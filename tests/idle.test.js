// Tests for idle motion: L0 keeps a slow stroke going while no video plays. Runs the plugin's
// idle loop against a simulated clock. Run: node tests/idle.test.js
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'stash-tcode', 'stash-tcode.js'), 'utf8');
const section = src.slice(src.indexOf('// --- HR GOVERNOR ---'), src.indexOf('function clamp9999('));

function world(opts) {
    const env = `
    var clock = 1e6;
    var Date = { now: function(){ return clock; } };
    var settings = { sync: 0, hr: { enabled: false },
        axes: { L0: { enabled: true, invert: false, link: "", idle: OPTS.idle !== false, idleHz: OPTS.hz || 0.2, idleRange: OPTS.range || 100 } } };
    var AXIS_LIST = ["L0", "L1", "L2", "R0", "R1", "R2"];
    var AXIS = {}, BOTH = 0, sent = [], lines = 0;
    var hr = { bpm: null, at: 0, status: 'off' };
    var serialConnected = OPTS.connected !== false, boundPlayer = null, streamOffsetMs = 0;
    var window = { sessionStorage: { getItem: function(){ return null; }, setItem: function(){} } };
    function showToast(){} function debug(){} function updateGovUi(){}
    function getCenter(){ return 5000; }
    function getLimit(){ return OPTS.limits || [0, 9999]; }
    function initAxis(n){ if(!AXIS[n]){ AXIS[n] = { acts: null, limits: null }; } }
    function queueMove(axis, pos, int){ sent.push({ t: clock, pos: Math.round(pos), int: int }); }
    function move(){ lines++; }`;
    return new Function('OPTS', env + section + `
    return { tick: idleTick, pos: idlePosition, wanted: idleWanted, sent: function(){ return sent; },
             advance: function(ms){ clock += ms; }, play: function(on){ boundPlayer = on ? { isConnected: true, paused: false } : null; },
             DELAY: IDLE_DELAY_MS, REJOIN: SINE_REJOIN_MS, STEP: SINE_STEP_MS };`)(opts || {});
}
// Run the idle loop every `every` ms for `ms` ms.
function run(w, ms, every) { for (let t = 0; t < ms; t += every) { w.tick(); w.advance(every); } }

let fails = 0;
function check(name, ok, detail) { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(detail))); }

// --- position ---
let w = world();
const sweep = (hz, range) => { let lo = 100, hi = 0; for (let t = 0; t < 30000; t += 10) { const p = w.pos(hz, t, range); lo = Math.min(lo, p); hi = Math.max(hi, p); } return [lo, hi]; };
let [lo, hi] = sweep(0.2, 100);
check('full idle stroke covers the whole range', lo < 0.01 && hi > 99.99, [lo, hi]);
[lo, hi] = sweep(0.2, 40);
check('a 40% stroke stays centred: 30-70', lo > 29.99 && hi < 70.01 && lo < 30.1 && hi > 69.9, [lo, hi]);
check('speed is capped at 1 Hz (no faster than one stroke a second)', w.pos(50, 250, 100) === w.pos(1, 250, 100));

// --- when it runs ---
check('wanted: connected, enabled, on, nothing playing, after the delay',
      w.wanted({ connected: true, enabled: true, idle: true, playing: false, sincePlayingMs: 5000 }));
check('not while a video plays', !w.wanted({ connected: true, enabled: true, idle: true, playing: true, sincePlayingMs: 5000 }));
check('not right after playback stops', !w.wanted({ connected: true, enabled: true, idle: true, playing: false, sincePlayingMs: 500 }));
check('not when switched off', !w.wanted({ connected: true, enabled: true, idle: false, playing: false, sincePlayingMs: 5000 }));
check('not without a device', !w.wanted({ connected: false, enabled: true, idle: true, playing: false, sincePlayingMs: 5000 }));

// --- the loop ---
w = world();
w.play(true); run(w, 3000, 25);
check('nothing while playing', w.sent().length === 0, w.sent().length);
w.play(false); run(w, w.DELAY - 100, 25);
check('nothing in the first moments after playback stops', w.sent().length === 0, w.sent().length);
run(w, 2000, 25);
const s = w.sent();
check('then idle strokes go out', s.length > 10, s.length);
check('the first move is slow (rejoin), from wherever the axis is', s[0].int === w.REJOIN, s[0]);
check('after that, a move every ~50 ms', s.slice(1).every(m => m.int === w.STEP), s.slice(1, 4));
w.play(true); const n = w.sent().length; run(w, 1000, 25);
check('stops as soon as a video plays', w.sent().length === n, w.sent().length - n);

// A hidden tab's timers fire about once a second: each move covers the real gap.
w = world();
run(w, w.DELAY + 600, 25);
const before = w.sent().length;
for (let i = 0; i < 5; i++) { w.advance(1000); w.tick(); } // a late timer: the wait comes first
const slow = w.sent().slice(before);
check('in a hidden tab each move spans the ~1 s gap', slow.length >= 4 && slow.every(m => m.int === 1000), slow.map(m => m.int));

// Range: the stroke maps into L0's range (here 2000-6000), centred for a partial stroke.
w = world({ range: 50, limits: [2000, 6000] });
run(w, w.DELAY + 10000, 25);
const p = w.sent().map(m => m.pos);
check('idle stroke stays inside the axis range, centred', Math.min(...p) >= 2999 && Math.max(...p) <= 5001, [Math.min(...p), Math.max(...p)]);

// Off or disconnected: never moves.
w = world({ idle: false }); run(w, 10000, 25);
check('idle off: no moves', w.sent().length === 0);
w = world({ connected: false }); run(w, 10000, 25);
check('no device: no moves', w.sent().length === 0);

console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
