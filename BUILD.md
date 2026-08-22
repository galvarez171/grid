# Grid — build reference (v2)

Supersedes `Grid_Build_Reference.pdf`. The concept, five circuits, and visual identity are unchanged. What changed is *where the app lives*, *how events get in*, and fixes to streak logic the original spec left undefined.

---

## What "one place for everything" actually means on iOS

Worth being straight about this before you build, because the honest version is better than the version you're probably picturing.

**Apple Calendar is where you see everything.** It's already on your lock screen, in your widgets, and in your notifications. No web app can compete with that, and none should try — a web page can't read your calendar at all. Apple provides no API for it.

**Grid is where you put things in and track things.** Two buttons on one screen cover every way an event ever reaches you:

| It arrives as | You do | Behind it |
|---|---|---|
| A thought — "dentist Thursday 2pm" | Type it, tap **Send to Calendar** | `Grid Quick Add` — on-device, free, instant |
| A picture — GroupMe shifts, class schedule, cheer calendar | Tap **Scan a Schedule**, pick the photo | `Grid Scan` — reads the whole table at once |
| Something in another app | Share → **Grid Quick Add** / **Grid Scan** | Same two shortcuts, from anywhere |

Grid also holds your streaks, cheer stats, and the Sunday reset — the things Apple Calendar has no place for.

So: **one input surface, one view surface.** Not one app. Anyone who tells you a web page can be your iPhone calendar is selling you a worse calendar.

### The one hard limit

**You cannot upload a photo through the Grid web page.** A URL scheme carries a few thousand characters; a photo is several million. There is no version of this that works.

That's why **Scan a Schedule** launches the shortcut with no input and the *shortcut* opens the photo picker. Same number of taps, and it also works from the Share Sheet, which the upload version wouldn't.

---

## What's in this folder

| File | What it is |
|---|---|
| `index.html` | The whole app. One file, no build step, no dependencies |
| `sw.js` | Service worker — makes it work offline on the phone |
| `manifest.webmanifest` | Home-screen app metadata |
| `icon-180.png` / `icon-512.png` | App icon |
| `SHORTCUT.md` | `Grid Quick Add` — typed sentence → one event (on-device) |
| `CAPTURE.md` | `Grid Scan` — photo of a schedule → many events (needs an API key) |
| `BUILD.md` | This file |

---

## Corrections to the original plan

**1. Hosting moved off Claude Artifacts.**
Artifacts render inside a sandboxed iframe. Two consequences the original plan didn't account for: custom URL schemes like `shortcuts://` are normally blocked from a sandbox, and storage tied to a sandbox origin isn't durable. That put both the one unfinished feature *and* the entire streak history on the same bet. Grid is now a plain static page you host yourself — top-level navigation, a stable origin, and no claude.ai login between you and the app.

**2. Quick Add no longer asks the model to do date math.**
See `SHORTCUT.md`. Short version: `Get Dates from Input` handles time, the model only picks a category.

**3. The web app doesn't parse at all.**
The original had a JS preview *and* a shortcut parse. Two parsers eventually disagree, and the one you see isn't the one that writes. Now the sentence goes straight to the shortcut, which shows its own confirmation before writing.

**4. Streaks are stored as dates, not counters.**
A counter that resets on a missed day is unrepairable — miss one tap and history is gone. Grid stores the set of days. The streak is derived, so tapping any past day in the month grid backfills or undoes it.

**5. Class attendance skips non-class days.**
The original never said what Saturday does to the attendance streak. Set your class weekdays in the app; days without class are skipped — they neither extend nor break the streak.

**6. Today gets grace.**
An unchecked today doesn't zero your streak, because the day isn't over. It counts from yesterday until you tap it.

**7. Cheer countdown has an explicit source.**
The app can't read Apple Calendar, so the next-event name and date are fields you set. Setting them is part of the Sunday Reset checklist.

**8. The month grid shows your actual data.**
Colored dots per logged habit, plus cheer. Tap any past day to edit it.

**9. Backup exists.**
Export/Import JSON at the bottom. Clearing Safari data wipes local storage — export after any long streak you'd hate to lose.

---

## Build steps

### Part 1 — The five calendars (~5 min)

Calendar app → **Calendars** → **Add Calendar…**. Create five, spelled exactly:

| Name | Color | Holds |
|---|---|---|
| `Work` | Blue | Shifts — irregular, from GroupMe, entered manually |
| `Cheer` | Pink | Practices and events |
| `Classes` | Purple | Fixed weekly class schedule, recurring |
| `Habits` | Orange | Meditation, the Learning slot |
| `Personal` | Green | Family, appointments, downtime |

Apple's color presets won't match the app's hex values exactly. Doesn't matter.

### Part 2 — Host Grid (~10 min, once)

GitHub Pages. Free, HTTPS, permanent URL.

1. Create a GitHub account if you don't have one.
2. New repository → name it `grid` → **Public** → Create.
3. **Add file → Upload files** → drag in all five: `index.html`, `sw.js`, `manifest.webmanifest`, `icon-180.png`, `icon-512.png` → Commit.
4. **Settings → Pages** → Source: **Deploy from a branch** → Branch: `main`, folder `/ (root)` → Save.
5. Wait ~1 minute. Your URL is `https://YOURNAME.github.io/grid/`.

Public repo means the *code* is public. Your streak data never leaves your phone — it's in browser storage, not the repo.

### Part 3 — Home screen (~1 min)

1. Open your Pages URL in **Safari** on the iPhone (must be Safari — Chrome's Add to Home Screen doesn't produce a standalone app).
2. Share → **Add to Home Screen** → Add.
3. Launch from the icon. No Safari chrome, full screen, works offline.

### Part 4 — `Grid Quick Add` (~15 min)

Follow [SHORTCUT.md](SHORTCUT.md). Prerequisite: Settings → **Apple Intelligence & Siri** → on and fully downloaded. Runs entirely on-device, costs nothing.

### Part 4b — `Grid Scan` (~25 min)

Follow [CAPTURE.md](CAPTURE.md). This is the photo-of-a-schedule path. It needs an Anthropic API key, which you create and paste into the Shortcut yourself — it never goes in the web app or the repo. Roughly **$0.04 per scan**; set a $5/month spend limit in the console and forget about it.

Build Part 4 first and confirm it works end to end. Part 4b is longer and you don't want to be debugging two new things at once.

### Part 5 — Test

1. Open Grid from the home screen.
2. Type `dentist thursday 2pm` → **Send to Calendar**.
3. First run only: iOS asks permission to open Shortcuts — Allow.
4. Shortcut shows `Personal · dentist thursday 2pm` + the resolved date → tap **Add**.
5. Check Apple Calendar: right calendar, right color, right time.

**If tapping Send does nothing at all** — the handoff isn't reaching Shortcuts. Test the scheme in isolation: paste this into Safari's address bar:

```
shortcuts://run-shortcut?name=Grid%20Quick%20Add&input=text&text=test%20friday%203pm
```

If that works but the button doesn't, it's the page. If neither works, the shortcut name doesn't match.

---

## Updating the app later

Edit `index.html`, re-upload to GitHub, **and bump `CACHE = "grid-v1"` in `sw.js`** to `grid-v2`. Skip the bump and phones keep serving the old cached version.

---

## Open items

- [ ] Host on GitHub Pages, add to home screen (Parts 2–3)
- [ ] Build and test `Grid Quick Add` end-to-end (Part 4)
- [ ] Build and test `Grid Scan` against a real GroupMe screenshot (Part 4b)
- [ ] v2: edit/cancel existing events ("moved to 5pm") via `Find Calendar Events`
- [ ] v2: real end times from date ranges ("4pm to 10pm")
- [ ] v2: duplicate detection on scan — rescanning the same schedule currently doubles it
- [ ] v2: multi-select on the scan confirmation instead of all-or-nothing
