# 🐟 Fishbowl Recorder

A free, self-hosted recording page for Team Velocity's monthly **Fishbowl** videos. It replaces VideoAsk.

Tributes open a personal link and answer one question at a time on camera, with a 3‑2‑1 countdown, a time limit on each answer, and unlimited re-records. Every answer uploads in the background to the Fishbowl Google Drive, named and organized for editing. Their row in the tracker sheet updates live (*Recording 5/16*) and turns green when they finish.

**Status:** built and tested locally (end to end, with a simulated Google backend). Ready to deploy. See **`docs/DEPLOY.md`**.

## How it fits together

```
Tracker sheet (Google Sheets + Apps Script, owned by teamvelocity.fishbowl@gmail.com)
   │  sends the calendar invite + reminders with a private link
   ▼
Recording page (this repo, free on GitHub Pages)
   teamvelocityfishbowl.github.io/fishbowl-recorder/?t=<private token>
   │  records each answer in the browser and uploads it in 4 MB pieces (retries on bad Wi‑Fi)
   ▼
Upload backend (Apps Script web app, the same script as the tracker)
   │  checks the token, joins the pieces, saves to Drive, updates the sheet
   ▼
Google Drive: Fishbowl 2027 / Colin Knox / 01 Intro.mp4, S1 Standing Desk or Sitting.mp4, … Photos/
```

The page lives on GitHub because Apps Script web pages have been blocked from using the camera since early 2026.

## Repo layout

| Path | What |
|---|---|
| `index.html`, `src/app.js`, `src/styles.css` | The recording page (plain HTML/CSS/JS, no build step) |
| `src/config.js` | **Backend URL** and recording quality |
| `config/questions.json` | Questions, order, time limits, and file names. Edit freely |
| `styles/tokens.css` | Team Velocity × Fishbowl colors and fonts |
| `backend/Fishbowl-Automation.gs` | The full tracker + upload script (paste into Apps Script) |
| `tools/convert-for-premiere.sh` | Makes edit-ready H.264 copies if ever needed |
| `docs/` | Plan, design, deploy guide, and test checklist |

## Try it locally
Open `index.html` through any local web server, e.g. `python3 -m http.server` in this folder, then visit `http://localhost:8000/?t=demo`. With `backendUrl` blank it runs in **preview mode** and nothing uploads.

## Brand assets to drop in
- Replace the "Team Velocity" text in the footer (`index.html`, `.tv-logo`) with the official **white** TV logo SVG.
- Optionally swap the drawn bowl for the official Fishbowl bowl icon.
