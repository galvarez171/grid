/* Grid push triggers — pure decision logic, no I/O.
 *
 * Kept free of KV/fetch/env so it can be unit-tested directly (see
 * test/triggers.test.mjs). index.js does the reads, calls decideNotifications,
 * and sends whatever comes back.
 *
 * All date math is calendar math on "YYYY-MM-DD" strings via UTC timestamps.
 * UTC has no DST, so adding 86400000ms is always exactly one calendar day —
 * doing this with local-time Dates would silently skip or repeat a day on the
 * two DST boundaries each year.
 */

const pad = n => String(n).padStart(2, "0");

export function ymdToUTC(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}
export function utcToYmd(ms) {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
export function addDaysYmd(ymd, n) {
  return utcToYmd(ymdToUTC(ymd) + n * 86400000);
}
export function dayOfWeek(ymd) {
  return new Date(ymdToUTC(ymd)).getUTCDay();
}

/* Wall-clock date + hour in the user's timezone. A Worker runs in UTC and has
 * no idea what "8pm" means to the user, so every trigger keys off this. */
export function localParts(now, timeZone) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit"
    }).formatToParts(now).map(x => [x.type, x.value])
  );
  const ymd = `${p.year}-${p.month}-${p.day}`;
  // Some ICU builds render midnight as hour "24" under hour12:false.
  return { ymd, hour: Number(p.hour) % 24, dow: dayOfWeek(ymd) };
}

/* ---------- to-do helpers (mirror the app's own logic exactly) ---------- */

/* An unfinished item rolls forward until it is done, so "open today" means
 * everything undone on or before today — not just what was filed under today.
 * A repeat is a pattern projected onto the days it matches, with completion
 * recorded per date, so it is never a row that can be left behind. */
export function openTodos(state, todayYmd) {
  const out = [];
  const todos = state?.todos || {};
  for (const k of Object.keys(todos).sort()) {
    if (k > todayYmd) continue;
    for (const x of todos[k] || []) if (x && !x.done) out.push({ t: x.t, late: k < todayYmd });
  }
  const dow = dayOfWeek(todayYmd);
  for (const r of state?.repeats || []) {
    if (!Array.isArray(r?.dows) || !r.dows.includes(dow) || todayYmd < r.from) continue;
    if (!state?.repeatDone?.[todayYmd]?.[r.id]) out.push({ t: r.t, late: false });
  }
  return out;
}

// The app rewrites reset.week to the current Sunday on render. A stale week
// therefore means the app hasn't been opened since the week rolled over, so
// nothing has been ticked off yet.
export function resetIncomplete(state, sundayYmd) {
  const r = state?.reset;
  if (!r) return true;
  if (r.week !== sundayYmd) return true;
  const done = Array.isArray(r.done) ? r.done : [];
  return !(done.length >= 3 && done.slice(0, 3).every(Boolean));
}

/* ---------- the decision ---------- */

/* Returns an array of {key, ymd, title, body} to send. `sent` maps a trigger
 * key to the ymd it last fired on, which is what keeps the 30-minute cron from
 * re-sending the same notification all evening. */
export function decideNotifications(state, parts, sent = {}) {
  const out = [];
  if (!state) return out;
  const { ymd: todayYmd, hour, dow } = parts;

  // Evening nag: what's still open on the to-do list. One carried-over item is
  // named directly — that's the one most likely to keep being ignored, and a
  // count alone never says which. Several are counted instead: naming the
  // oldest every night for weeks is how a notification stops being read, and
  // a semester's worth of dated items makes that the normal case rather than
  // the exception.
  if (hour >= 20 && sent.nag !== todayYmd) {
    const open = openTodos(state, todayYmd);
    if (open.length) {
      const late = open.filter(x => x.late);
      const body = late.length > 1
        ? `${late.length} things have been waiting since before today.`
        : late.length === 1
          ? `"${late[0].t}" has been waiting since before today.`
          : open.length === 1
            ? `One thing left: ${open[0].t}`
            : `${open.length} things still on today's list.`;
      out.push({ key: "nag", ymd: todayYmd, title: "Grid", body });
    }
  }

  // Sunday Reset nudge. Separate from the existing Personal-calendar alert —
  // this one points at opening Grid to run the checklist.
  if (dow === 0 && hour >= 10 && sent.reset !== todayYmd && resetIncomplete(state, todayYmd)) {
    out.push({
      key: "reset", ymd: todayYmd, title: "Grid",
      body: "Sunday Reset — run the weekly checklist."
    });
  }

  return out;
}
