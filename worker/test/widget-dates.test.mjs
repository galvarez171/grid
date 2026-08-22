/* Tests for the widget's date/filter logic.
 *
 * The widget itself can't run under node — it depends on Scriptable globals
 * (Calendar, DateFormatter, ListWidget). The pure helpers below are copied
 * verbatim from widget/grid-widget.js so the edge cases still get covered:
 * an event already in progress, an all-day event later the same day, and the
 * boundaries of the "in 25m" hint.
 *
 * Keep in sync by hand if the widget changes.
 */

import test from "node:test";
import assert from "node:assert/strict";

/* ---- verbatim from widget/grid-widget.js ---- */
function endOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);
}
const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());
function daysFromToday(d) {
  return Math.round((startOfDay(d) - startOfDay(new Date())) / 86400000);
}
function soonLabel(ev) {
  if (ev.isAllDay) return "";
  const ms = ev.startDate - new Date();
  if (ms < 0) return "NOW";
  if (ms > 12 * 3600000) return "";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return "IN " + mins + "M";
  return "IN " + Math.round(mins / 60) + "H";
}
function upcoming(events, now) {
  return events
    .filter(e => (e.isAllDay ? endOfDay(e.startDate) : e.endDate) >= now)
    .sort((a, b) => a.startDate - b.startDate);
}
/* -------------------------------------------- */

const mins = n => new Date(Date.now() + n * 60000);
const ev = (startDate, opts = {}) => ({
  startDate,
  endDate: opts.endDate ?? new Date(startDate.getTime() + 3600000),
  isAllDay: opts.isAllDay ?? false,
  title: opts.title ?? "E"
});

test("daysFromToday labels today, tomorrow and beyond", () => {
  const now = new Date();
  assert.equal(daysFromToday(now), 0);
  assert.equal(daysFromToday(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9)), 1);
  assert.equal(daysFromToday(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 6, 9)), 6);
});

test("daysFromToday is unaffected by time of day", () => {
  const now = new Date();
  const lateToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59);
  const earlyToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 1);
  assert.equal(daysFromToday(lateToday), 0);
  assert.equal(daysFromToday(earlyToday), 0);
});

test("endOfDay lands on the last second of the same date", () => {
  const d = new Date(2026, 7, 22, 3, 15);
  const e = endOfDay(d);
  assert.equal(e.getDate(), 22);
  assert.equal(e.getHours(), 23);
  assert.equal(e.getMinutes(), 59);
});

test("soonLabel counts down in minutes then hours", () => {
  assert.equal(soonLabel(ev(mins(25))), "IN 25M");
  assert.equal(soonLabel(ev(mins(59))), "IN 59M");
  assert.equal(soonLabel(ev(mins(180))), "IN 3H");
});

test("soonLabel says NOW for an event already started", () => {
  assert.equal(soonLabel(ev(mins(-5))), "NOW");
});

test("soonLabel stays quiet beyond 12 hours and for all-day events", () => {
  assert.equal(soonLabel(ev(mins(13 * 60))), "");
  assert.equal(soonLabel(ev(mins(30), { isAllDay: true })), "");
});

test("upcoming keeps an event that is currently in progress", () => {
  const now = new Date();
  const inProgress = ev(mins(-30), { endDate: mins(30), title: "running" });
  assert.deepEqual(upcoming([inProgress], now).map(e => e.title), ["running"]);
});

test("upcoming drops an event that has already ended", () => {
  const now = new Date();
  const over = ev(mins(-120), { endDate: mins(-60), title: "over" });
  assert.deepEqual(upcoming([over], now), []);
});

test("upcoming keeps today's all-day event even when it started at midnight", () => {
  const now = new Date();
  const allDay = ev(startOfDay(now), { endDate: startOfDay(now), isAllDay: true, title: "allday" });
  assert.deepEqual(upcoming([allDay], now).map(e => e.title), ["allday"]);
});

test("upcoming sorts by start time", () => {
  const now = new Date();
  const list = [ev(mins(300), { title: "c" }), ev(mins(60), { title: "a" }), ev(mins(120), { title: "b" })];
  assert.deepEqual(upcoming(list, now).map(e => e.title), ["a", "b", "c"]);
});
