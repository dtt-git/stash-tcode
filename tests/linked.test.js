// Tests for linked axes (one axis following another). Run: node tests/linked.test.js
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'stash-tcode.user.js'), 'utf8');
const section = src.slice(src.indexOf('// --- LINKED AXES ---'), src.indexOf('// --- SPEED LIMIT ---'));

// Fresh world per test: every axis enabled with no script; ranges and links per test.
function world(cfg) {
    const env = `
        var AXIS_LIST = ["L0", "L1", "L2", "R0", "R1", "R2"];
        var sent = [];
        function queueMove(axis, pos, int){ sent.push(axis + ":" + pos + "@" + int); }
        function shapePosition(axis, pos, a){ return axis === "L0" ? pos * a : 50 + (pos - 50) * a; }
        var settings = { axes: {} }, AXIS = {};
        AXIS_LIST.forEach(function(ax){
            var c = CFG[ax] || {};
            settings.axes[ax] = { enabled: c.enabled !== false, invert: !!c.invert, link: c.link || "" };
            AXIS[ax] = { limits: c.limits || [0, 9999], acts: c.scripted ? [{ at: 0, pos: 0 }] : null };
        });`;
    return new Function('CFG', env + section + `
        return { emit: emitAxisMove, linked: emitLinkedMoves, sent: function(){ return sent; },
                 reset: function(){ sent = []; tickMoves = {}; } };`)(cfg);
}

let fails = 0;
function check(name, ok, detail) { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(detail))); }

// Twist follows stroke: same point in its own range, same timing.
let w = world({ L0: { scripted: true, limits: [3000, 9999] }, R0: { link: 'L0', limits: [2000, 8000] } });
w.emit('L0', 80, 120, 1); w.linked(1);
check('follower copies position into its own range, same interval', JSON.stringify(w.sent()) === JSON.stringify(['L0:8599@120', 'R0:6800@120']), w.sent());

// The follower's own invert applies; the source's doesn't.
w = world({ L0: { scripted: true, invert: true }, R0: { link: 'L0', invert: true } });
w.emit('L0', 80, 100, 1); w.linked(1);
check('source invert not inherited, follower invert applied', JSON.stringify(w.sent()) === JSON.stringify(['L0:2000@100', 'R0:2000@100']), w.sent());

// Its own script wins over following.
w = world({ L0: { scripted: true }, R0: { link: 'L0', scripted: true } });
w.emit('L0', 50, 100, 1); w.linked(1);
check('axis with its own script ignores the link', JSON.stringify(w.sent()) === JSON.stringify(['L0:5000@100']), w.sent());

// Nothing from the source this tick: follower stays put.
w = world({ L0: { scripted: true }, R0: { link: 'L0' } });
w.linked(1);
check('no source move, no follower move', w.sent().length === 0, w.sent());

// Chains resolve in one tick; loops never move.
w = world({ L0: { scripted: true }, R0: { link: 'L0' }, R1: { link: 'R0' } });
w.emit('L0', 25, 80, 1); w.linked(1);
check('chain R1 -> R0 -> L0 resolves in one tick', JSON.stringify(w.sent()) === JSON.stringify(['L0:2500@80', 'R0:2500@80', 'R1:2500@80']), w.sent());
w = world({ R0: { link: 'R1' }, R1: { link: 'R0' } });
w.linked(1);
check('loop R0 <-> R1 never moves', w.sent().length === 0, w.sent());

// Disabled followers don't move; heart-rate shaping applies to the follower.
w = world({ L0: { scripted: true }, R0: { link: 'L0', enabled: false } });
w.emit('L0', 100, 100, 1); w.linked(1);
check('disabled follower stays put', JSON.stringify(w.sent()) === JSON.stringify(['L0:9999@100']), w.sent());
w = world({ L0: { scripted: true }, R0: { link: 'L0' } });
w.emit('L0', 100, 100, 0.5); w.linked(0.5);
check('allowance shrinks the follower toward home', JSON.stringify(w.sent()) === JSON.stringify(['L0:5000@100', 'R0:7499@100']), w.sent());

console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
