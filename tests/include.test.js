// Tests for the script's @include pattern: Stash's default port only, never a lookalike.
// Run: node tests/include.test.js
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'stash-tcode.user.js'), 'utf8');
const re = new RegExp(src.match(/@include\s+\/(.*)\/\s*$/m)[1]);

let fails = 0;
function check(url, want) {
    const ok = re.test(url) === want;
    if (!ok) fails++;
    console.log((ok ? 'PASS ' : 'FAIL ') + (want ? 'runs on    ' : 'skips      ') + url);
}

check('http://localhost:9999/scenes/194', true);
check('http://192.168.1.20:9999/', true);
check('http://stash.lan:9999/settings', true);
check('https://stash.local:9999/', true);
check('http://localhost:9998/', false);
check('https://stash.example.com/', false);           // reverse proxy: add it as a user include
check('https://some-site.com/page?x=:9999/', false);  // port text in the query string
check('https://some-site.com/:9999/', false);         // port text in the path
check('http://host:19999/', false);
check('http://host:99999/', false);

console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
