/* Unit tests for the push trigger logic.
 *
 *   node --test test/
 *
 * These cover the parts that are easy to get quietly wrong: DST-safe date
 * math, the streak grace rule, the every-30-min dedup, and the habit that is
 * scheduled for no day at all (which loops forever without a guard).
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  addDaysYmd, dayOfWeek, localParts, isScheduled,
  currentStreak, habitsUndone, resetIncomplete, decideNotifications
} from "../src/triggers.mjs";

const TZ = "America/Chicago";

/* ---------- date math ---------- */

test("addDaysYmd rolls month and year boundaries", () => {
  assert.equal(addDaysYmd("2026-08-22", 1), "2026-08-23");
  assert.equal(addDaysYmd("2026-08-31", 1), "2026-09-01");
  assert.equal(addDaysYmd("2026-12-31", 1), "2027-01-01");
  assert.equal(addDaysYmd("2026-01-01", -1), "2025-12-31");
  assert.equal(addDaysYmd("2028-02-28", 1), "2028-02-29"); // leap year
});

test("addDaysYmd is unaffected by DST transitions", () => {
  // US DST 2026: starts Mar 8, ends Nov 1. Local-time date math skips or
  // repeats a day here; UTC-based math must not.
  assert.equal(addDaysYmd("2026-03-07", 1), "2026-03-08");
  assert.equal(addDaysYmd("2026-03-08", 1), "2026-03-09");
  assert.equal(addDaysYmd("2026-10-31", 1), "2026-11-01");
  assert.equal(addDaysYmd("2026-11-01", 1), "2026-11-02");
  assert.equal(addDaysYmd("2026-11-01", -1), "2026-10-31");
});

test("dayOfWeek matches real calendar days", () => {
  assert.equal(dayOfWeek("2026-08-22"), 6); // Saturday
  assert.equal(dayOfWeek("2026-08-23"), 0); // Sunday
  assert.equal(dayOfWeek("2026-08-24"), 1); // Monday
});

/* ---------- timezone ---------- */

test("localParts converts UTC instants to Chicago wall clock", () => {
  // 02:30Z on the 22nd is still 21:30 on the 21st in Chicago (CDT, UTC-5).
  const p = localParts(new Date("2026-08-22T02:30:00Z"), TZ);
  assert.equal(p.ymd, "2026-08-21");
  assert.equal(p.hour, 21);
  assert.equal(p.dow, 5); // Friday
});

test("localParts renders local midnight as hour 0, not 24", () => {
  const p = localParts(new Date("2026-08-22T05:00:00Z"), TZ);
  assert.equal(p.ymd, "2026-08-22");
  assert.equal(p.hour, 0);
});

test("localParts respects the CST/CDT offset change", () => {
  // 15:00Z: CDT (UTC-5) in August -> 10am; CST (UTC-6) in December -> 9am.
  assert.equal(localParts(new Date("2026-08-22T15:00:00Z"), TZ).hour, 10);
  assert.equal(localParts(new Date("2026-12-22T15:00:00Z"), TZ).hour, 9);
});

/* ---------- scheduling ---------- */

test("isScheduled treats a missing schedule as every day", () => {
  assert.equal(isScheduled({}, 0), true);
  assert.equal(isScheduled({ scheduled: null }, 3), true);
});

test("isScheduled treats an empty schedule as no day", () => {
  // `!h.scheduled` is false for [], so this must fall through to includes().
  assert.equal(isScheduled({ scheduled: [] }, 0), false);
  assert.equal(isScheduled({ scheduled: [1, 2, 3, 4, 5] }, 6), false);
  assert.equal(isScheduled({ scheduled: [1, 2, 3, 4, 5] }, 1), true);
});

/* ---------- streaks ---------- */

const daily = dates => ({ name: "Meditation", scheduled: null, dates });
const logged = (...days) => Object.fromEntries(days.map(d => [d, true]));

test("currentStreak gives today grace when not yet logged", () => {
  // Sat 22nd unlogged, the five days before it logged -> streak is 5, not 0.
  const h = daily(logged("2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21"));
  assert.equal(currentStreak(h, "2026-08-22"), 5);
});

test("currentStreak counts today once logged", () => {
  const h = daily(logged("2026-08-21", "2026-08-22"));
  assert.equal(currentStreak(h, "2026-08-22"), 2);
});

test("currentStreak breaks on a missed scheduled day", () => {
  const h = daily(logged("2026-08-18", "2026-08-21")); // 19th/20th missed
  assert.equal(currentStreak(h, "2026-08-22"), 1);
});

test("currentStreak skips unscheduled days without breaking", () => {
  // Weekdays only; the weekend gap must not break the streak.
  const h = {
    name: "Class Attendance", scheduled: [1, 2, 3, 4, 5],
    dates: logged("2026-08-20", "2026-08-21", "2026-08-24") // Thu, Fri, Mon
  };
  assert.equal(currentStreak(h, "2026-08-24"), 3);
});

test("currentStreak terminates on a habit scheduled for no day", () => {
  // Without the guard counter this never exits.
  const h = { name: "Nothing", scheduled: [], dates: {} };
  assert.equal(currentStreak(h, "2026-08-22"), 0);
});

test("currentStreak tolerates a missing dates map", () => {
  assert.equal(currentStreak({ name: "X", scheduled: null }, "2026-08-22"), 0);
});

/* ---------- undone habits ---------- */

test("habitsUndone ignores habits not scheduled today", () => {
  const state = {
    habits: {
      attendance: { name: "Class Attendance", scheduled: [1, 2, 3, 4, 5], dates: {} },
      meditation: { name: "Meditation", scheduled: null, dates: {} }
    }
  };
  // 2026-08-22 is a Saturday: attendance isn't scheduled, meditation is.
  const undone = habitsUndone(state, "2026-08-22");
  assert.deepEqual(undone.map(h => h.name), ["Meditation"]);
});

test("habitsUndone returns nothing once everything is logged", () => {
  const state = { habits: { meditation: daily(logged("2026-08-22")) } };
  assert.equal(habitsUndone(state, "2026-08-22").length, 0);
});

/* ---------- sunday reset ---------- */

test("resetIncomplete treats a stale week as untouched", () => {
  const state = { reset: { week: "2026-08-16", done: [true, true, true] } };
  assert.equal(resetIncomplete(state, "2026-08-23"), true);
});

test("resetIncomplete is false only when this week is fully ticked", () => {
  assert.equal(resetIncomplete({ reset: { week: "2026-08-23", done: [true, true, true] } }, "2026-08-23"), false);
  assert.equal(resetIncomplete({ reset: { week: "2026-08-23", done: [true, false, true] } }, "2026-08-23"), true);
  assert.equal(resetIncomplete({ reset: { week: "2026-08-23", done: [] } }, "2026-08-23"), true);
  assert.equal(resetIncomplete({}, "2026-08-23"), true);
});

/* ---------- the evening nag ---------- */

const eveningSat = { ymd: "2026-08-22", hour: 20, dow: 6 };

test("nag stays silent before 8pm", () => {
  const state = { habits: { meditation: daily({}) } };
  assert.deepEqual(decideNotifications(state, { ...eveningSat, hour: 19 }, {}), []);
});

test("nag fires at 8pm when a habit is unlogged", () => {
  const state = { habits: { meditation: daily({}) } };
  const out = decideNotifications(state, eveningSat, {});
  assert.equal(out.length, 1);
  assert.equal(out[0].key, "nag");
  assert.equal(out[0].body, "Still time to log today's habits.");
});

test("nag stays silent when everything is logged", () => {
  const state = { habits: { meditation: daily(logged("2026-08-22")) } };
  assert.deepEqual(decideNotifications(state, eveningSat, {}), []);
});

test("nag sharpens the message when a 5+ day streak is at risk", () => {
  const state = {
    habits: {
      meditation: daily(logged(
        "2026-08-16", "2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21"
      ))
    }
  };
  const out = decideNotifications(state, eveningSat, {});
  assert.equal(out[0].body, "6-day Meditation streak breaks at midnight.");
});

test("nag reports the longest streak among several unlogged habits", () => {
  const state = {
    habits: {
      short: { name: "Learning", scheduled: null, dates: logged("2026-08-21") },
      long: {
        name: "Meditation", scheduled: null,
        dates: logged("2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21")
      }
    }
  };
  assert.equal(decideNotifications(state, eveningSat, {})[0].body,
    "5-day Meditation streak breaks at midnight.");
});

test("nag does not repeat once it has fired today", () => {
  const state = { habits: { meditation: daily({}) } };
  assert.deepEqual(decideNotifications(state, eveningSat, { nag: "2026-08-22" }), []);
});

test("nag fires again the next day", () => {
  const state = { habits: { meditation: daily({}) } };
  const out = decideNotifications(state, { ymd: "2026-08-23", hour: 20, dow: 0 }, { nag: "2026-08-22" });
  assert.ok(out.some(n => n.key === "nag"));
});

/* ---------- cheer ---------- */

test("cheer fires the day before the event", () => {
  const state = { cheer: { nextName: "Regionals", nextDate: "2026-08-23", dates: {} } };
  const out = decideNotifications(state, { ymd: "2026-08-22", hour: 9, dow: 6 }, {});
  assert.equal(out.length, 1);
  assert.equal(out[0].key, "cheer");
  assert.equal(out[0].body, "Regionals is tomorrow.");
});

test("cheer falls back to a generic message when unnamed", () => {
  const state = { cheer: { nextName: "  ", nextDate: "2026-08-23", dates: {} } };
  assert.equal(decideNotifications(state, { ymd: "2026-08-22", hour: 9, dow: 6 }, {})[0].body,
    "Cheer event tomorrow.");
});

test("cheer stays silent on the day itself and two days out", () => {
  const state = { cheer: { nextName: "Regionals", nextDate: "2026-08-23", dates: {} } };
  assert.deepEqual(decideNotifications(state, { ymd: "2026-08-23", hour: 9, dow: 0 }, { reset: "2026-08-23" }), []);
  assert.deepEqual(decideNotifications(state, { ymd: "2026-08-21", hour: 9, dow: 5 }, {}), []);
});

test("cheer stays silent with no date set", () => {
  const state = { cheer: { nextName: "", nextDate: "", dates: {} } };
  assert.deepEqual(decideNotifications(state, { ymd: "2026-08-22", hour: 9, dow: 6 }, {}), []);
});

test("cheer does not repeat once it has fired today", () => {
  const state = { cheer: { nextName: "Regionals", nextDate: "2026-08-23", dates: {} } };
  assert.deepEqual(decideNotifications(state, { ymd: "2026-08-22", hour: 9, dow: 6 }, { cheer: "2026-08-22" }), []);
});

/* ---------- sunday reset ---------- */

test("reset nudge fires Sunday morning when unfinished", () => {
  const state = { reset: { week: "2026-08-23", done: [true, false, false] } };
  const out = decideNotifications(state, { ymd: "2026-08-23", hour: 10, dow: 0 }, {});
  assert.equal(out.length, 1);
  assert.equal(out[0].key, "reset");
});

test("reset nudge stays silent when finished, before 10am, and off-Sunday", () => {
  const done = { reset: { week: "2026-08-23", done: [true, true, true] } };
  const undone = { reset: { week: "2026-08-23", done: [false, false, false] } };
  assert.deepEqual(decideNotifications(done, { ymd: "2026-08-23", hour: 10, dow: 0 }, {}), []);
  assert.deepEqual(decideNotifications(undone, { ymd: "2026-08-23", hour: 9, dow: 0 }, {}), []);
  assert.deepEqual(decideNotifications(undone, { ymd: "2026-08-24", hour: 10, dow: 1 }, {}), []);
});

/* ---------- combinations and robustness ---------- */

test("a Sunday evening can carry both the reset nudge and the nag", () => {
  const state = {
    habits: { meditation: daily({}) },
    reset: { week: "2026-08-23", done: [false, false, false] }
  };
  const keys = decideNotifications(state, { ymd: "2026-08-23", hour: 20, dow: 0 }, {}).map(n => n.key);
  assert.deepEqual(keys.sort(), ["nag", "reset"]);
});

test("each trigger dedupes independently", () => {
  const state = {
    habits: { meditation: daily({}) },
    reset: { week: "2026-08-23", done: [false, false, false] }
  };
  const out = decideNotifications(state, { ymd: "2026-08-23", hour: 20, dow: 0 }, { reset: "2026-08-23" });
  assert.deepEqual(out.map(n => n.key), ["nag"]);
});

test("every notification carries the ymd used for dedup", () => {
  const state = { habits: { meditation: daily({}) } };
  assert.equal(decideNotifications(state, eveningSat, {})[0].ymd, "2026-08-22");
});

test("null or empty state produces nothing", () => {
  assert.deepEqual(decideNotifications(null, eveningSat, {}), []);
  assert.deepEqual(decideNotifications({}, eveningSat, {}), []);
});
