# Going live (about 20 minutes, one time)

Do everything in the **Fishbowl Chrome profile** (teamvelocity.fishbowl@gmail.com) unless a step says otherwise.

## 1. Update the tracker script
1. Open the tracker sheet → **Extensions → Apps Script**.
2. Paste `backend/Fishbowl-Automation.gs` over the old code, then **Save**.
3. Back in the sheet, reload. Then run **🐟 Fishbowl → ⚙️ Setup & troubleshooting → Set up / restyle sheet**.
   - This adds **Drive Folder** and a hidden **Link Token** column.
   - Google asks for one new permission (Google Drive). That's where the videos are saved. Click **Allow**.

## 2. Turn on the upload backend
1. In Apps Script: **Deploy → New deployment**, click the ⚙️ gear, and choose **Web app**.
2. Set **Execute as: Me** (the Fishbowl account) and **Who has access: Anyone**. Then **Deploy**.
3. Copy the **Web app URL** (it ends in `/exec`).
4. Open the URL in a browser. It should say *Fishbowl backend is live.*

> "Anyone" just means the recording page can reach it without a Google login. Every upload still needs a tribute's private link token.

## 3. Point the page at the backend
1. In this repo, open `src/config.js` and paste the URL into `backendUrl: '…/exec'`.
2. Commit and push (GitHub Desktop: write a summary → **Commit to main** → **Push origin**).

## 4. Publish the page (GitHub, work account)
1. Publish this repo from GitHub Desktop as **public** (untick "Keep this code private"). Free GitHub Pages needs a public repo.
2. On github.com, open the repo: **Settings → Pages**. Under **Source: Deploy from a branch**, pick **Branch: main / (root)** and **Save**.
3. After about a minute the site is live at `https://<username>.github.io/fishbowl-recorder/`.

## 5. Point the invites at the page
1. In Apps Script, set `RECORDER_URL: 'https://<username>.github.io/fishbowl-recorder/'` in CONFIG, then **Save**.

## 6. Test it
1. In the sheet, click a test row → **🐟 Fishbowl → Show recording link for selected row**.
   - The popup also shows a **demo link** (`?t=demo`) that anyone can try. Demo answers go to `Fishbowl 2027/_Demo Recordings/`, not the tracker.
2. Open your test row's link and record everything. The row should go **Recording 1/16 … 16/16 → Received ✅** with a 📁 link to the folder.
3. Try it on your phone too (sideways).

## Updating later
- **Questions, time limits, page design:** edit the repo and push. Live in about a minute.
- **Backend:** paste the new code, then **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. This keeps the same URL, so nothing else changes.

## For editing
- Recordings are in Drive: `Fishbowl 2027/<NN Month> - <Name>/` (e.g. `01 January - Colin Knox`). Sync that folder with Google Drive for desktop, or download it.
- Chrome and Safari record H.264 MP4, which drops straight into Premiere. If a file is WebM, or audio drifts, run:
  `./tools/convert-for-premiere.sh "/path/to/Fishbowl 2027/01 January - Colin Knox"` (needs `brew install ffmpeg`).
  Edit-ready copies land in `<Name>/_edit-ready/`.
