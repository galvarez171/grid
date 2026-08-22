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
