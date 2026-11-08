// recap.js — the post-run PnL card data: a pure, DOM-free recorder that
// turns one run of Pump Rider into a run summary (stats, a score-over-
// time sample series, chart markers), plus the shareable "PnL card"
// model the game-over screen renders, and the verdict that grades the
// run against the player's previous one.
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
export const MAX_SAMPLES = 720;
export const SAMPLE_EVERY = 0.25; // seconds between chart samples
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

// The money a finished run made: the multiple is the score in
// hundreds, payout and pnl in dollars, rounded to the cent so the
// card's arithmetic adds up exactly as printed.
export function moneyFor(score, stake) {
  const multiple = score / 100;
  const payout = Math.round(stake * multiple * 100) / 100;
  const pnl = Math.round((payout - stake) * 100) / 100;
  return { multiple, payout, pnl };
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

export function createRunRecorder() {
  const events = []; // { t, kind, text, tone, score } — tone: plain|good|bad|gold
  let samples = []; // { t, score } — the run's score, sampled for the chart
  let sampleEvery = SAMPLE_EVERY;
  let lastSampleT = -Infinity;
  let preset = '';
  let stake = DEFAULT_STAKE;
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
    // chart sample at the origin. The stake the player picked rides
    // along so the finished summary can settle the bag.
    begin(presetLabel, stakeAmount) {
      preset = presetLabel;
      stake = sanitizeStake(stakeAmount);
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

// Grades a finished run. Green ("closed green") when the run set a new
// best or beat the previous run's score; red when it did neither;
// 'flat' for the very first run on the books (nothing to grade
// against — a first run that also sets the best arrives as green via
// isNewBest before it ever gets here).
export function verdictFor(summary, prev, isNewBest) {
  const deltaVsPrev = prev ? summary.score - prev.score : null;
  if (isNewBest) {
    return { tone: 'green', label: 'CLOSED GREEN · NEW BEST', deltaVsPrev };
  }
  if (prev && deltaVsPrev > 0) {
    return { tone: 'green', label: `CLOSED GREEN · +${deltaVsPrev} vs last run`, deltaVsPrev };
  }
  if (!prev) {
    return { tone: 'flat', label: 'FIRST TRADE ON THE BOOKS', deltaVsPrev: null };
  }
  return { tone: 'red', label: `CLOSED RED · ${deltaVsPrev} vs last run`, deltaVsPrev };
}

// Signed percent of `score` against the previous run's score, or null
// when there is nothing meaningful to divide by (no previous run, or a
// previous run that scored zero — the card then falls back to the
// absolute delta, which verdictFor already carries).
export function gainPctFor(score, prev) {
  if (!prev || !(prev.score > 0)) return null;
  return ((score - prev.score) / prev.score) * 100;
}

function fmtGainPct(pct) {
  return `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
}

function fmtMultiplier(m) {
  return `x${Number.isInteger(m) ? m.toFixed(0) : m}`;
}

// The share text, in the player's voice: all lowercase, no dash
// punctuation. It opens with the stake settlement (the bag the run
// turned), then the close, then the stats; the closing line follows
// the verdict.
function shareTextFor(summary, verdict, isNewBest) {
  const closer = isNewBest
    ? 'new best. wagmi.'
    : verdict.tone === 'green'
      ? 'the pump was near.'
      : verdict.tone === 'red'
        ? 'the line won this one. running it back.'
        : 'first trade on the books.';
  const orbBit = summary.orbs === 1 ? '1 orb clipped' : `${summary.orbs} orbs clipped`;
  const stake = sanitizeStake(summary.stake);
  const money = moneyFor(summary.score, stake);
  return (
    `turned ${fmtMoney(stake)} into ${fmtMoney(money.payout)} on pump rider, ${fmtBagMultiple(money.multiple)}. ` +
    `closed +${summary.score} pts. ` +
    `${summary.duration.toFixed(1)}s in trade, ${orbBit}, ` +
    `best combo ${fmtMultiplier(summary.bestMultiplier)}. ${closer}`
  );
}

// Everything the PnL card renders, derived from one finished run.
// Pure: the DOM card and the PNG painter both draw from this model, so
// the downloaded card can never disagree with the screen.
export function buildCardData(summary, prev, isNewBest) {
  const verdict = verdictFor(summary, prev, isNewBest);
  const gainPct = gainPctFor(summary.score, prev);
  const gainText = !prev
    ? 'FIRST TRADE'
    : gainPct !== null
      ? fmtGainPct(gainPct)
      : `${verdict.deltaVsPrev >= 0 ? '+' : ''}${verdict.deltaVsPrev} pts vs last`;
  // The stake settlement: independent of the verdict (which grades
  // against the previous run), this grades the run against the bag
  // that rode on it. A summary with no stake recorded — a run from
  // before the stake card existed — settles at the default stake.
  const stake = sanitizeStake(summary.stake);
  const money = moneyFor(summary.score, stake);
  const moneyTone = money.pnl > 0 ? 'green' : money.pnl < 0 ? 'red' : 'flat';
  const moneyText = `IN ${fmtMoney(stake)} → OUT ${fmtMoney(money.payout)} · ${fmtSignedMoney(money.pnl)}`;
  const footer = FOOTER_PUNS[
    Math.abs(summary.score * 7 + summary.orbs * 13 + Math.floor(summary.duration)) % FOOTER_PUNS.length
  ];
  return {
    preset: String(summary.preset || '').toUpperCase(),
    score: summary.score,
    heroText: `+${summary.score}`,
    tone: verdict.tone,
    verdictLabel: verdict.label,
    isNewBest,
    timeInTrade: summary.duration,
    timeText: `${summary.duration.toFixed(1)}s`,
    gainPct,
    gainText,
    bestMultiplier: summary.bestMultiplier,
    multText: fmtMultiplier(summary.bestMultiplier),
    stake,
    multiple: money.multiple,
    bagMultText: fmtBagMultiple(money.multiple),
    payout: money.payout,
    pnl: money.pnl,
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
    shareText: shareTextFor(summary, verdict, isNewBest),
  };
}

// The chart, normalized to the unit square (x: 0..1 across the run's
// duration, y: 0..1 up to the run's peak score) so any renderer — the
// SVG on the card, the PNG painter — maps it onto its own box. Score
// only ever climbs in this game, so the line always ends at the peak:
// the crash point IS the high, exactly like the reference cards.
export function chartModel(summary) {
  const dur = Math.max(summary.duration, 1e-6);
  const peak = Math.max(summary.peakScore, 1);
  const nx = (t) => Math.min(1, Math.max(0, t / dur));
  const ny = (s) => Math.min(1, Math.max(0, s / peak));
  const at = (t, s) => ({ x: nx(t), y: ny(s) });
  return {
    line: summary.samples.map((s) => at(s.t, s.score)),
    orbs: summary.events.filter((e) => e.kind === 'orb').map((e) => at(e.t, e.score)),
    rugs: summary.events.filter((e) => e.kind === 'rugsurvived').map((e) => at(e.t, e.score)),
    crash: at(summary.duration, summary.score),
    peakScore: summary.peakScore,
    duration: summary.duration,
  };
}
