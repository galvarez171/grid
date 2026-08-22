/* Cross-check: the widget computes streaks with local Date objects, the worker
 * with UTC ymd strings. Both are transcriptions of currentStreak() in
 * index.html, so they must agree on every input — otherwise the widget and the
 * notification would disagree about the same streak.
 *
 * The widget's implementation is copied in verbatim below (with `today`
 * injected instead of read from the clock) and fuzzed against the worker's.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { currentStreak as workerStreak } from "../src/triggers.mjs";

/* ---- verbatim from widget/grid-widget.js, with today() parameterised ---- */
const pad = n => String(n).padStart(2, "0");
const ymd = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
function addDays(d, n) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; }
function isScheduled(h, d) { return !h.scheduled || h.scheduled.includes(d.getDay()); }
function widgetStreak(h, todayDate) {
  let cur = todayDate;
  if (isScheduled(h, cur) && !h.dates?.[ymd(cur)]) cur = addDays(cur, -1);
  let n = 0, guard = 0;
  while (guard++ < 3660) {
    if (!isScheduled(h, cur)) { cur = addDays(cur, -1); continue; }
    if (h.dates?.[ymd(cur)]) { n++; cur = addDays(cur, -1); }
    else break;
  }
  return n;
}
/* ------------------------------------------------------------------------ */

const SCHEDULES = [null, [1, 2, 3, 4, 5], [0, 6], [3], []];

// Deterministic PRNG so a failure is reproducible.
function rng(seed) {
  let s = seed;
  return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

test("widget and worker streaks agree across random histories", () => {
  const rand = rng(20260822);
  for (let i = 0; i < 400; i++) {
    const scheduled = SCHEDULES[Math.floor(rand() * SCHEDULES.length)];
    // Anchor on a fixed day, walk back up to 40 days, log each with p≈0.7.
    const anchor = new Date(2026, 7, 22);
    const dates = {};
    for (let d = 0; d < 40; d++) {
      if (rand() < 0.7) dates[ymd(addDays(anchor, -d))] = true;
    }
    const h = { name: "H", scheduled, dates };
    assert.equal(
      widgetStreak(h, anchor),
      workerStreak(h, "2026-08-22"),
      `mismatch on iteration ${i} with schedule ${JSON.stringify(scheduled)}`
    );
  }
});

test("widget and worker agree across a DST boundary", () => {
  // Nov 1 2026 is the US fall-back date; the widget walks local Dates through
  // it while the worker walks UTC timestamps.
  const anchor = new Date(2026, 10, 3); // Nov 3
  const dates = {};
  for (let d = 0; d < 10; d++) dates[ymd(addDays(anchor, -d))] = true;
  const h = { name: "H", scheduled: null, dates };
  assert.equal(widgetStreak(h, anchor), workerStreak(h, "2026-11-03"));
  assert.equal(widgetStreak(h, anchor), 10);
});

test("widget and worker agree across the spring-forward boundary", () => {
  const anchor = new Date(2026, 2, 10); // Mar 10, just after Mar 8
  const dates = {};
  for (let d = 0; d < 10; d++) dates[ymd(addDays(anchor, -d))] = true;
  const h = { name: "H", scheduled: null, dates };
  assert.equal(widgetStreak(h, anchor), workerStreak(h, "2026-03-10"));
  assert.equal(widgetStreak(h, anchor), 10);
});
