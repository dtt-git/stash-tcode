// Tests for heart-rate packet decoding and the "is this a real reading" check.
// Run: node tests/hr-packets.test.js
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'stash-tcode.user.js'), 'utf8');

function grab(name) {
    const start = src.indexOf('function ' + name + '(');
    const end = src.indexOf('\n}', start);
    if (start < 0 || end < 0) throw new Error('function not found: ' + name);
    return src.slice(start, end + 2);
}
const api = new Function('var HR_MIN_VALID = 35;\n' + grab('parseHrMeasurement') + '\n' + grab('hrPacketVerdict') +
    '\nreturn { parse: parseHrMeasurement, verdict: hrPacketVerdict };')();

let fails = 0;
function check(name, ok, detail) { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(detail))); }
const dv = (bytes) => new DataView(Uint8Array.from(bytes).buffer);

// --- decoding ---
let m;
m = api.parse(dv([0x00, 72]));
check('uint8, contact unsupported', m.bpm === 72 && m.contact === null && m.rr === 0, m);
m = api.parse(dv([0x06, 95]));
check('contact detected', m.contact === true, m);
m = api.parse(dv([0x04, 60]));
check('no contact', m.contact === false, m);
m = api.parse(dv([0x01, 0x2c, 0x01]));
check('uint16 BPM', m.bpm === 300, m);
m = api.parse(dv([0x16, 80, 0x00, 0x03, 0x10, 0x03]));
check('contact + two RR intervals', m.bpm === 80 && m.contact === true && m.rr === 2, m);
m = api.parse(dv([0x18, 80, 0x10, 0x00, 0x00, 0x03]));
check('energy field before one RR interval', m.rr === 1, m);
m = api.parse(dv([0x11, 0x2c, 0x01, 0x00, 0x03]));
check('uint16 BPM + one RR interval', m.bpm === 300 && m.rr === 1, m);
m = api.parse(dv([0x10, 80]));
check('RR flag set but no room for any', m.rr === 0, m);
check('truncated uint16 is null', api.parse(dv([0x01, 0x2c])) === null);
check('too short is null', api.parse(dv([0x00])) === null);

// --- is it a real reading? ---
check('normal reading counts', api.verdict({ bpm: 80, contact: true, rr: 1 }, true) === 'ok');
check('below 35 BPM is not a pulse', api.verdict({ bpm: 20, contact: null, rr: 0 }, false) === 'low');
check('sensor reports no skin contact', api.verdict({ bpm: 80, contact: false, rr: 1 }, true) === 'contact');
check('strap stopped timing beats (taken off, repeating last BPM)', api.verdict({ bpm: 80, contact: null, rr: 0 }, true) === 'beats');
check('sensor that never times beats still counts', api.verdict({ bpm: 80, contact: null, rr: 0 }, false) === 'ok');

console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
