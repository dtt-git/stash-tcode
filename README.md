# Stash-TCode

A Tampermonkey userscript that drives TCode devices (OSR2/SR6 and similar) from
[Stash](https://github.com/stashapp/stash) over USB using the Web Serial API.
It plays a scene's funscripts, including multi-axis ones, on the device in sync with the video.

Maintained by **dtt**. Originally based on Stash-TCode by Steel, with modifications by Spunkle.

## Features

- Connects over USB via Web Serial at 115200 baud. No websocket bridge needed.
- Handles single-axis and multi-axis funscripts, plus separate per-axis files
  (`.surge`, `.sway`, `.twist`, `.roll`, `.pitch`).
- Per-axis range, invert, random motion and home position, all saved across refreshes.
- Puts a connection-status button in the Stash navbar that opens the settings panel.
- Handles seeking, including on transcoded streams.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Open **[stash-tcode.user.js (raw)](https://raw.githubusercontent.com/dtt-git/stash-tcode/main/stash-tcode.user.js)**.
   Tampermonkey shows its install page; click **Install**. It then checks this repo for updates automatically.
3. Open Stash (it should be on port 9999). Click **Connect** in the navbar, then pick your device's serial port.

Web Serial only works in Chromium-based browsers and only on a secure origin.
If you reach Stash by a LAN hostname over plain HTTP, add that origin under
`chrome://flags/#unsafely-treat-insecure-origin-as-secure` or serve Stash over HTTPS.

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

## Credits

- **dtt**: current maintainer.
- **Steel**: wrote the original Stash-TCode userscript.
- **Spunkle**: made the modded version this project builds on.

Licensed under the [GNU GPL v3](LICENSE), the same as the original.

### Releasing

Bump `@version` in the header of `stash-tcode.user.js` and push to `main`. Installed copies pick up
the new version on Tampermonkey's next update check, because of the script's `@updateURL`.
If you don't bump the version, Tampermonkey ignores the change.
