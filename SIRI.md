# Siri — talk to Grid without touching the phone

Two shortcuts, two sentences:

| Say | Runs | Lands in |
|---|---|---|
| "Hey Siri, **Grid Quick Add**" | the existing calendar shortcut | Apple Calendar, in the right Grid calendar |
| "Hey Siri, **Grid Todo**" | the new one below | Grid's To-Do panel, on the right day |

Siri runs a shortcut when you say its name. So the shortcut *name is the phrase* — no separate "Add to Siri" step, and no phrase to memorise beyond the name itself.

Both shortcuts need one change from how they were originally written: they have to ask for their input when Siri starts them, because Siri has no typed sentence to hand over.

---

## Part 1 — make `Grid Quick Add` answer Siri

Open the existing `Grid Quick Add` shortcut and put these two actions at the very top, **above** `Get Dates from Input`:

**1. `If`** — `Shortcut Input` **has any value**
- **Then:** `Text` → set to `Shortcut Input`
- **Otherwise:** `Ask for Input` → Input type **Text**, prompt: `What's the event?`
- **End If**

**2. `Set Variable`** — name it `Sentence`, value = the `If` result (Shortcut Result).

Then replace **every** later use of `Shortcut Input` with `Sentence`:
- `Get Dates from Input` → input `Sentence`
- the `Use Model` prompt → `"[Sentence]"`
- the title `Text` action → `Sentence`

Nothing else changes. Typing in the web app still works exactly as before — that path fills `Shortcut Input`, so the `If` takes the Then branch and never asks.

**Test it:** "Hey Siri, Grid Quick Add" → Siri asks what the event is → say `dentist thursday at two` → the confirmation menu appears → tap **Add**.

> With AirPods in or on a locked screen, Siri may read the `Choose from Menu` options aloud instead of showing them. Answer "Add" out loud. If you'd rather it never ask, delete the menu — but then a bad parse writes straight to your calendar.

---

## Part 2 — build `Grid Todo`

Name it **exactly** `Grid Todo`. That string is the Siri phrase.

Before you start, have your Grid sync token ready — the same 24-character token you pasted into the app's **Sync** panel. It goes into step 5 and nowhere else.

### Actions, in order

**1. `If`** — `Shortcut Input` **has any value**
- **Then:** `Text` → set to `Shortcut Input`
- **Otherwise:** `Ask for Input` → Input type **Text**, prompt: `What's on the list?`
- **End If**

**2. `Set Variable`** — name `Item`, value = Shortcut Result.

**3. `If`** — `Item` **has any value**
- **Otherwise:** `Stop Shortcut`
- **End If**

> Siri hands back an empty string if you say nothing. Without this you get a blank row in the app.

**4. `Get Dates from Input`** → input: `Item` → save as `Due`, then `Format Date`:
- Date: `Due`
- Date Format: **Custom** → `yyyy-MM-dd`
- Save as `DueYmd`

> Same data detector as the calendar shortcut, for the same reason: "pack cheer bag friday" should land on Friday, and Apple's parser is the only thing on the phone that gets that reliably right. If the sentence has no date in it, `DueYmd` comes out empty and the server files it under today — which is what you want for "call mom".

**5. `Get Contents of URL`**
- URL: `https://grid-sync.gabealvarez.workers.dev/todo`
- Method: **POST**
- Headers:
  | Key | Value |
  |---|---|
  | `authorization` | `Bearer YOUR_TOKEN_HERE` (one space after Bearer) |
  | `content-type` | `application/json` |
- Request Body: **JSON**
  | Key | Type | Value |
  |---|---|---|
  | `text` | Text | `Item` |
  | `date` | Text | `DueYmd` |

> This is a flat dictionary, so the JSON body builder handles it — unlike `Grid Scan`, which needed File mode for its nested arrays.

**6. `Show Notification`**
- Title: `Added to Grid`
- Body: `Item`

Optional, and better with AirPods: swap the notification for `Speak Text` → `Added: [Item]`.

### Test cases

| Say | Expect |
|---|---|
| "Hey Siri, Grid Todo" → `buy poster board` | appears under **Today** next time you open Grid |
| "Hey Siri, Grid Todo" → `pack cheer bag friday` | appears under **Fri, …**; today's list unchanged |
| "Hey Siri, Grid Todo" → *silence* | nothing added, no error |

---

## How the item actually reaches the app

The shortcut can't write to the app directly. The app's real storage is `localStorage` on the phone, and a shortcut has no way in. So:

1. The shortcut POSTs the one line to the Worker, which appends it to a queue (`inbox` in KV).
2. Grid drains that queue on launch and every time you switch back to it, writes the items into `localStorage`, and tells the Worker to delete what it took.

Two consequences worth knowing:

- **Spoken items appear when you next open Grid**, not instantly. The badge you're looking for is the toast: "2 items from Siri".
- **Nothing is ever overwritten.** The queue exists specifically so a shortcut never has to PUT the whole state — it doesn't have the whole state, and a blind write would wipe whatever you logged since. Each item is deleted from the server only after it's safely in `localStorage`, and it carries an id so a failed delete can't duplicate it on the next drain.

## When it doesn't work

| Symptom | Cause |
|---|---|
| Siri: "I don't have an app for that" | Shortcut name isn't exactly `Grid Todo` |
| Shortcut shows a `401` | Token wrong, or the `Bearer ` prefix is missing |
| Item lands on the wrong day | The sentence's date was ambiguous — check what `Get Dates from Input` returned by running the shortcut manually with the results shown |
| Items never appear in the app | Grid's Sync token isn't set in the app, so it never drains the queue. Open Grid → **Sync** → paste the token |
