// quattro.js — the Quattro Dash decision kernel: the approved instrument-
// cluster popup for Memory Monitor (board verdict "ship it", design rounds 1-7
// at data/mm-dashboard-standard-design/ in the firstmate home).
//
// This file owns every decision the dashboard makes, for the same reason the
// plugin's other decisions live in memory.js: they are testable without a
// running shell, and the panel (QuattroDash.qml) stays a pure renderer. The
// locked design defaults live here as named constants: the LED bands
// (green >= 25 / yellow 10-25 / red < 10), the PSI zones (amber 60-80, red at
// 80 and above), the fuel red zone (below 10 percent free), the 240-degree
// dial, the instrument names (RAM PRESSURE / SWAP RESERVE / ROOT DRIVE), the
// two-column popup content, the code taxonomy, and the dispatch toast copy.
//
// The language rule is round 4's, and it is law: NO em dashes, NO en dashes,
// NO semicolons in any string this module can produce. The copy register is
// terse and casual, five words ideal. tests/quattro.test.mjs scans every
// output this module can produce for banned characters.
//
// The codes area renders what the monitor actually sees: each resource the
// plugin watches that sits over its amber or red ceiling becomes a code row,
// the way a real check-engine light shows active faults and clears when they
// clear. A code is P (process) for System RAM and C (component) for VRAM and
// drives, plus four stable digits, so the same condition wears the same code
// while it is present. Both Fix lines are the locked design copies: moderate
// codes say the click sends the pattern to the agent, severe codes say the
// agent has the pattern and is processing now.
//
// The ISO 2575 / ISO 7000 telltale artwork in SYMBOLS is extracted verbatim
// from the approved mockup (Public domain / CC0 on Wikimedia Commons, licenses
// recorded in the design report). Rects and circles are pre-converted to path
// data so the QML side renders one PathSvg per item with no geometry code of
// its own.
//
// Loaded by QML (`import "quattro.js" as Quattro`) and by the node tests
// through node:vm. Plain top-level `function` declarations only: no `export`,
// no `import`, no pragma line, or one of the two consumers breaks.
// The trust primitives (asNumber, sanitizeText, fnv1a) are this repo's copies
// of the ringkit.js primitives, kept by hand because a QML JavaScript module
// cannot import another one.

// --- instrument names (round 5: brief names below each instrument) ----------

var INSTRUMENTS = { psi: "RAM PRESSURE", batt: "SWAP RESERVE", fuel: "ROOT DRIVE" };

// --- palette (the approved mockup's colors, by role) -------------------------

var PAL = {
  amber: "#e3b341",
  amberDeep: "#d29922",
  green: "#3fb950",
  red: "#e5484d",
  redHi: "#ff6b6f",
  redHot: "#ff3b30",
  needle: "#ff6b6f",
  hub: "#e5484d",
  face: "#101418",
  faceRing: "#1c2128",
  line: "#30363d",
  ledOff: "#232a33",
  mut: "#8b949e",
  faceSym: "#59646f",
  tickMinor: "#59646f",
  tickMajor: "#e6edf3",
  hubDot: "#0d1117",
  tooltipBg: "#0a0e13",
  hoverBg: "#181e26",
};

// --- thresholds and shapes (round 7 defaults, locked) ------------------------

var LED_COUNT = 10;
var LED_GREEN_AT = 25;
var LED_YELLOW_AT = 10;
var PSI_AMBER_AT = 60;
var PSI_RED_AT = 80;
var FUEL_RED_BELOW = 10;

var psiZoneArcs = [
  { from: 0.60, to: 0.80, kind: "amber" },
  { from: 0.80, to: 1.0, kind: "red" },
];
var fuelZoneArcs = [
  { from: 0.0, to: 0.10, kind: "red" },
];

var psiLabels = [
  { f: 0, t: "0" },
  { f: 0.25, t: "25" },
  { f: 0.5, t: "50" },
  { f: 0.75, t: "75" },
  { f: 1, t: "100", color: "redHi" },
];
var fuelLabels = [
  { f: 0, t: "E", color: "redHi" },
  { f: 0.25, t: "¼" },
  { f: 0.5, t: "½" },
  { f: 0.75, t: "¾" },
  { f: 1, t: "F", color: "green" },
];

// --- trust primitives (the ringkit.js copies, by hand) -----------------------

var DEVICE_PATH_MAX = 256;

function asNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const n = Number(value);
  return isFinite(n) ? n : null;
}

function sanitizePath(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, DEVICE_PATH_MAX);
}

function fnv1a(text, seed) {
  let h = seed >>> 0;
  const t = String(text === undefined || text === null ? "" : text);
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619) >>> 0;
  return h >>> 0;
}

// --- dial geometry (the mockup's 260x232 viewbox, 240 degrees from -120) -----

var DIAL = {
  viewW: 260,
  viewH: 232,
  cx: 130,
  cy: 122,
  sweep: 240,
  a0: -120,
  faceR: 108,
  faceRingR: 108,
  zoneR: 100,
  zoneWidth: 9,
  tickOuter: 90,
  tickMajor: 79,
  tickMid: 83,
  tickMinor: 86,
  labelR: 64,
  needleTail: 15,
  needleTip: 80,
  hubR: 9,
  hubDotR: 3.2,
};

function polar(cx, cy, r, deg) {
  const a = ((deg - 90) * Math.PI) / 180;
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}

function needleAngleDeg(frac) {
  const v = asNumber(frac);
  if (v === null) return null;
  return DIAL.a0 + DIAL.sweep * Math.max(0, Math.min(1, v));
}

function dialTicks() {
  const out = [];
  for (let i = 0; i <= 40; i += 1) {
    const f = i / 40;
    const major = i % 10 === 0;
    const mid = i % 5 === 0 && !major;
    out.push({ f: f, major: major, mid: mid });
  }
  return out;
}

// --- readings to needles and bands -------------------------------------------

function ledBand(pct) {
  const v = asNumber(pct);
  if (v === null) return "red";
  if (v >= LED_GREEN_AT) return "green";
  if (v >= LED_YELLOW_AT) return "yellow";
  return "red";
}

function litSegments(pct) {
  const v = asNumber(pct);
  if (v === null) return 0;
  return Math.max(0, Math.min(LED_COUNT, Math.round(v / 10)));
}

// The battery is the emergency swap RESERVE: charge is what is free, and it
// trickles down as the kernel fills swap. No swap configured is the empty
// state, not a green one.
function reserveReading(swapTotals) {
  const t = swapTotals || {};
  const total = asNumber(t.swapTotalKb) || 0;
  const used = asNumber(t.swapUsedKb) || 0;
  if (total <= 0) return { present: false, pct: 0 };
  const pct = ((total - used) / total) * 100;
  return { present: true, pct: Math.max(0, Math.min(100, pct)) };
}

function psiZone(psi) {
  const v = asNumber(psi);
  if (v === null) return null;
  if (v >= PSI_RED_AT) return "red";
  if (v >= PSI_AMBER_AT) return "amber";
  return "green";
}

function psiNeedleFrac(psi) {
  const v = asNumber(psi);
  if (v === null) return null;
  return Math.max(0, Math.min(1, v / 100));
}

function fuelNeedleFrac(pctFree) {
  const v = asNumber(pctFree);
  if (v === null) return null;
  return Math.max(0, Math.min(1, v / 100));
}

function gbFromKb(kb) {
  const v = asNumber(kb);
  if (v === null) return null;
  return Math.round((v * 1024) / 1000000000);
}

// --- popup content (round 4: two columns, label | sentence) ------------------

function psiZoneWord(psi) {
  const zone = psiZone(psi);
  if (zone === "red") return "red, act now";
  if (zone === "amber") return "amber, getting heavy";
  if (zone === "green") return "green, healthy";
  return null;
}

function psiTip(psi) {
  const some = asNumber(psi && psi.some_avg10);
  const word = psiZoneWord(some);
  const now = some === null || word === null
    ? "no pressure reading yet."
    : some.toFixed(1) + " PSI, " + word + ".";
  return {
    header: INSTRUMENTS.psi,
    rows: [
      { label: "Now:", text: now, cls: "now" },
      { label: "Metric:", text: "PSI is a real kernel metric. It stands for Pressure Stall Information and comes from /proc/pressure/memory in Linux. It reports the percent of time programs were stalled waiting for RAM, averaged over the last 10 seconds." },
      { label: "What:", text: "We show the kernel\u2019s \u201csome\u201d average, meaning at least one program was stuck waiting for RAM. The scale is 0 to 100 because that is exactly how the kernel reports it." },
      { label: "Why:", text: "High pressure means the machine is starved for memory. Everything slows down and crashes get more likely." },
      { label: "Ranges:", text: "Green below 60. Amber from 60 to 80. Red at 80 and above, which needs attention now." },
    ],
  };
}

function battTip(reserve) {
  const r = reserve || { present: false, pct: 0 };
  const pct = asNumber(r.pct);
  const now = r.present === true && pct !== null
    ? String(Math.round(pct)) + " percent remaining right now."
    : "no swap is configured.";
  const word = ledBand(pct);
  return {
    header: INSTRUMENTS.batt,
    rows: [
      { label: "Reserve:", text: now, cls: "now" },
      { label: "What:", text: "Emergency swap is spare disk space the kernel uses when RAM runs out. It is the reserve that keeps the machine alive under memory pressure." },
      { label: "Why:", text: "When this reserve drains to empty, the system stops like a car out of fuel." },
      { label: "Ranges:", text: "Green at 25 percent or more. Yellow from 10 to 25. Red below 10. Right now: " + word + ".", cls: word === "red" ? "st-r" : (word === "yellow" ? "st-a" : "") },
    ],
  };
}

function fuelTip(root) {
  const r = root || null;
  const pctFree = r === null ? null : asNumber(r.pctFree);
  const gb = r === null ? null : gbFromKb(r.availKb);
  const gbTotal = r === null ? null : gbFromKb(r.sizeKb);
  const now = pctFree === null || gb === null || gbTotal === null
    ? "no root reading yet."
    : gb + " GB free of " + gbTotal + " GB (" + Math.round(pctFree) + " percent).";
  return {
    header: INSTRUMENTS.fuel,
    rows: [
      { label: "Now:", text: now, cls: "now" },
      { label: "What:", text: "Fuel shows free space on the root drive, the disk that holds the OS and your files. F means 100 percent free, E means none." },
      { label: "Why:", text: "When the root drive fills up the system can freeze or fail to write. Performance hinges on keeping it free." },
      { label: "Ranges:", text: "Red below 10 percent free. Keep the needle away from E." },
    ],
  };
}

// --- codes: the monitor's own live state, as the approved taxonomy -----------

function codeFor(type, key) {
  const letter = type === "ram" ? "P" : "C";
  const digits = ("0000" + (fnv1a(type + "|" + key) % 10000)).slice(-4);
  return letter + digits;
}

function codesFromReadings(ram, vram, devices) {
  const out = [];
  function add(entry) {
    if (!entry) return;
    const band = asNumber(entry.band) || 0;
    if (band < 1) return;
    const severe = band >= 2;
    const kind = entry.type === "ram" ? "ram" : (entry.type === "vram" ? "vram" : "hd");
    const subject = kind === "ram" ? "System RAM" : (kind === "vram" ? "VRAM" : "Drive");
    const descWord = kind === "hd" ? "drive" : kind;
    const pct = asNumber(entry.pct);
    const where = kind === "hd" && entry.target ? " " + sanitizePath(entry.target) : "";
    const reading = pct === null ? "unknown" : String(Math.round(pct));
    const word = severe ? "red" : "amber";
    out.push({
      code: codeFor(kind, entry.key),
      sev: severe ? "r" : "a",
      band: band,
      desc: descWord + " over the " + word + " line",
      issue: subject + where + " reading " + reading + " percent.",
      status: severe ? "severe, over your red ceiling." : "moderate, over your amber ceiling.",
      fix: severe
        ? "agent has the crash pattern and is processing now."
        : "click to send crash pattern to agent.",
      alert: {
        kind: "alert",
        band: band,
        type: kind,
        key: entry.key,
        id: entry.id,
        pct: entry.pct,
        target: entry.target,
        device: entry.device,
        fstype: entry.fstype,
        label: entry.label,
        partlabel: entry.partlabel,
        sizeKb: entry.sizeKb,
        usedKb: entry.usedKb,
        availKb: entry.availKb,
        ro: entry.ro === true,
        latched: entry.latched === true,
      },
    });
  }
  add(ram);
  add(vram);
  if (devices) {
    for (let i = 0; i < devices.length; i += 1) add(devices[i]);
  }
  out.sort(function (a, b) {
    if (a.sev !== b.sev) return a.sev === "r" ? -1 : 1;
    if (a.band !== b.band) return b.band - a.band;
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  });
  return out;
}

function codeTip(code) {
  const c = code || {};
  return {
    header: c.code,
    sev: c.sev,
    rows: [
      { label: "Issue:", text: c.issue },
      { label: "Status:", text: c.status, cls: c.sev === "r" ? "st-r" : "st-a" },
      { label: "Fix:", text: c.fix },
    ],
  };
}

// --- dispatch toast (the approved copy, verbatim) ----------------------------

function dispatchToast(code, severe) {
  return {
    mark: "\u2713",
    code: code,
    text: severe
      ? "to firstmate (default agent), processing now"
      : "to firstmate (default agent)",
  };
}

// A severe code's click rides the arm, and the arm's gate can refuse it. The
// refusal is said in words, the way every other declined dispatch here is, and
// the keys are shouldStartArm's own why tokens from memory.js.
var REFUSALS = {
  "guard-off": "not sent. the guard is off.",
  "arm-live": "not sent. an agent is already on it.",
  "no-headroom": "not sent. no memory headroom.",
  "not-writer": "not sent. another screen owns the guard.",
};

function dispatchRefused(code, why) {
  return {
    mark: "\u2717",
    code: code,
    text: REFUSALS[why] || "not sent.",
  };
}

// --- the reserved spares row (the approved footer, captain's ruling) ---------

var SPARES = {
  caption: "FUTURE LANES (RESERVED)",
  symbols: ["oil", "thermo", "tri"],
};

// --- symbols: the ISO artwork from the approved mockup -----------------------

var SYMBOLS = {
  temp: {
    viewBox: [0, 0, 200, 200],
    items: [
      {"stroke":true,"width":11,"d":"M100 46.891h42.77M100 94.454h42.77M100 70.673h42.77"},
      {"fill":true,"d":"m36.834 144.91c-1.971 0.01401-3.7808 0.30574-5.4473 0.74218v11.652c2.036-0.83323 3.7629-1.359 5.4629-1.3828 2.6385 0.05709 5.1369 1.0853 8.4082 2.5703 3.2971 1.4968 7.3897 3.4749 12.615 3.5156l0.0625 0.00196 0.0625-0.00196c5.3385-0.0799 9.5347-2.0588 12.852-3.5664 3.2891-1.495 5.6999-2.4862 8.084-2.5195 2.6385 0.05709 5.1369 1.0853 8.4082 2.5703 3.2971 1.4968 7.3897 3.4749 12.615 3.5156l0.062499 0.00196 0.0625-0.00196c5.3386-0.0799 9.5347-2.0588 12.852-3.5664 3.2891-1.495 5.7018-2.4862 8.0859-2.5195 2.6378 0.05749 5.1377 1.0856 8.4082 2.5703 3.2971 1.4968 7.3878 3.4769 12.613 3.5176h0.0625l0.0625-0.00196c5.3385-0.0798 9.5367-2.0588 12.854-3.5664 3.2891-1.495 5.6999-2.4862 8.084-2.5195 1.7996 0.03894 3.5508 0.55468 5.5098 1.334v-11.605c-1.6578-0.42054-3.4512-0.7076-5.4004-0.73828l-0.0625-0.00195h-0.0625c-5.2305 0.0372-9.3253 2.0195-12.621 3.5176-3.27 1.4864-5.7645 2.5153-8.4024 2.5703-2.3847-0.0349-4.7997-1.0279-8.0898-2.5215-3.3178-1.5062-7.5123-3.4805-12.846-3.5644l-0.0625-0.00195h-0.0625c-5.2306 0.0372-9.3253 2.0195-12.621 3.5176-3.27 1.4864-5.7645 2.5153-8.4023 2.5703-2.3847-0.0349-4.8017-1.0279-8.0918-2.5215-3.3179-1.5062-7.5103-3.4825-12.844-3.5664h-0.12695c-5.2305 0.0372-9.3253 2.0195-12.621 3.5176-3.27 1.4864-5.7625 2.5153-8.4004 2.5703-2.3847-0.0349-4.8017-1.0279-8.0918-2.5215-3.3179-1.5062-7.5123-3.4825-12.846-3.5664h-0.125z"},
      {"fill":true,"d":"m36.418 112.63-0.064453 0.00195c-7.2067 0.052-12.978 2.8462-17.967 5.1484-0.1665 0.07684-0.3176 0.14104-0.48242 0.21679v11.99c1.7869-0.7291 3.5056-1.4867 5.0918-2.2188 4.9848-2.3005 9.0605-4.0842 13.373-4.1328 4.6618 0.0909 8.8707 1.9195 13.838 4.209 4.9905 2.3002 10.759 5.0915 17.959 5.1484h0.12695c2.476-0.03761 4.7724-0.39446 6.9375-0.91407a25.576 25.576 0 0 1-0.80664-6.1582 25.576 25.576 0 0 1 0.60547-5.2266c-2.2674 0.76189-4.4954 1.2491-6.8398 1.293-4.312-0.0515-8.3925-1.8345-13.379-4.1328-5.0114-2.3099-10.929-5.1044-18.33-5.2227l-0.0625-0.00195zm127.27 0-0.06445 0.00195c-7.2067 0.052-12.978 2.8462-17.967 5.1484-4.966 2.2918-9.169 4.1202-13.832 4.207-2.2746-0.02717-4.4925-0.55349-6.8047-1.3652a25.576 25.576 0 0 1 0.56055 5.2988 25.576 25.576 0 0 1-0.80273 6.1406c2.1896 0.54756 4.5159 0.9118 7.0254 0.93164h0.12695c7.407-0.11248 13.326-2.9125 18.336-5.2246 4.9878-2.3019 9.0654-4.0843 13.381-4.1309 4.6585 0.0929 8.8638 1.9188 13.828 4.207 1.4607 0.67326 3.0144 1.3723 4.625 2.0488v-12.029c-0.00666-0.00307-0.01286-0.00474-0.01953-0.00781-5.0114-2.3099-10.929-5.1064-18.33-5.2246l-0.0625-0.00195z"},
      {"fill":true,"d":"M100 21.053h0a7.604 7.604 0 0 1 7.604 7.604v92.352a7.604 7.604 0 0 1 -7.604 7.604h0a7.604 7.604 0 0 1 -7.604 -7.604v-92.352a7.604 7.604 0 0 1 7.604 -7.604z"},
      {"fill":true,"d":"M86.783 125.92a13.217 13.217 0 1 0 26.434 0a13.217 13.217 0 1 0 -26.434 0z"},
    ],
  },
  fuel: {
    viewBox: [0, 0, 200, 200],
    items: [
      {"stroke":true,"width":10,"d":"M38.305 171.82v-138.16c0-2.3996 1.9318-4.3314 4.3314-4.3314h62.337c2.3996 0 4.3314 1.9318 4.3314 4.3314v138.16M38.305 84.414h71M26.559 171.82h94.492M157.64 55.626l9.4547 80.332c0.51043 4.2911-0.51199 8.6243-2.8865 12.235-4.4493 6.7648-12.811 9.8081-20.567 7.4859-7.7567-2.3222-13.07-9.4595-13.123-17.556l-0.0532-37.547c-0.0002 -8.9258-7.2356-16.161-16.161-16.161"},
      {"fill":true,"d":"m125.21 23.179v10.102c3.3851 1.4714 6.7715 2.9434 11.189 6.3945 4.418 3.4511 9.8683 8.8808 13.15 15.35 3.2821 6.4688 4.3957 13.976 5.5098 21.482l18.377-8.5a81.074 81.074 0 0 0-48.227-44.828z"},
    ],
  },
  battery: {
    viewBox: [0, 0, 200, 200],
    items: [
      {"stroke":true,"width":8,"d":"M36.726 96.362h31.568M131.71 96.362h31.568M147.49 112.15v-31.568"},
      {"stroke":true,"width":10,"d":"M20.763 61.377h158.47v88.983h-158.47z"},
      {"fill":true,"d":"M41.525 44.64h25.636v16.737h-25.636z"},
      {"fill":true,"d":"M132.84 44.64h25.636v16.737h-25.636z"},
    ],
  },
  mil: {
    viewBox: [0, 0, 79.55, 53.03],
    items: [
      {"fill":true,"d":"M21.33,3.23V0h27V3.24H40.73v3h1.18c2.28,0,4.56,0,6.84,0a5.44,5.44,0,0,1,5.74,5.1,8,8,0,0,0,.21,1.3,2.36,2.36,0,0,0,2.44,1.87l6.36,0a2.12,2.12,0,0,1,.32.17v6.1h3.31v-6.1a7.6,7.6,0,0,1,.8-.14c2.72,0,5.44,0,8.16,0a1,1,0,0,1,1.15.89c.58,2.49,1.27,5,1.84,7.44a15.64,15.64,0,0,1,.39,3.2c0,3.4-.11,6.8,0,10.2a32.26,32.26,0,0,1-1.45,10.38c-.31,1.12-.53,2.26-.87,3.36-.11.34-.49.84-.75.84-3,.06-6.07,0-9.24,0V44.62h-3.4c0,1.06,0,2.05,0,3A5.38,5.38,0,0,1,58.57,53c-9.56,0-19.12,0-28.68,0a6,6,0,0,1-4.2-2c-2.1-2.08-4.24-4.13-6.31-6.23a3.32,3.32,0,0,0-2.66-1.1c-1.11,0-2.24,0-3.36,0A5.37,5.37,0,0,1,8.1,38.18c0-3.4,0-6.8,0-10.29H3.76V40.42c-2.17-.3-2.55-.72-2.55-2.66,0-3.32,0-6.64,0-10,0-.41,0-1-.3-1.21-1-.77-.9-1.78-.9-2.82C0,21,0,18.25,0,15.49A3,3,0,0,1,.8,13.75c.8-.91,1.76-1.69,2.86-2.73V24.31H8.1V19.83c0-.84,0-1.68,0-2.52a5.48,5.48,0,0,1,5.3-5.56c.36,0,.72,0,1.08,0,2.23,0,2.38-.15,3.31-2.18A5.34,5.34,0,0,1,22.88,6.2c2,0,4.06,0,6.18,0v-3ZM60.48,17.85H57.69c-3.82,0-6-2-6.5-5.74-.23-2-.84-2.54-2.88-2.54H23.72c-2,0-2.34.25-3.13,2.11a5.29,5.29,0,0,1-4.68,3.4c-.71.06-1.44,0-2.16,0a2.18,2.18,0,0,0-2.3,2.37q0,10.2,0,20.39a2.13,2.13,0,0,0,2.27,2.38c1.08.06,2.16,0,3.24,0a6.07,6.07,0,0,1,4.62,1.91c2.13,2.15,4.32,4.25,6.46,6.4a3.51,3.51,0,0,0,2.66,1.1c9,0,18,0,27,0,2,0,2.76-.77,2.77-2.73V41.28H70.53v6.26c1.19,0,2.26,0,3.33,0a1,1,0,0,0,.7-.6c.63-2.83,1.75-5.55,1.65-8.55-.12-3.35-.16-6.72,0-10.07s-.79-6.48-1.6-9.64c-.08-.29-.38-.73-.6-.75-1.13-.07-2.27,0-3.54,0V24.1h-10Z"},
    ],
  },
  // The three reserved-lane telltales the approved footer shows, unlit. The
  // hazard triangle's mockup transform is baked into its moveto, and the
  // moveto's second pair stays an explicit RELATIVE lineto, the same way the
  // fuel nozzle's is.
  oil: {
    viewBox: [0, 0, 200, 200],
    items: [
      {"fill":true,"d":"m11.951 58.867-7.8086 29.146 37.898 14.066v31.008h87.648l41.787-50.451 8.5128-2.6846 4.5655 4.7681 5.6618-6.8803-8.6347-8.8313-19.051 8.0307-48.686 12.508-7.9551-7.957h-22.289v-10.064h11.26v-10h-32.52v10h11.26v10.064h-21.561v-7.8418zm6.8164 13.197 23.273 8.6367v10.713l-25.883-9.6074zm138.24 13.243-32.018 37.78h-72.947v-31.498h49.707l9.2441 9.2441z"},
      {"fill":true,"d":"m187.69 101.34c0.25907 2.5987 0.33343 5.3253 1.6038 7.6787 1.0182 1.9309 1.5768 4.2267 1.06 6.3859-0.50729 1.6344-1.8645 2.9226-3.3876 3.6356-1.207 0.46222-2.5574 0.39771-3.8147 0.21508-1.6372-0.43101-3.0079-1.677-3.798-3.1513-0.77169-1.6722-0.4754-3.6262 0.0322-5.331 0.58637-1.5982 1.5551-3.0653 1.815-4.7768 0.50649-2.3923 0.35025-4.8876 1.005-7.2505 0.29081-0.984 1.0024-2.0868 2.159-2.0582 0.60118-0.0108 1.5162-0.0935 2.1286 0.67862 0.84419 0.86479 1.0108 2.4669 1.1966 3.9738z"},
    ],
  },
  thermo: {
    viewBox: [0, 0, 100, 100],
    items: [
      {"fill":true,"d":"M42.046,70.668V27.449c0-0.672-0.543-1.216-1.215-1.216c-0.671,0-1.215,0.544-1.215,1.216v43.219c-3.95,0.588-6.992,3.996-6.992,8.105c0,4.527,3.681,8.211,8.206,8.211s8.209-3.684,8.209-8.211C49.038,74.664,45.996,71.26,42.046,70.668z"},
      {"fill":true,"d":"M50.346,63.922V12.79c0-2.873-1.008-5.276-2.917-6.951c-1.664-1.461-3.922-2.265-6.355-2.265 c-4.731,0-9.758,3.229-9.758,9.216v51.13c-5.031,3.23-8.134,8.855-8.134,14.857c0,9.73,7.917,17.648,17.65,17.648 c9.732,0,17.649-7.918,17.649-17.648C58.479,72.775,55.378,67.152,50.346,63.922z M40.831,93.994 c-8.392,0-15.219-6.826-15.219-15.217c0-5.381,2.888-10.416,7.535-13.141c0.02-0.01,0.034-0.025,0.052-0.037 c0.012-0.008,0.022-0.018,0.034-0.025c0.055-0.037,0.106-0.08,0.152-0.125c0.006-0.006,0.011-0.012,0.017-0.018 c0.049-0.051,0.094-0.105,0.132-0.16c0.006-0.008,0.009-0.018,0.014-0.025c0.037-0.057,0.07-0.115,0.097-0.178 c0.006-0.014,0.01-0.027,0.016-0.043c0.022-0.059,0.042-0.117,0.055-0.178c0.004-0.02,0.007-0.039,0.01-0.059 c0.009-0.061,0.017-0.119,0.018-0.18c0-0.008,0.002-0.016,0.002-0.025v-3.07h1.789c0.672,0,1.216-0.545,1.216-1.217 s-0.544-1.215-1.216-1.215h-1.789v-6.148h1.789c0.672,0,1.216-0.543,1.216-1.217c0-0.67-0.544-1.215-1.216-1.215h-1.789v-6.147 h1.789c0.672,0,1.216-0.544,1.216-1.216s-0.544-1.215-1.216-1.215h-1.789v-6.148h1.789c0.672,0,1.216-0.544,1.216-1.216 c0-0.671-0.544-1.216-1.216-1.216h-1.789v-6.147h1.789c0.672,0,1.216-0.544,1.216-1.215c0-0.672-0.544-1.217-1.216-1.217h-1.789 v-6.146h1.789c0.672,0,1.216-0.545,1.216-1.216c0-0.672-0.544-1.216-1.216-1.216h-1.789V12.79c0-4.454,3.687-6.785,7.328-6.785 c1.843,0,3.531,0.591,4.752,1.662c1.367,1.199,2.09,2.971,2.09,5.123v7.685h-1.96c-0.672,0-1.216,0.545-1.216,1.216 c0,0.672,0.544,1.216,1.216,1.216h1.96v6.146h-1.96c-0.672,0-1.216,0.545-1.216,1.217c0,0.671,0.544,1.216,1.216,1.216h1.96v6.146 h-1.96c-0.672,0-1.216,0.544-1.216,1.217c0,0.671,0.544,1.215,1.216,1.215h1.96v6.148h-1.96c-0.672,0-1.216,0.544-1.216,1.215 c0,0.672,0.544,1.216,1.216,1.216h1.96v6.148h-1.96c-0.672,0-1.216,0.543-1.216,1.215s0.544,1.217,1.216,1.217h1.96v7.361 c0,0.008,0.002,0.014,0.002,0.02c0.001,0.066,0.009,0.133,0.02,0.199c0.004,0.014,0.004,0.025,0.008,0.039 c0.014,0.068,0.034,0.135,0.061,0.199c0.003,0.008,0.006,0.016,0.009,0.023c0.029,0.068,0.064,0.133,0.106,0.195 c0.001,0.002,0.002,0.004,0.004,0.006c0.042,0.062,0.089,0.119,0.144,0.174c0.002,0.002,0.003,0.006,0.006,0.008 c0.049,0.047,0.104,0.092,0.162,0.133c0.008,0.006,0.016,0.012,0.023,0.018c0.02,0.014,0.035,0.027,0.055,0.039 c4.647,2.725,7.536,7.76,7.536,13.141C56.05,87.168,49.223,93.994,40.831,93.994z"},
      {"fill":true,"d":"M72.794,56.779c-0.957-0.848-1.861-1.646-2.528-2.729c-0.222-0.359-0.613-0.578-1.035-0.578s-0.813,0.219-1.034,0.576c-0.668,1.082-1.572,1.883-2.53,2.73c-1.887,1.67-4.025,3.562-4.025,7.736c0,4.186,3.405,7.59,7.59,7.59c4.184,0,7.589-3.404,7.589-7.59C76.819,60.344,74.681,58.449,72.794,56.779z M69.23,69.674c-2.844,0-5.159-2.314-5.159-5.158c0-3.078,1.415-4.33,3.208-5.916c0.658-0.582,1.329-1.176,1.951-1.883c0.621,0.707,1.293,1.301,1.952,1.885c1.791,1.584,3.206,2.836,3.206,5.914C74.389,67.359,72.074,69.674,69.23,69.674z"},
      {"fill":true,"d":"M61.984,54.289c4.185,0,7.59-3.404,7.59-7.589c0-4.174-2.14-6.066-4.026-7.736c-0.958-0.848-1.861-1.647-2.529-2.73c-0.442-0.719-1.626-0.718-2.07,0c-0.667,1.083-1.57,1.884-2.527,2.73c-1.887,1.67-4.025,3.563-4.025,7.736C54.396,50.885,57.8,54.289,61.984,54.289z M60.032,40.785c0.658-0.584,1.331-1.179,1.952-1.885c0.621,0.706,1.294,1.301,1.951,1.884c1.793,1.586,3.207,2.838,3.207,5.916c0,2.844-2.314,5.157-5.158,5.157s-5.158-2.313-5.158-5.157C56.826,43.622,58.241,42.37,60.032,40.785z"},
    ],
  },
  tri: {
    viewBox: [0, 0, 80, 80],
    items: [
      {"stroke":true,"width":5.5,"d":"M40 9.9999995l17.320507,29.9999997 17.320508,30.000001 -34.641016,-1e-6 -34.641016,-1e-6 17.320508,-29.999999 zM40 25.0000002l10.825317,18.75 10.825317,18.75 -21.650635,0 -21.650635,-1e-6 10.825318,-18.749999 z"},
    ],
  },
};
