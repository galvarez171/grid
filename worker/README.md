# grid-sync Worker

Step 1 of `PLAN_V2.md`. A single KV key mirrors Grid's `localStorage` blob so the
Scriptable widget and the push cron have something to read. The app never waits
on it — if this is down, Grid works exactly as it does today.

## Endpoints

| Method | Path         | Auth   | Does |
|--------|--------------|--------|------|
| GET    | `/health`    | none   | liveness check |
| GET    | `/state`     | bearer | returns `{v,updatedAt,state}`; `state:null` before first sync |
| PUT    | `/state`     | bearer | body is the raw Grid state JSON; wraps it with `updatedAt` |
| PUT    | `/subscribe` | bearer | body is a `PushSubscription` from `PushManager.subscribe()`; stores it (single device) |
| DELETE | `/subscribe` | bearer | clears the stored subscription |
| POST   | `/push/test` | bearer | sends one test push to the stored subscription |
| POST   | `/todo`      | bearer | `{text, date?}` from Siri/Shortcuts; queues one to-do item |
| GET    | `/inbox`     | bearer | returns `{items}` — the queued to-dos the app hasn't taken yet |
| POST   | `/inbox/ack` | bearer | `{ids:[…]}`; deletes exactly those items from the queue |
| PUT    | `/events`    | bearer | flattened Apple Calendar mirror pushed by the Scriptable widget |
| GET    | `/events`    | bearer | returns `{syncedAt, events}` for the app's day view |
| POST   | `/todo/toggle` | bearer | `{id, ymd?}` from a widget tap; flips the item and queues the same flip for the app |

A `scheduled` cron (`*/30 * * * *`) checks the evening habit nag once `TIMEZONE`
(an IANA name, e.g. `America/Denver`) is set as a var — without it, it no-ops.

Auth header: `Authorization: Bearer <GRID_TOKEN>`. Anything else is `401`.
The body must be a JSON object — arrays, scalars and `null` are rejected `400`
so a confused caller can't blank a good blob.

### The to-do inbox

Shortcuts can't PUT `/state` — they only know the one line just spoken, and a
blind write would clobber whatever the phone logged since. So they append to a
queue instead, and the app drains it into `localStorage` on launch and on every
return to the foreground.

`date` is optional and must be `YYYY-MM-DD`; anything else (including the empty
string Shortcuts sends when the sentence had no date in it) falls back to today
in `TIMEZONE` — not the Worker's UTC today, which would push an evening item
onto tomorrow.

Ack is by id rather than a blind clear, so an item spoken between the app's GET
and its ack survives. The app also dedupes on that id, so a failed ack costs
nothing but a repeat drain. The queue is capped at 200 items, oldest dropped.

### The calendar mirror

iOS gives a web app no calendar access, so the PWA cannot draw an hour-by-hour
day without help. The Scriptable widget is native, reads EventKit, and PUTs a
flattened copy here on every refresh: one entry per day an event covers, with
times already resolved to the phone's wall clock as minutes from midnight.
Neither this Worker nor the app then does any timezone math on someone else's
calendar. Entries whose minutes don't validate are dropped rather than stored
with null times, which would make them look like all-day events downstream.

`/todo/toggle` exists because a widget can't reach `localStorage` either. It
flips the item on the mirrored state — which is what the widget itself reads
back, so the change is visible immediately — and queues the same flip on the
inbox. The app applies the queue on its next drain, so both sides converge on
whatever the tap did. The queued op carries the value it landed on rather than
"flip it", so replaying one can't drift out of step.

## Local test (no Cloudflare account needed)

`.dev.vars` already holds a throwaway `GRID_TOKEN` for local runs. It is
gitignored and is not the production token.

```bash
npx wrangler dev --local --port 8787
```

```bash
curl -X PUT http://127.0.0.1:8787/state -H "Authorization: Bearer local-dev-token-not-a-real-secret" -H "content-type: application/json" -d "{\"hello\":1}"
```

## Deploy

Needs a free Cloudflare account. **Every command below runs from this `worker/`
directory** — wrangler finds no config anywhere else and fails with
"Required Worker name missing".

1. Log in (opens a browser):

```bash
npx wrangler login
```

2. Set `ALLOWED_ORIGIN` in `wrangler.jsonc` to the Pages origin, e.g.
   `https://yourname.github.io`.

3. Deploy. The KV namespace has no `id` in config on purpose — wrangler
   provisions it on this first deploy and writes the id back. Deploying before
   the token exists is safe: with `GRID_TOKEN` unset every request answers
   `401`.

```bash
npx wrangler deploy
```

4. Generate the bearer token — the same value goes into the app and the
   Scriptable widget. Write it to a file instead of the terminal so it never
   lands in scrollback or a screenshot:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))" > token.txt
```

5. Pipe it straight into the secret prompt, then shred the file once the token
   is in the app and the widget. Never pass a secret as a CLI argument — it
   lands in shell history:

```bash
npx wrangler secret put GRID_TOKEN < token.txt
```

Secrets apply to the live Worker immediately; no redeploy needed. If a token is
ever printed, screenshotted, or committed, treat it as burned — rotate by
repeating steps 4-5, which overwrites the old value.

Wrangler prints the Worker URL (`https://grid-sync.<subdomain>.workers.dev`).
That URL plus the token are the two values step 2 wires into `index.html`.

## Verify the deploy

```bash
curl https://grid-sync.YOURSUB.workers.dev/health
```

```bash
curl https://grid-sync.YOURSUB.workers.dev/state -H "Authorization: Bearer PASTE_TOKEN"
```

Second call should return `{"v":1,"updatedAt":null,"state":null}` before the
first sync. Without the header it should be `401`.

Live logs while testing from the phone:

```bash
npx wrangler tail
```

## Notes

- One KV read/write per sync, one blob — no per-field reads (plan §6).
- Token comparison hashes both sides to SHA-256 before
  `crypto.subtle.timingSafeEqual`, so neither the bytes nor the length leak.
- CORS is pinned to `ALLOWED_ORIGIN`; the bearer token is still the real gate.
  Requests with no `Origin` (Scriptable, curl) are served normally.
- Single-user by design. The token *is* the account; there is no user table.
- Secrets never live in `wrangler.jsonc`, so this directory is safe to commit.
  `.gitignore` covers `node_modules/`, `.wrangler/`, `.dev.vars`.
