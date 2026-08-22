# Grid Scan — photo of a schedule → calendar events

Point it at a GroupMe screenshot, a printed class schedule, or the cheer season calendar. It reads every event and writes them all after you confirm.

Name it **exactly** `Grid Scan`.

---

## Why this one uses the cloud model

`Grid Quick Add` (one typed sentence) runs entirely on your phone — see [SHORTCUT.md](SHORTCUT.md). This one doesn't, for a reason worth understanding:

Reading a shift schedule is a **table** problem. A screenshot has rows, columns, merged cells, and a header row that says which week it is. Apple's on-device OCR flattens that into a jumble of text and loses which time belongs to which day. The on-device model then can't recover the structure, and it fails silently — you get plausible-looking events on wrong days.

Claude reads the image directly and keeps the layout. It's the difference between "this works" and "this mostly works and occasionally makes you miss a shift."

**Cost:** roughly **$0.04 per scan** on Claude Opus 4.8. Scanning a schedule every week is about **20¢/month**. If that ever matters, swap `claude-opus-4-8` for `claude-haiku-4-5` in the body below — 5× cheaper, noticeably worse at dense tables. Start with Opus.

---

## Setup: get an API key (5 min, one time)

1. Go to [console.anthropic.com](https://console.anthropic.com), sign in, add a payment method.
2. **API keys → Create key.** Name it `grid-phone`.
3. Copy it. It starts with `sk-ant-`.

**Paste it directly into the Shortcut on your phone in step 6 below — nowhere else.** Don't put it in the web app, don't put it in the GitHub repo, don't send it to anyone including me.

Two things to know:
- Anyone who can unlock your phone can open Shortcuts and read the key. That's the tradeoff for having no server. Acceptable for a personal key; don't reuse this key anywhere else.
- Set a **monthly spend limit** in the console (Settings → Limits). Set it to $5. If something ever loops, it stops at $5 instead of your card limit.

---

## Actions, in order

### Input

**1. `If`** — `Shortcut Input` **has any value**
- **Then:** `Get Images from Input` → input: `Shortcut Input` → save as `Img`
  *(this is the Share Sheet path — screenshot → Share → Grid Scan)*
- **Otherwise:** `Select Photos` → Select Multiple: **Off** → save as `Img`
  *(this is the Grid-button / home-screen path — it opens the photo picker)*
- **End If**

In the shortcut's settings (ⓘ), turn **Show in Share Sheet** ON and set Accepted Types to **Images** and **Text**.

**2. `Convert Image`** — input `Img`, Format: **JPEG**, save as `Img`
- Not optional. Screenshots are PNG, camera photos are JPEG. The request below declares `image/jpeg`; if the actual bytes are PNG the API rejects it. Converting first makes them always match.

**3. `Base64 Encode`** — input `Img`, **Line Breaks: None** → save as `B64`
- Line Breaks **must** be None. Base64 with newlines in it produces invalid JSON and the request fails with a parse error that tells you nothing useful.

**4. `Current Date`** → **`Format Date`** → Custom format `EEEE, MMMM d, yyyy` → save as `Today`
- This is how "Monday" and "8/3" get resolved to real dates.

### The request

**5. `Text`** — paste the block below as **one single line**. Do not press Enter inside it; a real line break inside a JSON string makes the whole body invalid.

Replace the two bracketed spots with variables (long-press → Insert Variable):
- `PASTE_B64_VARIABLE_HERE` → the `B64` variable from step 3
- `PASTE_TODAY_VARIABLE_HERE` → the `Today` variable from step 4

```
{"model":"claude-opus-4-8","max_tokens":4096,"output_config":{"format":{"type":"json_schema","schema":{"type":"object","properties":{"events":{"type":"array","items":{"type":"object","properties":{"calendar":{"type":"string","enum":["Work","Cheer","Classes","Habits","Personal"]},"title":{"type":"string"},"start":{"type":"string"},"end":{"type":"string"}},"required":["calendar","title","start","end"],"additionalProperties":false}}},"required":["events"],"additionalProperties":false}}},"messages":[{"role":"user","content":[{"type":"image","source":{"type":"base64","media_type":"image/jpeg","data":"PASTE_B64_VARIABLE_HERE"}},{"type":"text","text":"Today is PASTE_TODAY_VARIABLE_HERE. This image is a schedule. Extract every event you can read.\n\nRules:\n- calendar: Work for job shifts. Cheer for practices, games, exhibitions. Classes for college classes, lectures, labs, exams. Habits for study or meditation blocks. Personal for everything else.\n- title: short and clear. For a work shift just use the role or location if one is shown, otherwise 'Shift'.\n- start and end: exactly the format YYYY-MM-DD HH:mm in 24-hour time. Resolve weekday names and partial dates like 8/3 using today's date above. If no year is shown, pick the year that puts the date within the next 12 months.\n- If an end time is not shown, estimate a sensible one and keep the shift plausible.\n- Only include events you can actually read in the image. Never invent an event, a date, or a time. If a cell is blank or unreadable, skip it."}]}]}
```

`output_config` is doing real work here: it constrains the response to that exact schema, so you get parseable JSON every time instead of JSON wrapped in "Here's what I found:". `calendar` is an enum, so it can only ever be one of your five circuits.

**6. `Get Contents of URL`**
- URL: `https://api.anthropic.com/v1/messages`
- Method: **POST**
- **Headers** (three, exactly):

| Key | Value |
|---|---|
| `x-api-key` | your `sk-ant-…` key |
| `anthropic-version` | `2023-06-01` |
| `content-type` | `application/json` |

- **Request Body: `File`** — then pick the `Text` variable from step 5.
  Not `JSON`. The JSON body builder in Shortcuts can't express nested arrays like this. `File` mode sends your text as the raw body, which is what you want — that's also why `content-type` has to be set by hand.

### Parsing the response

**7. `Get Dictionary from Input`** — input: the result of step 6
**8. `Get Dictionary Value`** — Get **Value** for key `content` → save as `Blocks`
**9. `Get Item from List`** — `Blocks`, **First Item**
**10. `Get Dictionary Value`** — Get **Value** for key `text`
**11. `Get Dictionary from Input`** — on the result of step 10
**12. `Get Dictionary Value`** — Get **Value** for key `events` → save as `Events`

Steps 9–11 look redundant but aren't: step 8 gives you the API's content blocks, step 10 pulls the JSON *string* out of the first one, and step 11 parses that string into a real dictionary.

### Confirm before writing

**13. `Repeat with Each`** — `Events`:
- `Get Dictionary Value` `calendar` from `Repeat Item` → `C`
- `Get Dictionary Value` `title` from `Repeat Item` → `T`
- `Get Dictionary Value` `start` from `Repeat Item` → `S`
- `Text`: `C · T — S`
- `Add to Variable`: `Lines`
- **End Repeat**

**14. `Combine Text`** — `Lines`, separator: **New Lines** → `Preview`

**15. `Show Alert`**
- Title: `Add these events?`
- Message: `Preview`
- **Show Cancel Button: ON** ← this is the whole safety gate. Cancel stops the shortcut before anything is written.

### Write them

**16. `Repeat with Each`** — `Events`:
- `Get Dictionary Value` `calendar` → `C`
- `Get Dictionary Value` `title` → `T`
- `Get Dictionary Value` `start` → `Get Dates from Input` → `StartDate`
- `Get Dictionary Value` `end` → `Get Dates from Input` → `EndDate`
- `If` `C` **contains** `Work` → `Add New Event` (Calendar: **Work**, Title `T`, Start `StartDate`, End `EndDate`)
  - Otherwise If contains `Cheer` → **Cheer**
  - Otherwise If contains `Classes` → **Classes**
  - Otherwise If contains `Habits` → **Habits**
  - Otherwise → **Personal**
- **End Repeat**

**17. `Count`** — `Events` → **`Show Notification`**: `Added [Count] events to Grid`

---

## Test before you trust it

Screenshot your actual GroupMe schedule and run it. Then check three things in Apple Calendar:

1. **Right number of events.** Miscounts mean it misread the table structure.
2. **Right days.** This is where table-reading fails if it fails.
3. **Right times, including AM/PM.** A 6pm shift landing at 6am is the classic error.

If any of those are wrong, screenshot the schedule *and* what it produced, and we'll tune the prompt. Don't just accept it and manually fix — a systematic misread will repeat every week.

---

## When it breaks

| Symptom | Cause |
|---|---|
| Nothing happens on tap | Shortcut name isn't exactly `Grid Scan` |
| "Could not parse request body" | Line break inside the step-5 text, or Base64 Line Breaks isn't None |
| `authentication_error` | Key wrong, or `x-api-key` header misspelled |
| `invalid_request_error` about media_type | The Convert Image → JPEG step is missing |
| Empty / no events added | Image too blurry or cropped. Retake it. The prompt tells it not to invent events, so a bad photo correctly produces nothing |
| Right events, wrong dates | Screenshot the schedule and the result — the prompt needs tuning for that layout |

To see the raw error: add a `Quick Look` action right after step 6 and run it again. The API returns readable error messages.

---

## v2 backlog

- Multi-select confirmation (pick which events to add) instead of all-or-nothing
- Duplicate detection — scanning the same schedule twice currently creates duplicates
- Recurring class schedules as repeating events rather than individual ones
