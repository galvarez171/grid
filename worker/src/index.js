/* Grid sync Worker — steps 1-4 of PLAN_V2.
 *
 * One KV key ("state") holds one JSON blob. The phone PUTs it, the Scriptable
 * widget and the push cron GET it. localStorage stays the source of
 * truth; this is a mirror. If this Worker is down the app must keep working.
 *
 * "subscription" holds the one PushSubscription (single-user, one device).
 * "sent" maps each trigger key to the ymd it last fired on, so the every-30-min
 * cron doesn't re-fire the same notification all evening.
 */

import { buildPushPayload } from "@block65/webcrypto-web-push";
import { localParts, decideNotifications } from "./triggers.mjs";

const KV_KEY = "state";
const SUB_KEY = "subscription";
const SENT_KEY = "sent";
// Shortcuts/Siri can't PUT the whole state — they don't have it, and a blind
// PUT would clobber whatever the phone logged since. They append here instead,
// and the app drains this queue into localStorage, which stays the truth.
const INBOX_KEY = "inbox";
const MAX_INBOX = 200;
// The PWA gets no calendar access from iOS, so the phone's Scriptable widget
// (which is native and does) pushes a flattened mirror of the next few weeks
// here on every refresh. Read-only as far as Apple Calendar is concerned.
const EVENTS_KEY = "events";
const MAX_EVENTS = 1000;
const MAX_BODY = 200 * 1024; // KV allows 25MB; Grid's blob is a few KB. Anything
                             // bigger than this is a bug, not a real state.

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const origin = corsOrigin(req, env);

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    if (url.pathname === "/health") {
      return json({ ok: true }, 200, origin);
    }

    if (!(await authorized(req, env))) {
      return json({ error: "unauthorized" }, 401, origin);
    }

    if (url.pathname === "/state" && req.method === "GET") {
      const raw = await env.GRID_KV.get(KV_KEY);
      if (!raw) return json({ v: 1, updatedAt: null, state: null }, 200, origin);
      // Stored already-serialized — hand it back untouched, no reparse.
      return new Response(raw, { status: 200, headers: { ...cors(origin), "content-type": "application/json" } });
    }

    if (url.pathname === "/state" && req.method === "PUT") {
      const body = await req.text();
      if (body.length > MAX_BODY) return json({ error: "payload too large" }, 413, origin);
      let state;
      try {
        state = JSON.parse(body);
      } catch {
        return json({ error: "invalid json" }, 400, origin);
      }
      // Grid's state is always a plain object. An array or a bare scalar means
      // something upstream is confused — don't let it overwrite a good blob.
      if (!state || typeof state !== "object" || Array.isArray(state)) {
        return json({ error: "invalid state" }, 400, origin);
      }
      const updatedAt = new Date().toISOString();
      await env.GRID_KV.put(KV_KEY, JSON.stringify({ v: 1, updatedAt, state }));
      return json({ ok: true, updatedAt }, 200, origin);
    }

    /* ---------- todo inbox (Siri / Shortcuts) ---------- */

    if (url.pathname === "/todo" && req.method === "POST") {
      const body = await req.text();
      if (body.length > 4096) return json({ error: "payload too large" }, 413, origin);
      let item;
      try {
        item = JSON.parse(body);
      } catch {
        return json({ error: "invalid json" }, 400, origin);
      }
      const text = String(item?.text ?? "").trim().slice(0, 200);
      if (!text) return json({ error: "empty text" }, 400, origin);
      // Siri hands over a date only when the sentence had one. Everything else
      // lands on today, in the user's timezone — a Worker's own "today" is UTC
      // and would push an evening item onto tomorrow.
      const day = /^\d{4}-\d{2}-\d{2}$/.test(item?.date || "")
        ? item.date
        : localParts(new Date(), env.TIMEZONE || "UTC").ymd;

      const raw = await env.GRID_KV.get(INBOX_KEY);
      const items = raw ? JSON.parse(raw) : [];
      const entry = { id: crypto.randomUUID(), t: text, ymd: day, at: new Date().toISOString() };
      items.push(entry);
      // The app deletes what it drains, so this only grows while the phone is
      // offline. Drop the oldest rather than reject — a lost week-old item is
      // better than a rejected one the user just spoke.
      await env.GRID_KV.put(INBOX_KEY, JSON.stringify(items.slice(-MAX_INBOX)));
      return json({ ok: true, item: entry }, 200, origin);
    }

    /* ---------- calendar mirror ---------- */

    if (url.pathname === "/events" && req.method === "PUT") {
      const body = await req.text();
      if (body.length > MAX_BODY) return json({ error: "payload too large" }, 413, origin);
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        return json({ error: "invalid json" }, 400, origin);
      }
      if (!Array.isArray(payload?.events)) return json({ error: "events must be an array" }, 400, origin);
      // Times arrive already resolved to the phone's wall clock — minutes from
      // midnight on a named day — so neither this Worker nor the app has to do
      // timezone math on someone else's calendar.
      const events = payload.events
        .filter(e => e && typeof e.t === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e.d || ""))
        .slice(0, MAX_EVENTS)
        .map(e => ({
          id: String(e.id || "").slice(0, 128),
          t: String(e.t).slice(0, 120),
          d: e.d,
          s: e.allDay ? null : clampMin(e.s),
          e: e.allDay ? null : clampMin(e.e),
          allDay: !!e.allDay,
          cal: String(e.cal || "").slice(0, 60)
        }))
        // A timed event whose minutes didn't survive validation has nowhere to
        // sit in the hour grid. Dropping it beats letting it masquerade as an
        // all-day event, which is what a null start would look like downstream.
        .filter(e => e.allDay || (e.s !== null && e.e !== null && e.e > e.s));
      const syncedAt = new Date().toISOString();
      await env.GRID_KV.put(EVENTS_KEY, JSON.stringify({ v: 1, syncedAt, events }));
      return json({ ok: true, syncedAt, count: events.length }, 200, origin);
    }

    if (url.pathname === "/events" && req.method === "GET") {
      const raw = await env.GRID_KV.get(EVENTS_KEY);
      if (!raw) return json({ v: 1, syncedAt: null, events: [] }, 200, origin);
      return new Response(raw, { status: 200, headers: { ...cors(origin), "content-type": "application/json" } });
    }

    /* ---------- widget toggle ---------- */

    // The widget can't reach localStorage, so it flips the item on the mirrored
    // state (which is what the widget itself reads back) and queues the same
    // flip for the app. Both sides converge on the app's next drain.
    if (url.pathname === "/todo/toggle" && req.method === "POST") {
      let ask;
      try {
        ask = JSON.parse(await req.text());
      } catch {
        return json({ error: "invalid json" }, 400, origin);
      }
      const id = String(ask?.id || "");
      if (!id) return json({ error: "id required" }, 400, origin);
      const day = /^\d{4}-\d{2}-\d{2}$/.test(ask?.ymd || "") ? ask.ymd : null;

      const raw = await env.GRID_KV.get(KV_KEY);
      let done = null;
      if (raw) {
        const wrapper = JSON.parse(raw);
        const state = wrapper.state || {};
        done = applyToggle(state, id, day);
        if (done !== null) {
          await env.GRID_KV.put(KV_KEY, JSON.stringify({ ...wrapper, state }));
        }
      }
      if (done === null) return json({ error: "not found" }, 404, origin);

      const inboxRaw = await env.GRID_KV.get(INBOX_KEY);
      const items = inboxRaw ? JSON.parse(inboxRaw) : [];
      items.push({ id: crypto.randomUUID(), op: "toggle", ref: id, ymd: day, done, at: new Date().toISOString() });
      await env.GRID_KV.put(INBOX_KEY, JSON.stringify(items.slice(-MAX_INBOX)));
      return json({ ok: true, done }, 200, origin);
    }

    if (url.pathname === "/inbox" && req.method === "GET") {
      const raw = await env.GRID_KV.get(INBOX_KEY);
      return json({ items: raw ? JSON.parse(raw) : [] }, 200, origin);
    }

    // Ack rather than a blind clear: an item added between the GET and this
    // call must survive, or a todo spoken while the app was opening vanishes.
    if (url.pathname === "/inbox/ack" && req.method === "POST") {
      let ids;
      try {
        ids = JSON.parse(await req.text())?.ids;
      } catch {
        return json({ error: "invalid json" }, 400, origin);
      }
      if (!Array.isArray(ids)) return json({ error: "ids must be an array" }, 400, origin);
      const done = new Set(ids);
      const raw = await env.GRID_KV.get(INBOX_KEY);
      const items = raw ? JSON.parse(raw) : [];
      const left = items.filter(x => !done.has(x.id));
      await env.GRID_KV.put(INBOX_KEY, JSON.stringify(left));
      return json({ ok: true, remaining: left.length }, 200, origin);
    }

    if (url.pathname === "/subscribe" && req.method === "PUT") {
      const body = await req.text();
      if (body.length > MAX_BODY) return json({ error: "payload too large" }, 413, origin);
      let sub;
      try {
        sub = JSON.parse(body);
      } catch {
        return json({ error: "invalid json" }, 400, origin);
      }
      if (!sub || typeof sub !== "object" || !sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
        return json({ error: "invalid subscription" }, 400, origin);
      }
      await env.GRID_KV.put(SUB_KEY, JSON.stringify(sub));
      return json({ ok: true }, 200, origin);
    }

    if (url.pathname === "/subscribe" && req.method === "DELETE") {
      await env.GRID_KV.delete(SUB_KEY);
      return json({ ok: true }, 200, origin);
    }

    if (url.pathname === "/push/test" && req.method === "POST") {
      const result = await sendPush(env, { title: "Grid", body: "Test push — if you see this, it works." });
      return json(result, result.ok ? 200 : 502, origin);
    }

    return json({ error: "not found" }, 404, origin);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runTriggers(env));
  }
};

/* ---------- push triggers (step 4) ---------- */

// Requires env.TIMEZONE (IANA name, e.g. "America/Chicago") — without it the
// cron can't know what "8pm" means for the user, so it no-ops rather than
// guess and fire at the wrong hour.
async function runTriggers(env) {
  if (!env.TIMEZONE) return;

  const parts = localParts(new Date(), env.TIMEZONE);
  // Nothing can fire before 9am local; skip the KV reads entirely overnight.
  if (parts.hour < 9) return;

  // Read all three at once, and bail before any decision work if there's
  // nobody to notify — one KV round trip per tick, per plan §6.
  const [stateRaw, sentRaw, subRaw] = await Promise.all([
    env.GRID_KV.get(KV_KEY),
    env.GRID_KV.get(SENT_KEY),
    env.GRID_KV.get(SUB_KEY)
  ]);
  if (!subRaw) return;
  const state = stateRaw ? JSON.parse(stateRaw).state : null;
  const sent = sentRaw ? JSON.parse(sentRaw) : {};
  const subscription = JSON.parse(subRaw);

  const due = decideNotifications(state, parts, sent);
  if (!due.length) return;

  let changed = false;
  for (const n of due) {
    let res;
    try {
      res = await sendPush(env, { title: n.title, body: n.body }, subscription);
    } catch {
      // A thrown fetch (DNS/network) must not abort the remaining
      // notifications or lose the `sent` write below. Next tick retries.
      continue;
    }
    // Only mark it sent once it actually went out, so a transient push-service
    // failure retries on the next tick instead of silently eating the day's
    // notification.
    if (res.ok) { sent[n.key] = n.ymd; changed = true; }
    // The subscription is gone (phone re-added to the home screen, etc.) —
    // sendPush has already cleared it, so don't retry the rest against a
    // dead endpoint.
    if (res.status === 404 || res.status === 410) break;
  }
  if (changed) await env.GRID_KV.put(SENT_KEY, JSON.stringify(sent));
}

// `subscription` is optional: the cron passes the one it already read, while
// /push/test lets this fetch it.
async function sendPush(env, { title, body }, subscription) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
    return { ok: false, error: "vapid not configured" };
  }
  if (!subscription) {
    const raw = await env.GRID_KV.get(SUB_KEY);
    if (!raw) return { ok: false, error: "no subscription" };
    subscription = JSON.parse(raw);
  }

  const vapid = { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  const payload = await buildPushPayload({ data: { title, body }, options: { ttl: 3600 } }, subscription, vapid);
  const res = await fetch(subscription.endpoint, payload);

  // 404/410 means the push service dropped this subscription (e.g. re-added
  // to home screen) — clear it so later sends stop trying a dead endpoint.
  if (res.status === 404 || res.status === 410) await env.GRID_KV.delete(SUB_KEY);

  return { ok: res.ok, status: res.status };
}

/* ---------- helpers ---------- */

// Minutes from local midnight. Anything outside a day is a bug in the pusher,
// not a real event, so it's dropped rather than clamped into a wrong hour.
function clampMin(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 1440 ? n : null;
}

// Returns the new done value, or null if the id matched nothing — which is how
// the caller tells a stale widget tap from a real one.
function applyToggle(state, id, day) {
  if (day && Array.isArray(state.repeats) && state.repeats.some(r => r.id === id)) {
    state.repeatDone = state.repeatDone || {};
    const bucket = state.repeatDone[day] = state.repeatDone[day] || {};
    const next = !bucket[id];
    if (next) bucket[id] = true; else delete bucket[id];
    if (!Object.keys(bucket).length) delete state.repeatDone[day];
    return next;
  }
  const todos = state.todos || {};
  for (const k of Object.keys(todos)) {
    const item = (todos[k] || []).find(x => x.id === id);
    if (item) { item.done = !item.done; return item.done; }
  }
  return null;
}

/* ---------- auth ---------- */

async function authorized(req, env) {
  const h = req.headers.get("authorization") || "";
  const m = /^Bearer (.+)$/.exec(h);
  if (!m) return false;
  if (!env.GRID_TOKEN) return false;
  return secretEquals(m[1], env.GRID_TOKEN);
}

// SHA-256 first so both operands are always 32 bytes — otherwise
// timingSafeEqual throws on a length mismatch and the token length leaks.
async function secretEquals(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b))
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

/* ---------- cors ---------- */

// The bearer token is the real gate. CORS is pinned anyway so a random page
// can't quietly ride along on a token sitting in localStorage.
function corsOrigin(req, env) {
  const allowed = (env.ALLOWED_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
  const reqOrigin = req.headers.get("origin");
  if (!reqOrigin) return allowed[0] || "*";        // Scriptable / curl send no Origin
  return allowed.includes(reqOrigin) ? reqOrigin : (allowed[0] || "*");
}

function cors(origin) {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,PUT,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
    "access-control-max-age": "600",
    "vary": "Origin"
  };
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors(origin), "content-type": "application/json" }
  });
}
