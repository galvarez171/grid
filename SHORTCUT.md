# Grid Quick Add — Shortcut recipe (corrected)

**What changed from the original plan and why:**

| Original | Problem | Now |
|---|---|---|
| Model outputs ISO 8601 start + end | On-device model is small; date arithmetic on "Thursday"/"tomorrow" is exactly where it hallucinates, and it fails *silently* — a wrong-date event just appears | Model never touches dates. `Get Dates from Input` (Apple's own data detector) reads the date off your original sentence |
| `Split Text` → `Get Item at Index 1..4` | One blank line or a "Sure!" preamble shifts every index and the whole thing breaks | Model returns one word. Nothing to index |
| Web app previews, then shortcut re-parses | Two different parsers, so the preview can disagree with what actually lands | Shortcut is the only parser and shows its own confirmation |
| No confirmation before write | Bad parse goes straight into your calendar | `Choose from Menu` gate before writing |

The shortcut must be named **exactly** `Grid Quick Add`.

---

## Actions, in order

**1. Receive input**
- Shortcut settings (ⓘ icon) → toggle **Show in Share Sheet** OFF, but confirm **Shortcut Input** is available. When launched by URL the typed sentence arrives as `Shortcut Input`.

**2. `Get Dates from Input`**
- Input: **Shortcut Input**
- Save result as variable `StartDate`.
- This is the whole date fix. It's the same engine that makes dates tappable in Mail — "thursday 2pm", "tomorrow at 5", "aug 4 6:30pm" all resolve correctly, relative to right now, in your timezone, with DST handled.

**3. `If`** — `StartDate` **has no value**
- `Show Alert`: "Couldn't find a date in that. Try: dentist thursday 2pm"
- `Stop Shortcut`
- **End If**

> This is the loud failure. Better than a silently wrong event.

**4. `Add to Date`** — add **1 Hour** to `StartDate` → save as `EndDate`
- Default duration. Adjust to 2 hours if most of your entries run longer.

**5. `Use Model`** (Apple Intelligence)
- Follow up: **Off**
- Output type: **Text**
- Prompt (paste exactly; `[Shortcut Input]` is the variable):

```
Pick the single best category for this request: "[Shortcut Input]"

Work — job shifts
Cheer — cheer practices, games, exhibitions
Classes — college classes, lectures, labs, exams
Habits — meditation, studying, learning, personal routines
Personal — family, appointments, errands, downtime

Answer with one word only: Work, Cheer, Classes, Habits, or Personal.
```

- Save result as `Category`.
- One-word classification is what a small model is genuinely good at. And a miscategorized event is a 2-second drag between calendars — a mis-dated one makes you miss the appointment.

**6. `Text`** — build the title
- Set to **Shortcut Input**, save as `EventTitle`.
- Optional upgrade later: a second `Use Model` call to clean the title up. Skip for v1 — the raw sentence as a title is perfectly readable and costs nothing to get wrong.

**7. `Choose from Menu`** — prompt:
```
[Category] · [EventTitle]
[StartDate]
```
- Menu item **Add** → continue to step 8
- Menu item **Cancel** → `Stop Shortcut`

> The confirmation the plan wanted, living in the one place that knows the real parse.

**8. `If`** on `Category` **contains** `Work`
- `Add New Event` — Calendar: **Work**, Title: `EventTitle`, Start: `StartDate`, End: `EndDate`
- **Otherwise If** contains `Cheer` → Add New Event on **Cheer**
- **Otherwise If** contains `Classes` → **Classes**
- **Otherwise If** contains `Habits` → **Habits**
- **Otherwise** → **Personal**
- **End If**

> Order matters. Check `Classes` before `Cheer`? No — no substring collisions among these five, any order works. Keep `Personal` as the final Otherwise so nothing is ever dropped.

**9. `Show Notification`**
- Title: `Added to Grid`
- Body: `[EventTitle] — [StartDate]`

---

## Test cases — run all five before trusting it

| Type this | Expect |
|---|---|
| `dentist thursday 2pm` | Personal, this coming Thursday 2:00pm |
| `work shift tomorrow 4pm to 10pm` | Work, tomorrow (end may be 5pm — see note) |
| `cheer practice monday 6pm` | Cheer, next Monday 6:00pm |
| `bio lecture aug 4 10am` | Classes, Aug 4 10:00am |
| `asdfgh` | Alert: "Couldn't find a date in that" |

**Note on ranges:** `Get Dates from Input` returns the *start*. "4pm to 10pm" gives you 4pm + 1 hour. Fix the end time by hand in Calendar, or in v2 add a second `Get Dates from Input` with **Get All Dates** and use item 2 as `EndDate` when it exists.

---

## When it fails silently

Three causes, in order of likelihood:

1. **Shortcut name mismatch.** Must be `Grid Quick Add` — character for character, one space between each word. Retype it, don't trust the eye.
2. **Calendar name mismatch.** `Work`, `Cheer`, `Classes`, `Habits`, `Personal`. If you named one "Work Shifts", the `Add New Event` action silently points at nothing.
3. **Nothing happened at all when you tapped Send.** The `shortcuts://` handoff never fired — that's a browser problem, not a shortcut problem. See BUILD.md.

## v2 backlog

- Edit/cancel existing events ("cheer practice moved to 5pm") via `Find Calendar Events` before `Add New Event`.
- Real end times from date ranges.
- Second shortcut for bulk weekly shift entry from GroupMe.
