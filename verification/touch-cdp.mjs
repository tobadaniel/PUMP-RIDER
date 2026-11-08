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

const URL_GAME = `http://127.0.0.1:${PORT}${process.env.PR_BUNDLE || '/dist/pump-rider.html'}?seed=7&theme=dark`;
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
// FIELD REPORTS — iOS hardening proofs: the help strip scrolls in
// BOTH directions, a hold that starts inside the strip never pumps,
// and a steady canvas hold never pulses (zero dropped samples).
// =======================================================================
await loadGame();
async function touchDrag(x, y1, y2, id = 9) {
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y1, id }] });
  const steps = 6;
  for (let i = 1; i <= steps; i++) {
    await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: Math.round(y1 + (y2 - y1) * (i / steps)), id }] });
    await sleep(45);
  }
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(400);
}
const stripBox = await ev(`(() => { const ol = document.querySelector('.howto ol'); const r = ol.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, sh: ol.scrollHeight, ch: ol.clientHeight }; })()`);
check('(g0) the help strip is a real scroll box at 390px', stripBox.sh > stripBox.ch + 10,
  `sh=${stripBox.sh} ch=${stripBox.ch}`);
await touchDrag(stripBox.x, stripBox.y + 18, stripBox.y - 34);
const downTop = await ev(`document.querySelector('.howto ol').scrollTop`);
check('(g1) a drag up inside the strip scrolls it down', downTop > 4, `scrollTop=${downTop}`);
await touchDrag(stripBox.x, stripBox.y - 18, stripBox.y + 34);
const upTop = await ev(`document.querySelector('.howto ol').scrollTop`);
check('(g2) a drag down inside the strip scrolls it back UP', upTop < downTop - 4,
  `scrollTop ${downTop} -> ${upTop}`);
const hStart = await rectOf('#btn-start'); await tap(hStart.x, hStart.y, 2);
const hApe = await rectOf('#btn-ape'); await tap(hApe.x, hApe.y, 2);
check('(h0) run started for the strip-hold test', (await state()).mode === 'playing');
const stripBox2 = await ev(`(() => { const r = document.querySelector('.howto ol').getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
await touchHoldStart(stripBox2.x, stripBox2.y, 9);
let stripPump = 0;
for (let i = 0; i < 5; i++) { await sleep(120); if ((await state()).thrustHeld) stripPump += 1; }
await touchRelease();
check('(h) holding inside the help strip never pumps the rocket', stripPump === 0,
  `pumped samples=${stripPump}`);
await loadGame();
const iStart = await rectOf('#btn-start'); await tap(iStart.x, iStart.y, 2);
const iApe = await rectOf('#btn-ape'); await tap(iApe.x, iApe.y, 2);
const iGame = await rectOf('#game');
await touchHoldStart(iGame.x, iGame.y, 9);
const holdSamples = [];
for (let i = 0; i < 22; i++) { await sleep(60); const s = await state(); if (s.mode === 'playing') holdSamples.push(s.thrustHeld); }
await touchRelease();
const firstTrue = holdSamples.indexOf(true);
const drops = firstTrue < 0 ? -1 : holdSamples.slice(firstTrue).filter((v) => !v).length;
check('(i) a steady canvas hold never pulses: zero dropped input samples',
  firstTrue >= 0 && holdSamples.length >= 10 && drops === 0,
  `samples=${holdSamples.length} drops=${drops}`);

// (j) The chopped-hold heal, proven with synthetic pointer events
// driven through the REAL handlers: a pointercancel for a pointer
// that is still touching must not end the press (grace, then a move
// heals it outright); a cancel followed by silence still releases.
const evAsync = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) throw new Error('evaluate failed: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300));
  return r.result?.result?.value;
};
await loadGame();
const jStart = await rectOf('#btn-start'); await tap(jStart.x, jStart.y, 2);
const jApe = await rectOf('#btn-ape'); await tap(jApe.x, jApe.y, 2);
check('(j0) run started for the heal test', (await state()).mode === 'playing');
const heal = await evAsync(`(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const cv = document.getElementById('game');
  const P = window.__pumpRider;
  const fire = (type, id, target) => (target || window).dispatchEvent(
    new PointerEvent(type, { pointerId: id, pointerType: 'touch', bubbles: true, cancelable: true }));
  fire('pointerdown', 77, cv);
  await sleep(60);
  const afterDown = P.thrustHeld;
  fire('pointercancel', 77);
  await sleep(60);
  const afterCancel = P.thrustHeld;
  fire('pointermove', 77);
  await sleep(340);
  const afterGrace = P.thrustHeld;
  fire('pointerup', 77);
  await sleep(60);
  const afterUp = P.thrustHeld;
  fire('pointerdown', 78, cv);
  await sleep(60);
  fire('pointercancel', 78);
  await sleep(430);
  const droppedAfterRealCancel = P.thrustHeld;
  fire('pointerup', 78);
  return { afterDown, afterCancel, afterGrace, afterUp, droppedAfterRealCancel };
})()`);
check('(j) pointercancel of a still-touching pointer never ends the press; a silent cancel still releases',
  heal.afterDown === true && heal.afterCancel === true && heal.afterGrace === true &&
  heal.afterUp === false && heal.droppedAfterRealCancel === false, JSON.stringify(heal));

// (k) The soundtrack: started by the first gesture's unlock, alive
// at its modest gain, silenced at the gain node by the mute, back
// when unmuted.
const music0 = await ev(`window.__pumpRider.musicState()`);
check('(k1) the music scheduler started on the audio unlock',
  music0.started === true && music0.gain > 0.1 && music0.gain <= 0.25, JSON.stringify(music0));
const sndBtn = await rectOf('#btn-sound');
await tap(sndBtn.x, sndBtn.y, 2);
const musicMuted = await ev(`window.__pumpRider.musicState()`);
check('(k2) the mute silences the music gain node (and the button shows it)',
  musicMuted.gain === 0 && (await ev(`document.getElementById('btn-sound').textContent`)) === '🔇',
  JSON.stringify(musicMuted));
const sndBtn2 = await rectOf('#btn-sound');
await tap(sndBtn2.x, sndBtn2.y, 2);
const musicBack = await ev(`window.__pumpRider.musicState()`);
check('(k3) unmuting restores the music gain and the icon',
  musicBack.gain > 0.1 && (await ev(`document.getElementById('btn-sound').textContent`)) === '🔊',
  JSON.stringify(musicBack));

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
