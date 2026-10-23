// Tests for choosing which granted serial port to reopen. Run: node tests/serial.test.js
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'stash-tcode', 'stash-tcode.js'), 'utf8');
const start = src.indexOf('function pickSavedPort(');
const body = src.slice(start, src.indexOf('\n}', start) + 2);
const pick = (saved, ports) => new Function('settings', body + '\nreturn pickSavedPort;')({ serialPort: saved })(ports);

let fails = 0;
function check(name, ok) { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name); }
const port = (vid, pid) => ({ getInfo: () => ({ usbVendorId: vid, usbProductId: pid }) });
const stroker = port(0x1a86, 0x7523), arduino = port(0x2341, 0x0043);
const saved = { usbVendorId: 0x1a86, usbProductId: 0x7523 };

check('saved device present is picked', pick(saved, [arduino, stroker]) === stroker);
check('saved device absent: no fallback to another port', pick(saved, [arduino]) === null);
check('nothing saved, one granted port: use it', pick(null, [stroker]) === stroker);
check('nothing saved, several ports: none', pick(null, [stroker, arduino]) === null);
check('saved without USB ids (e.g. Bluetooth serial), one port: use it', pick({ usbVendorId: null, usbProductId: null }, [stroker]) === stroker);
check('no ports', pick(saved, []) === null);

console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
