/* Dock Media feed — what the PC's scheduled tasks know about the business,
 * shaped for Grid to draw. Pure so it can be tested without a Worker runtime.
 *
 * The PC is the only writer and replaces the whole doc each time, the same
 * way the widget treats /events. Two exceptions, both because a partial
 * failure on the PC shouldn't blank the phone: a push whose tracker read
 * failed sends stats:null, and one that couldn't read Square sends no money —
 * in both cases the last good value is kept.
 */

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ROWS = 200;

const str = (v, n) => String(v ?? "").slice(0, n);
const num = v => (Number.isFinite(Number(v)) ? Number(v) : null);

function minute(v) {
  if (v === null || v === undefined || v === "") return null;   // Number(null) is 0, i.e. midnight
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 1440 ? n : null;
}

// Consults sit on the hour grid, so they need a real day and real minutes —
// times arrive already resolved to Central wall clock, like the widget's.
export function cleanConsults(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(c => c && YMD.test(c.d || "") && c.t)
    .slice(0, MAX_ROWS)
    .map(c => ({ id: str(c.id, 128), t: str(c.t, 120), d: c.d, s: minute(c.s), e: minute(c.e) }))
    .filter(c => c.s !== null && c.e !== null && c.e > c.s);
}

// Delivery due dates and monthly batch dates: a day and a sentence.
export function cleanDates(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter(x => x && YMD.test(x.d || "") && x.t)
    .slice(0, MAX_ROWS)
    .map(x => ({ id: str(x.id, 128), d: x.d, t: str(x.t, 160) }));
}

// Stats are numbers and short labels only. Anything else in the payload is
// dropped rather than stored, so a bug on the PC can't smuggle a blob in.
export function cleanStats(s) {
  if (!s || typeof s !== "object") return null;
  const p = s.pipeline || {}, q = s.queue || {};
  return {
    asOf: str(s.asOf, 40),
    tracker: str(s.tracker, 80),
    pipeline: {
      total: num(p.total), notContacted: num(p.notContacted), contacted: num(p.contacted),
      responded: num(p.responded), client: num(p.client), overdue: num(p.overdue),
      lastOutreach: YMD.test(p.lastOutreach || "") ? p.lastOutreach : null
    },
    queue: { warm: num(q.warm), overdue: num(q.overdue), dueToday: num(q.dueToday), fresh: num(q.fresh) },
    warmLeads: (Array.isArray(s.warmLeads) ? s.warmLeads : []).slice(0, 5)
      .map(w => ({ gym: str(w?.gym, 80), idle: num(w?.idle), next: str(w?.next, 120) })),
    calls: s.calls && typeof s.calls === "object" ? { calls: num(s.calls.calls) } : null
  };
}

export function cleanMoney(m) {
  if (!m || typeof m !== "object") return null;
  return { asOf: str(m.asOf, 40), count7d: num(m.count7d), total7d: num(m.total7d) };
}

export function mergeDock(payload, prev, now) {
  const old = prev || {};
  return {
    v: 1,
    updatedAt: now,
    stats: cleanStats(payload.stats) || old.stats || null,
    money: cleanMoney(payload.money) || old.money || null,
    consults: cleanConsults(payload.consults),
    dates: cleanDates(payload.dates)
  };
}
