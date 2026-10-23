// The version is written in three places: the userscript header (Tampermonkey updates on it),
// TCODE_VERSION (what the script shows and records) and the plugin manifest (Stash's plugin
// list). Run: node tests/version.test.js
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(root, 'stash-tcode.user.js'), 'utf8');
const yml = fs.readFileSync(path.join(root, 'plugins', 'stash-tcode', 'stash-tcode.yml'), 'utf8');

const versions = {
    '@version': (src.match(/^\/\/ @version\s+(\S+)/m) || [])[1],
    'TCODE_VERSION': (src.match(/^const TCODE_VERSION = '([^']+)'/m) || [])[1],
    'stash-tcode.yml': (yml.match(/^version:\s*(\S+)/m) || [])[1],
};

let fails = 0;
for (const [where, v] of Object.entries(versions)) {
    const ok = v && v === versions['@version'];
    if (!ok) fails++;
    console.log((ok ? 'PASS ' : 'FAIL ') + where + ' = ' + v);
}

// The plugin manifest must load the script that's actually there.
const js = (yml.match(/javascript:\s*\n\s*-\s*(\S+)/) || [])[1];
const jsOk = js === 'stash-tcode.user.js' && fs.existsSync(path.join(root, js));
if (!jsOk) fails++;
console.log((jsOk ? 'PASS ' : 'FAIL ') + 'manifest loads ' + js);

console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
