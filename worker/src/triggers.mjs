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

/* ---------- habit helpers (mirror the app's own logic exactly) ---------- */

// A habit with scheduled:[] is scheduled for no day at all — note `!h.scheduled`
// is false for an empty array, so it correctly falls through to includes().
export function isScheduled(h, dow) {
  return !h.scheduled || h.scheduled.includes(dow);
}

// Mirrors currentStreak() in index.html, including the grace rule (an unlogged
// today doesn't break the streak) and the guard against a habit that is
// scheduled for no day, which would otherwise loop forever.
export function currentStreak(h, todayYmd) {
  let cur = todayYmd;
  if (isScheduled(h, dayOfWeek(cur)) && !h.dates?.[cur]) cur = addDaysYmd(cur, -1);
  let n = 0, guard = 0;
  while (guard++ < 3660) {
    if (!isScheduled(h, dayOfWeek(cur))) { cur = addDaysYmd(cur, -1); continue; }
    if (h.dates?.[cur]) { n++; cur = addDaysYmd(cur, -1); }
    else break;
  }
  return n;
}

export function habitsUndone(state, todayYmd) {
  const dow = dayOfWeek(todayYmd);
  return Object.values(state?.habits || {})
    .filter(h => h && isScheduled(h, dow) && !h.dates?.[todayYmd]);
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

  // Triggers 1+2: evening habit nag, sharpened when a long streak is at risk.
  // PLAN_V2 §3 lists streak-at-risk as "the same trigger as #1" — so it's one
  // notification with a sharper message, not a second buzz.
  if (hour >= 20 && sent.nag !== todayYmd) {
    const undone = habitsUndone(state, todayYmd);
    if (undone.length) {
      let top = null;
      for (const h of undone) {
        const s = currentStreak(h, todayYmd);
        if (!top || s > top.s) top = { h, s };
      }
      const body = top && top.s >= 5
        ? `${top.s}-day ${top.h.name} streak breaks at midnight.`
        : "Still time to log today's habits.";
      out.push({ key: "nag", ymd: todayYmd, title: "Grid", body });
    }
  }

  // Trigger 3: cheer event tomorrow. Fires the morning before, so a day-
  // granular event still gets roughly a day's warning.
  if (hour >= 9 && sent.cheer !== todayYmd) {
    const nextDate = state.cheer?.nextDate;
    if (nextDate && nextDate === addDaysYmd(todayYmd, 1)) {
      const name = (state.cheer?.nextName || "").trim();
      out.push({
        key: "cheer", ymd: todayYmd, title: "Grid",
        body: name ? `${name} is tomorrow.` : "Cheer event tomorrow."
      });
    }
  }

  // Trigger 4: Sunday Reset nudge. Separate from the existing Personal-calendar
  // alert — this one points at opening Grid to run the checklist.
  if (dow === 0 && hour >= 10 && sent.reset !== todayYmd && resetIncomplete(state, todayYmd)) {
    out.push({
      key: "reset", ymd: todayYmd, title: "Grid",
      body: "Sunday Reset — run the weekly checklist."
    });
  }

  return out;
}
