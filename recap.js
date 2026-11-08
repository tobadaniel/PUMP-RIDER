// recap.js — the post-run PnL card data: a pure, DOM-free recorder that
// turns one run of Pump Rider into a run summary (stats, a score-over-
// time sample series, chart markers), plus the shareable "PnL card"
// model the game-over screen renders, and the settlement that grades
// the run against the target bar the player called before it started.
//
// The app feeds it the engine's own events (see engine.js step()) as
// they happen and ticks it with the live state every frame; every
// number on the card comes straight from the run — orbs counted are
// orbs collected, the "high" is the highest score the run actually
// reached, the duration is the engine clock at the crash, the chart is
// the score the run actually posted, sampled as it climbed. Nothing
// here invents a figure.
//
// The event log is capped (MAX_LOG_EVENTS): the oldest entries are
// dropped first, so a marathon run cannot grow without bound. Samples
// are capped too (MAX_SAMPLES): past the cap the sampling interval
// doubles (decimation), so the series stays small while still ending
// exactly at the crash — finish() always lands the final sample there.

export const MAX_LOG_EVENTS = 200;
export const MAX_SAMPLES = 1440;
export const SAMPLE_EVERY = 0.12; // seconds between chart samples — fine enough that orb steps and rug jumps stay visible as steps in the line
export const LAST_RUN_KEY = 'pump-rider-last-run';

// ------------------------------------------------------------------ stake
// Before a run the player picks a stake from a fixed ladder of dollar
// amounts. The stake turns the score into a bag: every 100 pts is 1x
// on the stake, so payout = stake x score/100 and pnl = payout - stake.
// Pure helpers — the stake card UI in app.js walks this same ladder.
export const STAKE_LADDER = [1, 5, 10, 50, 100, 1000];
export const DEFAULT_STAKE = 10;
export const STAKE_KEY = 'pump-rider-stake';

export function sanitizeStake(v) {
  return STAKE_LADDER.includes(v) ? v : DEFAULT_STAKE;
}
export function stakeIndexOf(amount) {
  return STAKE_LADDER.indexOf(sanitizeStake(amount));
}
export function stepStakeIndex(index, dir) {
  return Math.min(STAKE_LADDER.length - 1, Math.max(0, index + Math.sign(dir)));
}

// ------------------------------------------------------------- currency
// The stake — and everything it settles into — can be denominated in
// dollars or in NEAR. The math never changes (payout = stake x
// multiple in whichever unit is active); only the ladders, the
// stepper steps and the formatting do. The rate is a fixed reference
// (1 NEAR = $3.63, fetched 2026-11-07 for the thesis board): the game
// is fully offline and never pretends the rate is live.
export const NEAR_RATE = 3.63;
export const CURRENCY_KEY = 'pump-rider-currency';
export const NEAR_LADDER = [1, 5, 10, 50, 100, 250];
export const DEFAULT_NEAR_STAKE = 10;

export function sanitizeCurrency(v) {
  return v === 'near' ? 'near' : 'usd';
}
export function sanitizeNearStake(v) {
  if (!Number.isFinite(v)) return DEFAULT_NEAR_STAKE;
  return Math.min(1000, Math.max(0.5, Math.round(v * 100) / 100));
}
// Switching units converts the stake at the reference rate. Into
// NEAR: two decimals under 10 NEAR, whole numbers at or above.
// Into dollars: whole dollars, snapped to the nearest USD ladder
// rung (log-nearest, so the relative distortion is smallest) — the
// USD chips and stepper stay the one source of truth there.
export function usdToNear(usd) {
  const raw = usd / NEAR_RATE;
  return raw < 10 ? Math.round(raw * 100) / 100 : Math.round(raw);
}
export function nearToUsd(near) {
  const raw = Math.round(near * NEAR_RATE);
  let rung = STAKE_LADDER[0];
  let bestDist = Infinity;
  for (const candidate of STAKE_LADDER) {
    const d = Math.abs(Math.log(raw / candidate));
    if (d < bestDist) { bestDist = d; rung = candidate; }
  }
  return rung;
}
// The NEAR stepper: half-NEAR steps under 10, then steps of 5.
export function stepNearStake(v, dir) {
  const cur = sanitizeNearStake(v);
  const step = dir > 0 ? (cur >= 10 ? 5 : 0.5) : (cur > 10 ? 5 : 0.5);
  return sanitizeNearStake(cur + Math.sign(dir) * step);
}
// A NEAR amount as bare grouped digits (the unit is added by
// fmtAmount): integers plain, fractions to two decimals.
export function fmtNear(v) {
  const a = Math.abs(v);
  const fixed = Number.isInteger(a) ? String(a) : a.toFixed(2);
  const [int, dec] = fixed.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${grouped}${dec ? `.${dec}` : ''}`;
}
export function fmtAmount(v, currency) {
  return currency === 'near' ? `${fmtNear(v)} NEAR` : fmtMoney(v);
}
export function fmtSignedAmount(v, currency) {
  if (currency === 'near') {
    if (v > 0) return `+${fmtNear(v)} NEAR`;
    if (v < 0) return `−${fmtNear(v)} NEAR`;
    return '0 NEAR';
  }
  return fmtSignedMoney(v);
}
// The share-text form of an amount, in the player's lowercase voice.
export function fmtUnitLower(v, currency) {
  return currency === 'near' ? `${fmtNear(v)} near` : fmtMoney(v);
}

// The money a finished run made: the multiple is the score in
// hundreds, payout and pnl in dollars, rounded to the cent so the
// card's arithmetic adds up exactly as printed.
export function moneyFor(score, stake) {
  const multiple = score / 100;
  const payout = Math.round(stake * multiple * 100) / 100;
  const pnl = Math.round((payout - stake) * 100) / 100;
  return { multiple, payout, pnl };
}

// ------------------------------------------------------------- the bar
// Before the run the player also calls a target bar: a gain over the
// stake they promise themselves (+50% ... +1900%). The bar is the
// run's real grading: clear it (score >= the points it implies) and
// the bag pays out at the run's multiple; miss it and the whole bag
// is gone, however far the run got. Pure helpers — the stake card UI
// in app.js walks this same ladder.
export const TARGET_LADDER = [50, 100, 200, 400, 900, 1900];
export const DEFAULT_TARGET = 200;
export const TARGET_KEY = 'pump-rider-target';

export function sanitizeTarget(v) {
  return TARGET_LADDER.includes(v) ? v : DEFAULT_TARGET;
}
export function targetIndexOf(pct) {
  return TARGET_LADDER.indexOf(sanitizeTarget(pct));
}
export function stepTargetIndex(index, dir) {
  return Math.min(TARGET_LADDER.length - 1, Math.max(0, index + Math.sign(dir)));
}
// The multiple the bar demands: +200% over the stake means the bag
// must come back 3x, and at 100 pts per 1x that is 300 pts.
export function targetMultiple(pct) {
  return 1 + sanitizeTarget(pct) / 100;
}
export function targetPoints(pct) {
  return 100 * targetMultiple(pct);
}

// Settlement v2: a finished run graded against the called bar.
// Clearing the bar (an exact hit counts) pays stake x multiple;
// missing it pays nothing — the run still happened, the chart still
// shows how far it got, but the bag is lost whole.
export function settleRun(score, stake, targetPct) {
  const multiple = score / 100;
  const barMult = targetMultiple(targetPct);
  const needed = targetPoints(targetPct);
  const win = score >= needed;
  const payout = win ? Math.round(stake * multiple * 100) / 100 : 0;
  const pnl = Math.round((payout - stake) * 100) / 100;
  const gainPct = win ? Math.round((multiple - 1) * 10000) / 100 : -100;
  return { multiple, barMult, needed, win, payout, pnl, gainPct };
}

// "$1,000" for whole dollars, "$10.81" when there are cents, always
// with thousands separators.
export function fmtMoney(v) {
  const a = Math.abs(v);
  const fixed = Number.isInteger(a) ? String(a) : a.toFixed(2);
  const [int, dec] = fixed.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `$${grouped}${dec ? `.${dec}` : ''}`;
}

// Signed money for the card strip: +$592 up, −$29 down (a real minus
// sign, U+2212, never a hyphen), plain $0 at break-even.
export function fmtSignedMoney(v) {
  if (v > 0) return `+${fmtMoney(v)}`;
  if (v < 0) return `−${fmtMoney(v)}`;
  return fmtMoney(0);
}

function fmtBagMultiple(m) {
  return `${parseFloat(m.toFixed(2))}x`;
}

// Footer lines for the PnL card — our own pun set, rotated per run.
export const FOOTER_PUNS = [
  'the pump was NEAR.',
  'not financial advice. just vibes and gravity.',
  'one button. infinite rugs.',
  'gravity is the only dev you can trust.',
];

// Seconds -> "m:ss.d" trade-clock format for chart timestamps.
export function formatClock(t) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

// The stored last run keeps its score curve so the next card can
// draw it as the quiet sub-line under the new run's own line. Stored
// samples are decimated to at most this many points: the shape of
// the run survives, the storage record stays small.
export const PREV_SAMPLES_MAX = 240;
export function decimateSamples(samples, maxPoints = PREV_SAMPLES_MAX) {
  if (!Array.isArray(samples)) return [];
  if (samples.length <= maxPoints) return samples.slice();
  const step = Math.ceil(samples.length / maxPoints);
  const out = [];
  for (let i = 0; i < samples.length; i += step) out.push(samples[i]);
  const last = samples[samples.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

export function createRunRecorder() {
  const events = []; // { t, kind, text, tone, score } — tone: plain|good|bad|gold
  let samples = []; // { t, score } — the run's score, sampled for the chart
  let sampleEvery = SAMPLE_EVERY;
  let lastSampleT = -Infinity;
  let preset = '';
  let stake = DEFAULT_STAKE;
  let target = DEFAULT_TARGET;
  let currency = 'usd';
  let orbs = 0;
  let closeCalls = 0;
  let rugsSurvived = 0;
  let bestCombo = 0;
  let bestMultiplier = 1;
  let peakScore = 0;

  function push(t, kind, text, tone = 'plain', score = 0) {
    events.push({ t, kind, text, tone, score });
    if (events.length > MAX_LOG_EVENTS) {
      events.splice(0, events.length - MAX_LOG_EVENTS);
    }
  }

  function sample(t, score) {
    samples.push({ t, score });
    lastSampleT = t;
    if (samples.length > MAX_SAMPLES) {
      // Decimate: keep every other point and sample half as often from
      // here on. The shape of the run survives; the array stays lean.
      samples = samples.filter((_, i) => i % 2 === 0);
      sampleEvery *= 2;
    }
  }

  return {
    events,
    get samples() { return samples; },

    // The run starts: the ape-in entry, stamped at t=0, and the first
    // chart sample at the origin. The stake, the called bar and the
    // currency they are denominated in ride along so the finished
    // summary can settle the bag against them.
    begin(presetLabel, stakeAmount, targetPct, stakeCurrency) {
      preset = presetLabel;
      currency = sanitizeCurrency(stakeCurrency);
      stake = currency === 'near' ? sanitizeNearStake(stakeAmount) : sanitizeStake(stakeAmount);
      target = sanitizeTarget(targetPct);
      push(0, 'start', `aped in · ${presetLabel}. one button, no mercy.`, 'plain', 0);
      sample(0, 0);
    },

    // Called by the app every frame of a live run: keeps the peak
    // honest and lays down a chart sample every SAMPLE_EVERY seconds.
    tick(state) {
      peakScore = Math.max(peakScore, state.score);
      if (state.time - lastSampleT >= sampleEvery) sample(state.time, state.score);
    },

    // The stored best fell mid-run (the app spots the crossing, since
    // it owns the stored record; the recorder just writes it down).
    noteNewBest(t, score) {
      push(t, 'newbest', `NEW BEST ${score}. wagmi.`, 'gold', score);
    },

    // One engine event, with the live state for its timestamp/score.
    // 'crash' is ignored here: finish() writes the exit line.
    observe(ev, state) {
      peakScore = Math.max(peakScore, state.score);
      switch (ev.type) {
        case 'orb':
          orbs += 1;
          bestCombo = Math.max(bestCombo, ev.combo);
          bestMultiplier = Math.max(bestMultiplier, ev.multiplier);
          push(
            state.time, 'orb',
            `orb clipped +${ev.points}${ev.multiplier > 1 ? ` · combo x${ev.multiplier}` : ''}`,
            'good', state.score,
          );
          break;
        case 'closecall':
          closeCalls += 1;
          push(state.time, 'closecall', 'that was NEAR! +15', 'good', state.score);
          break;
        case 'comboLost':
          push(state.time, 'comboLost', 'combo fumbled. reset to x1.', 'plain', state.score);
          break;
        case 'rugwarning':
          push(state.time, 'rugwarning', 'RUG PULL INBOUND', 'bad', state.score);
          break;
        case 'rugdrop':
          push(state.time, 'rugdrop', 'rug pulled. the floor just left.', 'bad', state.score);
          break;
        case 'rugsurvived':
          rugsSurvived += 1;
          push(state.time, 'rugsurvived', 'not today ser +150', 'good', state.score);
          break;
        default:
          break; // crash (see finish) and anything unknown: no entry
      }
    },

    // The run is over: append the exit line, land the final chart
    // sample exactly on the crash, and freeze the summary. The crash
    // is the only way a run ends, and kissing the line is its only
    // cause — so the exit line can say so honestly.
    finish(state) {
      peakScore = Math.max(peakScore, state.score);
      const last = samples[samples.length - 1];
      if (!last || last.t !== state.time || last.score !== state.score) {
        samples.push({ t: state.time, score: state.score });
      }
      push(state.time, 'crash', `position closed · kissed the line at ${state.score}.`, 'bad', state.score);
      return {
        preset,
        stake,
        target,
        currency,
        score: state.score,
        peakScore,
        orbs,
        closeCalls,
        rugsSurvived,
        bestCombo,
        bestMultiplier,
        duration: state.time,
        events,
        samples,
      };
    },
  };
}

// Signed percent of `score` against the previous run's score, or null
// when there is nothing meaningful to divide by (no previous run, or a
// previous run that scored zero — the vs-last-run note then falls
// back to the absolute points delta).
export function gainPctFor(score, prev) {
  if (!prev || !(prev.score > 0)) return null;
  return ((score - prev.score) / prev.score) * 100;
}

function fmtGainPct(pct) {
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

// The quiet line under the money strip: how this run compares to the
// previous one. Demoted, not deleted — the bar verdict owns the card
// now, this is just the footnote. Losses carry a real minus sign.
function vsPrevNote(summary, prev, isNewBest) {
  let base;
  if (!prev) {
    base = 'first trade';
  } else {
    const pct = gainPctFor(summary.score, prev);
    if (pct !== null) {
      base = `${fmtGainPct(pct).replace('-', '−')} vs last run`;
    } else {
      const d = summary.score - prev.score;
      base = `${d > 0 ? '+' : d < 0 ? '−' : ''}${Math.abs(d)} pts vs last run`;
    }
  }
  return isNewBest ? `${base} · new best` : base;
}

function fmtMultiplier(m) {
  return `x${Number.isInteger(m) ? m.toFixed(0) : m}`;
}

// The share text, in the player's voice: all lowercase, no dash
// punctuation. It opens with the call and the settlement — the bar
// the player picked, the multiple they actually hit, and what the
// bag did — then the close, then the stats.
function shareTextFor(summary, settle, isNewBest) {
  const closer = isNewBest
    ? 'new best. wagmi.'
    : settle.win
      ? 'the pump was near.'
      : 'the line won this one. running it back.';
  const orbBit = summary.orbs === 1 ? '1 orb clipped' : `${summary.orbs} orbs clipped`;
  const currency = sanitizeCurrency(summary.currency);
  const stake = currency === 'near' ? sanitizeNearStake(summary.stake) : sanitizeStake(summary.stake);
  const head = settle.win
    ? `called ${fmtBagMultiple(settle.barMult)} on pump rider, hit ${fmtBagMultiple(settle.multiple)}. ` +
      `turned ${fmtUnitLower(stake, currency)} into ${fmtUnitLower(settle.payout, currency)}. `
    : `called ${fmtBagMultiple(settle.barMult)} on pump rider, hit ${fmtBagMultiple(settle.multiple)}. ` +
      `lost the ${fmtUnitLower(stake, currency)} bag. `;
  return (
    head +
    `closed +${summary.score} pts. ` +
    `${summary.duration.toFixed(1)}s in trade, ${orbBit}, ` +
    `best combo ${fmtMultiplier(summary.bestMultiplier)}. ${closer}`
  );
}

// Game-over headlines: one short line each, small type, never wraps.
// The crash set mourns a missed bar; the WIN set celebrates a cleared
// one. A new best outranks both. The pick lives here — in the shared
// card model — so the screen card, the PNG painter and the tests all
// read the same headline for the same run, rotated deterministically
// from the run's own numbers (the same hash family as the footer).
export const NEW_BEST_LINE = 'new best. wagmi.';
export const WIN_LINES = ['called it. bag paid.', 'bar cleared. printed.', 'read the chart. ate.', 'the bar blinked first.'];
export const OVER_LINES = ['kissed the line.', 'down bad.', 'rugged.', 'not NEAR enough.'];
export function pickOverHeadline(isBest, win, seed = 0) {
  if (isBest) return NEW_BEST_LINE;
  const lines = win ? WIN_LINES : OVER_LINES;
  return lines[Math.abs(Math.floor(seed)) % lines.length];
}

// Everything the PnL card renders, derived from one finished run.
// Pure: the DOM card and the PNG painter both draw from this model, so
// the downloaded card can never disagree with the screen.
//
// The card's identity is the money truth: the run graded against the
// bar it called. Win and the card glows green with green majors; miss
// the bar and it glows red — even if the run outscored the previous
// one, because a missed bar means the bag is gone. The comparison to
// the previous run survives only as the quiet note under the strip.
export function buildCardData(summary, prev, isNewBest) {
  // A summary with no stake or bar recorded — a run from before the
  // bar existed — settles at the default stake and the default bar.
  // The currency defaults to dollars for the same reason.
  const currency = sanitizeCurrency(summary.currency);
  const stake = currency === 'near' ? sanitizeNearStake(summary.stake) : sanitizeStake(summary.stake);
  const target = sanitizeTarget(summary.target);
  const settle = settleRun(summary.score, stake, target);
  const win = settle.win;
  const verdictLabel = win
    ? `BAR CLEARED · ${fmtBagMultiple(settle.multiple)} vs ${fmtBagMultiple(settle.barMult)} bar`
    : `MISSED THE BAR · ${fmtBagMultiple(settle.multiple)} of ${fmtBagMultiple(settle.barMult)}`;
  const gainText = win ? fmtGainPct(settle.gainPct) : '−100%';
  const moneyTone = settle.pnl > 0 ? 'green' : settle.pnl < 0 ? 'red' : 'flat';
  // The strip speaks the active unit. In NEAR it also carries the
  // dollar equivalent of the pnl alone — appended only when the whole
  // line still fits the strip in both renderers.
  let moneyText;
  if (currency === 'near') {
    const base =
      `IN ${fmtAmount(stake, currency)} → OUT ${fmtAmount(settle.payout, currency)} · ${fmtSignedAmount(settle.pnl, currency)}`;
    moneyText = base;
    if (settle.pnl !== 0) {
      const eq = Math.sign(settle.pnl) * Math.round(Math.abs(settle.pnl * NEAR_RATE));
      const withEq = `${base} · ≈ ${fmtSignedMoney(eq)}`;
      if (withEq.length <= 58) moneyText = withEq;
    }
  } else {
    moneyText = `IN ${fmtMoney(stake)} → OUT ${fmtMoney(settle.payout)} · ${fmtSignedMoney(settle.pnl)}`;
  }
  const footer = FOOTER_PUNS[
    Math.abs(summary.score * 7 + summary.orbs * 13 + Math.floor(summary.duration)) % FOOTER_PUNS.length
  ];
  return {
    preset: String(summary.preset || '').toUpperCase(),
    headline: pickOverHeadline(isNewBest, win, summary.score * 7 + summary.orbs * 13 + Math.floor(summary.duration)),
    score: summary.score,
    heroText: `+${summary.score}`,
    win,
    outcome: win ? 'win' : 'loss',
    tone: win ? 'green' : 'red',
    verdictLabel,
    isNewBest,
    timeInTrade: summary.duration,
    timeText: `${summary.duration.toFixed(1)}s`,
    gainPct: settle.gainPct,
    gainText,
    vsPrevText: vsPrevNote(summary, prev, isNewBest),
    bestMultiplier: summary.bestMultiplier,
    multText: fmtMultiplier(summary.bestMultiplier),
    currency,
    stake,
    target,
    barMult: settle.barMult,
    barMultText: fmtBagMultiple(settle.barMult),
    needed: settle.needed,
    multiple: settle.multiple,
    bagMultText: fmtBagMultiple(settle.multiple),
    payout: settle.payout,
    pnl: settle.pnl,
    moneyTone,
    moneyText,
    tiles: [
      { key: 'combo', label: 'BEST COMBO', value: fmtMultiplier(summary.bestMultiplier) },
      { key: 'orbs', label: 'ORBS', value: String(summary.orbs) },
      { key: 'near', label: 'NEAR CALLS', value: String(summary.closeCalls) },
      { key: 'rugs', label: 'RUGS SURVIVED', value: String(summary.rugsSurvived) },
    ],
    peakScore: summary.peakScore,
    footer,
    shareText: shareTextFor(summary, settle, isNewBest),
  };
}

// The chart, normalized to the unit square so any renderer — the SVG
// on the card, the PNG painter — maps it onto its own box. TWO runs
// share the frame on ONE common scale: the current run (the major
// line) and the previous run (the quiet sub-line), so neither curve
// is ever stretched to fill the box on its own. Both normalize
// against the greater peak and the longer duration of the two, and
// the scale also makes room for the called bar (needed pts), so the
// dashed target line always sits inside the frame and a miss visibly
// dies below it. Score only ever climbs in this game, so each line
// ends at its own peak: a run's crash point IS its high.
export function chartModel(summary, prev = null) {
  const needed = targetPoints(summary.target);
  const prevSamples = prev && Array.isArray(prev.samples) && prev.samples.length >= 2
    ? prev.samples
    : null;
  const prevPeak = prevSamples
    ? Math.max(prev.peakScore || 0, prevSamples[prevSamples.length - 1].score)
    : 0;
  const peak = Math.max(summary.peakScore, prevPeak, needed, 1);
  const dur = Math.max(summary.duration, prevSamples ? (prev.duration || 0) : 0, 1e-6);
  const nx = (t) => Math.min(1, Math.max(0, t / dur));
  const ny = (s) => Math.min(1, Math.max(0, s / peak));
  const at = (t, s) => ({ x: nx(t), y: ny(s) });
  return {
    line: summary.samples.map((s) => at(s.t, s.score)),
    prevLine: prevSamples ? prevSamples.map((s) => at(s.t, s.score)) : [],
    hasPrev: !!prevSamples,
    orbs: summary.events.filter((e) => e.kind === 'orb').map((e) => at(e.t, e.score)),
    rugs: summary.events.filter((e) => e.kind === 'rugsurvived').map((e) => at(e.t, e.score)),
    crash: at(summary.duration, summary.score),
    peakScore: summary.peakScore,
    duration: summary.duration,
    peakY: ny(summary.peakScore),
    targetY: ny(needed),
    needed,
  };
}
