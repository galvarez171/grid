/* Tests for the widget's pure date/projection logic.
 *
 * The widget itself can't run under node — it depends on Scriptable globals
 * (Calendar, DateFormatter, ListWidget, Keychain). The two functions that
 * decide what the app ever sees are pure, so they're lifted out of the source
 * file at test time rather than copied: `flatten`, which turns EventKit events
 * into the day-keyed rows the Worker stores, and `openTodosFor`, which decides
 * what counts as still open today.
 *
 * Lifting rather than copying means these can't drift out of sync with the
 * widget the way a hand-maintained copy did.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, "..", "..", "widget", "grid-widget.js"), "utf8");

// Pull one top-level function out of the widget by brace matching.
function lift(name) {
  const i = src.indexOf("function " + name + "(");
  assert.ok(i >= 0, name + " not found in widget/grid-widget.js");
  let depth = 0, j = src.indexOf("{", i);
  for (let k = j; k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}" && --depth === 0) { j = k; break; }
  }
  return src.slice(i, j + 1);
}

const helpers = `
const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const pad = n => String(n).padStart(2, "0");
const ymd = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const minutes = d => d.getHours() * 60 + d.getMinutes();
`;
const { flatten, openTodosFor, ownEvents, mergeOwn } = new Function(
  helpers + lift("flatten") + lift("openTodosFor") + lift("ownEvents") + lift("mergeOwn")
  + "return { flatten, openTodosFor, ownEvents, mergeOwn };"
)();

const ev = (title, s, e, allDay, cal) => ({
  identifier: title.replace(/\s/g, ""),
  title,
  startDate: new Date(s),
  endDate: new Date(e),
  isAllDay: !!allDay,
  calendar: { title: cal || "Work" }
});
const brief = rows => rows.map(r => `${r.d} ${r.s}-${r.e}`);

/* ---------- flatten ---------- */

test("flatten resolves a timed event to minutes from local midnight", () => {
  const [row] = flatten([ev("Shift", "2026-08-24T16:00", "2026-08-24T22:00")]);
  assert.equal(row.d, "2026-08-24");
  assert.equal(row.s, 960);
  assert.equal(row.e, 1320);
  assert.equal(row.allDay, false);
  assert.equal(row.cal, "Work");
});

// Read straight off the clock this would be 0, putting the end before the
// start — and the app drops anything with e <= s, so the shift would vanish.
test("flatten ends an event at 1440, not 0, when it runs to midnight", () => {
  assert.deepEqual(brief(flatten([ev("Late", "2026-08-24T22:00", "2026-08-25T00:00")])),
    ["2026-08-24 1320-1440"]);
});

test("flatten splits a multi-day event into one row per day", () => {
  assert.deepEqual(brief(flatten([ev("Trip", "2026-08-24T18:00", "2026-08-26T09:00")])),
    ["2026-08-24 1080-1440", "2026-08-25 0-1440", "2026-08-26 0-540"]);
});

test("flatten keeps an all-day event on its own day with no times", () => {
  const [row] = flatten([ev("Move-in", "2026-08-24T00:00", "2026-08-25T00:00", true, "Personal")]);
  assert.equal(row.d, "2026-08-24");
  assert.equal(row.allDay, true);
  assert.equal(row.s, null);
  assert.equal(row.e, null);
});

test("flatten gives each day of an event a distinct id", () => {
  const ids = flatten([ev("Trip", "2026-08-24T18:00", "2026-08-26T09:00")]).map(r => r.id);
  assert.equal(new Set(ids).size, 3);
});

test("flatten survives an event that ends before it starts", () => {
  assert.deepEqual(brief(flatten([ev("Broken", "2026-08-24T10:00", "2026-08-24T09:00")])),
    ["2026-08-24 600-540"]);   // the Worker drops this; flatten must not throw
});

/* ---------- openTodosFor ---------- */

const item = (t, done) => ({ id: t, t, done: !!done });

test("openTodosFor rolls unfinished items forward and marks them late", () => {
  const state = { todos: { "2026-08-20": [item("library")], "2026-08-24": [item("poster board")] } };
  assert.deepEqual(openTodosFor(state, "2026-08-24"), [
    { id: "library", t: "library", late: true, ymd: null },
    { id: "poster board", t: "poster board", late: false, ymd: null }
  ]);
});

test("openTodosFor ignores finished items and future days", () => {
  const state = {
    todos: {
      "2026-08-20": [item("done one", true)],
      "2026-08-24": [item("today")],
      "2026-08-30": [item("next week")]
    }
  };
  assert.deepEqual(openTodosFor(state, "2026-08-24").map(x => x.t), ["today"]);
});

// 2026-08-24 is a Monday, 2026-08-25 a Tuesday.
test("openTodosFor projects a repeat only onto its own weekdays", () => {
  const state = { repeats: [{ id: "r1", t: "cheer practice", dows: [1], from: "2026-08-01" }] };
  assert.equal(openTodosFor(state, "2026-08-24").length, 1);
  assert.equal(openTodosFor(state, "2026-08-25").length, 0);
});

test("openTodosFor carries the date on a repeat, which the toggle URL needs", () => {
  const state = { repeats: [{ id: "r1", t: "cheer practice", dows: [1], from: "2026-08-01" }] };
  assert.equal(openTodosFor(state, "2026-08-24")[0].ymd, "2026-08-24");
});

test("openTodosFor does not project a repeat before the day it was created", () => {
  const state = { repeats: [{ id: "r1", t: "cheer practice", dows: [1], from: "2026-09-01" }] };
  assert.deepEqual(openTodosFor(state, "2026-08-24"), []);
});

test("openTodosFor respects a repeat already ticked for that date", () => {
  const state = {
    repeats: [{ id: "r1", t: "cheer practice", dows: [1], from: "2026-08-01" }],
    repeatDone: { "2026-08-24": { r1: true } }
  };
  assert.deepEqual(openTodosFor(state, "2026-08-24"), []);
});

test("openTodosFor tolerates an empty or missing state", () => {
  assert.deepEqual(openTodosFor(null, "2026-08-24"), []);
  assert.deepEqual(openTodosFor({}, "2026-08-24"), []);
});

/* ---------- classes and fixtures ----------
   These live in the app's state rather than in EventKit, because the mirror
   this widget pushes would overwrite them. Without the projection the lock
   screen claimed an empty day while the app showed three lectures. */

const wed = new Date(2026, 8, 2);        // Wednesday 2 Sep 2026
const tue = new Date(2026, 8, 1);
const mon = new Date(2026, 8, 7);        // Labor Day, in the skip list
const term = { from: "2026-08-24", to: "2026-12-09" };
const isqs = { id: "c", t: "ISQS 2377", dows: [1, 3, 5], s: 480, e: 530,
               ...term, skip: ["2026-09-07"] };
const mgt  = { id: "m", t: "MGT 3370", dows: [2, 4], s: 1020, e: 1110, ...term, skip: [] };
const titles = evs => evs.map(e => e.title);

test("ownEvents projects a class onto a day it meets", () => {
  const [ev] = ownEvents({ classes: [isqs] }, wed);
  assert.equal(ev.title, "ISQS 2377");
  assert.equal(ev.isAllDay, false);
  assert.equal(ev.startDate.getHours(), 8);
  assert.equal(ev.endDate.getHours(), 8);
  assert.equal(ev.endDate.getMinutes(), 50);
  // The calendar name is what picks the colour, and must stay matchable.
  assert.equal(ev.calendar.title, "class");
});

test("ownEvents skips a day in the class's skip list", () => {
  assert.deepEqual(titles(ownEvents({ classes: [isqs] }, mon)), []);
});

test("ownEvents ignores a weekday the class does not meet", () => {
  assert.deepEqual(titles(ownEvents({ classes: [isqs, mgt] }, tue)), ["MGT 3370"]);
});

test("ownEvents respects the term bounds at both ends", () => {
  assert.deepEqual(titles(ownEvents({ classes: [isqs] }, new Date(2026, 7, 21))), []);
  assert.deepEqual(titles(ownEvents({ classes: [isqs] }, new Date(2026, 11, 11))), []);
});

test("ownEvents gives a fixture with no kickoff an all-day span", () => {
  const [ev] = ownEvents({ fixtures: [
    { id: "f", t: "Football vs. Sam Houston", d: "2026-09-02", allDay: true }
  ] }, wed);
  assert.equal(ev.isAllDay, true);
  assert.equal(ev.calendar.title, "cheer");
  assert.equal(ev.startDate.getTime(), wed.getTime());
  assert.equal(ev.endDate.getDate(), 3);
});

test("ownEvents tolerates an empty or missing state", () => {
  assert.deepEqual(ownEvents(null, wed), []);
  assert.deepEqual(ownEvents({}, wed), []);
});

test("mergeOwn drops a class the user also keeps in Apple Calendar", () => {
  const mirrored = [ev("ISQS 2377 Lecture", "2026-09-02T08:00", "2026-09-02T08:50", false, "School")];
  const merged = mergeOwn(mirrored, ownEvents({ classes: [isqs] }, wed));
  assert.deepEqual(titles(merged), ["ISQS 2377 Lecture"]);
});

test("mergeOwn keeps a class when the mirrored event is a different hour", () => {
  const mirrored = [ev("ISQS 2377 Lecture", "2026-09-02T11:00", "2026-09-02T11:50", false, "School")];
  const merged = mergeOwn(mirrored, ownEvents({ classes: [isqs] }, wed));
  assert.deepEqual(titles(merged).sort(), ["ISQS 2377", "ISQS 2377 Lecture"]);
});

// The opponent is what identifies a game across two calendars — the wrapper
// wording ("Football vs." here, "TTU Football vs" there) never matches.
test("mergeOwn matches a game on the opponent, not the whole title", () => {
  const mirrored = [ev("TTU Football vs Houston", "2026-09-18T19:00", "2026-09-18T22:00", false, "Personal")];
  const own = ownEvents({ fixtures: [
    { id: "g", t: "Football vs. Houston", d: "2026-09-18", s: 1140, e: 1320 }
  ] }, new Date(2026, 8, 18));
  assert.deepEqual(titles(mergeOwn(mirrored, own)), ["TTU Football vs Houston"]);
});

test("mergeOwn sorts all-day entries ahead of timed ones", () => {
  const own = ownEvents({ classes: [isqs], fixtures: [
    { id: "f", t: "Football vs. Sam Houston", d: "2026-09-02", allDay: true }
  ] }, wed);
  assert.deepEqual(titles(mergeOwn([], own)), ["Football vs. Sam Houston", "ISQS 2377"]);
});
