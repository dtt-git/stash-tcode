# Stash-TCode

A Tampermonkey userscript that drives TCode devices (OSR2/SR6 and similar) from
[Stash](https://github.com/stashapp/stash) over USB using the Web Serial API.
It plays a scene's funscripts, including multi-axis ones, on the device in sync with the video.
With a Bluetooth heart-rate monitor it can also shorten strokes as your heart rate climbs and hold
off at the edge.

Maintained by **dtt**. Originally based on Stash-TCode by Steel, with modifications by Spunkle.

## Features

- Connects over USB via Web Serial at 115200 baud, with no websocket bridge, and reconnects
  on its own after a page refresh or when the device is plugged back in.
- Handles single-axis and multi-axis funscripts, plus separate per-axis files
  (`.surge`, `.sway`, `.twist`, `.roll`, `.pitch`).
- Per-axis range, invert and home position, all saved across refreshes.
- Settings live in a dialog built from Stash's own components, so it matches Stash and any custom theme.
- Heart-rate modulation, adaptive ceiling decay and climax markers (below).
- A stats overlay on the video: heart rate, ceiling, edges and what the limiter is doing.
- Handles seeking, including on transcoded streams.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open **[stash-tcode.user.js (raw)](https://raw.githubusercontent.com/dtt-git/stash-tcode/main/stash-tcode.user.js)**.
   Tampermonkey shows its install page; click **Install**. It then checks this repo for updates automatically.
3. Open Stash (it should be on port 9999). Click **Connect** in the navbar, then pick your device's serial port.
   After that first time it reconnects by itself.

Web Serial and Web Bluetooth only work in Chromium-based browsers (Chrome, Edge) and only on a
secure origin. If you reach Stash by a LAN hostname over plain HTTP, add that origin under
`chrome://flags/#unsafely-treat-insecure-origin-as-secure` or serve Stash over HTTPS.

Upgrading from 0.5.x "Stash-TCode (USB Fix)": the name changed, so Tampermonkey installs this as a
new script with fresh settings. Set your ranges again and delete the old script.

## Heart-rate modulation

Connect a monitor under **Device → Heart rate monitor**. Any monitor with the standard Bluetooth
heart-rate service works: chest straps (Polar, Coospo, Garmin, Wahoo, ...) or a watch broadcasting
its heart rate. Then turn it on under **Heart Rate**.

- **Edge** is the heart rate that counts as an edge, and it's your ceiling. In the **approach band** below it (default 10 BPM), strokes shorten
  linearly down to the **shortest stroke** (default 30%). The stroke shortens from the bottom of its
  range; other axes shrink toward their home position.
- **At the ceiling** the stroker parks at the bottom of its range and sits out the script while the
  video keeps playing. Once your heart rate drops 5 BPM below the ceiling, strokes ramp back in over
  the **rejoin time** (default 8 s).
- **Adaptive ceiling decay** lowers the ceiling 2 BPM every 2 edges, down to a floor (105 BPM by
  default), to counter fatigue over a long session. It never raises the ceiling above what you typed.
- **Signal timeout:** if a connected monitor sends nothing for 8 s, the device stops. With no monitor
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

Use the dev loader so you can edit in your editor and just refresh the browser,
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
  `clearTx()`, `state()`, `hr()`, `setHr(bpm)` / `setHr(null)`, `governor()`, `resetSession()`
  and `simulateDevice()`.

### Tests

The heart-rate governor's math (approach band, edge hysteresis, decay, rejoin ramp, climax window,
watchdog and axis shaping) is covered by plain Node tests:

```
node tests/governor.test.js
```

### Releasing

Bump `@version` in the header of `stash-tcode.user.js` and push to `main`. Installed copies pick up
the new version on Tampermonkey's next update check, because of the script's `@updateURL`.
If you don't bump the version, Tampermonkey ignores the change.

## Credits

- **dtt**: current maintainer.
- **Steel**: wrote the original Stash-TCode userscript.
- **Spunkle**: made the modded version this project builds on.
- Heart-rate modulation is inspired by [EdgeLoop](https://github.com/marshallmims/edgeloop) by
  marshallmims (AGPL-3.0) and reimplemented independently here.

Licensed under the [GNU GPL v3](LICENSE), the same as the original.
