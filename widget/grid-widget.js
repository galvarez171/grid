// Grid — Scriptable home-screen widget (PLAN_V2 step 5).
//
// iOS gives web apps no native widget API, so this reads the same /state blob
// the PWA syncs up and draws it with WidgetKit. Copy this file into a new
// Scriptable script on the phone and paste the token below.
//
// This is the canonical copy; the running one lives in the Scriptable app.
// It only ever does a single read-only GET — it never writes Grid's state.

// ── paste your Grid sync token here (the same one the app's Sync button took) ──
const TOKEN = "PASTE_YOUR_TOKEN_HERE";
const SYNC_URL = "https://grid-sync.gabealvarez.workers.dev";

// Same five circuit colors as the app, so the widget reads as the same product.
const COLORS = {
  "--work": "#00B4FF",
  "--cheer": "#FF2D95",
  "--classes": "#A855F7",
  "--habits": "#FF8A1E",
  "--personal": "#22E39A"
};
const BG = "#05070A";
const DIM = "#5A6B7A";
const HABIT_ORDER = ["attendance", "meditation", "learning"];

/* ---------- dates (local, mirrors the app) ---------- */
const pad = n => String(n).padStart(2, "0");
const ymd = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
function today() { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); }
function parseYmd(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
function addDays(d, n) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; }

/* ---------- streak (mirrors currentStreak() in index.html) ---------- */
function isScheduled(h, d) { return !h.scheduled || h.scheduled.includes(d.getDay()); }
function currentStreak(h) {
  let cur = today();
  // Grace: an unlogged today doesn't break the streak, the day isn't over.
  if (isScheduled(h, cur) && !h.dates?.[ymd(cur)]) cur = addDays(cur, -1);
  let n = 0, guard = 0;
  // The guard also stops a habit scheduled for no day from looping forever.
  while (guard++ < 3660) {
    if (!isScheduled(h, cur)) { cur = addDays(cur, -1); continue; }
    if (h.dates?.[ymd(cur)]) { n++; cur = addDays(cur, -1); }
    else break;
  }
  return n;
}

/* ---------- fetch ---------- */
async function loadState() {
  const req = new Request(SYNC_URL + "/state");
  req.headers = { Authorization: "Bearer " + TOKEN };
  req.timeoutInterval = 10;
  const res = await req.loadJSON();
  return res?.state || null;
}

/* ---------- draw ---------- */
function row(stack, text, color, bold) {
  const t = stack.addText(text);
  t.font = bold ? Font.boldMonospacedSystemFont(11) : Font.regularMonospacedSystemFont(11);
  t.textColor = new Color(color);
  t.lineLimit = 1;
  return t;
}

function build(state, error) {
  const w = new ListWidget();
  w.backgroundColor = new Color(BG);
  w.setPadding(12, 12, 12, 12);
  // iOS decides when to actually refresh; this is a hint, not a guarantee.
  w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);

  const title = w.addText("GRID");
  title.font = Font.boldMonospacedSystemFont(12);
  title.textColor = new Color(COLORS["--personal"]);
  w.addSpacer(6);

  if (error || !state) {
    const msg = w.addText(error ? "OFFLINE" : "NO DATA YET");
    msg.font = Font.regularMonospacedSystemFont(11);
    msg.textColor = new Color(DIM);
    const hint = w.addText(error ? "check token / network" : "open Grid to sync");
    hint.font = Font.regularMonospacedSystemFont(9);
    hint.textColor = new Color(DIM);
    return w;
  }

  const tk = ymd(today());
  for (const id of HABIT_ORDER) {
    const h = state.habits?.[id];
    if (!h) continue;
    const color = COLORS[h.color] || COLORS["--personal"];
    const scheduled = isScheduled(h, today());
    const done = !!h.dates?.[tk];
    // Filled box = logged today, hollow = still open, dash = not scheduled.
    const glyph = !scheduled ? "–" : (done ? "▣" : "▢");
    const line = w.addStack();
    line.centerAlignContent();
    row(line, glyph + " ", scheduled ? color : DIM, true);
    row(line, shortName(h.name), scheduled ? color : DIM, false);
    line.addSpacer();
    row(line, String(currentStreak(h)), scheduled ? color : DIM, true);
    w.addSpacer(3);
  }

  w.addSpacer(4);
  const cheer = w.addStack();
  cheer.centerAlignContent();
  row(cheer, "CHEER ", COLORS["--cheer"], true);
  cheer.addSpacer();
  row(cheer, cheerLabel(state), COLORS["--cheer"], false);
  return w;
}

// Keep the small widget from wrapping — "Class Attendance" is too wide.
function shortName(name) {
  const n = (name || "").trim();
  return n.length > 11 ? n.slice(0, 10) + "…" : n;
}

function cheerLabel(state) {
  const next = state.cheer?.nextDate;
  if (!next) return "none set";
  const days = Math.round((parseYmd(next) - today()) / 86400000);
  if (days < 0) return "past";
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  return days + "d";
}

/* ---------- run ---------- */
let state = null, error = null;
try {
  if (!TOKEN || TOKEN === "PASTE_YOUR_TOKEN_HERE") throw new Error("token not set");
  state = await loadState();
} catch (e) {
  error = e;
}

const widget = build(state, error);
if (config.runsInWidget) Script.setWidget(widget);
else await widget.presentSmall();
Script.complete();
