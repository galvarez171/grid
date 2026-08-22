// Grid — Scriptable home-screen widget (PLAN_V2 step 5).
//
// Shows what's next on the Apple Calendar, in Grid's colors.
//
// Note on the architecture: the PWA can't read Apple Calendar — iOS gives web
// apps no calendar access, which is why Grid only ever writes to it via the
// Shortcuts. Scriptable is a native app, so EventKit is available here. That
// makes this widget entirely local: no token, no network, no dependency on the
// sync Worker (which still exists for push notifications, and is unaffected).
//
// This is the canonical copy; the running one lives in the Scriptable app.
// Read-only — it never creates, edits, or deletes an event.

const LOOKAHEAD_DAYS = 14;   // how far out to look for "next"
const MAX_ROWS = 3;          // extra events listed under the headline (small)

// Grid's circuit colors, matched against the calendar's name so the widget
// reads as the same product as the app. Habits are deliberately absent —
// they live in Grid's own storage, not on a calendar, so nothing here can
// ever match them.
const CIRCUITS = [
  [/work|shift|job/i, "#00B4FF"],
  [/cheer/i, "#FF2D95"],
  [/class|school|course|lecture/i, "#A855F7"],
  [/personal|life|home/i, "#22E39A"]
];
const BG = "#05070A";
const DIM = "#5A6B7A";
const FALLBACK = "#22E39A";

/* ---------- calendar ---------- */

// Colors an event by its calendar's name, falling back to the color the
// calendar itself is assigned in iOS so an unrecognised one still looks right.
function eventColor(ev) {
  const name = ev.calendar?.title || "";
  for (const [re, hex] of CIRCUITS) if (re.test(name)) return hex;
  const c = ev.calendar?.color;
  return c ? "#" + c.hex.replace(/^#/, "") : FALLBACK;
}

async function loadEvents() {
  const cals = await Calendar.forEvents();
  const now = new Date();
  const end = new Date(now.getTime() + LOOKAHEAD_DAYS * 86400000);
  const events = await CalendarEvent.between(now, end, cals);
  return events
    // between() includes events already in progress; keep those (they're still
    // "what's happening"), but drop anything that has fully ended.
    .filter(e => (e.isAllDay ? endOfDay(e.startDate) : e.endDate) >= now)
    .sort((a, b) => a.startDate - b.startDate);
}

function endOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);
}

/* ---------- date formatting ---------- */

const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
function daysFromToday(d) {
  return Math.round((startOfDay(d) - startOfDay(new Date())) / 86400000);
}

function fmtTime(d) {
  const f = new DateFormatter();
  f.dateFormat = "h:mm a";
  return f.string(d);
}
function fmtWeekday(d) {
  const f = new DateFormatter();
  f.dateFormat = "EEE";
  return f.string(d).toUpperCase();
}
function fmtDate(d) {
  const f = new DateFormatter();
  f.dateFormat = "MMM d";
  return f.string(d).toUpperCase();
}

// "TODAY 4:00 PM" / "TOMORROW · ALL DAY" / "MON 9:00 AM" / "SEP 3 9:00 AM"
function whenLabel(ev) {
  const n = daysFromToday(ev.startDate);
  const day = n === 0 ? "TODAY" : n === 1 ? "TOMORROW" : n < 7 ? fmtWeekday(ev.startDate) : fmtDate(ev.startDate);
  return ev.isAllDay ? day + " · ALL DAY" : day + " " + fmtTime(ev.startDate);
}

// A short "in 25m" / "in 3h" hint, only while it's near enough to matter.
function soonLabel(ev) {
  if (ev.isAllDay) return "";
  const ms = ev.startDate - new Date();
  if (ms < 0) return "NOW";
  if (ms > 12 * 3600000) return "";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return "IN " + mins + "M";
  return "IN " + Math.round(mins / 60) + "H";
}

/* ---------- drawing ---------- */

function addLine(stack, text, hex, size, bold) {
  const t = stack.addText(text);
  t.font = bold ? Font.boldMonospacedSystemFont(size) : Font.regularMonospacedSystemFont(size);
  t.textColor = new Color(hex);
  t.lineLimit = 1;
  return t;
}

function build(events, error) {
  const family = config.widgetFamily || "small";
  const wide = family === "medium" || family === "large";
  const w = new ListWidget();
  w.backgroundColor = new Color(BG);
  w.setPadding(12, 12, 12, 12);

  const header = w.addStack();
  header.centerAlignContent();
  addLine(header, "GRID", FALLBACK, 10, true);
  header.addSpacer();
  addLine(header, "NEXT", DIM, 9, false);
  w.addSpacer(6);

  if (error) {
    const denied = /denied|permission|access/i.test(error.message || "");
    addLine(w, denied ? "NO ACCESS" : "ERROR", DIM, 11, true);
    w.addSpacer(2);
    addLine(w, denied ? "open script in app" : String(error.message).slice(0, 22), DIM, 9, false);
    w.refreshAfterDate = new Date(Date.now() + 15 * 60000);
    return w;
  }

  if (!events.length) {
    addLine(w, "NOTHING", DIM, 13, true);
    addLine(w, "SCHEDULED", DIM, 13, true);
    w.addSpacer(3);
    addLine(w, "next " + LOOKAHEAD_DAYS + " days", DIM, 9, false);
    w.refreshAfterDate = new Date(Date.now() + 30 * 60000);
    return w;
  }

  // Headline: the next thing coming up.
  const next = events[0];
  const hex = eventColor(next);
  addLine(w, next.title || "(untitled)", hex, wide ? 15 : 13, true).lineLimit = wide ? 1 : 2;
  w.addSpacer(2);
  const meta = w.addStack();
  meta.centerAlignContent();
  addLine(meta, whenLabel(next), hex, 10, false);
  const soon = soonLabel(next);
  if (soon) { meta.addSpacer(6); addLine(meta, soon, DIM, 9, true); }

  // Then the ones after it.
  const rest = events.slice(1, 1 + (wide ? MAX_ROWS + 2 : MAX_ROWS));
  if (rest.length) {
    w.addSpacer(8);
    for (const ev of rest) {
      const row = w.addStack();
      row.centerAlignContent();
      addLine(row, "▪ ", eventColor(ev), 9, true);
      addLine(row, ev.title || "(untitled)", DIM, 9, false).lineLimit = 1;
      row.addSpacer();
      addLine(row, whenLabel(ev), DIM, 9, false);
      w.addSpacer(2);
    }
  }

  // Roll the widget forward just after the current headline starts, so "NEXT"
  // doesn't sit on a stale event. iOS still decides when to honour this.
  const afterStart = new Date(next.startDate.getTime() + 60000);
  const cap = new Date(Date.now() + 30 * 60000);
  w.refreshAfterDate = afterStart > new Date() && afterStart < cap ? afterStart : cap;
  return w;
}

/* ---------- run ---------- */
let events = [], error = null;
try {
  events = await loadEvents();
} catch (e) {
  error = e;
}

const widget = build(events, error);
if (config.runsInWidget) Script.setWidget(widget);
else await widget.presentSmall();
Script.complete();
