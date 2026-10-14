# Fishbowl Builder (Premiere Pro panel)

Builds a Fishbowl edit from the template in one click: every answer from both tributes is cut in
after its question slide (Tribute 1, then Tribute 2), photos land on V2 after the outro, and
markers show who's who. Graphics (V2/V3) and the music bed (A2) are not touched.

## Install (once, and again after updates)
Double-click **Install Fishbowl Builder.command**, then restart Premiere Pro and open
**Window → Extensions → Fishbowl Builder**.

## Use
1. Download both tributes' folders from Drive (e.g. `01 January - Colin Knox`), or use Drive for desktop.
2. Open your month's project, double-click the template sequence **Fishbowl-Month-Year-v01** so it's in the timeline.
3. In the panel: **Check** → choose **Tribute 1** and **Tribute 2** folders → **Build sequence**.
4. A new sequence opens (the template stays as is). Change the intro names, extend the music bed to the
   red "Music bed ends here" marker, trim, place photos.

**Audio cleanup (step 5 in the panel, on by default):**
- *Cut dead air*: finds where each person starts and stops talking and sets in/out points with padding
  (0.4 s before, 0.6 s after). Nothing is deleted: drag a clip's edge to get frames back.
- *Even out voices*: measures each answer's loudness and sets its Volume level so everyone lands at −16 LUFS
  (the level past Fishbowls were mixed at, over the −20 dB music bed). Max +15 dB per clip; very quiet clips are listed.
- Uses ffmpeg, bundled in `extension/bin/ffmpeg` (Apple Silicon build from ffmpeg-static). The repo doesn't include it
  (too big); the copy in Desktop/Fishbowl/_Fishbowl Builder does. Homebrew's `ffmpeg` also works.

**Markers:** orange = Tribute 1, blue = Tribute 2, red = missing answer / music ends, yellow = photos.
Shift+M jumps to the next marker.

**Redos:** when someone re-records and Drive syncs the new file, click **Refresh updated clips**.

## How slides map to answers
| Slide on V1 | Answer code |
|---|---|
| Fishbowl-Intro | 01 (name, role, where you live) |
| Splash Round Intro | S1 |
| Splash Round 2–5 | S2–S5 |
| Question 2–11 | Q01–Q10 |
