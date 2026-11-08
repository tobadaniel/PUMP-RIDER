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
- **Every run rides on a stake.** Before you start, a stake card asks how much you are willing to risk: pick $1, $5, $10, $50, $100 or $1,000 from the ladder (or walk it with the − / + stepper). Every 100 points is 1x on your stake, and the PnL card settles it — what went in, what came out. A 1,284-point run on a $50 stake is a 12.84x bag: $642 out. Your stake choice is kept in your browser.

Extras: **P** pauses, **M** mutes, **R** restarts. There is a **dark / light theme toggle** in the header (true-black night market, or warm paper) — it persists, and the game defaults to your system preference. Behind the start screen the game scene sits frozen, parked, until you ride. Beat your best score mid-run and the BEST box in the header lights up gold.

**Every run gets a PnL card.** When you crash, the game-over screen shows the trade as a shareable card in the style of a memecoin PnL post: your score as the hero number (gold, like the HUD score; your best reads NEAR green), time in trade, the signed gain % against your previous run, a money line settling your stake (in, out, and the signed difference), your best combo as the multiple, four milestone tiles (best combo, orbs, NEAR calls, rugs survived) — and a chart of the run itself, the score sampled as it climbed, with a dashed peak line, gold markers where orbs were clipped, and an X where it ended. The verdict — **CLOSED GREEN** if you beat your last run or set a new best, **CLOSED RED** if you didn't — rides on the pill, the gain figure and the chart line's colour. **Download card** saves the same card as a 1080×1080 PNG; **Share on X** posts the run in your own words. All figures come from the run itself; nothing is made up.

Handy URL parameters: `?theme=dark|light` forces a theme, `?seed=42` pins the terrain seed so a run is reproducible and shareable, `?play=1` hides the start card over the frozen menu scene.

## Tech notes

- **Zero dependencies.** Vanilla JS + Canvas 2D + a tiny WebAudio synth for sound effects (created only after your first press, per autoplay rules). No images, no fonts, no requests.
- `engine.js` is a pure, DOM-free rules module: seeded RNG (mulberry32), deterministic terrain generation (seeded random-walk control points with occasional violent pump/dump jumps), physics, collision, orb/combo scoring, close calls, and the rug-pull state machine (warning → cliff-drop → bounce → survival bonus). Same seed + same inputs = same run, every time.
- `app.js` is only rendering, input, sound, particles and theming. Canvas colors come from a per-theme palette object; page colors come from CSS variables under `[data-theme="dark"]` / `[data-theme="light"]`.
- `recap.js` is a second pure module: it consumes the engine's events, samples the score over time for the chart, and builds the run summary, the closed-green/red verdict and the PnL card model (gain vs the previous run, tiles, share text). The event log is capped at 200 entries and the samples decimate past 720, so long runs stay lean.
- `test/engine.test.mjs` covers determinism, physics, collision, combo scoring, close calls, rug events, long-run sanity, difficulty settings, launch grace, and PnL correctness (summary vs run, chart samples ending at the crash, card mapping, verdict grading). Run it with `npm test`.
- `node build-single.mjs` (or `npm run build`) inlines everything into `dist/pump-rider.html`.
- Responsive down to 390px wide; the visible world window narrows on small screens so the rocket stays readable.

There is **no smart contract** in this project and it never claims one — it is a local browser game. The NEAR connection is thematic (orbs, the payout-grade NEAR account on the submission) and honest.

## Rules of the build

- Code written inside the hackathon window (announced Oct 19, 2026 → deadline Nov 14, 2026, 23:59 UTC).
- Solo build, size 1.

## Disclosure — same builder, other projects

Per the hackathon's multi-project rule: my other submitted project in this hackathon is **NEAR, On The Evidence** (Thesis track) — a reproducible NEAR investment-thesis dashboard with an HSP-029 issuance simulator.

Also built by the same builder during this hackathon, but **not submitted**: **STREAK** (a memecoin with a daily streak mechanic) and **Moon or Rug** (a memecoin survival management game).
