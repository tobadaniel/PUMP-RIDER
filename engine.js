// engine.js — ALL the rules of Pump Rider, in one pure ES module.
// No DOM, no canvas, no timers: the same seed and the same inputs always
// produce the same run, which is what the tests in test/ rely on.
//
// THE GAME
// You ride a rocket above a live memecoin price chart. The chart is the
// ground: touch it and the run ends. Hold to pump (thrust up), release to
// fall. NEAR orbs float above the chart — grab them back to back to build
// a combo multiplier. Every so often the coin rugs: a warning flashes,
// the chart cliff-drops, then dead-cat-bounces back up, hard. Skim the
// chart for close-call bonuses. Survive a rug for a bigger one.
//
// COORDINATES
// World units, y UP. The chart height at world x is terrainHeightAt().
// The player must keep y - PLAYER_R above it. The world is WORLD_H tall.
//
// ---------------------------------------------------------------------

// World + physics ------------------------------------------------------------
export const WORLD_H = 640; // total world height in units
export const CEILING = 598; // soft sky: the rocket cannot climb past this
export const PLAYER_R = 13; // rocket collision radius
export const GRAVITY = 1500; // downward accel, units/s^2
export const THRUST = 2750; // upward accel while holding (net +1250)
export const MAX_VY = 545; // vertical speed clamp
export const LAUNCH_GRACE_TIME = 1.0; // seconds of eased gravity after spawn
export const BASE_SPEED = 252; // starting scroll speed, units/s
export const MAX_SPEED = 540; // scroll speed cap
export const SPEED_RAMP = 6.5; // scroll speed gained per second

// Terrain --------------------------------------------------------------------
export const SEG_DX = 90; // control-point spacing along x
export const TERRAIN_MIN = 88;
export const TERRAIN_MAX = 425;
export const TERRAIN_START = 232; // flat-ish launch pad height
export const FLAT_POINTS = 5; // safe runway: first points stay at START

// Scoring --------------------------------------------------------------------
export const SCORE_PER_UNIT = 12; // 1 point per 12 units travelled
export const ORB_BASE = 20; // orb points at x1 combo
export const COMBO_STEP = 0.5; // multiplier growth per consecutive orb
export const COMBO_CAP = 4; // multiplier ceiling
export const CLOSE_BONUS = 15; // near-miss bonus
export const CLOSE_DIST = 26; // gap (above the chart) that counts as close
export const CLOSE_COOLDOWN = 1.1; // seconds between close-call awards
export const RUG_BONUS = 150; // surviving a full rug event

// Orbs -----------------------------------------------------------------------
export const ORB_COLLECT_DX = 27;
export const ORB_COLLECT_DY = 31;
export const ORB_MISS_DX = 36; // orb this far behind you uncollected = missed

// Difficulty -------------------------------------------------------------------
// Settings are MULTIPLIERS on the shipped constants above, passed to
// createGame(seed, { settings }). "classic" is exactly the original feel
// (all 1s). "thrust" scales the NET climb acceleration (THRUST - GRAVITY),
// so pumping always out-climbs gravity no matter how the sliders are set.
// Same seed + same settings + same inputs = same run, always.
export const PRESETS = {
  chill: { speedScale: 0.7, gravity: 0.8, thrust: 0.85 },
  classic: { speedScale: 1, gravity: 1, thrust: 1 },
  degen: { speedScale: 1.3, gravity: 1.25, thrust: 1.25 },
};

// Volatility coupling --------------------------------------------------------
// Difficulty IS market volatility: the settings bend not only how the
// rocket flies but how fast points accrue. Every point a run earns —
// distance, orbs, close calls, the rug bonus — is scaled by ONE payout
// factor derived from the three multipliers: the geometric mean of
// (speedScale, thrust, gravity), power-curved. Calibrated by
// measurement with the test pilot (see test group 16): classic
// (all 1s) pays exactly x1.00, the slider floor (all 0.5s) pays x0.75,
// the ceiling (1.5 / 1.8 / 1.8) pays x1.25 — and a competent pilot
// banks roughly 120 pts in 10s at the floor, ~150 in 5s at classic,
// ~300 in 5s at the ceiling. The curve is deliberately gentler than
// the raw settings span: the physics themselves already accrue ~3x
// faster per second at the ceiling than at the floor, so a steeper
// factor would overshoot the ceiling band and starve the floor.
export const PAYOUT_CURVE = 0.42;
export function payoutFactorFor(settings) {
  const st = settings || {};
  const geo = Math.cbrt(
    (st.speedScale ?? 1) * (st.thrust ?? 1) * (st.gravity ?? 1),
  );
  return Math.pow(geo, PAYOUT_CURVE);
}

// Rug pulls ------------------------------------------------------------------
export const RUG_WARN_TIME = 1.1; // seconds of flashing warning first
export const RUG_ACTIVE_TIME = 4.2; // seconds from drop to "survived"
export const CLIFF_LEN = 980; // world units over which a cliff plays out

const LOOKAHEAD = 1600; // terrain/orbs generated this far ahead of the player

// Seeded RNG -----------------------------------------------------------------
// mulberry32: tiny, fast, deterministic. One stream per game, consumed in
// a fixed order (terrain points, then orbs, then rug rolls), so a seed
// fully determines a run.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return seed >>> 0;
  const s = String(seed);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Game construction ------------------------------------------------------------
export function createGame(seed, opts = {}) {
  const rng = mulberry32(hashSeed(seed));
  const st = opts.settings || {};
  const gravity = GRAVITY * (st.gravity ?? 1);
  const netThrust = (THRUST - GRAVITY) * (st.thrust ?? 1);
  const speedScale = st.speedScale ?? 1;
  const state = {
    seed,
    rng,
    rugsEnabled: opts.rugs !== false,
    gravity, // effective downward accel for this run
    netThrust, // effective upward accel while holding, net of gravity
    speedScale,
    payoutFactor: payoutFactorFor(st), // volatility: scales every point earned
    time: 0,
    x: 60,
    y: 0, // set below, once the launch pad exists
    vy: 0,
    speed: BASE_SPEED * speedScale,
    pts: [], // terrain control-point heights, index * SEG_DX = x
    orbs: [], // {x, y, collected, missed}
    nextOrbX: 520,
    cliffs: [], // {x, depth} rug cliff-drops baked into the terrain query
    combo: 0,
    multiplier: 1,
    orbScore: 0,
    bonusScore: 0,
    orbsCollected: 0,
    score: 0,
    crashed: false,
    closeCd: 0,
    rugPhase: 'idle', // idle -> warning -> active -> idle
    rugT: 0, // time left in the current rug phase
    nextRugIn: 13 + rng() * 9, // first rug lands 13-22s in
  };
  ensurePoints(state, Math.floor((state.x + LOOKAHEAD) / SEG_DX) + 1);
  ensureOrbs(state, state.x + LOOKAHEAD);
  state.y = terrainHeightAt(state, state.x) + 148;
  return state;
}

// Terrain generation -----------------------------------------------------------
// Control points form a seeded random walk with occasional violent
// pump/dump jumps, because this is a memecoin chart, not a golf course.
function genPoint(state, idx) {
  if (idx < FLAT_POINTS) return TERRAIN_START;
  const prev = state.pts[idx - 1];
  const r = state.rng();
  let step;
  if (r < 0.09) step = (95 + state.rng() * 55) * (state.rng() < 0.5 ? -1 : 1); // violent move
  else step = (state.rng() * 2 - 1) * 64;
  return Math.min(TERRAIN_MAX, Math.max(TERRAIN_MIN, prev + step));
}

function ensurePoints(state, uptoIdx) {
  while (state.pts.length <= uptoIdx) {
    state.pts.push(genPoint(state, state.pts.length));
  }
}

// Orbs are seeded off the same stream, always generated in increasing-x
// order from their own frontier, so a seed reproduces the exact same orb
// field. Kept separate from ensurePoints because terrain queries recurse
// into ensurePoints and must never consume orb randomness out of order.
function ensureOrbs(state, uptoX) {
  while (state.nextOrbX < uptoX) {
    const ox = state.nextOrbX + state.rng() * 110;
    const base = terrainBaseHeightAt(state, ox);
    const oy = Math.min(CEILING - 42, base + 74 + state.rng() * 118);
    state.orbs.push({ x: ox, y: oy, collected: false, missed: false });
    state.nextOrbX = ox + 265 + state.rng() * 230;
  }
}

// Smooth (smoothstep) interpolation between control points, cliffs excluded.
export function terrainBaseHeightAt(state, x) {
  const i = Math.max(0, Math.floor(x / SEG_DX));
  ensurePoints(state, i + 1);
  const f = Math.min(1, Math.max(0, (x - i * SEG_DX) / SEG_DX));
  const s = f * f * (3 - 2 * f);
  return state.pts[i] + (state.pts[i + 1] - state.pts[i]) * s;
}

// A rug cliff: the chart plunges by `depth`, sits in the crater, then
// dead-cat-bounces ABOVE its old line before settling. Piecewise keyframes
// over CLIFF_LEN world units, smoothstepped between keys.
const CLIFF_KEYS = [
  [0.0, 0],
  [0.07, -1],
  [0.42, -1],
  [0.68, 0.3],
  [1.0, 0],
];
function cliffOffset(cliff, x) {
  const s = (x - cliff.x) / CLIFF_LEN;
  if (s <= 0 || s >= 1) return 0;
  for (let k = 0; k < CLIFF_KEYS.length - 1; k++) {
    const [s0, v0] = CLIFF_KEYS[k];
    const [s1, v1] = CLIFF_KEYS[k + 1];
    if (s >= s0 && s <= s1) {
      const f = (s - s0) / (s1 - s0);
      const sm = f * f * (3 - 2 * f);
      return cliff.depth * (v0 + (v1 - v0) * sm);
    }
  }
  return 0;
}

// The one terrain query everything (physics, rendering, tests) uses.
export function terrainHeightAt(state, x) {
  let h = terrainBaseHeightAt(state, x);
  for (const c of state.cliffs) {
    if (x > c.x) h += cliffOffset(c, x);
  }
  return h;
}

// Launch grace -----------------------------------------------------------------
// A fresh run spawns 148 units above the chart with zero vertical speed,
// so at full gravity an idle rocket is dead in ~0.5s — before a first-time
// player (especially on a phone) can even get a finger down. For the
// first LAUNCH_GRACE_TIME seconds, gravity therefore eases in from zero
// with a cubic ramp: the rocket effectively hovers, then sinks gently,
// then falls for real. The window is the same for every preset and depends
// only on state.time, so seed determinism is untouched. Thrust is NEVER
// eased: the moment you hold, you climb at full power, from frame one.
function gravityScaleAt(time) {
  if (time >= LAUNCH_GRACE_TIME) return 1;
  const s = Math.max(0, time / LAUNCH_GRACE_TIME);
  return s * s * s;
}

// The step ---------------------------------------------------------------------
// Advances the run by dt seconds. `thrust` is the one button. Returns the
// events that happened this step, so the UI can play sounds and particles:
//   orb {points, combo, multiplier, x, y}   closecall {gap}
//   comboLost {}                            rugwarning {}
//   rugdrop {depth}                         rugsurvived {}
//   crash {x, y}
export function step(state, dt, thrust) {
  if (state.crashed) return [];
  dt = Math.min(dt, 0.05);
  const events = [];
  state.time += dt;

  // Scroll: the chart flies at you, faster the longer you live.
  state.speed = Math.min(
    MAX_SPEED * state.speedScale,
    (BASE_SPEED + state.time * SPEED_RAMP) * state.speedScale,
  );
  state.x += state.speed * dt;

  // Vertical physics: hold to pump, release to fall. During the launch
  // grace the fall is eased in (see gravityScaleAt); the pump is not.
  const accel = thrust
    ? state.netThrust
    : -state.gravity * gravityScaleAt(state.time);
  state.vy = Math.max(-MAX_VY, Math.min(MAX_VY, state.vy + accel * dt));
  state.y += state.vy * dt;
  if (state.y > CEILING) {
    state.y = CEILING;
    state.vy = Math.min(state.vy, 0);
  }

  ensurePoints(state, Math.floor((state.x + LOOKAHEAD) / SEG_DX) + 1);
  ensureOrbs(state, state.x + LOOKAHEAD);

  stepRug(state, dt, events);
  stepOrbs(state, events);

  // The chart is the ground. Touch it and the run is over.
  const ground = terrainHeightAt(state, state.x);
  const gap = state.y - PLAYER_R - ground;
  state.closeCd -= dt;
  if (gap <= 0) {
    state.crashed = true;
    state.y = ground + PLAYER_R;
    events.push({ type: 'crash', x: state.x, y: state.y });
  } else if (
    gap < CLOSE_DIST &&
    state.vy < 90 &&
    state.closeCd <= 0 &&
    state.time > 1.5
  ) {
    state.bonusScore += Math.round(CLOSE_BONUS * state.payoutFactor);
    state.closeCd = CLOSE_COOLDOWN;
    events.push({ type: 'closecall', gap });
  }

  // Prune orbs far behind so long runs stay lean.
  if (state.orbs.length > 220) {
    state.orbs = state.orbs.filter((o) => o.x > state.x - 260);
  }

  state.score =
    Math.floor((state.x * state.payoutFactor) / SCORE_PER_UNIT) +
    state.orbScore + state.bonusScore;
  return events;
}

function stepRug(state, dt, events) {
  if (!state.rugsEnabled && state.rugPhase === 'idle') return;
  if (state.rugPhase === 'idle') {
    state.nextRugIn -= dt;
    if (state.nextRugIn <= 0) {
      state.rugPhase = 'warning';
      state.rugT = RUG_WARN_TIME;
      events.push({ type: 'rugwarning' });
    }
  } else if (state.rugPhase === 'warning') {
    state.rugT -= dt;
    if (state.rugT <= 0) {
      // The cliff lands just ahead of the rocket, so you watch the chart
      // fall out from under the run — and then bounce back up at you.
      const cliff = {
        x: state.x + state.speed * 0.55 + 130,
        depth: 118 + state.rng() * 78,
      };
      state.cliffs.push(cliff);
      state.rugPhase = 'active';
      state.rugT = RUG_ACTIVE_TIME;
      events.push({ type: 'rugdrop', depth: cliff.depth });
    }
  } else if (state.rugPhase === 'active') {
    state.rugT -= dt;
    if (state.rugT <= 0) {
      state.rugPhase = 'idle';
      state.nextRugIn = 15 + state.rng() * 13;
      state.bonusScore += Math.round(RUG_BONUS * state.payoutFactor);
      events.push({ type: 'rugsurvived' });
    }
  }
}

function stepOrbs(state, events) {
  for (const orb of state.orbs) {
    if (orb.collected || orb.missed) continue;
    const dx = orb.x - state.x;
    if (dx < -ORB_MISS_DX) {
      orb.missed = true;
      if (state.combo > 0) {
        state.combo = 0;
        state.multiplier = 1;
        events.push({ type: 'comboLost' });
      }
      continue;
    }
    if (
      Math.abs(dx) < ORB_COLLECT_DX &&
      Math.abs(orb.y - state.y) < ORB_COLLECT_DY
    ) {
      orb.collected = true;
      state.combo += 1;
      state.multiplier = Math.min(
        COMBO_CAP,
        1 + (state.combo - 1) * COMBO_STEP,
      );
      const points = Math.round(ORB_BASE * state.multiplier * state.payoutFactor);
      state.orbScore += points;
      state.orbsCollected += 1;
      events.push({
        type: 'orb',
        points,
        combo: state.combo,
        multiplier: state.multiplier,
        x: orb.x,
        y: orb.y,
      });
    }
  }
}
