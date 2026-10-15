/* The Dock Media feed's validation. The PC replaces the whole doc on every
 * push, so the cases that matter are what survives a bad push: a dropped
 * consult must not land at a made-up hour, and a failed tracker read must not
 * blank the stats the phone already has.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { cleanConsults, cleanDates, cleanStats, mergeDock } from "../src/dock.mjs";

test("a consult keeps its day and minutes", () => {
  const [c] = cleanConsults([{ id: "a", t: "Consult: All Stars Unlimited", d: "2026-10-16", s: 975, e: 990 }]);
  assert.deepEqual(c, { id: "a", t: "Consult: All Stars Unlimited", d: "2026-10-16", s: 975, e: 990 });
});

test("a consult with no usable time is dropped, not parked at midnight", () => {
  assert.equal(cleanConsults([{ t: "x", d: "2026-10-16", s: null, e: 15 }]).length, 0);
  assert.equal(cleanConsults([{ t: "x", d: "2026-10-16", s: 600, e: 600 }]).length, 0);
  assert.equal(cleanConsults([{ t: "x", d: "2026-10-16", s: 1500, e: 1515 }]).length, 0);
  assert.equal(cleanConsults([{ t: "x", d: "10/16/2026", s: 600, e: 615 }]).length, 0);
});

test("a date needs a real day and some text", () => {
  assert.deepEqual(cleanDates([{ id: "d", d: "2026-10-22", t: "Pro Cheer — 3 posts due" }, { d: "2026-10-22" }, null]),
    [{ id: "d", d: "2026-10-22", t: "Pro Cheer — 3 posts due" }]);
  assert.deepEqual(cleanDates("nope"), []);
});

test("stats keep numbers and drop anything they weren't asked for", () => {
  const s = cleanStats({ asOf: "t", pipeline: { total: "396", contacted: 120, secret: "x" },
                         warmLeads: Array(9).fill({ gym: "G", idle: 3, phone: "555" }) });
  assert.equal(s.pipeline.total, 396);
  assert.equal(s.pipeline.secret, undefined);
  assert.equal(s.warmLeads.length, 5);
  assert.equal(s.warmLeads[0].phone, undefined);
});

test("a push with stats:null keeps the last good stats; consults and dates are replaced", () => {
  const prev = mergeDock({ stats: { asOf: "old", pipeline: { total: 10 } }, money: { total7d: 60 },
                           consults: [{ t: "a", d: "2026-10-16", s: 60, e: 75 }], dates: [{ d: "2026-10-22", t: "x" }] },
                         null, "t0");
  const next = mergeDock({ stats: null, consults: [], dates: [] }, prev, "t1");
  assert.equal(next.stats.asOf, "old");
  assert.equal(next.money.total7d, 60);
  assert.equal(next.consults.length, 0);
  assert.equal(next.dates.length, 0);
  assert.equal(next.updatedAt, "t1");
});
