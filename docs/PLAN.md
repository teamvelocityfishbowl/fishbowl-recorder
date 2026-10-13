# Build plan

## Goals (from the problems we're solving)
1. **People never record** → the calendar invite and reminders are already handled by the tracker. The recorder has to make the recording itself fast and easy.
2. **People do it wrong** (skip questions, ramble in the Splash Round) → strict order, one question at a time, and a hard time limit on each answer.
3. **Tracking** → the row turns green on its own when the last answer uploads.
4. **Editing** → the editor gets one clean, named file per answer in Drive.

## Tribute flow (screens)
1. **Welcome**: "Hi {First}! Welcome to The Fishbowl 🐟". About 15 min, a progress preview, and "Let's go".
2. **Camera check**: live preview, a mic level meter, and a reminder to use landscape and put the light in front of them. We ask for permission here, once.
3. **Question screen**, repeated for every question:
   - A question card in Fishbowl teal, with a progress bar showing question X of 16.
   - **Record** → a 3‑2‑1 count‑in → recording with a ring timer → auto-stop at the limit (or **Stop**).
   - **Review**: play it back, then **Re-record** (unlimited) or **Use this take** → upload in the background → next question.
   - **Splash Round** questions get the aqua splash style and "ONE WORD!"
4. **Photos**: drag and drop or pick 3–6 photos, uploaded with a preview.
5. **Done**: "That's a wrap! 🐟" Their row turns green.

**Resume:** if they close the tab, the same link picks up at the next unanswered question.

## Questions (from the 2026 question doc, in `config/questions.json`)
- Intro: 1 question, **45 s**
- Splash Round: 5 questions, **7 s** each
- Deep dive: 10 questions, **60 s** each
- Photo upload step

## Backend (added to the existing tracker Apps Script)
A `doPost` handles these actions. They're plain-text JSON bodies, so they skip CORS preflight.

| Action | Does |
|---|---|
| `start` | Token → tribute name, which questions are already done, and upload settings |
| `chunk` | Receives one piece (~5 MB, base64) of an answer and stores it temporarily in Drive |
| `finish` | Stitches the pieces into one file, saves it as `NN Question.mp4`, and deletes the temp pieces |
| `photo` | Saves one photo into `Photos/` |
| `complete` | Marks VIDEO RECEIVED ✅ and links the person's Drive folder in the sheet |

- **Personal links:** each row gets a random token, kept in a hidden column. The link carries the token, so nobody types a name or email, and nobody can upload without a valid token.
- **Chunked uploads:** these survive spotty Wi‑Fi. A failed chunk retries automatically.
- **Sheet changes:** add a hidden **Link Token** column and a **Drive Folder** link column. Invites and reminders switch from the VideoAsk link to `…github.io/fishbowl-recorder/?t=TOKEN`. A CONFIG switch keeps VideoAsk available as a fallback.

## Drive layout (Fishbowl Gmail)
```
Fishbowl 2027/
  Colin Knox/
    01 Intro.mp4
    S1 Standing Desk or Sitting.mp4  …  S5 Mac or PC.mp4
    Q01 Favorite Company Memory.mp4  …  Q10 Good Mood Song.mp4
    Photos/
  _uploads-in-progress/   (temp pieces, cleaned up automatically)
```
Share `Fishbowl 2027/` with Jake (editor). It can sync to the Mac with Google Drive for desktop and drop straight into Premiere.

## Video format
- **720p, ~2.5 Mbps, with audio.** That's about 19 MB per minute, and roughly 100–150 MB per person.
- **MP4 (H.264/AAC)** wherever the browser supports it: current Chrome, Edge, and Safari on Mac and iPhone. **WebM** is the fallback (Firefox). WebM files may need a quick conversion in Media Encoder.
- Browser recordings can have a variable frame rate. If audio drifts in Premiere, conform or transcode first. We'll check this during testing.

## Limits and costs
- **$0.** GitHub Pages and Apps Script are free.
- **Storage:** the free Gmail has 15 GB. 52 people at 100–150 MB each is about 5–8 GB. If it fills up, Google One 100 GB is about $2/mo.
- **Apps Script:** 6 min per call (each chunk takes seconds) and about 30 uploads at once. Fine for us.
- **GitHub Pages:** free on **public** repos. The code is public, but no secrets live here: uploads need a valid personal token.

## Build phases
1. **Backend:** the upload endpoint, the Drive layout, the token column, and the sheet hooks. Tested with a script.
2. **Recorder page:** the screens above, recording and upload, resume.
3. **Wire up:** invites point to the new link. Turn on GitHub Pages.
4. **Test matrix** (`docs/TESTING.md`): Mac Chrome, Mac Safari, Windows Edge/Chrome, iPhone Safari, Android Chrome, plus a slow-connection test and a Premiere import test.
5. **Pilot:** 2–3 friendly coworkers before January.

## Open decisions (defaults in brackets)
- Time limits [Intro 45 s · Splash 7 s · Deep 60 s]
- Re-record [unlimited until they click "Use this take"]
- Photos [one step at the end, 3–6 photos, optional]
- Allow skipping a question? [No, but they can answer "pass" on camera]
- Repo name / URL [`fishbowl-recorder` → mightyjake.github.io/fishbowl-recorder]
