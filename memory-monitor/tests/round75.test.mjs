// Round 7.5: the captain's second-test-drive rulings, items 15-22. These pin
// the new laws before the implementation moves:
//   15. no RAM-percent warning or color path remains: the held band, the
//       toasts and the emblem all speak PSI or the swap reserve, and the
//       MemAvailable percent is data only.
//   16. the SWAP line moves off the bar card into the values popup.
//   17. swap, VRAM and disk free-ness read one standard format:
//       "z% Free (x/y GiB or GB)".
//   18. the settings what/why is one two-sentence paragraph per metric.
//   21. the VRAM gauge sliders move in 50 MiB steps.
//   22. the bar tooltip's dot column pads by character count - the shell
//       renders it in a monospace font, so every dot sits in the same column.
// Items 19 (settings start collapsed) and 20 (reset never closes the popup)
// are QML wiring, pinned as delegation guards in the last block.
// Red first - every assertion here failed against the round-7 code.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Memory, Quattro, repoFile } from "./load.mjs";

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PSI_T = { amber: 70, red: 90, critical: null };
const BATT = { amber: 20, red: 10 };

// ---------------------------------------------------------------------------
// 15. The rig's live bug: MemAvailable 87.1% used with healthy pressure and a
// healthy reserve held the amber band forever under the inverted law. None of
// that may produce a band, a toast, or a red/amber emblem.
// ---------------------------------------------------------------------------

test("the rig's stuck state releases: healthy psi and swap give band 0 however full RAM reads", () => {
  const reading = {
    pct: 87.1,
    psiSomeAvg10: 0,
    swapPct: 19.5,
  };
  const result = Memory.resolveRamBand(reading, PSI_T, 1, BATT);
  assert.equal(result.band, 0, "the held amber releases: neither signal is near its line");
  assert.equal(result.latched, false);
  assert.equal(result.signal, "psi");
});

test("a MemAvailable percent near red with healthy signals never bands or fires", () => {
  const result = Memory.resolveRamBand(
    { pct: 96, psiSomeAvg10: 0.4, swapPct: 5 },
    PSI_T,
    0,
    BATT,
  );
  assert.equal(result.band, 0, "MemAvailable percent is data, never a band");
  assert.equal(
    Memory.shouldFireAlert({ band: 0, previousBand: 0, psiCrossing: true, swapCrossing: true }),
    false,
    "no fire at band 0 whatever crosses",
  );
});

test("every ram toast and prompt names its signal's unit, never the MemAvailable percent", () => {
  const kinds = ["amberBody", "redBody", "criticalBody"];
  for (const kind of kinds) {
    const psi = Memory[kind]({ type: "ram", band: 1, signal: "psi", pct: 82 });
    assert.match(psi, /PSI/, kind + " speaks PSI for a pressure signal");
    assert.doesNotMatch(psi, /percent used|% usage/, kind + " never says percent-used for ram");
    const swap = Memory[kind]({ type: "ram", band: 1, signal: "swap", pct: 88 });
    assert.match(swap, /Swap reserve is 88 percent used\./, kind + " speaks the reserve for a swap signal");
    assert.doesNotMatch(swap, /usage/, kind + " never says usage for ram");
  }
  const prompt = Memory.agentPrompt(
    { type: "ram", key: "ram", id: Memory.memId("ram"), band: 2, signal: "swap", pct: 91 },
    [{ target: "/", pct: 24 }],
  );
  assert.match(prompt, /91 percent used/, "the prompt names the reserve's own number");
  assert.doesNotMatch(prompt, /MemAvailable/, "the prompt never leads with the RAM percent");
});

test("resolveRamBand never reads the MemAvailable percent", () => {
  const src = repoFile("memory-monitor/memory.js");
  const body = src.slice(src.indexOf("function resolveRamBand"));
  const fn = body.slice(0, body.indexOf("\n}"));
  assert.doesNotMatch(fn, /\br\.pct\b/, "the band law consumes psi and swapPct only");
});

// ---------------------------------------------------------------------------
// 17. The standard free format for swap, VRAM and disk: "z% Free (x/y GiB)".
// ---------------------------------------------------------------------------

test("freeLine is the one standard free format", () => {
  assert.equal(Quattro.freeLine(80, "1.9", "8", "GiB"), "80% Free (1.9/8 GiB)");
  assert.equal(Quattro.freeLine(24, "437", "936", "GB"), "24% Free (437/936 GB)");
});

test("swapLine reads the standard free format", () => {
  const swap = { swapTotalKb: 8 * 1024 * 1024, swapUsedKb: Math.round(1.9 * 1024 * 1024) };
  assert.equal(Quattro.swapLine(swap), "80% Free (1.9/8 GiB)");
  assert.equal(Quattro.swapLine({ swapTotalKb: 0, swapUsedKb: 0 }), "none configured");
  assert.equal(Quattro.swapLine(null), "none configured");
});

test("the value rows read the standard free format for swap, disk and VRAM", () => {
  const swap = { swapTotalKb: 8 * 1024 * 1024, swapUsedKb: Math.round(1.9 * 1024 * 1024) };
  const rootDrive = {
    pctFree: 76,
    availKb: 437 * 1024 * 1024,
    sizeKb: 936 * 1024 * 1024,
  };
  const vram = { vramFreeMib: 3649, vramTotalMib: 16303 };
  const rows = Quattro.valueRows(4.2, { present: false, pct: 0 }, swap, rootDrive, vram, []);
  const byLabel = Object.fromEntries(rows.map((r) => [r.label, r.value]));
  assert.match(byLabel["SWAP"], /^\d+% Free \([\d.]+\/[\d.]+ GiB\)$/, "swap row in the standard format");
  assert.match(byLabel["ROOT DRIVE"], /^\d+% Free \([\d.]+\/[\d.]+ GB\)$/, "disk row in the standard format");
  assert.match(byLabel["VRAM"], /^\d+% Free \([\d.]+\/[\d.]+ GiB\)$/, "VRAM row in the standard format");
});

test("the fuel and coolant hover tips read the standard free format", () => {
  const fuel = Quattro.fuelTipWith(
    { pctFree: 24, availKb: 437 * 1024 * 1024, sizeKb: 936 * 1024 * 1024 },
    80,
    90,
  );
  assert.match(fuel.rows[0].text, /^24% Free \(437\/936 GB\)\.$/);
  const coolant = Quattro.coolantTipWith(
    { usedMib: 12262, freeMib: 3649, totalMib: 16303 },
    1013,
    2051,
  );
  assert.match(coolant.rows[0].text, /^\d+% Free \([\d.]+\/[\d.]+ GiB\)\.$/);
});

// ---------------------------------------------------------------------------
// 18. One two-sentence paragraph per metric: no newline, exactly two sentences.
// ---------------------------------------------------------------------------

test("settings copy is one paragraph of two sentences per metric", () => {
  for (const key of ["psi", "hd", "batt", "vram"]) {
    const copy = Quattro.SETTINGS.copy[key];
    assert.ok(copy, "copy exists for " + key);
    assert.doesNotMatch(copy, /\n/, key + " copy is one paragraph, not two lines");
    const sentences = copy.split(/[.?] /).filter((s) => s.trim().length > 0).length;
    assert.equal(sentences, 2, key + " copy is exactly two sentences");
    assert.doesNotMatch(copy, /[;:]|\u2014|\u2013/, key + " copy keeps the plain-sentence law");
  }
});

// ---------------------------------------------------------------------------
// 21. The VRAM gauge sliders move in 50 MiB steps; the PSI and drive sliders
// stay at 1.
// ---------------------------------------------------------------------------

test("sliderStep is 50 MiB for the VRAM gauge and 1 elsewhere", () => {
  assert.equal(Quattro.sliderStep("vram"), 50);
  assert.equal(Quattro.sliderStep("psi"), 1);
  assert.equal(Quattro.sliderStep("hd"), 1);
  assert.equal(Quattro.sliderStep("batt"), 1);
});

// ---------------------------------------------------------------------------
// 22. The bar tooltip's dot column aligns by character count: the shell renders
// it in a monospace font, so the estimate-width machinery was the jank.
// ---------------------------------------------------------------------------

test("barTooltip aligns the dot column in character space and drops the width estimates", () => {
  const entries = [
    { kind: "ram", label: "RAM", band: 0 },
    { kind: "vram", label: "VRAM", band: 1 },
    { key: "partuuid:x", label: "Drive", band: 0 },
  ];
  const tip = Memory.barTooltip(entries);
  const lines = tip.split("\n").filter((l) => l.trim().length > 0);
  const dotIdx = lines.map((l) => [...l].lastIndexOf(" ") + 1);
  for (let i = 1; i < lines.length; i += 1) {
    assert.equal(
      dotIdx[i],
      dotIdx[0],
      "every dot sits in the same character column: " + JSON.stringify(lines),
    );
  }
  assert.equal(typeof Memory.textWidthUnits, "undefined", "the width estimates are gone");
  assert.equal(typeof Memory.padToWidth, "undefined", "the width pad is gone");
});

// ---------------------------------------------------------------------------
// 16. The SWAP line moves off the bar card (above the engine codes) into the
// values popup it already rides.
// ---------------------------------------------------------------------------

test("the dash card no longer draws the SWAP caption; the popup row stays", () => {
  const dash = repoFile("memory-monitor/QuattroDash.qml");
  assert.doesNotMatch(dash, /Quattro\.swapLine/, "the card never calls swapLine; the popup row owns swap");
  const rows = Quattro.valueRows(1, { present: true, pct: 80 }, { swapTotalKb: 8 * 1024 * 1024, swapUsedKb: 0 }, null, null, []);
  assert.ok(rows.some((r) => r.label === "SWAP"), "the values popup keeps the SWAP row");
});

// ---------------------------------------------------------------------------
// 19/20/21 QML wiring, pinned as delegation guards: settings always start
// collapsed, the state watcher ignores our own write so a reset cannot bounce
// the popup shut, and the gauge slider carries the quantized step.
// ---------------------------------------------------------------------------

test("the dash collapses settings whenever the popup opens or closes", () => {
  const dash = repoFile("memory-monitor/QuattroDash.qml");
  assert.match(
    dash,
    /onOpenedChanged:[^\n]*settingsOpen = false/,
    "every open/close edge starts the settings section collapsed",
  );
  assert.match(dash, /property bool settingsOpen: false/, "settings never restore expanded state");
});

test("the state watcher skips our own write, so a reset cannot bounce the popup", () => {
  const monitor = repoFile("memory-monitor/MemoryMonitor.qml");
  assert.match(
    monitor,
    /onFileChanged:[^\n]*lastStateWriteAt/,
    "a write this widget just made cannot re-enter through the watcher",
  );
  assert.match(monitor, /lastStateWriteAt = /, "writeState stamps its own writes");
});

test("the gauge slider quantizes drags to its step", () => {
  const dash = repoFile("memory-monitor/QuattroDash.qml");
  assert.match(dash, /property int step/, "the slider carries a step");
  assert.match(dash, /sliderStep\(/, "the slider reads the step from quattro.js");
});
