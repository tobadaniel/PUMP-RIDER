// Behaviour tests for the Pump Rider engine.
// Run: node test/engine.test.mjs   (or: npm test)
// Seeded and reproducible — no timers, no DOM, no randomness of our own.

import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import {
  createGame, step, terrainHeightAt, terrainBaseHeightAt, PRESETS,
  WORLD_H, CEILING, PLAYER_R, BASE_SPEED, MAX_SPEED,
} from '../engine.js';
import {
  createRunRecorder, verdictFor, formatClock, MAX_LOG_EVENTS,
  buildCardData, chartModel, gainPctFor, FOOTER_PUNS, SAMPLE_EVERY,
  STAKE_LADDER, DEFAULT_STAKE, sanitizeStake, stakeIndexOf, stepStakeIndex,
  moneyFor, fmtMoney, fmtSignedMoney,
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
  assert.ok(dist.includes('CLOSED GREEN'), 'dist has the closed-green verdict copy');
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
// card model (gain vs the previous run, tiles, share text) must be
// derived honestly, first run included.
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

  // Chart model: unit-square points, ending at the top-right (the peak
  // IS the crash), one gold marker per orb the run actually clipped.
  const model = chartModel(summary);
  assert.equal(model.line.length, samples.length, 'chart line = the samples');
  assert.equal(Math.max(...model.line.map((p) => p.y)), 1, 'chart tops out at the run high');
  assert.deepEqual(model.crash, { x: 1, y: 1 }, 'crash marker sits at the peak, run end');
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

  // Verdicts: new best is green, beating the last run is green,
  // matching or missing it is red, a first-ever run is flat.
  assert.equal(verdictFor({ score: 120 }, { score: 200 }, true).tone, 'green', 'new best is green');
  assert.ok(verdictFor({ score: 120 }, { score: 200 }, true).label.includes('NEW BEST'));
  assert.equal(verdictFor({ score: 150 }, { score: 100 }, false).tone, 'green', 'beat last run is green');
  assert.equal(verdictFor({ score: 150 }, { score: 100 }, false).deltaVsPrev, 50);
  assert.equal(verdictFor({ score: 90 }, { score: 100 }, false).tone, 'red', 'worse than last run is red');
  assert.equal(verdictFor({ score: 100 }, { score: 100 }, false).tone, 'red', 'a tie does not beat the last run');
  assert.equal(verdictFor({ score: 40 }, null, false).tone, 'flat', 'first run has nothing to grade against');
  assert.equal(formatClock(83.25), '1:23.3', 'trade clock formats m:ss.d');

  // Card mapping: every figure on the card comes from the summary,
  // graded against the previous run; the first run says so instead of
  // inventing a gain.
  const sum150 = {
    preset: 'Classic', score: 150, peakScore: 150, orbs: 3, closeCalls: 2,
    rugsSurvived: 1, bestCombo: 2, bestMultiplier: 1.5, duration: 12.34,
    events: [], samples: [],
  };
  const green = buildCardData(sum150, { score: 100 }, false);
  assert.equal(green.preset, 'CLASSIC', 'card header shows the preset');
  assert.equal(green.heroText, '+150', 'hero is the final score');
  assert.equal(green.tone, 'green');
  assert.equal(green.gainPct, 50, 'gain is the signed % vs the previous run');
  assert.equal(green.gainText, '+50.0%');
  assert.equal(green.timeText, '12.3s', 'time in trade is the run duration');
  assert.equal(green.multText, 'x1.5', 'best combo shows as the multiple');
  assert.deepEqual(
    green.tiles.map((t) => [t.key, t.value]),
    [['combo', 'x1.5'], ['orbs', '3'], ['near', '2'], ['rugs', '1']],
    'tiles carry combo, orbs, near calls, rugs survived',
  );
  assert.equal(green.peakScore, 150, 'card peak = run high');
  assert.ok(FOOTER_PUNS.includes(green.footer), 'footer is one of our own puns');
  assert.ok(!FOOTER_PUNS.some((p) => p.includes('cinema')), 'the footer set is ours, not the reference\u2019s');
  const red = buildCardData({ ...sum150, score: 90, peakScore: 90 }, { score: 100 }, false);
  assert.equal(red.tone, 'red', 'a worse run closes red');
  assert.equal(red.gainText, '-10.0%', 'red gain is signed');
  const first = buildCardData(sum150, null, false);
  assert.equal(first.tone, 'flat', 'first run is ungraded');
  assert.equal(first.gainPct, null, 'first run has no gain %');
  assert.equal(first.gainText, 'FIRST TRADE', 'first run says FIRST TRADE instead of a %');
  assert.equal(gainPctFor(150, { score: 0 }), null, 'a zero-score previous run cannot divide');
  assert.equal(
    buildCardData(sum150, { score: 0 }, false).gainText, '+150 pts vs last',
    'zero-score previous run falls back to the absolute delta',
  );
  // Money defaults: sum150 records no stake (a pre-stake-card run),
  // so the card settles it at the default $10 — in $10, out $15, up $5.
  assert.equal(green.stake, 10, 'a run with no stake recorded settles at the default');
  assert.equal(green.moneyText, 'IN $10 → OUT $15 · +$5', 'money strip settles the default stake');
  assert.equal(green.moneyTone, 'green', 'a profitable bag tones green');
  assert.equal(red.moneyText, 'IN $10 → OUT $9 · −$1', 'an underwater bag shows the loss with a real minus sign');
  assert.equal(red.moneyTone, 'red', 'an underwater bag tones red');
  // Share text: the player's voice — lowercase, no dash punctuation,
  // no hackathon tags — opening with the stake settlement, closing on
  // the verdict's line.
  const share = green.shareText;
  assert.equal(share, share.toLowerCase(), 'share text is all lowercase');
  assert.ok(!share.includes('—') && !/ - /.test(share), 'share text has no dash punctuation');
  assert.ok(!share.includes('#') && !share.includes('@'), 'share text is a game share, not the hackathon post');
  assert.ok(share.startsWith('turned $10 into $15 on pump rider, 1.5x.'), 'share opens with the stake settlement');
  assert.ok(share.includes('closed +150 pts'), 'share carries the close');
  assert.ok(share.includes('3 orbs clipped'), 'share counts the orbs');
  assert.ok(share.includes('best combo x1.5'), 'share carries the best combo');
  assert.ok(share.endsWith('the pump was near.'), 'green share closes on the pun');
  assert.ok(
    buildCardData(sum150, { score: 100 }, true).shareText.endsWith('new best. wagmi.'),
    'new-best share closes on wagmi',
  );
  assert.ok(
    buildCardData({ ...sum150, orbs: 1 }, { score: 100 }, false).shareText.includes('1 orb clipped'),
    'share singularises one orb',
  );
  ok('PnL card: summary matches the run, samples chart it, card mapping grades honestly');
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
  assert.equal(bag.tone, 'red', 'the verdict still grades against the last run, independently of the money');
  const under = buildCardData({ ...base, score: 40, peakScore: 40, stake: 50 }, null, false);
  assert.equal(under.moneyText, 'IN $50 → OUT $20 · −$30', 'underwater strip: out below in, loss with a real minus');
  assert.equal(under.moneyTone, 'red');
  const zero = buildCardData({ ...base, score: 0, peakScore: 0, stake: 100 }, null, false);
  assert.equal(zero.moneyText, 'IN $100 → OUT $0 · −$100', 'zero run: out is $0');
  const even = buildCardData({ ...base, score: 100, peakScore: 100, stake: 10 }, null, false);
  assert.equal(even.moneyText, 'IN $10 → OUT $10 · $0', 'break-even strip is unsigned');
  assert.equal(even.moneyTone, 'flat', 'break-even tones neutral');
  const whale = buildCardData({ ...base, stake: 1000 }, null, false);
  assert.equal(whale.moneyText, 'IN $1,000 → OUT $12,840 · +$11,840', 'thousands separate on the strip');
  const cents = buildCardData({ ...base, score: 1081, peakScore: 1081, stake: 1 }, null, false);
  assert.equal(cents.moneyText, 'IN $1 → OUT $10.81 · +$9.81', 'cent payouts print their cents');
  // Share text: the money clause leads, in the player's voice.
  const shareBag = bag.shareText;
  assert.ok(shareBag.startsWith('turned $50 into $642 on pump rider, 12.84x.'), 'share opens with the settlement');
  assert.ok(shareBag.includes('closed +1284 pts'), 'share still carries the close');
  assert.equal(shareBag, shareBag.toLowerCase(), 'money share stays lowercase');
  assert.ok(!shareBag.includes('—') && !/ - /.test(shareBag), 'money share has no dash punctuation');
  assert.ok(shareBag.length < 240, `share fits X with margin (${shareBag.length} chars)`);
  assert.ok(under.shareText.startsWith('turned $50 into $20 on pump rider, 0.4x.'), 'underwater share settles honestly too');

  // The recorder carries the stake from begin() into the summary.
  const recStake = createRunRecorder();
  recStake.begin('Chill', 50);
  assert.equal(recStake.finish({ score: 0, time: 0 }).stake, 50, 'summary carries the stake the run began with');
  const recOff = createRunRecorder();
  recOff.begin('Chill', 999);
  assert.equal(recOff.finish({ score: 0, time: 0 }).stake, 10, 'an off-ladder begin stake falls back to the default');
  ok('stake: ladder, clamped stepper, honest money math, card + share settle from one source');
}

console.log(`\n${passed}/14 test groups passed`);
