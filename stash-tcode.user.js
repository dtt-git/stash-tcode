// ==UserScript==
// @name         Stash-TCode
// @namespace    https://github.com/dtt-git/stash-tcode
// @version      0.5.18
// @description  Integrate TCode Devices with Stash via USB Web Serial
// @author       dtt (originally by Steel, modded by Spunkle)
// @include      http*://*:9999*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_info
// @grant        unsafeWindow
// @license      GPLv3
// @homepageURL  https://github.com/dtt-git/stash-tcode
// @supportURL   https://github.com/dtt-git/stash-tcode/issues
// @updateURL    https://raw.githubusercontent.com/dtt-git/stash-tcode/main/stash-tcode.user.js
// @downloadURL  https://raw.githubusercontent.com/dtt-git/stash-tcode/main/stash-tcode.user.js
// ==/UserScript==

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
const isChrome = !!unsafeWindow.chrome;

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
        if(value == ""){ console.log(text); } else { unsafeWindow[value] = text; }
    }
}

// Persist current in-memory axis ranges to GM storage (debounced).
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
        GM_setValue("settings", settings);
        debug("[TCode] Persisted axis ranges to storage");
    }, 300);
}

function settingsMenuApplySaved(){
    for(const setting in settings){
        if(setting == "axes"){
            for (const axis in settings.axes){
                var axisCheck = document.querySelector('#enable' + axis);
                if(axisCheck && settings.axes[axis].enabled){
                    axisCheck.checked = true;
                    var group = axisCheck.closest('.control-group');
                    var parentContainer = group ? group.querySelector('.dual-slider-container') : null;
                    if(parentContainer){ parentContainer.classList.remove('disabled'); }
                    var homeRow = group ? group.querySelector('.control-row-secondary') : null;
                    if(homeRow){ homeRow.classList.remove('disabled'); }
                }
                var invertCheck = document.querySelector('#invert' + axis);
                if(invertCheck && settings.axes[axis].invert){ invertCheck.checked = true; }
                var autoCenterCheck = document.querySelector('#autoCenter' + axis);
                if(autoCenterCheck){ autoCenterCheck.checked = (settings.axes[axis].autoCenter !== false); }
            }
            continue;
        }
        var input = document.querySelector('#' + setting);
        if(input){
            if(input.type == "checkbox"){
                if(JSON.parse(settings[setting])){ input.checked = true; }
            }else if(input.type == "text" || input.type == "range"){
                input.value = settings[setting];
            }
        }
    }
}

function saveSettings(saveToDevice=true){
    for(const setting in settings){
        if(setting == "axes"){
            for (const axis in settings.axes){
                var axisCheck = document.querySelector('#enable' + axis);
                if(axisCheck){ settings.axes[axis].enabled = axisCheck.checked; }
                var invertCheck = document.querySelector('#invert' + axis);
                if(invertCheck){ settings.axes[axis].invert = invertCheck.checked; }
                var autoCenterCheck = document.querySelector('#autoCenter' + axis);
                if(autoCenterCheck){ settings.axes[axis].autoCenter = autoCenterCheck.checked; }
                var centerInput = document.querySelector('#center' + axis);
                if(centerInput && autoCenterCheck && !autoCenterCheck.checked){
                    settings.axes[axis].center = parseInt(centerInput.value);
                }
                // Persist the axis range so it survives refreshes.
                if(AXIS[axis] && AXIS[axis].limits != null){
                    settings.axes[axis].limits = [AXIS[axis].limits[0], AXIS[axis].limits[1]];
                }
            }
            continue;
        }
        var input = document.querySelector('#' + setting);
        if(input){
            if(input.type == "checkbox"){
                if(input.checked){ settings[setting] = true; }else{ settings[setting] = false; }
            }else if(input.type == "text" || input.type == "range"){
                settings[setting] = input.value;
            }
        }
    }
    if(saveToDevice){
        for(const axis of listAxes()){
            var min = document.querySelector('#min' + axis);
            var max = document.querySelector('#max' + axis);
            if(min && max){ setLimits(min.value, max.value, axis); }
        }
    }
    GM_setValue("settings", settings);
    publishDebugApi();
}

function loadSettings(){
    var thisVersion = GM_info.script.version;
    var axisDefaults = function(enabled){ return {enabled: enabled, invert: false, center: null, autoCenter: true}; };
    var defaultSettings = {"debug": false, "sync": 0, "autoConnect": true, "serialPort": null,
                           "showNotifications": true, "centerTime": 1000, "homeEnabled": true,
                           "axes": { L0: axisDefaults(true), L1: axisDefaults(false), L2: axisDefaults(false),
                                     R0: axisDefaults(false), R1: axisDefaults(false), R2: axisDefaults(false) },
                           "currentVersion": thisVersion};
    settings = GM_getValue("settings", defaultSettings);
    handleUpgrade(thisVersion);
    backfillDefaults(settings, defaultSettings);
    // Drop settings for features that no longer exist (hotkeys, random motion).
    for(const gone of ["device", "initialKey", "minKey", "settingsKey", "syncKey"]){ delete settings[gone]; }
    for(const ax in settings.axes){ delete settings.axes[ax].random; }
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

// --- TOAST NOTIFICATION SYSTEM ---
var toastContainer = null;
var toastQueue = [];
var toastActive = false;

function initToastContainer() {
    if (toastContainer) return;
    toastContainer = document.createElement('div');
    toastContainer.id = 'tcode-toast-container';
    toastContainer.style.cssText = `
        position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
        z-index: 999999; display: flex; flex-direction: column-reverse; gap: 8px;
        pointer-events: none; max-width: 90%; width: 400px;
    `;
    document.body.appendChild(toastContainer);

    // Add toast styles
    var toastStyles = document.createElement('style');
    toastStyles.id = 'tcode-toast-styles';
    toastStyles.textContent = `
        .tcode-toast {
            background: linear-gradient(135deg, rgba(26, 26, 46, 0.95) 0%, rgba(22, 33, 62, 0.95) 100%);
            border: 1px solid rgba(255, 255, 255, 0.1);
            border-radius: 12px;
            padding: 14px 20px;
            color: #fff;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            font-size: 14px;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4);
            backdrop-filter: blur(10px);
            -webkit-backdrop-filter: blur(10px);
            display: flex;
            align-items: center;
            gap: 12px;
            animation: toastSlideIn 0.3s ease-out;
            pointer-events: auto;
        }
        .tcode-toast.toast-success { border-left: 4px solid #4ade80; }
        .tcode-toast.toast-info { border-left: 4px solid #60a5fa; }
        .tcode-toast.toast-warning { border-left: 4px solid #fbbf24; }
        .tcode-toast.toast-error { border-left: 4px solid #f87171; }
        .tcode-toast .toast-icon {
            font-size: 1.4em;
            flex-shrink: 0;
        }
        .tcode-toast .toast-content {
            flex: 1;
        }
        .tcode-toast .toast-title {
            font-weight: 600;
            margin-bottom: 2px;
        }
        .tcode-toast .toast-message {
            opacity: 0.8;
            font-size: 0.9em;
        }
        .tcode-toast.toast-exit {
            animation: toastSlideOut 0.3s ease-in forwards;
        }
        @keyframes toastSlideIn {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }
        @keyframes toastSlideOut {
            from { opacity: 1; transform: translateY(0); }
            to { opacity: 0; transform: translateY(-20px); }
        }
    `;
    document.head.appendChild(toastStyles);
}

function showToast(title, message, type = 'info', duration = 4000) {
    if (!settings.showNotifications) return;

    initToastContainer();

    var icons = {
        success: '✅',
        info: 'ℹ️',
        warning: '⚠️',
        error: '❌'
    };

    var toast = document.createElement('div');
    toast.className = 'tcode-toast toast-' + type;
    toast.innerHTML = `
        <span class="toast-icon">${icons[type] || icons.info}</span>
        <div class="toast-content">
            <div class="toast-title">${title}</div>
            ${message ? '<div class="toast-message">' + message + '</div>' : ''}
        </div>
    `;

    toastContainer.appendChild(toast);

    // Auto-remove after duration
    setTimeout(() => {
        toast.classList.add('toast-exit');
        setTimeout(() => {
            if (toast.parentNode) toast.remove();
        }, 300);
    }, duration);
}
// ---------------------------------

function settingsAddCheckBox(parent, id, label){
    var line = document.createElement("div");
    line.className = "checkbox-line";
    var box = document.createElement("input");
    box.setAttribute("id", id);
    box.setAttribute("type", "checkbox");
    var boxLabel = document.createElement("label");
    boxLabel.setAttribute("for", id);
    boxLabel.textContent = label;
    line.appendChild(box);
    line.appendChild(boxLabel);
    parent.appendChild(line);
}

function settingsAddInput(parent, id, label){
    var input = document.createElement("input");
    input.setAttribute("id", id);
    input.style.marginLeft = "3px";
    var inputLabel = document.createElement("label");
    inputLabel.setAttribute("for", id);
    inputLabel.innerHTML = " " + label;
    parent.appendChild(inputLabel);
    parent.appendChild(input);
}

function settingsAddDualSlider(parent, minId, maxId, label, minVal, maxVal, minLimit, maxLimit) {
    minVal = parseFloat(minVal); maxVal = parseFloat(maxVal); minLimit = parseFloat(minLimit); maxLimit = parseFloat(maxLimit);
    if (isNaN(minVal)) minVal = 0; if (isNaN(maxVal)) maxVal = 100; if (isNaN(minLimit)) minLimit = 0; if (isNaN(maxLimit)) maxLimit = 100;

    var wrapper = document.createElement("div"); wrapper.className = "dual-slider-container";
    var labelElem = document.createElement("label"); labelElem.innerHTML = label; wrapper.appendChild(labelElem);

    // Slider wrapper for positioning
    var sliderArea = document.createElement("div");
    sliderArea.className = "slider-area";
    sliderArea.style.cssText = "position: relative; height: 24px; width: 100%;";

    var track = document.createElement("div"); track.className = "slider-track"; sliderArea.appendChild(track);
    var fill = document.createElement("div"); fill.className = "slider-fill"; fill.id = minId + "Fill"; sliderArea.appendChild(fill);

    var minSlider = document.createElement("input");
    minSlider.type = "range"; minSlider.id = minId;
    minSlider.min = minLimit; minSlider.max = maxLimit; minSlider.value = minVal; minSlider.step = "1";
    minSlider.style.cssText = "position: absolute; left: 0; top: 50%; transform: translateY(-50%); width: 100%;";
    sliderArea.appendChild(minSlider);

    var maxSlider = document.createElement("input");
    maxSlider.type = "range"; maxSlider.id = maxId;
    maxSlider.min = minLimit; maxSlider.max = maxLimit; maxSlider.value = maxVal; maxSlider.step = "1";
    maxSlider.style.cssText = "position: absolute; left: 0; top: 50%; transform: translateY(-50%); width: 100%;";
    sliderArea.appendChild(maxSlider);

    wrapper.appendChild(sliderArea);

    var valuesDiv = document.createElement("div"); valuesDiv.className = "dual-slider-values";
    var minSpan = document.createElement("span"); minSpan.id = minId + "Value"; minSpan.innerHTML = minVal; valuesDiv.appendChild(minSpan);
    var maxSpan = document.createElement("span"); maxSpan.id = maxId + "Value"; maxSpan.innerHTML = maxVal; valuesDiv.appendChild(maxSpan);
    wrapper.appendChild(valuesDiv);
    parent.appendChild(wrapper);
}

function settingsAddSingleSlider(parent, id, label, value, minLimit, maxLimit, suffix="ms") {
    value = parseFloat(value); minLimit = parseFloat(minLimit); maxLimit = parseFloat(maxLimit);
    if (isNaN(value)) value = minLimit;

    var wrapper = document.createElement("div"); wrapper.className = "single-slider-container";
    var labelElem = document.createElement("label"); labelElem.innerHTML = label; wrapper.appendChild(labelElem);
    var sliderWrapper = document.createElement("div"); sliderWrapper.className = "slider-wrapper"; wrapper.appendChild(sliderWrapper);
    var track = document.createElement("div"); track.className = "slider-track"; sliderWrapper.appendChild(track);
    var fill = document.createElement("div"); fill.className = "slider-fill"; fill.id = id + "Fill"; sliderWrapper.appendChild(fill);

    var slider = document.createElement("input"); slider.type = "range"; slider.id = id; slider.min = minLimit; slider.max = maxLimit; slider.value = value; slider.step = "1";
    if(isChrome){ slider.style = "margin-top: -4px; transform: translateY(-50%)"; }
    sliderWrapper.appendChild(slider);

    var valueSpan = document.createElement("span"); valueSpan.id = id + "Value"; valueSpan.className = "single-slider-value"; valueSpan.innerHTML = String(value + suffix).padStart(6, ' ');
    wrapper.appendChild(valueSpan);
    parent.appendChild(wrapper);

    slider.addEventListener('input', () => {
        const currentVal = parseFloat(slider.value);
        const range = maxLimit - minLimit;
        const percent = ((currentVal - minLimit) / range) * 100;
        fill.style.width = `${percent}%`;
        valueSpan.textContent = String(currentVal + suffix).padStart(6, ' ');
    });
    const initialRange = maxLimit - minLimit;
    const initialPercent = ((value - minLimit) / initialRange) * 100;
    fill.style.width = `${initialPercent}%`;
}

function settingsAddGroupedControls(parent, checkboxId, axis, minId, maxId, sliderLabel, minVal, maxVal, minLimit, maxLimit, allSliderIds) {
    const groupContainer = document.createElement('div'); groupContainer.classList.add('control-group'); parent.appendChild(groupContainer);
    // Two stacked rows: the group used to be one flex line and overflowed horizontally
    // once the home controls were added.
    const rowTop = document.createElement('div'); rowTop.classList.add('control-row'); groupContainer.appendChild(rowTop);
    const rowBottom = document.createElement('div'); rowBottom.classList.add('control-row', 'control-row-secondary'); groupContainer.appendChild(rowBottom);
    const checkboxWrapper = document.createElement('div'); checkboxWrapper.classList.add('checkbox-wrapper');
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.id = checkboxId; checkbox.checked = false;
    checkboxWrapper.appendChild(checkbox);
    const label = document.createElement('label'); label.setAttribute('for', checkboxId); label.textContent = axis;
    checkboxWrapper.appendChild(label); rowTop.appendChild(checkboxWrapper);

    const invertWrapper = document.createElement('div'); invertWrapper.classList.add('invert-wrapper');
    const invertCheckbox = document.createElement('input'); invertCheckbox.type = 'checkbox'; invertCheckbox.id = `invert${axis}`;
    invertWrapper.appendChild(invertCheckbox);
    const invertLabel = document.createElement('label'); invertLabel.setAttribute('for', `invert${axis}`); invertLabel.textContent = 'Invert';
    invertWrapper.appendChild(invertLabel);
    rowTop.appendChild(invertWrapper);

    settingsAddDualSlider(rowTop, minId, maxId, sliderLabel, minVal, maxVal, minLimit, maxLimit);
    const dualSliderContainer = groupContainer.querySelector('.dual-slider-container');

    // --- Center controls ---
    const cfg = settings.axes[axis] || {};
    const centerWrapper = document.createElement('div'); centerWrapper.classList.add('center-wrapper');
    const autoCenterCb = document.createElement('input'); autoCenterCb.type = 'checkbox'; autoCenterCb.id = `autoCenter${axis}`;
    autoCenterCb.checked = (cfg.autoCenter !== false);
    centerWrapper.appendChild(autoCenterCb);
    const autoCenterLabel = document.createElement('label'); autoCenterLabel.setAttribute('for', `autoCenter${axis}`); autoCenterLabel.textContent = 'Auto home';
    centerWrapper.appendChild(autoCenterLabel);
    rowBottom.appendChild(centerWrapper);
    toolTip(autoCenterCb, "Rest this axis at the middle of its range. Uncheck to pick the resting position yourself.");

    var startCenter = (cfg.autoCenter === false && cfg.center != null && cfg.center !== "")
        ? parseInt(cfg.center)
        : Math.round(parseFloat(minVal) + ((parseFloat(maxVal) - parseFloat(minVal)) / 2));
    settingsAddSingleSlider(rowBottom, `center${axis}`, "Home:", startCenter, minLimit, maxLimit, "");
    const centerSlider = groupContainer.querySelector(`#center${axis}`);
    if(centerSlider){ toolTip(centerSlider, "Where this axis sits when idle \u2014 on connect, on scene change, and via Home Now."); }
    const centerContainer = centerSlider ? centerSlider.closest('.single-slider-container') : null;

    function refreshCenterState(){
        var auto = autoCenterCb.checked;
        if(centerSlider){ centerSlider.disabled = auto; }
        if(centerContainer){ centerContainer.style.opacity = auto ? '0.5' : '1'; }
        if(auto && centerSlider){
            // Track the live midpoint so the readout stays truthful as the range moves.
            var lo = parseFloat(document.querySelector('#' + minId)?.value ?? minVal);
            var hi = parseFloat(document.querySelector('#' + maxId)?.value ?? maxVal);
            var mid = Math.round(lo + ((hi - lo) / 2));
            centerSlider.value = mid;
            centerSlider.dispatchEvent(new Event('input'));
        }
    }
    autoCenterCb.addEventListener('change', () => {
        settings.axes[axis].autoCenter = autoCenterCb.checked;
        if(!autoCenterCb.checked && centerSlider){ settings.axes[axis].center = parseInt(centerSlider.value); }
        refreshCenterState();
        if(serialConnected){ centerAxis(axis); }
    });
    if(centerSlider){
        centerSlider.addEventListener('input', () => {
            if(autoCenterCb.checked){ return; }
            settings.axes[axis].center = parseInt(centerSlider.value);
        });
        // Preview on release rather than on every input event, so dragging doesn't
        // flood the serial writer.
        centerSlider.addEventListener('change', () => {
            if(!autoCenterCb.checked && serialConnected){ centerAxis(axis); }
        });
    }
    groupContainer._refreshCenterState = refreshCenterState;
    refreshCenterState();

    checkbox.addEventListener('change', (event) => {
        settings.axes[axis].enabled = event.target.checked;
        if (event.target.checked) {
            dualSliderContainer.classList.remove('disabled');
            invertWrapper.style.opacity = '1';
            rowBottom.classList.remove('disabled');
        } else {
            dualSliderContainer.classList.add('disabled');
            invertWrapper.style.opacity = '0.5';
            rowBottom.classList.add('disabled');
        }
    });
    invertCheckbox.addEventListener('change', (event) => { settings.axes[axis].invert = event.target.checked; });
    if (!checkbox.checked) {
        dualSliderContainer.classList.add('disabled');
        invertWrapper.style.opacity = '0.5';
        rowBottom.classList.add('disabled');
    }
}

function dualSliderListeners(minId, maxId) {
    const minSlider = document.getElementById(minId); const maxSlider = document.getElementById(maxId);
    const fill = document.getElementById(minId + "Fill"); const minValueDisplay = document.getElementById(minId + "Value"); const maxValueDisplay = document.getElementById(maxId + "Value");
    if (!minSlider || !maxSlider || !minValueDisplay || !maxValueDisplay || !fill) return;

    function updateDualSlider() {
        let currentMinVal = parseFloat(minSlider.value); let currentMaxVal = parseFloat(maxSlider.value);
        if (currentMinVal > currentMaxVal) { minSlider.value = currentMaxVal; }
        if (currentMaxVal < currentMinVal) { maxSlider.value = currentMinVal; }
        currentMinVal = parseFloat(minSlider.value); currentMaxVal = parseFloat(maxSlider.value);
        const range = parseFloat(maxSlider.max) - parseFloat(minSlider.min);
        const minPercent = ((currentMinVal - parseFloat(minSlider.min)) / range) * 100;
        const maxPercent = ((currentMaxVal - parseFloat(minSlider.min)) / range) * 100;
        fill.style.left = `${minPercent}%`; fill.style.width = `${Math.abs(maxPercent - minPercent)}%`;
        minValueDisplay.textContent = currentMinVal; maxValueDisplay.textContent = currentMaxVal;
        setLimits(currentMinVal, currentMaxVal, minSlider.id.replace('min', ''), false);
        // Auto-center follows the range, so refresh its readout when the handles move.
        const group = minSlider.closest('.control-group');
        if(group && typeof group._refreshCenterState === 'function'){ group._refreshCenterState(); }
    }
    minSlider.addEventListener('input', updateDualSlider); maxSlider.addEventListener('input', updateDualSlider);
    updateDualSlider();
}

let activeTab = 'device';
function settingsAddTabContent(parentDiv, type, id, label, key = "") {
    switch (type) {
        case 'checkbox': settingsAddCheckBox(parentDiv, id, label); break;
        case 'input': settingsAddInput(parentDiv, id, label); break;
    }
}

function showTab(tabId) {
    const tabContents = document.querySelectorAll('.tcode-tab-content'); tabContents.forEach(content => { content.style.display = 'none'; });
    const tabButtons = document.querySelectorAll('.tcode-tab-button'); tabButtons.forEach(button => { button.classList.remove('active-tab'); });
    const selectedTabContent = document.getElementById(tabId + 'Content'); if (selectedTabContent) { selectedTabContent.style.display = 'block'; }
    const selectedTabButton = document.getElementById(tabId + 'Tab'); if (selectedTabButton) { selectedTabButton.classList.add('active-tab'); }
    activeTab = tabId;
}

function toolTip(element, txt){
    var tooltip = document.querySelector('#dynamic-tooltip');
    if(!tooltip){
        tooltip = document.createElement('div'); tooltip.id = 'dynamic-tooltip';
        tooltip.style.position = 'absolute'; tooltip.style.backgroundColor = 'black'; tooltip.style.color = 'white';
        tooltip.style.padding = '5px'; tooltip.style.zIndex = '200000'; tooltip.style.visibility = 'hidden';
        document.body.appendChild(tooltip);
    }
    var tooltipTimeout = null;
    element.addEventListener('mouseover', () => { tooltipTimeout = setTimeout(function(){ tooltip.textContent = txt; tooltip.style.visibility = 'visible'; }, 750); });
    element.addEventListener('mousemove', (e) => { tooltip.style.left = e.pageX + 10 + 'px'; tooltip.style.top = e.pageY + 10 + 'px'; });
    element.addEventListener('mouseout', () => { clearTimeout(tooltipTimeout); tooltip.style.visibility = 'hidden'; });
}

// --- NAVBAR BUTTON (appended to the very end of the Donate/Stats/Settings/Help cluster) ---

// Persistent styles for the status dot. Added once; unlike the settings stylesheet
// this must NOT be torn down when the menu closes.
function injectNavStyles(){
    if(document.getElementById('tcode-nav-styles')){ return; }
    var s = document.createElement('style');
    s.id = 'tcode-nav-styles';
    s.textContent = `
        #tcode-nav-btn { display: flex; align-items: center; }
        #tcode-nav-btn .tcode-nav-dot {
            display: inline-block; width: 8px; height: 8px; border-radius: 50%;
            margin-right: 6px; flex-shrink: 0;
            background: #f87171; box-shadow: 0 0 4px rgba(248,113,113,0.9);
            transition: background 0.2s ease, box-shadow 0.2s ease;
        }
        #tcode-nav-btn.connected .tcode-nav-dot {
            background: #4ade80; box-shadow: 0 0 4px rgba(74,222,128,0.9);
        }
    `;
    document.head.appendChild(s);
}

// Reflect current serial status on the nav button (dot colour + label + tooltip).
function updateNavButton(){
    var btn = document.getElementById('tcode-nav-btn');
    if(!btn){ return; }
    var labelText = btn.querySelector('.tcode-nav-label-text');
    if(serialConnected){
        btn.classList.add('connected');
        btn.title = "TCode: Connected — click for settings";
        if(labelText){ labelText.textContent = "Connected"; }
    }else{
        btn.classList.remove('connected');
        btn.title = "TCode: Not connected — click for settings";
        if(labelText){ labelText.textContent = "Connect"; }
    }
}

// Append the button as the very last child of the Donate/Stats/Settings/Help cluster
// (.navbar-buttons — distinct from the primary Scenes/Images/.../Tags nav-link list,
// which is also, confusingly, classed .navbar-nav). No-op if already present, so the
// keep-alive interval can call it freely.
function injectNavButton(){
    if(document.getElementById('tcode-nav-btn')){ return; }
    var navButtons = document.querySelector('.navbar-buttons');
    if(!navButtons){ return; } // navbar not rendered yet; the keep-alive will retry
    injectNavStyles();

    var btn = document.createElement('button');
    btn.id = 'tcode-nav-btn';
    btn.type = 'button';
    // Match the Stats/Settings button classes (flex + vertically centered) plus Stash's
    // own nav-utility styling, so it sits flush with its neighbors.
    btn.className = 'nav-utility minimal d-flex align-items-center h-100 btn btn-primary';
    btn.innerHTML = '<span class="tcode-nav-dot"></span>' +
        '<span class="d-none d-sm-inline tcode-nav-label-text">Connect</span>';
    btn.addEventListener('click', function(){ toggleMenu(); });

    navButtons.appendChild(btn); // very end of the cluster
    updateNavButton();
}

// Stash is a React SPA and re-renders the navbar on navigation, which can drop our button.
// Re-inject on an interval (cheap; injectNavButton no-ops when the button is already there).
function startNavButton(){
    injectNavButton();
    setInterval(injectNavButton, 1000);
}

// ----------------------------------------------------------------

// Tear down the settings menu. Removes the full-screen overlay UNCONDITIONALLY, even if
// saveSettings throws — otherwise a save error would leave the invisible overlay on top of
// the page, swallowing every click (this was the "scene tabs stop responding" bug).
function closeSettings(){
    try { saveSettings(); } catch(e){ debug("[TCode] saveSettings error on close: " + e); }
    var overlayEl = document.getElementById("settings-overlay");
    if(overlayEl){ overlayEl.remove(); }
    var styleEl = document.getElementById("stash-tcode-styles");
    if(styleEl){ styleEl.remove(); }
}

function toggleMenu() {
    if (document.getElementById("settings-overlay") != null) {
        document.getElementById("settings-close-btn").click();
        return -1;
    }

    // Modern dark theme stylesheet
    const styleSheet = document.createElement("style");
    styleSheet.id = "stash-tcode-styles";
    styleSheet.type = "text/css";
    styleSheet.innerText = `
/* Overlay backdrop with blur */
#settings-overlay {
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0, 0, 0, 0.6); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
    z-index: 999998; display: flex; align-items: center; justify-content: center;
}

/* Main settings panel */
#settings {
    position: relative; width: 90%; max-width: 700px; max-height: 85vh;
    background: linear-gradient(145deg, #1a1a2e 0%, #16213e 100%);
    border-radius: 16px; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5), 0 0 0 1px rgba(255, 255, 255, 0.1);
    overflow: hidden; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}

/* Header */
#settings .settings-header {
    background: linear-gradient(90deg, #0f3460 0%, #533483 100%);
    padding: 20px 24px; display: flex; align-items: center; justify-content: space-between;
}
#settings .settings-title {
    font-size: 1.5em; font-weight: 700; color: #fff; letter-spacing: 0.5px;
    text-shadow: 0 2px 4px rgba(0,0,0,0.3);
}
#settings-close-btn {
    width: 36px; height: 36px; border-radius: 50%; border: none;
    background: rgba(255,255,255,0.1); color: #fff; font-size: 1.4em;
    cursor: pointer; transition: all 0.2s ease; display: flex; align-items: center; justify-content: center;
}
#settings-close-btn:hover { background: rgba(255,255,255,0.2); transform: scale(1.1); }

/* Tab navigation */
#tabContainer {
    display: flex; background: rgba(0,0,0,0.3); padding: 0 16px; gap: 4px;
}
.tcode-tab-button {
    padding: 14px 20px; border: none; background: transparent; color: rgba(255,255,255,0.6);
    font-size: 0.95em; font-weight: 500; cursor: pointer; transition: all 0.2s ease;
    border-bottom: 3px solid transparent; text-transform: uppercase; letter-spacing: 0.5px;
}
.tcode-tab-button:hover { color: rgba(255,255,255,0.9); background: rgba(255,255,255,0.05); }
.tcode-tab-button.active-tab {
    color: #e94560 !important; border-bottom-color: #e94560 !important;
    background: rgba(233, 69, 96, 0.1) !important;
}

/* Tab content area */
#tabContentContainer {
    padding: 24px; max-height: calc(85vh - 140px); overflow-y: auto; color: #e0e0e0;
}
#tabContentContainer::-webkit-scrollbar { width: 8px; }
#tabContentContainer::-webkit-scrollbar-track { background: rgba(255,255,255,0.05); border-radius: 4px; }
#tabContentContainer::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 4px; }
#tabContentContainer::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.3); }
.tcode-tab-content { display: none; animation: fadeIn 0.3s ease; }
@keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

/* Control groups */
.control-group {
    display: flex; flex-direction: column; align-items: stretch; gap: 10px; padding: 16px 20px; margin-bottom: 12px;
    background: rgba(255,255,255,0.05); border: 1px solid rgba(255,255,255,0.1);
    border-radius: 12px; transition: all 0.2s ease;
}
.control-group:hover { background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.15); }
.control-row { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; width: 100%; min-width: 0; }
.control-row > .dual-slider-container, .control-row > .single-slider-container { flex: 1 1 240px; min-width: 200px; }
.control-row-secondary { padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.08); }
.control-row.disabled { pointer-events: none; opacity: 0.4; }
.checkbox-line { display: flex; align-items: center; gap: 10px; padding: 6px 0; }
.checkbox-line label { color: rgba(255,255,255,0.85); font-size: 0.95em; cursor: pointer; line-height: 1.3; }
.checkbox-line input[type="checkbox"] { flex: 0 0 auto; margin: 0; }
.center-wrapper { display: flex; align-items: center; gap: 8px; white-space: nowrap; }
.center-wrapper label { color: rgba(255,255,255,0.7); font-size: 0.9em; }
.checkbox-wrapper { display: flex; align-items: center; gap: 8px; min-width: 50px; }
.checkbox-wrapper label { color: #fff; font-weight: 600; font-size: 1.1em; }
.random-wrapper { display: flex; align-items: center; gap: 8px; }
.random-wrapper label { color: rgba(255,255,255,0.7); font-size: 0.9em; }
.invert-wrapper { display: flex; align-items: center; gap: 8px; }
.invert-wrapper label { color: rgba(255,255,255,0.7); font-size: 0.9em; }

/* Custom checkboxes */
.control-group input[type="checkbox"], #tabContentContainer input[type="checkbox"] {
    width: 20px; height: 20px; accent-color: #e94560; cursor: pointer;
}

/* Dropdowns */
.control-group select, #tabContentContainer select {
    background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2);
    color: #fff; padding: 6px 10px; border-radius: 6px; cursor: pointer;
}
.control-group select option, #tabContentContainer select option {
    background: #1a1a2e; color: #fff;
}
.control-group select:focus, #tabContentContainer select:focus { outline: none; border-color: #e94560; }

/* Dual slider container */
.dual-slider-container {
    flex: 1; min-width: 200px; margin: 0; padding: 5px 0;
}
.dual-slider-container.disabled { pointer-events: none; opacity: 0.4; }
.dual-slider-container > label { display: block; margin-bottom: 8px; color: rgba(255,255,255,0.7); font-size: 0.9em; }
.dual-slider-container .slider-area {
    position: relative; height: 24px; width: 100%;
}
.dual-slider-container .slider-track {
    position: absolute; left: 0; right: 0; top: 50%; transform: translateY(-50%);
    height: 6px; border-radius: 3px; background: rgba(255,255,255,0.15); z-index: 0;
}
.dual-slider-container .slider-fill {
    position: absolute; top: 50%; transform: translateY(-50%);
    height: 6px; border-radius: 3px; background: linear-gradient(90deg, #e94560, #533483);
    z-index: 1; left: 0; width: 100%;
}
.dual-slider-container input[type="range"] {
    -webkit-appearance: none; appearance: none; width: 100%; outline: none;
    background: transparent; pointer-events: none; z-index: 3; margin: 0; height: 24px;
}
.dual-slider-container input[type="range"]::-webkit-slider-runnable-track {
    height: 6px; background: transparent;
}
.dual-slider-container input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none; appearance: none; height: 18px; width: 18px;
    background: #fff; cursor: pointer; pointer-events: auto; border-radius: 50%;
    box-shadow: 0 2px 6px rgba(0,0,0,0.3), 0 0 0 2px rgba(233, 69, 96, 0.3);
    transition: transform 0.15s ease, box-shadow 0.15s ease;
    margin-top: -6px;
}
.dual-slider-container input[type="range"]::-webkit-slider-thumb:hover {
    transform: scale(1.15);
    box-shadow: 0 2px 8px rgba(0,0,0,0.4), 0 0 0 3px rgba(233, 69, 96, 0.4);
}
.dual-slider-container input[type="range"]:hover { z-index: 10; }
.dual-slider-container input[type="range"]:active { z-index: 11; }
.dual-slider-values {
    display: flex; justify-content: space-between; margin-top: 8px;
    font-size: 0.85em; color: rgba(255,255,255,0.7); font-weight: 500;
}
.dual-slider-values span {
    min-width: 40px; text-align: center;
}

/* Single slider */
.single-slider-container {
    display: flex; align-items: center; gap: 16px; width: 100%;
    padding: 16px 20px; background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,255,255,0.1); border-radius: 12px; margin-bottom: 12px;
}
.single-slider-container label { color: #fff; font-weight: 500; min-width: 60px; }
.single-slider-container .slider-wrapper {
    position: relative; flex-grow: 1; display: flex; align-items: center; height: 24px;
}
.single-slider-container .slider-track, .single-slider-container .slider-fill {
    position: absolute; height: 6px; border-radius: 3px; left: 0; top: 50%; transform: translateY(-50%); width: 100%;
}
.single-slider-container .slider-track { background: rgba(255,255,255,0.15); }
.single-slider-container .slider-fill { background: linear-gradient(90deg, #e94560, #533483); }
.single-slider-container input[type="range"] {
    -webkit-appearance: none; appearance: none; background: transparent; cursor: pointer;
    width: 100%; position: absolute; left: 0; top: 50%; transform: translateY(-50%); z-index: 2;
}
.single-slider-container input[type="range"]::-webkit-slider-thumb {
    -webkit-appearance: none; height: 20px; width: 20px; background: #fff;
    border-radius: 50%; box-shadow: 0 2px 6px rgba(0,0,0,0.3); cursor: pointer;
}
.single-slider-container input[type="range"]::-webkit-slider-runnable-track { background: transparent; }
.single-slider-value {
    flex-shrink: 0; min-width: 60px; text-align: right; color: rgba(255,255,255,0.8);
    font-family: 'SF Mono', Monaco, monospace; font-size: 0.9em;
}

/* Buttons */
#tabContentContainer button {
    padding: 12px 24px; border: none; border-radius: 8px; font-size: 0.95em;
    font-weight: 600; cursor: pointer; transition: all 0.2s ease; margin: 8px 8px 8px 0;
}
#btnConnectUSB {
    background: linear-gradient(135deg, #e94560 0%, #533483 100%) !important;
    color: #fff !important; box-shadow: 0 4px 15px rgba(233, 69, 96, 0.3);
}
#btnConnectUSB:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(233, 69, 96, 0.4); }
#btnConnectUSB:disabled { opacity: 0.6; cursor: not-allowed; }
#initialKey, #minKey, #settingsKey {
    background: rgba(255,255,255,0.1) !important; color: #fff !important;
    border: 1px solid rgba(255,255,255,0.2) !important;
}
#initialKey:hover, #minKey:hover, #settingsKey:hover {
    background: rgba(255,255,255,0.15) !important; border-color: #e94560 !important;
}

/* Labels in tab content */
#tabContentContainer > label { color: rgba(255,255,255,0.8); display: flex; align-items: center; gap: 8px; margin: 12px 0; }
`;
    document.head.appendChild(styleSheet);

    // Create overlay backdrop
    var overlay = document.createElement("div");
    overlay.setAttribute("id", "settings-overlay");

    // Main settings panel
    var div = document.createElement("div");
    div.setAttribute("id", "settings");

    // Header
    var header = document.createElement("div");
    header.className = "settings-header";
    var title = document.createElement("span");
    title.className = "settings-title";
    title.innerHTML = "⚙️ TCode Settings";
    var closeBtn = document.createElement("button");
    closeBtn.id = "settings-close-btn";
    closeBtn.innerHTML = "✕";
    header.appendChild(title);
    header.appendChild(closeBtn);
    div.appendChild(header);

    // Tab container
    var tabContainer = document.createElement("div");
    tabContainer.id = "tabContainer";
    div.appendChild(tabContainer);

    // Tab content container
    var tabContentContainer = document.createElement("div");
    tabContentContainer.id = "tabContentContainer";
    div.appendChild(tabContentContainer);

    // Create tabs
    const tabs = ['device', 'axes', 'advanced'];
    const tabContents = {};
    const tabIcons = { device: '🔌', axes: '🎚️', advanced: '🔧' };
    tabs.forEach(t => {
        const btn = document.createElement('button');
        btn.id = t + 'Tab';
        btn.className = 'tcode-tab-button';
        btn.innerHTML = tabIcons[t] + ' ' + t.charAt(0).toUpperCase() + t.slice(1);
        btn.addEventListener('click', () => showTab(t));
        tabContainer.appendChild(btn);
        const content = document.createElement('div');
        content.id = t + 'Content';
        content.className = 'tcode-tab-content';
        content.style.display = 'none';
        tabContentContainer.appendChild(content);
        tabContents[t] = content;
    });

    // Device tab content
    const deviceContentDiv = tabContents['device'];
    const usbBtn = document.createElement('button');
    usbBtn.id = "btnConnectUSB";
    usbBtn.innerText = serialConnected ? "✓ USB Connected" : "🔗 Connect Serial (USB)";
    usbBtn.onclick = function() { connectSerial(); };
    if (serialConnected) usbBtn.disabled = true;
    deviceContentDiv.appendChild(usbBtn);
    settingsAddTabContent(deviceContentDiv, "checkbox", "autoConnect", "Reconnect automatically (page load and re-plug)");
    deviceContentDiv.appendChild(document.createElement("br"));
    settingsAddSingleSlider(deviceContentDiv, "sync", "Sync:", settings.sync, -250, 250);
    settingsAddTabContent(deviceContentDiv, "checkbox", "homeEnabled", "Home axes on connect & scene change");
    const homeEnabledCb = document.getElementById("homeEnabled");
    if(homeEnabledCb){ toolTip(homeEnabledCb, "Off leaves the device wherever it stopped. The Home Now button still works either way."); }
    settingsAddSingleSlider(deviceContentDiv, "centerTime", "Home time:", settings.centerTime, 100, 5000);
    const centerTimeSlider = document.getElementById("centerTime");
    if(centerTimeSlider){ toolTip(centerTimeSlider, "How long the device takes to travel to its home position. Higher is slower and gentler."); }
    deviceContentDiv.appendChild(document.createElement("br"));
    const centerNowBtn = document.createElement("button");
    centerNowBtn.id = "btnCenterNow"; centerNowBtn.innerText = "Home Now";
    centerNowBtn.addEventListener("click", function(){ saveSettings(false); centerAll(); }, false);
    deviceContentDiv.appendChild(centerNowBtn);
    toolTip(centerNowBtn, "Move every enabled axis to its home position now.");

    // Axes tab content
    const axesContentDiv = tabContents['axes'];
    ["L0","L1","L2","R0","R1","R2"].forEach(ax => {
        settingsAddGroupedControls(axesContentDiv, "enable"+ax, ax, "min"+ax, "max"+ax, "Range:", getLimit(ax,LOWER), getLimit(ax,UPPER), 0, 9999, listAxes(ax));
    });

    // Advanced tab content
    const advancedContentDiv = tabContents['advanced'];
    settingsAddTabContent(advancedContentDiv, "checkbox", "showNotifications", "Show Script Load Notifications");
    settingsAddTabContent(advancedContentDiv, "checkbox", "debug", "Enable Debug Mode");

    // Append panel to overlay, then overlay to body
    overlay.appendChild(div);
    document.body.appendChild(overlay);

    showTab(activeTab);
    settingsMenuApplySaved();

    // Close button handler
    closeBtn.addEventListener("click", function(){ closeSettings(); }, false);

    // Click on backdrop to close
    overlay.addEventListener("click", function(e){
        if (e.target === overlay) closeBtn.click();
    }, false);

    document.getElementById("settings").addEventListener("change", function(){ saveSettings(false); }, false);
    // Set each slider to the saved/live range before wiring listeners.
    // (settingsMenuApplySaved restores checkboxes/dropdowns but never the range sliders,
    //  so without this the handles show 0-9999 even when a range is stored.)
    ["L0","L1","L2","R0","R1","R2"].forEach(ax => {
        var lim = (AXIS[ax] && AXIS[ax].limits) ? AXIS[ax].limits
                : (settings.axes[ax] && settings.axes[ax].limits) ? settings.axes[ax].limits
                : [0, 9999];
        var minEl = document.querySelector('#min'+ax);
        var maxEl = document.querySelector('#max'+ax);
        if(minEl){ minEl.value = lim[0]; }
        if(maxEl){ maxEl.value = lim[1]; }
    });
    // dualSliderListeners runs updateDualSlider() immediately, redrawing the fill bar
    // and the min/max value labels to match the values just set above.
    ["L0","L1","L2","R0","R1","R2"].forEach(ax => dualSliderListeners("min"+ax, "max"+ax));
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
    // Remember which device this was so it can be reopened without the picker next time.
    try {
        var info = port.getInfo();
        settings.serialPort = { usbVendorId: info.usbVendorId ?? null, usbProductId: info.usbProductId ?? null };
        GM_setValue("settings", settings);
    } catch (e) { debug("[TCode] getInfo failed: " + e); }
    var usbBtn = document.getElementById("btnConnectUSB");
    if (usbBtn) {
        usbBtn.innerText = "USB Connected";
        usbBtn.disabled = true;
    }
    debug("USB Serial Connected");
    createOverlay("USB Connected");
    showToast(silent ? "USB Reconnected" : "USB Connected", "Serial connection established at 115200 baud", "success");
    updateNavButton(); // reflect connected state on the navbar
    readSerialLoop();
    return true;
}

// The previously used port among those this site already has permission for: an exact
// USB vendor/product match, or the only granted port if nothing was saved yet.
function pickSavedPort(ports) {
    var saved = settings.serialPort;
    if (saved && saved.usbVendorId != null) {
        var match = ports.find(function(p) {
            var i = p.getInfo();
            return i.usbVendorId === saved.usbVendorId && i.usbProductId === saved.usbProductId;
        });
        if (match) { return match; }
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
    // Loop exited -> port no longer readable (device unplugged / closed). Reflect that.
    serialConnected = false;
    writer = null;
    // Close our side so the same port can be reopened when the device comes back.
    try { await port.close(); } catch (e) { debug("[TCode] port.close after disconnect: " + e); }
    var usbBtn = document.getElementById("btnConnectUSB");
    if (usbBtn) {
        usbBtn.innerText = "🔗 Connect Serial (USB)";
        usbBtn.disabled = false;
    }
    showToast("USB Disconnected", settings.autoConnect !== false ? "Will reconnect when the device is plugged back in" : "", "warning");
    updateNavButton();
    debug("[TCode] Serial disconnected");
}

function sendTCode(data) {
    if (serialConnected && writer) {
        writer.write(data);
        if (settings.debug) { recordTx(data); }
    }
}

// ---------------------------------

// --- DEBUG TOOLS ---
// Only active with Debug on (Advanced tab). Tampermonkey runs this script in an isolated
// world, so the hooks are published on the page window as window.__tcode for the console.

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
                    processWSReply({ data: "L0 0 9999\nL1 0 9999\nL2 0 9999\nR0 0 9999\nR1 0 9999\nR2 0 9999\n" });
                }, 20);
            }
            return Promise.resolve();
        }
    };
    serialConnected = true;
    showToast("Simulated Device", "Commands are recorded, nothing is sent", "info");
    updateNavButton();
}

function publishDebugApi(){
    if(!settings.debug){ return; }
    unsafeWindow.__tcode = {
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

/* Stash Integration */
function fetchSceneInfo(id){
    GM_xmlhttpRequest({
        method: "POST",
        url: location.protocol + '//' + location.host + '/graphql',
        data: '{"operationName":"FindScene","variables":{"id":"' + id + '"},"query":"query FindScene($id: ID!, $checksum: String) {\\n  findScene(id: $id, checksum: $checksum) {\\n    ...SceneData\\n  }\\n}\\n\\nfragment SceneData on Scene {\\n  files {\\n    ...VideoFileData\\n  }\\n  paths {\\n    funscript\\n}\\n}\\n\\nfragment VideoFileData on VideoFile {\\n  path\\n}"}',
        cookie: document.cookie,
        anonymous: true,
        headers: { "Content-Type": "application/json" },
        onload: function(response){
            var json = JSON.parse(response.response);
            if(json.data && json.data.findScene && json.data.findScene.files.length > 0){
                video = json.data.findScene.files[0].path;
                debug("Video: " + video);
                fetchAllFunscripts();
            }
        }
    });
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
    var url = "";

    if (chosenScript) {
        url = chosenScript.value;
    } else {
        url = location.protocol + '//' + location.host + '/scene/' + getSceneId() + '/funscript';
    }

    GM_xmlhttpRequest({
        method: "GET",
        url: url,
        cookie: document.cookie,
        anonymous: true,
        onload: function(response) {
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
        }
    });
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
        GM_xmlhttpRequest({
            method: "POST",
            url: location.protocol + '//' + location.host + '/graphql',
            data: '{"operationName":"RunPluginOperation","variables":{"plugin_id":"StashInteractiveTools","args":{"mode":"init","scene_id":"' + getSceneId() + '","origin":"' + location.origin + '"}},"query":"mutation RunPluginOperation($plugin_id: ID!, $args: Map) {\\n  runPluginOperation(plugin_id: $plugin_id, args: $args)\\n}"}',
            cookie: document.cookie,
            anonymous: true,
            headers: { "Content-Type": "application/json" },
            onload: function(response){
                var json = JSON.parse(response.response);
                if(json.data && json.data.runPluginOperation){
                    scriptList = json.data.runPluginOperation.scripts;
                    fetchFunscript(axis);
                }
            }
        });
    }else{
        var chosenScript = document.querySelector('#stash-interactive-tools-select-funscripts');
        if(!chosenScript && !force){ setTimeout(function(){fetchFunscript(axis, true)}, 500); return -1; }
        var url = "";
        if(chosenScript){ url = chosenScript.value.split('.funscript')[0]; }
        else{ url = location.protocol + '//' + location.host + '/scene/' + getSceneId() + '/funscript'; }

        switch(axis){
            case "L1": url += ".surge"; break; case "L2": url += ".sway"; break; case "R0": url += ".twist"; break; case "R1": url += ".roll"; break; case "R2": url += ".pitch"; break;
        }
        if(chosenScript){ url = url + ".funscript"; }
        GM_xmlhttpRequest({
            method: "GET", url: url, cookie: document.cookie, anonymous: true,
            onload: function(response){
                if(response.status == 200){
                    if(!AXIS[axis]){ AXIS[axis] = new Object(); }
                    try { AXIS[axis].acts = JSON.parse(response.response).actions; }
                    catch (error) { debug("JSON error"); }
                    if(AXIS[axis].acts == null){ fetchFunscript(axis, force); return -1; }
                    AXIS[axis].start = AXIS[axis].acts[0].at;
                    AXIS[axis].end = AXIS[axis].acts[AXIS[axis].acts.length-1].at;
                    showToast("Axis Loaded", axis + " with " + AXIS[axis].acts.length + " actions", "success", 3000);
                }else{
                    AXIS[axis].acts = null;
                }
                AXIS[axis].scriptLoaded = true;
            }
        });
    }
}

function listAxes(exclude=""){
    var keys = Object.keys(AXIS);
    let removeAxis = keys.indexOf(exclude);
    if (removeAxis !== -1) { keys.splice(removeAxis, 1); }
    return keys;
}

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
    sendTCode(axis + String(getCenter(axis)).padStart(4, '0') + "I" + ramp + '\n');
}

// Park every enabled axis now (used by the Center Now button).
function centerAll(){
    if(!serialConnected){ showToast("Not Connected", "Connect over USB first", "warning"); return -1; }
    ["L0","L1","L2","R0","R1","R2"].forEach(ax => centerAxis(ax));
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
    // TCode magnitude is the digits after "0." -- send all four so the axis can reach
    // its real endpoints (two digits capped every axis at 0.99 and quantised to 1%).
    var cmd = axis + String(pos).padStart(4, '0') + "I" + int;
    debug(`[TCode] Queued: ${cmd} (axis: ${axis}, enabled: ${settings.axes[axis]?.enabled}, limits: ${lo}-${hi})`);
    // Commands stacked before the terminating \n MUST be separated by a space. Without
    // it the firmware reads "L05000I100R15000I100" as a single malformed L0 command and
    // silently drops every axis after the first.
    sendTCode(cmd + " ");
}

function move(){ if(serialConnected){ sendTCode('\n'); } }

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
        for(var x in AXIS){
            if(!settings.axes[x].enabled || AXIS[x].acts == null || AXIS[x].limits == null){ continue; }
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
                        var pos = AXIS[x].acts[i].pos;
                        if (settings.axes[x].invert) { pos = 100 - pos; }
                        // Map funscript 0-100 straight onto the axis range in device units
                        // (0-9999). The old "/100" collapsed this to 0-99 before sending.
                        var act = Math.round(((pos/100) * (AXIS[x].limits[1] - AXIS[x].limits[0])) + parseInt(AXIS[x].limits[0]));
                        queueMove(x, act, (AXIS[x].acts[i].at - ms));
                        AXIS[x].index = ++i;
                        break;
                    }
                }
            }
        }
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

function waitForVideoPlayer(){
    var player = document.querySelector('video');
    if(!player){
        // The element can disappear between scenes; drop the stale binding so the
        // replacement gets wired up instead of leaving listeners on a detached node.
        boundPlayer = null;
        setTimeout(waitForVideoPlayer, 500);
        return;
    }
    // Compare identity, not a boolean. videoPlayerLoaded was set once and never
    // cleared, so after React swapped the <video> the "seeking" listener stayed bound
    // to the old element and seeks stopped resetting the index -- which is why only a
    // page navigation restored playback.
    if(boundPlayer !== player){
        if(boundPlayer){
            boundPlayer.removeEventListener("seeking", resetIndex, false);
            boundPlayer.removeEventListener("seeked", resetIndex, false);
            boundPlayer.removeEventListener("ended", resetIndex, false);
            boundPlayer.removeEventListener("emptied", resetIndex, false);
        }
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
    setTimeout(waitForVideoPlayer, 10);
}

function processLimits(data){
    var values;
    var axesFound = [];
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

            // Auto-enable axes that the device supports (L and R axes only, not V or A)
            if(/^[LR]\d+$/.test(values[0]) && settings.axes[values[0]]){
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
        saveSettings(false); // Save without sending to device
    }
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

function hideOverlay(){ try{ document.querySelector('#overlay').hidden = "true"; }catch{ return ""; } }

function createOverlay(text){
    var video = document.querySelector("#VideoJsPlayer_html5_api");
    if(video){
        video = video.parentNode;
        var overlayElement = document.createElement('div');
        overlayElement.setAttribute('id', 'overlay');
        overlayElement.style = "position: absolute;z-index: 999999999999999;left: 50%;transform: translateX(-50%); font-size: 2.5em; color: white; -webkit-text-stroke-width: .75px; -webkit-text-stroke-color: black;";
        overlayElement.innerHTML = "<h2></h2>";
        video.appendChild(overlayElement);
        show(text);
    }else{ setTimeout(show, 500, text); }
}

function show(text){
    var overlay = document.querySelector('#overlay');
    if(!overlay){ createOverlay(text); }
    else{ overlay.childNodes[0].innerText = text; overlay.removeAttribute("hidden"); setTimeout(hideOverlay, 1000); }
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
    show(axis + ": " + min + " - " + max);
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
    ["L0","L1","L2","R0","R1","R2"].forEach(ax => initAxis(ax));
    loadCurrentLimits();
}

function getSceneId(){ return parseInt(location.href.split('/scenes/')[1]); }

function main(){
    if(serialConnected){
        // Restore saved ranges FIRST, synchronously, before anything (centerAxis or the
        // device D2 reply) can call setLimits and trigger a save.
        // Doing this on a timer previously let startup write the fallback [0,9999] over
        // the user's real saved range.
        ["L0","L1","L2","R0","R1","R2"].forEach(ax => {
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
        ["L0","L1","L2","R0","R1","R2"].forEach(ax => {
            if(settings.axes[ax] && settings.axes[ax].limits){ limits2socket(ax); } // push saved range to device
        });

        // Automatic homing is opt-out; the Home Now button ignores this and always runs.
        if(settings.homeEnabled !== false){
            ["L0","L1","L2","R0","R1","R2"].forEach(ax => centerAxis(ax));
        }
        fetchSceneInfo(getSceneId());
        waitForVideoPlayer();
    }else{ setTimeout(main, 500); }
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

function waitForPageChange(){
    var chosenScript = document.querySelector('#stash-interactive-tools-select-funscripts');
    if(chosenScript){ chosenScript.addEventListener('change', fetchAllFunscripts); cleanUpOptions(chosenScript); }
    if(location.href == lastPage){ setTimeout(waitForPageChange, 500); return -1; }
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
    }else{ videoPlayerLoaded = false; }
    setTimeout(waitForPageChange, 500);
}

publishDebugApi();
startNavButton();
startSerialAutoConnect();
waitForPageChange();