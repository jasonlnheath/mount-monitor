// quattro.js — the QuattroDash decision kernel: the approved instrument-
// cluster popup for Memory Monitor (board verdict "ship it", design rounds 1-7
// at data/mm-dashboard-standard-design/ in the firstmate home).
//
// This file owns every decision the dashboard makes, for the same reason the
// plugin's other decisions live in memory.js: they are testable without a
// running shell, and the panel (QuattroDash.qml) stays a pure renderer. The
// locked design defaults live here as named constants: the LED bands
// (green >= 25 / yellow 10-25 / red < 10), the PSI zones (amber 60-80, red at
// 80 and above), the fuel red zone (below 10 percent free), the 240-degree
// dial, the instrument names (RAM PRESSURE / SWAP RESERVE / ROOT DRIVE /
// VRAM COOLANT), the two-column popup content, the code taxonomy, and the
// dispatch toast copy.
//
// The language rule is round 4's, and it is law: NO em dashes, NO en dashes,
// NO semicolons in any string this module can produce. The copy register is
// terse and casual, five words ideal. tests/quattro.test.mjs scans every
// output this module can produce for banned characters.
//
// The codes area renders what the monitor actually sees: each watched DRIVE
// sitting over its amber or red ceiling becomes a code row, the way a real
// check-engine light shows active faults and clears when they clear. A code is
// C (component) plus four stable digits, so the same condition wears the same
// code while it is present. Round 2 doctrine (the captain's 2026-11-07
// live-look ruling): System RAM and VRAM high are NEVER engine codes. RAM
// monitoring is PRESSURE + SWAP RESERVE, never amount used, so RAM high is the
// PSI gauge and the battery and nothing else; VRAM high lights the coolant
// light only. Both Fix lines are the locked design copies: moderate codes say
// the click sends the pattern to the agent, severe codes say the agent has the
// pattern and is processing now. The click also carries the dash's own
// pre-computed diagnosis (diagnosisJson) as a fenced JSON block in the agent
// prompt, so Hermes explains from the dashboard's numbers instead of
// re-diagnosing from scratch.
//
// Round 2 also replaced the VRAM COOLANT tank card with the STANDARD ISO
// coolant warning light: the thermometer-in-liquid artwork this file already
// owns (SYMBOLS.temp), centered below the battery, tinted green / amber / red
// by coolantBand's own thresholds. The tank painter's coolantFill and COOLANT
// geometry left with the card; the band and the tip stayed.
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

// --- instrument names (round 5: brief names below each instrument; the VRAM
// --- COOLANT lane joined them at the captain's live-look ruling) ------------

var INSTRUMENTS = { psi: "RAM PRESSURE", batt: "SWAP RESERVE", fuel: "ROOT DRIVE", coolant: "VRAM COOLANT" };

// The settings row names each gauge by its instrument name; the pair keys are
// the gauge keys, so this is the one bridge between the two vocabularies.
var GAUGE_TITLES = {
  psi: INSTRUMENTS.psi,
  hd: INSTRUMENTS.fuel,
  batt: INSTRUMENTS.batt,
  vram: INSTRUMENTS.coolant,
};

function gaugeTitle(key) {
  return GAUGE_TITLES[key] || "";
}

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
// The coolant light's approach zone, a fixed MiB margin above the floor: amber
// when free VRAM falls under the floor plus this much. The captain's
// 2026-11-06 defaults steer set the light's lines at amber=1500 MiB free,
// red=500 MiB free, so the margin is 1000 over the 500 default floor.
var VRAM_AMBER_MARGIN_MIB = 1000;
// The unset-floor fallback, mirroring memory.js VRAM_FLOOR_DEFAULT_MIB. The
// two plain modules cannot import each other, so the test pins both at 500.
var VRAM_FLOOR_DEFAULT_MIB = 500;

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

// --- gauge threshold settings (the captain's 2026-11-07 round-1 ruling) -----
//
// Each gauge carries an amber/red pair the captain drags in the settings row
// at the bottom of the dash, and the pair moves the drawn bands live. The law
// the sliders enforce is mechanical: on the gauges where the bad end is high
// (RAM pressure, root drive) red can never sit below amber, and on the pair
// whose marks count what is LEFT (the swap reserve in percent, the VRAM
// coolant lines in MiB free) amber can never sit below red. Moving one slider
// through the other pushes the other, and no warning text exists.
//
// Defaults are the captain-approved recommended values: RAM pressure 70/90,
// root drive 80/90, swap reserve 20/10, VRAM coolant 1500/500 MiB free.
// psi and hd pairs are the plugin's own alert ceilings (memory.js thresholds);
// batt and vram pairs are display decisions stored beside them.

var GAUGE_KEYS = ["psi", "hd", "batt", "vram"];

var GAUGE_DEFAULTS = {
  psi: { amber: 70, red: 90 },
  hd: { amber: 80, red: 90 },
  batt: { amber: 20, red: 10 },
  vram: { amber: 1500, red: 500 },
};

// Slider ranges. The percent gauges drag 1-99; the coolant lines drag 1-8192
// MiB free, wide enough for the low half of any card this rig will see.
var GAUGE_PCT_MIN = 1;
var GAUGE_PCT_MAX = 99;
var GAUGE_MIB_MAX = 8192;

// True when the red number sits above the amber number (more used is worse).
// The reserve and coolant marks run the other way: their red sits below amber.
function gaugeRedAbove(key) {
  return key === "psi" || key === "hd";
}

function gaugeRange(key) {
  return key === "vram"
    ? { min: GAUGE_PCT_MIN, max: GAUGE_MIB_MAX }
    : { min: GAUGE_PCT_MIN, max: GAUGE_PCT_MAX };
}

function gaugeClamp(key, value) {
  const n = asNumber(value);
  if (n === null) return null;
  const range = gaugeRange(key);
  return Math.max(range.min, Math.min(range.max, Math.round(n)));
}

// The stored pair, sanitized. Absent or junk fields take the defaults, except
// a coolant red the captain moved on his own: its amber then rides the same
// fixed margin above it the card has always drawn, so a shell vramFloorMib of
// 3400 still lands amber at 4400. A pair that arrives ordered the wrong way
// round is brought back by the same push rule the sliders use, because a
// stored pair and a dragged pair obey one law.
function gaugePair(key, raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const defaults = GAUGE_DEFAULTS[key] || GAUGE_DEFAULTS.psi;
  const range = gaugeRange(key);
  let red = gaugeClamp(key, source.red);
  if (red === null) red = defaults.red;
  let amber = gaugeClamp(key, source.amber);
  if (amber === null) {
    amber = key === "vram" && red !== defaults.red
      ? red + VRAM_AMBER_MARGIN_MIB
      : defaults.amber;
  }
  amber = Math.max(range.min, Math.min(range.max, amber));
  if (gaugeRedAbove(key)) return { amber: amber, red: Math.max(red, amber) };
  return { amber: Math.max(amber, red), red: red };
}

// One slider moved: `which` is "amber" or "red", `value` the dragged number.
// Moving one slider through the other pushes the other, so the drawn bands
// never cross and no warning is ever needed. The RAM and root pairs are real
// alert ceilings, whose store demands strictly amber < red, so on those gauges
// the push keeps one percentage point of gap and drags the pushed slider off
// the boundary rather than onto it. Returns the new pair.
function adjustGaugePair(key, which, value, current) {
  const moved = gaugeClamp(key, value);
  if (moved === null) return gaugePair(key, current);
  const now = gaugePair(key, current);
  const range = gaugeRange(key);
  if (gaugeRedAbove(key)) {
    if (which === "red") {
      let amber = Math.max(range.min, Math.min(now.amber, moved - 1));
      let red = moved;
      if (amber >= red) red = amber + 1;
      return { amber: amber, red: red };
    }
    let amber = moved;
    let red = Math.min(range.max, Math.max(now.red, moved + 1));
    if (red <= amber) amber = red - 1;
    return { amber: amber, red: red };
  }
  if (which === "amber") return { amber: moved, red: Math.min(now.red, moved) };
  return { amber: Math.max(now.amber, moved), red: moved };
}

// Live dial zones from a pair. The drive gauge needle reads percent FREE, so
// its used-percent thresholds flip ends when they land on the dial; at the
// defaults the red zone is the locked one and the amber band extends it.
function zoneArcsFor(key, amber, red) {
  const p = gaugePair(key, { amber: amber, red: red });
  const a = Math.max(0, Math.min(1, p.amber / 100));
  const r = Math.max(0, Math.min(1, p.red / 100));
  if (gaugeRedAbove(key)) {
    return [
      { from: a, to: r, kind: "amber" },
      { from: r, to: 1, kind: "red" },
    ];
  }
  return [
    { from: 0, to: r, kind: "red" },
    { from: r, to: a, kind: "amber" },
  ];
}

function psiZoneArcsFor(amber, red) {
  return zoneArcsFor("psi", amber, red);
}

function fuelZoneArcsFor(amberUsed, redUsed) {
  const p = gaugePair("hd", { amber: amberUsed, red: redUsed });
  const aFree = Math.max(0, Math.min(1, (100 - p.amber) / 100));
  const rFree = Math.max(0, Math.min(1, (100 - p.red) / 100));
  const lo = Math.min(aFree, rFree);
  const hi = Math.max(aFree, rFree);
  return [
    { from: 0, to: lo, kind: "red" },
    { from: lo, to: hi, kind: "amber" },
  ];
}

var psiZoneArcs = psiZoneArcsFor(PSI_AMBER_AT, PSI_RED_AT);
var fuelZoneArcs = [{ from: 0, to: FUEL_RED_BELOW / 100, kind: "red" }];

// The battery band from the pair: green at amber or more, yellow between red
// and amber, red below red. ledBand keeps the locked 25/10 constants for the
// copy paths; the drawn gauge follows the pair.
function ledBandWith(pct, amber, red) {
  const p = gaugePair("batt", { amber: amber, red: red });
  const v = asNumber(pct);
  if (v === null) return "red";
  if (v >= p.amber) return "green";
  if (v >= p.red) return "yellow";
  return "red";
}

// Threshold ticks for the reserve gauge, red below amber, in needle fractions.
function battTickFracs(pair) {
  const p = gaugePair("batt", pair);
  return [
    { f: p.red / 100, cls: "red" },
    { f: p.amber / 100, cls: "amber" },
  ];
}

// The pair behind the coolant band and its hover decode. It arrives from the
// monitor's gaugePairFor already sanitized, so it keeps gaugePair's junk
// fallback and amber-over-red ordering but never the slider-range clamp: a
// vramFloorMib above GAUGE_MIB_MAX hands over the raw floor chain, whose
// lines legitimately sit past the slider scale.
function coolantPairUnclamped(redMib, amberMib) {
  const defaults = GAUGE_DEFAULTS.vram;
  let red = asNumber(redMib);
  if (red === null) red = defaults.red;
  let amber = asNumber(amberMib);
  if (amber === null)
    amber = red !== defaults.red ? red + VRAM_AMBER_MARGIN_MIB : defaults.amber;
  return { amber: Math.max(amber, red), red: red };
}

// The coolant band from the settings pair instead of the fixed margin. A junk
// or missing amber line falls back to the fixed margin above the red one, the
// same shape the locked coolantBand draws. No reading is null, the dash's rule
// that an unavailable reading never draws as healthy.
function coolantBandWith(freeMib, totalMib, redMib, amberMib) {
  const free = asNumber(freeMib);
  const total = asNumber(totalMib);
  if (free === null || total === null || total <= 0) return null;
  const p = coolantPairUnclamped(redMib, amberMib);
  if (free < p.red) return 2;
  if (free < p.amber) return 1;
  return 0;
}

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
  return ledBandWith(pct, LED_GREEN_AT, LED_YELLOW_AT);
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
  return psiZoneWith(psi, PSI_AMBER_AT, PSI_RED_AT);
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

// --- the VRAM COOLANT light (round 2) ---------------------------------------
//
// The tank card is gone; the light is the STANDARD ISO coolant warning glyph,
// the thermometer-in-liquid artwork SYMBOLS.temp already owns. What stays is
// the band the light tints by, over this plugin's own VRAM reading (memory.js
// vramReading, the nvidia-smi numbers), floored by this plugin's own
// vramFloorMib setting (memory.js vramFloorMib, 500 MiB unset). The band is
// the captain's own steer: red below the floor, amber a fixed 1000 MiB above
// it, so the unset lines are 500 and 1500 MiB free. High VRAM lights this
// light and throws no engine code.

// The band on its own, forgetting history - a gauge has no crossing to guard:
// 2 below the floor, 1 inside the approach zone, 0 above it. No reading is
// null, the dash's rule that an unavailable reading never draws as healthy.
// The thresholds are the captain's own steer: red at the floor (500 MiB free
// unset), amber a fixed 1000 MiB above it (1500 free unset), green above that.
function coolantBand(freeMib, totalMib, floorMib) {
  const floor = asNumber(floorMib);
  const base = floor === null || floor < 0 ? 0 : floor;
  return coolantBandWith(freeMib, totalMib, base, base + VRAM_AMBER_MARGIN_MIB);
}

// GiB with one decimal, the rounding the fuel gauge's mib() uses at the top
// of its range. The coolant light's hover says used and reserved in these
// units (round 2: the hover shows VRAM used / reserved).
function gibFromMib(mibValue) {
  const v = asNumber(mibValue);
  if (v === null) return "unknown";
  return (v / 1024).toFixed(1) + " GiB";
}

function coolantTip(reading, floorMib) {
  const floor = asNumber(floorMib);
  const floorNow = floor === null || floor < 0 ? VRAM_FLOOR_DEFAULT_MIB : floor;
  const tip = coolantTipWith(reading, floorNow, floorNow + VRAM_AMBER_MARGIN_MIB);
  tip.rows[3].text = "Red below the floor. Amber within 1000 MiB of the floor above it. Green above that. The floor is the vramFloorMib setting, 500 MiB unset.";
  return tip;
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
  return psiTipWith(psi, PSI_AMBER_AT, PSI_RED_AT);
}

function battTip(reserve) {
  return battTipWith(reserve, LED_GREEN_AT, LED_YELLOW_AT);
}

function fuelTip(root) {
  const tip = fuelTipWith(root, GAUGE_DEFAULTS.hd.amber, GAUGE_DEFAULTS.hd.red);
  tip.rows[3].text = "Red below " + FUEL_RED_BELOW + " percent free. Keep the needle away from E.";
  return tip;
}

// --- live-threshold tips ------------------------------------------------------
//
// The same four decodes with the drawn thresholds in the Ranges line, so hover
// copy always matches what the gauges draw. The dash calls these, because its
// gauges follow the settings pair; the locked decodes above are thin wrappers
// over these at the locked constants, with the fuel and coolant tips keeping
// their genuinely distinct locked Ranges wording.

function psiZoneWith(psi, amber, red) {
  const p = gaugePair("psi", { amber: amber, red: red });
  const v = asNumber(psi);
  if (v === null) return null;
  if (v >= p.red) return "red";
  if (v >= p.amber) return "amber";
  return "green";
}

function psiTipWith(psi, amber, red) {
  const p = gaugePair("psi", { amber: amber, red: red });
  const some = asNumber(psi && psi.some_avg10);
  const zone = psiZoneWith(some, p.amber, p.red);
  const word = zone === "red" ? "red, act now"
    : (zone === "amber" ? "amber, getting heavy"
    : (zone === "green" ? "green, healthy" : null));
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
      { label: "Ranges:", text: "Green below " + p.amber + ". Amber from " + p.amber + " to " + p.red + ". Red at " + p.red + " and above, which needs attention now." },
    ],
  };
}

function battTipWith(reserve, amber, red) {
  const p = gaugePair("batt", { amber: amber, red: red });
  const r = reserve || { present: false, pct: 0 };
  const pct = asNumber(r.pct);
  const now = r.present === true && pct !== null
    ? String(Math.round(pct)) + " percent remaining right now."
    : "no swap is configured.";
  const word = ledBandWith(pct, p.amber, p.red);
  return {
    header: INSTRUMENTS.batt,
    rows: [
      { label: "Reserve:", text: now, cls: "now" },
      { label: "What:", text: "Emergency swap is spare disk space the kernel uses when RAM runs out. It is the reserve that keeps the machine alive under memory pressure." },
      { label: "Why:", text: "When this reserve drains to empty, the system stops like a car out of fuel." },
      { label: "Ranges:", text: "Green at " + p.amber + " percent or more. Yellow from " + p.red + " to " + p.amber + ". Red below " + p.red + ". Right now: " + word + ".", cls: word === "red" ? "st-r" : (word === "yellow" ? "st-a" : "") },
    ],
  };
}

function fuelTipWith(root, amberUsed, redUsed) {
  const p = gaugePair("hd", { amber: amberUsed, red: redUsed });
  const r = root || null;
  const pctFree = r === null ? null : asNumber(r.pctFree);
  const gb = r === null ? null : gbFromKb(r.availKb);
  const gbTotal = r === null ? null : gbFromKb(r.sizeKb);
  const now = pctFree === null || gb === null || gbTotal === null
    ? "no root reading yet."
    : gb + " GB free of " + gbTotal + " GB (" + Math.round(pctFree) + " percent).";
  const redFree = 100 - p.red;
  const amberFree = 100 - p.amber;
  return {
    header: INSTRUMENTS.fuel,
    rows: [
      { label: "Now:", text: now, cls: "now" },
      { label: "What:", text: "Fuel shows free space on the root drive, the disk that holds the OS and your files. F means 100 percent free, E means none." },
      { label: "Why:", text: "When the root drive fills up the system can freeze or fail to write. Performance hinges on keeping it free." },
      { label: "Ranges:", text: "Red below " + redFree + " percent free, amber below " + amberFree + " percent free. Keep the needle away from E." },
    ],
  };
}

function coolantTipWith(reading, redMib, amberMib) {
  const p = coolantPairUnclamped(redMib, amberMib);
  const r = reading || null;
  const used = r === null ? null : asNumber(r.usedMib);
  const free = r === null ? null : asNumber(r.freeMib);
  const now = used === null || free === null
    ? "no VRAM reading yet."
    : gibFromMib(used) + " used, " + gibFromMib(free) + " reserved.";
  return {
    header: INSTRUMENTS.coolant,
    rows: [
      { label: "Now:", text: now, cls: "now" },
      { label: "What:", text: "Coolant is the GPU memory left over after what the GPU is using. Reserved means free: the headroom for the next big model load." },
      { label: "Why:", text: "When the coolant light goes red the GPU has no room for the next model load." },
      { label: "Ranges:", text: "Red below " + String(Math.round(p.red)) + " MiB free. Amber below " + String(Math.round(p.amber)) + " MiB free. Green above that. The gauge settings sliders move the thresholds." },
    ],
  };
}

// --- the settings row (the captain's round-1 ruling: one sentence per
// --- setting lives HERE, in the row, not in a popup inside the dashboard) ----

var SETTINGS = {
  header: "GAUGE SETTINGS",
  hint: "Drag a slider to move its band. Red never crosses amber.",
  reset: "RESET TO DEFAULTS",
  amberLabel: "AMBER",
  redLabel: "RED",
  copy: {
    psi: "Amber is where RAM pressure starts to build, red is where programs are stalling and the machine needs help.",
    hd: "Amber is where the root drive starts to fill, red is where it is nearly full and cleanup is due.",
    batt: "Ticks mark the emergency swap reserve, amber when it runs low and red just before empty.",
    vram: "The light tracks your free VRAM, amber when the next big model load gets risky, red at the floor where nothing fits.",
  },
};

// --- codes: the monitor's own live state, as the approved taxonomy -----------
//
// Round 2 doctrine: DRIVE codes only. The hash input stays "hd|<key>", so a
// drive keeps the code it wore before RAM and VRAM codes were retired.

function codeFor(type, key) {
  const digits = ("0000" + (fnv1a(type + "|" + key) % 10000)).slice(-4);
  return "C" + digits;
}

function codesFromReadings(devices) {
  const out = [];
  function add(entry) {
    if (!entry) return;
    const band = asNumber(entry.band) || 0;
    if (band < 1) return;
    const severe = band >= 2;
    const kind = entry.type === "ram" ? "ram" : (entry.type === "vram" ? "vram" : "hd");
    const subject = kind === "ram" ? "System RAM" : (kind === "vram" ? "VRAM" : "Drive");
    const pct = asNumber(entry.pct);
    const where = kind === "hd" && entry.target ? " " + sanitizePath(entry.target) : "";
    const reading = pct === null ? "unknown" : String(Math.round(pct));
    out.push({
      code: codeFor(kind, entry.key),
      sev: severe ? "r" : "a",
      band: band,
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

// The one check-engine head over the merged column. It tints by the most
// severe code showing: red when any severe code shows, amber when only
// moderate ones do, and the unlit emblem color when the column is empty. The
// captain's live-look ruling: red and amber codes share ONE space, most
// critical at the top, and no severity ever gets an empty section of its own.
function codesHeadToken(codes) {
  const list = codes === null || codes === undefined ? [] : codes;
  let token = "dim";
  for (let i = 0; i < list.length; i += 1) {
    const code = list[i];
    if (!code) continue;
    if (code.sev === "r") return "red";
    if (code.sev === "a") token = "amber";
  }
  return token;
}

// The line the empty column shows under the unlit head, so no codes never
// reads as a broken section.
function codesEmptyText() {
  return "all clear.";
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

// --- the pre-computed diagnosis (round 2, the engine-code click) -------------
//
// The dash's own read on a code, sent with the click as a fenced JSON block
// in the agent prompt, so Hermes explains from the dashboard's numbers
// instead of re-diagnosing from scratch. The schema is the captain's: code,
// severity, cause, top consumers, recommendation.
//
// Trust law, because targets and device names are written by whoever
// formatted the filesystem: every device-controlled string passes through
// sanitizePath, the fence is emitted on ONE line (JSON.stringify never emits
// a raw newline, and a fence closes only at the start of a line, so a fence
// sequence inside a string can never close the block), and the final scrub
// replaces backticks and angle brackets wherever they survived. The header
// sentence and the fence itself live in memory.js promptWithDiagnosis.

function diagnosisSeverity(entry) {
  return (entry || {}).sev === "r" ? "severe" : "moderate";
}

// The recommendation is the band's fixed advice, in the dash's own words. A
// read-only mount has nothing to prune or compress there: only moving files
// off is possible, the same honest wording the prompts and the skills carry.
function diagnosisRecommendation(entry) {
  const e = entry || {};
  if (e.alert && e.alert.ro === true) {
    return "read-only. nothing can be pruned or compressed here. move files off.";
  }
  return e.sev === "r"
    ? "act now. move files off or prune before the drive fills."
    : "plan a cleanup. prune, compress, or move files off.";
}

// Top consumers at the granularity the dash actually has: the device's own
// mount-target rows, worst reading first, three at most. These are targets
// on ONE device, not processes; the JSON says so by carrying only what the
// monitor measured.
function diagnosisConsumers(entry, rows) {
  const list = rows === null || rows === undefined ? [] : rows;
  const key = (entry === null || entry === undefined) || entry.alert === undefined || entry.alert === null ? "" : String(entry.alert.key);
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const row = list[i];
    if (!row || String(row.key) !== key) continue;
    const pct = asNumber(row.pct);
    out.push({
      target: sanitizePath(row.target),
      pct: pct === null ? null : Math.round(pct),
      usedKb: asNumber(row.usedKb),
      availKb: asNumber(row.availKb),
    });
  }
  out.sort(function (a, b) { return ((b.pct === null ? 0 : b.pct) - (a.pct === null ? 0 : a.pct)); });
  return out.slice(0, 3);
}

function diagnosisJson(entry, rows) {
  const e = entry || {};
  const doc = {
    code: e.code,
    severity: diagnosisSeverity(e),
    cause: e.issue,
    topConsumers: diagnosisConsumers(e, rows),
    recommendation: diagnosisRecommendation(e),
  };
  return JSON.stringify(doc).replace(/[`<>]/g, " ");
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

// The settings row can ask for a red a user-set critical ceiling may not sit
// under: the ceiling store's own law (critical above red) refuses the write,
// and the refusal is said in words, the way every other declined action here
// is. The toast names the gauge and both numbers, so the fix (raise critical
// first) is one sentence away. A refusal with no critical in the record (not
// reachable through the drawn sliders, which clamp inside the store's range)
// still says what did not happen instead of nothing at all.
function ceilingBlockedToast(key, critical, red) {
  const c = asNumber(critical);
  const r = asNumber(red);
  const label = gaugeTitle(key);
  const tail = c !== null && c > 0
    ? "the " + label + " critical line at " + String(Math.round(c)) + " must sit above red " + String(Math.round(r)) + ". raise critical first."
    : "the " + label + " red line could not move to " + String(Math.round(r)) + ".";
  return {
    mark: "\u2717",
    code: "THRESHOLD",
    text: tail,
  };
}

// --- the reserved spares record (the approved footer, held back) -------------
//
// The captain's live-look ruling: future additions are not visible on the
// dashboard. The three reserved lanes (oil, thermometer, hazard triangle) are
// no longer drawn; this record is the note of what is held back, and the
// SYMBOLS artwork stays so the lanes can be lit for real when their data
// sources exist. Nothing here is user-visible.

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
      {"stroke":true,"fill":true,"width":10,"d":"M38.305 171.82v-138.16c0-2.3996 1.9318-4.3314 4.3314-4.3314h62.337c2.3996 0 4.3314 1.9318 4.3314 4.3314v138.16M38.305 84.414h71M26.559 171.82h94.492M157.64 55.626l9.4547 80.332c0.51043 4.2911-0.51199 8.6243-2.8865 12.235-4.4493 6.7648-12.811 9.8081-20.567 7.4859-7.7567-2.3222-13.07-9.4595-13.123-17.556l-0.0532-37.547c-0.0002 -8.9258-7.2356-16.161-16.161-16.161"},
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
