// layout-cdp.mjs — headless verification for the layout + PnL round.
// Drives dist/pump-rider.html in real Chrome via CDP and asserts:
//   (0) difficulty is collapsed by default on the start card too, the
//       HUD colours score gold and best NEAR green, and the whole
//       page fits the 100dvh phone viewport without scrolling,
//   (1) the stage flexes to the visible height and the "How to ride"
//       strip is compact with an internally scrolling list at 390x844,
//   (2) the game-over card is a complete box inside the stage frame
//       (margin on all four sides, no whole-card scroll), every block
//       of the stack inside the stage by bounding box, the death
//       headline one short line, difficulty collapsed but expandable
//       without trapping any control,
//   (3) the PnL card renders from the real run: gold hero, verdict
//       pill, gain, the run's own chart with orb markers, tiles, and
//       the PNG painter returns a real data URL.
// Also regenerates the menu / game-over mobile proofs (dark + light)
// and the desktop start-screen + light-gameplay screenshots.
// Later sections cover the phone-viewer failure modes:
//   (4) browser-chrome-visible heights (390x700, 390x660): the start
//       card and the full game-over stack inside the JS-sized stage,
//   (5) the same with the stylesheet's dvh/flex chain neutralized by
//       an injected override (the hostile WebView case): the stage
//       must still be JS-sized >= 320px and the game playable,
//   (6) a 4-digit score under a +1900% bar: the long bar-miss pill
//       under a red 4-digit hero, on separate lines, HIGH chip clear
//       of the crash X, and the PNG painter's version of that card
//       saved as pnl-4digit.png.
//   (7) the stake flow: Start riding opens the STAKE card (the old
//       APE IN confirm card is gone entirely), the $10 default is
//       preselected, chips and the - / + stepper walk one ladder in
//       sync and clamp at both ends, the choice persists, ngmi backs
//       out un-started, and the game-over money strip settles the
//       chosen stake from the same card model. The stake card is
//       asserted inside the stage in the (4/5) matrix too.
//   (8) the bar round: the ENTIRE stake card (stake controls AND the
//       "call your bar" target picker AND APE IN) inside the stage at
//       390x660 with no card scroll; target chips update the need
//       line and persist; a flown WIN card and a crashed LOSS card
//       carry their green/red identity, glow, pill, gain and note;
//       run it back returns to the stake card (never auto-starts);
//       the two-step reset arms, disarms on any other tap and on a
//       timeout, and on the second tap wipes best, last run, stake,
//       bar and settings back to factory defaults, verified again on
//       a fresh boot. The painter's LOSS card lands in pnl-loss.png.
//   (9) the volatility readout is live (moving a slider rewrites
//       every readout line), and Share carries the card IMAGE: with
//       navigator.share stubbed in, the preferred path receives one
//       image/png File named pump-rider-pnl.png plus the share text
//       (and nothing downloads or opens); an AbortError stays silent;
//       with canShare stubbed false, the fallback downloads the PNG,
//       opens the X intent and shows the attach hint.
//   (10) the currency switch: the $ / NEAR toggle converts the stake
//       at the reference rate, swaps the ladder and the stepper
//       steps, persists across a reload, settles a NEAR run in NEAR
//       (with the pnl's dollar equivalent on the strip), converts
//       back with the ladder snap, and the reset restores dollars.
//       The stake card is re-fit at 390x660 in NEAR mode, rate line
//       and all.
// PR_BUNDLE=/dist/product/pump-rider.html runs the whole suite
// against the product variant instead of the hackathon bundle.
// Run: node verification/layout-cdp.mjs

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8932;
const CDP_PORT = 9338;
const CHROME_CANDIDATES = [
  process.env.CHROME,
  process.env.HOME + '/rec-tools/browsers/chrome/linux-157.0.8103.38/chrome-linux64/chrome',
  '/opt/meta-chromium/chrome',
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!CHROME) { console.error('FAIL: no Chrome binary found'); process.exit(1); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`);
  if (!cond) failures += 1;
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.md': 'text/plain' };
const server = createServer(async (req, res) => {
  try {
    const path = join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
    const data = await readFile(path);
    res.writeHead(200, { 'Content-Type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(data);
  } catch { res.writeHead(404); res.end('nope'); }
});
await new Promise((r) => server.listen(PORT, r));

const profile = mkdtempSync(join(tmpdir(), 'pr-layout-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

async function waitForCdp() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`); if (r.ok) return; } catch {}
    await sleep(250);
  }
  throw new Error('Chrome CDP never came up');
}
await waitForCdp();
const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let msgId = 0;
const pending = new Map();
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const id = ++msgId; pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.result?.exceptionDetails) throw new Error('evaluate failed: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
};
const shot = async (name, beyond = false) => {
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: beyond });
  writeFileSync(new URL(name, import.meta.url), Buffer.from(r.result.data, 'base64'));
  console.log('screenshot ->', name);
};
const rectOf = (sel) => ev(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, w: r.width, h: r.height,
           cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; })()`);
const BUNDLE = process.env.PR_BUNDLE || '/dist/pump-rider.html';
async function loadGame(qs) {
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}${BUNDLE}?${qs}` });
  for (let i = 0; i < 60; i++) {
    if (await ev('!!window.__pumpRider').catch(() => false)) { await sleep(250); return; }
    await sleep(200);
  }
  throw new Error('game never booted');
}
async function tap(x, y, id = 1) {
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id }] });
  await sleep(70);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(150);
}
const touchHoldStart = (x, y, id) => send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id }] });
const touchRelease = () => send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
const mode = () => ev('window.__pumpRider.mode');

// =======================================================================
// MOBILE — 390x844
// =======================================================================
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await loadGame('seed=7&theme=dark');

// (0) Start difficulty collapsed by default; HUD colours; page fit.
const startDiff = await ev(`(() => { const body = document.getElementById('start-settings-body');
  const btn = document.getElementById('btn-start-settings');
  return { hidden: body.classList.contains('hidden'), expanded: btn.getAttribute('aria-expanded') }; })()`);
check('(0a) start-card difficulty collapsed by default', startDiff.hidden === true && startDiff.expanded === 'false');
const startTog = await rectOf('#btn-start-settings');
await tap(startTog.cx, startTog.cy, 7);
const startDiffOpen = await ev(`document.getElementById('start-settings-body').classList.contains('hidden')`);
check('(0b) tapping the start difficulty row expands it', startDiffOpen === false);
const startTog2 = await rectOf('#btn-start-settings');
await tap(startTog2.cx, startTog2.cy, 7);
const startDiffShut = await ev(`document.getElementById('start-settings-body').classList.contains('hidden')`);
check('(0c) tapping again collapses it', startDiffShut === true);
const hudColors = await ev(`(() => { const cs = (id) => getComputedStyle(document.getElementById(id)).color;
  return { score: cs('stat-score'), best: cs('stat-best') }; })()`);
check('(0d) HUD score is gold #ffc837', hudColors.score === 'rgb(255, 200, 55)', hudColors.score);
check('(0e) HUD best is NEAR green #00ec97', hudColors.best === 'rgb(0, 236, 151)', hudColors.best);
const pageFit = await ev(`(() => ({ sh: document.documentElement.scrollHeight, ih: window.innerHeight,
  bodySh: document.body.scrollHeight }))()`);
check('(0f) whole page fits the phone viewport (100dvh column, no page scroll)',
  pageFit.sh <= pageFit.ih + 1 && pageFit.bodySh <= pageFit.ih + 1,
  `scrollHeight=${pageFit.sh} body=${pageFit.bodySh} inner=${pageFit.ih}`);

// (1) Stage flexes to the visible height; help strip compact.
const canvasH = await ev(`document.getElementById('game').getBoundingClientRect().height`);
check('(1a) stage flexes to fill the visible height at 390x844', canvasH >= 520, `canvas css height=${canvasH.toFixed(0)}`);
const howto = await ev(`(() => { const card = document.querySelector('.howto');
  const ol = card.querySelector('ol'); const r = card.getBoundingClientRect();
  return { h: r.height, items: ol.querySelectorAll('li').length,
           scrollable: ol.scrollHeight > ol.clientHeight + 1 || ol.scrollHeight <= ol.clientHeight,
           maxH: parseFloat(getComputedStyle(ol).maxHeight) }; })()`);
check('(1b) how-to strip is compact', howto.h <= 130, `card height=${howto.h.toFixed(0)}px, list max-height=${howto.maxH}px`);
check('(1c) all five instructions retained', howto.items === 5, `items=${howto.items}`);
await shot('menu-mobile.png', true); // full page: stage + compact strip below

// The stake flow: Start riding opens the stake card (the confirm
// card is gone). Exercise the ladder — default, ngmi back-out, chip
// select, stepper walk, the clamp at the top — then ape in on $50 so
// the game-over money strip has a real stake to settle.
const stakeState = () => ev(`(() => { const on = (id) => !document.getElementById(id).classList.contains('hidden');
  return { stakeShown: on('overlay-stake'), confirmGone: document.getElementById('overlay-confirm') === null,
           startShown: on('overlay-start'), state: document.body.dataset.state,
           amount: document.getElementById('stake-amount').textContent,
           ape: document.getElementById('btn-ape').textContent,
           mode: window.__pumpRider.mode, stake: window.__pumpRider.stake,
           stored: localStorage.getItem('pump-rider-stake'),
           activeChip: document.querySelector('.stake-chip.active')?.dataset.stake }; })()`);
const startBtn = await rectOf('#btn-start');
await tap(startBtn.cx, startBtn.cy, 2);
let ss = await stakeState();
check('(7a) Start riding opens the stake card, confirm card gone, run un-started',
  ss.stakeShown && ss.confirmGone && ss.mode === 'demo' && ss.state === 'stake', JSON.stringify(ss));
check('(7b) the $10 default is preselected on a first ever visit',
  ss.amount === '$10' && ss.ape === 'APE IN $10' && ss.activeChip === '10' && ss.stake === 10,
  `amount=${ss.amount} ape=${ss.ape} chip=${ss.activeChip}`);
const ngmiBtn = await rectOf('#btn-ngmi');
await tap(ngmiBtn.cx, ngmiBtn.cy, 2);
ss = await stakeState();
check('(7c) ngmi backs out to the start card, still un-started',
  !ss.stakeShown && ss.startShown && ss.mode === 'demo', JSON.stringify(ss));
const startBtn2 = await rectOf('#btn-start');
await tap(startBtn2.cx, startBtn2.cy, 2);
const chip50 = await rectOf('.stake-chip[data-stake="50"]');
await tap(chip50.cx, chip50.cy, 2);
ss = await stakeState();
check('(7d) tapping the $50 chip selects it, syncs the button, persists it',
  ss.amount === '$50' && ss.ape === 'APE IN $50' && ss.activeChip === '50' && ss.stake === 50 && ss.stored === '50',
  JSON.stringify(ss));
const plusBtn = await rectOf('#btn-stake-plus');
await tap(plusBtn.cx, plusBtn.cy, 2);
ss = await stakeState();
check('(7e) the + stepper walks the ladder to $100 and the chip follows',
  ss.amount === '$100' && ss.activeChip === '100' && ss.ape === 'APE IN $100', `amount=${ss.amount} chip=${ss.activeChip}`);
const minusBtn = await rectOf('#btn-stake-minus');
await tap(minusBtn.cx, minusBtn.cy, 2);
ss = await stakeState();
check('(7f) the - stepper walks back to $50', ss.amount === '$50' && ss.activeChip === '50', `amount=${ss.amount}`);
const chipTop = await rectOf('.stake-chip[data-stake="1000"]');
await tap(chipTop.cx, chipTop.cy, 2);
const plusBtn2 = await rectOf('#btn-stake-plus');
await tap(plusBtn2.cx, plusBtn2.cy, 2);
ss = await stakeState();
check('(7g) the stepper clamps at the $1,000 top of the ladder, no wrap',
  ss.amount === '$1,000' && ss.stake === 1000, `amount=${ss.amount}`);
const chip50b = await rectOf('.stake-chip[data-stake="50"]');
await tap(chip50b.cx, chip50b.cy, 2);
await shot('stake-card.png');
const ape = await rectOf('#btn-ape');
await tap(ape.cx, ape.cy, 2);
check('run started by touch', (await mode()) === 'playing');
const stageForFlight = await rectOf('#game');
const fx = stageForFlight.cx, fy = stageForFlight.cy;
const flightState = () => ev(`(() => { const P = window.__pumpRider, g = P.game; return {
  mode: P.mode, y: g.y, vy: g.vy, score: g.score, crashed: g.crashed,
  ahead: Math.max(P.terrainHeightAt(g.x), P.terrainHeightAt(g.x + 70), P.terrainHeightAt(g.x + 140)) }; })()`);
let holding = false;
const flightDeadline = Date.now() + 16000;
while (Date.now() < flightDeadline) {
  const s = await flightState();
  if (s.mode !== 'playing' || s.crashed) break;
  const wantHold = s.y + s.vy * 0.32 < s.ahead + 108;
  if (wantHold && !holding) { holding = true; await touchHoldStart(fx, fy, 6); }
  else if (!wantHold && holding) { holding = false; await touchRelease(); }
  await sleep(90);
}
if (holding) { await touchRelease(); holding = false; }
let overVisible = false;
for (let i = 0; i < 50 && !overVisible; i++) {
  await sleep(300);
  overVisible = await ev(`window.__pumpRider.mode === 'over' && !document.getElementById('overlay-over').classList.contains('hidden')`);
}
check('game over card appeared after the crash', overVisible);

// (2) The card is a complete box inside the stage, and does not scroll.
const stageR = await rectOf('#stage');
const cardR = await rectOf('#overlay-over .card');
const margins = {
  top: cardR.top - stageR.top, bottom: stageR.bottom - cardR.bottom,
  left: cardR.left - stageR.left, right: stageR.right - cardR.right,
};
check('(2a) game-over card inside the stage with margin on all sides',
  margins.top >= 8 && margins.bottom >= 8 && margins.left >= 8 && margins.right >= 8,
  `margins t/b/l/r = ${margins.top.toFixed(0)}/${margins.bottom.toFixed(0)}/${margins.left.toFixed(0)}/${margins.right.toFixed(0)}`);
const cardScroll = await ev(`(() => { const c = document.querySelector('#overlay-over .card');
  return { sh: c.scrollHeight, ch: c.clientHeight }; })()`);
check('(2b) game-over card does not scroll as a whole', cardScroll.sh <= cardScroll.ch + 1,
  `scrollHeight=${cardScroll.sh} clientHeight=${cardScroll.ch}`);
const againVisible = await ev(`(() => { const b = document.getElementById('btn-again').getBoundingClientRect();
  const s = document.getElementById('stage').getBoundingClientRect();
  return b.top >= s.top && b.bottom <= s.bottom; })()`);
check('(2c) run-it-back button fully inside the stage', againVisible);

// (2g) The whole game-over stack inside the stage, by bounding box.
const stackBoxes = await ev(`(() => { const s = document.getElementById('stage').getBoundingClientRect();
  const inside = (sel) => { const r = document.querySelector(sel).getBoundingClientRect();
    return r.top >= s.top - 1 && r.bottom <= s.bottom + 1 && r.left >= s.left - 1 && r.right <= s.right + 1; };
  return { title: inside('#over-title'), pnl: inside('#pnl-card'), money: inside('#pnl-money'),
           vs: inside('#pnl-vs'), settings: inside('#over-settings'), actions: inside('.pnl-actions'),
           again: inside('#btn-again'), reset: inside('#btn-reset') }; })()`);
check('(2g) headline, PnL card, money strip, note line, difficulty row, share buttons, run-it-back + reset all fully inside the stage',
  Object.values(stackBoxes).every(Boolean), JSON.stringify(stackBoxes));

// (2h) The death headline: one short line in small type, never wraps.
const headline = await ev(`(() => { const el = document.getElementById('over-title');
  return { text: el.textContent, h: el.getBoundingClientRect().height,
           fits: el.scrollWidth <= el.clientWidth + 1, fs: parseFloat(getComputedStyle(el).fontSize) }; })()`);
check('(2h) death headline is one short small line',
  headline.fits && headline.h <= 26 && headline.text.length <= 20 && headline.fs <= 16.5,
  `"${headline.text}" at ${headline.fs}px, h=${headline.h.toFixed(0)}`);

// (2d) Difficulty collapsed by default on this card, expands on tap.
const bodyHidden0 = await ev(`document.getElementById('over-settings-body').classList.contains('hidden')`);
check('(2d) difficulty collapsed by default on game over', bodyHidden0 === true);
const tog = await rectOf('#btn-over-settings');
await tap(tog.cx, tog.cy, 3);
const bodyHidden1 = await ev(`document.getElementById('over-settings-body').classList.contains('hidden')`);
const expanded = await ev(`document.getElementById('btn-over-settings').getAttribute('aria-expanded')`);
check('(2e) tapping the difficulty row expands it', bodyHidden1 === false && expanded === 'true');
const expandedFit = await ev(`(() => { const card = document.querySelector('#overlay-over .card');
  const s = document.getElementById('stage').getBoundingClientRect();
  const b = document.getElementById('btn-again').getBoundingClientRect();
  const btnInside = b.top >= s.top - 1 && b.bottom <= s.bottom + 1;
  const cs = getComputedStyle(card);
  const scrollable = cs.overflowY === 'auto' && card.scrollHeight > card.clientHeight;
  return { btnInside, scrollable }; })()`);
check('(2e2) expanded difficulty traps nothing: run-it-back inside the stage, or the card can scroll to it',
  expandedFit.btnInside || expandedFit.scrollable, JSON.stringify(expandedFit));
// Re-query the row: expanding re-centres the card, so it moved.
const tog2 = await rectOf('#btn-over-settings');
await tap(tog2.cx, tog2.cy, 3);
const bodyHidden2 = await ev(`document.getElementById('over-settings-body').classList.contains('hidden')`);
check('(2f) tapping again collapses it', bodyHidden2 === true);

// (3) PnL card: rendered from the real run that just crashed, and the
// PNG painter produces a real shareable file.
const pnl = await ev(`(() => { const P = window.__pumpRider;
  const svg = document.getElementById('pnl-chart');
  const linePath = [...svg.querySelectorAll('path')].find((p) => p.getAttribute('fill') === 'none');
  const cs = (id) => getComputedStyle(document.getElementById(id)).color;
  return {
    hero: document.getElementById('pnl-score').textContent,
    heroColor: cs('pnl-score'),
    verdict: document.getElementById('pnl-verdict').textContent,
    verdictClass: document.getElementById('pnl-verdict').className,
    gain: document.getElementById('pnl-gain').textContent,
    gainColor: cs('pnl-gain'),
    money: document.getElementById('pnl-money').textContent,
    moneyClass: document.getElementById('pnl-money').className,
    vs: document.getElementById('pnl-vs').textContent,
    cardClass: document.getElementById('pnl-card').className,
    cardShadow: getComputedStyle(document.getElementById('pnl-card')).boxShadow,
    hasTargetLine: !!svg.querySelector('.target-line'),
    time: document.getElementById('pnl-time').textContent,
    mult: document.getElementById('pnl-mult').textContent,
    peak: document.getElementById('pnl-peak').textContent,
    preset: document.getElementById('pnl-preset').textContent,
    foot: document.getElementById('pnl-foot').textContent,
    tiles: ['combo', 'orbs', 'near', 'rugs'].map((k) => document.getElementById('pnl-tile-' + k).textContent),
    lineD: linePath ? linePath.getAttribute('d') : '',
    lineStroke: linePath ? linePath.getAttribute('stroke') : '',
    orbMarkers: svg.querySelectorAll('rect').length,
    card: P.lastCard, run: P.lastRun,
  }; })()`);
check('(3a) PnL hero is the run score', pnl.hero === pnl.card.heroText && pnl.hero === `+${pnl.run.score}`, pnl.hero);
check('(3b) PnL hero follows the settlement: gold on a win, red on a loss',
  pnl.heroColor === (pnl.card.win ? 'rgb(255, 200, 55)' : 'rgb(255, 82, 82)'),
  `${pnl.heroColor} win=${pnl.card.win}`);
check('(3c) verdict pill carries the bar verdict',
  pnl.verdict === pnl.card.verdictLabel && pnl.verdictClass.includes(pnl.card.tone), pnl.verdict);
check('(3d) gain figure matches the model, coloured by its tone',
  pnl.gain === pnl.card.gainText &&
  (pnl.card.tone !== 'green' || pnl.gainColor === 'rgb(0, 236, 151)') &&
  (pnl.card.tone !== 'red' || pnl.gainColor === 'rgb(255, 82, 82)'),
  `${pnl.gain} ${pnl.gainColor} tone=${pnl.card.tone}`);
check('(3e) time in trade + best combo multiple shown',
  pnl.time === pnl.card.timeText && pnl.mult === `${pnl.card.multText} combo`,
  `${pnl.time} · ${pnl.mult}`);
check('(3f) tiles match the run',
  JSON.stringify(pnl.tiles) === JSON.stringify(pnl.card.tiles.map((t) => t.value)),
  pnl.tiles.join('/'));
check('(3g) peak label, preset and footer come from the model',
  pnl.peak === `HIGH ${pnl.run.peakScore}` && pnl.preset === pnl.card.preset && pnl.foot === pnl.card.footer,
  `${pnl.peak} · ${pnl.preset} · ${pnl.foot}`);
const linePoints = (pnl.lineD.match(/L/g) || []).length;
check('(3h) the chart plots the run (line path with real points)', linePoints >= 8,
  `${linePoints} segments, stroke=${pnl.lineStroke}`);
check('(3i) a green close draws a NEAR-green line',
  pnl.card.tone !== 'green' || pnl.lineStroke === '#00ec97',
  `tone=${pnl.card.tone} stroke=${pnl.lineStroke}`);
check('(3i2) a lost bar draws a red line',
  pnl.card.tone !== 'red' || pnl.lineStroke === '#ff5252',
  `tone=${pnl.card.tone} stroke=${pnl.lineStroke}`);
check('(3j) one gold marker per orb clipped', pnl.orbMarkers === pnl.run.orbs,
  `markers=${pnl.orbMarkers} orbs=${pnl.run.orbs}`);
check('(3l) PnL money strip settles the $50 stake chosen on the stake card',
  pnl.money === pnl.card.moneyText && pnl.moneyClass.includes(pnl.card.moneyTone) && pnl.card.stake === 50 &&
  pnl.money.startsWith('IN $50 → OUT '),
  `${pnl.money} (tone=${pnl.card.moneyTone})`);
check('(3m) card identity class + glow follow the bar settlement',
  pnl.cardClass.includes(pnl.card.win ? 'win' : 'loss') && pnl.cardShadow !== 'none',
  `class=${pnl.cardClass} win=${pnl.card.win}`);
check('(3n) the vs-last-run note sits under the strip, demoted but present',
  pnl.vs === pnl.card.vsPrevText && pnl.vs.length > 0, pnl.vs);
check('(3o) the chart draws the called bar as a dashed target line', pnl.hasTargetLine);
const png = await ev(`window.__pumpRider.pnlCardPng()`);
check('(3k) PNG painter returns a real data URL',
  typeof png === 'string' && png.startsWith('data:image/png') && png.length > 20000,
  png ? `${png.length} chars` : 'null');
await shot('gameover-mobile.png');

// Light-mode mobile gameplay proof.
await loadGame('seed=21&theme=light');
const ls = await rectOf('#btn-start');
await tap(ls.cx, ls.cy, 4);
const la = await rectOf('#btn-ape');
await tap(la.cx, la.cy, 4);
const lg = await rectOf('#game');
await touchHoldStart(lg.cx, lg.cy, 5);
await sleep(1100);
await shot('gameplay-mobile-light.png');
await touchRelease();

// Let the light run fall and crash, then take the light PnL proof.
let overLight = false;
for (let i = 0; i < 40 && !overLight; i++) {
  await sleep(300);
  overLight = await ev(`window.__pumpRider.mode === 'over' && !document.getElementById('overlay-over').classList.contains('hidden')`);
}
check('light game over card appeared after the fall', overLight);
const lightHero = await ev(`getComputedStyle(document.getElementById('pnl-score')).color`);
check('light PnL hero is red: the short fall missed the bar', lightHero === 'rgb(217, 43, 43)', lightHero);
await shot('gameover-mobile-light.png');

// =======================================================================
// DESKTOP — 1280x800: start screen + light gameplay regeneration
// =======================================================================
await send('Emulation.setTouchEmulationEnabled', { enabled: false });
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await loadGame('seed=7&theme=dark');
await shot('start-screen-dark.png');
const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(60);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(130);
};
await loadGame('seed=21&theme=light');
const ds = await rectOf('#btn-start');
await click(ds.cx, ds.cy);
const da = await rectOf('#btn-ape');
await click(da.cx, da.cy);
const dg = await rectOf('#game');
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dg.cx, y: dg.cy, button: 'left', clickCount: 1 });
await sleep(500);
check('desktop light run is flying under mouse hold',
  await ev('window.__pumpRider.mode') === 'playing' && await ev('window.__pumpRider.thrustHeld') === true);
await shot('gameplay-light.png');
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dg.cx, y: dg.cy, button: 'left', clickCount: 1 });

// =======================================================================
// SHORT VIEWPORTS x HOSTILE CSS — the two phone-viewer failure modes
// =======================================================================
const stackInsideStage = () => ev(`(() => { const s = document.getElementById('stage').getBoundingClientRect();
  const inside = (sel) => { const el = document.querySelector(sel); if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.height > 0 && r.top >= s.top - 1 && r.bottom <= s.bottom + 1 && r.left >= s.left - 1 && r.right <= s.right + 1; };
  return { title: inside('#over-title'), pnl: inside('#pnl-card'), money: inside('#pnl-money'),
           vs: inside('#pnl-vs'), settings: inside('#over-settings'), actions: inside('.pnl-actions'),
           again: inside('#btn-again'), reset: inside('#btn-reset') }; })()`);
const startInsideStage = () => ev(`(() => { const s = document.getElementById('stage').getBoundingClientRect();
  const inside = (sel) => { const r = document.querySelector(sel).getBoundingClientRect();
    return r.height > 0 && r.top >= s.top - 1 && r.bottom <= s.bottom + 1; };
  return { card: inside('#overlay-start .card'), btn: inside('#btn-start') }; })()`);
const pnlInnerFit = () => ev(`(() => { const p = document.getElementById('pnl-card').getBoundingClientRect();
  const t = document.querySelector('.pnl-tiles').getBoundingClientRect();
  const f = document.getElementById('pnl-foot').getBoundingClientRect();
  return { tilesGap: p.bottom - t.bottom, footGap: p.bottom - f.bottom }; })()`);
const overVisibleNow = () => ev(`window.__pumpRider.mode === 'over' && !document.getElementById('overlay-over').classList.contains('hidden')`);
async function flyToOver(cx, cy) {
  let holding = false;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const s = await flightState();
    if (s.mode !== 'playing' || s.crashed) break;
    const wantHold = s.y + s.vy * 0.32 < s.ahead + 108;
    if (wantHold && !holding) { holding = true; await touchHoldStart(cx, cy, 6); }
    else if (!wantHold && holding) { holding = false; await touchRelease(); }
    await sleep(90);
  }
  if (holding) { await touchRelease(); holding = false; }
  for (let i = 0; i < 50; i++) {
    await sleep(300);
    if (await overVisibleNow()) return true;
  }
  return false;
}
let hostileId = null;
async function setHostile(on) {
  if (on && !hostileId) {
    const r = await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      const css = 'body{display:block !important;height:auto !important;min-height:0 !important}'
        + '.stage-wrap{display:block !important;flex:none !important;height:auto !important}'
        + '.stage{flex:none !important}';
      const apply = () => { const s = document.createElement('style'); s.textContent = css; document.head.appendChild(s); };
      // DOM edits made at evaluate-on-new-document time are discarded
      // when the parser builds the real document, so land the override
      // at DOMContentLoaded. The game's load/resize/500ms re-measures
      // size the stage after it lands — the settled state asserted here.
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply);
      else apply();
    })();` });
    hostileId = r.result.identifier;
  } else if (!on && hostileId) {
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: hostileId });
    hostileId = null;
  }
}
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
for (const [H, hostile] of [[700, false], [660, false], [844, true], [700, true], [660, true]]) {
  const tag = hostile ? 'hostile' : 'normal';
  await setHostile(hostile);
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: H, deviceScaleFactor: 2, mobile: true });
  await loadGame('seed=7&theme=dark');
  // Settle deterministically under whichever CSS regime is active:
  // a resize re-runs the game's own stage measurement.
  await ev(`window.dispatchEvent(new Event('resize'))`);
  await sleep(250);
  const sizing = await ev(`(() => { const st = document.getElementById('stage');
    const r = st.getBoundingClientRect();
    return { h: r.height, inline: st.style.height, bodyDisplay: getComputedStyle(document.body).display,
             canvasH: document.getElementById('game').getBoundingClientRect().height }; })()`);
  check(`(4/5 ${tag} ${H}) stage is JS-sized >= 320px, canvas synced`,
    sizing.h >= 320 && sizing.canvasH >= sizing.h - 3 &&
    (!hostile || (sizing.bodyDisplay === 'block' && Math.abs(parseFloat(sizing.inline) - sizing.h) < 1.5)),
    `stage=${sizing.h.toFixed(0)} inline=${sizing.inline} canvas=${sizing.canvasH.toFixed(0)} body=${sizing.bodyDisplay}`);
  const sc = await startInsideStage();
  check(`(4/5 ${tag} ${H}) start card + Start riding fully inside the stage`, sc.card && sc.btn, JSON.stringify(sc));
  const sb2 = await rectOf('#btn-start');
  await tap(sb2.cx, sb2.cy, 2);
  const stakeIn = await ev(`(() => { const s = document.getElementById('stage').getBoundingClientRect();
    const card = document.querySelector('#overlay-stake .card');
    const r = card.getBoundingClientRect();
    const inside = (sel) => { const el = document.querySelector(sel); if (!el) return false;
      const b = el.getBoundingClientRect();
      return b.height > 0 && b.top >= s.top - 1 && b.bottom <= s.bottom + 1 && b.left >= s.left - 1 && b.right <= s.right + 1; };
    return { card: r.height > 0 && r.top >= s.top - 1 && r.bottom <= s.bottom + 1 && r.left >= s.left - 1 && r.right <= s.right + 1,
             noScroll: card.scrollHeight <= card.clientHeight + 1,
             head: inside('.target-head'), chips: inside('.target-chips'),
             need: inside('#target-need'), ape: inside('#btn-ape') }; })()`);
  check(`(4/5 ${tag} ${H}) ENTIRE stake card inside the stage: bar heading, target chips, need line, APE IN, no card scroll`,
    stakeIn.card && stakeIn.noScroll && stakeIn.head && stakeIn.chips && stakeIn.need && stakeIn.ape,
    JSON.stringify(stakeIn));
  const ap2 = await rectOf('#btn-ape');
  await tap(ap2.cx, ap2.cy, 2);
  check(`(4/5 ${tag} ${H}) tap flow reaches playing`, (await mode()) === 'playing');
  const gr = await rectOf('#game');
  check(`(4/5 ${tag} ${H}) run crashes to a game over`, await flyToOver(gr.cx, gr.cy));
  const st = await stackInsideStage();
  check(`(4/5 ${tag} ${H}) game-over stack fully inside the stage`, Object.values(st).every(Boolean), JSON.stringify(st));
  const inner = await pnlInnerFit();
  check(`(4/5 ${tag} ${H}) PnL tiles + footer not clipped inside the card`, inner.tilesGap >= 0 && inner.footGap >= 0,
    `tiles gap=${inner.tilesGap.toFixed(0)} foot gap=${inner.footGap.toFixed(0)}`);
}
await setHostile(false);

// (6) 4-digit hero + the longest bar pill the game can produce: a
// 4-digit score that still MISSES a +1900% bar (2000 pts needed), so
// the pill is the long missed-bar verdict and the hero burns red —
// graded against the bar now, not against the pinned 3050 last run
// (whose stored curve also exercises the chart's sub-line).
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await loadGame('seed=7&theme=dark');
await ev(`localStorage.setItem('pump-rider-best', '3050');
  localStorage.setItem('pump-rider-target', '1900');
  localStorage.setItem('pump-rider-last-run', JSON.stringify({ score: 3050, peakScore: 3050, orbs: 9, bestCombo: 3, duration: 40,
    samples: Array.from({ length: 41 }, (_, i) => ({ t: i, score: Math.round(3050 * i / 40) })) }));`);
await send('Page.reload', { ignoreCache: true });
for (let i = 0; i < 60 && !(await ev('!!window.__pumpRider').catch(() => false)); i++) await sleep(200);
await sleep(500);
const sb3 = await rectOf('#btn-start');
await tap(sb3.cx, sb3.cy, 2);
const ap3 = await rectOf('#btn-ape');
await tap(ap3.cx, ap3.cy, 2);
check('(6) regression run started', (await mode()) === 'playing');
// The engine derives the score from distance + orbs on every step, so
// a 4-digit score cannot be seeded — it has to be earned. Fly real
// runs (up to 4 attempts; a rug can end one early) until one banks
// 1050+, re-pinning the stored previous run to 3050 just before the
// final fall so the chart keeps its sub-line: a 4-digit hero next to
// the longest pill the game can print. This pilot rides higher
// (+122) and polls faster than the others: it must survive ~40s,
// rug bounces included, and plain bang-bang at +108 is marginal
// over that distance under CDP latency.
let banked = false;
for (let attempt = 0; attempt < 4 && !banked; attempt++) {
  if (attempt > 0) {
    // Run it back lands on the stake card now, never in a run: the
    // retry goes game over -> stake card -> APE IN, like a player.
    const again6 = await rectOf('#btn-again');
    await tap(again6.cx, again6.cy, 2);
    const back6 = await ev(`({ mode: window.__pumpRider.mode, stakeOpen: window.__pumpRider.stakeOpen })`);
    if (!(back6.mode === 'demo' && back6.stakeOpen)) break;
    const ape6 = await rectOf('#btn-ape');
    await tap(ape6.cx, ape6.cy, 2);
    if ((await mode()) !== 'playing') break;
  }
  const gr6 = await rectOf('#game');
  let holding6 = false;
  const dl6 = Date.now() + 60000;
  while (Date.now() < dl6) {
    const s = await flightState();
    if (s.mode !== 'playing' || s.crashed) break;
    if (s.score >= 1050) { banked = true; break; }
    const wantHold = s.y + s.vy * 0.32 < s.ahead + 122;
    if (wantHold && !holding6) { holding6 = true; await touchHoldStart(gr6.cx, gr6.cy, 6); }
    else if (!wantHold && holding6) { holding6 = false; await touchRelease(); }
    await sleep(70);
  }
  if (banked) {
    await ev(`localStorage.setItem('pump-rider-last-run', JSON.stringify({ score: 3050, peakScore: 3050, orbs: 9, bestCombo: 3, duration: 40,
      samples: Array.from({ length: 41 }, (_, i) => ({ t: i, score: Math.round(3050 * i / 40) })) }))`);
  }
  if (holding6) { await touchRelease(); holding6 = false; }
  let over6 = false;
  for (let i = 0; i < 50 && !over6; i++) { await sleep(300); over6 = await overVisibleNow(); }
  if (!over6) break;
}
check('(6) a real run banked a 4-digit score and closed', banked);
const geo = await ev(`(() => { const R = (el) => { const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
  const hero = R(document.querySelector('.pnl-hero'));
  const pill = R(document.getElementById('pnl-verdict'));
  const chip = R(document.getElementById('pnl-peak'));
  const paths = document.querySelectorAll('#pnl-chart path');
  const x = R(paths[paths.length - 1]);
  const hit = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  return { heroText: document.getElementById('pnl-score').textContent,
           heroColor: getComputedStyle(document.getElementById('pnl-score')).color,
           pillText: document.getElementById('pnl-verdict').textContent,
           heroPillHit: hit(hero, pill), pillBelow: pill.top >= hero.bottom - 1,
           chipXHit: hit(chip, x) }; })()`);
check('(6) hero is 4-digit and the pill is the long missed-bar verdict',
  /^\+\d{4}$/.test(geo.heroText) && /MISSED THE BAR · [\d.]+x of 20x/.test(geo.pillText),
  `${geo.heroText} / ${geo.pillText}`);
check('(6) the missed bar turns the 4-digit hero red', geo.heroColor === 'rgb(255, 82, 82)', geo.heroColor);
check('(6) hero and verdict pill do not intersect (pill stacked under the hero)', !geo.heroPillHit && geo.pillBelow);
check('(6) HIGH chip does not sit under the crash X', !geo.chipXHit);
const png6 = await ev(`window.__pumpRider.pnlCardPng()`);
check('(6) PNG painter renders the 4-digit card', typeof png6 === 'string' && png6.length > 20000,
  png6 ? `${png6.length} chars` : 'null');
if (png6) {
  writeFileSync(new URL('pnl-4digit.png', import.meta.url), Buffer.from(png6.split(',')[1], 'base64'));
  console.log('screenshot -> pnl-4digit.png');
}

// =======================================================================
// (8) THE BAR ROUND — 390x660: the whole stake card, the target
// picker, a flown WIN card, run-it-back, a crashed LOSS card, reset.
// =======================================================================
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 660, deviceScaleFactor: 2, mobile: true });
await loadGame('seed=7&theme=dark');
const sb8 = await rectOf('#btn-start');
await tap(sb8.cx, sb8.cy, 2);
const stakeFit = await ev(`(() => { const s = document.getElementById('stage').getBoundingClientRect();
  const card = document.querySelector('#overlay-stake .card');
  const cr = card.getBoundingClientRect();
  const inside = (sel) => { const el = document.querySelector(sel); if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.height > 0 && r.top >= s.top - 1 && r.bottom <= s.bottom + 1 && r.left >= s.left - 1 && r.right <= s.right + 1; };
  return { cardIn: cr.top >= s.top - 1 && cr.bottom <= s.bottom + 1 && cr.left >= s.left - 1 && cr.right <= s.right + 1,
    noScroll: card.scrollHeight <= card.clientHeight + 1,
    head: inside('.target-head'), chips: inside('.target-chips'), need: inside('#target-need'),
    ape: inside('#btn-ape'), amount: inside('.stake-amountrow'),
    headText: document.querySelector('.target-head').textContent }; })()`);
check('(8a) at 390x660 the ENTIRE stake card is inside the stage without scrolling',
  stakeFit.cardIn && stakeFit.noScroll, JSON.stringify(stakeFit));
check('(8a2) the bar picker is unmissable: own "call your bar" heading, chips, need line, APE IN all visible',
  stakeFit.head && stakeFit.chips && stakeFit.need && stakeFit.ape && stakeFit.amount &&
  stakeFit.headText === 'call your bar', JSON.stringify(stakeFit));
const chip200 = await rectOf('.target-chip[data-target="200"]');
await tap(chip200.cx, chip200.cy, 2);
const pick = await ev(`(() => ({ need: document.getElementById('target-need').textContent,
  stored: localStorage.getItem('pump-rider-target'), target: window.__pumpRider.target,
  active: document.querySelector('.target-chip.active')?.dataset.target }))()`);
check('(8b) tapping +200% selects it, updates the need line, persists it',
  pick.need === 'you need 300 pts to clear the bar' && pick.stored === '200' && pick.target === 200 && pick.active === '200',
  JSON.stringify(pick));
const chip400 = await rectOf('.target-chip[data-target="400"]');
await tap(chip400.cx, chip400.cy, 2);
const pick400 = await ev(`document.getElementById('target-need').textContent`);
check('(8b2) +400% moves the need line to 500 pts', pick400 === 'you need 500 pts to clear the bar', pick400);
await shot('stake-card-660.png');

// (8c) A flown WIN: call the +50% bar (150 pts), fly past it, crash.
const chip50t = await rectOf('.target-chip[data-target="50"]');
await tap(chip50t.cx, chip50t.cy, 2);
const ape8 = await rectOf('#btn-ape');
await tap(ape8.cx, ape8.cy, 2);
check('(8c) APE IN starts the win attempt', (await mode()) === 'playing');
async function flyUntilScore(minScore, cx, cy) {
  let holding = false;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const s = await flightState();
    if (s.mode !== 'playing' || s.crashed) break;
    if (s.score >= minScore) break;
    const wantHold = s.y + s.vy * 0.32 < s.ahead + 108;
    if (wantHold && !holding) { holding = true; await touchHoldStart(cx, cy, 6); }
    else if (!wantHold && holding) { holding = false; await touchRelease(); }
    await sleep(90);
  }
  if (holding) { await touchRelease(); holding = false; }
  for (let i = 0; i < 50; i++) { await sleep(300); if (await overVisibleNow()) return true; }
  return false;
}
const gr8 = await rectOf('#game');
check('(8c) the flown run cleared the bar and closed', await flyUntilScore(220, gr8.cx, gr8.cy));
const winCard = await ev(`(() => { const P = window.__pumpRider; const card = P.lastCard;
  const svg = document.getElementById('pnl-chart');
  const el = document.getElementById('pnl-card');
  return { win: card.win, cls: el.className, shadow: getComputedStyle(el).boxShadow,
    pill: document.getElementById('pnl-verdict').textContent,
    gain: document.getElementById('pnl-gain').textContent,
    money: document.getElementById('pnl-money').textContent,
    vs: document.getElementById('pnl-vs').textContent, vsModel: card.vsPrevText,
    heroColor: getComputedStyle(document.getElementById('pnl-score')).color,
    targetLine: !!svg.querySelector('.target-line'), prevLine: !!svg.querySelector('.prev-line'),
    target: card.target }; })()`);
check('(8d) WIN card: green identity + glow, bar-cleared pill, money gain, note line, two-line chart',
  winCard.win === true && winCard.cls.includes('win') && winCard.shadow !== 'none' &&
  winCard.pill.startsWith('BAR CLEARED') && winCard.gain.startsWith('+') &&
  winCard.heroColor === 'rgb(255, 200, 55)' && winCard.vs === winCard.vsModel &&
  winCard.targetLine && winCard.prevLine && winCard.target === 50,
  JSON.stringify(winCard));
await shot('gameover-win.png');

// (8e) Run it back: back to the stake card, picks kept, NO auto-start.
const again8 = await rectOf('#btn-again');
await tap(again8.cx, again8.cy, 2);
const back = await ev(`(() => ({ mode: window.__pumpRider.mode, stakeOpen: window.__pumpRider.stakeOpen,
  target: window.__pumpRider.target,
  overShown: !document.getElementById('overlay-over').classList.contains('hidden') }))()`);
check('(8e) run it back returns to the STAKE card (no auto-start) with the last bar kept',
  back.mode === 'demo' && back.stakeOpen === true && !back.overShown && back.target === 50,
  JSON.stringify(back));

// (8f) A crashed LOSS: call +1900% and never touch the button.
const chip1900 = await rectOf('.target-chip[data-target="1900"]');
await tap(chip1900.cx, chip1900.cy, 2);
const ape8b = await rectOf('#btn-ape');
await tap(ape8b.cx, ape8b.cy, 2);
check('(8f) APE IN starts the doomed run', (await mode()) === 'playing');
let over8 = false;
for (let i = 0; i < 40 && !over8; i++) { await sleep(300); over8 = await overVisibleNow(); }
check('(8f) the untouched run crashed to game over', over8);
const lossCard = await ev(`(() => { const P = window.__pumpRider; const card = P.lastCard;
  const el = document.getElementById('pnl-card');
  return { win: card.win, cls: el.className, shadow: getComputedStyle(el).boxShadow,
    pill: document.getElementById('pnl-verdict').textContent,
    gain: document.getElementById('pnl-gain').textContent,
    money: document.getElementById('pnl-money').textContent,
    heroColor: getComputedStyle(document.getElementById('pnl-score')).color,
    stake: card.stake, payout: card.payout, pnl: card.pnl }; })()`);
check('(8g) LOSS card: red identity + glow, missed-bar pill, -100% gain, OUT $0, hero red',
  lossCard.win === false && lossCard.cls.includes('loss') && lossCard.shadow !== 'none' &&
  lossCard.pill.startsWith('MISSED THE BAR') && lossCard.gain === '−100%' &&
  lossCard.payout === 0 && lossCard.pnl === -lossCard.stake &&
  lossCard.money.includes('→ OUT $0 · ') && lossCard.heroColor === 'rgb(255, 82, 82)',
  JSON.stringify(lossCard));
await shot('gameover-loss.png');
const pngLoss = await ev(`window.__pumpRider.pnlCardPng()`);
check('(8h) PNG painter renders the LOSS card', typeof pngLoss === 'string' && pngLoss.length > 20000,
  pngLoss ? `${pngLoss.length} chars` : 'null');
if (pngLoss) {
  writeFileSync(new URL('pnl-loss.png', import.meta.url), Buffer.from(pngLoss.split(',')[1], 'base64'));
  console.log('screenshot -> pnl-loss.png');
}

// (8i-8l) The two-step reset: arm, disarm by other tap, disarm by
// timeout, then execute and verify the wipe.
const resetBtn = await rectOf('#btn-reset');
await tap(resetBtn.cx, resetBtn.cy, 2);
const armed = await ev(`(() => ({ armed: window.__pumpRider.resetArmed,
  label: document.getElementById('btn-reset').textContent,
  best: localStorage.getItem('pump-rider-best'), lastRun: localStorage.getItem('pump-rider-last-run') !== null }))()`);
check('(8i) first reset tap arms it and wipes nothing',
  armed.armed === true && armed.label === 'sure? tap again to wipe' && armed.best !== null && armed.lastRun,
  JSON.stringify(armed));
const title8 = await rectOf('#over-title');
await tap(title8.cx, title8.cy, 2);
const disarmed = await ev(`(() => ({ armed: window.__pumpRider.resetArmed,
  label: document.getElementById('btn-reset').textContent,
  best: localStorage.getItem('pump-rider-best') }))()`);
check('(8j) any other tap disarms the wipe',
  disarmed.armed === false && disarmed.label === 'reset' && disarmed.best !== null,
  JSON.stringify(disarmed));
const resetBtn2 = await rectOf('#btn-reset');
await tap(resetBtn2.cx, resetBtn2.cy, 2);
await sleep(3900);
check('(8k) the armed wipe times out on its own', (await ev(`window.__pumpRider.resetArmed`)) === false);
const resetBtn3 = await rectOf('#btn-reset');
await tap(resetBtn3.cx, resetBtn3.cy, 2);
const resetBtn4 = await rectOf('#btn-reset');
await tap(resetBtn4.cx, resetBtn4.cy, 2);
const wiped = await ev(`(() => ({ keys: ['pump-rider-best', 'pump-rider-last-run', 'pump-rider-stake', 'pump-rider-target', 'pump-rider-settings'].map((k) => localStorage.getItem(k)),
  startShown: !document.getElementById('overlay-start').classList.contains('hidden'),
  overShown: !document.getElementById('overlay-over').classList.contains('hidden'),
  mode: window.__pumpRider.mode, best: window.__pumpRider.best,
  hudBest: document.getElementById('stat-best').textContent,
  presetName: document.querySelector('#overlay-start .preset-name').textContent }))()`);
check('(8l) second tap wipes EVERYTHING and returns to the start card at factory defaults',
  wiped.keys.every((v) => v === null) && wiped.startShown && !wiped.overShown &&
  wiped.mode === 'demo' && wiped.best === 0 && wiped.hudBest === '0' && wiped.presetName === 'Chill',
  JSON.stringify(wiped));

// (8m) Fresh boot after the wipe: the defaults are the boot state.
await loadGame('seed=7&theme=dark');
const sb8f = await rectOf('#btn-start');
await tap(sb8f.cx, sb8f.cy, 2);
const fresh = await ev(`(() => ({ amount: document.getElementById('stake-amount').textContent,
  ape: document.getElementById('btn-ape').textContent,
  activeStake: document.querySelector('.stake-chip.active')?.dataset.stake,
  activeTarget: document.querySelector('.target-chip.active')?.dataset.target,
  need: document.getElementById('target-need').textContent,
  stake: window.__pumpRider.stake, target: window.__pumpRider.target }))()`);
check('(8m) fresh boot after the wipe: $10 stake, +200% bar, 300 pts to clear',
  fresh.amount === '$10' && fresh.ape === 'APE IN $10' && fresh.activeStake === '10' &&
  fresh.activeTarget === '200' && fresh.need === 'you need 300 pts to clear the bar' &&
  fresh.stake === 10 && fresh.target === 200, JSON.stringify(fresh));

// =======================================================================
// (9) VOLATILITY READOUT + IMAGE SHARE — still 390x660, stake card
// open from (8m) at factory defaults (Chill: factor x0.90).
// =======================================================================
const volStake0 = await ev(`document.querySelector('.vol-line.stake-vol').textContent`);
check('(9a) the stake card shows the derived volatility readout at the Chill default',
  volStake0 === 'VOLATILITY MEDIUM · PAYOUT x0.90', volStake0);
const ngmi9 = await rectOf('#btn-ngmi');
await tap(ngmi9.cx, ngmi9.cy, 2);
const startSetBtn = await rectOf('#btn-start-settings');
await tap(startSetBtn.cx, startSetBtn.cy, 2);
await ev(`(() => { const sl = document.querySelector('#start-settings-body .js-slider[data-setting="speed"]');
  sl.value = '1.5'; sl.dispatchEvent(new Event('input', { bubbles: true })); sl.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
const volStart = await ev(`document.querySelector('#start-settings-body .vol-line').textContent`);
// Collapse the panel again before starting: expanded, the start
// card outgrows the 660 stage and the Start button leaves the tap
// area (a (9b) false start taught us this).
const startSetBtn2 = await rectOf('#btn-start-settings');
await tap(startSetBtn2.cx, startSetBtn2.cy, 2);
const sb9 = await rectOf('#btn-start');
await tap(sb9.cx, sb9.cy, 2);
const volStake1 = await ev(`document.querySelector('.vol-line.stake-vol').textContent`);
check('(9b) moving a slider rewrites EVERY volatility readout live (start panel and stake card agree)',
  volStart === volStake1 && volStart === 'VOLATILITY MEDIUM · PAYOUT x1.00',
  `start=${volStart} stake=${volStake1}`);
check('(9b2) Start riding opened the stake card', (await ev(`window.__pumpRider.stakeOpen`)) === true);

// A quick crashed run to have a card worth sharing.
const ape9 = await rectOf('#btn-ape');
await tap(ape9.cx, ape9.cy, 2);
check('(9c) APE IN starts the share-test run', (await mode()) === 'playing');
// The visible pause control: present during play, inside the stage,
// a real hit area, clear of the header HUD; the tap path pauses,
// resumes via the same button (now ▶), pauses again, and resumes
// via the veil's own Resume control.
const pauseBtn = await ev(`(() => { const b = document.getElementById('btn-pause-stage');
  const r = b.getBoundingClientRect(); const s = document.getElementById('stage').getBoundingClientRect();
  const hud = document.querySelector('.stats').getBoundingClientRect();
  return { shown: getComputedStyle(b).display !== 'none', label: b.textContent,
    w: r.width, h: r.height, inStage: r.top >= s.top && r.bottom <= s.bottom && r.left >= s.left && r.right <= s.right,
    hudClear: r.bottom <= hud.top || r.top >= hud.bottom }; })()`);
check('(9c2) the stage pause button shows during play: ⏸, >=36px, inside the stage, clear of the HUD',
  pauseBtn.shown && pauseBtn.label === '⏸' && pauseBtn.w >= 36 && pauseBtn.h >= 36 &&
  pauseBtn.inStage && pauseBtn.hudClear, JSON.stringify(pauseBtn));
const pb1 = await rectOf('#btn-pause-stage');
await tap(pb1.cx, pb1.cy, 2);
const pausedOnce = await ev(`(() => ({ paused: window.__pumpRider.paused,
  label: document.getElementById('btn-pause-stage').textContent,
  veil: !document.getElementById('paused-banner').classList.contains('hidden') }))()`);
check('(9c3) tapping ⏸ pauses: the button flips to ▶ and the veil shows',
  pausedOnce.paused === true && pausedOnce.label === '▶' && pausedOnce.veil, JSON.stringify(pausedOnce));
const pb2 = await rectOf('#btn-pause-stage');
await tap(pb2.cx, pb2.cy, 2);
check('(9c4) tapping ▶ (same button, above the veil) resumes', (await ev(`window.__pumpRider.paused`)) === false);
const pb3 = await rectOf('#btn-pause-stage');
await tap(pb3.cx, pb3.cy, 2);
const resumeBtn = await rectOf('#btn-resume');
await tap(resumeBtn.cx, resumeBtn.cy, 2);
check('(9c5) pausing again, the veil\u2019s own Resume control resumes',
  (await ev(`window.__pumpRider.paused`)) === false);
let over9 = false;
for (let i = 0; i < 40 && !over9; i++) { await sleep(300); over9 = await overVisibleNow(); }
check('(9c) the untouched run crashed to game over', over9);

// Downloads land in a watched folder so "no download happened" is
// provable, not assumed.
const dlDir = mkdtempSync(join(tmpdir(), 'pr-dl-'));
await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dlDir });
const dlFiles = () => readdirSync(dlDir).filter((f) => f.endsWith('.png'));
await ev(`(() => { window.__shareCalls = []; window.__opened = [];
  Object.defineProperty(window, 'open', { configurable: true, value: (u) => { window.__opened.push(String(u)); return null; } });
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
  Object.defineProperty(navigator, 'share', { configurable: true, value: (d) => {
    window.__shareCalls.push({ nFiles: (d.files || []).length,
      name: d.files && d.files[0] ? d.files[0].name : null,
      type: d.files && d.files[0] ? d.files[0].type : null, text: d.text });
    return Promise.resolve(); } });
  return true; })()`);
const shareBtn = await rectOf('#btn-share');
await tap(shareBtn.cx, shareBtn.cy, 2);
await sleep(900);
const sharePref = await ev(`(() => ({ calls: window.__shareCalls, opened: window.__opened,
  text: window.__pumpRider.lastCard.shareText }))()`);
check('(9d) preferred share: exactly one image/png File named pump-rider-pnl.png plus the share text',
  sharePref.calls.length === 1 && sharePref.calls[0].nFiles === 1 &&
  sharePref.calls[0].name === 'pump-rider-pnl.png' && sharePref.calls[0].type === 'image/png' &&
  sharePref.calls[0].text === sharePref.text, JSON.stringify(sharePref.calls));
check('(9d2) preferred share opens no intent and downloads nothing',
  sharePref.opened.length === 0 && dlFiles().length === 0,
  `opened=${sharePref.opened.length} downloads=${dlFiles().length}`);
await ev(`(() => { Object.defineProperty(navigator, 'share', { configurable: true,
  value: () => Promise.reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })) }); return true; })()`);
const shareBtn2 = await rectOf('#btn-share');
await tap(shareBtn2.cx, shareBtn2.cy, 2);
await sleep(700);
const shareAbort = await ev(`(() => ({ opened: window.__opened,
  toast: document.getElementById('toast').textContent }))()`);
check('(9e) a cancelled share (AbortError) is silent: no intent, no download, no hint',
  shareAbort.opened.length === 0 && dlFiles().length === 0 && shareAbort.toast === '',
  JSON.stringify(shareAbort));
await ev(`(() => { Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => false }); return true; })()`);
const shareBtn3 = await rectOf('#btn-share');
await tap(shareBtn3.cx, shareBtn3.cy, 2);
await sleep(1200);
const shareFb = await ev(`(() => ({ opened: window.__opened,
  toast: document.getElementById('toast').textContent }))()`);
check('(9f) fallback share: the PNG downloads, the X intent opens, the attach hint shows',
  dlFiles().length >= 1 && shareFb.opened.length === 1 &&
  shareFb.opened[0].startsWith('https://x.com/intent/tweet?text=') &&
  shareFb.toast === 'card saved. attach it to your post.',
  `downloads=${dlFiles().length} opened=${JSON.stringify(shareFb.opened).slice(0, 90)} toast=${shareFb.toast}`);

// =======================================================================
// (10) CURRENCY SWITCH — from the (9) game-over card.
// =======================================================================
const again10 = await rectOf('#btn-again');
await tap(again10.cx, again10.cy, 2);
const usdState = await ev(`(() => ({ currency: window.__pumpRider.currency,
  amount: document.getElementById('stake-amount').textContent,
  usdActive: document.getElementById('cur-usd').classList.contains('active'),
  rateHidden: document.getElementById('cur-rate').classList.contains('hidden') }))()`);
check('(10a) the stake card opens in dollars: toggle on $, rate line hidden',
  usdState.currency === 'usd' && usdState.amount === '$10' && usdState.usdActive && usdState.rateHidden,
  JSON.stringify(usdState));
const curNearBtn = await rectOf('#cur-near');
await tap(curNearBtn.cx, curNearBtn.cy, 2);
const nearState = await ev(`(() => ({ currency: window.__pumpRider.currency,
  amount: document.getElementById('stake-amount').textContent,
  ape: document.getElementById('btn-ape').textContent,
  rateHidden: document.getElementById('cur-rate').classList.contains('hidden'),
  rate: document.getElementById('cur-rate').textContent,
  storedCur: localStorage.getItem('pump-rider-currency'), storedStake: localStorage.getItem('pump-rider-stake'),
  chip250: document.querySelector('.stake-chip[data-stake="250"]')?.textContent,
  chip1000: !!document.querySelector('.stake-chip[data-stake="1000"]') }))()`);
check('(10b) switching to NEAR converts $10 to 2.75 NEAR, swaps the ladder, shows the honest rate line, persists both',
  nearState.currency === 'near' && nearState.amount === '2.75 NEAR' && nearState.ape === 'APE IN 2.75 NEAR' &&
  !nearState.rateHidden && nearState.rate === '1 near ≈ $3.63 · reference rate, nov 7' &&
  nearState.storedCur === 'near' && nearState.storedStake === '2.75' &&
  nearState.chip250 === '250 NEAR' && !nearState.chip1000, JSON.stringify(nearState));
const nearFit = await ev(`(() => { const s = document.getElementById('stage').getBoundingClientRect();
  const card = document.querySelector('#overlay-stake .card');
  const cr = card.getBoundingClientRect();
  const inside = (sel) => { const el = document.querySelector(sel); if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.height > 0 && r.top >= s.top - 1 && r.bottom <= s.bottom + 1 && r.left >= s.left - 1 && r.right <= s.right + 1; };
  return { cardIn: cr.top >= s.top - 1 && cr.bottom <= s.bottom + 1 && cr.left >= s.left - 1 && cr.right <= s.right + 1,
    noScroll: card.scrollHeight <= card.clientHeight + 1,
    toggle: inside('.cur-toggle'), rate: inside('#cur-rate'), ape: inside('#btn-ape') }; })()`);
check('(10b2) at 390x660 the NEAR stake card (toggle + rate line + APE IN) is fully inside, nothing scrolls',
  nearFit.cardIn && nearFit.noScroll && nearFit.toggle && nearFit.rate && nearFit.ape,
  JSON.stringify(nearFit));
const plus10 = await rectOf('#btn-stake-plus');
await tap(plus10.cx, plus10.cy, 2);
const stepped = await ev(`document.getElementById('stake-amount').textContent`);
check('(10c) the NEAR stepper steps 0.5 under 10', stepped === '3.25 NEAR', stepped);
const chip50n = await rectOf('.stake-chip[data-stake="50"]');
await tap(chip50n.cx, chip50n.cy, 2);
const plus10b = await rectOf('#btn-stake-plus');
await tap(plus10b.cx, plus10b.cy, 2);
const stepped2 = await ev(`document.getElementById('stake-amount').textContent`);
check('(10c2) the 50 NEAR chip picks 50 and the stepper steps 5 above 10',
  stepped2 === '55 NEAR', stepped2);
await loadGame('seed=7&theme=dark');
const sb10 = await rectOf('#btn-start');
await tap(sb10.cx, sb10.cy, 2);
const persisted = await ev(`(() => ({ currency: window.__pumpRider.currency,
  amount: document.getElementById('stake-amount').textContent,
  storedStake: localStorage.getItem('pump-rider-stake') }))()`);
check('(10d) currency and NEAR stake persist across a reload',
  persisted.currency === 'near' && persisted.amount === '55 NEAR' && persisted.storedStake === '55',
  JSON.stringify(persisted));
const ape10 = await rectOf('#btn-ape');
await tap(ape10.cx, ape10.cy, 2);
let over10 = false;
for (let i = 0; i < 40 && !over10; i++) { await sleep(300); over10 = await overVisibleNow(); }
check('(10e) the NEAR run crashed to game over', over10);
const nearStrip = await ev(`(() => ({ money: document.getElementById('pnl-money').textContent,
  currency: window.__pumpRider.lastCard.currency }))()`);
check('(10e2) the NEAR card settles in NEAR with the pnl dollar equivalent appended',
  nearStrip.currency === 'near' && nearStrip.money.includes('IN 55 NEAR → OUT 0 NEAR') &&
  nearStrip.money.includes('−55 NEAR') && nearStrip.money.includes('≈ −$200'),
  JSON.stringify(nearStrip));
const again10b = await rectOf('#btn-again');
await tap(again10b.cx, again10b.cy, 2);
const curUsdBtn = await rectOf('#cur-usd');
await tap(curUsdBtn.cx, curUsdBtn.cy, 2);
const backUsd = await ev(`(() => ({ currency: window.__pumpRider.currency,
  amount: document.getElementById('stake-amount').textContent,
  storedCur: localStorage.getItem('pump-rider-currency') }))()`);
check('(10f) switching back converts 55 NEAR to the log-nearest dollar rung ($100) and persists usd',
  backUsd.currency === 'usd' && backUsd.amount === '$100' && backUsd.storedCur === 'usd',
  JSON.stringify(backUsd));
// (10g) The reset restores dollars too: flip to NEAR, crash, wipe.
const curNearBtn2 = await rectOf('#cur-near');
await tap(curNearBtn2.cx, curNearBtn2.cy, 2);
const ape10g = await rectOf('#btn-ape');
await tap(ape10g.cx, ape10g.cy, 2);
let over10g = false;
for (let i = 0; i < 40 && !over10g; i++) { await sleep(300); over10g = await overVisibleNow(); }
check('(10g) the pre-wipe NEAR run crashed to game over', over10g);
const resetG1 = await rectOf('#btn-reset');
await tap(resetG1.cx, resetG1.cy, 2);
const resetG2 = await rectOf('#btn-reset');
await tap(resetG2.cx, resetG2.cy, 2);
const sb10g = await rectOf('#btn-start');
await tap(sb10g.cx, sb10g.cy, 2);
const afterWipe = await ev(`(() => ({ currency: window.__pumpRider.currency,
  storedCur: localStorage.getItem('pump-rider-currency'),
  amount: document.getElementById('stake-amount').textContent,
  usdActive: document.getElementById('cur-usd').classList.contains('active'),
  rateHidden: document.getElementById('cur-rate').classList.contains('hidden') }))()`);
check('(10g2) after the wipe the currency is dollars again, $10, rate line hidden',
  afterWipe.currency === 'usd' && afterWipe.storedCur === null && afterWipe.amount === '$10' &&
  afterWipe.usdActive && afterWipe.rateHidden, JSON.stringify(afterWipe));

ws.close();
chrome.kill();
server.close();
console.log(failures === 0 ? '\nALL LAYOUT CHECKS PASSED' : `\n${failures} LAYOUT CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
