// touch-cdp.mjs — headless verification for the mobile fix round.
// Drives dist/pump-rider.html in real Chrome via CDP with REAL touch
// events (Input.dispatchTouchEvent) at a 390x844 phone viewport, and
// asserts the four reported issues are fixed:
//   (a) menu scene frozen (no simulation while in the menu),
//   (b) touch-hold pumps / touch-release drops — including the FIRST
//       hold right after APE IN, the one the old click-armed latch ate,
//   (c) tap menu -> stake card (un-started) -> tap APE IN -> playing,
//   (d) the five HUD boxes sit on one row at 390px,
//   (e) crossing the stored best lights the BEST box up live.
// Plus a desktop mouse pass for the gameplay screenshot.
// Run: node verification/touch-cdp.mjs   (needs Chrome; see CHROME_CANDIDATES)

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = 8931;
const CDP_PORT = 9337;
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

// ---- static server for the project dir --------------------------------
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

// ---- Chrome + CDP ------------------------------------------------------
const profile = mkdtempSync(join(tmpdir(), 'pr-cdp-'));
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
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(new URL(name, import.meta.url), Buffer.from(r.result.data, 'base64'));
  console.log('screenshot ->', name);
};

const URL_GAME = `http://127.0.0.1:${PORT}/dist/pump-rider.html?seed=7&theme=dark`;
async function loadGame() {
  await send('Page.navigate', { url: URL_GAME });
  for (let i = 0; i < 60; i++) {
    if (await ev('!!window.__pumpRider').catch(() => false)) return;
    await sleep(200);
  }
  throw new Error('game never booted');
}
const state = () => ev(`(() => { const P = window.__pumpRider, g = P.game; return {
  mode: P.mode, stakeOpen: P.stakeOpen, thrustHeld: P.thrustHeld,
  x: g.x, y: g.y, vy: g.vy, time: g.time, score: g.score, crashed: g.crashed,
  ahead: Math.max(P.terrainHeightAt(g.x), P.terrainHeightAt(g.x + 70), P.terrainHeightAt(g.x + 140)),
}; })()`);
const rectOf = (sel) => ev(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }; })()`);

async function tap(x, y, id = 1) {
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id }] });
  await sleep(70);
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(120);
}
const touchHoldStart = (x, y, id) => send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y, id }] });
const touchRelease = () => send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

// =======================================================================
// MOBILE PASS — 390x844, touch emulation on
// =======================================================================
await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await loadGame();

// Seed a small stored best (30) so the crossing is reachable in seconds.
await ev(`localStorage.setItem('pump-rider-best', '30')`);
await send('Page.reload', { ignoreCache: true });
for (let i = 0; i < 60 && !(await ev('!!window.__pumpRider').catch(() => false)); i++) await sleep(200);
await sleep(300);
check('stored best seeded', (await ev(`document.getElementById('stat-best').textContent`)) === '30');

// (a) Menu is frozen: no simulation advances behind the start card.
const m1 = await state();
await sleep(2000);
const m2 = await state();
check('(a) menu frozen: x/time/score unchanged over 2s',
  m1.mode === 'demo' && m2.mode === 'demo' && m1.x === m2.x && m1.time === m2.time && m1.score === m2.score,
  `x ${m1.x} -> ${m2.x}, time ${m1.time} -> ${m2.time}`);

// (d) HUD: all five stat boxes share one row at 390px.
const tops = await ev(`[...document.querySelectorAll('.stat')].map((el) => Math.round(el.getBoundingClientRect().top))`);
check('(d) HUD one row at 390px', tops.length === 5 && Math.max(...tops) - Math.min(...tops) <= 1, `tops=${tops}`);
await shot('hud-mobile.png');

// Backdrop tap path: if a free point exists on the start overlay (not
// the card), tapping it must open the stake card, game un-started.
const probe = await ev(`(() => { const s = document.getElementById('stage').getBoundingClientRect();
  const x = s.left + s.width / 2, y = s.top + 8; const el = document.elementFromPoint(x, y);
  return { x, y, isBackdrop: !!el && el.id === 'overlay-start' }; })()`);
if (probe.isBackdrop) {
  await tap(probe.x, probe.y, 3);
  const s = await state();
  check('(c1) backdrop tap opens the stake card, game un-started', s.stakeOpen === true && s.mode === 'demo');
  const ngmi = await rectOf('#btn-ngmi');
  await tap(ngmi.x, ngmi.y, 3);
  check('(c1) ngmi closes the stake card back to menu', (await state()).stakeOpen === false);
} else {
  console.log('SKIP - (c1) no free backdrop point at this viewport (card covers the stage)');
}

// (c) Start riding -> stake card -> APE IN -> playing.
const startBtn = await rectOf('#btn-start');
await tap(startBtn.x, startBtn.y, 4);
{
  const s = await state();
  check('(c2) tap Start riding opens the stake card, game un-started', s.stakeOpen === true && s.mode === 'demo');
}
await shot('stake-card.png');
// Precompute the canvas point BEFORE starting: after APE IN the first
// hold must land fast, exactly like a player's finger would. (Spawn is
// 148 units above the chart; at Chill gravity an idle rocket has
// ~0.45s before the dive becomes unrecoverable, so a test that idles
// for half a second first is testing its own delay, not the game.)
const game = await rectOf('#game');
const gx = game.x, gy = game.y;
const ape = await rectOf('#btn-ape');
await tap(ape.x, ape.y, 4);
{
  const s = await state();
  check('(c3) tap APE IN starts the run', s.mode === 'playing' && s.stakeOpen === false && !s.crashed);
}

// (b) THE regression: the first touch-hold after APE IN must pump.
await touchHoldStart(gx, gy, 5);
await sleep(150);
const heldEarly = await state();
await sleep(400);
const heldLate = await state();
check('(b1) first hold after APE IN registers thrust immediately',
  heldEarly.thrustHeld === true && heldLate.thrustHeld === true,
  `thrustHeld early=${heldEarly.thrustHeld} late=${heldLate.thrustHeld}`);
check('(b2) held rocket climbs (engine y up, vy up)',
  heldLate.vy > 30 && !heldLate.crashed,
  `vy=${heldLate.vy.toFixed(0)} y=${heldLate.y.toFixed(0)}`);
await touchRelease();
await sleep(600);
const afterRelease = await state();
check('(b3) release drops the rocket (vy down, thrust off)',
  afterRelease.thrustHeld === false && afterRelease.vy < -30 && !afterRelease.crashed,
  `vy=${afterRelease.vy.toFixed(0)}`);

// (e) Bang-bang touch controller: fly until the score crosses best=30,
// then the BEST box must be lit. Also harvest climb/fall evidence.
let holding = false;
let sawClimb = false, sawFall = false, crossed = null;
const deadline = Date.now() + 40000;
while (Date.now() < deadline) {
  const s = await state();
  if (s.mode !== 'playing' || s.crashed) break;
  if (holding && s.vy > 50) sawClimb = true;
  if (!holding && s.vy < -50) sawFall = true;
  if (s.score > 30) { crossed = s; break; }
  const wantHold = s.y + s.vy * 0.32 < s.ahead + 108;
  if (wantHold && !holding) { holding = true; await touchHoldStart(gx, gy, 9); }
  else if (!wantHold && holding) { holding = false; await touchRelease(); }
  await sleep(90);
}
if (holding) { await touchRelease(); holding = false; }
check('(e1) touch controller flew the run past the old best', !!crossed && crossed.mode === 'playing' && !crossed.crashed,
  crossed ? `score=${crossed.score}` : 'never crossed / crashed');
check('(e2) controller evidence: climbed under touch, fell on release', sawClimb && sawFall);
await sleep(150);
const beaten = await ev(`document.getElementById('stat-best-box').classList.contains('beaten')`);
const bestShown = await ev(`document.getElementById('stat-best').textContent`);
check('(e3) BEST box lit up live at the crossing', beaten === true && Number(bestShown) > 30,
  `beaten=${beaten} bestShown=${bestShown}`);

// =======================================================================
// DESKTOP PASS — mouse parity + gameplay screenshot
// =======================================================================
await send('Emulation.setTouchEmulationEnabled', { enabled: false });
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
await loadGame();
await sleep(300);
const click = async (x, y) => {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(60);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(120);
};
const dStart = await rectOf('#btn-start');
await click(dStart.x, dStart.y);
const dApe = await rectOf('#btn-ape');
await click(dApe.x, dApe.y);
await sleep(200);
check('(f1) mouse: click flow reaches playing', (await state()).mode === 'playing');
const dGame = await rectOf('#game');
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: dGame.x, y: dGame.y, button: 'left', clickCount: 1 });
await sleep(550);
const dHeld = await state();
check('(f2) mouse: first hold after APE IN pumps (no eaten hold)', dHeld.thrustHeld === true && dHeld.vy > 30 && !dHeld.crashed,
  `vy=${dHeld.vy.toFixed(0)}`);
await shot('gameplay-dark.png');
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: dGame.x, y: dGame.y, button: 'left', clickCount: 1 });

ws.close();
chrome.kill();
server.close();
console.log(failures === 0 ? '\nALL CDP TOUCH CHECKS PASSED' : `\n${failures} CDP CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
