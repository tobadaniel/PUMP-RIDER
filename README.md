# Pump Rider

**A one-button arcade game about riding a memecoin chart — and not getting rugged.**

You are a rocket skimming a live, procedurally generated price chart. The chart is the ground. Hold to pump, release to fall, thread the candles, chain the orbs, and when the rug pull warning flashes… hold on.

Built for **NEAR HACKATHON 2026 — Games track**.

## Play it

Open `dist/pump-rider.html` in any browser. That is the whole install: one self-contained file, no server, no build step, no wallet, no network calls. It works on a phone (touch and hold) and on desktop.

To run the modular source instead, serve the folder statically (ES modules need http, not file://):

```sh
npx serve .        # or any static server, then open index.html
```

## How to play

- **Hold** — Space, mouse button, or touch — to thrust upward. **Release** to fall. One button, all momentum.
- **The chart is the ground.** Touch the line and the run ends.
- **NEAR orbs** float above the chart. Collect them back to back to build a **combo multiplier** (x1 → x4). Miss one and the combo resets.
- **Close calls (+15):** pass within a whisker of the chart without touching it.
- **Rug pulls (+150 to survive):** a flashing warning, then the chart cliff-drops — and dead-cat-bounces back *up*, which is the part that kills you. Survive the whole event for the bonus.
- The scroll **speeds up** the longer you live. Score = distance + orbs + bonuses. Best score is kept in your browser.
- **Every run rides on a stake — and a bar you call yourself.** Before you start, a stake card asks how much you are willing to risk: pick $1, $5, $10, $50, $100 or $1,000 from the ladder (or walk it with the − / + stepper). A **$ / NEAR toggle** on the same card switches the unit: in NEAR the ladder becomes 1, 5, 10, 50, 100, 250 NEAR with a finer stepper (0.5 under 10 NEAR, then 5s); switching converts the amount at a fixed reference rate (1 NEAR = $3.63, fetched Nov 7 and labelled on the card — the game is offline and never fetches a live rate), and the whole settlement follows the active unit, the money line appending the PnL's dollar equivalent in NEAR mode. Under it, **call your bar**: the gain you promise yourself, +50%, +100%, +200%, +400%, +900% or +1900% over the stake. Every 100 points is 1x on your stake, so the card spells out the points you need (the +200% bar needs 300). Clear the bar and the bag pays out at your run's multiple — a 1,284-point run on a $50 stake is a 12.84x bag: $642 out. Miss the bar, by a mile or by a single point, and the whole bag is gone, however far you rode. Your stake and bar choices are kept in your browser. **Run it back** never restarts directly: it returns to the stake card with your last picks in place, and the next run starts only when you ape in again. A two-step **reset** button on the game-over card wipes everything the game remembers (best, last run, stake, bar, difficulty, currency) back to factory defaults.
- **Difficulty is volatility.** The Chill / Classic / Degen presets and the speed, pump and gravity sliders don't just change how the rocket flies — they set how fast points accrue. Every point a run earns (distance, orbs, close calls, the rug bonus) is scaled by one payout factor derived from the three sliders, and both difficulty panels and the stake card show it live as a VOLATILITY · PAYOUT xN.NN readout. Calibrated by measurement with the test pilot: at the slider floor, 10 seconds of clean riding banks ≈120 points; at Classic, 5 seconds banks ≈135; at the ceiling, 5 seconds banks ≈280. Low volatility is controllable but may never reach a high bar; high volatility pays fast and crashes fast — the bar turns difficulty into a risk/reward call.

Extras: **P** pauses (or the ⏸ button at the stage's top-right corner, on screen whenever a run is live; it flips to ▶ while paused, like the Resume control on the paused veil), **M** mutes. A procedural WebAudio soundtrack — a synthwave loop in A minor, bass, arp, kick and hats, no samples — starts on your first press, plays under the SFX in the menu and in runs, holds its place while the game is paused, and the mute silences it together with the SFX. There is a **dark / light theme toggle** in the header (true-black night market, or warm paper) — it persists, and the game defaults to your system preference. Behind the start screen the game scene sits frozen, parked, until you ride. Beat your best score mid-run and the BEST box in the header lights up gold.

**Every run gets a PnL card.** When you crash, the game-over screen shows the trade as a shareable card in the style of a memecoin PnL post: your score as the hero number, time in trade, the gain % **against your stake**, a money line settling the bag (in, out, and the signed difference), your best combo as the multiple, four milestone tiles (best combo, orbs, NEAR calls, rugs survived) — and a chart of the run itself. The card's identity is the bar settlement, the money truth: clear the bar and the card glows **green** with a gold hero and a **BAR CLEARED** pill; miss it and the card glows **red**, hero included, with a **MISSED THE BAR** pill and a −100% gain — even if you outscored your previous run, because a missed bar means the bag is gone. That comparison isn't deleted, just demoted to a quiet note under the money line. The chart draws **two runs on one common scale** — your run as the thick line in the card's colour, your previous run as a thin muted line underneath — plus a dashed line at the bar you called, so a miss visibly dies below it; gold markers sit where orbs were clipped, and an X marks where it ended. **Download card** saves the same card as a 1080×1080 PNG; **Share on X** shares the card image itself alongside the run's story in your own words — through the system share sheet where file sharing exists, and where it doesn't, it downloads the PNG and opens the composer with a hint to attach it. All figures come from the run itself; nothing is made up.

Handy URL parameters: `?theme=dark|light` forces a theme, `?seed=42` pins the terrain seed so a run is reproducible and shareable, `?play=1` hides the start card over the frozen menu scene.

## Tech notes

- **Zero dependencies.** Vanilla JS + Canvas 2D + a tiny WebAudio synth for sound effects (created only after your first press, per autoplay rules). No images, no fonts, no requests.
- `engine.js` is a pure, DOM-free rules module: seeded RNG (mulberry32), deterministic terrain generation (seeded random-walk control points with occasional violent pump/dump jumps), physics, collision, orb/combo scoring, close calls, and the rug-pull state machine (warning → cliff-drop → bounce → survival bonus). Same seed + same inputs = same run, every time.
- `app.js` is only rendering, input, sound, particles and theming. Canvas colors come from a per-theme palette object; page colors come from CSS variables under `[data-theme="dark"]` / `[data-theme="light"]`.
- `recap.js` is a second pure module: it consumes the engine's events, samples the score over time for the chart, and builds the run summary, the bar settlement (clear the called bar and the bag pays at the run's multiple; miss it and the bag is gone) and the PnL card model (bar verdict, money gain, the demoted vs-last-run note, tiles, share text). The event log is capped at 200 entries and the samples (one every 0.12s, so orb steps and rug jumps stay visible as steps in the line) decimate past 1,440, so long runs stay lean; the stored last run keeps its curve decimated to ~240 points so the next card can draw it as the sub-line.
- `test/engine.test.mjs` covers determinism, physics, collision, combo scoring, close calls, rug events, long-run sanity, difficulty settings, launch grace, PnL correctness (summary vs run, chart samples ending at the crash, card mapping), the stake ladder and money math, the bar (ladder ↔ needed points, settlement at the exact bar and one point under, decimation, the two-line common-scale chart), the volatility payout factor with its measured rate bands, the currency switch (NEAR ladder, stepper steps, rate conversions both ways, the unit-true card and share text), and guards over both build variants. Run it with `npm test`.
- `node build-single.mjs` (or `npm run build`) inlines everything into two single-file bundles that differ only in the NEAR-affiliation layer: `dist/pump-rider.html` carries it (the repo + GitHub Pages build); `dist/product/pump-rider.html` is the identical game without the affiliation inscriptions, for the product site. `BUILD_VARIANT=hackathon|product` builds just one.
- Responsive down to 390px wide; the visible world window narrows on small screens so the rocket stays readable.

There is **no smart contract** in this project and it never claims one — it is a local browser game. The NEAR connection is thematic (orbs, the payout-grade NEAR account on the submission) and honest.

## Rules of the build

- Code written inside the hackathon window (announced Oct 19, 2026 → deadline Nov 14, 2026, 23:59 UTC).
- Solo build, size 1.

## Disclosure — same builder, other projects

Per the hackathon's multi-project rule: my other submitted project in this hackathon is **NEAR, On The Evidence** (Thesis track) — a reproducible NEAR investment-thesis dashboard with an HSP-029 issuance simulator.

Also built by the same builder during this hackathon, but **not submitted**: **STREAK** (a memecoin with a daily streak mechanic) and **Moon or Rug** (a memecoin survival management game).
