/* Grid sync Worker — steps 1-4 of PLAN_V2.
 *
 * One KV key ("state") holds one JSON blob. The phone PUTs it, the Scriptable
 * widget and the push cron GET it. localStorage stays the source of
 * truth; this is a mirror. If this Worker is down the app must keep working.
 *
 * "subscription" holds the one PushSubscription (single-user, one device).
 * "lastNag" holds the ymd string of the last evening-nag push sent, so the
 * every-30-min cron doesn't re-fire inside the same day.
 */

import { buildPushPayload } from "@block65/webcrypto-web-push";

const KV_KEY = "state";
const SUB_KEY = "subscription";
const NAG_KEY = "lastNag";
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

// Requires env.TIMEZONE (IANA name, e.g. "America/Denver") — without it the
// cron can't know what "8pm" means for the user, so it no-ops rather than
// guess and fire at the wrong hour.
async function runTriggers(env) {
  if (!env.TIMEZONE) return;

  const now = new Date();
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: env.TIMEZONE, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit"
    }).formatToParts(now).map(p => [p.type, p.value])
  );
  const todayYmd = `${parts.year}-${parts.month}-${parts.day}`;
  const hour = Number(parts.hour) % 24;

  // Trigger 1: evening habit nag, ~8pm local, once per day.
  if (hour >= 20) {
    const lastNag = await env.GRID_KV.get(NAG_KEY);
    if (lastNag !== todayYmd) {
      const raw = await env.GRID_KV.get(KV_KEY);
      const state = raw ? JSON.parse(raw).state : null;
      if (state && habitsUndoneToday(state, todayYmd)) {
        await sendPush(env, { title: "Grid", body: "Still time to log today's habits." });
      }
      await env.GRID_KV.put(NAG_KEY, todayYmd);
    }
  }

  // Triggers 2-4 (streak-at-risk, cheer-tomorrow, Sunday Reset nudge) land
  // here once trigger 1 has proven itself for a few days — see PLAN_V2 §3.
}

function habitsUndoneToday(state, todayYmd) {
  const day = new Date(`${todayYmd}T00:00:00`).getDay();
  return Object.values(state.habits || {}).some(h => {
    const scheduled = !h.scheduled || h.scheduled.includes(day);
    return scheduled && !h.dates?.[todayYmd];
  });
}

async function sendPush(env, { title, body }) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
    return { ok: false, error: "vapid not configured" };
  }
  const raw = await env.GRID_KV.get(SUB_KEY);
  if (!raw) return { ok: false, error: "no subscription" };
  const subscription = JSON.parse(raw);

  const vapid = { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  const payload = await buildPushPayload({ data: { title, body }, options: { ttl: 3600 } }, subscription, vapid);
  const res = await fetch(subscription.endpoint, payload);

  // 404/410 means the push service dropped this subscription (e.g. re-added
  // to home screen) — clear it so /push/test stops trying a dead endpoint.
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
    "access-control-allow-methods": "GET,PUT,OPTIONS",
    "access-control-allow-headers": "authorization,content-type",
    "access-control-max-age": "86400",
    "vary": "Origin"
  };
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors(origin), "content-type": "application/json" }
  });
}
