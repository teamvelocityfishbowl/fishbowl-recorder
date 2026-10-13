# Design direction: Team Velocity × The Fishbowl

The idea: **the Fishbowl's playful teal world, inside Team Velocity's polished navy frame.** Internal, fun, laid back (the brand guide's "Internal" category), but still clean and professional. Nothing should look like a template.

## Color
| Token | Hex | Source | Use |
|---|---|---|---|
| `--tv-navy` | `#082642` | TV Dark Blue | Page background, headline text on light surfaces |
| `--tv-gradient` | `#054F6A → #082642` | TV gradient | App background |
| `--tv-light-blue` | `#0090B2` | TV Light Blue | Buttons, links, progress |
| `--tv-teal-blue` | `#156785` | TV Teal Blue | Secondary accents |
| `--fb-card` | `#15AFB5 → #008EB0` | Fishbowl question cards (sampled from the Sept video) | Question card |
| `--fb-splash` | `#4CD7FE` | Fishbowl Splash Round card | Splash Round questions |
| `--fb-water` | `#A0D3E5` | Fishbowl bowl water | Progress "water level", subtle fills |
| `--tv-light-gray` | `#F2F4F8` | TV Light Gray | Panels, review screen |
| `--rec` | `#E5484D` | functional | The recording dot and timer only |

Nice coincidence: the bottom of the Fishbowl card gradient (#008EB0) is almost exactly TV Light Blue (#0090B2), so the two palettes blend naturally.

## Type
- **Headlines / question text:** Trebuchet MS Bold (TV headline font, and close to the Fishbowl card lettering). Fallback stack for phones without it: `"Trebuchet MS", "Fira Sans", system-ui, sans-serif`.
- **Body:** Open Sans Regular (Google Fonts).
- **Buttons / CTA:** OPEN SANS, ALL CAPS, per the brand guide.
- Headlines in Title Case. Questions stay as written in the question doc.

## Signature elements
- **The bowl.** The Fishbowl "?" bowl icon sits above every question. Progress shows as the bowl's **water level rising** from question 1 to 16.
- **Splash Round.** Aqua card with white splash shapes, "SPLASH ROUND!", and a big "ONE WORD!" tag. The 7‑second timer ring is front and center.
- **TV "V" active icon** as the play/next arrow on buttons (the guide allows it as an arrow or play button, never alone as the logo).
- **Team Velocity logo** in white, small, in the footer. It's the only full logo on the page.

## Motion (TV motion rules)
- Smooth eases only. No bounce, wiggle, or elastic. Default ease ≈ AE In 95% / Out 85% → CSS `cubic-bezier(.2,.8,.2,1)`.
- Cards slide in with momentum and exit in the same direction. Lines stagger in by about 5 frames (~170 ms).
- A single circle burst when an answer is saved (the brand's one approved highlight).
- Respect `prefers-reduced-motion`.

## Layout
- Desktop: the camera preview is large on the left (16:9) and the question card is on the right.
- Phone: camera on top, card below. If the phone is upright, a "turn your phone sideways" overlay asks for landscape.
- Big, clear buttons. One primary action per screen.

## Copy tone
Direct, concise, approachable, fun ("We are… Direct, Concise, Fun, Welcoming"). Example: "Splash Round! One word. Go." Not cheesy.
