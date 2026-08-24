// Grid — Scriptable home-screen widget.
//
// Shows TODAY, and only today: the day's calendar events, then the day's open
// to-dos with a box you can tap to tick off.
//
// Note on the architecture: the PWA can't read Apple Calendar — iOS gives web
// apps no calendar access, which is why Grid only ever writes to it via the
// Shortcuts. Scriptable is native, so EventKit is available here. That makes
// this script the only thing on the phone that can see both halves, so it also
// pushes a flattened mirror of the next few weeks to the sync Worker, which is
// what fills the app's hour-by-hour day view.
//
// It is read-only as far as Apple Calendar is concerned: it never creates,
// edits, or deletes an event.
//
// Unlike the earlier version, this one needs the sync token and a network —
// to-dos live in Grid, not on the calendar. Events still draw without either.
//
// This is the canonical copy; the running one lives in the Scriptable app.

const SYNC_URL = "https://grid-sync.gabealvarez.workers.dev";
const APP_URL = "https://galvarez171.github.io/grid/";
const KEYCHAIN_KEY = "grid-sync-token";
const MIRROR_DAYS = 21;      // how far ahead to mirror into the app's day view
const MAX_EVENT_ROWS = { medium: 3, large: 7 };
const MAX_TODO_ROWS = { medium: 3, large: 6 };

// One colour per meaning, matching the app exactly: blue is the calendar,
// orange is the to-do list, green is classes, pink is cheer. Personal and
// unrecognised calendars fall to blue — they are still scheduled things.
const CIRCUITS = [
  [/cheer/i, "#FF2D95"],
  [/class|school|course|lecture/i, "#22E39A"]
];
const CAL = "#00B4FF";        // every other calendar, including Work
const BG = "#05070A";
const TXT = "#F2F8FD";
const DIM = "#C3D2E0";
const DIMMER = "#A2B4C6";
const ACCENT = "#FF8A1E";     // to-dos, matching the app's To-Do panel

/* ---------- token ---------- */

// Kept in the Keychain rather than in this file: the file syncs through iCloud
// Drive and has a copy in the repo, and neither is a place for a bearer token.
function getToken() {
  return Keychain.contains(KEYCHAIN_KEY) ? Keychain.get(KEYCHAIN_KEY) : null;
}

async function promptForToken() {
  const a = new Alert();
  a.title = "Grid sync token";
  a.message = "Paste the same token you saved in the Grid app.";
  a.addSecureTextField("token", "");
  a.addAction("Save");
  a.addCancelAction("Cancel");
  if ((await a.presentAlert()) < 0) return null;
  const v = (a.textFieldValue(0) || "").trim();
  if (!v) return null;
  Keychain.set(KEYCHAIN_KEY, v);
  return v;
}

function api(path, token, options) {
  const r = new Request(SYNC_URL + path);
  r.headers = Object.assign({ authorization: "Bearer " + token }, (options || {}).headers || {});
  if (options && options.method) r.method = options.method;
  if (options && options.body) {
    r.body = options.body;
    r.headers["content-type"] = "application/json";
  }
  return r;
}

/* ---------- calendar ---------- */

const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const pad = n => String(n).padStart(2, "0");
const ymd = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const minutes = d => d.getHours() * 60 + d.getMinutes();

// Deliberately ignores the calendar's own iOS colour: the point is that Grid
// only ever shows these four, so a calendar tinted purple in Settings still
// reads as blue here rather than introducing a fifth meaning.
function eventColor(ev) {
  const name = (ev.calendar && ev.calendar.title) || "";
  for (const [re, hex] of CIRCUITS) if (re.test(name)) return hex;
  return CAL;
}

async function loadRange(from, to) {
  const cals = await Calendar.forEvents();
  return (await CalendarEvent.between(from, to, cals)).sort((a, b) => a.startDate - b.startDate);
}

// One entry per day an event covers, with times already resolved to this
// phone's wall clock — the Worker and the app then need no timezone math at
// all, which is the whole point of flattening here rather than there.
function flatten(events) {
  const out = [];
  for (const ev of events) {
    const first = startOfDay(ev.startDate);
    // An all-day event's endDate is midnight on the following day; a timed one
    // ending exactly at midnight belongs to the day it started, not the next.
    const lastRaw = new Date(ev.endDate.getTime() - 1);
    const last = startOfDay(lastRaw < first ? ev.startDate : lastRaw);
    for (let d = first; d <= last; d = addDays(d, 1)) {
      const sameStart = ymd(d) === ymd(ev.startDate);
      const sameEnd = ymd(d) === ymd(lastRaw);
      out.push({
        id: ev.identifier + "@" + ymd(d),
        t: ev.title || "(untitled)",
        d: ymd(d),
        s: ev.isAllDay ? null : (sameStart ? minutes(ev.startDate) : 0),
        // Measured from this day's midnight rather than read off the clock, so
        // an event ending at exactly 00:00 lands on 1440 and not on 0 — which
        // would make it end before it started and vanish from the day view.
        e: ev.isAllDay ? null
          : (sameEnd ? Math.min(1440, Math.round((ev.endDate - d) / 60000)) : 1440),
        allDay: !!ev.isAllDay,
        cal: (ev.calendar && ev.calendar.title) || ""
      });
      if (out.length >= 1000) return out;
    }
  }
  return out;
}

async function pushMirror(token) {
  const from = startOfDay(new Date());
  const events = flatten(await loadRange(from, addDays(from, MIRROR_DAYS)));
  const req = api("/events", token, { method: "PUT", body: JSON.stringify({ events }) });
  await req.loadJSON();
}

/* ---------- to-dos ---------- */

// Mirrors the app's own rules: an unfinished item rolls forward until it's
// done, and a repeat is a pattern projected onto the days it matches rather
// than a row stored per week.
function openTodosFor(state, key) {
  const out = [];
  const todos = (state && state.todos) || {};
  for (const k of Object.keys(todos).sort()) {
    if (k > key) continue;
    for (const x of todos[k] || []) {
      if (!x.done) out.push({ id: x.id, t: x.t, late: k < key, ymd: null });
    }
  }
  const dow = new Date(key.slice(0, 4), +key.slice(5, 7) - 1, +key.slice(8, 10)).getDay();
  for (const r of (state && state.repeats) || []) {
    if (!r.dows.includes(dow) || key < r.from) continue;
    const done = state.repeatDone && state.repeatDone[key] && state.repeatDone[key][r.id];
    if (!done) out.push({ id: r.id, t: r.t, late: false, ymd: key });
  }
  return out;
}

async function loadTodos(token, key) {
  const res = await api("/state", token).loadJSON();
  return openTodosFor(res && res.state, key);
}

/* ---------- the tap ---------- */

// A home-screen widget runs no code when tapped — it can only open a URL. So a
// checkbox opens this same script with a toggle parameter, which flips the item
// on the Worker and returns. Scriptable visibly launches for a moment; that is
// the cost of a tickable box on the home screen.
function toggleURL(item) {
  const q = "toggle=" + encodeURIComponent(item.id) + (item.ymd ? "&ymd=" + item.ymd : "");
  return "scriptable:///run/" + encodeURIComponent(Script.name()) + "?" + q;
}

async function runToggle(token, id, key) {
  const body = JSON.stringify(key ? { id, ymd: key } : { id });
  await api("/todo/toggle", token, { method: "POST", body }).loadJSON();
}

/* ---------- drawing ---------- */

function addLine(stack, text, hex, size, bold) {
  const t = stack.addText(text);
  t.font = bold ? Font.boldMonospacedSystemFont(size) : Font.regularMonospacedSystemFont(size);
  t.textColor = new Color(hex);
  t.lineLimit = 1;
  return t;
}

function fmtTime(d) {
  const f = new DateFormatter();
  f.dateFormat = "h:mm a";
  return f.string(d);
}
function fmtToday(d) {
  const f = new DateFormatter();
  f.dateFormat = "EEE MMM d";
  return f.string(d).toUpperCase();
}

function eventRow(w, ev, now) {
  const row = w.addStack();
  row.centerAlignContent();
  const past = !ev.isAllDay && ev.endDate < now;
  const hex = past ? DIMMER : eventColor(ev);
  addLine(row, "▪ ", hex, 9, true);
  addLine(row, ev.title || "(untitled)", past ? DIMMER : TXT, 10, false);
  row.addSpacer();
  addLine(row, ev.isAllDay ? "ALL DAY" : fmtTime(ev.startDate), past ? DIMMER : DIM, 9, false);
  w.addSpacer(3);
}

function todoRow(w, item) {
  const row = w.addStack();
  row.centerAlignContent();
  row.url = toggleURL(item);          // the tap target is the whole row
  const box = addLine(row, "☐ ", ACCENT, 11, false);
  box.lineLimit = 1;
  addLine(row, item.t, TXT, 10, false);
  row.addSpacer();
  if (item.late) addLine(row, "LATE", ACCENT, 8, true);
  else if (item.ymd) addLine(row, "WKLY", DIMMER, 8, false);
  w.addSpacer(3);
}

function section(w, label) {
  w.addSpacer(6);
  addLine(w, label, DIMMER, 8, true);
  w.addSpacer(3);
}

function build(events, todos, note) {
  const family = config.widgetFamily || "medium";
  const w = new ListWidget();
  w.backgroundColor = new Color(BG);
  w.setPadding(12, 12, 12, 12);
  w.url = APP_URL;                    // tapping anywhere else opens Grid

  const now = new Date();
  const header = w.addStack();
  header.centerAlignContent();
  addLine(header, "GRID", CAL, 10, true);
  header.addSpacer();
  addLine(header, fmtToday(now), DIM, 9, false);

  // A small widget has exactly one tap target for the whole thing, so per-row
  // checkboxes are impossible there — show the shape of the day instead.
  if (family === "small") {
    w.addSpacer(6);
    const next = events.find(e => e.isAllDay || e.endDate >= now);
    if (next) {
      addLine(w, next.title || "(untitled)", eventColor(next), 13, true).lineLimit = 2;
      addLine(w, next.isAllDay ? "ALL DAY" : fmtTime(next.startDate), DIM, 9, false);
    } else {
      addLine(w, "NOTHING LEFT", DIM, 12, true);
    }
    w.addSpacer(6);
    addLine(w, todos.length ? todos.length + (todos.length === 1 ? " TO-DO" : " TO-DOS") : "LIST CLEAR",
            todos.length ? ACCENT : DIM, 10, true);
    w.refreshAfterDate = new Date(Date.now() + 15 * 60000);
    return w;
  }

  const evCap = MAX_EVENT_ROWS[family] || 3;
  const tdCap = MAX_TODO_ROWS[family] || 3;

  section(w, "SCHEDULE");
  if (!events.length) addLine(w, "nothing on the calendar", DIMMER, 9, false);
  for (const ev of events.slice(0, evCap)) eventRow(w, ev, now);
  if (events.length > evCap) addLine(w, "+" + (events.length - evCap) + " more", DIMMER, 8, false);

  section(w, note ? "TO-DO · " + note : "TO-DO");
  if (!todos.length && !note) addLine(w, "nothing left today", DIMMER, 9, false);
  for (const item of todos.slice(0, tdCap)) todoRow(w, item);
  if (todos.length > tdCap) addLine(w, "+" + (todos.length - tdCap) + " more", DIMMER, 8, false);

  if (family === "large") w.addSpacer();

  // Roll forward when the next event starts, so a finished shift doesn't sit at
  // the top of the list. iOS still decides when to honour this.
  const upcoming = events.filter(e => !e.isAllDay && e.startDate > now)[0];
  const cap = new Date(Date.now() + 15 * 60000);
  const at = upcoming ? new Date(upcoming.startDate.getTime() + 60000) : cap;
  w.refreshAfterDate = at < cap ? at : cap;
  return w;
}

/* ---------- run ---------- */

let token = getToken();

// Tapped a checkbox: flip it, then get out of the way. Nothing is drawn.
if (!config.runsInWidget && args.queryParameters && args.queryParameters.toggle) {
  if (token) {
    try {
      await runToggle(token, args.queryParameters.toggle, args.queryParameters.ymd || null);
    } catch (e) {
      // Silent by design — this path exists only to make a tap feel free. The
      // app reconciles from the Worker either way, and an alert here would sit
      // on screen after the user has already looked away.
    }
  }
  Script.complete();
} else {
  // Only prompt when a person is actually looking at the script; a widget
  // refresh can't answer an alert.
  if (!token && !config.runsInWidget) token = await promptForToken();

  const from = startOfDay(new Date());
  let events = [], todos = [], note = null;

  try {
    events = await loadRange(from, addDays(from, 1));
  } catch (e) {
    note = /denied|permission|access/i.test(e.message || "") ? "NO CALENDAR ACCESS" : "CALENDAR ERROR";
  }

  if (!token) {
    note = "NO TOKEN";
  } else {
    try {
      todos = await loadTodos(token, ymd(from));
    } catch (e) {
      note = "OFFLINE";
    }
    // Best effort, and last: a failed mirror must not cost the user the widget.
    try {
      await pushMirror(token);
    } catch (e) {}
  }

  const widget = build(events, todos, note);
  if (config.runsInWidget) Script.setWidget(widget);
  else await widget.presentMedium();
  Script.complete();
}
