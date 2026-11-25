// Tests for the HR governor section of the plugin script. Run: node tests/governor.test.js
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'stash-tcode', 'stash-tcode.js'), 'utf8');
const start = src.indexOf('// --- HR GOVERNOR ---');
const end = src.indexOf('function clamp9999('); // first function after the speed-limit section
const section = src.slice(start, end);

// Minimal stand-ins for the script globals the section touches.
const env = `
var settings = { sync: 0, hr: { enabled: true, edgeHr: 140, band: 10, floor: 30, releaseBpm: 5, rejoinSec: 8,
    timeoutSec: 8, decay: true, decayEvery: 2, decayBpm: 2, decayFloor: 105, climaxRampSec: 45, climaxHoldSec: 20, climaxEaseSec: 15 },
    axes: { R0: { autoCenter: true } } };
var hr = { bpm: null, at: 0, status: 'live' };
var AXIS = { R0: { limits: [1000, 9000] } };
var boundPlayer = null, streamOffsetMs = 0, toasts = [];
function showToast(t){ toasts.push(t); } function debug(){}
function getCenter(){ return 5000; }
`;
const api = new Function(env + section + `
return { limitSpeed, sinePosition, workingCeiling, decaySteps, approachFactor, rejoinFactor, climaxFactor, updateEdgeState, computeAllowance, shapePosition,
         hrSession, settings, hr, setMarks: (m) => { climaxMarksMs = m; }, toasts: () => toasts };`)();

let fails = 0;
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
function check(name, ok, detail) { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(detail))); }

const cfg = api.settings.hr;

// --- approach band ---
check('below band = 1', api.approachFactor(125, 140, 10, 30) === 1);
check('band start = 1', api.approachFactor(130, 140, 10, 30) === 1);
check('band middle = 0.65', near(api.approachFactor(135, 140, 10, 30), 0.65));
check('at ceiling = floor', near(api.approachFactor(140, 140, 10, 30), 0.30));
check('band 0 = 1', api.approachFactor(139, 140, 0, 30) === 1);

// --- hysteresis: 140 sets, 136 holds, 134 releases ---
{
    const s = { edged: false, edges: 0, releasedAt: null };
    const e1 = api.updateEdgeState(s, 140, 140, false, 1000, 5);
    const held = api.updateEdgeState(s, 136, 140, false, 2000, 5);
    const edgedAfterHold = s.edged;
    const e2 = api.updateEdgeState(s, 140, 140, false, 2500, 5); // still edged: not a second edge
    const rel = api.updateEdgeState(s, 134, 140, false, 3000, 5);
    check('140 triggers edge', e1 === 'edge' && s.edges === 1, { e1, s });
    check('136 holds', held === null && edgedAfterHold === true);
    check('no double count while edged', e2 === null && s.edges === 1);
    check('134 releases', rel === 'release' && s.edged === false && s.releasedAt === 3000);
    const c = { edged: false, edges: 0, releasedAt: null };
    check('no edge counted during climax', api.updateEdgeState(c, 150, 140, true, 0, 5) === null && c.edges === 0);
}
// --- recovery drop 0: 1 BPM under the ceiling clears the edge, and climbing back is a new edge ---
{
    const s = { edged: false, edges: 0, releasedAt: null };
    api.updateEdgeState(s, 140, 140, false, 1000, 0);
    const held = api.updateEdgeState(s, 140, 140, false, 2000, 0);
    const heldEdges = s.edges;
    const rel = api.updateEdgeState(s, 139, 140, false, 3000, 0);
    const again = api.updateEdgeState(s, 140, 140, false, 4000, 0);
    check('drop 0: still at ceiling holds', held === null && heldEdges === 1);
    check('drop 0: 1 under releases', rel === 'release' && s.releasedAt === 3000);
    check('drop 0: back at ceiling is edge 2', again === 'edge' && s.edges === 2);
    const t = { edged: true, edges: 1, releasedAt: null };
    check('drop 10: 130 holds, 129 releases', api.updateEdgeState(t, 130, 140, false, 0, 10) === null
        && api.updateEdgeState(t, 129, 140, false, 1, 10) === 'release');
    const u = { edged: true, edges: 1, releasedAt: null };
    check('missing drop treated as 0', api.updateEdgeState(u, 139, 140, false, 0) === 'release');
}

// --- decay ---
const wc = (edges, over) => api.workingCeiling(Object.assign({}, cfg, over || {}), edges);
check('0 edges: 140', wc(0).ceiling === 140 && wc(0).decay === 0);
check('1 edge: 140', wc(1).ceiling === 140);
check('2 edges: 138', wc(2).ceiling === 138 && wc(2).decay === 2);
check('4 edges: 136', wc(4).ceiling === 136);
check('6 edges: 134', wc(6).ceiling === 134);
check('floor stops decay at 105', wc(100).ceiling === 105 && wc(100).decay === 35);
check('floor never raises a low ceiling', wc(10, { edgeHr: 95 }).ceiling === 95);
check('decay off', wc(10, { decay: false }).ceiling === 140);
// Speeding up, every 5: drops land on edges 5, 9, 12, 14, 15, then every edge.
const steps = (edges, every) => api.decaySteps(edges, every, true);
check('accel: no drop before the first 5', steps(4, 5) === 0 && steps(5, 5) === 1);
check('accel: second drop after 4 more', steps(8, 5) === 1 && steps(9, 5) === 2);
check('accel: then 3, 2, 1', steps(12, 5) === 3 && steps(14, 5) === 4 && steps(15, 5) === 5);
check('accel: every edge once it reaches 1', steps(16, 5) === 6 && steps(20, 5) === 10);
check('accel: every 1 is just every edge', steps(7, 1) === 7);
check('steady: unchanged', api.decaySteps(9, 5, false) === 1 && api.decaySteps(10, 5, false) === 2);
// With a fastest step of 2: drops land on edges 5, 9, 12, 14, then every 2 (16, 18, ...).
const capped = (edges, every, fastest) => api.decaySteps(edges, every, true, fastest);
check('accel, fastest 2: same until it gets there', capped(14, 5, 2) === 4 && capped(15, 5, 2) === 4);
check('accel, fastest 2: then every 2 edges', capped(16, 5, 2) === 5 && capped(17, 5, 2) === 5 && capped(18, 5, 2) === 6);
check('accel, fastest at or above every: steady', capped(10, 5, 5) === 2 && capped(14, 5, 8) === 2);
check('accel ceiling with fastest 2', wc(18, { decayEvery: 5, decayAccel: true, decayAccelMin: 2 }).ceiling === 128);
check('accel ceiling: 9 edges at every 5 = 2 drops', wc(9, { decayEvery: 5, decayAccel: true }).ceiling === 136);
check('accel still stops at the floor', wc(100, { decayEvery: 5, decayAccel: true }).ceiling === 105);

// --- rejoin ---
check('rejoin none = 1', api.rejoinFactor(null, 8) === 1);
check('rejoin starts from nothing', api.rejoinFactor(0, 8) === 0);
check('rejoin half = 0.5', near(api.rejoinFactor(4, 8), 0.5));
check('rejoin is a constant pace', near(api.rejoinFactor(2, 8), 0.25) && near(api.rejoinFactor(6, 8), 0.75));
check('rejoin done = 1', near(api.rejoinFactor(8, 8), 1) && near(api.rejoinFactor(20, 8), 1));
check('rejoin 0 s = 1', api.rejoinFactor(0, 0) === 1);

// --- climax window: ramp 45 s, hold 20 s, ease 15 s around a mark at 100 s ---
const k = (t) => api.climaxFactor(t * 1000, [100000], 45000, 20000, 15000);
check('before ramp = 0', k(50) === 0);
check('ramp start ~0', near(k(55), 0));
check('ramp middle = 0.5', near(k(77.5), 0.5));
check('at mark = 1', k(100) === 1);
check('hold = 1', k(119) === 1 && k(120) === 1);
check('ease middle = 0.5', near(k(127.5), 0.5));
check('after ease = 0', k(136) === 0);
check('range marker holds for its range', api.climaxFactor(150000, [{ at: 100000, hold: 60000 }], 45000, 20000, 15000) === 1
    && near(api.climaxFactor(167500, [{ at: 100000, hold: 60000 }], 45000, 20000, 15000), 0.5));
check('object mark without hold uses default', api.climaxFactor(119000, [{ at: 100000, hold: null }], 45000, 20000, 15000) === 1
    && api.climaxFactor(136000, [{ at: 100000, hold: null }], 45000, 20000, 15000) === 0);
check('strongest mark wins', near(api.climaxFactor(85000, [100000, 80000], 45000, 20000, 15000), 1) && near(api.climaxFactor(77500, [100000, 80000], 45000, 20000, 15000), 1 - 2500 / 45000));

// --- computeAllowance end to end ---
const now = 1e6;
const at = (bpm, t) => { api.hr.bpm = bpm; api.hr.at = t; return api.computeAllowance(t, null); };
let g = at(120, now);
check('free below band', g.a === 1 && g.phase === 'FREE', g);
g = at(135, now + 1000);
check('easing in band', near(g.a, 0.65) && g.label === 'EASING 65%', g);
g = at(140, now + 2000);
check('edge at ceiling', g.a === 0 && g.phase === 'EDGE' && api.hrSession.edges === 1, g);
check('edge toast shown', api.toasts().length === 1);
g = at(134, now + 3000);
check('release starts rejoin', g.phase === 'REJOINING' && g.a === 0 && g.blend === 0 && near(g.shape, 0.72), g);
g = at(120, now + 7000);
check('rejoin halfway', near(g.a, 0.5) && near(g.blend, 0.5) && g.label === 'REJOINING 4 s', g);
g = at(120, now + 12000);
check('rejoin finished', g.a === 1 && g.phase === 'FREE' && api.hrSession.releasedAt === null, g);
g = api.computeAllowance(now + 12000 + 9000, null);
check('watchdog: stale reading stops', g.a === 0 && g.phase === 'NO SIGNAL', g);
g = at(120, now + 22000);
check('signal back: rejoins like after an edge', g.phase === 'REJOINING' && g.a === 0 && api.hrSession.releasedAt === now + 22000, g);
g = at(120, now + 26000);
check('...over the rejoin time', near(g.blend, 0.5) && g.phase === 'REJOINING', g);
api.hr.status = 'off';
g = api.computeAllowance(now + 30000, null);
check('no monitor plays normally', g.a === 1 && g.phase === 'NO MONITOR', g);
api.hr.status = 'live';
api.setMarks([200000]);
api.hrSession.edged = true;
api.hr.bpm = 150; api.hr.at = now + 40000;
g = api.computeAllowance(now + 40000, 200000);
check('climax overrides edge', g.a === 1 && g.phase === 'CLIMAX', g);
api.settings.hr.climax = false;
g = api.computeAllowance(now + 40000, 200000);
check('climax off: marker ignored, edge holds', g.a === 0 && g.phase === 'EDGE' && g.climax === 0, g);
api.settings.hr.climax = true;
api.settings.hr.enabled = false;
g = api.computeAllowance(now + 40000, null);
check('disabled = 1', g.a === 1 && g.phase === 'OFF');

// --- shaping ---
check('L0 shortens from bottom', api.shapePosition('L0', 80, 0.5) === 40);
check('L0 full at a=1', api.shapePosition('L0', 80, 1) === 80);
check('other axis shrinks to home', near(api.shapePosition('R0', 100, 0.5), 75)); // home 5000 in 1000..9000 = 50%
check('other axis at a=0 is home', near(api.shapePosition('R0', 0, 0), 50));

// --- auto motion sine ---
check('sine starts mid (axis 0)', near(api.sinePosition(0.5, 0, 0), 50));
check('sine peaks at quarter period', near(api.sinePosition(0.5, 500, 0), 100)); // 0.5 Hz: period 2 s
check('sine trough at three quarters', near(api.sinePosition(0.5, 1500, 0), 0));
check('sine stays in 0..100', [0, 0.05, 1, 3].every(hz => Array.from({length: 200}, (_, i) => api.sinePosition(hz, i * 37, 3)).every(p => p >= 0 && p <= 100)));
check('sine frequency clamped to 3 Hz', near(api.sinePosition(10, 1000 / 12, 0), api.sinePosition(3, 1000 / 12, 0)));
check('axes start at different points', !near(api.sinePosition(0.5, 0, 0), api.sinePosition(0.5, 0, 3)));

// --- speed limit (u/s as in MultiFunPlayer: 1 unit = a full 0-100% move, 0-9999) ---
check('within limit unchanged', api.limitSpeed(0, 4000, 1000, 0.5) === 4000);
check('too fast is shortened, same direction', api.limitSpeed(0, 9999, 100, 5) === 5000 && api.limitSpeed(9999, 0, 100, 5) === 5000);
check('exactly at limit unchanged', api.limitSpeed(0, 9999, 1000, 1) === 9999);
check('unknown start not limited', api.limitSpeed(null, 9999, 10, 1) === 9999);
check('limit off (0) not limited', api.limitSpeed(0, 9999, 10, 0) === 9999);
check('zero interval stays put', api.limitSpeed(3000, 9000, 0, 5) === 3000);

console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
