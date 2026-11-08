// Behaviour tests for the Pump Rider engine.
// Run: node test/engine.test.mjs   (or: npm test)
// Seeded and reproducible — no timers, no DOM, no randomness of our own.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  createGame, step, terrainHeightAt, terrainBaseHeightAt, PRESETS,
  WORLD_H, CEILING, PLAYER_R, BASE_SPEED, MAX_SPEED, payoutFactorFor,
} from '../engine.js';
import {
  createRunRecorder, formatClock, MAX_LOG_EVENTS,
  buildCardData, chartModel, gainPctFor, FOOTER_PUNS, SAMPLE_EVERY,
  STAKE_LADDER, DEFAULT_STAKE, sanitizeStake, stakeIndexOf, stepStakeIndex,
  moneyFor, fmtMoney, fmtSignedMoney,
  TARGET_LADDER, DEFAULT_TARGET, sanitizeTarget, targetIndexOf, stepTargetIndex,
  targetMultiple, targetPoints, settleRun, decimateSamples, PREV_SAMPLES_MAX,
  NEAR_RATE, NEAR_LADDER, DEFAULT_NEAR_STAKE, sanitizeCurrency, sanitizeNearStake,
  usdToNear, nearToUsd, stepNearStake, fmtNear, fmtAmount, fmtSignedAmount, fmtUnitLower,
  pickOverHeadline, WIN_LINES, OVER_LINES, NEW_BEST_LINE,
} from '../recap.js';

const DT = 1 / 60;
let passed = 0;
function ok(name) { passed += 1; console.log('ok -', name); }

// An autopilot good enough to survive ordinary terrain: aim above the
// highest chart point in the lookahead window, with a predictive term
// (where the rocket WILL be shortly) so falls get arrested early. Uses
// the real terrain query (cliffs included), like a player reading ahead.
function autopilotThrust(s) {
  const ahead = Math.max(
    terrainHeightAt(s, s.x),
    terrainHeightAt(s, s.x + 70),
    terrainHeightAt(s, s.x + 140),
  );
  return s.y + s.vy * 0.32 < ahead + 108;
}
function runWith(s, seconds, thrustFn, onEvent) {
  const all = [];
  const steps = Math.round(seconds / DT);
  for (let i = 0; i < steps; i++) {
    const evs = step(s, DT, thrustFn(s, i));
    for (const e of evs) { all.push(e); if (onEvent) onEvent(e); }
    if (s.crashed) break;
  }
  return all;
}

// 1. Determinism: same seed + same inputs = same terrain and same run.
{
  const a = createGame(42);
  const b = createGame(42);
  for (const x of [0, 137, 900, 2600, 5200, 12000]) {
    assert.equal(terrainHeightAt(a, x), terrainHeightAt(b, x), `terrain at ${x}`);
  }
  const pattern = (s, i) => (i % 50) < 22;
  runWith(a, 9, pattern);
  runWith(b, 9, pattern);
  assert.equal(a.x, b.x);
  assert.equal(a.y, b.y);
  assert.equal(a.score, b.score);
  assert.equal(a.pts.length, b.pts.length);
  assert.deepEqual(a.pts, b.pts);
  // A different seed is a different chart.
  const c = createGame(1337);
  let differs = false;
  for (const x of [500, 1500, 3000, 6000]) {
    if (terrainHeightAt(c, x) !== terrainHeightAt(a, x)) differs = true;
  }
  assert.ok(differs, 'seed 1337 chart should differ from seed 42');
  ok('determinism: same seed reproduces terrain and run; other seed differs');
}

// 2. Physics sanity: holding rises, releasing falls.
{
  const up = createGame(7);
  const y0 = up.y;
  runWith(up, 0.3, () => true);
  assert.ok(up.y > y0 + 15, `hold should climb (y ${y0} -> ${up.y})`);
  assert.ok(!up.crashed, 'climbing from spawn should not crash');

  const down = createGame(7);
  const y1 = down.y;
  // Measured past the 1s launch grace (test 12): gravity eases in from
  // zero at spawn, so an idle rocket barely sinks in the first moments,
  // then falls for real (and, untouched, into the chart).
  runWith(down, 1.5, () => false);
  assert.ok(down.y < y1 - 15, `release should fall (y ${y1} -> ${down.y})`);
  ok('physics: hold climbs, release falls');
}

// 3. Collision: never touching the button ends in a crash, quickly.
{
  const s = createGame(99);
  const events = runWith(s, 5, () => false);
  assert.ok(s.crashed, 'idle rocket must hit the chart');
  assert.ok(events.some((e) => e.type === 'crash'), 'crash event emitted');
  const ground = terrainHeightAt(s, s.x);
  assert.ok(Math.abs(s.y - (ground + PLAYER_R)) < 0.001, 'rocket rests on the chart');
  ok('collision: falling into the chart crashes and emits the event');
}

// 4. Combo scoring: consecutive orbs multiply; a missed orb resets.
{
  const s = createGame(5, { rugs: false });
  const collectOrb = (orb) => {
    s.x = orb.x; s.y = orb.y; s.vy = 0;
    return step(s, DT, false).filter((e) => e.type === 'orb');
  };
  const orb1 = s.orbs.find((o) => !o.collected);
  const e1 = collectOrb(orb1);
  assert.equal(e1.length, 1);
  assert.equal(s.combo, 1);
  assert.equal(e1[0].points, 20, 'first orb pays base 20 at x1');

  const orb2 = s.orbs.find((o) => !o.collected && !o.missed && o.x > s.x);
  const e2 = collectOrb(orb2);
  assert.equal(e2.length, 1);
  assert.equal(s.combo, 2);
  assert.ok(e2[0].points > e1[0].points, 'second consecutive orb pays more');
  assert.equal(e2[0].multiplier, 1.5);

  // Skip the next orb entirely: fly far past it and the combo dies.
  const orb3 = s.orbs.find((o) => !o.collected && !o.missed && o.x > s.x);
  s.x = orb3.x + 120; s.y = orb3.y + 260; s.vy = 0;
  const evs = step(s, DT, true);
  assert.ok(orb3.missed, 'orb left behind is marked missed');
  assert.equal(s.combo, 0, 'missed orb resets the combo');
  assert.equal(s.multiplier, 1);
  assert.ok(evs.some((e) => e.type === 'comboLost'), 'comboLost event emitted');
  ok('combo: consecutive orbs raise the multiplier, a miss resets it');
}

// 5. Close calls: skimming the chart pays a bonus, with a cooldown.
{
  const s = createGame(11, { rugs: false });
  let closeEvents = 0;
  for (let i = 0; i < 60 * 6 && !s.crashed; i++) {
    // Ride a hair above the highest chart point just ahead, predictively,
    // so we hug the line without touching it.
    const ahead = Math.max(
      terrainHeightAt(s, s.x),
      terrainHeightAt(s, s.x + 70),
      terrainHeightAt(s, s.x + 140),
    );
    const evs = step(s, DT, s.y + s.vy * 0.32 < ahead + PLAYER_R + 12);
    closeEvents += evs.filter((e) => e.type === 'closecall').length;
  }
  assert.ok(!s.crashed, 'skim autopilot should survive 6s');
  assert.ok(closeEvents >= 2, `expected repeated close calls, got ${closeEvents}`);
  assert.ok(s.bonusScore >= closeEvents * 15, 'close calls paid into bonus score');
  ok('close calls: skimming the chart pays out repeatedly');
}

// 6. Rug pulls happen, drop a real cliff, and pay the survival bonus.
{
  const withRugs = createGame(2026);
  const seen = [];
  runWith(withRugs, 70, autopilotThrust, (e) => seen.push(e.type));
  assert.ok(seen.includes('rugwarning'), 'a rug warning fired');
  assert.ok(seen.includes('rugdrop'), 'a rug drop fired');
  assert.ok(withRugs.cliffs.length >= 1, 'a cliff was carved into the chart');
  // The cliff is real: at the crater, the live chart sits far below the
  // same game's own cliff-free base terrain.
  const cliff = withRugs.cliffs[0];
  let maxDip = 0;
  for (let dx = 40; dx < 500; dx += 20) {
    const dip = terrainBaseHeightAt(withRugs, cliff.x + dx) - terrainHeightAt(withRugs, cliff.x + dx);
    if (dip > maxDip) maxDip = dip;
  }
  assert.ok(maxDip > 55, `cliff should crater the chart (max dip ${maxDip.toFixed(1)})`);
  if (!withRugs.crashed) {
    assert.ok(seen.includes('rugsurvived'), 'surviving the rug fired its event');
  }
  ok('rug pulls: warning, cliff-drop carves the chart, survival pays');
}

// 7. Long-run sanity: speed ramps, distance accrues, nothing goes NaN.
{
  const s = createGame(31415);
  runWith(s, 45, autopilotThrust);
  assert.ok(Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.score));
  assert.ok(s.speed > BASE_SPEED, 'speed ramps up over time');
  assert.ok(s.speed <= MAX_SPEED, 'speed is capped');
  assert.ok(s.y <= CEILING, 'rocket respects the ceiling');
  assert.ok(s.score > 0, 'score accrues');
  assert.ok(s.y >= 0 && s.y <= WORLD_H, 'rocket stays in the world');
  ok('long run: speed ramps and caps, state stays sane for 45s');
}

// 8. Settings: higher gravity falls faster, higher thrust climbs faster.
{
  const fallHard = createGame(21, { settings: { gravity: 2 } });
  const fallSoft = createGame(21, { settings: { gravity: 0.5 } });
  // Pin both clocks past the 1s launch grace (test 12): this group is
  // about steady-state gravity, not the spawn window where gravity
  // deliberately eases in from zero for every run.
  fallHard.time = 2;
  fallSoft.time = 2;
  const fy0 = fallHard.y;
  runWith(fallHard, 0.25, () => false);
  runWith(fallSoft, 0.25, () => false);
  assert.ok(!fallHard.crashed && !fallSoft.crashed, 'both still airborne at 0.25s');
  assert.ok(
    fy0 - fallHard.y > (fy0 - fallSoft.y) * 1.5,
    `gravity 2 should fall much faster (${(fy0 - fallHard.y).toFixed(1)} vs ${(fy0 - fallSoft.y).toFixed(1)})`,
  );

  const climbHard = createGame(21, { settings: { thrust: 1.8 } });
  const climbBase = createGame(21, { settings: { thrust: 1 } });
  const cy0 = climbHard.y;
  runWith(climbHard, 0.25, () => true);
  runWith(climbBase, 0.25, () => true);
  assert.ok(
    climbHard.y - cy0 > (climbBase.y - cy0) * 1.4,
    `thrust 1.8 should climb much faster (${(climbHard.y - cy0).toFixed(1)} vs ${(climbBase.y - cy0).toFixed(1)})`,
  );
  ok('settings: gravity and thrust multipliers bend physics as labelled');
}

// 9. Settings: higher speedScale scrolls farther in the same time.
{
  const fast = createGame(33, { settings: { speedScale: 1.5 } });
  const slow = createGame(33, { settings: { speedScale: 0.5 } });
  runWith(fast, 3, autopilotThrust);
  runWith(slow, 3, autopilotThrust);
  assert.ok(!fast.crashed && !slow.crashed, 'autopilot survives 3s at both speeds');
  assert.ok(
    fast.x > slow.x * 2,
    `speedScale 1.5 should out-scroll 0.5 by >2x (${fast.x.toFixed(0)} vs ${slow.x.toFixed(0)})`,
  );
  ok('settings: speedScale scales distance covered');
}

// 10. Presets: Chill is gentler than Classic is gentler than Degen, and
// Classic reproduces the shipped physics exactly.
{
  const { chill, classic, degen } = PRESETS;
  for (const key of ['speedScale', 'gravity', 'thrust']) {
    assert.ok(chill[key] < classic[key], `chill.${key} < classic.${key}`);
    assert.ok(classic[key] < degen[key], `classic.${key} < degen.${key}`);
  }
  assert.deepEqual(classic, { speedScale: 1, gravity: 1, thrust: 1 });
  const a = createGame(77, { settings: PRESETS.classic });
  const b = createGame(77);
  runWith(a, 5, autopilotThrust);
  runWith(b, 5, autopilotThrust);
  assert.equal(a.x, b.x);
  assert.equal(a.y, b.y);
  assert.equal(a.score, b.score);
  // Determinism still holds under custom settings.
  const c1 = createGame(88, { settings: PRESETS.chill });
  const c2 = createGame(88, { settings: PRESETS.chill });
  runWith(c1, 5, autopilotThrust);
  runWith(c2, 5, autopilotThrust);
  assert.equal(c1.x, c2.x);
  assert.equal(c1.score, c2.score);
  ok('presets: chill < classic < degen; classic = shipped physics; seeded settings deterministic');
}

// 11. The built single-file bundle carries both themes and the stake flow.
// (Run `npm run build` first; the bundle is what judges actually open.)
{
  const dist = readFileSync(new URL('../dist/pump-rider.html', import.meta.url), 'utf8');
  assert.ok(dist.includes('[data-theme="dark"]'), 'dist has the dark theme block');
  assert.ok(dist.includes('[data-theme="light"]'), 'dist has the light theme block');
  assert.ok(dist.includes('#000000'), 'dist dark theme is true black');
  assert.ok(dist.includes('APE IN'), 'dist has the APE IN button');
  // Stake card round: the pre-game stake card replaced the old APE IN
  // confirm card outright — its copy must be gone, the stake copy in.
  assert.ok(dist.includes('overlay-stake'), 'dist has the stake card');
  assert.ok(dist.includes('how much are you willing to risk, ser?'), 'dist has the stake headline');
  assert.ok(dist.includes('every 100 pts is 1x on your bag'), 'dist has the stake rule line');
  assert.ok(dist.includes('pump-rider-stake'), 'dist persists the chosen stake');
  assert.ok(dist.includes('pnl-money'), 'dist has the PnL money strip');
  // Build guard for the $$ collapse: fmtMoney's template opens with a
  // literal dollar followed by an interpolation ("`$${grouped}`"). If
  // the bundle is ever assembled through a String.replace replacement
  // STRING again, the $$ collapses and every printed $ vanishes while
  // the modular tests still pass — this catches it in the artifact.
  assert.ok(
    dist.includes('$${grouped}'),
    'dist keeps fmtMoney\u2019s literal-dollar template intact (no $$ collapse in the build)',
  );
  assert.ok(!dist.includes('overlay-confirm'), 'dist has no confirm card: the stake card replaced it');
  assert.ok(!dist.includes('NEARly ready'), 'dist has no confirm-card copy');
  assert.ok(dist.includes('that was NEAR! +15'), 'dist has the close-call pun');
  assert.ok(dist.includes('pump-rider-settings'), 'dist persists difficulty settings');
  // Regression guards for the mobile fix round:
  assert.ok(!dist.includes('awaitRelease'), 'dist has no click-armed release latch (it ate the first hold of every touch run)');
  assert.ok(dist.includes('ignoredPointers'), 'dist snapshots physically-held inputs at run start');
  assert.ok(dist.includes('__pumpRider'), 'dist exposes the headless test handle');
  // Compatibility round: the bundle is a CLASSIC script — phone file
  // viewers that silently skip module scripts still run the game — and
  // the audio state is observable so the unlock can be verified headlessly.
  assert.ok(
    !dist.includes('<script type="module">'),
    'dist has no module script: the bundle must boot in viewers that skip module scripts',
  );
  assert.ok(dist.includes('audioState'), 'dist exposes the audio state on the test handle');
  // Stage-collapse round: the stage height is measured in JS (the dvh /
  // flex chain alone collapsed to zero in a phone file viewer), and the
  // start card is slim — the full instructions live in the how-to strip.
  assert.ok(dist.includes('sizeStage'), 'dist measures the stage height in JS');
  assert.ok(dist.includes('STAGE_FLOOR_PX = 320'), 'dist keeps the 320px stage floor');
  assert.ok(
    dist.includes('hold to pump. let go to fall. do not kiss the line.'),
    'dist start card carries the one-line brief',
  );
  assert.ok(
    !dist.includes('The glowing chart is the ground'),
    'dist start card repeats no instruction paragraphs',
  );
  assert.ok(dist.includes('stat-best-box'), 'dist has the light-up BEST box');
  assert.ok(!dist.includes('autopilot'), 'dist has no autopilot: the menu scene is frozen');
  // PnL card round:
  assert.ok(dist.includes('pnl-card'), 'dist has the PnL card');
  assert.ok(dist.includes('pnl-chart'), 'dist has the run chart on the card');
  assert.ok(!dist.includes('recap-chat'), 'dist has no trade-chat feed: the recap is a chart now');
  assert.ok(dist.includes('btn-download'), 'dist has the card download button');
  assert.ok(dist.includes('btn-share'), 'dist has the share-on-X button');
  assert.ok(dist.includes('pump-rider-last-run'), 'dist persists the last run for the verdict');
  // Bar round: the card's verdict is the bar settlement now, and the
  // stake card carries the target picker under its own heading.
  assert.ok(dist.includes('BAR CLEARED'), 'dist has the bar-cleared verdict copy');
  assert.ok(dist.includes('MISSED THE BAR'), 'dist has the missed-bar verdict copy');
  assert.ok(!dist.includes('CLOSED GREEN'), 'dist has no vs-last-run verdict copy: the bar owns the card');
  assert.ok(dist.includes('call your bar'), 'dist has the target picker heading');
  assert.ok(dist.includes('target-chip'), 'dist has the target chips');
  assert.ok(dist.includes('pump-rider-target'), 'dist persists the chosen bar');
  assert.ok(dist.includes('you need'), 'dist shows the points the bar needs');
  // Run-it-back + reset round: game over never starts a run directly,
  // and the wipe is a two-step button beside it.
  assert.ok(dist.includes('btn-reset'), 'dist has the reset button');
  assert.ok(dist.includes('sure? tap again to wipe'), 'dist has the two-step reset copy');
  assert.ok(dist.includes('backToStake'), 'dist returns to the stake card instead of restarting');
  assert.ok(dist.includes('btn-over-settings'), 'dist has the collapsible game-over difficulty');
  assert.ok(dist.includes('btn-start-settings'), 'dist has the collapsible start-card difficulty');
  assert.ok(dist.includes('start-settings-body'), 'dist start difficulty starts collapsed');
  // Score/best colour distinction + the shrunk death headline:
  assert.ok(dist.includes('#ffc837'), 'dist colours the score gold');
  assert.ok(dist.includes('#00ec97'), 'dist colours the best NEAR green');
  assert.ok(dist.includes('not NEAR enough.'), 'dist has the short death headline');
  assert.ok(
    !dist.includes('the pump was NEAR. not NEAR enough.'),
    'dist has no long two-sentence death headline',
  );
  // Volatility round: the derived payout readout rides the difficulty
  // panels and the stake card, live from the sliders.
  assert.ok(dist.includes('VOLATILITY'), 'dist shows the volatility readout');
  assert.ok(dist.includes('PAYOUT x'), 'dist shows the payout factor in the readout');
  assert.ok(dist.includes('payoutFactorFor'), 'dist derives the payout factor in the engine layer');
  // Image share round: the share carries the card PNG itself — the
  // Web Share file path where it exists, a download + intent + hint
  // where it does not; a cancelled share stays silent.
  assert.ok(dist.includes('canShare'), 'dist prefers the Web Share file path');
  assert.ok(dist.includes('AbortError'), 'dist treats a cancelled share as silent');
  assert.ok(dist.includes('pump-rider-pnl.png'), 'dist names the shared card file');
  assert.ok(dist.includes('card saved. attach it to your post.'), 'dist has the fallback attach hint');
  // NEAR attribution round (this bundle is the hackathon stamp): the
  // affiliation layer is present and visible — pill, built-on line,
  // title accent, card mark, honest fan note.
  assert.ok(dist.includes('ON NEAR'), 'dist has the ON NEAR pill');
  assert.ok(dist.includes('built on NEAR · NEAR Hackathon 2026'), 'dist has the built-on affiliation line');
  assert.ok(dist.includes('fan made game built for the near hackathon 2026'), 'dist has the honest fan note');
  assert.ok(dist.includes('<svg class="near-glyph"'), 'dist draws the NEAR glyph inline');
  assert.ok(dist.includes('class="near-accent"'), 'dist has the NEAR-green title accent');
  assert.ok(dist.includes("const VARIANT = 'hackathon';"), 'dist is stamped as the hackathon variant');
  // Currency round: the $ / NEAR switch and its honest rate line.
  assert.ok(dist.includes('pump-rider-currency'), 'dist persists the chosen currency');
  assert.ok(dist.includes('reference rate, nov 7'), 'dist labels the fixed reference rate honestly');
  assert.ok(dist.includes('id="cur-near"'), 'dist has the NEAR side of the currency toggle');
  // Product variant: the identical game WITHOUT the affiliation
  // layer — no inscriptions, no glyph elements, no accent — while
  // the game's own NEAR flavour and every feature stay.
  const product = readFileSync(new URL('../dist/product/pump-rider.html', import.meta.url), 'utf8');
  assert.ok(product.includes("const VARIANT = 'product';"), 'product bundle is stamped product');
  assert.ok(!product.includes('ON NEAR'), 'product has no ON NEAR pill');
  assert.ok(!product.includes('built on NEAR'), 'product has no built-on inscription');
  assert.ok(!product.includes('Hackathon'), 'product names no hackathon (capitalised)');
  assert.ok(!product.includes('hackathon'), 'product names no hackathon (lowercase)');
  assert.ok(!product.includes('fan made game'), 'product has no fan note');
  assert.ok(!product.includes('<svg class="near-glyph"'), 'product draws no affiliation glyph');
  assert.ok(!product.includes('class="near-pill"'), 'product has no affiliation pill element');
  assert.ok(!product.includes('class="near-accent"'), 'product has no affiliation title accent');
  // iOS hardening round: the hold cannot be pulsed by the browser —
  // pointer capture, the callout kill, gesture suppression, the
  // stage-scoped touch guard — and the help strip owns its pan.
  assert.ok(dist.includes('setPointerCapture'), 'dist captures the hold pointer to the stage');
  assert.ok(dist.includes('gesturestart'), 'dist suppresses iOS gesture events on the stage');
  assert.ok(dist.includes('-webkit-touch-callout'), 'dist kills the iOS long-press callout on the game surface');
  assert.ok(dist.includes('touch-action: pan-y'), 'dist gives the help strip its own vertical pan');
  assert.ok(dist.includes('suspectPointers'), 'dist pardons a pointercancel instead of chopping the hold');
  // Soundtrack + icon controls + visible pause round:
  assert.ok(dist.includes('MUSIC_BPM'), 'dist carries the procedural soundtrack');
  assert.ok(dist.includes('startMusic'), 'dist starts the music on the audio unlock');
  assert.ok(dist.includes('visibilitychange'), 'dist auto-pauses a live run when the tab hides');
  assert.ok(dist.includes('btn-pause-stage'), 'dist has the in-stage pause button');
  assert.ok(dist.includes('btn-resume'), 'dist has the paused veil\u2019s resume control');
  assert.ok(dist.includes('☀️') && dist.includes('🌙'), 'dist theme toggle is the sun/moon icon pair');
  assert.ok(dist.includes('🔊') && dist.includes('🔇'), 'dist sound toggle is the speaker icon pair');
  assert.ok(product.includes('setPointerCapture'), 'product ships the same input hardening');
  assert.ok(product.includes('that was NEAR! +15'), 'product keeps the game\u2019s own NEAR flavour: the close-call pun');
  assert.ok(product.includes('pump-rider-currency'), 'product keeps the currency switch: a feature, not affiliation');
  assert.ok(product.includes('BAR CLEARED'), 'product keeps the bar settlement');
  ok('dist bundle: both themes, true black, stake flow, pun copy present');
}

// 12. Launch grace: at Chill (the default), an untouched rocket must
// still be airborne 0.9s in — long enough for a first-time player to
// get a finger down — but the grace is a launch window, not autopilot:
// left alone it must be dead well inside 3s.
{
  const s = createGame(4242, { settings: PRESETS.chill });
  const y0 = s.y;
  runWith(s, 0.9, () => false);
  assert.ok(!s.crashed, 'untouched Chill run must survive the grace window (0.9s)');
  assert.ok(
    y0 - s.y < 60,
    `grace should be a near-hover, not a dive (sank ${(y0 - s.y).toFixed(1)} of the 135-unit gap in 0.9s)`,
  );
  runWith(s, 2.1, () => false); // 3.0s total
  assert.ok(s.crashed, 'untouched Chill run must crash once the grace expires (3s)');
  // Determinism under grace: same seed + settings + inputs, same run.
  const g1 = createGame(4242, { settings: PRESETS.chill });
  const g2 = createGame(4242, { settings: PRESETS.chill });
  runWith(g1, 2.5, (st, i) => (i % 40) < 15);
  runWith(g2, 2.5, (st, i) => (i % 40) < 15);
  assert.equal(g1.y, g2.y);
  assert.equal(g1.score, g2.score);
  ok('launch grace: 0.9s of hover to react, dead by 3s untouched, still deterministic');
}

// 13. PnL card data: a simulated run's summary must match its stats —
// orb entries are the orbs collected, combo peak is the combo reached,
// the exit line is last, timestamps never go backwards — the chart
// samples must trace the run and end exactly at the crash, and the
// card model (bar settlement, tiles, the demoted vs-last-run note,
// share text) must be derived honestly, first run included.
{
  const s = createGame(2026);
  const rec = createRunRecorder();
  rec.begin('Classic');
  let maxComboSeen = 0;
  let closeSeen = 0;
  let rugSurvSeen = 0;
  const evs = [];
  const stepOnce = (thrust) => {
    for (const e of step(s, DT, thrust)) {
      evs.push(e);
      rec.observe(e, s);
      if (e.type === 'orb') maxComboSeen = Math.max(maxComboSeen, e.combo);
      if (e.type === 'closecall') closeSeen += 1;
      if (e.type === 'rugsurvived') rugSurvSeen += 1;
    }
    rec.tick(s); // the app ticks the recorder every frame, like this
  };
  // Fly piloted for a long stretch, then hands off the button: the run
  // ends the way every run ends, by kissing the line.
  let guard = 0;
  while (!s.crashed && guard++ < 60 * 48) {
    stepOnce(s.time < 40 ? autopilotThrust(s) : false);
  }
  assert.ok(s.crashed, 'hands off the button, the run must end in a crash');
  assert.ok(s.orbsCollected >= 2, `pilot should collect orbs (got ${s.orbsCollected})`);
  const summary = rec.finish(s);
  const log = summary.events;

  assert.equal(summary.preset, 'Classic', 'summary carries the preset the card header shows');
  assert.equal(log[0].kind, 'start', 'log opens with the ape-in');
  assert.equal(log[log.length - 1].kind, 'crash', 'log closes with the crash');
  assert.equal(
    log.filter((e) => e.kind === 'orb').length, s.orbsCollected,
    'one log entry per orb collected',
  );
  assert.equal(summary.orbs, s.orbsCollected, 'summary orbs = engine orbs');
  assert.equal(summary.closeCalls, closeSeen, 'summary close calls = engine close calls');
  assert.equal(summary.rugsSurvived, rugSurvSeen, 'summary rugs survived = engine rugs survived');
  assert.equal(summary.score, s.score, 'summary score = engine score');
  assert.equal(summary.peakScore, s.score, 'score only climbs, so the high is the close');
  assert.equal(summary.bestCombo, maxComboSeen, 'summary best combo = best combo flown');
  assert.ok(Math.abs(summary.duration - s.time) < 1e-9, 'duration is the engine clock');
  for (let i = 1; i < log.length; i++) {
    assert.ok(log[i].t >= log[i - 1].t, `timestamps non-decreasing at entry ${i}`);
  }
  // The run really contained the moments the log claims: if the log
  // mentions a rug or a close call, the engine emitted it too.
  for (const kind of ['closecall', 'rugwarning', 'rugsurvived']) {
    if (log.some((e) => e.kind === kind)) {
      assert.ok(evs.some((e) => e.type === kind), `logged ${kind} really happened`);
    }
  }

  // Chart samples: laid down about every SAMPLE_EVERY seconds of play,
  // starting at the origin, and the last one sits exactly on the crash.
  const samples = summary.samples;
  assert.deepEqual(samples[0], { t: 0, score: 0 }, 'samples open at the origin');
  assert.ok(samples.length >= 40, `a ~40s run samples densely (got ${samples.length})`);
  for (let i = 1; i < samples.length; i++) {
    assert.ok(samples[i].t >= samples[i - 1].t, `sample times non-decreasing at ${i}`);
    assert.ok(samples[i].score >= samples[i - 1].score, 'sampled score never falls');
    assert.ok(
      samples[i].t - samples[i - 1].t <= SAMPLE_EVERY + DT + 1e-9 || i === samples.length - 1,
      `sample gap near the sampling interval at ${i} (got ${(samples[i].t - samples[i - 1].t).toFixed(3)}s)`,
    );
  }
  const lastSample = samples[samples.length - 1];
  assert.equal(lastSample.t, s.time, 'last sample is at the crash time');
  assert.equal(lastSample.score, s.score, 'last sample is the final score');
  assert.equal(
    Math.max(...samples.map((p) => p.score)), summary.peakScore,
    'chart data peak = the run high',
  );

  // Chart model: unit-square points on the COMMON scale — the frame
  // holds the greater of the run's peak and the bar it called (this
  // run began with the default +200% bar: 300 pts) — one gold marker
  // per orb the run actually clipped. No previous run: no sub-line.
  const model = chartModel(summary);
  assert.equal(model.line.length, samples.length, 'chart line = the samples');
  assert.equal(model.hasPrev, false, 'no previous run, no sub-line');
  assert.deepEqual(model.prevLine, [], 'sub-line empty on a first run');
  const scalePeak = Math.max(summary.peakScore, 300);
  assert.ok(
    Math.abs(model.crash.y - summary.peakScore / scalePeak) < 1e-9,
    'crash height sits on the common scale, not stretched to the top',
  );
  assert.equal(model.crash.x, 1, 'the run is the longest thing in its own frame');
  assert.ok(Math.abs(model.targetY - 300 / scalePeak) < 1e-9, 'bar line at needed / scale peak');
  assert.equal(model.needed, 300, 'the default bar needs 300 pts');
  assert.equal(model.orbs.length, s.orbsCollected, 'one chart marker per orb collected');
  assert.equal(model.rugs.length, rugSurvSeen, 'one chart marker per rug survived');
  assert.equal(model.peakScore, summary.peakScore, 'chart model carries the high');

  // The log is capped: a flood of events keeps only the newest window.
  const flood = createRunRecorder();
  flood.begin('Chill');
  const fakeState = { time: 0, score: 0 };
  for (let i = 0; i < MAX_LOG_EVENTS + 60; i++) {
    fakeState.time = i * 0.1;
    fakeState.score = i;
    flood.observe({ type: 'orb', points: 20, combo: 1, multiplier: 1 }, fakeState);
  }
  assert.equal(flood.events.length, MAX_LOG_EVENTS, 'log capped at MAX_LOG_EVENTS');
  assert.ok(
    Math.abs(flood.events[flood.events.length - 1].t - fakeState.time) < 1e-9,
    'the newest events survive the cap',
  );

  assert.equal(formatClock(83.25), '1:23.3', 'trade clock formats m:ss.d');

  // Card mapping: every figure on the card comes from the summary,
  // and the card's identity is the BAR settlement — the money truth —
  // never the comparison to the previous run (that survives only as
  // the quiet note). A summary with no stake or bar recorded settles
  // at the defaults: $10 in, +200% called (300 pts to clear).
  const sum150 = {
    preset: 'Classic', score: 150, peakScore: 150, orbs: 3, closeCalls: 2,
    rugsSurvived: 1, bestCombo: 2, bestMultiplier: 1.5, duration: 12.34,
    events: [], samples: [],
  };
  // 150 pts BEAT the previous run's 100 — and the card is still a
  // loss, because 150 never cleared the 300-pt bar. This is the exact
  // case the user caught: a run must not dress up green for beating
  // the last run while the bag is gone.
  const missed = buildCardData(sum150, { score: 100 }, false);
  assert.equal(missed.preset, 'CLASSIC', 'card header shows the preset');
  assert.equal(missed.heroText, '+150', 'hero is the final score');
  assert.equal(missed.win, false, 'beating the last run does not clear the bar');
  assert.equal(missed.outcome, 'loss');
  assert.equal(missed.tone, 'red', 'a missed bar tones the card red');
  assert.equal(missed.verdictLabel, 'MISSED THE BAR · 1.5x of 3x', 'pill states the bar miss');
  assert.equal(missed.gainPct, -100, 'a missed bar loses the whole bag');
  assert.equal(missed.gainText, '−100%', 'loss gain is the full minus, real minus sign');
  assert.equal(missed.timeText, '12.3s', 'time in trade is the run duration');
  assert.equal(missed.multText, 'x1.5', 'best combo shows as the multiple');
  assert.deepEqual(
    missed.tiles.map((t) => [t.key, t.value]),
    [['combo', 'x1.5'], ['orbs', '3'], ['near', '2'], ['rugs', '1']],
    'tiles carry combo, orbs, near calls, rugs survived',
  );
  assert.equal(missed.peakScore, 150, 'card peak = run high');
  assert.ok(FOOTER_PUNS.includes(missed.footer), 'footer is one of our own puns');
  assert.ok(!FOOTER_PUNS.some((p) => p.includes('cinema')), 'the footer set is ours, not the reference\u2019s');
  assert.equal(missed.stake, 10, 'a run with no stake recorded settles at the default');
  assert.equal(missed.target, 200, 'a run with no bar recorded settles at the default bar');
  assert.equal(missed.moneyText, 'IN $10 → OUT $0 · −$10', 'a missed bar pays out nothing');
  assert.equal(missed.moneyTone, 'red', 'a lost bag tones red');
  assert.equal(missed.vsPrevText, '+50.0% vs last run', 'the beaten last run survives as the quiet note');

  // The same run, bigger: 400 clears the default bar and the card
  // turns green even though the note still compares honestly.
  const cleared = buildCardData({ ...sum150, score: 400, peakScore: 400 }, { score: 100 }, false);
  assert.equal(cleared.win, true);
  assert.equal(cleared.tone, 'green', 'a cleared bar tones the card green');
  assert.equal(cleared.verdictLabel, 'BAR CLEARED · 4x vs 3x bar', 'pill states the bar clear');
  assert.equal(cleared.gainText, '+300.0%', 'win gain is the money gain vs the stake');
  assert.equal(cleared.moneyText, 'IN $10 → OUT $40 · +$30', 'a cleared bar pays stake x multiple');
  assert.equal(cleared.moneyTone, 'green');
  assert.equal(cleared.vsPrevText, '+300.0% vs last run');

  // First trade: the note says so; a new best appends to the note,
  // never to the pill.
  const first = buildCardData({ ...sum150, score: 400, peakScore: 400 }, null, false);
  assert.equal(first.vsPrevText, 'first trade', 'first run has no comparison to make');
  assert.equal(
    buildCardData({ ...sum150, score: 400, peakScore: 400 }, null, true).vsPrevText,
    'first trade · new best',
    'new best appends to the note',
  );
  assert.equal(gainPctFor(150, { score: 0 }), null, 'a zero-score previous run cannot divide');
  assert.equal(
    buildCardData({ ...sum150, score: 400, peakScore: 400 }, { score: 0 }, false).vsPrevText,
    '+400 pts vs last run',
    'zero-score previous run falls back to the absolute delta in the note',
  );

  // Share text: the player's voice — lowercase, no dash punctuation,
  // no hackathon tags — opening with the call and the settlement.
  const winShare = cleared.shareText;
  assert.equal(winShare, winShare.toLowerCase(), 'share text is all lowercase');
  assert.ok(!winShare.includes('—') && !/ - /.test(winShare), 'share text has no dash punctuation');
  assert.ok(!winShare.includes('#') && !winShare.includes('@'), 'share text is a game share, not the hackathon post');
  assert.ok(winShare.startsWith('called 3x on pump rider, hit 4x. turned $10 into $40.'), 'win share opens with the call and the payout');
  assert.ok(winShare.includes('closed +400 pts'), 'share carries the close');
  assert.ok(winShare.includes('3 orbs clipped'), 'share counts the orbs');
  assert.ok(winShare.includes('best combo x1.5'), 'share carries the best combo');
  assert.ok(winShare.endsWith('the pump was near.'), 'win share closes on the pun');
  assert.ok(
    buildCardData({ ...sum150, score: 400, peakScore: 400 }, { score: 100 }, true).shareText.endsWith('new best. wagmi.'),
    'new-best share closes on wagmi',
  );
  const lossShare = missed.shareText;
  assert.ok(lossShare.startsWith('called 3x on pump rider, hit 1.5x. lost the $10 bag.'), 'loss share opens with the call and the lost bag');
  assert.ok(lossShare.endsWith('the line won this one. running it back.'), 'loss share closes on the run-back line');
  assert.ok(
    buildCardData({ ...sum150, orbs: 1, score: 400, peakScore: 400 }, { score: 100 }, false).shareText.includes('1 orb clipped'),
    'share singularises one orb',
  );
  ok('PnL card: summary matches the run, samples chart it, card identity is the bar settlement');
}

// 14. The stake: the ladder is exactly the amounts the user asked
// for, the stepper walks it clamped at both ends, chips and stepper
// share one index space, and the money math settles honestly — big
// wins, underwater runs, zero scores, break-evens, thousands and
// cents included. The card model and the share text carry the same
// figures from the same pure source.
{
  assert.deepEqual(STAKE_LADDER, [1, 5, 10, 50, 100, 1000], 'the stake ladder is the six chosen amounts');
  assert.equal(DEFAULT_STAKE, 10, 'the default stake is $10');
  assert.equal(stakeIndexOf(1), 0);
  assert.equal(stakeIndexOf(10), 2, 'the default sits mid-ladder');
  assert.equal(stakeIndexOf(1000), 5);
  assert.equal(stakeIndexOf(999), 2, 'an off-ladder amount falls back to the default index');
  assert.equal(sanitizeStake(50), 50, 'a ladder amount survives sanitising');
  assert.equal(sanitizeStake(7), 10, 'an off-ladder amount sanitises to the default');
  assert.equal(sanitizeStake(undefined), 10, 'no stake recorded settles at the default');
  assert.equal(stepStakeIndex(2, 1), 3, 'stepper walks up');
  assert.equal(stepStakeIndex(2, -1), 1, 'stepper walks down');
  assert.equal(stepStakeIndex(0, -1), 0, 'stepper clamps at the $1 floor, no wrap');
  assert.equal(stepStakeIndex(5, 1), 5, 'stepper clamps at the $1,000 top, no wrap');

  // The user's headline example: a 1284 run on a $50 stake is a
  // 12.84x bag — $642 out, $592 up.
  assert.deepEqual(moneyFor(1284, 50), { multiple: 12.84, payout: 642, pnl: 592 }, 'money: the 12.84x bag');
  // Underwater: score under 100 pays back less than the stake.
  assert.deepEqual(moneyFor(40, 50), { multiple: 0.4, payout: 20, pnl: -30 }, 'money: an underwater run pays cents on the dollar');
  // Zero score: the whole stake is gone.
  assert.deepEqual(moneyFor(0, 100), { multiple: 0, payout: 0, pnl: -100 }, 'money: a zero run loses the stake');
  // Break-even at exactly 100 pts.
  assert.deepEqual(moneyFor(100, 10), { multiple: 1, payout: 10, pnl: 0 }, 'money: 100 pts is exactly 1x, stake back');
  // Formatting: separators for thousands, cents only when real.
  assert.equal(fmtMoney(1000), '$1,000', 'whole thousands get separators, no cents');
  assert.equal(fmtMoney(12840), '$12,840');
  assert.equal(fmtMoney(10.81), '$10.81', 'real cents are shown');
  assert.equal(fmtMoney(0), '$0');
  assert.equal(fmtSignedMoney(592), '+$592', 'a win is signed +');
  assert.equal(fmtSignedMoney(-29), '−$29', 'a loss carries a real minus sign (U+2212), not a hyphen');
  assert.ok(!fmtSignedMoney(-29).includes('-'), 'the signed loss contains no hyphen character');
  assert.equal(fmtSignedMoney(0), '$0', 'break-even is unsigned and neutral');

  // The card model settles the stake the run was begun with.
  const base = {
    preset: 'Chill', score: 1284, peakScore: 1284, orbs: 12, closeCalls: 2,
    rugsSurvived: 1, bestCombo: 5, bestMultiplier: 3.5, duration: 29.9,
    events: [], samples: [],
  };
  const bag = buildCardData({ ...base, stake: 50 }, { score: 3050 }, false);
  assert.equal(bag.stake, 50, 'card carries the stake');
  assert.equal(bag.multiple, 12.84, 'card multiple is score / 100 exactly');
  assert.equal(bag.bagMultText, '12.84x');
  assert.equal(bag.payout, 642);
  assert.equal(bag.pnl, 592);
  assert.equal(bag.moneyTone, 'green');
  assert.equal(bag.moneyText, 'IN $50 → OUT $642 · +$592', 'the strip reads in, out, difference');
  // The card follows the money, not the last run: 1284 cleared the
  // default 300-pt bar, so the card is GREEN even though the previous
  // run scored 3050 — the comparison lives in the quiet note only.
  assert.equal(bag.win, true, '1284 clears the default bar');
  assert.equal(bag.tone, 'green', 'the card grades the bar, not the last run');
  assert.equal(bag.verdictLabel, 'BAR CLEARED · 12.84x vs 3x bar');
  assert.equal(bag.gainText, '+1184.0%', 'gain is the money gain vs the stake');
  assert.equal(bag.vsPrevText, '−57.9% vs last run', 'the lost comparison is demoted to the note');
  const under = buildCardData({ ...base, score: 40, peakScore: 40, stake: 50 }, null, false);
  assert.equal(under.win, false);
  assert.equal(under.payout, 0, 'a missed bar pays nothing, however far the run got');
  assert.equal(under.pnl, -50, 'a missed bar loses the whole stake');
  assert.equal(under.moneyText, 'IN $50 → OUT $0 · −$50', 'loss strip: out is $0, loss with a real minus');
  assert.equal(under.moneyTone, 'red');
  const zero = buildCardData({ ...base, score: 0, peakScore: 0, stake: 100 }, null, false);
  assert.equal(zero.moneyText, 'IN $100 → OUT $0 · −$100', 'zero run: out is $0');
  // 100 pts was break-even under the old money; under the bar it is
  // a miss like any other — the bag is gone.
  const even = buildCardData({ ...base, score: 100, peakScore: 100, stake: 10 }, null, false);
  assert.equal(even.win, false, '100 pts does not clear a 300-pt bar');
  assert.equal(even.moneyText, 'IN $10 → OUT $0 · −$10', 'a sub-bar run pays $0');
  assert.equal(even.moneyTone, 'red');
  const whale = buildCardData({ ...base, stake: 1000 }, null, false);
  assert.equal(whale.moneyText, 'IN $1,000 → OUT $12,840 · +$11,840', 'thousands separate on the strip');
  const cents = buildCardData({ ...base, score: 1081, peakScore: 1081, stake: 1 }, null, false);
  assert.equal(cents.moneyText, 'IN $1 → OUT $10.81 · +$9.81', 'cent payouts print their cents');
  // Share text: the call leads, in the player's voice.
  const shareBag = bag.shareText;
  assert.ok(shareBag.startsWith('called 3x on pump rider, hit 12.84x. turned $50 into $642.'), 'share opens with the call and the settlement');
  assert.ok(shareBag.includes('closed +1284 pts'), 'share still carries the close');
  assert.equal(shareBag, shareBag.toLowerCase(), 'money share stays lowercase');
  assert.ok(!shareBag.includes('—') && !/ - /.test(shareBag), 'money share has no dash punctuation');
  assert.ok(shareBag.length < 240, `share fits X with margin (${shareBag.length} chars)`);
  assert.ok(under.shareText.startsWith('called 3x on pump rider, hit 0.4x. lost the $50 bag.'), 'loss share names the lost bag');

  // The recorder carries the stake from begin() into the summary.
  const recStake = createRunRecorder();
  recStake.begin('Chill', 50);
  assert.equal(recStake.finish({ score: 0, time: 0 }).stake, 50, 'summary carries the stake the run began with');
  const recOff = createRunRecorder();
  recOff.begin('Chill', 999);
  assert.equal(recOff.finish({ score: 0, time: 0 }).stake, 10, 'an off-ladder begin stake falls back to the default');
  ok('stake: ladder, clamped stepper, honest money math, card + share settle from one source');
}

// 15. The bar: the target ladder and the points it demands, the
// persistence sanitize, settlement v2 (clear it and the bag pays at
// the run's multiple; miss it — by a mile or by a single point — and
// the whole bag is gone), the decimated last-run curve the next card
// draws, and the two-line chart on its common scale.
{
  assert.deepEqual(TARGET_LADDER, [50, 100, 200, 400, 900, 1900], 'the bar ladder is the six chosen gains');
  assert.equal(DEFAULT_TARGET, 200, 'the default bar is +200%');
  assert.deepEqual(
    TARGET_LADDER.map(targetPoints), [150, 200, 300, 500, 1000, 2000],
    'each gain maps to its needed points (100 pts per 1x)',
  );
  assert.deepEqual(
    TARGET_LADDER.map(targetMultiple), [1.5, 2, 3, 5, 10, 20],
    'each gain maps to its multiple',
  );
  assert.equal(sanitizeTarget(400), 400, 'a ladder gain survives sanitising');
  assert.equal(sanitizeTarget(250), 200, 'an off-ladder gain sanitises to the default');
  assert.equal(sanitizeTarget(undefined), 200, 'no bar recorded settles at the default');
  assert.equal(targetIndexOf(50), 0);
  assert.equal(targetIndexOf(200), 2, 'the default sits mid-ladder');
  assert.equal(targetIndexOf(1900), 5);
  assert.equal(stepTargetIndex(2, 1), 3, 'bar stepper walks up');
  assert.equal(stepTargetIndex(0, -1), 0, 'bar stepper clamps at the floor, no wrap');
  assert.equal(stepTargetIndex(5, 1), 5, 'bar stepper clamps at the top, no wrap');

  // Settlement v2: a clear win pays stake x multiple.
  assert.deepEqual(
    settleRun(1284, 50, 200),
    { multiple: 12.84, barMult: 3, needed: 300, win: true, payout: 642, pnl: 592, gainPct: 1184 },
    'settle: the 12.84x bag over a 3x bar',
  );
  // Meeting the bar exactly counts as cleared.
  const exact = settleRun(300, 10, 200);
  assert.equal(exact.win, true, 'settle: an exact bar hit clears');
  assert.equal(exact.payout, 30);
  assert.equal(exact.pnl, 20);
  assert.equal(exact.gainPct, 200);
  // Missing by ONE point loses the whole bag.
  const byOne = settleRun(299, 10, 200);
  assert.equal(byOne.win, false, 'settle: one point short is a miss');
  assert.equal(byOne.payout, 0, 'settle: a miss pays $0');
  assert.equal(byOne.pnl, -10, 'settle: a miss loses the whole stake');
  assert.equal(byOne.gainPct, -100);
  // A zero run loses the whole bag too.
  assert.deepEqual(
    settleRun(0, 100, 200),
    { multiple: 0, barMult: 3, needed: 300, win: false, payout: 0, pnl: -100, gainPct: -100 },
    'settle: a zero run loses the stake',
  );
  // The user's case in pure form: a multiple above 1x — a run that
  // "made money" under the old rules — still loses the bag when it
  // never reached the bar it called.
  const paper = settleRun(250, 10, 200);
  assert.equal(paper.multiple, 2.5, 'a 250 run is a 2.5x multiple');
  assert.equal(paper.win, false, 'but 2.5x never cleared a 3x bar');
  assert.equal(paper.payout, 0, 'so the bag is gone');
  // The bar scales with the call: +1900% demands 2000 pts.
  assert.equal(settleRun(1999, 10, 1900).win, false, '1999 misses the +1900% bar');
  assert.equal(settleRun(2000, 10, 1900).win, true, '2000 clears the +1900% bar');
  assert.equal(settleRun(2000, 10, 1900).payout, 200, 'and pays 20x the stake');

  // The recorder carries the bar from begin() into the summary, and
  // sanitises an off-ladder call to the default.
  const recBar = createRunRecorder();
  recBar.begin('Chill', 50, 400);
  const barSummary = recBar.finish({ score: 0, time: 0 });
  assert.equal(barSummary.target, 400, 'summary carries the bar the run began with');
  assert.equal(barSummary.stake, 50, 'summary still carries the stake alongside');
  const recBarOff = createRunRecorder();
  recBarOff.begin('Chill', 50, 250);
  assert.equal(recBarOff.finish({ score: 0, time: 0 }).target, 200, 'an off-ladder begin bar falls back to the default');

  // The stored last run keeps its curve, decimated: shape and
  // endpoints survive, the record stays small.
  const dense = Array.from({ length: 600 }, (_, i) => ({ t: i * 0.25, score: i * 2 }));
  const dec = decimateSamples(dense);
  assert.ok(dec.length <= PREV_SAMPLES_MAX + 1, `decimated to ~${PREV_SAMPLES_MAX} points (got ${dec.length})`);
  assert.deepEqual(dec[0], dense[0], 'decimation keeps the first sample');
  assert.deepEqual(dec[dec.length - 1], dense[dense.length - 1], 'decimation keeps the last sample (the peak)');
  const sparse = [{ t: 0, score: 0 }, { t: 3, score: 40 }];
  assert.deepEqual(decimateSamples(sparse), sparse, 'a short curve is stored intact');
  assert.deepEqual(decimateSamples(undefined), [], 'a missing curve decimates to empty');
  assert.deepEqual(decimateSamples('nope'), [], 'a non-array curve decimates to empty');

  // Two lines, ONE common scale: both curves normalize against the
  // greater peak and the longer duration of the pair, and the frame
  // always contains the bar.
  const cur = {
    score: 500, peakScore: 500, duration: 10, target: 200,
    samples: [{ t: 0, score: 0 }, { t: 5, score: 250 }, { t: 10, score: 500 }], events: [],
  };
  const prev = {
    score: 1000, peakScore: 1000, duration: 20,
    samples: [{ t: 0, score: 0 }, { t: 20, score: 1000 }],
  };
  const m = chartModel(cur, prev);
  assert.equal(m.hasPrev, true, 'a previous run with a curve draws the sub-line');
  assert.deepEqual(m.line[2], { x: 0.5, y: 0.5 }, 'current run normalized against the GREATER peak and duration');
  assert.deepEqual(m.prevLine[1], { x: 1, y: 1 }, 'the bigger previous run owns the top-right');
  assert.ok(Math.abs(m.targetY - 0.3) < 1e-9, 'bar line at 300 of the 1000 common peak');
  assert.ok(Math.abs(m.peakY - 0.5) < 1e-9, 'peak marker at this run\u2019s own high on the common scale');
  assert.equal(
    chartModel(cur, { score: 900, duration: 9 }).hasPrev, false,
    'a previous record with no stored curve (pre-bar build) draws no sub-line',
  );
  assert.equal(
    chartModel(cur, { score: 900, duration: 9, samples: [{ t: 0, score: 0 }] }).hasPrev, false,
    'a one-point curve is not a line',
  );
  const tall = chartModel({ ...cur, target: 1900 }, null);
  assert.ok(Math.abs(tall.targetY - 1) < 1e-9, 'a taller bar can BE the top of the frame');
  assert.ok(Math.abs(tall.line[2].y - 0.25) < 1e-9, 'the run shrinks under the taller bar, never clipped by it');
  ok('the bar: ladder, settlement v2, decimated curve, two-line common-scale chart');
}

// 16. Volatility coupling: the difficulty multipliers also set how
// fast points accrue. One payout factor — the power-curved geometric
// mean of the three settings — scales every point at the moment it
// is earned, classic paying exactly x1. The bands below are the
// user's table, measured with this suite's own pilot (median of nine
// seeded runs), not asserted from theory.
{
  const FLOOR = { speedScale: 0.5, thrust: 0.5, gravity: 0.5 };
  const CEIL = { speedScale: 1.5, thrust: 1.8, gravity: 1.8 };
  const floor = payoutFactorFor(FLOOR);
  const ceil = payoutFactorFor(CEIL);
  assert.equal(payoutFactorFor({ speedScale: 1, thrust: 1, gravity: 1 }), 1, 'classic settings pay exactly x1.00');
  assert.equal(payoutFactorFor(PRESETS.classic), 1, 'the classic preset pays exactly x1.00');
  assert.ok(Math.abs(floor - 0.747) < 0.01, `the slider floor pays ~x0.75 (got ${floor.toFixed(3)})`);
  assert.ok(Math.abs(ceil - 1.248) < 0.01, `the slider ceiling pays ~x1.25 (got ${ceil.toFixed(3)})`);
  assert.ok(floor < 1 && ceil > 1, 'the factor straddles 1 across the range');
  assert.ok(
    payoutFactorFor(PRESETS.chill) < 1 && payoutFactorFor(PRESETS.degen) > 1,
    'the presets straddle classic too (chill under, degen over)',
  );
  // Monotonic in each slider on its own: raising any one multiplier
  // never lowers the payout.
  for (const key of ['speedScale', 'thrust', 'gravity']) {
    const lo = payoutFactorFor({ speedScale: 1, thrust: 1, gravity: 1, [key]: 0.6 });
    const mid = payoutFactorFor({ speedScale: 1, thrust: 1, gravity: 1 });
    const hi = payoutFactorFor({ speedScale: 1, thrust: 1, gravity: 1, [key]: 1.6 });
    assert.ok(lo < mid && mid < hi, `the factor rises with ${key}`);
  }
  // The achieved span is ~1.67x, deliberately NOT the ~2.5x first
  // asked for: the physics alone already accrue ~3x faster per
  // second at the ceiling than at the floor, and the measured bands
  // below are the binding constraint — a 2.5x factor span would push
  // ceiling medians past ~390 (the band caps at 310) or drag the
  // floor under 100. Bands first; the span is what's left.
  assert.ok(ceil / floor >= 1.6, `the factor spans at least 1.6x (got ${(ceil / floor).toFixed(2)}x)`);
  // Measured rate bands (median of nine seeded pilot runs):
  // floor settings bank ~110-150 in 10s, classic ~150 in 5s, the
  // ceiling ~200-300 in 5s.
  const SEEDS = [7, 42, 99, 123, 555, 2026, 31337, 8, 2718];
  const medianScoreAt = (settings, seconds) => {
    const scores = SEEDS.map((seed) => {
      const s = createGame(seed, { settings });
      runWith(s, seconds, autopilotThrust);
      assert.ok(Number.isInteger(s.score), 'the score stays an integer under the payout factor');
      return s.score;
    }).sort((a, b) => a - b);
    return scores[Math.floor(scores.length / 2)];
  };
  const minMed = medianScoreAt(FLOOR, 10);
  const classicMed = medianScoreAt({ speedScale: 1, thrust: 1, gravity: 1 }, 5);
  const maxMed = medianScoreAt(CEIL, 5);
  assert.ok(minMed >= 100 && minMed <= 160, `floor: 10s banks 100-160 (median ${minMed})`);
  assert.ok(classicMed >= 130 && classicMed <= 170, `classic: 5s banks 130-170 (median ${classicMed})`);
  assert.ok(maxMed >= 190 && maxMed <= 310, `ceiling: 5s banks 190-310 (median ${maxMed})`);
  assert.ok(minMed < classicMed && classicMed < maxMed, 'the accrual rate is monotonic in the settings');
  ok('volatility coupling: payout factor calibrated, measured bands in range');
}

// 17. Currency: the stake can ride in dollars or NEAR. The math is
// unit-agnostic (payout = stake x multiple in the active unit); the
// ladders, stepper steps, conversions and formatting are recap-pure
// and pinned here, including the honest fixed reference rate.
{
  assert.deepEqual(NEAR_LADDER, [1, 5, 10, 50, 100, 250], 'the NEAR ladder is the native ladder');
  assert.equal(NEAR_RATE, 3.63, 'the reference rate is the fixed 2026-11-07 rate');
  assert.equal(DEFAULT_NEAR_STAKE, 10, 'the default NEAR stake is 10');
  assert.equal(sanitizeCurrency('near'), 'near');
  assert.equal(sanitizeCurrency('usd'), 'usd');
  assert.equal(sanitizeCurrency('eur'), 'usd', 'an unknown currency sanitises to dollars');
  assert.equal(sanitizeCurrency(undefined), 'usd', 'no currency recorded means dollars');
  assert.equal(sanitizeNearStake(2.754), 2.75, 'a NEAR stake keeps two decimals');
  assert.equal(sanitizeNearStake(0), 0.5, 'the NEAR floor is half a NEAR');
  assert.equal(sanitizeNearStake(99999), 1000, 'the NEAR ceiling is a thousand');
  assert.equal(sanitizeNearStake(NaN), 10, 'a garbage NEAR stake falls back to the default');
  // Conversions at the reference rate, with the rounding rules:
  // into NEAR two decimals under 10 and whole above; into dollars
  // whole, snapped to the USD ladder (log-nearest rung).
  assert.equal(usdToNear(50), 14, '$50 converts to 14 NEAR (13.77, whole above 10)');
  assert.equal(usdToNear(10), 2.75, '$10 converts to 2.75 NEAR (two decimals under 10)');
  assert.equal(usdToNear(1000), 275, '$1,000 converts to 275 NEAR');
  assert.equal(usdToNear(1), 0.28, '$1 converts to 0.28 NEAR');
  assert.equal(nearToUsd(14), 50, '14 NEAR converts back to the $50 rung');
  assert.equal(nearToUsd(2.75), 10, '2.75 NEAR converts back to the $10 rung');
  assert.equal(nearToUsd(275), 1000, '275 NEAR converts back to the $1,000 rung');
  assert.equal(nearToUsd(1), 5, '1 NEAR (~$3.63) snaps to the $5 rung, the log-nearest');
  // The NEAR stepper: halves under 10, then fives, clamped both ends.
  assert.equal(stepNearStake(9.5, 1), 10, 'half steps climb to 10');
  assert.equal(stepNearStake(10, 1), 15, 'at 10 the steps become fives');
  assert.equal(stepNearStake(10, -1), 9.5, 'stepping down from 10 returns to halves');
  assert.equal(stepNearStake(12, -1), 7, 'above 10, down-steps are fives too');
  assert.equal(stepNearStake(0.5, -1), 0.5, 'the stepper clamps at the floor');
  assert.equal(stepNearStake(1000, 1), 1000, 'the stepper clamps at the ceiling');
  // Formatting: the card and the share text speak the active unit.
  assert.equal(fmtNear(1000), '1,000', 'NEAR amounts group their thousands');
  assert.equal(fmtNear(2.75), '2.75', 'NEAR amounts keep their decimals');
  assert.equal(fmtAmount(50, 'near'), '50 NEAR');
  assert.equal(fmtAmount(50, 'usd'), '$50');
  assert.equal(fmtSignedAmount(271, 'near'), '+271 NEAR');
  assert.equal(fmtSignedAmount(-50, 'near'), '−50 NEAR', 'a real minus sign, never a hyphen');
  assert.equal(fmtSignedAmount(0, 'near'), '0 NEAR');
  assert.equal(fmtUnitLower(321, 'near'), '321 near', 'the share voice keeps the unit lowercase');
  assert.equal(fmtUnitLower(50, 'usd'), '$50');

  // The card model in NEAR: strip in NEAR with the pnl's dollar
  // equivalent appended (it fits), share text in NEAR.
  const nearSummary = {
    preset: 'CHILL', stake: 50, target: 200, currency: 'near', score: 1284,
    duration: 29.9, orbs: 12, bestMultiplier: 3.5, closeCalls: 3,
    rugsSurvived: 1, peakScore: 1284, samples: [], events: [],
  };
  const nearWin = buildCardData(nearSummary, null, true);
  assert.equal(nearWin.currency, 'near', 'the card model carries the run\u2019s currency');
  assert.equal(
    nearWin.moneyText, 'IN 50 NEAR → OUT 642 NEAR · +592 NEAR · ≈ +$2,149',
    'NEAR win strip: unit figures plus the pnl in dollars (592 x 3.63)',
  );
  assert.ok(nearWin.shareText.includes('turned 50 near into 642 near'), 'NEAR win share text settles in NEAR');
  const nearLoss = buildCardData({ ...nearSummary, score: 100 }, null, false);
  assert.equal(
    nearLoss.moneyText, 'IN 50 NEAR → OUT 0 NEAR · −50 NEAR · ≈ −$182',
    'NEAR loss strip: the whole bag gone, its dollars shown',
  );
  assert.ok(nearLoss.shareText.includes('lost the 50 near bag'), 'NEAR loss share text loses the NEAR bag');
  // The dollar equivalent is dropped when the strip would overflow:
  // a monster NEAR win keeps the unit figures only.
  const huge = buildCardData({ ...nearSummary, stake: 1000, target: 50, score: 25000 }, null, false);
  assert.ok(!huge.moneyText.includes('≈'), 'an overflowing strip drops the dollar equivalent');
  assert.ok(huge.moneyText.startsWith('IN 1,000 NEAR → OUT 250,000 NEAR'), 'the unit figures stay');
  // A legacy summary with no currency recorded settles in dollars.
  const legacy = { ...nearSummary };
  delete legacy.currency;
  assert.equal(buildCardData(legacy, null, false).moneyText, 'IN $50 → OUT $642 · +$592', 'no currency recorded settles in dollars');
  // The recorder carries the currency from begin() into the summary
  // and sanitises the stake in the active unit.
  const recNear = createRunRecorder();
  recNear.begin('Chill', 2.754, 200, 'near');
  const nearRecSummary = recNear.finish({ score: 0, time: 0 });
  assert.equal(nearRecSummary.currency, 'near', 'the summary carries the run\u2019s currency');
  assert.equal(nearRecSummary.stake, 2.75, 'a NEAR begin sanitises the stake to two decimals');
  const recBogus = createRunRecorder();
  recBogus.begin('Chill', 50, 200, 'bogus');
  assert.equal(recBogus.finish({ score: 0, time: 0 }).currency, 'usd', 'a bogus currency begins in dollars');
  ok('currency: NEAR ladder, conversions, unit-true card and share text');
}

// 18. Game-over headlines: a cleared bar speaks in the WIN set,
// never the crash set; a new best outranks both; a missed bar keeps
// the crash set. The pick is the card model's own field, so screen,
// PNG and tests can never disagree.
{
  const sum = {
    preset: 'Chill', score: 150, peakScore: 150, orbs: 3, closeCalls: 1,
    rugsSurvived: 0, bestCombo: 2, bestMultiplier: 1.5, duration: 9.4,
    events: [], samples: [],
  };
  assert.deepEqual(WIN_LINES, ['called it. bag paid.', 'bar cleared. printed.', 'read the chart. ate.', 'the bar blinked first.'], 'the win headline set is the four chosen lines');
  // A cleared bar that is also a new best: the new-best line wins.
  const bestWin = buildCardData({ ...sum, score: 400, peakScore: 400 }, { score: 100 }, true);
  assert.equal(bestWin.win, true, 'fixture clears the bar');
  assert.equal(bestWin.headline, NEW_BEST_LINE, 'cleared + new best headlines the new best');
  assert.equal(pickOverHeadline(true, true, 2), NEW_BEST_LINE, 'picker: best outranks win');
  assert.equal(pickOverHeadline(true, false, 2), NEW_BEST_LINE, 'picker: best outranks a miss too');
  // A cleared bar, not a best: a WIN-set line, never a crash line,
  // and the rotation walks the whole set.
  const winHeads = new Set();
  for (let s = 0; s < WIN_LINES.length; s++) {
    const h = pickOverHeadline(false, true, s);
    assert.equal(h, WIN_LINES[s], 'picker walks the win set in order');
    assert.ok(!OVER_LINES.includes(h), 'a cleared bar never headlines a crash line');
    winHeads.add(h);
  }
  assert.equal(winHeads.size, WIN_LINES.length, 'the win rotation covers every win line');
  for (const score of [300, 331, 400, 512, 1284]) {
    const card = buildCardData({ ...sum, score, peakScore: score }, { score: 100 }, false);
    assert.equal(card.win, true, 'fixture clears the bar');
    assert.ok(WIN_LINES.includes(card.headline), `cleared card headlines the win set (score ${score})`);
    assert.ok(!OVER_LINES.includes(card.headline), 'cleared card headline is never a crash line');
  }
  // A missed bar: the crash set, unchanged, rotating as before.
  for (let s = 0; s < OVER_LINES.length; s++) {
    assert.equal(pickOverHeadline(false, false, s), OVER_LINES[s], 'picker walks the crash set in order');
  }
  const missedCard = buildCardData({ ...sum }, { score: 100 }, false);
  assert.equal(missedCard.win, false, 'fixture misses the bar');
  assert.ok(OVER_LINES.includes(missedCard.headline), 'missed card headlines the crash set');
  // Every headline stays one short line in the player's voice
  // (the crash set's NEAR keeps its brand capitals, as before).
  for (const h of [NEW_BEST_LINE, ...WIN_LINES]) {
    assert.equal(h, h.toLowerCase(), 'win and new-best headlines are lowercase');
  }
  for (const h of [NEW_BEST_LINE, ...WIN_LINES, ...OVER_LINES]) {
    assert.ok(h.length <= 22, `headline stays short: ${h}`);
  }
  ok('headlines: win set for cleared bars, new best outranks, crash set for misses');
}

console.log(`\n${passed}/18 test groups passed`);
