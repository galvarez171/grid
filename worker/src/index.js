/* Grid sync Worker — step 1 of PLAN_V2.
 *
 * One KV key ("state") holds one JSON blob. The phone PUTs it, the Scriptable
 * widget and (later) the cron push job GET it. localStorage stays the source of
 * truth; this is a mirror. If this Worker is down the app must keep working.
 */

const KV_KEY = "state";
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

    if (url.pathname !== "/state") {
      return json({ error: "not found" }, 404, origin);
    }

    if (!(await authorized(req, env))) {
      return json({ error: "unauthorized" }, 401, origin);
    }

    if (req.method === "GET") {
      const raw = await env.GRID_KV.get(KV_KEY);
      if (!raw) return json({ v: 1, updatedAt: null, state: null }, 200, origin);
      // Stored already-serialized — hand it back untouched, no reparse.
      return new Response(raw, { status: 200, headers: { ...cors(origin), "content-type": "application/json" } });
    }

    if (req.method === "PUT") {
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

    return json({ error: "method not allowed" }, 405, origin);
  }
};

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
