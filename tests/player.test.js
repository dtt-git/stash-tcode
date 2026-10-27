// Tests that only Stash's scene player is ever bound, never another <video> on the page
// (Stash Battle's previews drove the device and got the overlay). Run: node tests/player.test.js
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'stash-tcode', 'stash-tcode.js'), 'utf8');
const start = src.indexOf('function findScenePlayer(');
const fn = src.slice(start, src.indexOf('\n}\n', start) + 2);
const findScenePlayer = new Function(fn + '\nreturn findScenePlayer;')();

// A tiny stand-in for the document: elements by id, and what each host holds.
function doc(byId) {
    return { getElementById: (id) => byId[id] || null };
}
const scenePlayer = { name: 'scene' };
const preview = { name: 'battle preview' };

let fails = 0;
function check(name, ok, detail) { if (!ok) fails++; console.log((ok ? 'PASS ' : 'FAIL ') + name + (ok ? '' : '  ' + JSON.stringify(detail))); }

check('finds the scene player by id', findScenePlayer(doc({ VideoJsPlayer_html5_api: scenePlayer })) === scenePlayer);
check('finds it inside the video.js host when the id differs',
    findScenePlayer(doc({ VideoJsPlayer: { querySelector: (s) => s === 'video.vjs-tech' ? scenePlayer : null } })) === scenePlayer);
// Between scenes Stash briefly has no player, while Battle's previews are still in the page.
// The old lookup fell back to the first <video> and stayed bound to the preview.
check('no scene player: nothing, not some other video', findScenePlayer(Object.assign(doc({}), { querySelector: () => preview })) === null);

console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
