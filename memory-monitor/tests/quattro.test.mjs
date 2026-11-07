// QuattroDash — the approved instrument-cluster popup for Memory Monitor.
//
// Design source of truth: the board-approved mockup
// data/mm-dashboard-standard-design/index.html (round 6, verdict "ship it") and
// its report rounds 1-7. These tests pin the decisions the popup is built from:
// the LED bands (green >= 25 / yellow 10-25 / red < 10), the PSI zones
// (amber 60-80, red >= 80) and the fuel red zone (< 10 percent free), the dial
// geometry the Canvas painter draws with, the two-column popup content
// structure with the approved copy, the live code taxonomy with both locked Fix
// copies, the dispatch toast, the ISO symbol data the Shape/PathSvg components
// render, the palette, and the language rule (no em dashes, no en dashes, no
// semicolons anywhere a captain reads).
//
// memory.js gains one data reading for the dashboard (rootDriveReading); its
// tests live here because the dashboard is the only consumer.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { Memory, Mounts, repoFile, same } from "./load.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

// quattro.js is a QML JavaScript module: plain top-level `function`
// declarations, no `export`, no `import`, no `.pragma library` — loaded the way
// QML loads it, in a fresh context. A future "just add an export" change fails
// here instead of in the shell.
function loadQuattro() {
  const source = readFileSync(path.join(ROOT, "memory-monitor/quattro.js"), "utf8");
  const context = {
    Math,
    Number,
    parseInt,
    parseFloat,
    isFinite,
    String,
    Array,
    Object,
    JSON,
    Date,
    RegExp,
    Boolean,
    console,
  };
  vm.runInNewContext(source, context, { filename: "memory-monitor/quattro.js" });
  return context;
}

const Quattro = loadQuattro();

// Whether `function tip()` is declared directly on the object whose `id` is
// <id>: the declaration must sit at the owning object's own brace depth inside
// its body. A tip declared on a nested child is the swap hover bug this guards
// against, and an unbounded search between `id:` and `function tip(` cannot
// see the difference.
function tipDeclaredOn(text, id) {
  const at = new RegExp(`id:\\s*${id}\\b`).exec(text);
  if (at === null) return false;
  const openAt = [];
  let depth = 0;
  for (let i = 0; i < at.index; i += 1) {
    if (text[i] === "{") { depth += 1; openAt[depth] = i; }
    else if (text[i] === "}") depth -= 1;
  }
  const bodyStart = openAt[depth];
  if (bodyStart === undefined) return false;
  const memberDepth = depth + 1;
  const tokens = /\{|\}|function\s+tip\s*\(/g;
  let t;
  while ((t = tokens.exec(text.slice(bodyStart))) !== null) {
    if (t[0] === "{") depth += 1;
    else if (t[0] === "}") { depth -= 1; if (depth < memberDepth) return false; }
    else if (depth === memberDepth) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Module shape
// ---------------------------------------------------------------------------

test("quattro.js is a plain QML module: no export, no import, no pragma", () => {
  const source = readFileSync(path.join(ROOT, "memory-monitor/quattro.js"), "utf8");
  assert.equal(/(^|\n)\s*export\s/.test(source), false, "no export in a QML-imported module");
  assert.equal(/(^|\n)\s*import\s/.test(source), false, "no import in a QML-imported module");
  assert.equal(source.includes(".pragma library"), false);
  // The decisions are functions, not a frozen bag of literals: every helper the
  // panel calls is a top-level declaration QML and the tests both see.
  for (const fn of [
    "ledBand", "litSegments", "reserveReading", "psiZone", "psiNeedleFrac",
    "fuelNeedleFrac", "needleAngleDeg", "psiTip", "battTip", "fuelTip",
    "codeTip", "codesFromReadings", "dispatchToast", "dispatchRefused", "gbFromKb",
    "coolantFill", "coolantBand", "coolantTip", "codesHeadToken", "codesEmptyText",
  ]) {
    assert.match(source, new RegExp(`\\bfunction\\s+${fn}\\s*\\(`), `quattro.js must declare ${fn}`);
  }
});

// ---------------------------------------------------------------------------
// Instrument names (round 5: brief names below each instrument)
// ---------------------------------------------------------------------------

test("the four instrument names are the approved ones", () => {
  assert.equal(Quattro.INSTRUMENTS.psi, "RAM PRESSURE");
  assert.equal(Quattro.INSTRUMENTS.batt, "SWAP RESERVE");
  assert.equal(Quattro.INSTRUMENTS.fuel, "ROOT DRIVE");
  assert.equal(Quattro.INSTRUMENTS.coolant, "VRAM COOLANT");
});

// ---------------------------------------------------------------------------
// LED bands (round 7 defaults, locked): green >= 25 / yellow 10-25 / red < 10
// ---------------------------------------------------------------------------

test("ledBand: green at 25 and above, yellow from 10, red below 10, and no reading is red", () => {
  assert.equal(Quattro.ledBand(100), "green");
  assert.equal(Quattro.ledBand(25), "green", "the green edge is >= 25");
  assert.equal(Quattro.ledBand(24.9), "yellow");
  assert.equal(Quattro.ledBand(10), "yellow", "the yellow edge is >= 10");
  assert.equal(Quattro.ledBand(9.9), "red");
  assert.equal(Quattro.ledBand(0), "red");
  assert.equal(Quattro.ledBand(null), "red", "an absent reserve is the empty state, not green");
  assert.equal(Quattro.ledBand(undefined), "red");
});

test("litSegments: ten segments, rounded like the mockup, clamped, none without a reading", () => {
  assert.equal(Quattro.LED_COUNT, 10);
  assert.equal(Quattro.litSegments(100), 10);
  assert.equal(Quattro.litSegments(38), 4);
  assert.equal(Quattro.litSegments(35), 4);
  assert.equal(Quattro.litSegments(34), 3);
  assert.equal(Quattro.litSegments(5), 1);
  assert.equal(Quattro.litSegments(4), 0);
  assert.equal(Quattro.litSegments(0), 0);
  assert.equal(Quattro.litSegments(null), 0);
  assert.equal(Quattro.litSegments(1000), 10, "clamped at the top");
  assert.equal(Quattro.litSegments(-5), 0, "clamped at the bottom");
});

test("reserveReading: the battery shows the FREE percent of swap, and no swap is the empty state", () => {
  same(Quattro.reserveReading({ swapTotalKb: 1000, swapUsedKb: 250, swapPct: 25 }),
    { present: true, pct: 75 });
  same(Quattro.reserveReading({ swapTotalKb: 0, swapUsedKb: 0, swapPct: null }),
    { present: false, pct: 0 });
  same(Quattro.reserveReading(null), { present: false, pct: 0 });
});

// ---------------------------------------------------------------------------
// Dial geometry (the 240-degree dial from the mockup)
// ---------------------------------------------------------------------------

test("the dial geometry matches the mockup viewBox and sweep", () => {
  assert.equal(Quattro.DIAL.viewW, 260);
  assert.equal(Quattro.DIAL.viewH, 232);
  assert.equal(Quattro.DIAL.cx, 130);
  assert.equal(Quattro.DIAL.cy, 122);
  assert.equal(Quattro.DIAL.sweep, 240);
  assert.equal(Quattro.DIAL.a0, -120);
});

test("needleAngleDeg: 0 sits at -120 degrees, half at 0, full at 120, clamped both ends", () => {
  assert.equal(Quattro.needleAngleDeg(0), -120);
  assert.equal(Quattro.needleAngleDeg(0.25), -60);
  assert.equal(Quattro.needleAngleDeg(0.5), 0);
  assert.equal(Quattro.needleAngleDeg(0.75), 60);
  assert.equal(Quattro.needleAngleDeg(1), 120);
  assert.equal(Quattro.needleAngleDeg(-0.5), -120);
  assert.equal(Quattro.needleAngleDeg(1.5), 120);
  assert.equal(Quattro.needleAngleDeg(null), null, "no reading hides the needle, never parks it");
});

test("polar matches the mockup's angle convention", () => {
  const p = Quattro.polar(130, 122, 108, -120);
  assert.equal(Math.abs(p.x - 36.47) < 0.5, true, `expected x near 36.47, got ${p.x}`);
  assert.equal(Math.abs(p.y - 176.0) < 0.5, true, `expected y near 176, got ${p.y}`);
  const top = Quattro.polar(130, 122, 108, 0);
  assert.equal(Math.abs(top.x - 130) < 0.5, true);
  assert.equal(Math.abs(top.y - 14) < 0.5, true);
});

test("the PSI dial carries the amber 60-80 and red 80-100 zones; the fuel dial the red 0-10 zone", () => {
  same(Quattro.psiZoneArcs, [
    { from: 0.60, to: 0.80, kind: "amber" },
    { from: 0.80, to: 1.0, kind: "red" },
  ]);
  same(Quattro.fuelZoneArcs, [
    { from: 0.0, to: 0.10, kind: "red" },
  ]);
});

test("the dial tick ring is the mockup's 41 ticks with majors every tenth", () => {
  const ticks = Quattro.dialTicks();
  assert.equal(ticks.length, 41);
  assert.equal(ticks[0].major, true);
  assert.equal(ticks[10].major, true);
  assert.equal(ticks[20].major, true);
  assert.equal(ticks[40].major, true);
  assert.equal(ticks[5].major, false);
  assert.equal(ticks[5].mid, true);
  assert.equal(ticks[2].mid, false);
  assert.equal(Math.abs(ticks[0].f) < 1e-9, true);
  assert.equal(Math.abs(ticks[40].f - 1) < 1e-9, true);
});

test("the dial labels are the mockup's", () => {
  same(Quattro.psiLabels.map(l => l.t), ["0", "25", "50", "75", "100"]);
  same(Quattro.fuelLabels.map(l => l.t), ["E", "¼", "½", "¾", "F"]);
  assert.equal(Quattro.psiLabels[4].color, "redHi", "the 100 label reads hot");
  assert.equal(Quattro.fuelLabels[0].color, "redHi", "E reads hot");
  assert.equal(Quattro.fuelLabels[4].color, "green", "F reads green");
});

// ---------------------------------------------------------------------------
// Needle fractions and zones for the live readings
// ---------------------------------------------------------------------------

test("psiNeedleFrac and psiZone: the locked amber 60 / red 80 edges on PSI itself", () => {
  assert.equal(Quattro.psiNeedleFrac(68), 0.68);
  assert.equal(Quattro.psiNeedleFrac(105), 1);
  assert.equal(Quattro.psiNeedleFrac(-3), 0);
  assert.equal(Quattro.psiNeedleFrac(null), null);
  assert.equal(Quattro.psiZone(80), "red", "the red edge is >= 80");
  assert.equal(Quattro.psiZone(79.9), "amber");
  assert.equal(Quattro.psiZone(60), "amber");
  assert.equal(Quattro.psiZone(59.9), "green");
  assert.equal(Quattro.psiZone(null), null);
});

test("fuelNeedleFrac reads the percent free directly", () => {
  assert.equal(Quattro.fuelNeedleFrac(78), 0.78);
  assert.equal(Quattro.fuelNeedleFrac(0), 0);
  assert.equal(Quattro.fuelNeedleFrac(null), null);
});

// ---------------------------------------------------------------------------
// Popup content structure (round 4: two columns, label | sentence; round 5:
// the Metric row; copy verbatim from the approved mockup)
// ---------------------------------------------------------------------------

test("psiTip: the approved five rows with the live Now line and the /proc metric named", () => {
  const tip = Quattro.psiTip({ some_avg10: 12.8 });  assert.equal(tip.header, "RAM PRESSURE");
  same(tip.rows.map(r => r.label), ["Now:", "Metric:", "What:", "Why:", "Ranges:"]);
  assert.equal(Quattro.psiTip({ some_avg10: 68 }).rows[0].text, "68.0 PSI, amber, getting heavy.");
  assert.equal(tip.rows[1].text,
    "PSI is a real kernel metric. It stands for Pressure Stall Information and comes from /proc/pressure/memory in Linux. It reports the percent of time programs were stalled waiting for RAM, averaged over the last 10 seconds.");
  assert.equal(tip.rows[2].text,
    "We show the kernel\u2019s \u201csome\u201d average, meaning at least one program was stuck waiting for RAM. The scale is 0 to 100 because that is exactly how the kernel reports it.");
  assert.equal(tip.rows[3].text,
    "High pressure means the machine is starved for memory. Everything slows down and crashes get more likely.");
  assert.equal(tip.rows[4].text,
    "Green below 60. Amber from 60 to 80. Red at 80 and above, which needs attention now.");
});

test("psiTip: the zone words are the mockup's, and a missing reading says so instead of inventing one", () => {
  assert.equal(Quattro.psiTip({ some_avg10: 85 }).rows[0].text, "85.0 PSI, red, act now.");
  assert.equal(Quattro.psiTip({ some_avg10: 45 }).rows[0].text, "45.0 PSI, green, healthy.");
  assert.equal(Quattro.psiTip(null).rows[0].text, "no pressure reading yet.");
  assert.equal(Quattro.psiTip({}).rows[0].text, "no pressure reading yet.");
});

test("battTip: the approved four rows with the live Reserve line and the ranges stated", () => {
  const tip = Quattro.battTip({ present: true, pct: 38 });
  assert.equal(tip.header, "SWAP RESERVE");
  same(tip.rows.map(r => r.label), ["Reserve:", "What:", "Why:", "Ranges:"]);
  assert.equal(tip.rows[0].text, "38 percent remaining right now.");
  assert.equal(tip.rows[1].text,
    "Emergency swap is spare disk space the kernel uses when RAM runs out. It is the reserve that keeps the machine alive under memory pressure.");
  assert.equal(tip.rows[2].text,
    "When this reserve drains to empty, the system stops like a car out of fuel.");
  assert.equal(tip.rows[3].text,
    "Green at 25 percent or more. Yellow from 10 to 25. Red below 10. Right now: green.");
  assert.equal(Quattro.battTip({ present: true, pct: 9 }).rows[3].text.endsWith("Right now: red."), true);
  assert.equal(Quattro.battTip({ present: true, pct: 15 }).rows[3].text.endsWith("Right now: yellow."), true);
  assert.equal(Quattro.battTip({ present: true, pct: 15 }).rows[0].text, "15 percent remaining right now.");
});

test("battTip: a machine with no swap says so, honestly", () => {
  const tip = Quattro.battTip({ present: false, pct: 0 });
  assert.equal(tip.rows[0].text, "no swap is configured.");
});

test("fuelTip: the approved four rows with the live GB Now line", () => {
  const root = { target: "/", device: "/dev/nvme1n1p2", pctFree: 77, pctUsed: 23, availKb: 1501820186, sizeKb: 1950990074 };
  const tip = Quattro.fuelTip(root);
  assert.equal(tip.header, "ROOT DRIVE");
  same(tip.rows.map(r => r.label), ["Now:", "What:", "Why:", "Ranges:"]);
  assert.equal(tip.rows[0].text, "1538 GB free of 1998 GB (77 percent).");
  assert.equal(tip.rows[1].text,
    "Fuel shows free space on the root drive, the disk that holds the OS and your files. F means 100 percent free, E means none.");
  assert.equal(tip.rows[2].text,
    "When the root drive fills up the system can freeze or fail to write. Performance hinges on keeping it free.");
  assert.equal(tip.rows[3].text,
    "Red below 10 percent free. Keep the needle away from E.");
  assert.equal(Quattro.fuelTip(null).rows[0].text, "no root reading yet.");
});

test("gbFromKb rounds bytes to the GB the mockup prints", () => {
  assert.equal(Quattro.gbFromKb(1501820186), 1538);
  assert.equal(Quattro.gbFromKb(0), 0);
  assert.equal(Quattro.gbFromKb(null), null);
});

// ---------------------------------------------------------------------------
// Codes: the monitor's own live state, rendered as the approved taxonomy
// ---------------------------------------------------------------------------

test("codesFromReadings: a band-1 RAM reading is one moderate P-code with the locked Fix copy", () => {
  const codes = Quattro.codesFromReadings(
    { type: "ram", key: "ram", id: "mem-0aad21c9", band: 1, pct: 82.4 },
    null, []);
  assert.equal(codes.length, 1);
  const code = codes[0];
  assert.match(code.code, /^P\d{4}$/);
  assert.equal(code.sev, "a");
  assert.equal(code.issue, "System RAM reading 82 percent.");
  assert.equal(code.status, "moderate, over your amber ceiling.");
  assert.equal(code.fix, "click to send crash pattern to agent.");
  assert.equal(code.alert.band, 1);
  assert.equal(code.alert.type, "ram");
  assert.equal(code.alert.key, "ram");
  assert.equal(code.alert.id, "mem-0aad21c9");
});

test("codesFromReadings: band 2 and band 3 are severe, with the locked processing Fix copy", () => {
  for (const band of [2, 3]) {
    const codes = Quattro.codesFromReadings(
      { type: "ram", key: "ram", id: "mem-0aad21c9", band, pct: 96 }, null, []);
    assert.equal(codes.length, 1);
    assert.equal(codes[0].sev, "r");
    assert.equal(codes[0].status, "severe, over your red ceiling.");
    assert.equal(codes[0].fix, "agent has the crash pattern and is processing now.");
    assert.equal(codes[0].alert.band, band);
  }
});

test("codesFromReadings: VRAM is a C-code and the issue names the resource", () => {
  const codes = Quattro.codesFromReadings(
    null, { type: "vram", key: "vram", id: "mem-1a56a487", band: 1, pct: 95 }, []);
  assert.equal(codes.length, 1);
  assert.match(codes[0].code, /^C\d{4}$/);
  assert.equal(codes[0].issue, "VRAM reading 95 percent.");
});

test("codesFromReadings: each over-line drive is its own C-code, the target only rides the issue data", () => {
  const codes = Quattro.codesFromReadings(null, null, [
    { type: "hd", key: "partuuid:aabb", id: "mem-2b4e1c05", band: 1, pct: 91, target: "/mnt/models", ro: false },
    { type: "hd", key: "partuuid:ccdd", id: "mem-3f2a9b11", band: 2, pct: 97, target: "/", ro: false },
  ]);
  assert.equal(codes.length, 2);
  for (const code of codes) assert.match(code.code, /^C\d{4}$/);
  const severe = codes.find(c => c.sev === "r");
  const moderate = codes.find(c => c.sev === "a");
  assert.equal(severe.issue, "Drive / reading 97 percent.");
  assert.equal(moderate.issue, "Drive /mnt/models reading 91 percent.");
  assert.equal(severe.alert.target, "/");
});

test("codesFromReadings: healthy readings are no codes at all", () => {
  const codes = Quattro.codesFromReadings(
    { type: "ram", key: "ram", id: "mem-0aad21c9", band: 0, pct: 41 },
    { type: "vram", key: "vram", id: "mem-1a56a487", band: 0, pct: 12 },
    [{ type: "hd", key: "partuuid:aabb", id: "mem-2b4e1c05", band: 0, pct: 55, target: "/", ro: false }]);
  same(codes, []);
  same(Quattro.codesFromReadings(null, null, null), []);
});

test("codesFromReadings: the same condition always shows the same code, four digits wide", () => {
  const once = Quattro.codesFromReadings(
    { type: "ram", key: "ram", id: "mem-0aad21c9", band: 1, pct: 82 }, null, []);
  const twice = Quattro.codesFromReadings(
    { type: "ram", key: "ram", id: "mem-0aad21c9", band: 1, pct: 82 }, null, []);
  assert.equal(once[0].code, twice[0].code);
  const otherDrive = Quattro.codesFromReadings(null, null, [
    { type: "hd", key: "partuuid:zzzz", id: "mem-4c1d8e22", band: 1, pct: 88, target: "/srv", ro: false }]);
  assert.notEqual(otherDrive[0].code, once[0].code, "a different resource does not wear the same code");
});

test("codesFromReadings: severe rows sort ahead of moderate rows", () => {
  const codes = Quattro.codesFromReadings(
    { type: "ram", key: "ram", id: "mem-0aad21c9", band: 1, pct: 82 },
    { type: "vram", key: "vram", id: "mem-1a56a487", band: 2, pct: 96 }, []);
  assert.equal(codes[0].sev, "r");
  assert.equal(codes[1].sev, "a");
});

test("codesFromReadings: one column, most critical at the top, band descending under each severity", () => {
  // The captain's live-look ruling: red and amber codes share ONE column,
  // always most critical at the top. The list codesFromReadings returns is the
  // column: critical (band 3) above red (band 2) above every amber, code
  // ascending inside the same band so the order is stable.
  const codes = Quattro.codesFromReadings(
    { type: "ram", key: "ram", id: "mem-0aad21c9", band: 1, pct: 82 },
    { type: "vram", key: "vram", id: "mem-1a56a487", band: 3, pct: 99 },
    [
      { type: "hd", key: "partuuid:aa01", id: "mem-2b4e1c05", band: 2, pct: 97, target: "/" },
      { type: "hd", key: "partuuid:aa02", id: "mem-3c5f2d16", band: 1, pct: 84, target: "/mnt/backup" },
      { type: "hd", key: "partuuid:aa03", id: "mem-4d603e27", band: 3, pct: 99, target: "/mnt/models" },
    ]);
  same(codes.map(c => c.sev + c.band), ["r3", "r3", "r2", "a1", "a1"]);
});

test("codesFromReadings: two ambers and no red are one amber list, with no empty section anywhere", () => {
  const codes = Quattro.codesFromReadings(
    { type: "ram", key: "ram", id: "mem-0aad21c9", band: 1, pct: 82 },
    null,
    [{ type: "hd", key: "partuuid:aa02", id: "mem-3c5f2d16", band: 1, pct: 84, target: "/mnt/backup" }]);
  assert.equal(codes.length, 2);
  for (const code of codes) assert.equal(code.sev, "a");
  assert.equal(Quattro.codesHeadToken(codes), "amber", "the one head tints amber when only amber codes show");
});

test("codesHeadToken: the single check-engine head tints by the most severe code showing", () => {
  const make = (ram, vram, devices) => Quattro.codesFromReadings(ram, vram, devices);
  assert.equal(Quattro.codesHeadToken([]), "dim", "no codes is the unlit emblem, not an empty red section");
  assert.equal(
    Quattro.codesHeadToken(make({ type: "ram", key: "ram", id: "mem-0aad21c9", band: 1, pct: 82 }, null, [])),
    "amber");
  assert.equal(
    Quattro.codesHeadToken(make(null, null, [{ type: "hd", key: "partuuid:aa01", id: "mem-2b4e1c05", band: 2, pct: 97, target: "/" }])),
    "red");
  assert.equal(
    Quattro.codesHeadToken(make(
      { type: "ram", key: "ram", id: "mem-0aad21c9", band: 1, pct: 82 },
      null,
      [{ type: "hd", key: "partuuid:aa01", id: "mem-2b4e1c05", band: 2, pct: 97, target: "/" }])),
    "red", "one red code outranks every amber on the head");
});

test("codesEmptyText: the empty column says the machine is clear, in the terse register", () => {
  assert.equal(Quattro.codesEmptyText(), "all clear.");
});

// ---------------------------------------------------------------------------
// VRAM COOLANT (the captain's live-look item 3): the fourth instrument. The
// fill mirrors Mount Monitor's PR-18 tank semantics, sampled from this
// plugin's own nvidia-smi reading, floored by this plugin's own
// vramFloorMib setting. The captain's 2026-11-06 defaults steer set the
// card's own band lines: red below 500 MiB free, amber below 1500 MiB free
// when unset (a fixed 1000 MiB approach margin above the floor); the bar
// telltale keeps its own 3400 default.
// ---------------------------------------------------------------------------

test("coolantFill: free VRAM above the floor, as a fraction of everything above it (the PR-18 semantics)", () => {
  assert.equal(Quattro.coolantFill(3400, 8186, 3400), 0, "at the floor the tank is empty");
  assert.equal(Quattro.coolantFill(8186, 8186, 3400), 1, "at capacity the tank is full");
  const half = Quattro.coolantFill(3400 + (8186 - 3400) / 2, 8186, 3400);
  assert.equal(Math.abs(half - 0.5) < 1e-9, true, "half the headroom is half a tank");
  assert.equal(Quattro.coolantFill(1000, 8186, 3400), 0, "below the floor clamps to empty, never negative");
  assert.equal(Quattro.coolantFill(9000, 8186, 3400), 1, "above capacity clamps to full");
  assert.equal(Quattro.coolantFill(1000, 8186, 9000), 0, "a floor at or above capacity leaves no usable headroom");
  assert.equal(Quattro.coolantFill(null, 8186, 3400), 0, "no reading is an empty tank, not a lie");
  assert.equal(Quattro.coolantFill(4000, 0, 3400), 0, "no capacity is an empty tank");
});

test("coolantFill agrees with Mount Monitor's PR-18 fill on the same numbers", () => {
  // Conformance law: the coolant tank level and the bar telltale cannot
  // disagree about what the same free/total/floor means. The fill is the
  // shared decision and stays a case-for-case mirror of mounts.js
  // vramHeadroomFrac. The band is not mirrored: the captain's defaults steer
  // gave the card its own lines (see the coolantBand tests below).
  const cases = [
    [3400, 8186, 3400], [8186, 8186, 3400], [1000, 8186, 3400], [4186, 8186, 3400],
    [5000, 8186, 3400], [6000, 8186, 3400], [7500, 8186, 3400], [1000, 8186, 9000],
    [3399, 8186, 3400], [4100, 24576, 3400], [9000, 24576, 3400],
    [600, 8186, 500], [1500, 8186, 500], [4211, 8186, 500],
  ];
  for (const [free, total, floor] of cases) {
    assert.equal(Quattro.coolantFill(free, total, floor), Mounts.vramHeadroomFrac(free, total, floor),
      `coolantFill(${free}, ${total}, ${floor}) must equal mounts.js vramHeadroomFrac`);
  }
});

test("coolantBand: the captain's lines, red below the floor, amber 1000 MiB above it, green above that, no reading is null", () => {
  const total = 8186;
  // The unset defaults, exactly the steer's numbers: red at 500, amber at 1500.
  assert.equal(Quattro.coolantBand(null, total, 500), null, "a missing reading never draws as healthy");
  assert.equal(Quattro.coolantBand(499, total, 500), 2, "below the 500 floor is red");
  assert.equal(Quattro.coolantBand(500, total, 500), 1, "at the floor the approach zone opens");
  assert.equal(Quattro.coolantBand(1499, total, 500), 1, "1499 free is amber, one under the 1500 line");
  assert.equal(Quattro.coolantBand(1500, total, 500), 0, "1500 free is green, the steer's amber line");
  // A raised floor moves both lines, the margin staying 1000 MiB.
  assert.equal(Quattro.coolantBand(1999, total, 2000), 2, "below a raised floor is red");
  assert.equal(Quattro.coolantBand(2999, total, 2000), 1, "the approach zone rides the floor");
  assert.equal(Quattro.coolantBand(3000, total, 2000), 0, "floor plus margin is green");
  // One deliberate difference from the bar telltale on a missing reading: the
  // telltale's rawVramBand says 0 (no alarm), the gauge says null (an
  // unavailable reading never draws as healthy). Both honest, neither a 0% lie.
  assert.equal(Mounts.rawVramBand(null, total, 500), 0);
});

test("coolantTip: the four-row teaching decode with the live level and the floor named", () => {
  const tip = Quattro.coolantTip({ present: true, freeMib: 4211, totalMib: 8186 }, 500);
  assert.equal(tip.header, "VRAM COOLANT");
  same(tip.rows.map(r => r.label), ["Now:", "What:", "Why:", "Ranges:"]);
  assert.equal(tip.rows[0].text, "4211 MiB free of 8186 MiB. Floor 500 MiB.");
  assert.equal(tip.rows[3].text.endsWith("vramFloorMib setting, 500 MiB unset."), true,
    "the ranges row names the setting and the default");
  assert.equal(tip.rows[3].text.startsWith("Red below the floor. Amber within 1000 MiB of the floor above it."), true,
    "the ranges row teaches the fixed margin, not a fraction of total");
  const empty = Quattro.coolantTip(null, 500);
  assert.equal(empty.rows[0].text, "no VRAM reading yet.", "a missing reading is said, not drawn as zero");
  const unset = Quattro.coolantTip({ present: true, freeMib: 900, totalMib: 8186 });
  assert.equal(unset.rows[0].text, "900 MiB free of 8186 MiB. Floor 500 MiB.",
    "no floor argument falls back to the steer's 500 default");
});

test("codeTip: the approved three-row decode with the severity color class", () => {
  const codes = Quattro.codesFromReadings(
    { type: "ram", key: "ram", id: "mem-0aad21c9", band: 2, pct: 96 }, null, []);
  const tip = Quattro.codeTip(codes[0]);
  assert.equal(tip.header, codes[0].code);
  assert.equal(tip.sev, "r");
  same(tip.rows.map(r => r.label), ["Issue:", "Status:", "Fix:"]);
  assert.equal(tip.rows[2].text, "agent has the crash pattern and is processing now.");
});

// ---------------------------------------------------------------------------
// Dispatch toast (the approved copy, verbatim)
// ---------------------------------------------------------------------------

test("dispatchToast: the approved toast copy, with the processing words on severe", () => {
  const mild = Quattro.dispatchToast("P0420", false);
  assert.equal(mild.mark, "\u2713");
  assert.equal(mild.code, "P0420");
  assert.equal(mild.text, "to firstmate (default agent)");
  const severe = Quattro.dispatchToast("C1500", true);
  assert.equal(severe.text, "to firstmate (default agent), processing now");
});

test("dispatchRefused: a refused severe click names why, on shouldStartArm's own tokens", () => {
  assert.equal(Quattro.dispatchRefused("C1500", "guard-off").text, "not sent. the guard is off.");
  assert.equal(Quattro.dispatchRefused("C1500", "arm-live").text, "not sent. an agent is already on it.");
  assert.equal(Quattro.dispatchRefused("C1500", "no-headroom").text, "not sent. no memory headroom.");
  assert.equal(Quattro.dispatchRefused("C1500", "not-writer").text, "not sent. another screen owns the guard.");
  const unknown = Quattro.dispatchRefused("C1500", "");
  assert.equal(unknown.mark, "\u2717");
  assert.equal(unknown.code, "C1500");
  assert.equal(unknown.text, "not sent.");
});

test("codesFromReadings: an hd alert carries the device data the dispatch prompt's data block needs", () => {
  const entry = {
    type: "hd", key: "partuuid:aabb", id: "mem-2b4e1c05", band: 2, pct: 97,
    target: "/", device: "/dev/sda2", fstype: "btrfs", label: "OMARCHY",
    partlabel: "OMARCHY_ROOT", sizeKb: 1000, usedKb: 700, availKb: 300,
    ro: false, latched: true,
  };
  const alert = Quattro.codesFromReadings(null, null, [entry])[0].alert;
  same(alert, {
    kind: "alert", band: 2, type: "hd", key: "partuuid:aabb", id: "mem-2b4e1c05",
    pct: 97, target: "/", device: "/dev/sda2", fstype: "btrfs", label: "OMARCHY",
    partlabel: "OMARCHY_ROOT", sizeKb: 1000, usedKb: 700, availKb: 300,
    ro: false, latched: true,
  });
});

test("the dashboard dispatch builds the same prompt the toast dispatch builds", () => {
  const entry = {
    type: "hd", key: "partuuid:aabb", id: "mem-2b4e1c05", band: 2, pct: 97,
    target: "/", device: "/dev/sda2", fstype: "btrfs", label: "OMARCHY",
    partlabel: "OMARCHY_ROOT", sizeKb: 1000, usedKb: 700, availKb: 300,
    ro: false, latched: false,
  };
  const dashAlert = Quattro.codesFromReadings(null, null, [entry])[0].alert;
  const dashPrompt = Memory.agentPrompt(dashAlert, null, null, "/log");
  const toastAlert = Object.assign({ kind: "band" }, entry);
  const toastPrompt = Memory.agentPrompt(toastAlert, null, null, "/log");
  assert.equal(dashPrompt, toastPrompt, "one alert, one prompt, whichever surface dispatched it");
  assert.match(dashPrompt, /\/dev\/sda2/, "the device rides the data block, not an empty string");
  assert.match(dashPrompt, /OMARCHY_ROOT/);
});

// ---------------------------------------------------------------------------
// Symbols and palette (the ISO artwork from the approved mockup)
// ---------------------------------------------------------------------------

test("the four ISO symbols ship with their viewBox and fill/stroke items", () => {
  for (const id of ["temp", "fuel", "battery", "mil"]) {
    const sym = Quattro.SYMBOLS[id];
    assert.notEqual(sym, undefined, `symbol ${id} is missing`);
    assert.equal(sym.viewBox.length, 4, `${id} needs its four-number SVG viewBox`);
    assert.equal(sym.items.length >= 1, true, `${id} needs items`);
    for (const item of sym.items) {
      assert.equal(typeof item.d, "string", `${id} item needs a path string`);
      assert.match(item.d, /^[Mm]/, `${id} item path must start with a moveto`);
      if (item.stroke) assert.equal(typeof item.width, "number", `${id} stroke item needs a width`);
      else assert.equal(item.fill, true, `${id} non-stroke item is a fill item`);
    }
  }
  assert.equal(Quattro.SYMBOLS.mil.items.length, 1, "the MIL emblem is one filled path");
  assert.equal(Quattro.SYMBOLS.battery.items.some(i => i.stroke && i.width === 10), true,
    "the battery outline is the 10-wide stroke from the mockup");
  assert.equal(Quattro.SYMBOLS.temp.items.some(i => i.stroke && i.width === 11), true,
    "the temp symbol's ribs are the 11-wide strokes from the mockup");
  assert.equal(Quattro.SYMBOLS.fuel.items.some(i => i.stroke && i.width === 10), true);
  assert.equal(Quattro.SYMBOLS.fuel.items.find(i => i.stroke && i.width === 10).fill, true,
    "the fuel outline sits in the mockup's fill parent, so it fills and strokes");
});

test("the fuel nozzle subpath is the mockup's relative lineto, not an absolute one", () => {
  // The mockup reads `M157.64 55.626 9.4547 80.332c...`: a lowercase moveto's
  // implicit second pair is a RELATIVE lineto. Transcribed under an uppercase M
  // that pair becomes absolute and the nozzle lands off-canvas. The zero
  // reference is the moveto pair itself; what follows must start with `l`.
  const item = Quattro.SYMBOLS.fuel.items.find(i => i.stroke && i.width === 10);
  const at = item.d.indexOf("M157.64 55.626");
  assert.notEqual(at, -1, "the nozzle subpath is part of the fuel outline");
  assert.match(item.d.slice(at + "M157.64 55.626".length), /^l9\.4547 80\.332c/,
    "the nozzle's second pair must be the mockup's relative lineto");
});

test("the reserved spares are a record, not a rendered row", () => {
  // The captain's live-look ruling: future additions are not visible on the
  // dashboard. The SPARES record (the caption and the three unlit telltales the
  // approved footer once showed) stays in quattro.js as the note of what is
  // held back, and the panel no longer draws any of it.
  assert.equal(Quattro.SPARES.caption, "FUTURE LANES (RESERVED)");
  same(Quattro.SPARES.symbols, ["oil", "thermo", "tri"]);
  const PANEL = repoFile("memory-monitor/QuattroDash.qml");
  assert.equal(PANEL.includes("Quattro.SPARES"), false,
    "the reserved spares row is not rendered on the dash");
  assert.equal(PANEL.includes(Quattro.SPARES.caption), false,
    "the reserved caption appears nowhere on the dash");
  for (const id of Quattro.SPARES.symbols) {
    const sym = Quattro.SYMBOLS[id];
    assert.notEqual(sym, undefined, `reserved-lane symbol ${id} stays in the record as artwork`);
    assert.equal(PANEL.includes(`"${id}"`), false, `the reserved symbol ${id} is not placed on the dash`);
  }
});

test("the thermometer body keeps the mockup's full tick-bump run into the bulb neck", () => {
  // The stem's ticks are a run of bump pairs the mockup draws explicitly before
  // the bulb neck; collapsing the run into one smooth curve shortens the stem
  // and lifts the bulb entry off the approved artwork. The artwork is an owned
  // transcription contract, pinned like the fuel nozzle's relative lineto.
  const body = Quattro.SYMBOLS.thermo.items[1];
  assert.match(body.d,
    /1\.216,1\.216h1\.96v6\.148h-1\.96c-0\.672,0-1\.216,0\.543-1\.216,1\.215s/,
    "the bump run into the bulb neck is the mockup's, not a collapsed smooth curve");
});

test("the palette carries the approved mockup hexes", () => {
  assert.equal(Quattro.PAL.amber, "#e3b341");
  assert.equal(Quattro.PAL.redHot, "#ff3b30");
  assert.equal(Quattro.PAL.green, "#3fb950");
  assert.equal(Quattro.PAL.needle, "#ff6b6f");
  assert.equal(Quattro.PAL.hub, "#e5484d");
  assert.equal(Quattro.PAL.tooltipBg, "#0a0e13");
  assert.equal(Quattro.PAL.mut, "#8b949e");
  assert.equal(Quattro.PAL.line, "#30363d");
  assert.equal(Quattro.PAL.faceSym, "#59646f");
});

// ---------------------------------------------------------------------------
// The language rule (round 4): NO em dashes, NO en dashes, NO semicolons in
// human-facing text. Scanned over every copy output this module can produce.
// ---------------------------------------------------------------------------

test("the language rule holds over every string the popup copy can produce", () => {
  const texts = [];
  const pushTip = tip => { texts.push(tip.header); for (const row of tip.rows) texts.push(row.label, row.text); };

  pushTip(Quattro.psiTip(null));
  pushTip(Quattro.psiTip({}));
  for (const psi of [0, 12.8, 45, 60, 79.5, 85, 100]) pushTip(Quattro.psiTip({ some_avg10: psi }));
  pushTip(Quattro.battTip({ present: false, pct: 0 }));
  for (const pct of [0, 5, 9.9, 10, 15, 24.9, 25, 60, 100]) pushTip(Quattro.battTip({ present: true, pct }));
  pushTip(Quattro.fuelTip(null));
  for (const pctFree of [0, 9.9, 10, 45, 77, 100]) {
    pushTip(Quattro.fuelTip({ target: "/", device: "/dev/sda1", pctFree, pctUsed: 100 - pctFree, availKb: 123456789, sizeKb: 987654321 }));
  }
  pushTip(Quattro.coolantTip(null, 3400));
  for (const freeMib of [0, 1000, 3399, 3400, 3800, 4211, 8186]) {
    pushTip(Quattro.coolantTip({ present: true, freeMib, totalMib: 8186 }, 3400));
  }
  texts.push(Quattro.codesEmptyText());

  for (const band of [1, 2, 3]) {
    for (const entry of [
      { type: "ram", key: "ram", id: "mem-0aad21c9", band, pct: 82 },
      { type: "vram", key: "vram", id: "mem-1a56a487", band, pct: 95 },
      { type: "hd", key: "partuuid:aabb", id: "mem-2b4e1c05", band, pct: 91, target: "/mnt/models", ro: false },
    ]) {
      const codes = Quattro.codesFromReadings(
        entry.type === "ram" ? entry : null,
        entry.type === "vram" ? entry : null,
        entry.type === "hd" ? [entry] : []);
      for (const code of codes) {
        texts.push(code.issue, code.status, code.fix);
        pushTip(Quattro.codeTip(code));
      }
    }
  }

  texts.push(Quattro.dispatchToast("P0420", false).text);
  texts.push(Quattro.dispatchToast("C1500", true).text);
  for (const why of ["guard-off", "arm-live", "no-headroom", "not-writer", ""]) {
    texts.push(Quattro.dispatchRefused("C1500", why).text);
  }
  texts.push(Quattro.SPARES.caption);
  texts.push(Quattro.INSTRUMENTS.psi, Quattro.INSTRUMENTS.batt, Quattro.INSTRUMENTS.fuel, Quattro.INSTRUMENTS.coolant);

  const bad = texts.filter(t => /[\u2014\u2013;]/.test(t));
  assert.deepEqual(bad, [], `em dashes, en dashes and semicolons are banned from UI copy: ${JSON.stringify(bad)}`);
});

// ---------------------------------------------------------------------------
// rootDriveReading — memory.js's one dashboard reading: the root row of the
// findmnt table, on a real device, in percent FREE.
// ---------------------------------------------------------------------------

const FINDMNT_ROW = (source, target, used, avail, usepct, options, partuuid, uuid, label, partlabel) =>
  [source, target, "btrfs", used, avail, usepct, options, partuuid, uuid, label, partlabel].join(" ");

test("rootDriveReading: the root row on a real device, in percent free, subvolume suffix stripped", () => {
  const text = [
    FINDMNT_ROW("/dev/nvme1n1p2[/@]", "/", "459949965312", "1537868070912", "23%",
      "rw,noatime,compress=zstd:3", "-", "2d60739b-cf79-4b41-b4d7-678fe8712181", "OMARCHY-NEW", "OMARCHY_ROOT_NEW"),
    FINDMNT_ROW("/dev/sda1", "/mnt/backup", "100", "900", "10%", "rw", "-", "-", "backup", "-"),
  ].join("\n");
  const reading = Memory.rootDriveReading(text);
  assert.notEqual(reading, null);
  assert.equal(reading.type, "root");
  assert.equal(reading.target, "/");
  assert.equal(reading.device, "/dev/nvme1n1p2", "the [/@] subvolume suffix is stripped");
  assert.equal(reading.pctUsed, 23);
  assert.equal(reading.pctFree, 77);
  assert.equal(reading.usedKb, Math.round(459949965312 / 1024));
  assert.equal(reading.availKb, Math.round(1537868070912 / 1024));
  assert.equal(reading.sizeKb, reading.usedKb + reading.availKb);
});

test("rootDriveReading: a tmpfs root is no root at all, and a missing root is null", () => {
  const tmpfsOnly = FINDMNT_ROW("tmpfs", "/", "0", "1000000", "0%", "rw", "-", "-", "-", "-");
  assert.equal(Memory.rootDriveReading(tmpfsOnly), null,
    "a pseudo filesystem behind / never draws the fuel needle");
  assert.equal(Memory.rootDriveReading(""), null);
  assert.equal(Memory.rootDriveReading(FINDMNT_ROW("/dev/sda1", "/mnt/backup", "100", "900", "10%", "rw", "-", "-", "backup", "-")), null,
    "only the root target feeds the fuel gauge");
});

test("rootDriveReading: a full root reads zero free, and the real device row wins over pseudo rows", () => {
  const full = FINDMNT_ROW("/dev/sda2", "/", "1000", "0", "100%", "rw", "-", "-", "-", "-");
  const reading = Memory.rootDriveReading(full);
  assert.equal(reading.pctFree, 0);
  assert.equal(reading.pctUsed, 100);
});

// ---------------------------------------------------------------------------
// Delegation: the panel draws, the decisions stay here, and the installer
// ships both new files.
// ---------------------------------------------------------------------------

test("QuattroDash.qml asks Quattro.* for every decision and writes no sentence of its own", () => {
  const PANEL = repoFile("memory-monitor/QuattroDash.qml");
  for (const call of [
    "Quattro.psiTip(", "Quattro.battTip(", "Quattro.fuelTip(", "Quattro.coolantTip(",
    "Quattro.codeTip(", "Quattro.codesFromReadings(", "Quattro.dispatchToast(",
    "Quattro.litSegments(", "Quattro.ledBand(", "Quattro.INSTRUMENTS", "Quattro.PAL",
    "Quattro.psiZoneArcs", "Quattro.fuelZoneArcs", "Quattro.dialTicks(",
    "Quattro.needleAngleDeg(", "Quattro.psiNeedleFrac(", "Quattro.fuelNeedleFrac(",
    "Quattro.reserveReading(", "Quattro.coolantFill(", "Quattro.coolantBand(",
    "Quattro.codesHeadToken(", "Quattro.codesEmptyText(",
  ]) {
    assert.equal(PANEL.includes(call), true, `QuattroDash.qml must ask ${call} instead of deciding locally`);
  }
  // The codes column is ONE column, most critical at the top: the panel renders
  // the codesFromReadings list directly and keeps no per-severity models of its
  // own (the captain's live-look ruling; the old amber and red columns are gone).
  assert.equal(PANEL.includes("model: root.codes"), true, "the single column renders the merged code list");
  assert.equal(PANEL.includes("amberCodes"), false, "no separate amber column model survives");
  assert.equal(PANEL.includes("severeCodes"), false, "no separate red column model survives");
  // Every instrument's hover must call the tip declared on the id it names: a
  // call into an id with no tip function throws on hover and that
  // instrument's tooltip never shows (the swap hover bug). Each <id>.tip()
  // call needs a `function tip()` declared on the <id> object itself, so the
  // search stays inside that object's own braces.
  const declared = new Set([...PANEL.matchAll(/^\s*id:\s*(\w+)/gm)].map(m => m[1]));
  const called = [...PANEL.matchAll(/\b(\w+)\.tip\(\)/g)].map(m => m[1]);
  assert.equal(called.length >= 4, true, "psi, batt, fuel and the coolant all hover for their decode");
  for (const id of called) {
    assert.equal(tipDeclaredOn(PANEL, id), true,
      `the ${id} hover calls a tip declared on the ${id} object itself`);
    assert.equal(declared.has(id), true, `${id} is an id in this panel`);
  }
  // The ISO artwork comes from quattro.js through QuattroSymbol.qml - the panel
  // renders it, it does not carry it.
  assert.equal(PANEL.includes("QuattroSymbol {"), true, "the panel renders symbols through QuattroSymbol");
  const SYMBOL_FILE = repoFile("memory-monitor/QuattroSymbol.qml");
  assert.equal(SYMBOL_FILE.includes("Quattro.SYMBOLS"), true, "the symbol artwork is quattro.js data");
  assert.equal(/"[MmLlHhVvCcSsQqTtAaZz] ?[-\d.]/.test(SYMBOL_FILE), false,
    "no path geometry lives in the QML: the artwork has one source");
  // The dispatch runs the same fixed agent prompt the toasts send, through
  // memory.js. The panel builds no prompt words of its own.
  assert.equal(PANEL.includes("Memory.agentArgv("), true);
  assert.equal(PANEL.includes("Memory.agentPrompt("), true);
  // A severe code's click dispatches through the widget's arm gate, not around
  // it: the arm's single-flight check is what keeps a second agent off the
  // machine while one is armed.
  assert.equal(PANEL.includes("Memory.isArmNotice("), true);
  assert.equal(PANEL.includes("callMonitor(\"dispatchCriticalCode\""), true);
  assert.equal(PANEL.includes("Quickshell.execDetached("), true);
  // No fixed sentence lives in the panel except its own log lines.
  const longLiterals = PANEL.split("\n").filter(line =>
    /"[^"\n]{40,}"/.test(line) && !/console\.(warn|log|info|error)/.test(line));
  assert.deepEqual(longLiterals, [], "no fixed sentence lives in the dashboard panel");
});

test("the widget carries the coolant floor and the panel reads it through memory.js", () => {
  const QML = repoFile("memory-monitor/MemoryMonitor.qml");
  assert.match(QML, /function vramFloorMib\(\): int \{/, "the widget exposes the floor the PR-18 way");
  assert.match(QML, /Memory\.vramFloorMib\(setting\("vramFloorMib", null\)\)/,
    "the floor is this plugin's own vramFloorMib setting through the memory.js normalizer");
  const PANEL = repoFile("memory-monitor/QuattroDash.qml");
  assert.equal(PANEL.includes("vramFloorMib"), true, "the dash reads the floor from the widget");
});

test("the bar widget mounts the dashboard and the badge opens it", () => {
  const QML = repoFile("memory-monitor/MemoryMonitor.qml");
  assert.equal(QML.includes('Qt.resolvedUrl("QuattroDash.qml")'), true,
    "the dashboard mounts through its own Loader like MemoryPanel does");
  assert.equal(QML.includes("dashLoader"), true);
  // The badge click opens the dashboard (round 2: the user clicks the emblem).
  assert.match(QML, /onPressed:[^]*?togglePanel\(\)/, "the badge's onPressed opens the panel");
  // The emblem still asks RingKit for its severity parameters.
  assert.equal(QML.includes("RingKit.badgeParams("), true);
  assert.equal(QML.includes("RingKit.paletteToken("), true);
  // The critical-click IPC path still opens the detail window.
  assert.equal(QML.includes("function showDetail(): void {"), true);
  assert.equal(QML.includes("panelLoader.item.open()"), true);
  // The readings the dashboard needs are on the widget, from memory.js.
  assert.equal(QML.includes("Memory.rootDriveReading("), true);
  assert.equal(QML.includes("rootReading"), true);
});

test("install.sh ships the dashboard beside the widget", () => {
  const INSTALL = repoFile("memory-monitor/install.sh");
  for (const file of ["QuattroDash.qml", "QuattroSymbol.qml", "CardBar.qml", "quattro.js", "MemoryPanel.qml", "memory.js", "ringkit.js"]) {
    assert.equal(INSTALL.includes(file), true, `install.sh must copy ${file}`);
  }
});

test("run.sh lints the dashboard panel too", () => {
  const RUN = repoFile("memory-monitor/tests/run.sh");
  assert.equal(RUN.includes("QuattroDash.qml"), true);
});
