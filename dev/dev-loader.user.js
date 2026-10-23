// ==UserScript==
// @name         Stash-TCode (dev)
// @namespace    https://github.com/dtt-git/stash-tcode
// @version      0.0.0-dev
// @description  Dev loader: runs stash-tcode.user.js straight from your local clone
// @include      /^https?:\/\/[^\/?#]+:9999\//
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        unsafeWindow
// @require      file:///C:/path/to/stash-tcode/stash-tcode.user.js
// ==/UserScript==

// Intentionally empty: the @require above pulls in the real script from disk.
// Keep the @include and @grant lines in sync with stash-tcode.user.js.
