# Pump Rider

**A one-button arcade game about riding a memecoin chart — where the payout is decided by your hands, not by the house.**

You are a rocket skimming a live, procedurally generated price chart. The chart is the ground. Before each run you stake play money and call a target bar ("I will clear +200%"). Hold to climb, release to fall, chain the orbs, survive the rug pulls — then the run settles against the bar you called: clear it and the bag pays out at your run's multiple; miss it by a single point and the whole bag is gone. Every run ends as a shareable PnL card whose figures all come from the run itself.

Built for **NEAR Hackathon 2026 — Games track**. Solo build.

**Play it now:**

- **Submission build (this repo):** https://tobadaniel.github.io/PUMP-RIDER/
- **Product build (Netlify):** https://pump-rider.netlify.app — the identical game, shipped as a standalone product without the hackathon affiliation layer (see "Two builds" below).

No install, no wallet, no sign-up, no network calls. It runs in any modern browser, phone or desktop.

## The problem

Rug-style memecoin games are theatre. The outcome is decided by automation behind a chart animation — the house picks when you eat — and the PnL card afterwards is marketing: gains framed against flattering baselines, losses quietly rebranded. The player never actually decides anything, and the scorecard never has to tell the truth.

Pump Rider removes the house twice over:

1. **There is no outcome roll.** The chart is generated from a seed, but nothing decides your fate mid-run: the rocket does exactly what your one button does. Every point is distance flown, an orb you clipped, a line you skimmed, a rug you survived.
2. **Settlement is against a bar you called before the run.** Because the target is yours and fixed in advance, the end-of-run card cannot flatter you. Clear the bar and it pays the full multiple; miss it and the card turns red and shows OUT $0, even if the run outscored your last one (that comparison survives only as a quiet note under the money line).

Difficulty is priced the same honest way: the speed/pump/gravity settings act as volatility and scale how fast points accrue, so picking an easier ride visibly pays less. Risk, reward and result are all on the table before you start.

## Try it (for judges)

Each step is do-this, see-that. A full pass takes about three minutes.

1. **Open https://tobadaniel.github.io/PUMP-RIDER/** → the game loads as a single page: the start card sits over a frozen chart scene, with the HUD boxes (SCORE, BEST, COMBO, ORBS, SPEED) above it.
2. **Tap "Start riding"** → the stake card opens: "how much are you willing to risk, ser?", with $10 preselected and the bar preset to +200%.
3. **Tap the $50 chip, then the +200% chip under CALL YOUR BAR** → the card confirms "you need 300 pts to clear the bar" and the button now reads "APE IN $50".
4. **Tap "APE IN $50"** → the run starts. Press and hold anywhere on the stage (or hold Space) and the rocket climbs; release and it falls. Touching the glowing chart line ends the run.
5. **Fly through the round NEAR orbs** → each pays 20 points × the multiplier in the COMBO box; chain orbs without missing one and the combo climbs to x4. Skim just above the line without touching it → "that was NEAR! +15".
6. **When "RUG PULL INBOUND" flashes, keep flying** → the chart cliff-drops and bounces back up; survive the whole event and +150 lands.
7. **Stay alive until SCORE passes 300, then let the rocket settle onto the line** → the game-over card glows **green**: a BAR CLEARED pill, your score as the hero number, and the money line "IN $50 → OUT $… · +$…" (OUT = $50 × score ÷ 100). Crash before 300 instead and the same card glows **red** — MISSED THE BAR, OUT $0. Both outcomes are the settlement working as designed.
8. **On the card, tap "run it back"** → you land back on the stake card with $50 and +200% prefilled. Nothing restarts on its own; the next run begins only when you ape in again.
9. **APE IN and crash on purpose within a few seconds** → this card's chart draws **two lines on one scale**: the short run as the thick line, your previous long run as the thin muted line labelled "last run", with the dashed BAR line across both.
10. **On that card, tap DIFFICULTY to expand it and drag the Speed slider up, then down** → the "VOLATILITY · PAYOUT x…" readout moves with the sliders (about x1.25 at the ceiling, x0.75 at the floor). Difficulty re-prices every point the next run can earn.
11. **Tap "run it back", then tap the NEAR side of the $ / NEAR toggle** → the stake ladder becomes 1, 5, 10, 50, 100, 250 NEAR, and the card shows the printed reference rate "1 near ≈ $3.63 · reference rate, nov 7". Settlement follows the active unit.
12. **Start one more run, crash, and on the game-over card tap "reset"** → the button arms: "sure? tap again to wipe". Tap it again → everything the game stored is wiped (best, last run, stake, bar, difficulty, currency) and you are back at the start card on factory defaults: BEST 0, $10, +200%, Chill, USD.

## How to play

- **Controls.** Hold (Space, mouse, or touch) to thrust, release to fall. **P** or the ⏸ button at the stage's top-right pauses (it flips to ▶ while paused); **M** or the speaker button mutes; the 🌙/☀️ button in the header switches theme.
- **Scoring.** Distance flown pays continuously. Orbs pay 20 × combo; the combo chains to x4 and resets when an orb passes uncollected. Close calls pay +15. Rug pulls are telegraphed ("RUG PULL INBOUND"), then the chart cliff-drops and dead-cat-bounces back up, which is the part that kills you; surviving pays +150. The scroll speed ramps the longer you live.
- **Stake and bar.** Stake ladder: $1 / $5 / $10 / $50 / $100 / $1,000 (or the − / + stepper). Bar ladder: +50% / +100% / +200% / +400% / +900% / +1900%. Every 100 points is 1x on the stake, so a bar needs 150 / 200 / 300 / 500 / 1000 / 2000 points; hitting the needed score exactly counts as cleared. Win: payout = stake × score ÷ 100. Miss: payout $0, the stake is gone. Your picks persist between sessions; "run it back" always returns to the stake card rather than restarting.
- **Volatility.** The Chill (default) / Classic / Degen presets and the individual speed, pump and gravity sliders set one payout factor that scales **every** point earned. Measured with the game's test pilot: at the slider floor, 10 seconds of clean riding banks ≈120 points; at Classic, 5 seconds banks ≈135; at the ceiling, 5 seconds banks ≈280. The current factor is always on screen as the VOLATILITY · PAYOUT readout.
- **Currency.** The stake card's $ / NEAR toggle denominates the stake and the settlement in NEAR (ladder 1 / 5 / 10 / 50 / 100 / 250, finer stepper). Conversion uses a fixed, on-card reference rate (1 NEAR = $3.63, fetched Nov 7); the game is offline and never fetches a live rate.
- **The PnL card.** Green and gold on a cleared bar, red on a miss; hero score, time in trade, gain as the money gain, the IN → OUT money line, the two-line run chart with the dashed bar line, gold orb markers and an X at the crash, and four tiles (best combo, orbs, NEAR calls, rugs survived). A new best takes the headline; cleared bars draw from a win headline set, misses from a crash set. **Download card** saves the card as a 1080×1080 PNG; **Share on X** shares the card image itself plus the run's story via the system share sheet where file sharing exists, and otherwise downloads the PNG and opens the composer with a hint to attach it.
- **Sound.** A procedural WebAudio soundtrack (an original synthwave loop in A minor — bass, arp, kick and hats, no samples) starts on your first press, plays in the menu and in runs, holds its place while paused, and is silenced together with the SFX by the mute. Sound effects are synthesized the same way.
- **Themes and links.** Dark theme is true black; light theme is warm paper. The choice persists and defaults to your system preference. URL parameters: `?seed=42` pins the terrain seed so a run is reproducible, `?theme=dark|light` forces a theme, `?play=1` hides the start card over the frozen scene.

## How it works

Zero dependencies: vanilla JavaScript, Canvas 2D and WebAudio in a single self-contained HTML file per build. No images, no fonts, no requests — it works offline and straight from `file://`.

- **`engine.js`** is a pure, DOM-free rules module: seeded RNG (mulberry32), deterministic terrain (a seeded random-walk with occasional violent pump/dump jumps), physics, collision, orb/combo scoring, close calls, and the rug-pull state machine (warning → cliff-drop → bounce → survival bonus). Same seed + same inputs = same run, every time.
- **`recap.js`** is a second pure module: it records the run (score sampled every 0.12s, so orb steps and rug jumps stay visible as steps in the line), settles it against the called bar, and builds the PnL card model — verdict, money gain, the two-line common-scale chart data, tiles and share text. One model feeds the on-screen card, the PNG painter and the tests, so the three can never disagree.
- **`app.js`** is rendering, input, audio and theming only. The hold input is level-triggered from the set of active pointers with pointer capture, so a stray OS interruption (the iOS long-press cut-out players reported) heals instead of ending the press.
- **State** lives in `localStorage` only: best score, the last run (its curve decimated to ~240 points for the next card's sub-line), stake, bar, difficulty settings, currency, theme and mute.
- **Two builds, one codebase.** `node build-single.mjs` inlines everything into two bundles that differ only in the NEAR-affiliation layer:
  - `dist/pump-rider.html` — the hackathon build (this repo and GitHub Pages): ON NEAR pill in the header, a "built on NEAR · NEAR Hackathon 2026" line on the start card, the NEAR mark on the PnL card, and a fan-made footer note.
  - `dist/product/pump-rider.html` — the product build (Netlify): the identical game and features, including the $ / NEAR switch and all the NEAR wordplay, with the affiliation inscriptions stripped at build time. Guard tests assert the split in both directions. `BUILD_VARIANT=hackathon|product` builds just one.
- **Tests.** `npm test` runs the Node suite — 18/18 groups passing as the suite reports them — covering determinism, physics, collision, combo, close calls, rug events, difficulty presets, launch grace, the stake ladder and money math, bar settlement (including the exact-bar edge and one point under), the volatility factor's measured rate bands, the currency switch, headline selection, and guards over both build variants. Two Chrome/CDP harnesses drive the real bundle: `node verification/layout-cdp.mjs` asserts layout and card geometry at phone sizes (including a deliberately broken-CSS "hostile WebView" case), and `node verification/touch-cdp.mjs` fires real touch events to assert hold-to-pump, the stake-card tap flow, the one-row HUD and the live best-score glow. Screenshots from these runs live in `verification/`.

There is **no smart contract** in this project and it never claims one. The NEAR connection is thematic (orbs, wordplay, the denominated NEAR stake) plus the NEAR payout account named on the submission — stated plainly so the entry is judged for what it is: a complete, honest, playable game.

## Run it locally

Fastest path — open the built game, no server needed:

```sh
open dist/pump-rider.html        # or just double-click it
```

The product variant is `dist/product/pump-rider.html`, same deal. To run the modular source instead, serve the folder (ES modules need http, not file://):

```sh
npx serve .                      # then open index.html
```

Rebuild the bundles with `npm run build`; run the tests with `npm test`.

## Rules of the build

- Code written inside the hackathon window (announced Oct 19, 2026 → deadline Nov 14, 2026, 23:59 UTC).
- Solo build, size 1.

## Disclosure — same builder, other projects

Per the hackathon's multi-project rule: my other submitted project in this hackathon is **NEAR: On The Evidence** (Thesis track) — a reproducible NEAR investment-thesis dashboard with an HSP-029 issuance simulator.

Also built by the same builder during this hackathon, but **not submitted**: **STREAK** (a memecoin with a daily streak mechanic) and **Moon or Rug** (a memecoin survival management game).
