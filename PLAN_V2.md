# Grid V2 — Notifications, Widget, Visual Polish, Efficiency, Real Icon

**Paste this entire file into a new chat to start the build.** It's self-contained — the new session doesn't need this conversation's history.

---

## 0. What Grid is today (context for the new chat)

A single-file PWA (`index.html` + `sw.js` + `manifest.webmanifest`) hosted free on GitHub Pages, added to the iPhone home screen. All data (habit streaks, cheer log, Sunday Reset state) lives in `localStorage` — nothing leaves the phone. Two Apple Shortcuts write directly to Apple Calendar: `Grid Quick Add` (typed sentence, on-device AI) and `Grid Scan` (photo of a schedule, calls the Claude API directly from the Shortcut). Five calendars in Apple Calendar are the source of truth for events; Grid never reads them back — it can't, iOS gives web apps no calendar access.

Full history in `BUILD.md`, `SHORTCUT.md`, `CAPTURE.md` in the same repo.

## 1. The one architecture decision this phase requires

**Today Grid has zero backend, zero login, zero signup.** That's why it was fast to build and there was nothing to leak. Notifications and a widget both need Grid's data to exist somewhere other than "inside Safari's sandbox on one phone" — a push notification has to be sent by a server that knows your state, and a widget runs outside the browser entirely, so it can't touch `localStorage`.

**Decision: add a Cloudflare Worker + Workers KV as a thin sync layer.** Free tier (100k requests/day, no card required historically, though Cloudflare's signup requirements can change — expect to create a free account). `localStorage` stays the source of truth for the app's own instant, offline UI; the Worker is a mirror the widget and push cron read from. If Cloudflare or the Worker is ever down, the app itself keeps working exactly as it does now — only the widget and notifications degrade.

**Auth: one long random token**, generated once, stored in `localStorage`, sent as a header on every Worker request. No password, no email, no account system for you to manage — it's a bearer secret, same trust model as an API key. This is a single-user app; don't build multi-user auth for it.

This is the only part of the current design that changes. Confirm you're fine creating one free Cloudflare account before the new chat starts — that's the one signup this plan needs.

## 2. What stays exactly as-is (don't relitigate these)

- Single-file frontend, GitHub Pages hosting, no build step
- `localStorage` as the instant/offline source of truth — Worker is a mirror, not a replacement
- `Grid Quick Add` and `Grid Scan` shortcuts — unrelated to this phase, they write straight to Apple Calendar and never touch Grid's own storage
- No custom webfont — the system monospace stack is free and instant; a hosted font is a network request for no visible gain at this size
- Export/import JSON backup — becomes the migration path (see §6), don't rebuild it

## 3. Push notifications

**Mechanism:** Web Push (`iOS 16.4+` supports this for home-screen PWAs — confirm the phone is above that, it will be after the 26.6 update). VAPID key pair generated once. The Worker stores the push subscription (from `PushManager.subscribe()`) and a **Cron Trigger** (Cloudflare's free scheduled-execution feature, e.g. every 30 min) checks state and fires pushes.

**Triggers to build, in priority order:**
1. **Evening habit nag** — ~8pm, if any habit scheduled for today isn't logged yet. Skip silently if everything's done.
2. **Streak-at-risk** — if a streak of 5+ is about to break (same trigger as #1, worth a sharper message on a long streak).
3. **Cheer event tomorrow** — 24h before `cheer.nextDate`.
4. **Sunday Reset nudge** — separate from the existing Personal-calendar alert (keep that one), this one points specifically at opening Grid to run the checklist.

**Permission UX:** request `Notification.requestPermission()` from a real tap (a "Turn on reminders" button in the app), never on load — iOS is strict about this and a cold-load prompt gets auto-denied by habit.

## 4. iOS widget

**iOS gives web apps no native widget API — this is the real constraint, be clear about it in the new chat.** The only way to get an actual home-screen widget backed by Grid's data is a third app: **Scriptable** (free, App Store, runs JavaScript, renders `WidgetKit` widgets).

**Build:** a small Scriptable script (not part of the Grid repo — lives in the Scriptable app on-device, or synced via iCloud Drive) that does a single `fetch()` to the Worker's read-only `/state` endpoint (same bearer token) and draws: today's streak numbers, cheer countdown, today's habit checkboxes as filled/empty glyphs. Reuse the same five circuit colors as the app (`--work #00B4FF`, `--cheer #FF2D95`, `--classes #A855F7`, `--habits #FF8A1E`, `--personal #22E39A`) so it reads as the same product, not a bolt-on.

**Refresh cadence:** iOS controls widget refresh timing, not you — expect 15–30 min lag, not live. Fine for streaks and a countdown; don't design anything that needs to be second-accurate.

## 5. Visual polish

- Checkbox toggle gets a brief scale+glow pulse instead of an instant snap — reinforces the "logged" moment
- Streak number ticks up with a short transform animation on increment, not an instant digit swap
- **No `navigator.vibrate()` haptics** — Safari on iOS has never implemented the Vibration API; don't plan for it, use a visual flash instead (already partially there via the box glow)
- Month-grid day cells get a pressed/active state on tap, not just on release
- A short boot-sequence flourish on first paint (sub-second, Tron-terminal flavor: a line or two of monospace text that resolves into the header) — skip on subsequent loads via a `sessionStorage` flag so it's not annoying
- Background circuit-line texture gets subtle directional motion tied to which panel is in view (CSS only, no JS cost)

## 6. Efficiency

- Keep the existing 120ms local-save debounce for `localStorage` — don't touch it, it's already correct
- Add a **separate**, longer debounce (2–3s, or on `visibilitychange`) before pushing to the Worker — local UI must never wait on the network
- Service worker: switch static assets (`index.html`, CSS-in-file, icons) to **cache-first with a versioned cache name**, bumped on deploy — instant loads instead of the current network-first pattern, which makes every load wait on a round-trip even when nothing changed. Keep the `/state` API call itself network-only (it's the one thing that must be fresh)
- Worker/KV reads should be **one JSON blob per fetch**, not one KV read per field — minimize billed reads even though the free tier is generous
- Audit that habit-toggle taps still only re-render the habit list and calendar dots (they do today) — don't regress this when sync code is added

## 7. Real icon

The current icon (five glowing bars) is the right concept — refine, don't redesign: cleaner glow falloff, slightly more rounded bar caps, maybe a subtle circuit-node dot at each bar's end to read as "grid" rather than "bar chart" at a glance.

**Important constraint to know going in:** iOS reads `apple-touch-icon` from the manifest **only at the moment you tap "Add to Home Screen"** — it does not live-update afterward. Changing the icon file on GitHub Pages will not change the icon already on your home screen. After the new icon ships, you'll need to **delete the current Grid icon from your home screen and re-add it from Safari.** This is a one-time step, not a recurring one — plan for it, don't be surprised by it.

There is no "upload an icon" step on iOS for a PWA — the icon comes from the manifest automatically. If you want a manual upload flow instead, that means switching from "Add to Home Screen" to a `Open URL` Shortcut with a custom photo as its icon — but that loses full-screen/offline PWA mode and reopens inside Safari's UI chrome. Not recommended; stick with the manifest-driven icon.

## 8. Data migration

No migration needed for existing local data — it stays in `localStorage` exactly as it is. The Worker starts empty and gets populated by the **first sync after the update ships** (app pushes its current local state up on next load). The existing Export/Import JSON buttons remain the backup path; don't build a second one.

## 9. Build order

1. Cloudflare account + Worker + KV namespace, empty `/state` GET/PUT endpoints with bearer-token auth
2. Wire the app's existing save path to also push to the Worker (debounced, best-effort, never blocks UI)
3. VAPID keys, push subscription flow, one working test notification end-to-end
4. Real trigger logic in the Cron Worker (start with just the evening habit nag, prove it fires correctly for a few days before adding the rest)
5. Scriptable widget reading `/state`
6. Visual polish pass
7. Efficiency pass (cache-first SW, sync debounce tuning)
8. New icon, re-add to home screen

Each step should leave the app fully working on its own — never ship a state where the core app depends on the Worker being up.
