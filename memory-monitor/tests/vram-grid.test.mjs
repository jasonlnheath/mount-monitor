// The VRAM per-process hover grid (the popover on the QuattroDash VRAM lane).
//
// The plugin already collects per-process GPU memory inside every VRAM sample
// (memory.js parseNvidiaApps: pid + processName + usedMib); the approved
// feature surfaces it on hover. The contract pinned here: the row assembly
// (top three by MiB held, sorted descending, then one remainder row labelled
// exactly "Other", then the total row matching the dial), the shortened
// process names, the honest fallback (an empty or unsupported list is NO grid,
// so the panel keeps the plain free-percent tip), and the panel wiring (the
// popover renders quattro.js rows in the existing tip card; a fresh sample
// re-renders the open popover in place, and the hover is the whole feature).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Quattro, Memory, repoFile, same } from "./load.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

const READING = { vramTotalMib: 16384, vramUsedMib: 11000, vramFreeMib: 5384, pct: 67.1 };

const APPS = (pairs) => pairs.map(([name, used], i) => ({ pid: 100 + i, processName: name, usedMib: used }));

test("vramAppsGrid: five apps become top three descending, Other, then the dial's total", () => {
  const grid = Quattro.vramAppsGrid(
    APPS([["chrome", 3000], ["blender", 5200], ["codex", 900], ["python3", 210], ["Xorg", 640]]),
    READING, 500, 1500);
  assert.equal(grid.header, "VRAM BY PROCESS");
  same(grid.rows.map(r => r.label), ["blender", "chrome", "codex", "Other", "Total"],
    "top three by MiB held, then the one Other row, then Total");
  same(grid.rows.map(r => r.mib), ["5200 MiB", "3000 MiB", "900 MiB", "850 MiB", "11000 MiB"]);
  // Percent is of TOTAL VRAM, not of used, one decimal.
  same(grid.rows.map(r => r.pct), ["31.7%", "18.3%", "5.5%", "5.2%", "67.1%"]);
  assert.equal(grid.rows[3].cls, undefined, "the Other row is a plain grid row");
  assert.equal(grid.rows[4].cls, "grid-total", "the total row wears the total class");
  assert.equal(grid.rows[4].mib, "11000 MiB", "the total row is the dial's used number");
  assert.equal(grid.rows[4].pct, "67.1%", "the total row's percent is the dial's percent");
});

test("the total row matches the dial even when the apps' sum exceeds used", () => {
  // Shared contexts and double-counted processes can push the per-process sum
  // past the GPU's own used number; the total row never rides that sum.
  const grid = Quattro.vramAppsGrid(
    APPS([["chrome", 8000], ["blender", 7000], ["codex", 3000], ["Xorg", 500]]),
    READING, 500, 1500);
  assert.equal(grid.rows[3].mib, "500 MiB", "the Other row sums only what fell below the cut");
  assert.equal(grid.rows[4].mib, "11000 MiB",
    "the total row is the reading's used, never the apps' 18500 MiB sum");
});

test("three apps exactly: every app on its own row, no Other row", () => {
  const grid = Quattro.vramAppsGrid(
    APPS([["chrome", 3000], ["blender", 5200], ["codex", 900]]),
    READING, 500, 1500);
  same(grid.rows.map(r => r.label), ["blender", "chrome", "codex", "Total"]);
});

test("the remainder row's label is exactly Other, never a sentence", () => {
  const grid = Quattro.vramAppsGrid(
    APPS([["a", 10], ["b", 9], ["c", 8], ["d", 7], ["e", 6], ["f", 5]]),
    READING, 500, 1500);
  assert.equal(grid.rows[3].label, "Other");
  assert.equal(grid.rows[3].mib, "18 MiB", "four leftovers sum into the one Other row");
});

test("empty, missing or unsupported list: no grid at all, the plain tip stays", () => {
  // No NVML (apps never sampled), an idle GPU with no compute processes, or a
  // junk shape - each must yield null so the panel falls back to the
  // free-percent coolant tip rather than a broken or empty popover.
  assert.equal(Quattro.vramAppsGrid(null, READING, 500, 1500), null);
  assert.equal(Quattro.vramAppsGrid(undefined, READING, 500, 1500), null);
  assert.equal(Quattro.vramAppsGrid([], READING, 500, 1500), null);
  assert.equal(Quattro.vramAppsGrid(APPS([["chrome", 3000]]), null, 500, 1500), null,
    "no reading means no total to match the dial against");
  assert.equal(Quattro.vramAppsGrid(APPS([["chrome", 3000]]), { vramTotalMib: 0, vramUsedMib: 0 }, 500, 1500), null);
  // Rows that cannot produce a number are skipped, not drawn as dashes:
  // nvidia-smi never emits them, and a junk row must not crowd the grid.
  assert.equal(Quattro.vramAppsGrid([{ pid: 1, processName: "chrome", usedMib: "junk" }], READING, 500, 1500), null);
  const mixed = Quattro.vramAppsGrid(
    [{ pid: 1, processName: "chrome", usedMib: 3000 }, { pid: 2, processName: "junk", usedMib: "junk" }],
    READING, 500, 1500);
  same(mixed.rows.map(r => r.label), ["chrome", "Total"]);
});

test("shortAppName: basename only, capped with an ellipsis, empty is unknown", () => {
  assert.equal(Quattro.shortAppName("chrome"), "chrome");
  assert.equal(Quattro.shortAppName("/usr/lib/xorg/Xorg"), "Xorg", "a path shortens to its basename");
  const long = "a-very-long-process-name-well-past-the-card";
  assert.equal(Quattro.shortAppName(long), long.slice(0, 21) + "...",
    "a long name caps at 24 characters including the ellipsis");
  assert.equal(Quattro.shortAppName(""), "unknown");
  assert.equal(Quattro.shortAppName("/tmp/"), "unknown", "a basename of nothing is unknown");
  assert.equal(Quattro.shortAppName(null), "unknown");
  // Machine data stays sanitized: control characters, bidi overrides and the
  // angle brackets that could forge a delimiter never survive.
  assert.equal(Quattro.shortAppName("we\u0008ird"), "we ird", "control characters become spaces");
  assert.equal(Quattro.shortAppName("bad\u202Ename"), "bad name");
  assert.equal(Quattro.shortAppName("<img>src"), "img src", "angle brackets become spaces, like every sanitizeText");
});

test("sort: descending by MiB, ties keep the sample's order", () => {
  const grid = Quattro.vramAppsGrid(
    APPS([["first", 1000], ["second", 1000], ["third", 900], ["fourth", 2000]]),
    READING, 500, 1500);
  same(grid.rows.map(r => r.label), ["fourth", "first", "second", "Other", "Total"],
    "equal MiB keeps the order the sample listed them in");
});

test("the header's severity rides the coolant pair, like the plain tip", () => {
  const apps = APPS([["chrome", 3000]]);
  assert.equal(Quattro.vramAppsGrid(apps, READING, null, null).sev, "", "no pair, no tint");
  assert.equal(Quattro.vramAppsGrid(apps, { vramTotalMib: 16384, vramUsedMib: 11000, vramFreeMib: 300 }, 500, 1500).sev, "r");
  assert.equal(Quattro.vramAppsGrid(apps, { vramTotalMib: 16384, vramUsedMib: 11000, vramFreeMib: 1400 }, 500, 1500).sev, "a");
  assert.equal(Quattro.vramAppsGrid(apps, { vramTotalMib: 16384, vramUsedMib: 11000, vramFreeMib: 8000 }, 500, 1500).sev, "");
});

test("memory.js really samples the apps list the grid reads", () => {
  // The feature is surfacing only: this pins the handoff shape (the comma
  // argv, the parser's rows) so a collection change cannot silently starve
  // the popover.
  assert.equal(Memory.APP_FIELDS.join(","), "pid,process_name,used_memory");
  const apps = Memory.parseNvidiaApps("4101,blender,5200\n4102,/usr/lib/xorg/Xorg,640\nbad,line\n");
  same(apps, [
    { pid: 4101, processName: "blender", usedMib: 5200 },
    { pid: 4102, processName: "/usr/lib/xorg/Xorg", usedMib: 640 },
  ]);
  const reading = Memory.vramReading(
    { index: 0, name: "NVIDIA GeForce RTX 5070 Ti", totalMib: 16384, usedMib: 11000, freeMib: 5384 },
    apps);
  const grid = Quattro.vramAppsGrid(reading.apps, reading, 500, 1500);
  same(grid.rows.map(r => r.label), ["blender", "Xorg", "Total"]);
  assert.equal(grid.rows[2].mib, "11000 MiB");
});

// ---------------------------------------------------------------------------
// Panel wiring (delegation guards: QuattroDash.qml imports QuickShell and
// cannot load under node, so the panel side is pinned by the repo convention -
// the tests above execute quattro.js, these only name the delegation).
// ---------------------------------------------------------------------------

test("QuattroDash.qml renders the grid through quattro.js and keeps the plain fallback", () => {
  const PANEL = repoFile("memory-monitor/QuattroDash.qml");
  assert.equal(PANEL.includes("Quattro.vramAppsGrid("), true,
    "the per-process grid is assembled by quattro.js; the panel only renders its rows");
  assert.equal(PANEL.includes("Quattro.coolantTipWith("), true,
    "the fallback is the plain free-percent tip, assembled by quattro.js");
  assert.equal(PANEL.includes("if (grid !== null) return grid"), true,
    "a grid from the sample wins; only a null grid falls through to the plain tip");
  // No fixed sentence lives in the panel: the grid's words are quattro.js's.
  const longLiterals = PANEL.split("\n").filter(line =>
    /"[^"\n]{40,}"/.test(line) && !/console\.(warn|log|info|error)/.test(line));
  assert.deepEqual(longLiterals, []);
});

test("a fresh sample re-renders the open VRAM popover in place, and no other instrument's", () => {
  const PANEL = repoFile("memory-monitor/QuattroDash.qml");
  assert.equal(PANEL.includes("onVramChanged: root.refreshTip()"), true,
    "a fresh VRAM sample re-renders the open popover in place, so the grid never disagrees with the dial");
  assert.equal(PANEL.includes("tipOwner !== vramBox"), true,
    "only the VRAM box may be re-asked: another instrument's popover can be owned by a Repeater delegate a fresh sample destroys, and calling into a destroyed object throws");
});

test("the popover is hover-only: the click-to-pin mode stays out", () => {
  // The pin was beyond the approved hover spec, and its panel-global flag let
  // a pinned popover stick to whatever instrument was hovered next. This is
  // the removal guard: the VRAM hover is the whole feature.
  const PANEL = repoFile("memory-monitor/QuattroDash.qml");
  for (const gone of ["tipPinned", "pinTip", "releaseTipPin"]) {
    assert.equal(PANEL.includes(gone), false, `the ${gone} machinery stays out of the panel`);
  }
});

test("vramMibColWidth: the MiB column holds value + unit for 5- and 6-digit values", () => {
  // The captain's report: a 5-digit MiB value clipped the unit off the fixed
  // 64px column. The column now sizes to the row's own text, so value + unit
  // always fit; the 64px floor keeps today's widths unchanged.
  const width = (s) => Quattro.vramMibColWidth(s);
  assert.equal(width("5200 MiB"), 64, "a 4-digit value keeps the old fixed width");
  assert.equal(width("12345 MiB"), 72, "a 5-digit value grows past the floor, unit on-screen");
  assert.equal(width("123456 MiB"), 80, "a 6-digit value grows further, unit still on-screen");
  assert.equal(Quattro.vramMibColWidth(""), 64, "an empty value falls to the floor");
  assert.equal(Quattro.vramMibColWidth(null), 64, "null falls to the floor");
  assert.equal(Quattro.vramMibColWidth("-"), 64, "the dash row keeps the floor");
});

test("the panel wires the MiB column width through quattro.js, not a fixed 64", () => {
  const PANEL = repoFile("memory-monitor/QuattroDash.qml");
  assert.equal(PANEL.includes("Quattro.vramMibColWidth("), true,
    "the panel asks quattro.js for the column width instead of a fixed 64");
  assert.equal(/Layout\.preferredWidth: 64\b/.test(PANEL), false,
    "no fixed 64px value column remains to clip a unit off a wide number");
});
