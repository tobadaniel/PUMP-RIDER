// app.js — the Pump Rider UI. All rules live in engine.js; this file
// renders state to a canvas, forwards the one button, plays tiny synth
// sounds, and owns the theme system.
//
// Themes: CSS variables under [data-theme] dress the page; the canvas
// reads the matching palette from THEMES below. Resolution order:
// ?theme= in the URL, then localStorage, then prefers-color-scheme.
// The toggle button flips and persists. ?seed= pins the terrain seed
// (demos, screenshots, shared runs); ?play=1 hides the start card over
// the frozen menu scene.

import {
  createGame, step, terrainHeightAt, PRESETS,
  WORLD_H, PLAYER_R, BASE_SPEED, MAX_SPEED,
} from './engine.js';
import {
  createRunRecorder, buildCardData, chartModel, LAST_RUN_KEY,
  STAKE_LADDER, STAKE_KEY, stakeIndexOf, stepStakeIndex, fmtMoney,
} from './recap.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);

// ---------------------------------------------------------------- themes
const THEMES = {
  dark: {
    sky: ['#000000', '#000000', '#000000'],
    grid: 'rgba(255,255,255,0.08)',
    candleUp: 'rgba(0,255,163,0.10)',
    candleDown: 'rgba(255,61,138,0.11)',
    speckle: 'rgba(255,255,255,0.55)',
    chart: '#00ffa3',
    chartHi: '#8dffd9',
    fillTop: 'rgba(0,255,163,0.30)',
    fillBot: 'rgba(0,255,163,0.02)',
    glow: 'rgba(0,255,163,0.55)',
    cliff: '#ff5252',
    orb: '#ffd23d',
    orbCore: '#fff3b0',
    orbInk: '#6b4e00',
    body: '#f5f7ff',
    fin: '#ff3d8a',
    win: '#45d0ff',
    flameO: '#ff9a3d',
    flameY: '#ffd23d',
    floaterStroke: 'rgba(0,0,0,0.75)',
  },
  light: {
    sky: ['#fff9ec', '#fdeed3', '#fbe0ac'],
    grid: 'rgba(22,33,60,0.10)',
    candleUp: 'rgba(0,150,90,0.13)',
    candleDown: 'rgba(224,36,115,0.13)',
    speckle: 'rgba(146,110,40,0.35)',
    chart: '#009e60',
    chartHi: '#00c978',
    fillTop: 'rgba(0,158,96,0.26)',
    fillBot: 'rgba(0,158,96,0.03)',
    glow: 'rgba(0,158,96,0.35)',
    cliff: '#d92b2b',
    orb: '#f59e0b',
    orbCore: '#ffe066',
    orbInk: '#6b4e00',
    body: '#ffffff',
    fin: '#e02473',
    win: '#0e7fd8',
    flameO: '#ff8a2a',
    flameY: '#ffc93d',
    floaterStroke: 'rgba(255,250,240,0.85)',
  },
};

const THEME_KEY = 'pump-rider-theme';
const BEST_KEY = 'pump-rider-best';
const MUTE_KEY = 'pump-rider-muted';

function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { return null; }
}

function resolveTheme() {
  const q = params.get('theme');
  if (q === 'dark' || q === 'light') return q;
  const saved = store(THEME_KEY);
  if (saved === 'dark' || saved === 'light') return saved;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches
    ? 'light'
    : 'dark';
}

let themeName = resolveTheme();
function applyTheme() {
  document.documentElement.dataset.theme = themeName;
  $('btn-theme').textContent = `Theme: ${themeName}`;
}
function toggleTheme() {
  themeName = themeName === 'dark' ? 'light' : 'dark';
  store(THEME_KEY, themeName);
  applyTheme();
}

// ---------------------------------------------------------------- settings
// Difficulty: preset chips (Chill / Classic / Degen) + Speed / Pump /
// Gravity sliders. Values are multipliers handed to the engine at run
// start (engine PRESETS are the single source of truth for the chips).
// The shipped feel was too quick, so the default preset is Chill.
// Moving any slider flips the preset to Custom. All of it persists.
const SETTINGS_KEY = 'pump-rider-settings';
const SLIDER_KEYS = ['speed', 'pump', 'gravity'];
const SLIDER_RANGES = { speed: [0.5, 1.5], pump: [0.5, 1.8], gravity: [0.5, 1.8] };

function presetSettings(name) {
  const p = PRESETS[name];
  return { speed: p.speedScale, pump: p.thrust, gravity: p.gravity };
}
function clampSetting(key, v) {
  const [lo, hi] = SLIDER_RANGES[key];
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null;
}
function loadSettings() {
  const fallback = { preset: 'chill', ...presetSettings('chill') };
  try {
    const raw = store(SETTINGS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    const out = { preset: 'custom' };
    for (const key of SLIDER_KEYS) {
      const v = clampSetting(key, Number(parsed[key]));
      if (v === null) return fallback;
      out[key] = v;
    }
    if (parsed.preset && PRESETS[parsed.preset]) {
      const p = presetSettings(parsed.preset);
      if (SLIDER_KEYS.every((k) => Math.abs(p[k] - out[k]) < 1e-9)) out.preset = parsed.preset;
    }
    return out;
  } catch { return fallback; }
}

let settings = loadSettings();
function persistSettings() { store(SETTINGS_KEY, JSON.stringify(settings)); }
function engineSettings() {
  return { speedScale: settings.speed, thrust: settings.pump, gravity: settings.gravity };
}
function presetLabel() {
  return settings.preset === 'custom'
    ? 'Custom'
    : settings.preset[0].toUpperCase() + settings.preset.slice(1);
}
function syncSettingsUI() {
  const label = presetLabel();
  document.querySelectorAll('.settings-panel').forEach((panel) => {
    panel.querySelector('.preset-name').textContent = label;
    panel.querySelectorAll('.chip').forEach((chip) => {
      chip.classList.toggle('active', chip.dataset.preset === settings.preset);
    });
    panel.querySelectorAll('.js-slider').forEach((input) => {
      input.value = settings[input.dataset.setting];
    });
    panel.querySelectorAll('.slider-val').forEach((el) => {
      el.textContent = `${settings[el.dataset.val].toFixed(2)}x`;
    });
  });
}
function applyPreset(name) {
  settings = { preset: name, ...presetSettings(name) };
  persistSettings();
  syncSettingsUI();
}
function wireSettings() {
  document.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => applyPreset(chip.dataset.preset));
  });
  document.querySelectorAll('.js-slider').forEach((input) => {
    input.addEventListener('input', () => {
      settings[input.dataset.setting] = clampSetting(input.dataset.setting, parseFloat(input.value));
      settings.preset = 'custom';
      persistSettings();
      syncSettingsUI();
    });
  });
  syncSettingsUI();
}

// ---------------------------------------------------------------- stake
// The pre-game stake: a fixed ladder of dollar amounts, picked on the
// stake card between the start card and the run. The choice persists
// across sessions; the run's PnL card settles it (every 100 pts is 1x
// on the bag — the money math lives in recap.js with the card model).
let stakeIndex = stakeIndexOf(Number(store(STAKE_KEY)));
function currentStake() { return STAKE_LADDER[stakeIndex]; }
function setStakeIndex(i) {
  stakeIndex = Math.min(STAKE_LADDER.length - 1, Math.max(0, i));
  store(STAKE_KEY, String(currentStake()));
  syncStakeUI();
}
function syncStakeUI() {
  const stake = currentStake();
  $('stake-amount').textContent = fmtMoney(stake);
  document.querySelectorAll('.stake-chip').forEach((chip) => {
    chip.classList.toggle('active', Number(chip.dataset.stake) === stake);
  });
  $('btn-stake-minus').disabled = stakeIndex === 0;
  $('btn-stake-plus').disabled = stakeIndex === STAKE_LADDER.length - 1;
  $('btn-ape').textContent = `APE IN ${fmtMoney(stake)}`;
}
function wireStake() {
  document.querySelectorAll('.stake-chip').forEach((chip) => {
    chip.addEventListener('click', () => setStakeIndex(stakeIndexOf(Number(chip.dataset.stake))));
  });
  $('btn-stake-minus').addEventListener('click', () => setStakeIndex(stepStakeIndex(stakeIndex, -1)));
  $('btn-stake-plus').addEventListener('click', () => setStakeIndex(stepStakeIndex(stakeIndex, 1)));
  syncStakeUI();
}

// ---------------------------------------------------------------- audio
// Tiny WebAudio synth. The context is created ONLY inside a user-gesture
// handler (first press), per browser autoplay rules.
let actx = null;
let muted = store(MUTE_KEY) === '1';

function ensureAudio() {
  if (!actx) {
    try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch { actx = null; }
  }
  if (actx && actx.state === 'suspended') actx.resume();
}

// The unlock must ride the FIRST gesture anywhere — a button tap, a key
// press, a touch on the stage — not only presses that land on the game
// surface: browsers only honour a resume issued inside a real gesture,
// so a context created suspended stays silent until one of these fires.
window.addEventListener('pointerdown', ensureAudio);
window.addEventListener('touchstart', ensureAudio, { passive: true });
window.addEventListener('keydown', ensureAudio);

function tone(freq, dur, { type = 'sine', vol = 0.12, slideTo = null, delay = 0 } = {}) {
  if (muted || !actx) return;
  if (actx.state === 'suspended') actx.resume(); // a play attempt is also a chance to unlock
  const t0 = actx.currentTime + delay;
  const o = actx.createOscillator();
  const g = actx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t0);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(30, slideTo), t0 + dur);
  g.gain.setValueAtTime(vol, t0);
  g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  o.connect(g); g.connect(actx.destination);
  o.start(t0); o.stop(t0 + dur + 0.03);
}

function noiseBurst(dur = 0.35, vol = 0.22) {
  if (muted || !actx) return;
  if (actx.state === 'suspended') actx.resume(); // a play attempt is also a chance to unlock
  const n = Math.floor(actx.sampleRate * dur);
  const buf = actx.createBuffer(1, n, actx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = actx.createBufferSource(); src.buffer = buf;
  const f = actx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900;
  const g = actx.createGain(); g.gain.value = vol;
  src.connect(f); f.connect(g); g.connect(actx.destination);
  src.start();
}

const sfx = {
  orb(combo) { tone(540 + combo * 45, 0.09, { type: 'square', vol: 0.05 }); tone(1080 + combo * 90, 0.08, { vol: 0.07, delay: 0.02 }); },
  closecall() { tone(280, 0.13, { type: 'sawtooth', vol: 0.045, slideTo: 640 }); },
  warn() { tone(880, 0.09, { type: 'square', vol: 0.06 }); tone(880, 0.09, { type: 'square', vol: 0.06, delay: 0.16 }); },
  drop() { tone(720, 0.5, { type: 'sawtooth', vol: 0.07, slideTo: 55 }); },
  survived() { tone(523, 0.1, { vol: 0.08 }); tone(784, 0.16, { vol: 0.08, delay: 0.09 }); },
  comboLost() { tone(320, 0.14, { type: 'triangle', vol: 0.06, slideTo: 170 }); },
  crash() { noiseBurst(); tone(130, 0.4, { vol: 0.22, slideTo: 38 }); },
};

// ---------------------------------------------------------------- state
const canvas = $('game');
const ctx = canvas.getContext('2d');
const seedParam = params.get('seed');

let G = null; // engine state
let mode = 'demo'; // demo (frozen menu scene) | playing | over
let paused = false;
let thrustHeld = false;
let stakeOpen = false; // the pre-game stake card is showing

// Mirrors the UI state onto <body data-state> for tests and screenshots.
function syncState() {
  document.body.dataset.state = stakeOpen ? 'stake' : mode;
}
let particles = [];
let floaters = [];
let shake = 0;
let crashAt = 0;
let best = Number(store(BEST_KEY) || 0);
let bestBeaten = false; // this run has crossed the stored best
let lastHud = {};
let recorder = null; // PnL recorder for the live run (recap.js)
let lastSummary = null; // the most recent finished run's summary
let lastCard = null; // the most recent finished run's PnL card model

function newRun(seed) {
  G = createGame(seed, { settings: engineSettings() });
  particles = [];
  floaters = [];
  shake = 0;
  bestBeaten = false;
  $('stat-best-box').classList.remove('beaten');
  paused = false;
  $('paused-banner').classList.add('hidden');
  $('rug-banner').classList.add('hidden');
}

function startGame() {
  ensureAudio();
  // Whatever is physically held down at this instant (the Space press
  // that aped in, say) cannot thrust until it is released and pressed
  // again — see the input section. Pointer-started runs snapshot an
  // empty set, because a click only fires after its pointerup, so the
  // player's first real hold of the run just works.
  ignoredPointers = new Set(heldPointers);
  ignoredKeys = new Set(heldKeys);
  newRun(seedParam !== null ? seedParam : (Math.random() * 1e9) | 0);
  recorder = createRunRecorder();
  recorder.begin(presetLabel(), currentStake());
  mode = 'playing';
  $('overlay-start').classList.add('hidden');
  $('overlay-over').classList.add('hidden');
  syncState();
}

// Death headlines: one short line each, small type, never wraps.
const OVER_LINES = ['kissed the line.', 'down bad.', 'rugged.', 'not NEAR enough.'];
function gameOver() {
  mode = 'over';
  syncState();
  crashAt = performance.now();
  const isBest = bestBeaten || G.score > best;
  if (isBest) { best = G.score; store(BEST_KEY, String(best)); }
  $('over-title').textContent = isBest
    ? 'new best. wagmi.'
    : OVER_LINES[(Math.random() * OVER_LINES.length) | 0];
  // PnL card: close the run's books, grade it against the previous
  // run, remember it for next time, and render the card.
  if (recorder) {
    lastSummary = recorder.finish(G);
    const prev = loadLastRun();
    lastCard = buildCardData(lastSummary, prev, isBest);
    store(LAST_RUN_KEY, JSON.stringify({
      score: lastSummary.score,
      orbs: lastSummary.orbs,
      bestCombo: lastSummary.bestCombo,
      duration: lastSummary.duration,
    }));
    renderPnlCard(lastCard, lastSummary);
  }
  setOverSettings(false); // difficulty starts collapsed on this card
  setTimeout(() => {
    if (mode !== 'over') return;
    $('overlay-over').classList.remove('hidden');
  }, 650);
}

// ---------------------------------------------------------------- PnL card
function loadLastRun() {
  try {
    const raw = store(LAST_RUN_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && Number.isFinite(parsed.score) ? parsed : null;
  } catch { return null; }
}

const SVGNS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

// The run's own chart, drawn into the card's SVG: the score climbing
// over time (from chartModel's unit-square points), a dashed line at
// the peak, gold squares where orbs were clipped, a pink flag where a
// rug was survived, and a red X where it ended.
function renderPnlChart(svg, summary, tone) {
  const T = THEMES[themeName];
  // The verdict rides on the line itself: NEAR green up, red down.
  const line = tone === 'green' ? '#00ec97' : tone === 'red' ? T.cliff : T.chart;
  const m = chartModel(summary);
  const W = 320; const H = 110;
  const X0 = 7; const X1 = W - 7; const YT = 11; const YB = H - 6;
  const px = (u) => X0 + u * (X1 - X0);
  const py = (u) => YB - u * (YB - YT);
  svg.textContent = '';
  if (m.line.length < 2) return;
  const pts = m.line.map((p) => `${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`);
  // Dashed peak line, from the start to just short of the crash
  // (score is monotonic, so the peak is the crash point, at the
  // top-right): it stops before the X so the HIGH chip and the
  // marker never fight over the corner.
  if (m.peakScore > 0) {
    svg.append(svgEl('line', {
      x1: X0, y1: py(1), x2: px(m.crash.x) - 12, y2: py(1),
      stroke: line, 'stroke-width': 1, 'stroke-dasharray': '4 4',
      opacity: 0.55, 'vector-effect': 'non-scaling-stroke',
    }));
  }
  svg.append(svgEl('path', {
    d: `M${pts.join(' L')} L${px(m.crash.x).toFixed(1)},${YB} L${X0},${YB} Z`,
    fill: line, 'fill-opacity': 0.16, stroke: 'none',
  }));
  svg.append(svgEl('path', {
    d: `M${pts.join(' L')}`, fill: 'none', stroke: line,
    'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
    'vector-effect': 'non-scaling-stroke',
  }));
  for (const o of m.orbs) {
    svg.append(svgEl('rect', {
      x: px(o.x) - 2.6, y: py(o.y) - 2.6, width: 5.2, height: 5.2, fill: T.orb,
    }));
  }
  for (const r of m.rugs) {
    const cx = px(r.x); const cy = py(r.y);
    svg.append(svgEl('path', {
      d: `M${cx},${cy - 6} L${cx + 4.6},${cy + 3.4} L${cx - 4.6},${cy + 3.4} Z`, fill: T.fin,
    }));
  }
  const cx = px(m.crash.x); const cy = py(m.crash.y);
  svg.append(svgEl('path', {
    d: `M${cx - 4},${cy - 4} L${cx + 4},${cy + 4} M${cx + 4},${cy - 4} L${cx - 4},${cy + 4}`,
    stroke: T.cliff, 'stroke-width': 2.2, 'stroke-linecap': 'round',
    'vector-effect': 'non-scaling-stroke',
  }));
}

function renderPnlCard(card, summary) {
  $('pnl-preset').textContent = card.preset || 'CUSTOM';
  // The hero score is always gold; the verdict is carried by the
  // pill, the gain figure and the chart line, not the score.
  $('pnl-score').textContent = card.heroText;
  const verdict = $('pnl-verdict');
  verdict.textContent = card.verdictLabel;
  verdict.className = `pnl-verdict ${card.tone}`;
  $('pnl-time').textContent = card.timeText;
  const gain = $('pnl-gain');
  gain.textContent = card.gainText;
  gain.className = `pnl-gain ${card.tone}`;
  $('pnl-mult').textContent = `${card.multText} combo`;
  const money = $('pnl-money');
  money.textContent = card.moneyText;
  money.className = `pnl-money ${card.moneyTone}`;
  $('pnl-peak').textContent = `HIGH ${card.peakScore}`;
  for (const tile of card.tiles) {
    $(`pnl-tile-${tile.key}`).textContent = tile.value;
  }
  $('pnl-foot').textContent = card.footer;
  renderPnlChart($('pnl-chart'), summary, card.tone);
}

// ---------------------------------------------------------------- PNG painter
// The Download button's card: the same layout as the on-screen PnL
// card, painted onto a 1080x1080 canvas from the same card model, so
// the file a player shares can never disagree with what they saw.
const PNL_PAINT = {
  dark: { bg: '#000000', panel: '#0d0d0d', ink: '#eef2ff', dim: '#9aa7d9', line: '#232323', green: '#00ffa3', red: '#ff5252', gold: '#ffd23d', pink: '#ff3d8a', chart: '#00ffa3', score: '#ffc837', best: '#00ec97' },
  light: { bg: '#fffdf6', panel: '#fdf3dd', ink: '#16213c', dim: '#5d6a8c', line: '#e3d3ae', green: '#009e60', red: '#d92b2b', gold: '#d97706', pink: '#e02473', chart: '#009e60', score: '#b97e04', best: '#00875a' },
};

function rr(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function renderPnlPng() {
  if (!lastCard || !lastSummary) return null;
  const P = PNL_PAINT[themeName];
  const card = lastCard;
  const toneColor = card.tone === 'green' ? P.best : card.tone === 'red' ? P.red : P.ink;
  const cv = document.createElement('canvas');
  cv.width = 1080; cv.height = 1080;
  const c = cv.getContext('2d');
  c.fillStyle = P.bg;
  c.fillRect(0, 0, 1080, 1080);
  rr(c, 28, 28, 1024, 1024, 36);
  c.strokeStyle = P.line; c.lineWidth = 3; c.stroke();

  // Header: a little rocket + the wordmark, preset on the right.
  c.save();
  c.translate(104, 96);
  c.fillStyle = P.pink;
  c.beginPath(); c.moveTo(-13, -8); c.lineTo(-26, -22); c.lineTo(-7, -15); c.closePath(); c.fill();
  c.beginPath(); c.moveTo(-13, 8); c.lineTo(-26, 22); c.lineTo(-7, 15); c.closePath(); c.fill();
  c.beginPath(); c.ellipse(0, 0, 24, 13, 0, 0, Math.PI * 2);
  c.fillStyle = themeName === 'dark' ? '#f5f7ff' : '#ffffff'; c.fill();
  c.beginPath(); c.arc(8, -2, 6, 0, Math.PI * 2);
  c.fillStyle = '#45d0ff'; c.fill();
  c.restore();
  c.fillStyle = P.ink;
  c.font = '900 46px system-ui, sans-serif';
  c.textBaseline = 'middle';
  c.fillText('PUMP RIDER', 148, 98);
  c.font = '800 34px system-ui, sans-serif';
  c.fillStyle = P.green;
  const presetW = c.measureText(card.preset || 'CUSTOM').width;
  c.fillText(card.preset || 'CUSTOM', 1008 - presetW, 98);

  // Hero score (always gold, like the HUD). The verdict pill gets its
  // OWN line under the hero, left-aligned, exactly as on screen: on
  // the hero's row it ran out of width at 4-digit scores and painted
  // over the PTS.
  c.font = '900 148px system-ui, sans-serif';
  c.fillStyle = P.score;
  c.fillText(card.heroText, 72, 236);
  const heroW = c.measureText(card.heroText).width;
  c.font = '800 50px system-ui, sans-serif';
  c.fillStyle = P.dim;
  c.fillText('PTS', 84 + heroW, 256);
  c.font = '800 27px system-ui, sans-serif';
  const vW = c.measureText(card.verdictLabel).width + 44;
  rr(c, 72, 294, vW, 58, 29);
  c.strokeStyle = toneColor; c.lineWidth = 2.5; c.stroke();
  c.fillStyle = toneColor;
  c.fillText(card.verdictLabel, 94, 324);

  // Sub stats: time in trade (left), gain + best combo (right).
  c.font = '700 25px system-ui, sans-serif';
  c.fillStyle = P.dim;
  c.fillText('TIME IN TRADE', 72, 402);
  const gainLabel = 'GAIN';
  c.fillText(gainLabel, 1008 - c.measureText(gainLabel).width, 402);
  c.font = '800 56px system-ui, sans-serif';
  c.fillStyle = P.ink;
  c.fillText(card.timeText, 72, 452);
  const gainW = c.measureText(card.gainText).width;
  c.fillStyle = toneColor;
  c.fillText(card.gainText, 1008 - gainW, 452);
  c.font = '800 30px system-ui, sans-serif';
  c.fillStyle = P.gold;
  const multText = `${card.multText} BEST COMBO`;
  c.fillText(multText, 1008 - c.measureText(multText).width, 498);

  // The stake settlement strip, same string and tone as on screen:
  // what went in, what came out, and the difference.
  rr(c, 72, 514, 936, 46, 12);
  c.fillStyle = P.panel; c.fill();
  c.strokeStyle = P.line; c.lineWidth = 2; c.stroke();
  c.font = '800 29px system-ui, sans-serif';
  c.fillStyle = card.moneyTone === 'green' ? P.best : card.moneyTone === 'red' ? P.red : P.dim;
  const moneyW = c.measureText(card.moneyText).width;
  c.fillText(card.moneyText, (1080 - moneyW) / 2, 538);

  // The chart of the run itself.
  const bx = 72; const by = 576; const bw = 936; const bh = 172;
  rr(c, bx, by, bw, bh, 18);
  c.fillStyle = P.panel; c.fill();
  c.strokeStyle = P.line; c.lineWidth = 2; c.stroke();
  const m = chartModel(lastSummary);
  const chartColor = card.tone === 'green' ? P.best : card.tone === 'red' ? P.red : P.chart;
  const X0 = bx + 20; const X1 = bx + bw - 20; const YT = by + 22; const YB = by + bh - 18;
  const px = (u) => X0 + u * (X1 - X0);
  const py = (u) => YB - u * (YB - YT);
  if (m.line.length >= 2) {
    c.save();
    rr(c, bx, by, bw, bh, 18);
    c.clip();
    if (m.peakScore > 0) {
      c.beginPath();
      c.setLineDash([10, 9]);
      c.moveTo(X0, py(1)); c.lineTo(px(m.crash.x) - 26, py(1)); // stops short of the crash X
      c.strokeStyle = chartColor; c.lineWidth = 2; c.globalAlpha = 0.55; c.stroke();
      c.setLineDash([]);
      c.globalAlpha = 1;
    }
    c.beginPath();
    m.line.forEach((p, i) => { if (i === 0) c.moveTo(px(p.x), py(p.y)); else c.lineTo(px(p.x), py(p.y)); });
    c.lineTo(px(m.crash.x), YB); c.lineTo(X0, YB); c.closePath();
    c.fillStyle = chartColor; c.globalAlpha = 0.15; c.fill();
    c.globalAlpha = 1;
    c.beginPath();
    m.line.forEach((p, i) => { if (i === 0) c.moveTo(px(p.x), py(p.y)); else c.lineTo(px(p.x), py(p.y)); });
    c.strokeStyle = chartColor; c.lineWidth = 5; c.lineJoin = 'round'; c.lineCap = 'round'; c.stroke();
    c.fillStyle = P.gold;
    for (const o of m.orbs) c.fillRect(px(o.x) - 6, py(o.y) - 6, 12, 12);
    c.fillStyle = P.pink;
    for (const r of m.rugs) {
      c.beginPath();
      c.moveTo(px(r.x), py(r.y) - 13);
      c.lineTo(px(r.x) + 10, py(r.y) + 8);
      c.lineTo(px(r.x) - 10, py(r.y) + 8);
      c.closePath(); c.fill();
    }
    c.beginPath();
    c.moveTo(px(m.crash.x) - 10, py(m.crash.y) - 10); c.lineTo(px(m.crash.x) + 10, py(m.crash.y) + 10);
    c.moveTo(px(m.crash.x) + 10, py(m.crash.y) - 10); c.lineTo(px(m.crash.x) - 10, py(m.crash.y) + 10);
    c.strokeStyle = P.red; c.lineWidth = 6; c.stroke();
    c.restore();
    c.font = '800 25px system-ui, sans-serif';
    c.fillStyle = P.dim;
    const highText = `HIGH ${m.peakScore}`;
    // Ends 30px left of the chart's right edge: the crash X owns the
    // top-right corner and the label must never sit under it.
    c.fillText(highText, X1 - 30 - c.measureText(highText).width, by + 36);
  }

  // Milestone tiles.
  const tileY = 800; const tileH = 118; const gap = 18;
  const tileW = (bw - gap * 3) / 4;
  card.tiles.forEach((tile, i) => {
    const tx = bx + i * (tileW + gap);
    rr(c, tx, tileY, tileW, tileH, 16);
    c.fillStyle = P.panel; c.fill();
    c.strokeStyle = P.line; c.lineWidth = 2; c.stroke();
    c.font = '800 50px system-ui, sans-serif';
    c.fillStyle = P.ink;
    const vw = c.measureText(tile.value).width;
    c.fillText(tile.value, tx + (tileW - vw) / 2, tileY + 48);
    c.font = '700 21px system-ui, sans-serif';
    c.fillStyle = P.dim;
    const lw = c.measureText(tile.label).width;
    c.fillText(tile.label, tx + (tileW - lw) / 2, tileY + 90);
  });

  // Footer pun.
  c.font = '700 31px system-ui, sans-serif';
  c.fillStyle = P.dim;
  const fw = c.measureText(card.footer).width;
  c.fillText(card.footer, (1080 - fw) / 2, 992);

  return cv.toDataURL('image/png');
}

function downloadPnl() {
  const url = renderPnlPng();
  if (!url) return;
  const a = document.createElement('a');
  a.href = url;
  a.download = 'pump-rider-pnl.png';
  document.body.append(a);
  a.click();
  a.remove();
}

function shareOnX() {
  if (!lastCard) return;
  const url = `https://x.com/intent/tweet?text=${encodeURIComponent(lastCard.shareText)}`;
  window.open(url, '_blank', 'noopener');
}

// Difficulty panels are collapsible on BOTH cards and closed by
// default: one row, tapped to open. Expanding the game-over one hides
// the PnL chart via CSS, so the taller card still fits the stage.
function setSettingsPanel(btn, body, open, onToggle) {
  body.classList.toggle('hidden', !open);
  btn.setAttribute('aria-expanded', String(open));
  btn.querySelector('.chev').textContent = open ? '▾' : '▸';
  if (onToggle) onToggle(open);
}
function setOverSettings(open) {
  setSettingsPanel($('btn-over-settings'), $('over-settings-body'), open, (o) => {
    $('overlay-over').querySelector('.card-over').classList.toggle('settings-open', o);
  });
}



// ---------------------------------------------------------------- events
function burst(wx, wy, colors, n = 16, power = 190) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const v = (0.3 + Math.random() * 0.7) * power;
    particles.push({
      wx, wy,
      vx: Math.cos(a) * v, vy: Math.sin(a) * v,
      life: 0, max: 0.45 + Math.random() * 0.5,
      size: 2 + Math.random() * 3.2,
      color: colors[(Math.random() * colors.length) | 0],
    });
  }
}
function floater(wx, wy, text, color) {
  floaters.push({ wx, wy, text, color, life: 0, max: 1.0 });
}

let toastTimer = null;
function toast(text, ms = 2200) {
  $('toast').textContent = text;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').textContent = ''; }, ms);
}

function handleEvents(events, T) {
  for (const e of events) {
    if (recorder) recorder.observe(e, G); // PnL log (crash is written by finish)
    if (e.type === 'orb') {
      sfx.orb(e.combo);
      burst(e.x, e.y, [T.orb, T.orbCore, T.chart], 14, 160);
      const wagmi = e.combo === 4 || Math.random() < 0.15;
      floater(e.x, e.y + 26, wagmi ? `+${e.points} wagmi` : `+${e.points}${e.multiplier > 1 ? `  x${e.multiplier}` : ''}`, T.orb);
    } else if (e.type === 'closecall') {
      sfx.closecall();
      burst(G.x, terrainHeightAt(G, G.x) + 6, [T.chartHi, T.chart], 8, 120);
      floater(G.x, G.y + 30, 'that was NEAR! +15', T.chartHi);
      shake = Math.max(shake, 2);
    } else if (e.type === 'comboLost') {
      sfx.comboLost();
      floater(G.x, G.y + 30, 'combo lost', T.cliff);
    } else if (e.type === 'rugwarning') {
      sfx.warn();
      const b = $('rug-banner');
      b.textContent = 'RUG PULL INBOUND';
      b.classList.remove('hidden');
    } else if (e.type === 'rugdrop') {
      sfx.drop();
      const b = $('rug-banner');
      b.textContent = 'RUG PULL!';
      setTimeout(() => b.classList.add('hidden'), 900);
      shake = Math.max(shake, 6);
    } else if (e.type === 'rugsurvived') {
      sfx.survived();
      floater(G.x, G.y + 34, 'not today, ser +150', T.chart);
      toast('not today, ser. rug survived, +150');
    } else if (e.type === 'crash') {
      sfx.crash();
      burst(G.x, G.y, [T.fin, T.flameO, T.chart, T.orb], 46, 300);
      shake = 15;
      if (mode === 'playing') gameOver();
    }
  }
}

// ---------------------------------------------------------------- input
// No accidental starts: pressing on the menu only opens the stake
// card, and on the game-over screen nothing restarts except the
// "run it back" button.
//
// THE ONE BUTTON, tracked as physical state. heldPointers / heldKeys
// mirror what is down RIGHT NOW, updated on every down / up / cancel.
// startGame() snapshots them into ignoredPointers / ignoredKeys: an
// input that was already down when the run started cannot thrust until
// it has been released and pressed again. That is the whole "the press
// that started the run must not thrust" rule, keyed off physical state
// rather than event order.
//
// Why not a latch armed inside the click handler? That was the old
// design, and it broke touch completely: for pointer input, pointerup
// fires BEFORE click, so a latch set in apeIn() was armed after its
// own release had already happened. It stayed armed, press() swallowed
// the player's first real hold of every run, and the rocket free-fell
// and crashed inside half a second — then "run it back", another
// click, armed it again. A death loop. (Keyboard survived because
// keyup genuinely comes after keydown.) Snapshotting has no such
// asymmetry: a click-started run snapshots an empty set, because by
// click time the pointer is already up.
const heldPointers = new Set();
const heldKeys = new Set();
let ignoredPointers = new Set();
let ignoredKeys = new Set();

function refreshThrust() {
  let held = false;
  for (const id of heldPointers) if (!ignoredPointers.has(id)) { held = true; break; }
  if (!held) for (const code of heldKeys) if (!ignoredKeys.has(code)) { held = true; break; }
  thrustHeld = held;
}

function openStake() {
  if (mode !== 'demo' || stakeOpen) return;
  ensureAudio();
  stakeOpen = true;
  syncStakeUI();
  $('overlay-stake').classList.remove('hidden');
  syncState();
}
function closeStake() {
  stakeOpen = false;
  $('overlay-stake').classList.add('hidden');
  syncState();
}
function apeIn() {
  if (!stakeOpen) return;
  closeStake();
  startGame();
}

const stage = $('stage');
stage.addEventListener('pointerdown', (e) => {
  // UI inside the stage (buttons, sliders, the cards themselves) is
  // not the one button, and its presses are never recorded as holds.
  if (e.target.closest('button, input, .card')) return;
  e.preventDefault();
  ensureAudio();
  heldPointers.add(e.pointerId);
  if (stakeOpen) return;
  if (mode === 'demo') { openStake(); return; }
  if (mode !== 'playing') return; // game over: canvas clicks never restart
  refreshThrust();
});
function endPointer(e) {
  heldPointers.delete(e.pointerId);
  ignoredPointers.delete(e.pointerId);
  refreshThrust();
}
window.addEventListener('pointerup', endPointer);
window.addEventListener('pointercancel', endPointer);
window.addEventListener('blur', () => {
  heldPointers.clear();
  heldKeys.clear();
  refreshThrust();
  if (mode === 'playing' && !paused) togglePause();
});

const THRUST_KEYS = ['Space', 'ArrowUp', 'KeyW'];
window.addEventListener('keydown', (e) => {
  if (THRUST_KEYS.includes(e.code)) {
    e.preventDefault();
    if (e.repeat) return;
    heldKeys.add(e.code);
    if (stakeOpen) { apeIn(); return; }
    if (mode === 'demo') { openStake(); return; }
    refreshThrust();
  } else if (e.code === 'Enter') {
    if (stakeOpen) { apeIn(); return; }
    if (mode === 'demo') openStake();
  } else if (e.code === 'KeyP') {
    togglePause();
  } else if (e.code === 'KeyM') {
    toggleMute();
  }
});
window.addEventListener('keyup', (e) => {
  if (THRUST_KEYS.includes(e.code)) {
    heldKeys.delete(e.code);
    ignoredKeys.delete(e.code);
    refreshThrust();
  }
});

function togglePause() {
  if (mode !== 'playing') return;
  paused = !paused;
  $('paused-banner').classList.toggle('hidden', !paused);
  $('btn-pause').textContent = paused ? 'Resume' : 'Pause';
}
function toggleMute() {
  muted = !muted;
  store(MUTE_KEY, muted ? '1' : '0');
  $('btn-sound').textContent = `Sound: ${muted ? 'off' : 'on'}`;
  if (!muted) ensureAudio();
}

$('btn-start').addEventListener('click', () => { openStake(); });
$('btn-over-settings').addEventListener('click', () => {
  setOverSettings($('over-settings-body').classList.contains('hidden'));
});
$('btn-start-settings').addEventListener('click', () => {
  setSettingsPanel(
    $('btn-start-settings'), $('start-settings-body'),
    $('start-settings-body').classList.contains('hidden'),
  );
});
$('btn-ape').addEventListener('click', () => { apeIn(); });
$('btn-ngmi').addEventListener('click', () => { closeStake(); });
$('btn-again').addEventListener('click', () => { startGame(); });
$('btn-download').addEventListener('click', () => { downloadPnl(); });
$('btn-share').addEventListener('click', () => { shareOnX(); });
$('btn-pause').addEventListener('click', () => togglePause());
$('btn-sound').addEventListener('click', () => toggleMute());
$('btn-theme').addEventListener('click', () => toggleTheme());

// ---------------------------------------------------------------- sizing
let viewW = 920; // world units across the screen
function fit() {
  const r = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(r.width * dpr);
  canvas.height = Math.round(r.height * dpr);
  viewW = r.width < 560 ? 600 : 920;
}

// The stage's height must never rest on the 100dvh flex chain alone.
// In at least one Android file viewer that chain resolved to nothing:
// the page rendered (header, HUD, buttons, help) but the stage was a
// zero-height seam — no canvas, no cards, no game, and fit() had baked
// a 0px backing store at boot with no resize ever arriving to fix it.
// So on phone widths the stage gets an explicit pixel height, measured
// from window.innerHeight minus the real heights of everything else on
// screen, with a hard floor. The stylesheet sizes stay underneath as a
// fallback; once set, the JS pixel height (and flex:none) wins.
const STAGE_FLOOR_PX = 320; // the stage never collapses below this on a phone

function sizeStage() {
  const stage = $('stage');
  if (window.innerWidth > 760) {
    // Desktop keeps the stylesheet sizing; drop any phone measurement.
    if (stage.style.height) { stage.style.height = ''; stage.style.flex = ''; fit(); }
    return;
  }
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;
  const chromeOf = (el) => {
    if (!el) return 0;
    const cs = getComputedStyle(el);
    return el.offsetHeight + parseFloat(cs.marginTop || 0) + parseFloat(cs.marginBottom || 0);
  };
  const wrap = document.querySelector('.stage-wrap');
  const wrapCs = getComputedStyle(wrap);
  const used = chromeOf(document.querySelector('.topbar'))
    + chromeOf($('toast'))
    + chromeOf(document.querySelector('.howto'))
    + parseFloat(wrapCs.paddingTop || 0) + parseFloat(wrapCs.paddingBottom || 0);
  stage.style.flex = '0 0 auto'; // the measured px height wins over the flex chain
  stage.style.height = `${Math.max(STAGE_FLOOR_PX, Math.floor(vh - used))}px`;
  fit(); // re-sync the canvas backing store to the stage's real box
}
window.addEventListener('resize', sizeStage);
window.addEventListener('orientationchange', sizeStage);
window.addEventListener('load', sizeStage);
// Slow WebViews settle late (fonts, browser chrome, innerHeight still
// moving): re-measure shortly after boot so a stage sized against a
// half-laid-out page recovers instead of staying collapsed.
setTimeout(sizeStage, 500);
setTimeout(sizeStage, 1500);

// ---------------------------------------------------------------- render
function hash01(n) {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
}

function draw(dt) {
  const T = THEMES[themeName];
  const w = canvas.getBoundingClientRect().width;
  const h = canvas.getBoundingClientRect().height;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const scaleX = w / viewW;
  const scaleY = h / WORLD_H;
  const camX = G.x - viewW * 0.24;
  const X = (wx) => (wx - camX) * scaleX;
  const Y = (wy) => h - wy * scaleY;

  ctx.save();
  if (shake > 0.2) {
    ctx.translate((Math.random() * 2 - 1) * shake, (Math.random() * 2 - 1) * shake);
  }

  // Sky
  const sky = ctx.createLinearGradient(0, 0, 0, h);
  sky.addColorStop(0, T.sky[0]); sky.addColorStop(0.55, T.sky[1]); sky.addColorStop(1, T.sky[2]);
  ctx.fillStyle = sky;
  ctx.fillRect(-20, -20, w + 40, h + 40);

  // Speckles (stars at night, dust motes on paper)
  ctx.fillStyle = T.speckle;
  for (let i = 0; i < 64; i++) {
    const sx = (((i * 173.3 - camX * scaleX * 0.12) % (w + 30)) + w + 30) % (w + 30) - 15;
    const sy = (i * 97.71) % h;
    ctx.globalAlpha = 0.25 + hash01(i * 3) * 0.5;
    ctx.fillRect(sx, sy, 2, 2);
  }
  ctx.globalAlpha = 1;

  // Parallax candlesticks, far behind the action
  const slot = 46;
  const bgX = camX * 0.45;
  const k0 = Math.floor(bgX / slot) - 1;
  const k1 = k0 + Math.ceil(viewW / slot) + 3;
  for (let k = k0; k < k1; k++) {
    const sx = (k * slot - bgX) * scaleX;
    const mid = 320 + (hash01(k) - 0.5) * 300;
    const body = 26 + hash01(k + 999) * 95;
    const wick = 12 + hash01(k + 77) * 34;
    const up = hash01(k + 55) > 0.45;
    ctx.fillStyle = up ? T.candleUp : T.candleDown;
    ctx.fillRect(sx + slot * scaleX * 0.22, Y(mid + body / 2), slot * scaleX * 0.56, body * scaleY);
    ctx.fillRect(sx + slot * scaleX * 0.47, Y(mid + body / 2 + wick), slot * scaleX * 0.06, (body + wick * 2) * scaleY);
  }

  // Grid
  ctx.strokeStyle = T.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const gridOff = (camX * 0.7) % 90;
  for (let gx = -gridOff * scaleX; gx < w; gx += 90 * scaleX) { ctx.moveTo(gx, 0); ctx.lineTo(gx, h); }
  for (let wy = 0; wy <= WORLD_H; wy += 80) { ctx.moveTo(0, Y(wy)); ctx.lineTo(w, Y(wy)); }
  ctx.stroke();

  // The chart (terrain): filled body + glowing line
  const x0 = camX - 24;
  const x1 = camX + viewW + 24;
  ctx.beginPath();
  let first = true;
  for (let wx = x0; wx <= x1; wx += 7) {
    const sx = X(wx); const sy = Y(terrainHeightAt(G, wx));
    if (first) { ctx.moveTo(sx, sy); first = false; } else ctx.lineTo(sx, sy);
  }
  ctx.lineTo(X(x1), h + 24); ctx.lineTo(X(x0), h + 24); ctx.closePath();
  const fill = ctx.createLinearGradient(0, 0, 0, h);
  fill.addColorStop(0, T.fillTop); fill.addColorStop(1, T.fillBot);
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.beginPath();
  first = true;
  for (let wx = x0; wx <= x1; wx += 7) {
    const sx = X(wx); const sy = Y(terrainHeightAt(G, wx));
    if (first) { ctx.moveTo(sx, sy); first = false; } else ctx.lineTo(sx, sy);
  }
  ctx.save();
  ctx.shadowColor = T.glow; ctx.shadowBlur = 13;
  ctx.strokeStyle = T.chart; ctx.lineWidth = 3; ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.restore();

  // Rug dressing: warning makes the whole line strobe red; during the
  // event the freshest cliff zone is tinted.
  if (G.rugPhase === 'warning' && Math.sin(G.time * 26) > 0) {
    ctx.beginPath();
    first = true;
    for (let wx = x0; wx <= x1; wx += 7) {
      const sx = X(wx); const sy = Y(terrainHeightAt(G, wx));
      if (first) { ctx.moveTo(sx, sy); first = false; } else ctx.lineTo(sx, sy);
    }
    ctx.strokeStyle = T.cliff; ctx.lineWidth = 3; ctx.globalAlpha = 0.85;
    ctx.stroke(); ctx.globalAlpha = 1;
  }
  if (G.rugPhase === 'active' && G.cliffs.length) {
    const c = G.cliffs[G.cliffs.length - 1];
    if (c.x + 980 > camX && c.x < x1) {
      ctx.beginPath();
      first = true;
      for (let wx = Math.max(x0, c.x); wx <= Math.min(x1, c.x + 420); wx += 7) {
        const sx = X(wx); const sy = Y(terrainHeightAt(G, wx));
        if (first) { ctx.moveTo(sx, sy); first = false; } else ctx.lineTo(sx, sy);
      }
      ctx.lineTo(X(Math.min(x1, c.x + 420)), h + 24); ctx.lineTo(X(Math.max(x0, c.x)), h + 24); ctx.closePath();
      ctx.fillStyle = T.cliff; ctx.globalAlpha = 0.16 + 0.06 * Math.sin(G.time * 9);
      ctx.fill(); ctx.globalAlpha = 1;
    }
  }

  // Orbs
  for (const orb of G.orbs) {
    if (orb.collected || orb.missed) continue;
    const sx = X(orb.x);
    if (sx < -30 || sx > w + 30) continue;
    const sy = Y(orb.y);
    const pulse = 1 + Math.sin(G.time * 4 + orb.x * 0.05) * 0.1;
    const r = 11 * Math.max(scaleX, 0.55) * pulse;
    ctx.save();
    ctx.shadowColor = T.orb; ctx.shadowBlur = 16;
    ctx.beginPath(); ctx.arc(sx, sy, r, 0, Math.PI * 2);
    ctx.fillStyle = T.orb; ctx.fill();
    ctx.restore();
    ctx.beginPath(); ctx.arc(sx, sy, r * 0.62, 0, Math.PI * 2);
    ctx.fillStyle = T.orbCore; ctx.fill();
    ctx.fillStyle = T.orbInk;
    ctx.font = `800 ${Math.round(r * 0.95)}px system-ui, sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('N', sx, sy + 0.5);
  }

  // Particles
  for (const p of particles) {
    const a = 1 - p.life / p.max;
    ctx.globalAlpha = a;
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(X(p.wx), Y(p.wy), p.size * a + 0.4, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;

  // The rocket
  if (mode !== 'over') {
    const px = X(G.x);
    const py = Y(G.y);
    const u = ((scaleX + scaleY) / 2) * 1.3;
    const rot = Math.max(-0.6, Math.min(0.55, -G.vy * 0.00075));
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(rot);
    ctx.scale(u, u);
    if (thrustHeld) {
      const fl = 14 + Math.random() * 10 + Math.max(0, G.vy) * 0.012;
      ctx.beginPath();
      ctx.moveTo(-13, 4.6); ctx.lineTo(-13 - fl, 0); ctx.lineTo(-13, -4.6); ctx.closePath();
      ctx.fillStyle = T.flameO; ctx.fill();
      ctx.beginPath();
      ctx.moveTo(-13, 2.6); ctx.lineTo(-13 - fl * 0.55, 0); ctx.lineTo(-13, -2.6); ctx.closePath();
      ctx.fillStyle = T.flameY; ctx.fill();
    }
    ctx.fillStyle = T.fin;
    ctx.beginPath(); ctx.moveTo(-11, -6); ctx.lineTo(-19, -14); ctx.lineTo(-6, -10.5); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(-11, 6); ctx.lineTo(-19, 14); ctx.lineTo(-6, 10.5); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.ellipse(0, 0, 17, 9.5, 0, 0, Math.PI * 2);
    ctx.fillStyle = T.body; ctx.fill();
    ctx.strokeStyle = 'rgba(20,26,54,0.35)'; ctx.lineWidth = 1 / u + 0.6; ctx.stroke();
    ctx.beginPath(); ctx.arc(5.5, -1.5, 4.1, 0, Math.PI * 2);
    ctx.fillStyle = T.win; ctx.fill();
    ctx.beginPath(); ctx.arc(6.8, -2.8, 1.3, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.85)'; ctx.fill();
    ctx.restore();
  }

  // Floaters
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const f of floaters) {
    const a = 1 - f.life / f.max;
    ctx.globalAlpha = a;
    ctx.font = '800 15px system-ui, sans-serif';
    ctx.lineWidth = 4; ctx.strokeStyle = T.floaterStroke;
    const sx = X(f.wx); const sy = Y(f.wy);
    ctx.strokeText(f.text, sx, sy);
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, sx, sy);
  }
  ctx.globalAlpha = 1;

  ctx.restore();
}

// ---------------------------------------------------------------- HUD
function setHud(id, value) {
  if (lastHud[id] !== value) { lastHud[id] = value; $(id).textContent = value; }
}
function updateHud() {
  // Crossing the stored best lights the BEST box up for the rest of
  // the run (and the record is saved on the spot, not just at the end).
  if (mode === 'playing' && !bestBeaten && best > 0 && G.score > best) {
    bestBeaten = true;
    best = G.score;
    store(BEST_KEY, String(best));
    $('stat-best-box').classList.add('beaten');
    if (recorder) recorder.noteNewBest(G.time, G.score);
  }
  setHud('stat-score', String(G.score));
  setHud('stat-best', String(Math.max(best, G.score)));
  const comboEl = $('stat-combo');
  const comboText = G.combo >= 2 ? `x${G.multiplier} (${G.combo})` : '—';
  setHud('stat-combo', comboText);
  comboEl.classList.toggle('hot', G.combo >= 2);
  setHud('stat-orbs', String(G.orbsCollected));
  setHud('stat-speed', `${(G.speed / (BASE_SPEED * settings.speed)).toFixed(1)}x`);
}

// ---------------------------------------------------------------- loop
let lastTs = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  if (!lastTs) lastTs = ts;
  const dt = Math.min((ts - lastTs) / 1000, 0.05);
  lastTs = ts;
  if (!G) return;
  const T = THEMES[themeName];

  // Only a live run simulates. The menu scene is FROZEN: one parked
  // frame of terrain and rocket behind the start card — nothing
  // plays itself. The game-over world also stays where the crash
  // left it; only its particles settle (below).
  if (!paused && mode === 'playing') {
    const events = step(G, dt, thrustHeld);
    handleEvents(events, T);
    if (recorder) recorder.tick(G); // chart samples for the PnL card
  }

  if (!paused && mode !== 'demo') {
    for (const p of particles) {
      p.life += dt;
      p.wx += p.vx * dt + G.speed * dt * 0.12;
      p.wy += p.vy * dt;
      p.vy -= 320 * dt;
    }
    particles = particles.filter((p) => p.life < p.max);
    for (const f of floaters) { f.life += dt; f.wy += 36 * dt; }
    floaters = floaters.filter((f) => f.life < f.max);
    shake = Math.max(0, shake - dt * 26);
  }

  draw(dt);
  updateHud();
}

// ---------------------------------------------------------------- test handle
// Minimal debug surface for headless verification: lets checks read the
// live state and confirm real input (touch included) drives the game.
// Harmless in normal play — it changes nothing, only observes.
window.__pumpRider = {
  get mode() { return mode; },
  get stakeOpen() { return stakeOpen; },
  get stake() { return currentStake(); },
  get thrustHeld() { return thrustHeld; },
  get game() { return G; },
  get lastRun() { return lastSummary; },
  get lastCard() { return lastCard; },
  pnlCardPng: () => renderPnlPng(),
  audioState: () => (actx ? actx.state : 'none'),
  terrainHeightAt: (x) => terrainHeightAt(G, x),
};

// ---------------------------------------------------------------- boot
applyTheme();
wireSettings();
wireStake();
$('btn-sound').textContent = `Sound: ${muted ? 'off' : 'on'}`;
sizeStage();
newRun(seedParam !== null ? seedParam : 'pump-rider-demo');
mode = 'demo';
syncState();
if (params.get('play') === '1') $('overlay-start').classList.add('hidden');
requestAnimationFrame(frame);
