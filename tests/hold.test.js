// Tests for holding still at an edge: every axis stops where it is instead of travelling to
// the bottom of the stroke or to its home position. Run: node tests/hold.test.js
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'stash-tcode', 'stash-tcode.js'), 'utf8');
const section = src.slice(src.indexOf('// --- HR GOVERNOR ---'), src.indexOf('function clamp9999('));

function world(over) {
    const env = `
    var clock = 1e6;
    var Date = { now: function(){ return clock; } };
    var settings = { sync: 0, hr: { enabled: true, edgeHr: 140, band: 0, floor: 30, releaseBpm: 0, rejoinSec: OVER.rejoinSec != null ? OVER.rejoinSec : 8, timeoutSec: 8, decay: false },
        axes: { L0: { enabled: true, invert: false, link: "", idle: true, idleHz: 0.2, idleRange: 100 },
                R0: { enabled: true, invert: false, link: "" }, R1: { enabled: false, invert: false, link: "" } } };
    var AXIS_LIST = ["L0", "L1", "L2", "R0", "R1", "R2"];
    var AXIS = { L0: { limits: [0, 9999], lastPos: null }, R0: { limits: [0, 9999], lastPos: null }, R1: { limits: [0, 9999], lastPos: null } };
    var BOTH = 0, sent = [], tx = [];
    var hr = { bpm: 100, at: clock, status: 'live' };
    var serialConnected = true, boundPlayer = null, streamOffsetMs = 0;
    var window = { sessionStorage: { getItem: function(){ return null; }, setItem: function(){} } };
    function showToast(){} function debug(){} function updateGovUi(){}
    function getCenter(){ return 5000; }
    function getLimit(){ return [0, 9999]; }
    function initAxis(){}
    function sendTCode(d){ tx.push(d); }
    function queueMove(axis, pos, int){ pos = rejoinBlend(axis, Math.round(pos)); sent.push({ t: clock, axis: axis, pos: pos, int: int }); noteMove(axis, pos, int, clock); return pos; }
    function move(){}`;
    return new Function('OVER', env + section + `
    return { AXIS, settings, noteMove, axisPositionNow, holdMotion, idleTick, motionAllowance, queueMove, blend: function(){ return motionBlend; },
             now: function(){ return clock; }, advance: function(ms){ clock += ms; },
             beat: function(bpm){ hr.bpm = bpm; hr.at = clock; },
             gov: function(){ return computeAllowance(clock, null); },
             sent: function(){ return sent; }, tx: function(){ return tx; } };`)(over || {});
}

let fails = 0;
function check(name, ok, detail) { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(detail))); }

// --- where an axis is, mid-move ---
let w = world();
check('never moved: unknown', w.axisPositionNow(w.AXIS.L0, w.now()) === null);
w.noteMove('L0', 8000, 400, w.now());
check('first move, start unknown: counts as at its target', w.axisPositionNow(w.AXIS.L0, w.now() + 100) === 8000);
w.advance(1000);
w.noteMove('L0', 2000, 600, w.now()); // 8000 -> 2000 over 600 ms
check('at the start of a move', w.axisPositionNow(w.AXIS.L0, w.now()) === 8000);
check('a third of the way', w.axisPositionNow(w.AXIS.L0, w.now() + 200) === 6000);
check('after it ends: at the target', w.axisPositionNow(w.AXIS.L0, w.now() + 5000) === 2000);
w.advance(300);                        // halfway: at 5000
w.noteMove('L0', 9000, 100, w.now());  // interrupted: the new move starts from 5000
check('an interrupting move starts from where the axis had got to', w.AXIS.L0.moveFrom === 5000 && w.AXIS.L0.lastPos === 9000);

// --- going into a hold: each moving axis is sent to where it is ---
w = world();
w.noteMove('L0', 0, 0, w.now()); w.noteMove('R0', 5000, 0, w.now()); w.noteMove('R1', 5000, 0, w.now());
w.advance(1000);
w.noteMove('L0', 8000, 400, w.now());  // stroke up
w.noteMove('R0', 5000, 400, w.now());  // twist isn't going anywhere
w.noteMove('R1', 9000, 400, w.now());  // a disabled axis
w.advance(100);                        // L0 is a quarter of the way: 2000
check('free: no hold, nothing sent', w.holdMotion(w.gov(), w.now()) === false && w.tx().length === 0);
w.beat(140);                           // at the ceiling
const g = w.gov();
check('at the ceiling: hold', g.phase === 'EDGE' && w.holdMotion(g, w.now()) === true);
check('the stroke is stopped where it is, not sent to the bottom', w.tx().length === 1 && w.tx()[0] === 'L02000I50 \n', w.tx());
check('an axis at rest and a disabled axis get no command', !/R0|R1/.test(w.tx()[0]));
check('the stroke now counts as being there', w.AXIS.L0.lastPos === 2000);
w.advance(10);
w.holdMotion(w.gov(), w.now());
w.advance(2000); w.beat(141);
w.holdMotion(w.gov(), w.now());
check('still holding: nothing more is sent', w.tx().length === 1);
w.advance(1000);
w.holdMotion(w.gov(), w.now());        // (playback ticks every 10 ms)
w.advance(10); w.beat(139);            // recovery drop 0: 1 BPM under clears it
const r = w.gov();
check('1 under the ceiling: hold ends', r.phase === 'REJOINING' && w.holdMotion(r, w.now()) === false);
check('strokes are not shortened: all the easing is the blend', w.motionAllowance(r, w.now()) === 1 && w.blend() === 0);

// --- rejoining: from where the axis stopped (2000), easing into the script ---
// The script strokes between 5000 and 9000 once a second. 50 ms ticks, a reading a second.
const script = (t) => 7000 + 2000 * Math.sin(2 * Math.PI * t / 1000);
function rejoin(w, ms) {
    const out = [];
    for (let t = 0; t < ms; t += 50) {
        if (t % 1000 === 0) w.beat(139);
        const g = w.gov();
        if (!w.holdMotion(g, w.now())) { w.motionAllowance(g, w.now()); out.push({ t: t, want: Math.round(script(t + 50)), pos: w.queueMove('L0', script(t + 50), 50) }); }
        w.advance(50);
    }
    return out;
}
let run = rejoin(w, 9000);
check('the first move stays where the axis stopped', Math.abs(run[0].pos - 2000) <= 110, run[0]);
check('it never heads for the bottom of the stroke first', Math.min(...run.map(m => m.pos)) >= 2000, Math.min(...run.map(m => m.pos)));
check('half a second in: still close to where it stopped', run[10].pos < 3300, run[10]);
const mid = run[80]; // 4 s into an 8 s rejoin
check('halfway through the rejoin time: halfway to the script', Math.abs(mid.pos - (2000 + (mid.want - 2000) * 0.5)) <= 5, mid);
check('after the rejoin time: exactly the script', run.slice(-10).every(m => m.pos === m.want) && w.AXIS.L0.holdPos === null, run.slice(-2));
// The script's fastest step is 628 units a tick; easing in adds 7000 / 8 a second on top.
check('no step faster than the script plus the easing', run.slice(1).every((m, i) => Math.abs(m.pos - run[i].pos) <= 700),
      Math.max(...run.slice(1).map((m, i) => Math.abs(m.pos - run[i].pos))));

// The rejoin time is all that decides how long it takes: 3 s is 3 s, and 0 is straight back.
const after = (sec) => {
    const x = world({ rejoinSec: sec });
    x.noteMove('L0', 2000, 0, x.now());
    x.advance(1000); x.beat(140);
    x.holdMotion(x.gov(), x.now());
    x.advance(1000);
    x.holdMotion(x.gov(), x.now());
    x.advance(10);
    return rejoin(x, 5000);
};
run = after(3);
check('rejoin time 3 s: a third of the way at 1 s', Math.abs(run[20].pos - (2000 + (run[20].want - 2000) / 3)) <= 5, run[20]);
check('rejoin time 3 s: halfway at 1.5 s', Math.abs(run[30].pos - (2000 + (run[30].want - 2000) * 0.5)) <= 5, run[30]);
check('rejoin time 3 s: not there before 3 s', run[58].pos !== run[58].want, run[58]);
check('rejoin time 3 s: on the script from 3 s', run.slice(60).every(m => m.pos === m.want), run[60]);
run = after(0);
check('rejoin time 0: straight back onto the script', run.every(m => m.pos === m.want), run[0]);

// An axis that was homed during the hold rejoins from there, not from where it had stopped.
w = world();
w.noteMove('L0', 2000, 0, w.now());
w.advance(1000); w.beat(140);
w.holdMotion(w.gov(), w.now());
w.noteMove('L0', 5000, 0, w.now());    // Center now
w.advance(1000); w.beat(139);
w.holdMotion(w.gov(), w.now());
check('rejoins from where the axis is now', w.AXIS.L0.holdPos === 5000);

// --- lost signal holds too ---
w = world();
w.noteMove('L0', 0, 0, w.now());
w.advance(1000);
w.noteMove('L0', 6000, 300, w.now());
w.advance(150);
w.advance(9000);                       // no reading for longer than the timeout
w.noteMove('L0', 1000, 500, w.now());  // (a move that was under way when the signal went)
w.advance(250);
const lost = w.gov();
check('no signal: hold, stopped in place', lost.phase === 'NO SIGNAL' && w.holdMotion(lost, w.now()) === true && w.tx()[0] === 'L03500I50 \n', w.tx());

// --- idle motion stands still at an edge ---
w = world();
for (let t = 0; t < 4000; t += 25) { w.idleTick(); w.advance(25); }
const before = w.sent().length;
check('idle motion runs below the ceiling', before > 10, before);
w.beat(140);
for (let t = 0; t < 3000; t += 25) { w.idleTick(); w.advance(25); w.beat(140); }
check('at an edge: no idle moves at all', w.sent().length === before, w.sent().length - before);
check('...and one stop-in-place command at most', w.tx().length <= 1, w.tx());
w.beat(139);
for (let t = 0; t < 1000; t += 25) { w.idleTick(); w.advance(25); w.beat(139); }
check('idle motion picks up again once it clears', w.sent().length > before);
check('...starting with a slow move', w.sent()[before].int === 500, w.sent()[before]);

console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
