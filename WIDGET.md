# Grid widget — today's schedule, tickable to-dos

`widget/grid-widget.js` is the canonical source; the running copy lives in the Scriptable app on the phone. Paste the file's contents into a Scriptable script, name it whatever you like, and put it on the home screen at **medium** or **large**.

It shows today and only today: the day's calendar events, then the day's open to-dos with a box you can tap.

## What changed from the old widget

| Old | Now |
|---|---|
| Next event across the coming 14 days | Today's events only |
| No to-dos | Today's open to-dos, including rolled-over and weekly ones |
| No taps | Tap a to-do row to tick it off |
| No token, no network | Needs the sync token (to-dos live in Grid, not on the calendar) |
| Read the calendar | Also mirrors the next 21 days to the Worker, which is what fills the app's hour-by-hour day view |

Events still draw with no token and no network. Only the to-do half needs either.

## Setup

**1. Paste the script in.** Scriptable → **+** → paste the contents of `widget/grid-widget.js`.

**2. Run it once inside Scriptable.** It asks for the sync token — the same one you saved in the Grid app — and stores it in the **iOS Keychain**, not in the script.

> The script file syncs through iCloud Drive and has a copy in the repo. Neither is a place for a bearer token, which is why it's never written into the file. If you ever need to clear it, delete the script's Keychain entry by running `Keychain.remove("grid-sync-token")` in a scratch script.

**3. Add it to the home screen** at medium or large.

**4. Give it a minute.** The first run pushes your calendar to the Worker; open Grid afterwards and tap a day to see the hour grid fill in.

## Why the tap flashes

A home-screen widget runs no code when you tap it — iOS only lets it open a URL. So the checkbox opens this same script with a `?toggle=` parameter, which flips the item on the Worker and exits. **Scriptable visibly launches for about a second each time.** That's the cost of a tickable box on the home screen; there's no API that avoids it.

Two consequences:

- **The widget may not redraw immediately.** iOS decides when widgets refresh; the script asks for one at most every 15 minutes and just after the next event starts. The tap did land — it's the picture that's stale.
- **The app catches up on its own.** The toggle is written to the Worker's mirrored state *and* queued as an operation. Grid applies the queue on its next launch or foreground, so `localStorage` — which is still the real source of truth — converges either way.

A **small** widget can't do this at all: iOS gives it exactly one tap target for the whole widget. At that size the script shows the next event and a to-do count, and tapping opens Grid.

## Sizes

| Size | Shows |
|---|---|
| Small | Next event + open to-do count. Tap opens Grid |
| Medium | 3 events, 3 to-dos |
| Large | 7 events, 6 to-dos |

Rows beyond the cap collapse into a `+N more` line.

## Row markers

| Marker | Means |
|---|---|
| `LATE` (pink) | Rolled over from an earlier day and still not done |
| `WKLY` | A weekly repeat, projected onto today |
| Dimmed event | Already finished |

## When it doesn't work

| Symptom | Cause |
|---|---|
| `NO TOKEN` | Run the script inside Scriptable once and paste the token |
| `OFFLINE` | The Worker couldn't be reached. Events still show |
| `NO CALENDAR ACCESS` | Scriptable was denied calendar permission — iOS Settings → Scriptable → Calendars |
| To-dos never tick | The tap opened Scriptable but the token is wrong. Run the script by hand and watch for a `401` |
| Day view in the app stays empty | The widget hasn't run since you added it. Open Scriptable and run the script once by hand |
| Widget shows yesterday | iOS hasn't refreshed it. Nothing to fix — it rolls over on the next refresh |
