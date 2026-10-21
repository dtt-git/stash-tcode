// Tests for the HR governor section of stash-tcode.user.js. Run: node tests/governor.test.js
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'stash-tcode.user.js'), 'utf8');
const start = src.indexOf('// --- HR GOVERNOR ---');
const end = src.indexOf('function listAxes(');
const section = src.slice(start, end);

// Minimal stand-ins for the script globals the section touches.
const env = `
var settings = { sync: 0, hr: { enabled: true, restingHr: 70, climaxHr: 140, band: 10, floor: 30, rejoinSec: 8,
    timeoutSec: 8, decay: true, decayEvery: 2, decayBpm: 2, decayFloor: 105, climaxRampSec: 45, climaxHoldSec: 20, climaxEaseSec: 15 },
    axes: { R0: { autoCenter: true } } };
var hr = { bpm: null, at: 0, status: 'live' };
var AXIS = { R0: { limits: [1000, 9000] } };
var boundPlayer = null, streamOffsetMs = 0, toasts = [];
function showToast(t){ toasts.push(t); } function debug(){}
function getCenter(){ return 5000; }
`;
const api = new Function(env + section + `
return { workingCeiling, approachFactor, rejoinFactor, climaxFactor, updateEdgeState, computeAllowance, shapePosition,
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
    const e1 = api.updateEdgeState(s, 140, 140, false, 1000);
    const held = api.updateEdgeState(s, 136, 140, false, 2000);
    const edgedAfterHold = s.edged;
    const e2 = api.updateEdgeState(s, 140, 140, false, 2500); // still edged: not a second edge
    const rel = api.updateEdgeState(s, 134, 140, false, 3000);
    check('140 triggers edge', e1 === 'edge' && s.edges === 1, { e1, s });
    check('136 holds', held === null && edgedAfterHold === true);
    check('no double count while edged', e2 === null && s.edges === 1);
    check('134 releases', rel === 'release' && s.edged === false && s.releasedAt === 3000);
    const c = { edged: false, edges: 0, releasedAt: null };
    check('no edge counted during climax', api.updateEdgeState(c, 150, 140, true, 0) === null && c.edges === 0);
}

// --- decay ---
const wc = (edges, over) => api.workingCeiling(Object.assign({}, cfg, over || {}), edges);
check('0 edges: 140', wc(0).ceiling === 140 && wc(0).decay === 0);
check('1 edge: 140', wc(1).ceiling === 140);
check('2 edges: 138', wc(2).ceiling === 138 && wc(2).decay === 2);
check('4 edges: 136', wc(4).ceiling === 136);
check('6 edges: 134', wc(6).ceiling === 134);
check('floor stops decay at 105', wc(100).ceiling === 105 && wc(100).decay === 35);
check('floor never raises a low ceiling', wc(10, { climaxHr: 95 }).ceiling === 95);
check('never within 15 of resting', wc(100, { restingHr: 100, decayFloor: 80 }).ceiling === 115);
check('decay off', wc(10, { decay: false }).ceiling === 140);

// --- rejoin ---
check('rejoin none = 1', api.rejoinFactor(null, 8) === 1);
check('rejoin start = 0.16', near(api.rejoinFactor(0, 8), 0.16));
check('rejoin half = 0.58', near(api.rejoinFactor(4, 8), 0.58));
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
check('release starts rejoin', g.phase === 'REJOINING' && near(g.a, 0.16), g);
g = at(120, now + 7000);
check('rejoin halfway', near(g.a, 0.58) && g.label === 'REJOINING 4 s', g);
g = at(120, now + 12000);
check('rejoin finished', g.a === 1 && g.phase === 'FREE' && api.hrSession.releasedAt === null, g);
g = api.computeAllowance(now + 12000 + 9000, null);
check('watchdog: stale reading stops', g.a === 0 && g.phase === 'NO SIGNAL', g);
api.hr.status = 'off';
g = api.computeAllowance(now + 30000, null);
check('no monitor plays normally', g.a === 1 && g.phase === 'NO MONITOR', g);
api.hr.status = 'live';
api.setMarks([200000]);
api.hrSession.edged = true;
api.hr.bpm = 150; api.hr.at = now + 40000;
g = api.computeAllowance(now + 40000, 200000);
check('climax overrides edge', g.a === 1 && g.phase === 'CLIMAX', g);
api.settings.hr.enabled = false;
g = api.computeAllowance(now + 40000, null);
check('disabled = 1', g.a === 1 && g.phase === 'OFF');

// --- shaping ---
check('L0 shortens from bottom', api.shapePosition('L0', 80, 0.5) === 40);
check('L0 full at a=1', api.shapePosition('L0', 80, 1) === 80);
check('other axis shrinks to home', near(api.shapePosition('R0', 100, 0.5), 75)); // home 5000 in 1000..9000 = 50%
check('other axis at a=0 is home', near(api.shapePosition('R0', 0, 0), 50));

console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
