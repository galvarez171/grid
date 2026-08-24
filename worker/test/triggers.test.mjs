/* Unit tests for the push trigger logic.
 *
 *   node --test test/
 *
 * These cover the parts that are easy to get quietly wrong: DST-safe date
 * math, the rollover rule (an unfinished item is still open days later), the
 * projection of a weekly repeat, and the every-30-min dedup.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  addDaysYmd, dayOfWeek, localParts,
  openTodos, resetIncomplete, decideNotifications
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

/* ---------- open to-dos ---------- */

const item = (t, done) => ({ id: t, t, done: !!done });

test("openTodos carries unfinished items forward from earlier days", () => {
  const state = { todos: { "2026-08-20": [item("library")], "2026-08-22": [item("poster board")] } };
  assert.deepEqual(openTodos(state, "2026-08-22"),
    [{ t: "library", late: true }, { t: "poster board", late: false }]);
});

test("openTodos ignores finished items and future days", () => {
  const state = {
    todos: {
      "2026-08-20": [item("done one", true)],
      "2026-08-22": [item("today")],
      "2026-08-30": [item("next week")]
    }
  };
  assert.deepEqual(openTodos(state, "2026-08-22").map(x => x.t), ["today"]);
});

test("openTodos projects a repeat onto the days it matches", () => {
  // 2026-08-22 is a Saturday, 2026-08-24 a Monday.
  const state = { repeats: [{ id: "r1", t: "cheer practice", dows: [1], from: "2026-08-01" }] };
  assert.deepEqual(openTodos(state, "2026-08-22"), []);
  assert.deepEqual(openTodos(state, "2026-08-24"), [{ t: "cheer practice", late: false }]);
});

test("openTodos does not project a repeat before the day it was created", () => {
  const state = { repeats: [{ id: "r1", t: "cheer practice", dows: [1], from: "2026-09-01" }] };
  assert.deepEqual(openTodos(state, "2026-08-24"), []);
});

test("openTodos respects a repeat already ticked for that date", () => {
  const state = {
    repeats: [{ id: "r1", t: "cheer practice", dows: [1], from: "2026-08-01" }],
    repeatDone: { "2026-08-24": { r1: true } }
  };
  assert.deepEqual(openTodos(state, "2026-08-24"), []);
});

test("openTodos tolerates a malformed repeat", () => {
  const state = { repeats: [{ id: "bad", t: "no days" }, null] };
  assert.deepEqual(openTodos(state, "2026-08-24"), []);
});

/* ---------- the reset checklist ---------- */

test("resetIncomplete treats a stale week as untouched", () => {
  assert.equal(resetIncomplete({ reset: { week: "2026-08-16", done: [true, true, true] } }, "2026-08-23"), true);
  assert.equal(resetIncomplete({ reset: { week: "2026-08-23", done: [] } }, "2026-08-23"), true);
  assert.equal(resetIncomplete({}, "2026-08-23"), true);
});

test("resetIncomplete is false only when this week is fully ticked", () => {
  assert.equal(resetIncomplete({ reset: { week: "2026-08-23", done: [true, true, true] } }, "2026-08-23"), false);
  assert.equal(resetIncomplete({ reset: { week: "2026-08-23", done: [true, true, false] } }, "2026-08-23"), true);
});

/* ---------- the evening nag ---------- */

const eveningSat = { ymd: "2026-08-22", hour: 20, dow: 6 };
const oneOpen = { todos: { "2026-08-22": [item("poster board")] } };

test("nag stays silent before 8pm", () => {
  assert.deepEqual(decideNotifications(oneOpen, { ...eveningSat, hour: 19 }, {}), []);
});

test("nag names the single open item", () => {
  const out = decideNotifications(oneOpen, eveningSat, {});
  assert.equal(out.length, 1);
  assert.equal(out[0].key, "nag");
  assert.equal(out[0].body, "One thing left: poster board");
});

test("nag counts when several are open", () => {
  const state = { todos: { "2026-08-22": [item("a"), item("b"), item("c")] } };
  assert.equal(decideNotifications(state, eveningSat, {})[0].body, "3 things still on today's list.");
});

test("nag names a rolled-over item ahead of the count", () => {
  const state = { todos: { "2026-08-19": [item("library")], "2026-08-22": [item("a"), item("b")] } };
  assert.equal(decideNotifications(state, eveningSat, {})[0].body,
    '"library" has been waiting since before today.');
});

test("nag stays silent when the list is clear", () => {
  const state = { todos: { "2026-08-22": [item("done one", true)] } };
  assert.deepEqual(decideNotifications(state, eveningSat, {}), []);
});

test("nag fires for a repeat that is due and unticked", () => {
  const state = { repeats: [{ id: "r1", t: "laundry", dows: [6], from: "2026-08-01" }] };
  assert.equal(decideNotifications(state, eveningSat, {})[0].body, "One thing left: laundry");
});

test("nag does not repeat once it has fired today", () => {
  assert.deepEqual(decideNotifications(oneOpen, eveningSat, { nag: "2026-08-22" }), []);
});

test("nag fires again the next day", () => {
  const state = { todos: { "2026-08-22": [item("poster board")] } };
  const out = decideNotifications(state, { ymd: "2026-08-23", hour: 20, dow: 0 }, { nag: "2026-08-22" });
  assert.ok(out.some(n => n.key === "nag"));
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
    todos: { "2026-08-23": [item("poster board")] },
    reset: { week: "2026-08-23", done: [false, false, false] }
  };
  const keys = decideNotifications(state, { ymd: "2026-08-23", hour: 20, dow: 0 }, {}).map(n => n.key);
  assert.deepEqual(keys.sort(), ["nag", "reset"]);
});

test("each trigger dedupes independently", () => {
  const state = {
    todos: { "2026-08-23": [item("poster board")] },
    reset: { week: "2026-08-23", done: [false, false, false] }
  };
  const out = decideNotifications(state, { ymd: "2026-08-23", hour: 20, dow: 0 }, { reset: "2026-08-23" });
  assert.deepEqual(out.map(n => n.key), ["nag"]);
});

test("every notification carries the ymd used for dedup", () => {
  assert.equal(decideNotifications(oneOpen, eveningSat, {})[0].ymd, "2026-08-22");
});

test("null or empty state produces nothing", () => {
  assert.deepEqual(decideNotifications(null, eveningSat, {}), []);
  assert.deepEqual(decideNotifications({}, eveningSat, {}), []);
});
