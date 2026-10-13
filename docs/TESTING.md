# Test checklist

## ✅ Automated (Oct 13, 2026: headless Chromium, fake camera, real backend code on a simulated Google)
- [x] Welcome → camera check (mic meter) → 16 questions → photos → done
- [x] 3‑2‑1 count-in, ring timer, auto-stop at the limit, early Stop, re-record
- [x] Background upload in 4 MB pieces. A forced server error on one piece was retried automatically
- [x] Resume: reload after 4 answers → "Hi again, Colin! You've saved 4 of 16" → continues at question 5
- [x] Files saved as `Fishbowl 2027/Colin Knox/01 Intro.mp4 … Q10 Good Mood Song.mp4`, 1280×720, correct lengths. Temp pieces cleaned up
- [x] Photos resized and saved to `Photos/`
- [x] Sheet: Status *Recording n/16* → **Received ✅**, VIDEO RECEIVED date, 📁 folder link
- [x] Invalid link → friendly error. Phone held upright → "Turn your phone sideways"
- [x] `tools/convert-for-premiere.sh` → H.264/AAC at a constant 30 fps

Note: the test browser (open-source Chromium) has no H.264 encoder, so it saved VP9 inside MP4. Real Chrome, Edge, and Safari record H.264.

## To do on real devices
| Device / browser | Camera prompt | Record + auto-stop | Re-record | Upload | Resume | Opens in Premiere |
|---|---|---|---|---|---|---|
| Mac Chrome | | | | | | |
| Mac Safari | | | | | | |
| Windows Chrome / Edge | | | | | | |
| iPhone Safari (sideways) | | | | | | |
| Android Chrome (sideways) | | | | | | |
| Slow Wi‑Fi / hotspot | | | | | | |
