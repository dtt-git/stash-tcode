// The version is written in two places: TCODE_VERSION in the plugin script (what it shows and
// records) and the plugin manifest (Stash's plugin list and update check).
// Run: node tests/version.test.js
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'plugins', 'stash-tcode');
const yml = fs.readFileSync(path.join(dir, 'stash-tcode.yml'), 'utf8');

let fails = 0;
function check(name, ok) { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name); }

// The manifest must load the script that's actually there.
const js = (yml.match(/javascript:\s*\n\s*-\s*(\S+)/) || [])[1];
check('manifest loads ' + js, js && fs.existsSync(path.join(dir, js)));

const src = js ? fs.readFileSync(path.join(dir, js), 'utf8') : '';
const code = (src.match(/^const TCODE_VERSION = '([^']+)'/m) || [])[1];
const manifest = (yml.match(/^version:\s*(\S+)/m) || [])[1];
check('TCODE_VERSION ' + code + ' = manifest ' + manifest, code && code === manifest);

console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
