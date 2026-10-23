# Stash-TCode

A [Stash](https://github.com/stashapp/stash) plugin that drives TCode devices (OSR2/SR6 and similar)
over USB using the Web Serial API. It's also available as a Tampermonkey userscript.
It plays a scene's funscripts, including multi-axis ones, on the device in sync with the video.
With a Bluetooth heart-rate monitor it can also shorten strokes as your heart rate climbs and hold
off at the edge.

Maintained by **dtt**. Originally based on Stash-TCode by Spunkle, with modifications by Steel.

## Features

- Connects over USB via Web Serial at 115200 baud, with no websocket bridge, and reconnects
  on its own after a page refresh or when the device is plugged back in.
- Handles single-axis and multi-axis funscripts, plus separate per-axis files
  (`.surge`, `.sway`, `.twist`, `.roll`, `.pitch`).
- Per-axis range, invert and home position, all saved across refreshes.
- Optional per-axis speed limit, as a percentage of full travel per second (300%/s is the same as
  3 u/s in MultiFunPlayer). Moves that would be faster are shortened rather than slowed, so
  playback stays in sync.
- Auto motion: any axis the scene has no script for can follow a smooth sine wave at its own
  frequency, so a video without a funscript still gets motion.
- Linked axes: an axis can **follow** another, e.g. twist mirroring stroke: when stroke goes
  0-100%, twist goes 0-100% of its own range, in step. Use the follower's Invert to reverse it.
  It applies when the axis has no script of its own, or always with **Override script** on.
- Settings live in a dialog built from Stash's own components, so it matches Stash and any custom theme.
- Heart-rate modulation, adaptive ceiling decay and climax markers (below).
- A stats overlay on the video: heart rate, ceiling, edges and what the limiter is doing.
- Handles seeking, including on transcoded streams.

## Screenshots

<p>
  <img src="docs/screenshots/settings-heart-rate.png" alt="The Heart Rate tab of the settings dialog" width="49%">
  <img src="docs/screenshots/settings-axes.png" alt="The Axes tab: twist set to follow stroke, with range, invert, auto motion, speed limit and home settings" width="49%">
</p>

Left, the Heart Rate tab. Right, the Axes tab with twist set to follow stroke.

The stats overlay on the video, two edges in: the ceiling has decayed from 120 to 118 BPM and strokes
are easing off at 72%. The navbar button shows the device status and live heart rate.

<p>
  <img src="docs/screenshots/overlay.png" alt="Stats overlay: 112 BPM, ceiling 118 (−2), easing 72%, 2 edges" width="300">
  <br>
  <img src="docs/screenshots/navbar.png" alt="Navbar button showing Connected and a heart rate of 112" width="360">
</p>

## Install

### Before you install

- Use a Chromium-based browser (Chrome, Edge): Web Serial and Web Bluetooth only exist there.
- Reach Stash on a secure origin: `localhost`, or HTTPS. If you reach it by a LAN address over plain
  HTTP, add that origin under `chrome://flags/#unsafely-treat-insecure-origin-as-secure` or serve Stash
  over HTTPS.
- The **Stash Interactive Tools** plugin is optional. Without it, Stash-TCode plays each scene's main
  funscript, single- or multi-axis, which Stash serves itself. You need it only for separate per-axis
  files (`video.twist.funscript`, `video.roll.funscript`, ...), which Stash doesn't serve on its own,
  and for picking between several scripts for one scene.

The plugin is tested on Stash v0.31.

### As a Stash plugin (recommended)

1. In Stash, go to **Settings → Plugins → Available Plugins → Add Source** and add
   `https://dtt-git.github.io/stash-tcode/main/index.yml`.
2. Tick **Stash-TCode** under that source and click **Install**. Refresh the page.
3. Click **Connect** in the navbar, then pick your device's serial port.
   After that first time it reconnects by itself.

The plugin works on whatever address you reach Stash at (port, reverse proxy or LAN name), and Stash
keeps it updated from the source above. Settings are saved in the browser, like the device permissions
they go with.

**Coming from the userscript:** update the userscript to 0.7.0 or later before installing the plugin
(Tampermonkey normally does this itself). On the next page load the userscript finds the plugin, copies
your settings over and stops running, and a pop-up tells you so. Refresh once to load them into the
plugin, then delete the userscript from Tampermonkey. An older userscript doesn't know about the plugin,
so both would run and drive the device twice.

To install by hand instead, put [`plugins/stash-tcode/stash-tcode.yml`](plugins/stash-tcode/stash-tcode.yml)
and [`stash-tcode.user.js`](stash-tcode.user.js) together in a `stash-tcode` folder in your Stash plugins
directory, then **Reload plugins** in Stash and refresh.

### As a Tampermonkey userscript

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open **[stash-tcode.user.js (raw)](https://raw.githubusercontent.com/dtt-git/stash-tcode/main/stash-tcode.user.js)**.
   Tampermonkey shows its install page; click **Install**. It then checks this repo for updates automatically.
3. Open Stash. Click **Connect** in the navbar, then pick your device's serial port.
   After that first time it reconnects by itself.

#### Stash on another address

Out of the box the userscript runs on any address with Stash's default port, `:9999`
(`http://localhost:9999`, `http://192.168.1.20:9999`, ...). If you reach Stash some other way, such as
a reverse proxy (`https://stash.example.com`) or a different port, add that address to the script in
Tampermonkey:

1. Open the Tampermonkey **Dashboard** and click **Stash-TCode**.
2. Go to its **Settings** tab and find **Includes/Excludes**.
3. Under **User includes**, add your address followed by `/*`, e.g. `https://stash.example.com/*`
   (one per line), and save.

User includes are kept when the script updates. Leave **Original includes** ticked if you also use
port 9999.

#### Upgrading from 0.5.x

The 0.5.x script was named "Stash-TCode (USB Fix)". Because the name changed, Tampermonkey installs this as a
new script with fresh settings. Set your ranges again and delete the old script.

## Heart-rate modulation

Connect a monitor under **Device → Heart rate monitor**. Any monitor with the standard Bluetooth
heart-rate service works: chest straps (Polar, Coospo, Garmin, Wahoo, ...) or a watch broadcasting
its heart rate. Then turn it on under **Heart Rate**.

- **Edge** is the heart rate that counts as an edge, and it's your ceiling. In the **approach band**
  below it (default 10 BPM), strokes shorten linearly down to the **shortest stroke** (default 30%). The stroke shortens from the bottom of its
  range; other axes shrink toward their home position.
- **At the ceiling** the stroker parks at the bottom of its range and sits out the script while the
  video keeps playing. Once your heart rate drops 5 BPM below the ceiling, strokes ramp back in over
  the **rejoin time** (default 8 s).
- **Adaptive ceiling decay** lowers the ceiling 2 BPM every 2 edges, down to a floor (105 BPM by
  default), to counter fatigue over a long session. It never raises the ceiling above what you typed.
- **Signal timeout:** if a connected monitor sends no real reading for 8 s, the device stops. That
  includes a strap that's been taken off but keeps repeating its last BPM: packets flagged "no skin
  contact", or a strap that was timing beats and stopped, don't count as readings. With no monitor
  connected at all, scripts play normally.
- **Session** shows the live state, and **Reset** clears the edge count and decay. The session
  survives a page reload but ends when you close the tab.

Chrome only reconnects a Bluetooth monitor after a refresh if
`chrome://flags/#enable-web-bluetooth-new-permissions-backend` is on. Without it, the Device tab
shows a one-click **Reconnect**.

## Climax markers

Add a Stash scene marker tagged **Climax** (the tag name is configurable on the **Climax** tab), or
use **Mark climax here** on that tab while the video is at the right spot. Around a climax marker the
limiter lets go, whatever your heart rate: strokes build back to full over 45 s before the marker,
stay full for 20 s (or for the marker's whole range, if it has an end time), then hand control back
over 15 s. All three times are adjustable.

## Development

`stash-tcode.user.js` is the whole program, for both installs: the plugin manifest loads it as the
plugin's script, and Tampermonkey installs it directly. The script checks which one it's running as
(only Tampermonkey provides the `GM_*` functions).

To try the plugin in a local Stash, copy it into your plugins folder, then **Reload plugins** in Stash and
refresh:

```bash
STASH_PLUGINS_DIR=/path/to/stash/plugins dev/deploy-plugin.sh
```

`STASH_PLUGINS_DIR` can also go in a `.env` file at the repo root. Run it again after each edit.

For the userscript, use the dev loader so you can edit in your editor and just refresh the browser,
with no copy-paste into Tampermonkey:

1. In the Tampermonkey extension's browser settings (`chrome://extensions` → Tampermonkey → Details),
   turn on **Allow access to file URLs**.
2. Open [`dev/dev-loader.user.js`](dev/dev-loader.user.js) and point the `@require` line at
   your local clone's `stash-tcode.user.js`.
3. Install the dev loader in Tampermonkey and disable the regular script while you work.
4. Edit `stash-tcode.user.js`, save, and refresh Stash.

If Tampermonkey seems to serve a stale copy, set **Settings → Externals → Update interval**
to *Always*.

### Debug tools

Turn on **Advanced → Debug mode** to get:

- **Simulated device:** stands in for the hardware. Commands are recorded but nothing moves.
- **Simulate heart rate:** a steady reading once a second in place of a monitor.
- `window.__tcode` in the page console: `commands()` (axis commands sent, parsed), `tx()`,
  `clearTx()`, `state()`, `hr()`, `hrPackets()` (raw monitor packets), `setHr(bpm)` / `setHr(null)`,
  `governor()`, `resetSession()`
  and `simulateDevice()`.

### Tests

The heart-rate governor's math (approach band, edge hysteresis, decay, rejoin ramp, climax window,
watchdog and axis shaping), the auto-motion sine and the speed limit, plus heart-rate packet decoding and
serial port selection, are covered by plain Node tests. `version.test.js` checks the version matches
everywhere it's written.

```
node tests/governor.test.js
node tests/hr-packets.test.js
node tests/serial.test.js
node tests/include.test.js
node tests/linked.test.js
node tests/version.test.js
```

### Releasing

Bump the version in all three places: `@version` in the header of `stash-tcode.user.js`,
`TCODE_VERSION` just below it, and `version:` in `plugins/stash-tcode/stash-tcode.yml`. Then push to
`main`.

- Userscript installs pick up the new version on Tampermonkey's next update check, because of the
  script's `@updateURL`. If you don't bump the version, Tampermonkey ignores the change.
- The **Deploy** workflow runs the tests and publishes the plugin source index to GitHub Pages
  (`https://dtt-git.github.io/stash-tcode/main/index.yml`), where Stash finds the update. GitHub Pages
  has to be turned on once, with **Settings → Pages → Source** set to *GitHub Actions*.

## Credits

- **dtt**: current maintainer.
- **Spunkle**: wrote the original Stash-TCode userscript.
- **Steel**: made the modded version this project builds on.
- Heart-rate modulation is inspired by [EdgeLoop](https://github.com/marshallmims/edgeloop) by
  marshallmims (AGPL-3.0) and reimplemented independently here.

Licensed under the [GNU GPL v3](LICENSE), the same as the original.
