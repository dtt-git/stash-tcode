// Stash-TCode: drives TCode devices from Stash over USB Web Serial, with optional heart-rate
// modulation. A Stash UI plugin: Stash loads this file into its page (see stash-tcode.yml).
// https://github.com/dtt-git/stash-tcode, GPLv3. By dtt, originally by Spunkle, modded by Steel.

// Wrapped so none of this lands in the page's globals.
(function(){

// --- HOST ---
const TCODE_VERSION = '1.1.0'; // keep in step with version: in stash-tcode.yml
const PLUGIN_ID = 'stash-tcode';
const STORE_PREFIX = 'stash-tcode:';
// Settings the retired Tampermonkey userscript leaves here when it finds this plugin installed.
const HANDOFF_KEY = STORE_PREFIX + 'userscript-settings';

// Saved values live in the browser, like the serial and Bluetooth permissions they refer to.
function storeGet(key, fallback){
    try {
        var raw = localStorage.getItem(STORE_PREFIX + key);
        return raw == null ? fallback : JSON.parse(raw);
    } catch(e) { return fallback; }
}

function storeSet(key, value){
    try { localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value)); }
    catch(e) { console.error("[TCode] Couldn't save settings:", e); }
}

// Take over settings the userscript handed over, once: they hold the ranges and devices the
// user actually set up. Later changes made in the plugin stand.
function importUserscriptSettings(own){
    if(own && own.importedUserscript){ return own; }
    try {
        var raw = localStorage.getItem(HANDOFF_KEY);
        if(raw == null){ return own; }
        var handed = JSON.parse(raw);
        handed.importedUserscript = true;
        storeSet("settings", handed);
        console.log("[TCode] Took over the userscript's settings");
        return handed;
    } catch(e) { return own; }
}
// ---------------------------------

var video="";
var lastPage = null;

var settings = loadSettings();

// --- SERIAL VARIABLES ---
var port = null;
var writer = null;
var keepReading = false;
var serialConnected = false;
var reader = null;
var readableStreamClosed = null;
var writableStreamClosed = null;
var textEncoder = new TextEncoder();
var serialBuffer = ""; // Buffer for accumulating fragmented serial responses
var bufferTimeout = null;
// ------------------------

var scriptList = null;
var scriptListRequest = null;   // the in-flight Interactive Tools lookup, shared by all axes
var AXIS = new Object();
var pending = false;
var msPending = false;
var lastActionMs = null;          // last playhead position we served, for seek detection
var SEEK_THRESHOLD_MS = 1000;     // forward jump beyond this is treated as a seek
var boundPlayer = null;           // the <video> our listeners are currently attached to
var lastSrc = null;               // last media source seen, for transcode offset caching
var streamOffsetMs = 0;           // scene-time offset of the current stream (transcode)
var videoPlayerLoaded = false;
var saveLimitsTimeout = null; // debounce handle for persisting axis ranges
var limitsReady = false; // true once saved ranges are restored; gates persistence so startup can't overwrite storage
const BOTH = 0;
const LOWER = 1;
const UPPER = 2;

function isNewerVersion (oldVer, newVer) {
    const oldParts = oldVer.split('.')
    const newParts = newVer.split('.')
    for (var i = 0; i < newParts.length; i++) {
        const a = ~~newParts[i]; const b = ~~oldParts[i];
        if (a > b) return true; if (a < b) return false;
    }
    return false;
}

function handleUpgrade(thisVersion){
    if(settings.currentVersion === undefined || isNewerVersion(settings.currentVersion, thisVersion)){
        return true;
    }
    return false;
}

function getLimit(axis, which=BOTH){
    var limits = [0, 9999];
    if(AXIS && AXIS[axis] && AXIS[axis].limits){
        limits = AXIS[axis].limits;
    } else if(settings.axes && settings.axes[axis] && settings.axes[axis].limits){
        limits = settings.axes[axis].limits; // fall back to saved range for the UI (e.g. menu opened before connect)
    }
    switch(which){
        case BOTH: return limits;
        case LOWER: return limits[0];
        case UPPER: return limits[1];
    }
}

function debug(text, value=""){
    if(settings.debug){
        if(value == ""){ console.log(text); } else { window[value] = text; }
    }
}

// Persist current in-memory axis ranges to storage (debounced).
// Called from setLimits() so scroll-wheel AND slider changes survive refresh.
function persistLimitsSoon(){
    if(!limitsReady){ return; } // don't save until saved ranges have been restored on load
    if(saveLimitsTimeout){ clearTimeout(saveLimitsTimeout); }
    saveLimitsTimeout = setTimeout(function(){
        for(var ax in AXIS){
            if(AXIS[ax] && AXIS[ax].limits != null && settings.axes[ax]){
                settings.axes[ax].limits = [AXIS[ax].limits[0], AXIS[ax].limits[1]];
            }
        }
        saveSettings();
        debug("[TCode] Persisted axis ranges to storage");
    }, 300);
}

function saveSettings(){
    storeSet("settings", settings);
    if(settings.saveToStash){ saveToStashSoon(); }
    publishDebugApi();
}

// --- SETTINGS IN STASH ---
// With "Save settings to Stash" on, the settings also live in Stash's plugin configuration, so
// every browser gets them, private windows included. Which serial port and heart-rate monitor
// to reopen stays with each browser, like the browser's permission to use them.

// The settings every browser shares: all but the per-browser ones.
function sharedSettings(){
    var copy = JSON.parse(JSON.stringify(settings));
    for(const k of ["serialPort", "knownAxes", "saveToStash", "currentVersion", "importedUserscript"]){ delete copy[k]; }
    delete copy.hr.deviceId; delete copy.hr.deviceName;
    return copy;
}

// Write the shared settings to Stash, or clear them there when saving to Stash is off.
// keepalive lets the request finish while the page is closing (too late to check first, as
// syncChangeToStash does; that only matters for a change made in the last moment anyway).
function writeStashSettings(keepalive){
    clearTimeout(stashSaveTimer); stashSaveTimer = null;
    var input = settings.saveToStash ? { saveToStash: true, settings: JSON.stringify(sharedSettings()) } : {};
    return stashGql("mutation($id: ID!, $input: Map!){ configurePlugin(plugin_id: $id, input: $input) }",
                    { id: PLUGIN_ID, input: input }, keepalive)
        .catch(function(e){ showToast("Couldn't save settings to Stash", e.message, "error"); throw e; });
}

// A change saved from any tab. A tab that was already open doesn't hear that saving to Stash
// was turned off elsewhere, so check first; otherwise its next change would turn it back on.
async function syncChangeToStash(){
    stashSaveTimer = null;
    try {
        var data = await stashGql("{ configuration { plugins } }");
        var cfg = (data.configuration.plugins || {})[PLUGIN_ID];
        if(!cfg || !cfg.saveToStash){
            settings.saveToStash = false;
            storeSet("settings", settings);
            showToast("Settings kept in this browser", "Saving to Stash was turned off in another browser.", "info");
            return;
        }
    } catch(e) { debug("[TCode] Couldn't check Stash's settings: " + e.message); return; }
    writeStashSettings().catch(function(){});
}

var stashSaveTimer = null;
function saveToStashSoon(){
    clearTimeout(stashSaveTimer);
    stashSaveTimer = setTimeout(syncChangeToStash, 300);
}
window.addEventListener('pagehide', function(){ if(stashSaveTimer){ writeStashSettings(true).catch(function(){}); } });

// At startup: if this Stash has saved settings, use them, keeping this browser's own device
// and monitor. If saving to Stash was turned off elsewhere, this browser stops too.
async function loadStashSettings(){
    var cfg;
    try {
        var data = await stashGql("{ configuration { plugins } }");
        cfg = (data.configuration.plugins || {})[PLUGIN_ID];
    } catch(e) { debug("[TCode] Couldn't read settings from Stash: " + e.message); return; }
    if(!cfg || !cfg.saveToStash || typeof cfg.settings !== 'string'){
        if(settings.saveToStash){ settings.saveToStash = false; storeSet("settings", settings); }
        return;
    }
    var stored;
    try { stored = JSON.parse(cfg.settings); }
    catch(e) { console.error("[TCode] Settings saved in Stash aren't valid JSON:", e); return; }
    var own = { serialPort: settings.serialPort, knownAxes: settings.knownAxes,
                deviceId: settings.hr.deviceId, deviceName: settings.hr.deviceName };
    loadSettings(stored);
    settings.serialPort = own.serialPort; settings.knownAxes = own.knownAxes;
    settings.hr.deviceId = own.deviceId; settings.hr.deviceName = own.deviceName;
    settings.saveToStash = true;
    storeSet("settings", settings);
    debug("[TCode] Using the settings saved in Stash");
}

// Settings from `stored` (or this browser's storage), upgraded and with defaults filled in.
function loadSettings(stored){
    var thisVersion = TCODE_VERSION;
    var axisDefaults = function(enabled){ return {enabled: enabled, invert: false, center: null, autoCenter: true, auto: false, autoHz: 0.5,
                                                  speedLimit: false, maxSpeed: 5, link: "", linkOverride: false,
                                                  idle: false, idleHz: 0.2, idleRange: 100}; }; // idle motion: L0 only
    var defaultSettings = {"debug": false, "sync": 0, "autoConnect": true, "serialPort": null, "showHud": true, "knownAxes": [],
                           "showNotifications": true, "centerTime": 1000, "homeEnabled": true,
                           "axes": { L0: axisDefaults(true), L1: axisDefaults(false), L2: axisDefaults(false),
                                     R0: axisDefaults(false), R1: axisDefaults(false), R2: axisDefaults(false) },
                           "hr": { deviceId: null, deviceName: null, enabled: false,
                                   edgeHr: 140, band: 10, floor: 30, rejoinSec: 8, timeoutSec: 8,
                                   decay: true, decayEvery: 2, decayBpm: 2, decayFloor: 105,
                                   climax: true, climaxRampSec: 45, climaxHoldSec: 20, climaxEaseSec: 15, climaxTag: "Climax" },
                           "currentVersion": thisVersion};
    settings = stored !== undefined ? stored : importUserscriptSettings(storeGet("settings", null));
    if(settings == null){ settings = defaultSettings; }
    handleUpgrade(thisVersion);
    // "Climax HR" was renamed "Edge HR": it's where an edge is called, not a climax.
    // Carry the old value over before defaults are filled in.
    if(settings.hr && settings.hr.climaxHr != null){
        if(settings.hr.edgeHr == null){ settings.hr.edgeHr = settings.hr.climaxHr; }
        delete settings.hr.climaxHr;
    }
    // The speed limit started as one global setting (in full travels/s as "maxSpeed",
    // then TCode units/s as "maxUnitsPerSec"). It's now per axis, in full travels/s like
    // MultiFunPlayer. Carry a global setting onto every axis.
    var globalLimit = settings.maxUnitsPerSec != null ? settings.maxUnitsPerSec / 9999
                    : (settings.maxSpeed != null ? settings.maxSpeed : null);
    if(settings.axes && (globalLimit != null || settings.speedLimit != null)){
        for(const ax in settings.axes){
            var a = settings.axes[ax];
            if(a.maxSpeed == null && globalLimit != null){ a.maxSpeed = Math.round(globalLimit * 4) / 4; }
            if(a.speedLimit == null){ a.speedLimit = !!settings.speedLimit; }
        }
    }
    delete settings.speedLimit; delete settings.maxUnitsPerSec; delete settings.maxSpeed;
    // Axes the device has reported before (see processLimits). Installs that have already
    // connected a device have seen all of theirs, so their on/off choices stand.
    if(settings.knownAxes === undefined){
        settings.knownAxes = settings.serialPort ? ["L0", "L1", "L2", "R0", "R1", "R2"] : [];
    }
    backfillDefaults(settings, defaultSettings);
    // Drop settings for features that no longer exist (hotkeys, random motion).
    for(const gone of ["device", "initialKey", "minKey", "settingsKey", "syncKey"]){ delete settings[gone]; }
    for(const ax in settings.axes){ delete settings.axes[ax].random; }
    delete settings.hr.restingHr;
    return settings;
}

// Fill in any key missing from `target`, recursing into nested objects, so settings
// groups added after a user's settings were first written get their defaults on upgrade.
// Arrays and null count as values, not groups.
function backfillDefaults(target, defaults){
    for(const k in defaults){
        var d = defaults[k];
        if(target[k] === undefined){
            target[k] = (d && typeof d === "object" && !Array.isArray(d)) ? JSON.parse(JSON.stringify(d)) : d;
        }else if(d && typeof d === "object" && !Array.isArray(d) && target[k] && typeof target[k] === "object"){
            backfillDefaults(target[k], d);
        }
    }
}

// --- UI TOOLKIT ---
// Everything is built from Stash's own markup (Bootstrap 4 + its .setting-section/.setting
// rows), so it picks up Stash's theme, including any custom CSS the user has installed.
// The stylesheet below only covers layout details and the range sliders, which Stash
// doesn't style.

var STASH = { bg: "#202b33", card: "#30404d", input: "#394b59", accent: "#137cbd", text: "#f5f8fa",
              muted: "#bfccd6", success: "#0f9960", warning: "#d9822b", danger: "#db3737" };

function injectUiStyles(){
    injectNavStyles(); // the status dot's style
    if(document.getElementById('tcode-ui-styles')){ return; }
    var s = document.createElement('style');
    s.id = 'tcode-ui-styles';
    s.textContent = `
#tcode-modal .modal-header { align-items: center; }
#tcode-modal .modal-title { display: flex; align-items: center; gap: .5rem; }
#tcode-modal .modal-body { padding-top: .5rem; }
#tcode-modal .nav-tabs { margin: 0 0 1rem; }
#tcode-modal .nav-tabs .nav-link { cursor: pointer; }
#tcode-modal .setting-section h1 { font-size: 1.1rem; margin-bottom: .25rem; }
#tcode-modal .setting-section > .sub-heading { color: ${STASH.muted}; margin: 0 0 .5rem; }
#tcode-modal .setting-section:not(:first-child) { margin-top: 1.25rem; }
#tcode-modal .setting { gap: 1rem; padding: 12px 15px; }
#tcode-modal .setting > div:first-child { flex: 1 1 auto; min-width: 0; }
#tcode-modal .setting > div:last-child { flex: 0 0 auto; min-width: 0; }
#tcode-modal .setting h3 { font-size: 1rem; }
#tcode-modal .setting .sub-heading { color: ${STASH.muted}; margin-top: .25rem; }
#tcode-modal .setting.sub-setting { padding-left: 2rem; }
#tcode-modal .setting.disabled > div:last-child { opacity: .5; pointer-events: none; }
#tcode-modal .setting.dep { padding-left: 3.5rem; } /* only shown while the setting above it is on */
#tcode-modal .setting.dep.off { display: none; }
#tcode-modal .setting-group { padding-bottom: 0; }
#tcode-modal .setting-group:not(:last-child) { border-bottom: 1px solid #000; }
#tcode-modal .setting-group > .setting { border-bottom: none; }
#tcode-modal .setting-group .setting { flex-wrap: nowrap; } /* Stash wraps grouped rows; keep controls beside their label */
#tcode-modal .setting-group.collapsed > .setting:not(:first-child) { display: none; }
#tcode-modal .modal-footer { justify-content: space-between; }
#tcode-modal .tcode-version { color: ${STASH.muted}; font-size: .8rem; }
#tcode-modal .tcode-number { width: 90px; text-align: right; display: inline-block; }
#tcode-modal .tcode-suffix { margin-left: .4rem; color: ${STASH.muted}; }
#tcode-modal .tcode-status { white-space: nowrap; } /* the dot itself is styled in injectNavStyles */
#tcode-modal .tcode-list { margin: .25rem 0 0; padding-left: 1.1rem; color: ${STASH.muted}; }

/* Range sliders: thin track in the input colour, accent fill, light thumb. */
.tcode-range { display: flex; align-items: center; gap: .6rem; width: 360px; max-width: 100%; }
.tcode-range .tcode-track { position: relative; flex: 1 1 auto; height: 20px; }
.tcode-range input[type=range] {
    -webkit-appearance: none; appearance: none; position: absolute; inset: 0; width: 100%; height: 20px;
    margin: 0; background: transparent; outline: none; --lo: 0%; --hi: 0%;
}
.tcode-range input[type=range]::-webkit-slider-runnable-track {
    height: 4px; border-radius: 2px;
    background: linear-gradient(to right, ${STASH.input} 0 var(--lo), ${STASH.accent} var(--lo) var(--hi), ${STASH.input} var(--hi) 100%);
}
.tcode-range input[type=range]::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none; width: 14px; height: 14px; margin-top: -5px; border-radius: 50%;
    background: ${STASH.text}; box-shadow: 0 0 0 1px rgba(16,22,26,.4), 0 1px 2px rgba(16,22,26,.4); cursor: pointer;
}
.tcode-range input[type=range]:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 3px rgba(19,124,189,.6); }
.tcode-range input[type=range]:disabled::-webkit-slider-thumb { background: ${STASH.muted}; cursor: default; }
.tcode-range.dual input[type=range] { pointer-events: none; }
.tcode-range.dual input[type=range]::-webkit-slider-thumb { pointer-events: auto; }
.tcode-range.dual input[type=range].upper::-webkit-slider-runnable-track { background: transparent; }
.tcode-range output { min-width: 10.5em; text-align: right; font-variant-numeric: tabular-nums; color: ${STASH.text}; font-size: .9rem; }

/* Phones: a 360px slider beside its label squeezed the label to a letter per line. Let a
   control drop below its label when both don't fit, and let sliders shrink to the row. */
@media (max-width: 575.98px) {
    #tcode-modal .setting, #tcode-modal .setting-group .setting { flex-wrap: wrap; row-gap: .5rem; }
    #tcode-modal .setting > div:first-child { flex: 1 1 8rem; }
    #tcode-modal .setting > div:last-child { flex: 0 1 auto; max-width: 100%; }
    .tcode-range output { min-width: 0; }
}

/* Toasts, in Stash's secondary colour with a coloured edge per type. */
#tcode-toasts { position: fixed; bottom: 1.5rem; left: 50%; transform: translateX(-50%); z-index: 1080;
                display: flex; flex-direction: column-reverse; gap: .5rem; pointer-events: none; width: 360px; max-width: calc(100vw - 32px); }
.tcode-toast { background: ${STASH.input}; color: ${STASH.text}; border-radius: 3.5px; border-left: 4px solid ${STASH.accent};
               box-shadow: 0 2px 8px rgba(16,22,26,.5); padding: .5rem .75rem; font-size: .875rem;
               transition: opacity .25s ease, transform .25s ease; }
.tcode-toast.success { border-left-color: ${STASH.success}; }
.tcode-toast.warning { border-left-color: ${STASH.warning}; }
.tcode-toast.error { border-left-color: ${STASH.danger}; }
.tcode-toast .tcode-toast-title { font-weight: 600; }
.tcode-toast .tcode-toast-body { color: ${STASH.muted}; margin-top: .1rem; }
.tcode-toast.hiding { opacity: 0; transform: translateY(-6px); }
`;
    document.head.appendChild(s);
}

// Tiny DOM builder. props: class, text, style (cssText), on<event> handlers; value,
// checked and disabled are set as properties; anything else becomes an attribute.
function el(tag, props, children){
    var e = document.createElement(tag);
    for(var k in (props || {})){
        var v = props[k];
        if(v == null || v === false && k !== 'value'){ continue; }
        if(k === 'class'){ e.className = v; }
        else if(k === 'text'){ e.textContent = v; }
        else if(k === 'style'){ e.style.cssText = v; }
        else if(k === 'value' || k === 'checked' || k === 'disabled'){ e[k] = v; }
        else if(k.indexOf('on') === 0){ e.addEventListener(k.slice(2), v); }
        else { e.setAttribute(k, v); }
    }
    for(var c of (children || [])){
        if(c == null){ continue; }
        e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
}

// A Stash settings section: heading, optional sub-heading, and the card rows go into.
function uiSection(parent, title, subheading){
    var card = el('div', {class: 'card'});
    parent.appendChild(el('div', {class: 'setting-section'}, [
        el('h1', {text: title}),
        subheading ? el('div', {class: 'sub-heading', text: subheading}) : null,
        card
    ]));
    return card;
}

// One Stash settings row: title and hint on the left, control on the right.
function uiSetting(parent, title, hint, control, opts){
    opts = opts || {};
    var row = el('div', {class: 'setting' + (opts.sub ? ' sub-setting' : '') + (opts.dep ? ' dep' : '') + (opts.disabled ? ' disabled' : '')}, [
        el('div', null, [el('h3', {text: title}), hint ? el('div', {class: 'sub-heading', text: hint}) : null]),
        el('div', null, [control])
    ]);
    parent.appendChild(row);
    return row;
}

function uiSwitch(id, checked, onChange){
    var input = el('input', {type: 'checkbox', id: 'tcode-' + id, class: 'custom-control-input', checked: !!checked,
                             onchange: function(){ onChange(input.checked); }});
    return el('div', {class: 'custom-control custom-switch'}, [input, el('label', {class: 'custom-control-label', for: 'tcode-' + id})]);
}

function uiButton(label, variant, onClick, opts){
    opts = opts || {};
    return el('button', {type: 'button', class: 'btn btn-' + (variant || 'secondary') + (opts.small ? ' btn-sm' : ''),
                         text: label, disabled: !!opts.disabled, onclick: onClick});
}

// Number box. Out-of-range or empty input snaps back to the nearest valid value on change.
function uiNumber(id, value, o, onChange){
    var input = el('input', {type: 'number', id: 'tcode-' + id, class: 'input-control form-control form-control-sm tcode-number',
                             min: o.min, max: o.max, step: o.step || 1, value: value});
    input.addEventListener('change', function(){
        var v = parseFloat(input.value);
        if(!isFinite(v)){ v = value; }
        v = Math.min(o.max, Math.max(o.min, v));
        input.value = v; value = v;
        onChange(v);
    });
    return el('span', null, [input, o.suffix ? el('span', {class: 'tcode-suffix', text: o.suffix}) : null]);
}

function setRangeFill(input, loPct, hiPct){
    input.style.setProperty('--lo', loPct + '%');
    input.style.setProperty('--hi', hiPct + '%');
}

// Single slider with a readout. o: {min, max, step, format(v), origin}. The fill runs from
// `origin` (default min) to the value. onInput fires while dragging, onChange on release.
// Returns {el, set(v), setDisabled(bool)}.
function uiRange(id, value, o, onInput, onChange){
    var fmt = o.format || function(v){ return String(v); };
    var input = el('input', {type: 'range', id: 'tcode-' + id, min: o.min, max: o.max, step: o.step || 1, value: value});
    var out = el('output', {for: 'tcode-' + id});
    var toPct = function(v){ return (v - o.min) / (o.max - o.min) * 100; };
    function paint(){
        var v = parseFloat(input.value), from = toPct(o.origin != null ? o.origin : o.min), to = toPct(v);
        setRangeFill(input, Math.min(from, to), Math.max(from, to));
        out.textContent = fmt(v);
    }
    input.addEventListener('input', function(){ paint(); if(onInput){ onInput(parseFloat(input.value)); } });
    input.addEventListener('change', function(){ if(onChange){ onChange(parseFloat(input.value)); } });
    paint();
    return {
        el: el('div', {class: 'tcode-range'}, [el('div', {class: 'tcode-track'}, [input]), out]),
        set: function(v){ input.value = v; paint(); },
        setDisabled: function(d){ input.disabled = d; }
    };
}

// Two-handled range slider: two overlapping range inputs whose thumbs can't cross.
// onInput(lo, hi) fires while dragging, onChange(lo, hi) on release.
function uiDualRange(id, lo, hi, o, onInput, onChange){
    var fmt = o.format || function(v){ return String(v); };
    var lower = el('input', {type: 'range', class: 'lower', id: 'tcode-' + id + '-min', min: o.min, max: o.max, step: o.step || 1, value: lo,
                             'aria-label': 'Minimum'});
    var upper = el('input', {type: 'range', class: 'upper', id: 'tcode-' + id + '-max', min: o.min, max: o.max, step: o.step || 1, value: hi,
                             'aria-label': 'Maximum'});
    var out = el('output');
    function values(){ return [parseFloat(lower.value), parseFloat(upper.value)]; }
    function paint(){
        var v = values(), span = o.max - o.min;
        setRangeFill(lower, (v[0] - o.min) / span * 100, (v[1] - o.min) / span * 100);
        out.textContent = fmt(v[0]) + ' – ' + fmt(v[1]);
        // Upper sits above lower so its thumb isn't crossed by the lower's track; flip that
        // when the lower thumb is near the top end, or it couldn't be grabbed there.
        var lowerOnTop = v[0] > o.max - span * 0.05;
        lower.style.zIndex = lowerOnTop ? 2 : 1;
        upper.style.zIndex = lowerOnTop ? 1 : 2;
    }
    function onMove(e){
        var v = values();
        if(v[0] > v[1]){
            if(e.target === lower){ lower.value = v[1]; } else { upper.value = v[0]; }
        }
        paint();
        if(onInput){ onInput.apply(null, values()); }
    }
    lower.addEventListener('input', onMove); upper.addEventListener('input', onMove);
    lower.addEventListener('change', function(){ if(onChange){ onChange.apply(null, values()); } });
    upper.addEventListener('change', function(){ if(onChange){ onChange.apply(null, values()); } });
    paint();
    return { el: el('div', {class: 'tcode-range dual'}, [el('div', {class: 'tcode-track'}, [lower, upper]), out]) };
}

// --- TOASTS ---
function showToast(title, message, type = 'info', duration = 4000) {
    if (!settings.showNotifications) return;
    injectUiStyles();
    var box = document.getElementById('tcode-toasts');
    if(!box){ box = el('div', {id: 'tcode-toasts', role: 'status', 'aria-live': 'polite'}); document.body.appendChild(box); }
    var toast = el('div', {class: 'tcode-toast ' + type}, [
        el('div', {class: 'tcode-toast-title', text: title}),
        message ? el('div', {class: 'tcode-toast-body', text: message}) : null
    ]);
    box.appendChild(toast);
    setTimeout(function(){
        toast.classList.add('hiding');
        setTimeout(function(){ toast.remove(); }, 250);
    }, duration);
}

// ---------------------------------

// --- NAVBAR BUTTON (appended to the very end of the Donate/Stats/Settings/Help cluster) ---

// Persistent styles for the nav button and the status dot. Added once; unlike the settings
// stylesheet this must NOT be torn down when the menu closes.
function injectNavStyles(){
    if(document.getElementById('tcode-nav-styles')){ return; }
    var s = document.createElement('style');
    s.id = 'tcode-nav-styles';
    // One status dot for the navbar and the settings dialog, centred on the height of a capital
    // letter (about .71em in Stash's font), so it lines up with "Connected", the heart and the
    // BPM digits. Raising its bottom edge by half that, less half the dot, does it.
    s.textContent = `
        .tcode-dot {
            display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px;
            vertical-align: calc(.355em - 4px); background: ${STASH.danger}; transition: background 0.2s ease;
        }
        .tcode-dot.on { background: ${STASH.success}; }
        #tcode-nav-btn { display: flex; align-items: center; }
        #tcode-nav-btn .tcode-nav-status { white-space: nowrap; }
        #tcode-nav-btn .tcode-nav-hr { margin-left: 8px; font-variant-numeric: tabular-nums; white-space: nowrap; }
        #tcode-nav-btn .tcode-nav-hrdot { margin-left: -3px; } /* 3px from the device dot */
        #tcode-nav-btn .tcode-nav-heart { color: #ff7373; margin-right: 3px; }
        /* Phones: the label is hidden, leaving the dot alone. Centre it in a button as wide as
           the icon buttons beside it (SFW Switch, New), with the same gap after it. */
        @media (max-width: 575.98px) {
            .navbar-buttons .tcode-nav-slot { margin-right: .5rem; }
            #tcode-nav-btn { min-width: 42px; justify-content: center; }
            #tcode-nav-btn .tcode-dot { margin-right: 0; }
            #tcode-nav-btn .tcode-nav-hrdot { margin-left: 3px; }
            #tcode-nav-btn .tcode-nav-hr { margin-left: 6px; }
        }
    `;
    document.head.appendChild(s);
}

// Reflect current serial status on the nav button (dot colour + label + tooltip).
function updateNavButton(){
    refreshSettingsTab('device');
    var btn = document.getElementById('tcode-nav-btn');
    if(!btn){ return; }
    var labelText = btn.querySelector('.tcode-nav-label-text');
    btn.querySelector('.tcode-nav-devdot').classList.toggle('on', serialConnected);
    if(labelText){ labelText.textContent = serialConnected ? "Connected" : "Connect"; }
    setNavTitle(btn);
}

function setNavTitle(btn){
    var parts = ["TCode: " + (serialConnected ? "connected" : "not connected")];
    if(settings.hr.enabled){ parts.push("heart rate monitor: " + (hrLive() ? hr.bpm + " BPM" : "no reading")); }
    btn.title = parts.join(" · ") + " — click for settings";
}

function createNavButton(){
    injectNavStyles();
    var btn = document.createElement('button');
    btn.id = 'tcode-nav-btn';
    btn.type = 'button';
    // Match the Stats/Settings button classes (flex + vertically centered) plus Stash's
    // own nav-utility styling, so it sits flush with its neighbors.
    btn.className = 'nav-utility minimal d-flex align-items-center h-100 btn btn-primary';
    // The dots and label share one line of text, so the dots line up with the letters. The
    // second dot (the heart-rate monitor) sits beside the device's while modulation is on.
    btn.innerHTML = '<span class="tcode-nav-status"><span class="tcode-dot tcode-nav-devdot"></span>' +
        '<span class="tcode-dot tcode-nav-hrdot" style="display: none"></span>' +
        '<span class="d-none d-sm-inline tcode-nav-label-text">Connect</span></span>' +
        '<span class="tcode-nav-hr" style="display: none"><span class="tcode-nav-heart">♥</span><span class="tcode-nav-bpm"></span></span>';
    btn.addEventListener('click', function(){ toggleMenu(); });
    return btn;
}

// Append the button as the very last child of the Donate/Stats/Settings/Help cluster
// (.navbar-buttons — distinct from the primary Scenes/Images/.../Tags nav-link list,
// which is also, confusingly, classed .navbar-nav). No-op if already present, so the
// keep-alive interval can call it freely.
// Phones (Stash's phone layout, where it hides the Donate/Stats/Settings buttons from the bar and
// shows them in the menu): the button steps in front of Stash's New button, wherever plugins put
// theirs. Wider, or on a page without New, it sits in its own slot at the end of the cluster.
// Only our button moves, never Stash's or anyone else's.
var NAV_NARROW = '(max-width: 575.98px)';
function syncNavPlacement(slot){
    var btn = document.getElementById('tcode-nav-btn');
    var cluster = slot && slot.closest('.navbar-buttons');
    if(!btn || !cluster){ return; }
    var newBtn = cluster.querySelector('a[href$="/new"]');
    var newItem = newBtn && newBtn.closest('.navbar-buttons > *');
    if(window.matchMedia(NAV_NARROW).matches && newItem){
        btn.classList.add('mr-2');
        if(btn.nextSibling !== newItem){ newItem.before(btn); }
    }else{
        btn.classList.remove('mr-2');
        if(btn.parentNode !== slot){ slot.appendChild(btn); }
    }
}

function injectNavButton(){
    if(document.getElementById('tcode-nav-btn')){ return; }
    var navButtons = document.querySelector('.navbar-buttons');
    if(!navButtons){ return; } // navbar not rendered yet; the keep-alive will retry
    navButtons.appendChild(createNavButton()); // very end of the cluster
    updateNavButton();
    updateHrUi();
}

// As a plugin, the button goes in through Stash's patchable navbar utility items, so React
// keeps it in place across re-renders. Stash renders those items twice, in the collapsed
// menu and in the .navbar-buttons cluster; the button goes in the cluster only.
function patchNavButton(api){
    var React = api.React;
    function TcodeNavSlot(){
        var ref = React.useRef(null);
        React.useEffect(function(){
            var slot = ref.current;
            if(!slot || !slot.closest('.navbar-buttons') || document.getElementById('tcode-nav-btn')){ return; }
            slot.appendChild(createNavButton());
            updateNavButton();
            updateHrUi();
            // Re-place on resize, and after navigation (New comes and goes with the page).
            var sync = function(){ syncNavPlacement(slot); };
            var narrow = window.matchMedia(NAV_NARROW);
            var onPage = function(){ setTimeout(sync, 0); };
            sync();
            narrow.addEventListener('change', sync);
            window.addEventListener('resize', sync); // not every resize reports a media change
            if(window.PluginApi && window.PluginApi.Event){ window.PluginApi.Event.addEventListener('stash:location', onPage); }
            return function(){
                narrow.removeEventListener('change', sync);
                window.removeEventListener('resize', sync);
                if(window.PluginApi && window.PluginApi.Event){ window.PluginApi.Event.removeEventListener('stash:location', onPage); }
                var btn = document.getElementById('tcode-nav-btn');
                if(btn){ btn.remove(); }
            };
        }, []);
        return React.createElement('div', {ref: ref, className: 'tcode-nav-slot d-flex align-items-center'});
    }
    // Stash appends the rendered result after the call's args, and another plugin's before
    // patch can change how many args there are, so the result is the last one.
    api.patch.after("MainNavBar.UtilityItems", function(){
        return React.createElement(React.Fragment, null, arguments[arguments.length - 1], React.createElement(TcodeNavSlot));
    });
}

function startNavButton(){
    var api = window.PluginApi;
    // Stash loads plugins before it first draws the navbar, so the patch is in place in time.
    if(api && api.patch && api.React){ patchNavButton(api); return; }
    // An older Stash without patching re-renders the navbar on navigation, which can drop our
    // button. Re-inject on an interval (cheap; a no-op while it's there).
    injectNavButton();
    setInterval(injectNavButton, 1000);
}

// --- SETTINGS DIALOG ---
// A Stash-style modal with a tab per area. Controls write straight into `settings` and
// persist immediately, so closing the dialog never has anything left to save.

var AXIS_LIST = ["L0", "L1", "L2", "R0", "R1", "R2"];
var AXIS_NAMES = { L0: "Stroke", L1: "Surge", L2: "Sway", R0: "Twist", R1: "Roll", R2: "Pitch" };

// Tabs in display order; later sections of the script push their own.
var SETTINGS_TABS = [
    { id: 'device', label: 'Device', build: buildDeviceTab },
    { id: 'axes', label: 'Axes', build: buildAxesTab },
    { id: 'advanced', label: 'Advanced', build: buildAdvancedTab }
];
var activeTab = 'device';

function pct(v){ return Math.round(v / 99.99) + '%'; } // device units (0-9999) as a percentage
function ms(v){ return Math.round(v) + ' ms'; }

function settingsOpen(){ return !!document.getElementById('tcode-modal'); }

function toggleMenu(){
    if(settingsOpen()){ closeSettings(); } else { openSettings(); }
}

function openSettings(){
    if(settingsOpen()){ return; }
    injectUiStyles();
    var nav = el('nav', {class: 'nav nav-tabs', role: 'tablist'});
    var body = el('div', {id: 'tcode-modal-body'});
    var modal = el('div', {class: 'modal fade show', id: 'tcode-modal', role: 'dialog', 'aria-modal': 'true',
                           'aria-labelledby': 'tcode-modal-title', tabindex: '-1', style: 'display: block;'}, [
        el('div', {class: 'modal-dialog modal-lg modal-dialog-scrollable'}, [
            el('div', {class: 'modal-content'}, [
                el('div', {class: 'modal-header'}, [
                    el('div', {class: 'modal-title h4', id: 'tcode-modal-title'}, ['TCode']),
                    el('button', {type: 'button', class: 'close', 'aria-label': 'Close', onclick: closeSettings}, [el('span', {'aria-hidden': 'true', text: '×'})])
                ]),
                el('div', {class: 'modal-body'}, [nav, body]),
                el('div', {class: 'modal-footer'}, [
                    el('span', {class: 'tcode-version', text: 'Stash-TCode ' + TCODE_VERSION}),
                    uiButton('Close', 'secondary', closeSettings)
                ])
            ])
        ])
    ]);
    // Clicking the dimmed area outside the dialog closes it.
    modal.addEventListener('mousedown', function(e){ if(e.target === modal){ closeSettings(); } });
    document.body.appendChild(el('div', {class: 'modal-backdrop fade show', id: 'tcode-modal-backdrop'}));
    document.body.appendChild(modal);
    document.body.classList.add('modal-open');
    document.addEventListener('keydown', onSettingsKey, true);
    for(var tab of SETTINGS_TABS){
        nav.appendChild(el('a', {class: 'nav-item nav-link', role: 'tab', 'data-tab': tab.id, text: tab.label,
                                 onclick: (function(id){ return function(){ showTab(id); }; })(tab.id)}));
    }
    showTab(activeTab);
    modal.focus();
}

// Removes the dialog unconditionally: a stray full-screen layer would swallow every
// click on the page.
function closeSettings(){
    try { saveSettings(); } catch(e){ debug("[TCode] saveSettings error on close: " + e); }
    for(var id of ['tcode-modal', 'tcode-modal-backdrop']){
        var node = document.getElementById(id);
        if(node){ node.remove(); }
    }
    document.body.classList.remove('modal-open');
    document.removeEventListener('keydown', onSettingsKey, true);
}

function onSettingsKey(e){
    if(e.key === 'Escape'){ e.stopPropagation(); closeSettings(); }
}

function showTab(id){
    if(!SETTINGS_TABS.some(function(t){ return t.id === id; })){ id = SETTINGS_TABS[0].id; }
    activeTab = id;
    document.querySelectorAll('#tcode-modal .nav-tabs .nav-link').forEach(function(a){
        var on = a.getAttribute('data-tab') === id;
        a.classList.toggle('active', on);
        a.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    renderActiveTab();
}

// Rebuild the visible tab from current state (after a connection change, etc.).
function renderActiveTab(){
    var body = document.getElementById('tcode-modal-body');
    if(!body){ return; }
    var tab = SETTINGS_TABS.find(function(t){ return t.id === activeTab; });
    body.textContent = '';
    tab.build(body);
}

// Re-render only if the given tab is the one showing, so live updates don't reset a
// tab the user is working in.
function refreshSettingsTab(id){
    if(settingsOpen() && activeTab === id){ renderActiveTab(); }
}

// ---- Device tab ----
function buildDeviceTab(body){
    var card = uiSection(body, "Device");
    var status;
    if(!serialConnected){ status = "Not connected"; }
    else if(simulatedDevice){ status = "Simulated device (debug)"; }
    else { status = "Connected over USB" + portLabel(); }
    var statusEl = el('span', {class: 'tcode-status'}, [el('span', {class: 'tcode-dot' + (serialConnected ? ' on' : '')}), status]);
    var row = uiSetting(card, "TCode device", null,
        serialConnected ? uiButton("Disconnect", "secondary", disconnectSerial)
                        : uiButton("Connect", "primary", connectSerial));
    row.firstChild.appendChild(el('div', {class: 'sub-heading'}, [statusEl]));
    uiSetting(card, "Reconnect automatically", "Reopen the device on page load, and when it's plugged back in.",
        uiSwitch('autoConnect', settings.autoConnect !== false, function(v){ settings.autoConnect = v; saveSettings(); }));

    var hrCard = uiSection(body, "Heart rate monitor");
    var hrButton;
    if(hr.status === 'live' || hr.status === 'connecting' || hr.status === 'reconnecting'){
        hrButton = uiButton("Disconnect", "secondary", disconnectHr);
    }else if(settings.hr.deviceId && !hrCanAutoReconnect()){
        hrButton = uiButton("Reconnect", "primary", connectHr);
    }else{
        hrButton = uiButton("Connect", "primary", connectHr);
    }
    var hrRow = uiSetting(hrCard, "Monitor", null, hrButton);
    hrRow.firstChild.appendChild(el('div', {class: 'sub-heading'}, [
        el('span', {class: 'tcode-status'}, [el('span', {class: 'tcode-dot' + (hrLive() ? ' on' : ''), id: 'tcode-hr-dot'}),
                                             el('span', {id: 'tcode-hr-status', text: hrStatusText()})])
    ]));
    hrRow.firstChild.appendChild(el('div', {class: 'sub-heading',
        text: "Any Bluetooth monitor with the standard heart-rate service: chest straps, or watches broadcasting HR."}));

    var play = uiSection(body, "Playback");
    uiSetting(play, "Sync offset", "Shifts the script against the video. Positive plays strokes earlier.",
        uiRange('sync', parseInt(settings.sync) || 0, {min: -250, max: 250, origin: 0, format: ms}, null,
                function(v){ settings.sync = v; saveSettings(); }).el);

    var home = uiSection(body, "Homing");
    uiSetting(home, "Home on connect and scene change", "Off leaves the device wherever it stopped.",
        uiSwitch('homeEnabled', settings.homeEnabled !== false, function(v){ settings.homeEnabled = v; saveSettings(); }));
    uiSetting(home, "Home travel time", "How long the move to the home position takes. Longer is gentler.",
        uiRange('centerTime', parseInt(settings.centerTime) || 1000, {min: 100, max: 5000, step: 50, format: ms}, null,
                function(v){ settings.centerTime = v; saveSettings(); }).el);
    uiSetting(home, "Home now", "Move every enabled axis to its home position.",
        uiButton("Home now", "secondary", function(){ centerAll(); }, {disabled: !serialConnected}));
}

function portLabel(){
    var p = settings.serialPort;
    if(!p || p.usbVendorId == null){ return ""; }
    var hex = function(n){ return Number(n).toString(16).toUpperCase().padStart(4, '0'); };
    return " (" + hex(p.usbVendorId) + ":" + hex(p.usbProductId) + ")";
}

// ---- Axes tab ----
function buildAxesTab(body){
    var card = uiSection(body, "Axes", "Range limits how far each axis travels. Home is where it rests when idle.");
    AXIS_LIST.forEach(function(axis){ buildAxisGroup(card, axis); });
}

function buildAxisGroup(card, axis){
    var cfg = settings.axes[axis];
    var group = el('div', {class: 'setting-group' + (cfg.enabled ? '' : ' collapsed')});
    card.appendChild(group);

    uiSetting(group, axis + " · " + AXIS_NAMES[axis], null, uiSwitch('enable' + axis, cfg.enabled, function(v){
        cfg.enabled = v;
        group.classList.toggle('collapsed', !v);
        saveSettings();
    }));

    var lim = getLimit(axis, BOTH);
    var homeRange;
    function applyRange(lo, hi, send){
        cfg.limits = [lo, hi];
        if(AXIS[axis]){ setLimits(lo, hi, axis, send); }
        if(send){ saveSettings(); }
        syncHome();
    }
    uiSetting(group, "Range", null,
        uiDualRange('range' + axis, parseInt(lim[0]), parseInt(lim[1]), {min: 0, max: 9999, format: pct},
            function(lo, hi){ applyRange(lo, hi, false); },
            function(lo, hi){ applyRange(lo, hi, true); }).el, {sub: true});
    uiSetting(group, "Invert", "Flip the direction of this axis.",
        uiSwitch('invert' + axis, cfg.invert, function(v){ cfg.invert = v; saveSettings(); }), {sub: true});
    // Rows that only matter while another setting is on stay hidden until it is (see syncRows).
    var rows = {};
    var linkSelect = el('select', {id: 'tcode-link' + axis, class: 'input-control form-control form-control-sm', style: 'width: 160px'},
        [el('option', {value: '', text: 'Off'})].concat(AXIS_LIST.filter(function(o){ return o !== axis; }).map(function(o){
            return el('option', {value: o, text: o + ' · ' + AXIS_NAMES[o]});
        })));
    linkSelect.value = cfg.link || '';
    linkSelect.addEventListener('change', function(){
        cfg.link = linkSelect.value;
        syncRows();
        saveSettings();
    });
    uiSetting(group, "Follow", "Copy another axis's motion: this axis moves to the same point in its own range. Applies when the scene has no script for this axis.",
        linkSelect, {sub: true});
    rows.override = uiSetting(group, "Override script", "Follow even when the scene has a script for this axis, ignoring that script.",
        uiSwitch('linkOverride' + axis, cfg.linkOverride, function(v){ cfg.linkOverride = v; saveSettings(); }), {sub: true, dep: true});
    // Following replaces auto motion, so its rows go while the axis follows another.
    rows.auto = uiSetting(group, "Auto motion", "When the scene has no script for this axis, move in a smooth sine wave instead.",
        uiSwitch('auto' + axis, cfg.auto, function(v){ cfg.auto = v; syncRows(); saveSettings(); }), {sub: true});
    var hzFormat = function(v){ return v.toFixed(2) + " Hz · " + Math.round(v * 60) + "/min"; };
    rows.freq = uiSetting(group, "Frequency", "Full cycles per second.",
        uiRange('autoHz' + axis, cfg.autoHz, {min: AUTO_HZ_MIN, max: AUTO_HZ_MAX, step: 0.05, format: hzFormat}, null,
                function(v){ cfg.autoHz = v; saveSettings(); }).el, {sub: true, dep: true});
    if(axis === "L0"){ buildIdleRows(group, cfg, rows, function(){ syncRows(); }); }
    uiSetting(group, "Speed limit", "Cap how fast this axis moves. Faster moves are shortened so they stay in sync with the video.",
        uiSwitch('speedLimit' + axis, cfg.speedLimit, function(v){ cfg.speedLimit = v; syncRows(); saveSettings(); }), {sub: true});
    // Stored as full travels per second (cfg.maxSpeed); shown as % of full travel per second.
    rows.speed = uiSetting(group, "Max speed", "How much of its full travel this axis may cover per second.",
        uiRange('maxSpeed' + axis, Math.round(cfg.maxSpeed * 100), {min: MAX_SPEED_MIN * 100, max: MAX_SPEED_MAX * 100, step: 25,
                format: function(v){ return v + "%/s"; }}, null,
                function(v){ cfg.maxSpeed = v / 100; saveSettings(); }).el, {sub: true, dep: true});
    uiSetting(group, "Auto home", "Rest at the middle of the range. Turn off to choose the home position.",
        uiSwitch('autoCenter' + axis, cfg.autoCenter !== false, function(v){
            cfg.autoCenter = v;
            if(!v){ cfg.center = getCenter(axis); }
            saveSettings();
            syncHome();
            if(serialConnected){ centerAxis(axis); }
        }), {sub: true});
    homeRange = uiRange('center' + axis, getCenter(axis), {min: 0, max: 9999, format: pct}, null, function(v){
        cfg.center = v;
        saveSettings();
        if(serialConnected){ centerAxis(axis); } // preview on release, not on every input event
    });
    rows.home = uiSetting(group, "Home position", null, homeRange.el, {sub: true, dep: true});

    function syncRows(){
        var show = function(row, on){ if(row){ row.classList.toggle('off', !on); } };
        show(rows.override, !!cfg.link);
        show(rows.auto, !cfg.link);
        show(rows.freq, !cfg.link && cfg.auto);
        show(rows.idleSpeed, cfg.idle);
        show(rows.idleStroke, cfg.idle);
        show(rows.speed, cfg.speedLimit);
        show(rows.home, cfg.autoCenter === false);
    }
    function syncHome(){
        var auto = cfg.autoCenter !== false;
        if(auto){ homeRange.set(getCenter(axis)); }
        syncRows();
    }
    syncHome();
}

// Idle motion settings, on the stroke axis only. Adds its dependent rows to `rows`.
function buildIdleRows(group, cfg, rows, sync){
    uiSetting(group, "Idle motion", "Keep a slow stroke going while no video is playing, like when you're picking what to watch next.",
        uiSwitch('idleL0', cfg.idle, function(v){
            cfg.idle = v;
            sync();
            saveSettings();
            if(!v && serialConnected){ centerAxis("L0"); } // stop at home rather than mid-stroke
        }), {sub: true});
    // Stored in Hz like auto motion, but idle strokes are slow, so shown per minute.
    var perMinute = function(v){ return Math.round(v * 60) + " strokes/min"; };
    rows.idleSpeed = uiSetting(group, "Idle speed", "Full strokes per minute.",
        uiRange('idleHzL0', cfg.idleHz, {min: IDLE_HZ_MIN, max: IDLE_HZ_MAX, step: 0.05, format: perMinute}, null,
                function(v){ cfg.idleHz = v; saveSettings(); }).el, {sub: true, dep: true});
    rows.idleStroke = uiSetting(group, "Idle stroke", "How much of the range idle strokes use, centred in it.",
        uiRange('idleRangeL0', cfg.idleRange, {min: IDLE_RANGE_MIN, max: 100, step: 5, format: function(v){ return v + "%"; }}, null,
                function(v){ cfg.idleRange = v; saveSettings(); }).el, {sub: true, dep: true});
}

// ---- Advanced tab ----
function buildAdvancedTab(body){
    var card = uiSection(body, "Advanced");
    uiSetting(card, "Save settings to Stash",
        "Keep these settings in Stash, so every browser uses them, private windows included. Off keeps them in this browser only. " +
        "Which device and heart-rate monitor to reconnect to always stays with each browser.",
        uiSwitch('saveToStash', !!settings.saveToStash, function(v){
            settings.saveToStash = v;
            storeSet("settings", settings);
            writeStashSettings().then(function(){
                showToast(v ? "Settings saved to Stash" : "Settings kept in this browser",
                          v ? "Every browser on this Stash now uses them." : "They're no longer saved in Stash.", "success");
            }).catch(function(){});
        }));
    uiSetting(card, "Stats overlay", "Heart rate, ceiling, edges and the current phase over the video, while a monitor is connected or modulation is on.",
        uiSwitch('showHud', settings.showHud !== false, function(v){ settings.showHud = v; saveSettings(); updateHud(); }));
    uiSetting(card, "Notifications", "Show pop-ups for connections and script loading.",
        uiSwitch('showNotifications', settings.showNotifications !== false, function(v){ settings.showNotifications = v; saveSettings(); }));
    uiSetting(card, "Debug mode", "Log details to the console and show the debug tools below.",
        uiSwitch('debug', settings.debug, function(v){ settings.debug = v; saveSettings(); renderActiveTab(); }));
    if(settings.debug){
        var dbg = uiSection(body, "Debug tools", "window.__tcode is available in the page console.");
        uiSetting(dbg, "Simulated device", "Stands in for a TCode device: commands are recorded, nothing is sent.",
            uiButton(simulatedDevice ? "Running" : "Start", "secondary", function(){ connectSimulatedDevice(); renderActiveTab(); },
                     {disabled: serialConnected}));
        var simOn = hr.source === 'sim';
        uiSetting(dbg, "Simulate heart rate", "Feeds a steady reading once a second in place of a monitor.",
            uiSwitch('hrSim', simOn, function(v){ if(v){ startHrSim(); } else { stopHrSim(); } renderActiveTab(); }));
        var simRange = uiRange('hrSimBpm', hrSimBpm, {min: 40, max: 200, format: function(v){ return v + " BPM"; }},
            function(v){ hrSimBpm = v; if(hr.source === 'sim'){ feedHr(v, true); } }, null);
        simRange.setDisabled(!simOn);
        uiSetting(dbg, "Simulated BPM", null, simRange.el, {sub: true, disabled: !simOn});
    }
}

// ---- Heart Rate tab ----
SETTINGS_TABS.splice(2, 0, { id: 'hr', label: 'Heart Rate', build: buildHrTab });

function buildHrTab(body){
    var cfg = settings.hr;
    var bpm = function(v){ return v + " BPM"; };
    var sec = function(v){ return v + " s"; };
    var changed = function(){ saveSettings(); refreshGovernor(); };

    var main = uiSection(body, "Heart-rate modulation",
        "Shortens strokes as your heart rate nears your edge, and holds the stroker back there until you recover.");
    uiSetting(main, "Enable", hr.status === 'off' ? "Connect a monitor on the Device tab. Without one, scripts play normally." : null,
        uiSwitch('hrEnabled', cfg.enabled, function(v){ cfg.enabled = v; changed(); updateHrUi(); }));
    var live = uiSetting(main, "Session", null,
        uiButton("Reset", "secondary", function(){ resetHrSession(); }, {small: true}));
    live.firstChild.appendChild(el('div', {class: 'sub-heading', id: 'tcode-gov-status', text: govStatusText(lastGov)}));

    var rates = uiSection(body, "Heart rate");
    uiSetting(rates, "Edge", "The heart rate that counts as an edge. This is the ceiling: strokes stop here until you recover.",
        uiNumber('edgeHr', cfg.edgeHr, {min: 50, max: 250, suffix: "BPM"}, function(v){ cfg.edgeHr = v; changed(); }));

    var resp = uiSection(body, "Response");
    uiSetting(resp, "Approach band", "Strokes start shortening this many BPM below the ceiling. 0 only reacts at the ceiling.",
        uiRange('hrBand', cfg.band, {min: 0, max: 40, format: bpm}, null, function(v){ cfg.band = v; changed(); }).el);
    uiSetting(resp, "Shortest stroke", "Stroke length just below the ceiling, as a share of the full range.",
        uiRange('hrFloor', cfg.floor, {min: 0, max: 100, format: function(v){ return v + "%"; }}, null, function(v){ cfg.floor = v; changed(); }).el);
    uiSetting(resp, "Rejoin time", "After an edge, strokes ramp back to full over this long.",
        uiRange('hrRejoin', cfg.rejoinSec, {min: 0, max: 60, format: sec}, null, function(v){ cfg.rejoinSec = v; changed(); }).el);
    uiSetting(resp, "Signal timeout", "If the monitor sends no real reading for this long (disconnected, or taken off), the device stops.",
        uiRange('hrTimeout', cfg.timeoutSec, {min: 3, max: 20, format: sec}, null, function(v){ cfg.timeoutSec = v; changed(); }).el);

    var decay = uiSection(body, "Adaptive ceiling decay", "Lowers the ceiling as edges add up, to counter fatigue over a long session.");
    var decayRows = [];
    uiSetting(decay, "Enable", null, uiSwitch('hrDecay', cfg.decay, function(v){
        cfg.decay = v;
        decayRows.forEach(function(r){ r.classList.toggle('disabled', !v); });
        changed();
    }));
    decayRows.push(uiSetting(decay, "Every", "Number of edges per step.",
        uiNumber('decayEvery', cfg.decayEvery, {min: 1, max: 10, suffix: "edges"}, function(v){ cfg.decayEvery = v; changed(); }), {sub: true}));
    decayRows.push(uiSetting(decay, "Drop by", "How much the ceiling falls each step.",
        uiNumber('decayBpm', cfg.decayBpm, {min: 1, max: 5, suffix: "BPM"}, function(v){ cfg.decayBpm = v; changed(); }), {sub: true}));
    decayRows.push(uiSetting(decay, "Floor", "The ceiling never decays below this.",
        uiNumber('decayFloor', cfg.decayFloor, {min: 80, max: 130, suffix: "BPM"}, function(v){ cfg.decayFloor = v; changed(); }), {sub: true}));
    decayRows.forEach(function(r){ r.classList.toggle('disabled', !cfg.decay); });
}

// ---- Climax tab ----
SETTINGS_TABS.splice(3, 0, { id: 'climax', label: 'Climax', build: buildClimaxTab });

function buildClimaxTab(body){
    var cfg = settings.hr;
    var sec = function(v){ return v + " s"; };
    var changed = function(){ saveSettings(); refreshGovernor(); };

    var main = uiSection(body, "Climax markers",
        "Scene markers with this tag release the limiter: strokes build to full before the marker and stay full, whatever your heart rate. Works with heart-rate modulation on.");
    uiSetting(main, "Enable", "Turn off to keep edging through a scene's climax markers; turn back on when you're ready.",
        uiSwitch('climaxEnabled', cfg.climax, function(v){ cfg.climax = v; changed(); }));
    var tagInput = el('input', {type: 'text', id: 'tcode-climaxTag', class: 'input-control form-control form-control-sm', value: cfg.climaxTag,
                                style: 'width: 160px', spellcheck: 'false'});
    tagInput.addEventListener('change', function(){
        cfg.climaxTag = tagInput.value.trim() || "Climax";
        tagInput.value = cfg.climaxTag;
        saveSettings();
        fetchClimaxMarkers();
    });
    uiSetting(main, "Marker tag", "Primary or secondary tag. Add markers in Stash's Markers tab, or with the button below.", tagInput);

    var onScene = isFinite(getSceneId());
    var hint, list = null;
    if(!onScene){ hint = "Open a scene to see its climax markers."; }
    else if(!climaxMarkers.length){ hint = "No climax markers in this scene yet."; }
    else {
        hint = climaxMarkers.length + (climaxMarkers.length === 1 ? " marker. Click a time to jump to it." : " markers. Click a time to jump to it.");
        list = el('ul', {class: 'tcode-list'}, climaxMarkers.map(function(m){
            return el('li', null, [
                el('a', {href: '#', text: formatTime(m.seconds) + (m.end != null ? " – " + formatTime(m.end) : ""), onclick: function(e){
                    e.preventDefault();
                    seekScene(m.seconds);
                }})
            ]);
        }));
    }
    var row = uiSetting(main, "This scene", hint,
        uiButton("Mark climax here", "primary", markClimaxHere, {disabled: !onScene || !boundPlayer}));
    if(list){ row.firstChild.appendChild(list); }

    var timing = uiSection(body, "Timing");
    uiSetting(timing, "Build-up", "How long before the marker strokes start climbing back to full.",
        uiRange('climaxRamp', cfg.climaxRampSec, {min: 0, max: 180, format: sec}, null, function(v){ cfg.climaxRampSec = v; changed(); }).el);
    uiSetting(timing, "Hold", "How long strokes stay full after the marker. Markers with an end time hold for their whole range instead.",
        uiRange('climaxHold', cfg.climaxHoldSec, {min: 5, max: 180, format: sec}, null, function(v){ cfg.climaxHoldSec = v; changed(); }).el);
    uiSetting(timing, "Ease back", "How long it takes to hand control back to your heart rate afterwards.",
        uiRange('climaxEase', cfg.climaxEaseSec, {min: 0, max: 180, format: sec}, null, function(v){ cfg.climaxEaseSec = v; changed(); }).el);
}

// --- WEB SERIAL IMPLEMENTATION ---

// Ask the user to pick a port (needs a click), then open it.
async function connectSerial() {
    if (!navigator.serial) {
        alert("Web Serial API is NOT available.\n\nUse a Chromium-based browser, and either serve Stash over HTTPS or add " + location.origin + " to 'Insecure origins treated as secure' in chrome://flags.");
        return;
    }
    var picked;
    try {
        picked = await navigator.serial.requestPort();
    } catch (e) {
        if (e.name !== "NotFoundError") { showToast("Connection Failed", e.message, "error"); } // NotFoundError = picker cancelled
        return;
    }
    await openPort(picked, false);
}

// Open a port and wire up the writer and read loop. `silent` is for automatic reconnects:
// failures are only logged, since the user didn't ask for anything.
async function openPort(p, silent) {
    if (serialConnected) { return true; }
    try {
        await p.open({ baudRate: 115200 }); // Standard TCode Baud Rate
    } catch (e) {
        console.error("[TCode] Serial open failed:", e);
        if (!silent) { showToast("Connection Failed", e.message, "error"); }
        return false;
    }
    port = p;
    const textEncoder = new TextEncoderStream();
    writableStreamClosed = textEncoder.readable.pipeTo(port.writable);
    writer = textEncoder.writable.getWriter();
    serialConnected = true;
    simulatedDevice = false;
    keepReading = true;
    forgetAxisPositions();
    // Remember which device this was so it can be reopened without the picker next time.
    try {
        var info = port.getInfo();
        settings.serialPort = { usbVendorId: info.usbVendorId ?? null, usbProductId: info.usbProductId ?? null };
        storeSet("settings", settings);
    } catch (e) { debug("[TCode] getInfo failed: " + e); }
    debug("USB Serial Connected");
    showToast(silent ? "USB Reconnected" : "USB Connected", "Serial connection established at 115200 baud", "success");
    updateNavButton(); // reflect connected state on the navbar
    readSerialLoop();
    return true;
}

// The previously used port among those this site already has permission for: an exact
// USB vendor/product match, or the only granted port if no USB device was saved yet.
// A saved device that isn't present never falls back to some other granted port, which
// could be anything (an Arduino, a different toy) and would be sent TCode.
function pickSavedPort(ports) {
    var saved = settings.serialPort;
    if (saved && saved.usbVendorId != null) {
        return ports.find(function(p) {
            var i = p.getInfo();
            return i.usbVendorId === saved.usbVendorId && i.usbProductId === saved.usbProductId;
        }) || null;
    }
    return ports.length === 1 ? ports[0] : null;
}

// Reopen a port the user granted earlier. Granted ports can be opened without a click,
// so this runs on page load and again whenever a device is plugged in.
async function autoConnectSerial() {
    if (!navigator.serial || serialConnected || settings.autoConnect === false) { return; }
    var ports;
    try { ports = await navigator.serial.getPorts(); } catch (e) { return; }
    var p = pickSavedPort(ports);
    if (p) { await openPort(p, true); }
}

function startSerialAutoConnect() {
    if (!navigator.serial) { return; }
    navigator.serial.addEventListener("connect", function() {
        debug("[TCode] Serial device plugged in");
        autoConnectSerial();
    });
    autoConnectSerial();
}

async function readSerialLoop() {
    while (port.readable && keepReading) {
        const textDecoder = new TextDecoderStream();
        readableStreamClosed = port.readable.pipeTo(textDecoder.writable);
        reader = textDecoder.readable.getReader();
        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) { break; }
                if (value) { processWSReply({ data: value }); }
            }
        } catch (error) { console.error(error); } finally { reader.releaseLock(); }
    }
    // Loop exited -> port no longer readable (device unplugged) or we were asked to stop.
    var manual = !keepReading;
    var w = writer;
    serialConnected = false;
    writer = null;
    // Release both pipes, then close our side so the same port can be reopened later.
    // Each step is time-boxed: on an unplugged device they can stall instead of failing.
    var settle = function(p){ return Promise.race([Promise.resolve(p).catch(function(){}), new Promise(function(r){ setTimeout(r, 500); })]); };
    if (w) { await settle(w.close()); }
    await settle(writableStreamClosed);
    await settle(readableStreamClosed);
    try { await port.close(); } catch (e) { debug("[TCode] port.close after disconnect: " + e); }
    if (manual) {
        showToast("USB Disconnected", "", "info");
    } else {
        showToast("USB Disconnected", settings.autoConnect !== false ? "Will reconnect when the device is plugged back in" : "", "warning");
    }
    updateNavButton();
    debug("[TCode] Serial disconnected");
}

// Stop talking to the device. Auto-connect still applies on the next page load.
async function disconnectSerial() {
    if (simulatedDevice) {
        simulatedDevice = false;
        serialConnected = false;
        writer = null;
        updateNavButton();
        return;
    }
    if (!serialConnected) { return; }
    keepReading = false;
    try { if (reader) { await reader.cancel(); } } catch (e) { debug("[TCode] reader.cancel: " + e); }
}

function sendTCode(data) {
    if (serialConnected && writer) {
        writer.write(data);
        if (settings.debug) { recordTx(data); }
    }
}

// ---------------------------------

// --- HEART RATE MONITOR (Web Bluetooth) ---
// Any sensor exposing the standard Bluetooth Heart Rate service (0x180D): chest straps,
// and watches that broadcast HR. Readings land in `hr`; the governor reads from there.

var hr = {
    bpm: null,          // last valid reading
    at: 0,              // Date.now() of that reading
    contact: null,      // true/false if the sensor reports skin contact, else null
    status: 'off',      // off | connecting | live | reconnecting | lost
    source: null,       // 'ble' | 'sim'
    device: null,
    characteristic: null,
    battery: null,
    retry: 0,
    manualDisconnect: false,
    rrRun: 0,           // consecutive packets carrying beat timing (RR intervals)
    rrReliable: false,  // this connection has sent beat timing consistently
    rejecting: null     // why the latest packets aren't counted: 'contact' | 'beats' | null
};
var hrPacketLog = [];   // debug: recent raw packets, newest last
var HR_MIN_VALID = 35;                  // anything lower is a bad read, not a heartbeat
var HR_RETRY_MS = [1000, 2000, 4000];   // reconnect attempts after an unexpected drop
var hrSimTimer = null;
var hrSimBpm = 80;

// Decode a Heart Rate Measurement value (GATT 0x2A37). Byte 0 is flags: bit 0 picks a
// uint8 or uint16 BPM, bits 1-2 report skin contact (0b11 contact, 0b10 none, else
// unsupported), bit 3 adds a 2-byte energy field, bit 4 adds RR intervals (2 bytes per
// detected beat). Returns {bpm, contact, rr} where rr is how many beats the packet
// timed, or null when the value is too short to hold a reading.
function parseHrMeasurement(view){
    if(!view || view.byteLength < 2){ return null; }
    var flags = view.getUint8(0);
    var wide = (flags & 0x01) === 0x01;
    if(wide && view.byteLength < 3){ return null; }
    var bpm = wide ? view.getUint16(1, true) : view.getUint8(1);
    var contactBits = (flags >> 1) & 0x03;
    var contact = contactBits === 0x03 ? true : (contactBits === 0x02 ? false : null);
    var offset = (wide ? 3 : 2) + ((flags & 0x08) ? 2 : 0);
    var rr = (flags & 0x10) ? Math.max(0, Math.floor((view.byteLength - offset) / 2)) : 0;
    return { bpm: bpm, contact: contact, rr: rr };
}

// Whether a packet is a real reading. A strap taken off often keeps sending its last
// BPM, so besides the obvious (too low to be a pulse) a packet doesn't count when the
// sensor says it has no skin contact. Sensors with no contact flag get a fallback: once
// they've timed beats (RR intervals) consistently, a packet without beat timing doesn't
// count. Watches and relay apps that only send RR now and then never become "reliable",
// so they aren't caught by it. Rejected packets don't refresh the reading, so the
// signal timeout trips as it would for a dropped connection.
var HR_RR_RELIABLE_RUN = 5;
function hrPacketVerdict(m, rrReliable){
    if(m.bpm < HR_MIN_VALID){ return 'low'; }
    if(m.contact === false){ return 'contact'; }
    if(m.contact === null && rrReliable && m.rr === 0){ return 'beats'; }
    return 'ok';
}

// The single entry point for a new reading, from the monitor or the simulator.
function feedHr(bpm, contact){
    hr.bpm = bpm;
    hr.at = Date.now();
    hr.contact = contact;
    updateHrUi();
    refreshGovernor();
}

function hrLive(){ return hr.status === 'live' && hr.bpm != null; }

function onHrValue(e){
    var m = parseHrMeasurement(e.target.value);
    if(!m){ return; }
    var verdict = hrPacketVerdict(m, hr.rrReliable);
    hr.rrRun = m.rr > 0 ? hr.rrRun + 1 : 0;
    if(hr.rrRun >= HR_RR_RELIABLE_RUN){ hr.rrReliable = true; }
    if(settings.debug){
        hrPacketLog.push({ t: Date.now(), bpm: m.bpm, contact: m.contact, rr: m.rr, verdict: verdict });
        if(hrPacketLog.length > 600){ hrPacketLog.splice(0, hrPacketLog.length - 600); }
    }
    hr.contact = m.contact;
    if(verdict !== 'ok'){
        hr.rejecting = verdict === 'low' ? 'contact' : verdict;
        updateHrUi();
        return;
    }
    hr.rejecting = null;
    feedHr(m.bpm, m.contact);
}

// Pick a monitor (needs a click) and connect to it.
async function connectHr(){
    if(!navigator.bluetooth){
        showToast("Bluetooth Unavailable", "Web Bluetooth needs Chrome or Edge, and a secure origin (https, localhost, or the insecure-origins flag).", "error", 8000);
        return;
    }
    var device;
    try {
        device = await navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }], optionalServices: ['battery_service'] });
    } catch(e) {
        if(e.name !== 'NotFoundError'){ showToast("Heart Rate Failed", e.message, "error"); } // NotFoundError = picker cancelled
        return;
    }
    await attachHrDevice(device, false);
}

async function attachHrDevice(device, silent){
    if(hr.device && hr.device !== device){ hr.device.removeEventListener('gattserverdisconnected', onHrDropped); }
    stopHrSim();
    hr.device = device;
    hr.manualDisconnect = false;
    device.removeEventListener('gattserverdisconnected', onHrDropped);
    device.addEventListener('gattserverdisconnected', onHrDropped);
    settings.hr.deviceId = device.id;
    settings.hr.deviceName = device.name || "Heart rate monitor";
    saveSettings();
    return openHrGatt(silent);
}

async function openHrGatt(silent){
    var device = hr.device;
    if(!device){ return false; }
    setHrStatus(hr.status === 'reconnecting' ? 'reconnecting' : 'connecting');
    try {
        var server = await device.gatt.connect();
        var service = await server.getPrimaryService('heart_rate');
        var ch = await service.getCharacteristic('heart_rate_measurement');
        if(hr.characteristic && hr.characteristic !== ch){ hr.characteristic.removeEventListener('characteristicvaluechanged', onHrValue); }
        ch.removeEventListener('characteristicvaluechanged', onHrValue);
        ch.addEventListener('characteristicvaluechanged', onHrValue);
        await ch.startNotifications();
        hr.characteristic = ch;
        hr.source = 'ble';
        hr.retry = 0;
        hr.rrRun = 0;
        hr.rrReliable = false;
        hr.rejecting = null;
        setHrStatus('live');
        readHrBattery(server);
        showToast(silent ? "Heart Rate Reconnected" : "Heart Rate Connected", settings.hr.deviceName, "success");
        return true;
    } catch(e) {
        console.error("[TCode] Heart rate connect failed:", e);
        if(!silent){ showToast("Heart Rate Failed", e.message, "error"); }
        if(hr.status !== 'reconnecting'){ setHrStatus('off'); }
        return false;
    }
}

async function readHrBattery(server){
    try {
        var svc = await server.getPrimaryService('battery_service');
        var ch = await svc.getCharacteristic('battery_level');
        hr.battery = (await ch.readValue()).getUint8(0);
        updateHrUi();
    } catch(e) { hr.battery = null; } // battery service is optional
}

// The link dropped without us asking: retry on a short backoff before calling it lost.
function onHrDropped(){
    if(hr.manualDisconnect || hr.source !== 'ble'){ return; }
    hr.retry = 0;
    setHrStatus('reconnecting');
    retryHr();
}

function retryHr(){
    if(hr.manualDisconnect || hr.status !== 'reconnecting'){ return; }
    if(hr.retry >= HR_RETRY_MS.length){
        setHrStatus('lost');
        showToast("Heart Rate Lost", (settings.hr.deviceName || "Monitor") + " stopped responding", "warning", 6000);
        return;
    }
    var delay = HR_RETRY_MS[hr.retry++];
    setTimeout(async function(){
        if(await openHrGatt(true)){ return; }
        retryHr();
    }, delay);
}

function disconnectHr(){
    stopHrSim();
    hr.manualDisconnect = true;
    if(hr.device){
        try { hr.device.gatt.disconnect(); } catch(e) {}
    }
    hr.source = null;
    hr.bpm = null;
    hr.battery = null;
    setHrStatus('off');
}

// Reconnect the remembered monitor without the picker. Chrome only lists previously
// granted devices through getDevices(), which isn't available everywhere; when it's
// missing the Device tab offers a one-click reconnect instead.
async function autoConnectHr(){
    if(!navigator.bluetooth || typeof navigator.bluetooth.getDevices !== 'function' || !settings.hr.deviceId){ return; }
    var devices;
    try { devices = await navigator.bluetooth.getDevices(); } catch(e) { return; }
    var device = devices.find(function(d){ return d.id === settings.hr.deviceId; });
    if(!device){ return; }
    if(await attachHrDevice(device, true)){ return; }
    // Not reachable yet (asleep, out of range): wait for it to advertise, then connect.
    if(typeof device.watchAdvertisements !== 'function'){ return; }
    var abort = new AbortController();
    device.addEventListener('advertisementreceived', function(){
        abort.abort();
        if(hr.status !== 'live'){ attachHrDevice(device, true); }
    }, { once: true });
    try { await device.watchAdvertisements({ signal: abort.signal }); } catch(e) { debug("[TCode] watchAdvertisements: " + e); }
}

function hrCanAutoReconnect(){
    return !!(navigator.bluetooth && typeof navigator.bluetooth.getDevices === 'function');
}

// ---- simulator (debug) ----
// Feeds a steady reading once a second, the cadence of a real strap, so everything
// downstream (including the signal watchdog) behaves as it would with a monitor.
function startHrSim(bpm){
    if(bpm != null){ hrSimBpm = bpm; }
    if(hr.source === 'ble'){ disconnectHr(); }
    hr.manualDisconnect = false;
    hr.source = 'sim';
    setHrStatus('live');
    feedHr(hrSimBpm, true);
    if(!hrSimTimer){ hrSimTimer = setInterval(function(){ feedHr(hrSimBpm, true); }, 1000); }
}

function stopHrSim(){
    if(hrSimTimer){ clearInterval(hrSimTimer); hrSimTimer = null; }
    if(hr.source === 'sim'){ hr.source = null; hr.bpm = null; setHrStatus('off'); }
}

// ---- UI hooks ----
function setHrStatus(status){
    hr.status = status;
    updateHrUi();
    refreshGovernor();
    refreshSettingsTab('device');
}

function hrStatusText(){
    var name = settings.hr.deviceName || "Monitor";
    switch(hr.status){
        case 'live': return (hr.source === 'sim' ? "Simulated" : name) + (hr.bpm != null ? " · " + hr.bpm + " BPM" : "") +
                            (hr.battery != null ? " · battery " + hr.battery + "%" : "") +
                            (hr.rejecting === 'contact' ? " · no skin contact" : (hr.rejecting === 'beats' ? " · no beats detected" : ""));
        case 'connecting': return "Connecting to " + name + "…";
        case 'reconnecting': return "Reconnecting to " + name + "…";
        case 'lost': return name + " lost";
        default: return "Not connected";
    }
}

// Cheap live updates (nav readout, status line) without re-rendering the dialog.
function updateHrUi(){
    var btn = document.getElementById('tcode-nav-btn');
    if(btn){
        var live = hrLive();
        var hrDot = btn.querySelector('.tcode-nav-hrdot');
        hrDot.style.display = settings.hr.enabled ? "" : "none";
        hrDot.classList.toggle('on', live);
        var navHr = btn.querySelector('.tcode-nav-hr');
        navHr.style.display = live ? "" : "none";
        navHr.querySelector('.tcode-nav-bpm').textContent = live ? hr.bpm : "";
        setNavTitle(btn);
    }
    var line = document.getElementById('tcode-hr-status');
    if(line){ line.textContent = hrStatusText(); }
    var dot = document.getElementById('tcode-hr-dot');
    if(dot){ dot.classList.toggle('on', hrLive()); }
}

// ---------------------------------

// --- DEBUG TOOLS ---
// Only active with Debug on (Advanced tab). The hooks are published as window.__tcode for
// the console.

var txLog = []; // [{t, data}] -- every chunk written to the device, newest last
var TX_LOG_MAX = 5000;
var simulatedDevice = false;

function recordTx(data){
    txLog.push({ t: Math.round(performance.now()), data: data });
    if(txLog.length > TX_LOG_MAX){ txLog.splice(0, txLog.length - TX_LOG_MAX); }
}

// Pretend a device is connected: commands are recorded but go nowhere, and the D2 limits
// query is answered locally, so playback can be exercised without the hardware moving.
function connectSimulatedDevice(){
    if(serialConnected){ return; }
    simulatedDevice = true;
    writer = {
        write: function(data){
            if(String(data).indexOf("D2") !== -1){
                setTimeout(function(){
                    processWSReply({ data: "L0 0 9999\n" }); // a plain single-axis stroker
                }, 20);
            }
            return Promise.resolve();
        }
    };
    serialConnected = true;
    forgetAxisPositions();
    showToast("Simulated Device", "Commands are recorded, nothing is sent", "info");
    updateNavButton();
}

function publishDebugApi(){
    if(!settings.debug){ return; }
    window.__tcode = {
        // Axis commands as [{t, axis, pos, ms}], parsed from the TX log.
        commands: function(){
            var out = [];
            for(var e of txLog){
                var re = /([LR]\d)(\d{4})I(\d+)/g, m;
                while((m = re.exec(e.data))){ out.push({ t: e.t, axis: m[1], pos: +m[2], ms: +m[3] }); }
            }
            return out;
        },
        tx: function(){ return txLog.slice(); },
        clearTx: function(){ txLog.length = 0; },
        simulateDevice: connectSimulatedDevice,
        seek: seekScene, // jump the player to a scene time in seconds
        // Simulated heart rate: setHr(bpm) starts or updates it, setHr(null) stops it.
        setHr: function(bpm){ if(bpm == null){ stopHrSim(); } else { startHrSim(bpm); } },
        hr: function(){ return { bpm: hr.bpm, at: hr.at, ageMs: hr.at ? Date.now() - hr.at : null, contact: hr.contact,
                                 status: hr.status, source: hr.source, battery: hr.battery }; },
        governor: function(){ return { last: lastGov, session: Object.assign({}, hrSession), marks: climaxMarksMs.slice() }; },
        // Raw monitor packets (debug mode only): {t, bpm, contact, rr, verdict}.
        hrPackets: function(){ return hrPacketLog.slice(); },
        resetSession: resetHrSession,
        state: function(){
            var axes = {};
            for(var ax in AXIS){
                axes[ax] = { limits: AXIS[ax].limits, loaded: !!AXIS[ax].scriptLoaded,
                             acts: AXIS[ax].acts ? AXIS[ax].acts.length : 0, enabled: !!(settings.axes[ax] && settings.axes[ax].enabled) };
            }
            return { connected: serialConnected, simulated: simulatedDevice, axes: axes,
                     settings: JSON.parse(JSON.stringify(settings)) };
        }
    };
}

// ---------------------------------

// --- STATS OVERLAY ---
// A small panel over the video: heart rate, ceiling, edges, the governor's phase and
// allowance, and the next climax marker. It lives inside the video.js container so it
// stays visible in fullscreen, ignores the mouse, and refreshes at 4 Hz.

var hudTimer = null;
var HUD_COLORS = { ok: "#3dcc91", warn: "#ffb366", stop: "#ff7373", climax: "#48aff0", off: "#bfccd6" };

function injectHudStyles(){
    if(document.getElementById('tcode-hud-styles')){ return; }
    var s = document.createElement('style');
    s.id = 'tcode-hud-styles';
    s.textContent = `
#tcode-hud { position: absolute; top: 12px; left: 12px; z-index: 2; pointer-events: none; user-select: none;
             min-width: 170px; padding: 8px 10px; border-radius: 4px; background: rgba(16, 22, 26, .62);
             color: #f5f8fa; font-size: 12px; line-height: 1.35; font-variant-numeric: tabular-nums;
             text-shadow: 0 1px 2px rgba(0,0,0,.6); }
#tcode-hud .hud-top { display: flex; align-items: baseline; gap: 6px; }
#tcode-hud .hud-heart { font-size: 14px; display: inline-block; animation: tcode-beat 1s ease-in-out infinite; }
#tcode-hud .hud-bpm { font-size: 22px; font-weight: 600; }
#tcode-hud .hud-ceiling { color: #bfccd6; }
#tcode-hud .hud-decay { color: #ffb366; font-size: 11px; }
#tcode-hud .hud-label { font-weight: 600; letter-spacing: .03em; }
#tcode-hud .hud-bar { height: 4px; margin: 4px 0 5px; border-radius: 2px; background: rgba(245,248,250,.18); overflow: hidden; }
#tcode-hud .hud-fill { height: 100%; width: 0; transition: width .2s linear, background-color .2s; }
#tcode-hud .hud-meta { display: flex; align-items: center; gap: 8px; color: #bfccd6; font-size: 11px; }
#tcode-hud .hud-dots { margin-left: auto; display: inline-flex; gap: 4px; }
#tcode-hud .hud-dot { width: 6px; height: 6px; border-radius: 50%; background: #ff7373; }
#tcode-hud .hud-dot.on { background: #3dcc91; }
@keyframes tcode-beat { 0%, 60%, 100% { transform: scale(1); } 20% { transform: scale(1.25); } }
`;
    document.head.appendChild(s);
}

function hudWanted(){
    return settings.showHud !== false && !!boundPlayer && (hrLive() || settings.hr.enabled);
}

// The HUD element, created inside the current player's container (and moved if Stash
// swapped the player). Null when there's nothing to attach to.
function ensureHud(){
    var hud = document.getElementById('tcode-hud');
    var host = boundPlayer && boundPlayer.parentNode;
    if(!host){ if(hud){ hud.remove(); } return null; }
    if(hud && hud.parentNode !== host){ hud.remove(); hud = null; }
    if(!hud){
        injectHudStyles();
        hud = el('div', {id: 'tcode-hud', 'aria-hidden': 'true'}, [
            el('div', {class: 'hud-top'}, [
                el('span', {class: 'hud-heart', text: '♥'}),
                el('span', {class: 'hud-bpm'}),
                el('span', {class: 'hud-ceiling'}),
                el('span', {class: 'hud-decay'})
            ]),
            el('div', {class: 'hud-label'}),
            el('div', {class: 'hud-bar'}, [el('div', {class: 'hud-fill'})]),
            el('div', {class: 'hud-meta'}, [
                el('span', {class: 'hud-edges'}),
                el('span', {class: 'hud-climax'}),
                el('span', {class: 'hud-dots'}, [el('span', {class: 'hud-dot usb', title: 'Device'}), el('span', {class: 'hud-dot hr', title: 'Heart rate'})])
            ])
        ]);
        host.appendChild(hud);
    }
    return hud;
}

function phaseColor(g){
    if(!g){ return HUD_COLORS.off; }
    switch(g.phase){
        case 'EDGE': case 'NO SIGNAL': return HUD_COLORS.stop;
        case 'EASING': case 'REJOINING': return HUD_COLORS.warn;
        case 'CLIMAX': return HUD_COLORS.climax;
        case 'FREE': return HUD_COLORS.ok;
        default: return HUD_COLORS.off;
    }
}

// Time to the next climax marker ahead of the playhead, or "". With climax markers turned
// off, a reminder instead, so a marker isn't expected to take over.
function nextClimaxText(sceneMs){
    if(sceneMs == null){ return ""; }
    var ahead = climaxMarksMs.map(function(m){ return m.at; }).filter(function(at){ return at > sceneMs; });
    if(!ahead.length){ return ""; }
    if(settings.hr.climax === false){ return "Climax off"; }
    return "Climax in " + formatTime((Math.min.apply(null, ahead) - sceneMs) / 1000);
}

function q(hud, sel){ return hud.querySelector(sel); }

function updateHud(){
    if(!hudWanted()){
        var stale = document.getElementById('tcode-hud');
        if(stale){ stale.remove(); }
        return;
    }
    var hud = ensureHud();
    if(!hud){ return; }
    var g = lastGov;
    var modulating = settings.hr.enabled && g && g.phase !== 'OFF';
    var color = modulating ? phaseColor(g) : HUD_COLORS.off;

    q(hud, '.hud-bpm').textContent = hr.bpm != null && hrLive() ? hr.bpm : "--";
    var heart = q(hud, '.hud-heart');
    heart.style.color = color;
    heart.style.animationDuration = hrLive() && hr.bpm ? (60 / hr.bpm).toFixed(2) + 's' : '0s';
    q(hud, '.hud-ceiling').textContent = modulating && g.ceiling != null ? "/ " + g.ceiling : "";
    q(hud, '.hud-decay').textContent = modulating && g.decay ? "−" + g.decay : "";

    var label = q(hud, '.hud-label');
    label.textContent = modulating ? g.label : (hrLive() ? "Modulation off" : "No monitor");
    label.style.color = color;
    var bar = q(hud, '.hud-bar');
    bar.style.display = modulating ? "" : "none";
    if(modulating){
        var fill = q(hud, '.hud-fill');
        fill.style.width = Math.round(g.a * 100) + "%";
        fill.style.backgroundColor = color;
    }

    q(hud, '.hud-edges').textContent = modulating ? hrSession.edges + (hrSession.edges === 1 ? " edge" : " edges") : "";
    q(hud, '.hud-climax').textContent = modulating && g.phase !== 'CLIMAX' ? nextClimaxText(currentSceneMs()) : "";
    q(hud, '.hud-dot.usb').classList.toggle('on', serialConnected);
    q(hud, '.hud-dot.hr').classList.toggle('on', hrLive());
}

function startHud(){
    if(hudTimer){ return; }
    hudTimer = setInterval(function(){
        try {
            // Keep the governor current while paused too (watchdog, edges, the dialog's
            // session line); during playback currentAction refreshes it on every tick.
            if(!boundPlayer || boundPlayer.paused){ refreshGovernor(); } else { updateGovUi(); }
            updateHud();
        } catch(e) { debug("[TCode] HUD update failed: " + e); }
    }, 250);
}

// ---------------------------------

// --- STASH REQUESTS ---
// Everything the script downloads comes from the Stash server this page belongs to, as a
// plain same-origin fetch: the browser attaches Stash's session cookie when it has a
// login, and no cross-site request permission is needed.

// `url` resolved against the page, or null when it points at another site. Script URLs
// can come from the page itself (the Interactive Tools dropdown), so never follow one
// off-site with the user's cookies.
function sameOriginUrl(url){
    try {
        var u = new URL(url, location.href);
        return u.origin === location.origin ? u.href : null;
    } catch(e) { return null; }
}

// GET a text file from Stash; resolves {status, response} (the body text).
function getStashText(url){
    return fetch(url, { credentials: 'same-origin' }).then(function(r){
        return r.text().then(function(t){ return { status: r.status, response: t }; });
    });
}

// Stash's own address for the scene's main funscript.
function defaultFunscriptUrl(){
    return location.origin + '/scene/' + getSceneId() + '/funscript';
}

// --- STASH GRAPHQL ---
// A plain same-origin fetch: the browser attaches Stash's session cookie, which is
// HttpOnly (invisible to document.cookie), so this also works when Stash has a login.
// keepalive lets a request sent while the page closes still finish.
function stashGql(query, variables, keepalive){
    return fetch(location.origin + '/graphql', {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: !!keepalive,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query, variables: variables || {} })
    }).then(function(r){
        if(!r.ok){ throw new Error("Stash returned " + r.status); }
        return r.json();
    }).then(function(j){
        if(j.errors && j.errors.length){ throw new Error(j.errors[0].message); }
        return j.data;
    });
}

// --- CLIMAX MARKERS ---
// Stash scene markers tagged with settings.hr.climaxTag release the HR limiter around
// their time (see climaxFactor). A marker with an end time holds for its whole range.

var climaxMarkers = [];     // [{id, seconds, end}] for the current scene, sorted
var climaxSceneId = null;
var climaxPollTimer = null;

function isClimaxMarker(m, tag){
    tag = String(tag || "").trim().toLowerCase();
    if(!tag){ return false; }
    var names = [m.primary_tag && m.primary_tag.name].concat((m.tags || []).map(function(t){ return t.name; }));
    return names.some(function(n){ return n && n.toLowerCase() === tag; });
}

async function fetchClimaxMarkers(){
    var id = getSceneId();
    if(!isFinite(id)){ setClimaxMarkers(null, []); return; }
    try {
        var data = await stashGql("query($id: ID!){ findScene(id: $id){ scene_markers { id seconds end_seconds title primary_tag { name } tags { name } } } }",
                                  { id: String(id) });
        if(getSceneId() !== id){ return; } // navigated away meanwhile
        var all = (data.findScene && data.findScene.scene_markers) || [];
        var list = all.filter(function(m){ return isClimaxMarker(m, settings.hr.climaxTag); })
                      .map(function(m){ return { id: m.id, seconds: m.seconds, end: m.end_seconds != null && m.end_seconds > m.seconds ? m.end_seconds : null }; })
                      .sort(function(a, b){ return a.seconds - b.seconds; });
        setClimaxMarkers(id, list);
    } catch(e) {
        debug("[TCode] Climax markers: " + e.message);
    }
}

function setClimaxMarkers(sceneId, list){
    var changed = sceneId !== climaxSceneId || JSON.stringify(list) !== JSON.stringify(climaxMarkers);
    climaxSceneId = sceneId;
    climaxMarkers = list;
    climaxMarksMs = list.map(function(m){
        return { at: Math.round(m.seconds * 1000), hold: m.end != null ? Math.round((m.end - m.seconds) * 1000) : null };
    });
    if(changed){
        refreshSettingsTab('climax');
        refreshGovernor();
    }
}

// Re-read markers now and then, so ones added in Stash's own marker editor are picked up.
function startClimaxPolling(){
    if(climaxPollTimer){ return; }
    climaxPollTimer = setInterval(function(){
        if(location.href.indexOf('/scenes/') !== -1){ fetchClimaxMarkers(); }
    }, 20000);
}

async function findOrCreateTag(name){
    var found = await stashGql("query($name: String!){ findTags(tag_filter: { name: { value: $name, modifier: EQUALS } }, filter: { per_page: 1 }){ tags { id } } }",
                               { name: name });
    if(found.findTags.tags.length){ return found.findTags.tags[0].id; }
    var created = await stashGql("mutation($name: String!){ tagCreate(input: { name: $name }){ id } }", { name: name });
    return created.tagCreate.id;
}

// Add a climax marker at the current playhead (creating the tag if needed).
async function markClimaxHere(){
    var id = getSceneId();
    if(!isFinite(id) || !boundPlayer){ showToast("No Scene", "Open a scene to add a marker", "warning"); return; }
    var seconds = Math.round((boundPlayer.currentTime + streamOffsetMs / 1000) * 10) / 10;
    var tag = String(settings.hr.climaxTag || "").trim() || "Climax";
    try {
        var tagId = await findOrCreateTag(tag);
        await stashGql("mutation($input: SceneMarkerCreateInput!){ sceneMarkerCreate(input: $input){ id } }",
                       { input: { title: tag, seconds: seconds, scene_id: String(id), primary_tag_id: tagId } });
        showToast("Climax Marker Added", "At " + formatTime(seconds) + ". Reload to see it in Stash's Markers tab.", "success", 5000);
        await fetchClimaxMarkers();
    } catch(e) {
        showToast("Couldn't Add Marker", e.message, "error");
    }
}

// Stash's video.js player for the current scene, or null. Stash hands it to plugins; on a
// Stash without that, video.js also keeps it on its element.
function stashPlayer(){
    var api = window.PluginApi;
    var iu = api && api.utils && api.utils.InteractiveUtils;
    if(iu && typeof iu.getPlayer === 'function'){ return iu.getPlayer() || null; }
    var host = document.querySelector('.video-js');
    return (host && host.player) || null;
}

// Jump the Stash player to a scene time. video.js takes scene time and copes with
// transcoded streams, so go through it when it's reachable; otherwise set the <video> directly.
function seekScene(seconds){
    var vjs = stashPlayer();
    if(vjs && typeof vjs.currentTime === 'function'){ vjs.currentTime(seconds); return; }
    if(boundPlayer){ boundPlayer.currentTime = Math.max(0, seconds - streamOffsetMs / 1000); }
}

function formatTime(sec){
    sec = Math.max(0, Math.round(sec));
    var h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return (h ? h + ':' + String(m).padStart(2, '0') : String(m)) + ':' + String(s).padStart(2, '0');
}

// ---------------------------------

/* Stash Integration */
function fetchSceneInfo(id){
    stashGql("query($id: ID!){ findScene(id: $id){ files { path } } }", { id: String(id) })
        .then(function(data){
            var scene = data.findScene;
            if(scene && scene.files.length > 0){
                video = scene.files[0].path;
                debug("Video: " + video);
                fetchAllFunscripts();
            }
        })
        .catch(function(e){ console.error("[TCode] Couldn't load the scene:", e); });
}

function initAxis(name){
    if(AXIS[name]){ return -1; }
    AXIS[name] = new Object();
    AXIS[name].index = 0; AXIS[name].start = 0; AXIS[name].end = 0; AXIS[name].scriptLoaded = false;
    AXIS[name].acts = null; AXIS[name].limits = null;
}

function fetchAllFunscripts(){
    // First, try to fetch the main funscript which may contain multiple axes
    fetchMainFunscript();
}

// Maps the many axis-name conventions found in single-file multi-axis
// funscripts onto the six TCode axes this script drives (L0/L1/L2/R0/R1/R2).
// Uses the SAME convention the separate-file loader uses:
//   L0=stroke, L1=surge, L2=sway, R0=twist, R1=roll, R2=pitch
var AXIS_ALIASES = {
    // canonical TCode codes (pass-through)
    "l0":"L0", "l1":"L1", "l2":"L2", "r0":"R0", "r1":"R1", "r2":"R2",
    // descriptive names
    "stroke":"L0", "up":"L0", "updown":"L0", "linear":"L0",
    // Descriptive names, per the TCode convention (right-hand rule: Rn rotates about Ln).
    //   L1 = surge = forward/back   L2 = sway = left/right
    //   R1 = roll  = tilt L/R       R2 = pitch = tilt fwd/back
    "surge":"L1", "forward":"L1", "forwardbackward":"L1",
    "sway":"L2", "left":"L2", "leftright":"L2",
    "twist":"R0", "yaw":"R0",
    "roll":"R1",
    "pitch":"R2"
};

// Returns the canonical TCode axis name for any known alias, or null if the
// axis isn't one this script can drive (e.g. vibrate/valve/suck axes).
function normalizeAxisId(id){
    if(id == null){ return null; }
    var key = String(id).trim().toLowerCase().replace(/[\s_\-\.]/g, '');
    return AXIS_ALIASES[key] || null;
}

// Parse a multi-axis funscript file (single file with an "axes" array)
function parseMultiAxisFunscript(json) {
    var foundAxes = [];

    // Check if this is a multi-axis funscript (has "axes" array)
    if (json.axes && Array.isArray(json.axes) && json.axes.length > 0) {
        debug("Multi-axis funscript detected with " + json.axes.length + " axes");

        // Process each axis in the axes array
        for (var i = 0; i < json.axes.length; i++) {
            var axisData = json.axes[i];
            var rawId = axisData.id;              // e.g. "R1", "surge", "twist", etc.
            var axisId = normalizeAxisId(rawId);  // -> canonical TCode name, or null

            if (axisId == null) {
                // Unknown / undrivable axis (vibrate, suck, valve, ...) — skip it
                // rather than creating an AXIS entry that later crashes the
                // playback loops (which key on settings.axes[L0..R2]).
                debug("Skipping unsupported axis id '" + rawId + "' in multi-axis file");
                continue;
            }

            if (axisData.actions && Array.isArray(axisData.actions) && axisData.actions.length > 0) {
                if (!AXIS[axisId]) { initAxis(axisId); }
                AXIS[axisId].acts = axisData.actions;
                AXIS[axisId].start = AXIS[axisId].acts[0].at;
                AXIS[axisId].end = AXIS[axisId].acts[AXIS[axisId].acts.length - 1].at;
                AXIS[axisId].scriptLoaded = true;
                foundAxes.push(axisId);
                debug("Loaded axis " + axisId + " (from '" + rawId + "') with " + axisData.actions.length + " actions");
            }
        }

        // Also check for root-level actions (usually L0/stroke)
        if (json.actions && Array.isArray(json.actions) && json.actions.length > 0) {
            if (!AXIS["L0"]) { initAxis("L0"); }
            AXIS["L0"].acts = json.actions;
            AXIS["L0"].start = AXIS["L0"].acts[0].at;
            AXIS["L0"].end = AXIS["L0"].acts[AXIS["L0"].acts.length - 1].at;
            AXIS["L0"].scriptLoaded = true;
            foundAxes.push("L0");
            debug("Loaded L0 from root actions with " + json.actions.length + " actions");
        }

        return foundAxes;
    }

    // Not a multi-axis file
    return null;
}

// Fetch the main funscript file first, then check if it's multi-axis
function fetchMainFunscript() {
    var chosenScript = document.querySelector('#stash-interactive-tools-select-funscripts');
    var url = (chosenScript && sameOriginUrl(chosenScript.value)) || defaultFunscriptUrl();

    getStashText(url).then(function(response) {
            if (response.status == 200) {
                try {
                    var json = JSON.parse(response.response);

                    // Try to parse as multi-axis first
                    var multiAxisResult = parseMultiAxisFunscript(json);

                    if (multiAxisResult && multiAxisResult.length > 0) {
                        // Multi-axis file was successfully parsed
                        debug("Successfully loaded multi-axis funscript with axes: " + multiAxisResult.join(", "));
                        showToast("Multi-Axis Script Loaded", "Parsed " + multiAxisResult.length + " axes: " + multiAxisResult.join(", "), "success");

                        // For any axes not found in the multi-axis file, try their separate files
                        for (var axis in AXIS) {
                            if (!AXIS[axis].scriptLoaded) { fetchFunscript(axis, true); }
                        }
                    } else {
                        // Single-axis file (legacy format) - load as L0
                        if (json.actions && Array.isArray(json.actions) && json.actions.length > 0) {
                            if (!AXIS["L0"]) { initAxis("L0"); }
                            AXIS["L0"].acts = json.actions;
                            AXIS["L0"].start = AXIS["L0"].acts[0].at;
                            AXIS["L0"].end = AXIS["L0"].acts[AXIS["L0"].acts.length - 1].at;
                            AXIS["L0"].scriptLoaded = true;
                            debug("Loaded single-axis funscript as L0 with " + json.actions.length + " actions");
                            showToast("Script Loaded", "L0 axis with " + json.actions.length + " actions", "success");
                        }

                        // Fetch other axes from separate files
                        for (var axis in AXIS) {
                            if (!AXIS[axis].scriptLoaded && axis !== "L0") { fetchFunscript(axis); }
                        }
                    }
                } catch (error) {
                    debug("JSON parse error in main funscript: " + error);
                    showToast("Parse Error", "Failed to parse funscript, trying individual files", "warning");
                    // Fallback to fetching individual files
                    fetchIndividualAxisFiles();
                }
            } else {
                debug("Main funscript not found, trying individual files");
                showToast("No Main Script", "Searching for individual axis files...", "info");
                fetchIndividualAxisFiles();
            }

            // Clean up dropdown options
            if (chosenScript) { cleanUpOptions(chosenScript); }
    }).catch(function(e) { console.error("[TCode] Couldn't load the funscript:", e); });
}

// Fallback: fetch individual axis files
function fetchIndividualAxisFiles() {
    for (var axis in AXIS) {
        if (!AXIS[axis].scriptLoaded) { fetchFunscript(axis); }
    }
    var chosenScript = document.querySelector('#stash-interactive-tools-select-funscripts');
    if (chosenScript) { cleanUpOptions(chosenScript); }
}

function fetchFunscript(axis, force=false){
    if(scriptList == null){
        // Ask the Stash Interactive Tools plugin for the scene's script list, once: every
        // axis lands here before the first answer, and each plugin call can start a process
        // on the server. Without the plugin (or if it fails) carry on with an empty list and
        // try the default paths.
        if(!scriptListRequest){
            scriptListRequest = stashGql("mutation($plugin_id: ID!, $args: Map){ runPluginOperation(plugin_id: $plugin_id, args: $args) }",
                     { plugin_id: "StashInteractiveTools", args: { mode: "init", scene_id: String(getSceneId()), origin: location.origin } })
                .then(function(data){ scriptList = (data.runPluginOperation && data.runPluginOperation.scripts) || []; })
                .catch(function(e){ debug("[TCode] StashInteractiveTools unavailable: " + e.message); scriptList = []; })
                .then(function(){ scriptListRequest = null; });
        }
        scriptListRequest.then(function(){ fetchFunscript(axis); });
    }else{
        var chosenScript = document.querySelector('#stash-interactive-tools-select-funscripts');
        if(!chosenScript && !force){ setTimeout(function(){fetchFunscript(axis, true)}, 500); return -1; }
        var chosen = chosenScript && sameOriginUrl(chosenScript.value);
        var url = chosen ? chosen.split('.funscript')[0] : defaultFunscriptUrl();

        switch(axis){
            case "L1": url += ".surge"; break; case "L2": url += ".sway"; break; case "R0": url += ".twist"; break; case "R1": url += ".roll"; break; case "R2": url += ".pitch"; break;
        }
        if(chosen){ url = url + ".funscript"; }
        getStashText(url).then(function(response){
            if(!AXIS[axis]){ AXIS[axis] = new Object(); }
            var acts = null;
            if(response.status == 200){
                try { acts = JSON.parse(response.response).actions; }
                catch (error) { debug("[TCode] " + axis + " script isn't valid JSON"); }
            }
            // No usable actions (missing file, or not a funscript): this axis has no script.
            // Used to retry here forever when a 200 response held no actions.
            if(Array.isArray(acts) && acts.length > 0){
                AXIS[axis].acts = acts;
                AXIS[axis].start = acts[0].at;
                AXIS[axis].end = acts[acts.length-1].at;
                showToast("Axis Loaded", axis + " with " + acts.length + " actions", "success", 3000);
            }else{
                AXIS[axis].acts = null;
            }
            AXIS[axis].scriptLoaded = true;
        }).catch(function(e){ debug("[TCode] " + axis + " script request failed: " + e); });
    }
}

// --- HR GOVERNOR ---
// Heart rate decides how much of each stroke the device may play: the allowance `a`,
// 0-1. Inspired by EdgeLoop's biofeedback limiter (github.com/marshallmims/edgeloop),
// reimplemented here:
//   - Approach band: in the last `band` BPM below the ceiling, `a` falls linearly from
//     1 to the floor, so strokes shorten as you climb.
//   - Edge: at the ceiling `a` is 0 (the stroker parks at the bottom of its range) until
//     HR drops EDGE_RELEASE_BPM below it, then ramps back in over `rejoinSec`.
//   - Adaptive decay: every N edges the ceiling drops M BPM, never below a floor.
//   - Climax marks: around a marked time `a` is lifted toward 1 regardless of HR.
//   - Watchdog: with modulation on and no fresh reading, `a` is 0.
// The pure functions below take everything as arguments so they can be tested alone.

var EDGE_RELEASE_BPM = 5;   // hysteresis: an edge only clears this far below the ceiling
var REJOIN_START = 0.16;    // allowance at the moment an edge clears

// The session (edge count, which drives decay; whether we're at the edge; when the last
// edge cleared) is kept in sessionStorage: it survives a page reload, say when another
// plugin misbehaves, but not closing the tab, which is what ends a session.
var HR_SESSION_KEY = 'stash-tcode:hrSession';
var hrSession = loadHrSession();
var climaxMarksMs = [];     // climax mark times for the current scene (scene ms)
var lastGov = null;         // most recent governor result, for the UI

// The ceiling after adaptive decay. The floor can stop the decay but never raise the
// ceiling above the edge HR you set. Returns {ceiling, decay}.
function workingCeiling(cfg, edges){
    var typed = cfg.edgeHr;
    if(!cfg.decay || !(edges > 0)){ return { ceiling: typed, decay: 0 }; }
    var drop = Math.floor(edges / Math.max(1, cfg.decayEvery)) * cfg.decayBpm;
    var ceiling = Math.min(typed, Math.max(cfg.decayFloor, typed - drop));
    return { ceiling: ceiling, decay: typed - ceiling };
}

// 1 below the band, falling linearly to floorPct/100 at the ceiling.
function approachFactor(bpm, ceiling, band, floorPct){
    if(!(band > 0)){ return 1; }
    var s = Math.max(0, Math.min(1, (bpm - (ceiling - band)) / band));
    return 1 - s * (1 - floorPct / 100);
}

// Cap on the allowance `sinceSec` seconds after an edge cleared: eases from REJOIN_START
// up to 1 over rejoinSec. No ramp running (null) or a zero-length ramp is 1.
function rejoinFactor(sinceSec, rejoinSec){
    if(sinceSec == null || !(rejoinSec > 0)){ return 1; }
    var t = Math.max(0, Math.min(1, sinceSec / rejoinSec));
    var eased = t * t * (3 - 2 * t); // smoothstep
    return REJOIN_START + (1 - REJOIN_START) * eased;
}

// How far climax marks have taken over at sceneMs, 0-1: climbs over rampMs before a
// mark, holds at 1 for holdMs, then eases back over easeMs. The strongest mark wins.
// A mark is a time in ms, or {at, hold} where a non-null hold overrides holdMs (a
// Stash marker with an end time holds for its whole range).
function climaxFactor(sceneMs, marks, rampMs, holdMs, easeMs){
    if(sceneMs == null || !marks || !marks.length){ return 0; }
    var k = 0;
    for(var mark of marks){
        var at = typeof mark === 'number' ? mark : mark.at;
        var hold = typeof mark === 'number' || mark.hold == null ? holdMs : mark.hold;
        var d = at - sceneMs; // > 0: mark still ahead
        if(d > 0){
            if(rampMs > 0 && d <= rampMs){ k = Math.max(k, 1 - d / rampMs); }
        }else if(-d <= hold){
            k = 1;
        }else if(easeMs > 0 && -d <= hold + easeMs){
            k = Math.max(k, 1 - (-d - hold) / easeMs);
        }
    }
    return Math.max(0, Math.min(1, k));
}

function loadHrSession(){
    try {
        var saved = JSON.parse(window.sessionStorage.getItem(HR_SESSION_KEY) || 'null');
        if(saved && typeof saved.edges === 'number'){
            return { edged: !!saved.edged, edges: Math.max(0, Math.floor(saved.edges)),
                     releasedAt: typeof saved.releasedAt === 'number' ? saved.releasedAt : null };
        }
    } catch(e) {} // unavailable or corrupt: start fresh
    return { edged: false, edges: 0, releasedAt: null };
}

function saveHrSession(){
    try { window.sessionStorage.setItem(HR_SESSION_KEY, JSON.stringify(hrSession)); } catch(e) {}
}

// Advance the edge state machine for one reading. Rising through the ceiling counts an
// edge (but not while a climax mark has taken over); it clears below the release band.
function updateEdgeState(session, bpm, ceiling, climaxActive, now){
    if(bpm >= ceiling){
        if(!session.edged && !climaxActive){
            session.edged = true;
            session.edges++;
            return 'edge';
        }
    }else if(session.edged && bpm < ceiling - EDGE_RELEASE_BPM){
        session.edged = false;
        session.releasedAt = now;
        return 'release';
    }
    return null;
}

// The governor for this moment. Returns {a, phase, label, ceiling, decay, climax, bpm}.
//   phase: OFF | NO MONITOR | NO SIGNAL | FREE | EASING | EDGE | REJOINING | CLIMAX
function computeAllowance(now, sceneMs){
    var cfg = settings.hr;
    var res = { a: 1, phase: 'OFF', label: 'OFF', ceiling: null, decay: 0, climax: 0, bpm: hr.bpm };
    if(!cfg.enabled){ return res; }
    var wc = workingCeiling(cfg, hrSession.edges);
    res.ceiling = wc.ceiling;
    res.decay = wc.decay;
    res.climax = cfg.climax === false ? 0 :
        climaxFactor(sceneMs, climaxMarksMs, cfg.climaxRampSec * 1000, cfg.climaxHoldSec * 1000, cfg.climaxEaseSec * 1000);

    if(hr.status === 'off'){
        // No monitor at all: play the script as-is rather than refuse to move.
        res.phase = res.label = 'NO MONITOR';
        return res;
    }
    if(hr.bpm == null || now - hr.at > cfg.timeoutSec * 1000){
        // Watchdog: a monitor that has gone quiet stops the device.
        res.a = 0;
        res.phase = res.label = 'NO SIGNAL';
        return res;
    }

    var event = updateEdgeState(hrSession, hr.bpm, wc.ceiling, res.climax > 0, now);
    if(event){ saveHrSession(); }
    if(event === 'edge'){ onEdge(); }

    var base;
    if(hrSession.edged){
        base = 0;
        res.phase = res.label = 'EDGE';
    }else{
        base = approachFactor(hr.bpm, wc.ceiling, cfg.band, cfg.floor);
        res.phase = base < 1 ? 'EASING' : 'FREE';
        var since = hrSession.releasedAt != null ? (now - hrSession.releasedAt) / 1000 : null;
        var r = rejoinFactor(since, cfg.rejoinSec);
        if(r < base){
            base = r;
            res.phase = 'REJOINING';
            res.label = 'REJOINING ' + Math.max(1, Math.ceil(cfg.rejoinSec - since)) + ' s';
        }else if(r >= 1 && hrSession.releasedAt != null){
            hrSession.releasedAt = null; // ramp finished
            saveHrSession();
        }
        if(res.phase === 'EASING'){ res.label = 'EASING ' + Math.round(base * 100) + '%'; }
        if(res.phase === 'FREE'){ res.label = 'FREE'; }
    }
    if(res.climax > 0){
        base = base + (1 - base) * res.climax;
        res.phase = 'CLIMAX';
        res.label = 'CLIMAX ' + Math.round(res.climax * 100) + '%';
    }
    res.a = base;
    return res;
}

// The allowance motion actually uses. `a` changes in steps: with each heart-rate reading
// (about one a second) inside the approach band, and all at once when an edge starts or
// clears. Applied straight, every shaped axis jumped within a single tick, which a slow
// twist showed as a stutter after each edge. So motion follows `a` at a capped rate: up
// gently, down faster so backing off at the edge stays prompt. Losing the monitor's
// signal still stops at once.
var A_RISE_PER_SEC = 0.3;
var A_FALL_PER_SEC = 0.8;

function smoothAllowance(prev, target, dtMs){
    if(prev == null){ return target; }
    var step = Math.max(0, dtMs) / 1000;
    if(target > prev){ return Math.min(target, prev + A_RISE_PER_SEC * step); }
    return Math.max(target, prev - A_FALL_PER_SEC * step);
}

var motionA = null, motionAAt = 0;
function motionAllowance(gov, now){
    motionA = gov.phase === 'NO SIGNAL' ? 0 : smoothAllowance(motionA, gov.a, now - motionAAt);
    motionAAt = now;
    return motionA;
}

// Scale one funscript position (0-100, after invert) by the allowance. Stroke shortens
// from the bottom of its range; every other axis shrinks toward its home position.
function shapePosition(axis, pos, a){
    if(a >= 1){ return pos; }
    if(axis === "L0"){ return pos * a; }
    var lo = parseInt(AXIS[axis].limits[0]), hi = parseInt(AXIS[axis].limits[1]);
    var home = hi > lo ? (getCenter(axis) - lo) / (hi - lo) * 100 : 50;
    return home + (pos - home) * a;
}

function onEdge(){
    showToast("Edge " + hrSession.edges, "Holding until your heart rate drops " + EDGE_RELEASE_BPM + " BPM", "warning", 3000);
    debug("[TCode] Edge " + hrSession.edges + " at " + hr.bpm + " BPM");
}

function resetHrSession(){
    hrSession.edged = false;
    hrSession.edges = 0;
    hrSession.releasedAt = null;
    saveHrSession();
    refreshGovernor();
}

// Scene time of the bound player in ms (transcode offset included), or null.
function currentSceneMs(){
    if(!boundPlayer){ return null; }
    return Math.floor(boundPlayer.currentTime * 1000) + streamOffsetMs + (parseInt(settings.sync) || 0);
}

// Re-evaluate outside playback (on each HR reading, settings changes) so edges are
// counted and the UI stays current even while the video is paused.
function refreshGovernor(){
    lastGov = computeAllowance(Date.now(), currentSceneMs());
    updateGovUi();
}

function govStatusText(g){
    if(!g || g.phase === 'OFF'){ return "Off"; }
    var parts = [];
    if(g.bpm != null && g.phase !== 'NO MONITOR'){ parts.push(g.bpm + " BPM"); }
    if(g.ceiling != null){ parts.push("ceiling " + g.ceiling + (g.decay ? " (−" + g.decay + ")" : "")); }
    parts.push(hrSession.edges + (hrSession.edges === 1 ? " edge" : " edges"));
    parts.push(g.label);
    return parts.join(" · ");
}

function updateGovUi(){
    var line = document.getElementById('tcode-gov-status');
    if(line){ line.textContent = govStatusText(lastGov); }
}

// ---------------------------------

// --- AUTO MOTION ---
// An axis with auto motion on, and no script for the current scene, follows a sine wave
// across its range at its own frequency. A new target goes out every SINE_STEP_MS and
// the device interpolates between them, so the motion is smooth rather than a zigzag.
// It runs on video time, so it pauses with the video, and goes through the same
// invert / heart-rate shaping as scripted motion.

var SINE_STEP_MS = 50;
var SINE_REJOIN_MS = 500;   // first move after a seek or start: slow, never a slam
var AUTO_HZ_MIN = 0.05;
var AUTO_HZ_MAX = 3;

// Sine position (0-100) at sceneMs. Each axis starts at a different point in its
// cycle so axes sharing a frequency don't move in lockstep.
function sinePosition(hz, sceneMs, axisIndex){
    hz = Math.max(AUTO_HZ_MIN, Math.min(AUTO_HZ_MAX, Number(hz) || 0.5));
    return 50 + 50 * Math.sin(2 * Math.PI * hz * sceneMs / 1000 + axisIndex * 0.7);
}

function autoMotion(axis, ms, jumped, a){
    var ax = AXIS[axis];
    // Moves chain end to end: the next one goes out when the device reaches the last
    // target (ax.sineDue), so a slow rejoin move is never cut short by a quick step.
    // A seek, or the playhead landing far from the chain, starts over with a rejoin.
    var fresh = jumped || ax.sineDue == null || ms < ax.sineDue - SINE_REJOIN_MS || ms > ax.sineDue + SINE_REJOIN_MS;
    if(!fresh && ms < ax.sineDue){ return; }
    var interval = fresh ? SINE_REJOIN_MS : SINE_STEP_MS;
    ax.sineDue = ms + interval;
    emitAxisMove(axis, sinePosition(settings.axes[axis].autoHz, ms + interval, AXIS_LIST.indexOf(axis)), interval, a);
}

// --- IDLE MOTION ---
// With idle motion on, L0 keeps a slow stroke going whenever no video is playing:
// browsing for the next scene, on another page, or paused. It starts a moment after
// playback stops and gives way as soon as a video plays. It runs on wall-clock time and
// goes through the same range, invert, heart-rate shaping and speed limit as playback,
// so it stops at an edge like any other motion.

var IDLE_DELAY_MS = 2000;   // wait this long after playback stops
var IDLE_HZ_MIN = 0.05;
var IDLE_HZ_MAX = 1;
var IDLE_RANGE_MIN = 10;
var idleDue = null;         // when the next idle move goes out; null while idle motion is off
var idleTickAt = null;      // when the idle loop last ran
var lastPlayingAt = 0;

// Idle stroke position (0-100) at tMs: rangePct of the stroke, centred in the axis range.
function idlePosition(hz, tMs, rangePct){
    hz = Math.max(IDLE_HZ_MIN, Math.min(IDLE_HZ_MAX, Number(hz) || 0.2));
    var half = Math.max(IDLE_RANGE_MIN, Math.min(100, Number(rangePct) || 100)) / 2;
    return 50 + half * Math.sin(2 * Math.PI * hz * tMs / 1000);
}

function idleWanted(s){
    return !!(s.connected && s.enabled && s.idle && !s.playing && s.sincePlayingMs >= IDLE_DELAY_MS);
}

function idleTick(){
    var now = Date.now();
    // A browser runs a hidden tab's timers about once a second; each move then covers the
    // real gap, so the stroke stays smooth instead of darting and waiting.
    var gap = idleTickAt == null ? SINE_STEP_MS : Math.max(SINE_STEP_MS, Math.min(1000, now - idleTickAt));
    idleTickAt = now;
    var playing = !!(boundPlayer && boundPlayer.isConnected && !boundPlayer.paused);
    if(playing){ lastPlayingAt = now; }
    var cfg = settings.axes.L0;
    if(!idleWanted({ connected: serialConnected, enabled: cfg.enabled, idle: cfg.idle, playing: playing, sincePlayingMs: now - lastPlayingAt })){
        idleDue = null;
        return;
    }
    // Off a scene page the axes aren't set up yet: take L0's saved range.
    initAxis("L0");
    if(AXIS.L0.limits == null){ AXIS.L0.limits = getLimit("L0", BOTH).slice(0); }
    if(idleDue != null && now < idleDue){ return; }
    var interval = idleDue == null ? SINE_REJOIN_MS : gap; // first move: slow, from wherever it is
    idleDue = now + interval;
    var gov = lastGov = computeAllowance(now, null);
    emitAxisMove("L0", idlePosition(cfg.idleHz, now + interval, cfg.idleRange), interval, motionAllowance(gov, now));
    move();
}

function startIdleMotion(){
    setInterval(idleTick, 25);
}

// --- LINKED AXES ---
// An axis set to follow another copies the moves that axis makes: whenever the source
// heads to a script position (0-100) over some time, the follower heads to the same
// position within its own range over the same time. The source's raw position is used
// (before its invert), so the follower's own range and invert decide how it moves.
// Precedence on an axis: its own script, then following, then auto motion; with
// "Override script" on, following wins over the axis's own script too.

var tickMoves = {};   // axis -> {pos, int}: raw positions sent during this playback tick

// Send one move for an axis from a raw script position: invert, heart-rate shaping and
// the axis range, then queue it. Records the raw position for any axis following it.
function emitAxisMove(axis, rawPos, int, a){
    var pos = settings.axes[axis].invert ? 100 - rawPos : rawPos;
    pos = shapePosition(axis, pos, a); // heart-rate modulation (a = 1 when off)
    // Map 0-100 onto the axis range in device units (0-9999).
    var lo = parseInt(AXIS[axis].limits[0]), hi = parseInt(AXIS[axis].limits[1]);
    queueMove(axis, Math.round((pos / 100) * (hi - lo) + lo), int);
    tickMoves[axis] = { pos: rawPos, int: int };
}

// After the scripted and auto-motion moves of a tick: followers copy their source's move.
// A few passes, so a chain (R1 follows R0 follows L0) resolves within the same tick; a
// loop (A follows B follows A) simply never moves.
function emitLinkedMoves(a){
    for(var pass = 0; pass < AXIS_LIST.length; pass++){
        var progressed = false;
        AXIS_LIST.forEach(function(axis){
            var cfg = settings.axes[axis];
            var src = cfg && cfg.link;
            if(!src || src === axis || !cfg.enabled || !AXIS[axis] || AXIS[axis].limits == null){ return; }
            if(AXIS[axis].acts != null && !cfg.linkOverride){ return; } // its own script wins, unless overridden
            if(tickMoves[axis] || !tickMoves[src]){ return; }
            emitAxisMove(axis, tickMoves[src].pos, tickMoves[src].int, a);
            progressed = true;
        });
        if(!progressed){ break; }
    }
}

// ---------------------------------

// --- SPEED LIMIT ---
// Caps how fast an axis may travel, per axis. The limit is stored in full travels per
// second (1 = the whole 0-9999 range in one second; MultiFunPlayer's "u/s") and shown as
// % of full travel per second. A move that would be faster has its end pulled back toward where the
// axis is, so it fits in the same time. Timing never changes, so playback stays in sync,
// and the next move starts from the clipped point.

var MAX_SPEED_MIN = 0.25;
var MAX_SPEED_MAX = 20;

function limitSpeed(from, to, intervalMs, maxUps){
    if(from == null || !(maxUps > 0)){ return to; }
    var reach = maxUps * 9999 * Math.max(0, intervalMs) / 1000;
    var d = to - from;
    if(Math.abs(d) <= reach){ return to; }
    return Math.round(from + Math.sign(d) * reach);
}

// Where each axis was last sent is unknown after (re)connecting.
function forgetAxisPositions(){
    for(var ax in AXIS){ AXIS[ax].lastPos = null; }
}

// ---------------------------------


// Clamp helper: returns an integer inside [0, 9999].
function clamp9999(v){
    v = Math.round(Number(v));
    if(!isFinite(v)){ return 0; }
    if(v < 0){ return 0; }
    if(v > 9999){ return 9999; }
    return v;
}

// Resolves where an axis should park. Auto mode tracks the midpoint of the configured
// range; manual mode uses the stored value, always clamped inside min/max so a saved
// center can't drive the axis outside a range narrowed later.
function getCenter(axis){
    var lo = parseInt(getLimit(axis, LOWER));
    var hi = parseInt(getLimit(axis, UPPER));
    if(!isFinite(lo)){ lo = 0; }
    if(!isFinite(hi)){ hi = 9999; }
    var cfg = settings.axes[axis] || {};
    var c;
    if(cfg.autoCenter === false && cfg.center != null && cfg.center !== ""){ c = parseInt(cfg.center); }
    else { c = lo + ((hi - lo) / 2); }
    if(!isFinite(c)){ c = lo + ((hi - lo) / 2); }
    if(c < lo){ c = lo; }
    if(c > hi){ c = hi; }
    return clamp9999(c);
}

function centerAxis(axis){
    if(!serialConnected){ return -1; }
    if(!settings.axes[axis].enabled){ return -1; }
    if(!AXIS[axis].limits || AXIS[axis].limits == null){ setTimeout(function(){ centerAxis(axis)}, 500); return -1; }
    var ramp = parseInt(settings.centerTime);
    if(!isFinite(ramp) || ramp < 0){ ramp = 1000; }
    var home = getCenter(axis);
    var from = AXIS[axis].lastPos;
    // Homing is slowed rather than shortened by the speed limit: it has to arrive. An
    // unknown start position is treated as the far end of travel.
    var cfg = settings.axes[axis];
    if(cfg.speedLimit && cfg.maxSpeed > 0){
        var dist = from != null ? Math.abs(home - from) : Math.max(home, 9999 - home);
        ramp = Math.max(ramp, Math.ceil(dist / (cfg.maxSpeed * 9999) * 1000));
    }
    AXIS[axis].lastPos = home;
    sendTCode(axis + String(home).padStart(4, '0') + "I" + ramp + '\n');
}

// Park every enabled axis now (used by the Center Now button).
function centerAll(){
    if(!serialConnected){ showToast("Not Connected", "Connect over USB first", "warning"); return -1; }
    AXIS_LIST.forEach(ax => centerAxis(ax));
}

function queueMove(axis, pos, int){
    if(!serialConnected){ return -1; }
    var lo = parseInt(AXIS[axis].limits[0]);
    var hi = parseInt(AXIS[axis].limits[1]);
    pos = Math.round(Number(pos));
    if(pos > hi){ pos = hi; } else if(pos < lo){ pos = lo; }
    pos = clamp9999(pos);
    int = Math.round(Number(int));
    if(!isFinite(int) || int < 0){ int = 0; }
    var cfg = settings.axes[axis];
    if(cfg && cfg.speedLimit){
        pos = limitSpeed(AXIS[axis].lastPos, pos, int, cfg.maxSpeed);
        // Coming from outside a range that was just narrowed, the limited step can still
        // be outside it; the range is the hard limit.
        if(pos > hi){ pos = hi; } else if(pos < lo){ pos = lo; }
    }
    AXIS[axis].lastPos = pos;
    // TCode magnitude is the digits after "0." -- send all four so the axis can reach
    // its real endpoints (two digits capped every axis at 0.99 and quantised to 1%).
    var cmd = axis + String(pos).padStart(4, '0') + "I" + int;
    debug(`[TCode] Queued: ${cmd} (axis: ${axis}, enabled: ${settings.axes[axis]?.enabled}, limits: ${lo}-${hi})`);
    // Commands stacked before the terminating \n MUST be separated by a space. Without
    // it the firmware reads "L05000I100R15000I100" as a single malformed L0 command and
    // silently drops every axis after the first.
    sendTCode(cmd + " ");
    tickQueued = true;
}

// Ends the line of commands queued during this playback tick. Nothing queued, nothing
// sent: the tick runs every 10 ms and an empty line would just be serial noise.
var tickQueued = false;
function move(){
    if(serialConnected && tickQueued){ sendTCode('\n'); }
    tickQueued = false;
}

// Binary search for the first keyframe strictly after ms. Returns acts.length when the
// playhead is past the end. Used to re-seat an axis after any non-linear jump.
function seekIndex(acts, ms){
    var lo = 0, hi = acts.length;
    while(lo < hi){
        var mid = (lo + hi) >> 1;
        if(acts[mid] && acts[mid].at > ms){ hi = mid; } else { lo = mid + 1; }
    }
    return lo;
}

function currentAction(ms){
    if(msPending){ return -1; }
    msPending = true;
    try{
        ms += parseInt(settings.sync);
        // Detect any jump the linear walk can't serve -- backward seeks, and forward
        // seeks past the end that previously stranded the index beyond acts.length.
        // This no longer depends on the "seeking" event firing.
        var jumped = (lastActionMs === null) || (ms < lastActionMs) || (ms - lastActionMs > SEEK_THRESHOLD_MS);
        lastActionMs = ms;
        var now = Date.now();
        var gov = lastGov = computeAllowance(now, ms);
        var a = motionAllowance(gov, now);
        tickMoves = {};
        for(var x in AXIS){
            if(!settings.axes[x].enabled || AXIS[x].limits == null){ continue; }
            if(AXIS[x].acts == null){
                // No script for this axis in this scene: it follows another axis if linked
                // (emitLinkedMoves, below), otherwise auto motion fills in if it's on.
                if(!settings.axes[x].link && settings.axes[x].auto){ autoMotion(x, ms, jumped, a); }
                continue;
            }
            // Following with "Override script": ignore this axis's own script entirely.
            if(settings.axes[x].link && settings.axes[x].linkOverride){ continue; }
            if(jumped){ AXIS[x].index = seekIndex(AXIS[x].acts, ms); }
            // Re-seat rather than give up when the index has run off the end (video
            // ended, or a seek left it stranded). The old guard skipped the whole
            // block here, so the axis never recovered without a page navigation.
            if(AXIS[x].acts[AXIS[x].index] == null){
                if(AXIS[x].index >= AXIS[x].acts.length){ AXIS[x].index = seekIndex(AXIS[x].acts, ms); }
                if(AXIS[x].acts[AXIS[x].index] == null){ continue; }
            }
            var prev = AXIS[x].acts[AXIS[x].index-1];
            if(AXIS[x].index == 0 || (prev && prev.at < ms)){
                for(var i=AXIS[x].index;i<AXIS[x].acts.length;i++){
                    if(AXIS[x].acts[i] && AXIS[x].acts[i].at > ms){
                        emitAxisMove(x, AXIS[x].acts[i].pos, AXIS[x].acts[i].at - ms, a);
                        AXIS[x].index = ++i;
                        break;
                    }
                }
            }
        }
        emitLinkedMoves(a);
        move();
    }catch(e){
        // Without this, a throw left msPending stuck true and every later call
        // short-circuited on the first line -- silent, permanent, page-reload-only.
        console.error("[TCode] currentAction failed:", e);
    }finally{
        msPending = false;
    }
}

function resetIndex(){
    lastActionMs = null;
    for(var i in AXIS){ AXIS[i].index = 0; }
}

// Stash restarts the transcode at the seek point and serves it as a fresh stream, so
// on a transcoded source player.currentTime is relative to that restart, not to the
// scene. The absolute position is the src's "start" param plus currentTime. Direct
// stream has no start param, so this resolves to 0 and behaviour is unchanged.
function getStreamOffsetMs(player){
    var src = player.currentSrc || "";
    if(src === lastSrc){ return streamOffsetMs; }
    lastSrc = src;
    streamOffsetMs = 0;
    var m = /[?&]start=([0-9]*\.?[0-9]+)/.exec(src);
    if(m){
        var sec = parseFloat(m[1]);
        if(isFinite(sec) && sec > 0){ streamOffsetMs = Math.round(sec * 1000); }
    }
    debug("[TCode] Stream offset now " + streamOffsetMs + "ms (" + src + ")");
    // A new source means the playhead moved; re-seat so we don't rely on the jump
    // threshold catching a small seek.
    resetIndex();
    return streamOffsetMs;
}

function updateTime(player){
    if(!player.paused){
        var offset = getStreamOffsetMs(player);
        currentAction(Math.floor(player.currentTime*1000) + offset);
    }
}

// One watcher for the whole page lifetime, started at load, independent of the device:
// the climax markers and overlay need the player even with nothing connected.
var playerWatchStarted = false;
function startPlayerWatch(){
    if(playerWatchStarted){ return; }
    playerWatchStarted = true;
    waitForVideoPlayer();
}

// The watcher reschedules itself through here so there's only ever one pending tick.
var watchTimer = null;
function scheduleWatch(delay){
    clearTimeout(watchTimer);
    watchTimer = setTimeout(waitForVideoPlayer, delay);
}
function onPlayerPlay(){ scheduleWatch(0); } // back to the fast tick the moment playback starts

function unbindPlayer(){
    if(!boundPlayer){ return; }
    boundPlayer.removeEventListener("play", onPlayerPlay, false);
    boundPlayer.removeEventListener("seeking", resetIndex, false);
    boundPlayer.removeEventListener("seeked", resetIndex, false);
    boundPlayer.removeEventListener("ended", resetIndex, false);
    boundPlayer.removeEventListener("emptied", resetIndex, false);
    boundPlayer = null;
}

function waitForVideoPlayer(){
    // Only the scene player counts: other pages (the scene wall, marker lists) have
    // preview <video>s of their own.
    // While the bound player is still in the page, skip the DOM lookups.
    var player = !isFinite(getSceneId()) ? null
        : (boundPlayer && boundPlayer.isConnected) ? boundPlayer
        : (document.querySelector('#VideoJsPlayer_html5_api') || document.querySelector('video.vjs-tech') || document.querySelector('video'));
    if(!player){
        // The element can disappear between scenes; drop the stale binding so the
        // replacement gets wired up instead of leaving listeners on a detached node.
        unbindPlayer();
        scheduleWatch(500);
        return;
    }
    // Compare identity, not a boolean. videoPlayerLoaded was set once and never
    // cleared, so after React swapped the <video> the "seeking" listener stayed bound
    // to the old element and seeks stopped resetting the index -- which is why only a
    // page navigation restored playback.
    if(boundPlayer !== player){
        unbindPlayer();
        player.addEventListener("play", onPlayerPlay, false);
        player.addEventListener("seeking", resetIndex, false);
        // "seeking" doesn't fire in every path that moves the playhead (notably
        // resuming after the video ended), so also reset on completion.
        player.addEventListener("seeked", resetIndex, false);
        player.addEventListener("ended", resetIndex, false);
        player.addEventListener("emptied", resetIndex, false);
        resetIndex();
        boundPlayer = player;
        if(!videoPlayerLoaded){
            init();
            videoPlayerLoaded = true;
        }
    }
    updateTime(player);
    // 10 ms ticks while playing; a paused player only needs checking a few times a second.
    scheduleWatch(player.paused ? 250 : 10);
}

function processLimits(data){
    var values;
    var axesFound = [];
    var learned = false;
    console.log(`[TCode] Device returned limits:`, data);
    // Was data.length-1, which silently discarded the last axis reported by D2 when the
    // reply had no trailing blank line (the plain-text path filters blanks out already).
    for(var i=0;i<data.length;i++){
        if(!data[i] || !data[i].trim()){ continue; }
        values = data[i].trim().split(/\s+/);
        if(AXIS[values[0]]){
            // Don't overwrite a user-saved range with the device default
            if(settings.axes[values[0]] && settings.axes[values[0]].limits){
                console.log(`[TCode] Keeping saved limits for ${values[0]} (ignoring device values ${values[1]} - ${values[2]})`);
            }else{
                AXIS[values[0]].limits = new Array(values[1], values[2]);
                console.log(`[TCode] Set ${values[0]} limits: ${values[1]} - ${values[2]}`);
            }

            // Auto-enable an L/R axis the first time a device reports it. After that the
            // user's on/off choice stands: switching an axis off must survive reconnects.
            if(/^[LR]\d+$/.test(values[0]) && settings.axes[values[0]] && settings.knownAxes.indexOf(values[0]) === -1){
                settings.knownAxes.push(values[0]);
                learned = true;
                if(!settings.axes[values[0]].enabled){
                    settings.axes[values[0]].enabled = true;
                    axesFound.push(values[0]);
                    console.log(`[TCode] Auto-enabled ${values[0]} (device supports this axis)`);
                }
            }
        }
    }
    if(axesFound.length > 0){
        showToast("Axes Auto-Enabled", "Enabled " + axesFound.join(", ") + " based on device capabilities", "info");
    }
    if(learned){ saveSettings(); }
    refreshSettingsTab('axes');
}

function processWSReply(event){
    try {
        // Accumulate data in buffer
        serialBuffer += event.data;

        // Clear existing timeout
        if(bufferTimeout) clearTimeout(bufferTimeout);

        // Wait for data to finish arriving (100ms timeout)
        bufferTimeout = setTimeout(() => {
            var cleanData = serialBuffer.replaceAll('\n', '|').replaceAll('\r', '');
            serialBuffer = ""; // Clear buffer

            // Handle JSON format (wrapped in {command: "..."})
            if(cleanData.startsWith('{')) {
                 var json = JSON.parse(cleanData);
                 debug("[TCode] Parsed JSON: " + JSON.stringify(json));
                 processLimits(json.command.split("|"));
            }
            // Handle plain text format - check if ANY line matches axis limits pattern
            else if(/[LRVA]\d+\s+\d+\s+\d+/.test(cleanData)) {
                debug("[TCode] Plain text limits detected");
                // Filter and process only lines that match the pattern (including those after pipes)
                var lines = cleanData.split("|");
                var validLines = lines.filter(line => {
                    var trimmed = line.trim();
                    return /^[LRVA]\d+\s+\d+\s+\d+/.test(trimmed);
                });
                if(validLines.length > 0){
                    debug("[TCode] Found " + validLines.length + " valid limit lines");
                    processLimits(validLines);
                }
            }
        }, 100); // 100ms debounce
    } catch(e) {
        debug("[TCode] Error processing device response: " + e);
    }
}

function setPendingFalse(){ pending = false; }

function loadCurrentLimits(){
    if(pending){ return -1; }
    pending = true;
    if(serialConnected){
        console.log("[TCode] Requesting device limits with D2 command...");
        sendTCode("D2" + '\n');
    }
    setPendingFalse();
}

function limits2socket(axis=""){
    function sendAxis2socket(axis){
        if(AXIS[axis] && AXIS[axis].limits){
            sendTCode("$" + axis + "-" + AXIS[axis].limits[0].toString().padStart(4, '0') + "-" + AXIS[axis].limits[1].toString().padStart(4, '0') + '\n');
        }
    }
    if(axis == ""){ for(var thisAxis in AXIS){ sendAxis2socket(thisAxis); } } else{ sendAxis2socket(axis); }
}

function setLimits(min, max, axis="L0", save=true){
    if(!AXIS[axis]){ return -1; }
    if(AXIS[axis].limits == null){ AXIS[axis].limits = new Array(); }
    AXIS[axis].limits[0] = min; AXIS[axis].limits[1] = max;
    persistLimitsSoon(); // Persist to GM storage so ranges survive refresh/new window (debounced)
    if(pending){ return -1; }
    if(serialConnected && save){
        pending = true; limits2socket(axis); setPendingFalse();
    }
}

function init(){
    AXIS_LIST.forEach(ax => initAxis(ax));
    loadCurrentLimits();
}

function getSceneId(){ return parseInt(location.href.split('/scenes/')[1]); }

// Device-side setup for the current scene, once a device is connected. Each scene
// change supersedes the previous call, so waits don't pile up while disconnected.
var mainToken = 0;
function main(){
    var token = ++mainToken;
    mainAttempt(token);
}

function mainAttempt(token){
    if(token !== mainToken){ return; }
    if(serialConnected){
        // Restore saved ranges FIRST, synchronously, before anything (centerAxis or the
        // device D2 reply) can call setLimits and trigger a save.
        // Doing this on a timer previously let startup write the fallback [0,9999] over
        // the user's real saved range.
        AXIS_LIST.forEach(ax => {
            if(!AXIS[ax]){ return; }
            if(settings.axes[ax] && settings.axes[ax].limits){
                // User-saved range wins over device defaults
                AXIS[ax].limits = settings.axes[ax].limits.slice(0);
                console.log(`[TCode] Restored saved range for ${ax}: ${AXIS[ax].limits[0]} - ${AXIS[ax].limits[1]}`);
            } else {
                console.log(`[TCode] No saved range for ${ax}, using fallback: 0 - 9999`);
                AXIS[ax].limits = [0, 9999];
            }
        });

        // Ranges are now in place; persistence is allowed from here on.
        limitsReady = true;

        loadCurrentLimits(); // ask the device; processLimits() keeps saved ranges over device defaults
        AXIS_LIST.forEach(ax => {
            if(settings.axes[ax] && settings.axes[ax].limits){ limits2socket(ax); } // push saved range to device
        });

        // Automatic homing is opt-out; the Home Now button ignores this and always runs.
        if(settings.homeEnabled !== false){
            AXIS_LIST.forEach(ax => centerAxis(ax));
        }
        fetchSceneInfo(getSceneId());
    }else{ setTimeout(function(){ mainAttempt(token); }, 500); }
}

function cleanUpOptions(list){
    var options = list.childNodes;
    for(var i=0;i<options.length;i++){
        if(!options[i]){ return -1; }
        var type = options[i].value.replace(/\.funscript/, '').split('.');
        switch(type[type.length-1]){
            case "sway": case "surge": case "twist": case "pitch": case "roll":
                options[i].parentNode.removeChild(options[i]); break;
        }
    }
}

// Per-axis files load alongside the main script, so they aren't a choice of their own in the
// Interactive Tools dropdown: tidy it as the user goes to open it. Picking another script
// reloads them all. Listening on the document covers the dropdown however often it's redrawn.
function watchScriptPicker(){
    var isPicker = function(t){ return t && t.id === 'stash-interactive-tools-select-funscripts'; };
    document.addEventListener('mousedown', function(e){ if(isPicker(e.target)){ cleanUpOptions(e.target); } }, true);
    document.addEventListener('focusin', function(e){ if(isPicker(e.target)){ cleanUpOptions(e.target); } });
    document.addEventListener('change', function(e){ if(isPicker(e.target)){ fetchAllFunscripts(); } });
}

// Stash announces each navigation to plugins. On a Stash that doesn't, check the address
// twice a second instead.
function watchPageChanges(){
    watchScriptPicker();
    var events = window.PluginApi && window.PluginApi.Event;
    onPageChange(); // the page we started on
    if(events && typeof events.addEventListener === 'function'){
        events.addEventListener('stash:location', onPageChange);
    }else{
        setInterval(onPageChange, 500);
    }
}

function onPageChange(){
    if(location.href == lastPage){ return; }
    lastPage = location.href;
    scriptList = null;

    // Reset ALL axis data when changing videos
    for(var axis in AXIS){
        AXIS[axis].index = 0;
        AXIS[axis].start = 0;
        AXIS[axis].end = 0;
        AXIS[axis].scriptLoaded = false;
        AXIS[axis].acts = null;
        // Keep limits - these come from the device / saved settings
    }

    if(location.href.indexOf('/scenes/') != -1){
        init(); main();
        fetchClimaxMarkers();
    }else{
        videoPlayerLoaded = false;
        setClimaxMarkers(null, []);
    }
}

async function start(){
    startNavButton(); // first: the navbar patch must be in before Stash draws the navbar
    await loadStashSettings(); // before anything reads the settings
    updateHrUi(); // the navbar button may have drawn before Stash's settings arrived
    publishDebugApi();
    startSerialAutoConnect();
    autoConnectHr();
    startClimaxPolling();
    startPlayerWatch();
    startHud();
    startIdleMotion();
    watchPageChanges();
}

start();

})();
