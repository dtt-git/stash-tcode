// Tests that heart-rate shaping eases in and out instead of jumping (the twist stutter after
// an edge). Runs the plugin's governor and auto-motion code against a simulated clock and a
// monitor reading once a second. Run: node tests/smoothing.test.js
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'stash-tcode', 'stash-tcode.js'), 'utf8');
const section = src.slice(src.indexOf('// --- HR GOVERNOR ---'), src.indexOf('function clamp9999('));

const env = `
var settings = { sync: 0, hr: { enabled: true, edgeHr: 133, band: 10, floor: 40, rejoinSec: 8, timeoutSec: 8, decay: false,
    decayEvery: 2, decayBpm: 2, decayFloor: 105, climaxRampSec: 45, climaxHoldSec: 20, climaxEaseSec: 15 },
    axes: { R0: { enabled: true, auto: true, autoHz: 0.1, invert: false, link: "", autoCenter: true } } };
var AXIS_LIST = ["L0", "L1", "L2", "R0", "R1", "R2"];
var AXIS = { R0: { limits: [0, 9999], lastPos: null } };
var hr = { bpm: null, at: 0, status: 'live' };
var boundPlayer = null, streamOffsetMs = 0, sent = [];
var window = { sessionStorage: { getItem: function(){ return null; }, setItem: function(){} } };
function showToast(){} function debug(){} function updateGovUi(){}
function getCenter(){ return 5000; }
function queueMove(axis, pos, int){ sent.push({ pos: Math.round(pos), int: int }); }
`;
const api = new Function(env + section + `
return { computeAllowance, motionAllowance, smoothAllowance, autoMotion, hr, sent: function(){ return sent; },
         resetAxis: function(){ AXIS.R0 = { limits: [0, 9999], lastPos: null }; },
         rise: A_RISE_PER_SEC, fall: A_FALL_PER_SEC };`)();

let fails = 0;
function check(name, ok, detail) { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(detail))); }
const near = (x, y) => Math.abs(x - y) < 1e-9;

// --- the capped-rate follower ---
check('first value is taken as is', api.smoothAllowance(null, 0.4, 0) === 0.4);
check('rises at most A_RISE_PER_SEC', near(api.smoothAllowance(0, 1, 1000), api.rise));
check('falls at most A_FALL_PER_SEC', near(api.smoothAllowance(1, 0, 500), 1 - api.fall * 0.5));
check('never overshoots the target', api.smoothAllowance(0.5, 0.55, 1000) === 0.55 && api.smoothAllowance(0.5, 0.45, 1000) === 0.45);
check('a long gap (paused video) catches up at once', api.smoothAllowance(0, 1, 60000) === 1);
check('losing the signal stops at once', api.motionAllowance({ phase: 'NO SIGNAL', a: 0 }, 1e6 + 10) === 0);

// --- the scenario that stuttered: slow twist through an edge and back down the approach band ---
api.motionAllowance({ phase: 'FREE', a: 1 }, 0); // reset the follower
const bpmAt = (s) => s < 10 ? 120 : s < 20 ? 120 + (s - 10) * 1.6 : Math.max(116, 135 - (s - 20) * 0.9);
let now = 1e6, ms = 0, lastBeat = -1, prev = null, worst = 0, phases = new Set();
for (let tick = 0; tick < 6000; tick++) {          // 60 s of video, 10 ms ticks
    const s = tick / 100;
    if (Math.floor(s) !== lastBeat) {              // one reading a second, +-1 jitter
        lastBeat = Math.floor(s);
        api.hr.bpm = Math.round(bpmAt(s) + [1, -1, 0][lastBeat % 3]);
        api.hr.at = now;
    }
    const g = api.computeAllowance(now, ms);
    phases.add(g.phase);
    const n = api.sent().length;
    api.autoMotion('R0', now, api.motionAllowance(g, now));
    if (api.sent().length > n) {
        const m = api.sent()[api.sent().length - 1];
        if (prev && tick > 100) worst = Math.max(worst, Math.abs(m.pos - prev.pos) / m.int * 1000);
        prev = m;
    }
    now += 10; ms += 10;
}
// A 0.1 Hz sine over the full range peaks at ~3142 units/s; shaping may add at most
// 5000 * A_FALL_PER_SEC on top. Before the fix, steps reached ~39000.
const limit = 3142 + 5000 * api.fall;
check('the run went through easing, edge and rejoining', ['EASING', 'EDGE', 'REJOINING'].every(p => phases.has(p)), [...phases]);
check('twist never steps faster than the sine plus the capped shaping rate', worst <= limit, { worst: Math.round(worst), limit });

// --- auto motion runs on its own clock: seeking doesn't move it, a pause holds it ---
{
    const R = { limits: [0, 9999] };
    const run = (from, ticks, step) => { const out = []; for (let i = 0; i < ticks; i++) {
        const n = api.sent().length; api.autoMotion('R0', from + i * step, 1);
        if (api.sent().length > n) out.push(api.sent()[api.sent().length - 1]); } return out; };
    api.resetAxis();
    let t = 5e6;
    const first = run(t, 200, 10);                    // 2 s of playback
    check('starts with a slow rejoin move', first[0].int === 500, first[0]);
    t += 2000;
    // Video time plays no part, so a seek mid-playback is just the next tick: no rejoin, no jump.
    const after = run(t, 100, 10);
    const stepRate = (m, p) => Math.abs(m.pos - p.pos) / m.int * 1000;
    check('playback carries on in 50 ms steps', after.every(m => m.int === 50), after.slice(0, 3));
    check('no step faster than the sine', after.slice(1).every((m, i) => stepRate(m, after[i]) <= 3142 * 1.05));
    t += 1000;
    const lastPos = after[after.length - 1].pos;
    // A 30 s pause: the clock holds, so it picks up next to where it stopped, with a slow rejoin.
    const resumed = run(t + 30000, 1, 10);
    check('after a pause: a slow rejoin move', resumed[0].int === 500, resumed[0]);
    // The rejoin aims 500 ms ahead: at 0.1 Hz that's at most ~1600 units from where it stopped.
    // On the old video clock, a 30 s jump landed anywhere in the cycle.
    check('after a pause: picks up near where it stopped', Math.abs(resumed[0].pos - lastPos) <= 3142 * 0.55, { lastPos, pos: resumed[0].pos });
}

console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
