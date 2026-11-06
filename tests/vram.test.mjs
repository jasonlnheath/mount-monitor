// Mount Monitor VRAM headroom telltale tests.
//
// Run: bash tests/run.sh   (or: node --test tests/)
//
// The telltale's decisions live in mounts.js so they are testable without a
// running shell: the user-set floor (vramFloorMib) and its recovery, the
// guarded threshold crossings (a reading hovering at a boundary must hold the
// band it has instead of flickering between states), the fill fraction, the
// nvidia-smi argv and parser, the poll escalator, and the telltale copy. The
// palette pin at the bottom keeps this plugin's amber and red on RingKit's
// tokens, so a bar carrying both plugins cannot show two different ambers.
// The offscreen probe at the bottom loads VramSymbol.qml in a real Qt runtime
// (QT_QPA_PLATFORM=offscreen) and skips where qml6 is absent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);

// mounts.js and ringkit.js are Qt-importable JavaScript files (plain
// top-level functions), so they are loaded into VM contexts instead of
// imported as ES modules.
function loadInto(file) {
  const src = readFileSync(path.join(repo, file), "utf8");
  const ctx = { Math, Number, parseInt, isFinite, String, Array, RegExp, JSON, Object, Date, console };
  vm.runInNewContext(src, ctx);
  return ctx;
}

const Mounts = loadInto("mounts.js");
const RingKit = loadInto("ringkit.js");

// Fixture lines starting with '#' document the fixture and are not rows.
function fixture(name) {
  return readFileSync(path.join(here, "fixtures", name), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"))
    .join("\n");
}

function strings(list) {
  // Array.from rather than list.map: the list is built inside mounts.js's VM
  // context, and a cross-realm array is not deep-equal to a local one.
  return Array.from(list, (s) => s);
}

const EPS = 1e-9;
const RIG_TOTAL = 16303;
const RIG_FLOOR = 3400;

// ---------------------------------------------------------------------------
// The argv: typed, no shell, one --query-gpu call
// ---------------------------------------------------------------------------

test("nvidia-smi argv is a typed argv with no shell", () => {
  const argv = strings(Mounts.nvidiaGpuArgs());
  assert.equal(argv[0], "nvidia-smi");
  assert.ok(argv.some((a) => a.startsWith("--query-gpu=")), "must query the gpu");
  assert.ok(
    argv.some((a) => a.startsWith("--query-gpu=") && a.includes("memory.free")),
    "the query must carry memory.free: the telltale speaks headroom"
  );
  assert.ok(argv.some((a) => a.includes("noheader")), "csv, nounits, noheader");
  assert.equal(argv.length, 3, "no third element, so no shell and no sentence");
});

// ---------------------------------------------------------------------------
// The floor setting: vramFloorMib
// ---------------------------------------------------------------------------

test("vramFloorMib defaults to the documented floor on unset and garbage", () => {
  assert.equal(Mounts.VRAM_FLOOR_DEFAULT_MIB, 3400);
  assert.equal(Mounts.normalizeFloorMib(null), 3400);
  assert.equal(Mounts.normalizeFloorMib(undefined), 3400);
  assert.equal(Mounts.normalizeFloorMib(""), 3400);
  assert.equal(Mounts.normalizeFloorMib("unset"), 3400);
  assert.equal(Mounts.normalizeFloorMib("not a number"), 3400);
  assert.equal(Mounts.normalizeFloorMib(true), 3400);
  assert.equal(Mounts.normalizeFloorMib(-1), 3400, "a negative floor is garbage, not a choice");
  assert.equal(Mounts.normalizeFloorMib(-0.5), 3400);
});

test("vramFloorMib honors the floor the user set, including zero", () => {
  assert.equal(Mounts.normalizeFloorMib(4096), 4096);
  assert.equal(Mounts.normalizeFloorMib("4096"), 4096);
  assert.equal(Mounts.normalizeFloorMib(0), 0, "a floor at zero never alarms, and that is the user's call");
  assert.equal(Mounts.normalizeFloorMib("0"), 0);
  assert.equal(Mounts.normalizeFloorMib(4096.4), 4096, "whole MiB");
  assert.equal(Mounts.normalizeFloorMib(4096.5), 4097);
  assert.equal(Mounts.normalizeFloorMib(16303), 16303, "a floor at capacity is honored, and reads as permanently empty");
});

// ---------------------------------------------------------------------------
// The guarded crossings: lines, raw bands, and the resolver
// ---------------------------------------------------------------------------

test("band lines derive from capacity: amber zone above the floor, hysteresis margins", () => {
  const lines = Mounts.vramBandLines(RIG_TOTAL, RIG_FLOOR);
  assert.ok(Math.abs(lines.redEnter - 3400) < EPS);
  assert.ok(Math.abs(lines.amberMib - RIG_TOTAL * 0.10) < EPS, "approach zone: 10% of capacity");
  assert.ok(Math.abs(lines.hystMib - RIG_TOTAL * 0.05) < EPS, "release margin: 5% of capacity, inside the 5-10% band");
  assert.ok(Math.abs(lines.redExit - (RIG_FLOOR + lines.hystMib)) < EPS);
  assert.ok(Math.abs(lines.amberEnter - (RIG_FLOOR + lines.amberMib)) < EPS);
  assert.ok(Math.abs(lines.amberExit - (RIG_FLOOR + lines.amberMib + lines.hystMib)) < EPS);
  assert.ok(lines.amberEnter > lines.redEnter, "amber enters above red");
  assert.ok(lines.redExit > lines.redEnter, "release sits above entry: the guard");
});

test("raw band: below the floor is red, the approach zone is amber, above is clear", () => {
  const lines = Mounts.vramBandLines(RIG_TOTAL, RIG_FLOOR);
  assert.equal(Mounts.rawVramBand(lines.redEnter - 1, RIG_TOTAL, RIG_FLOOR), 2);
  assert.equal(Mounts.rawVramBand(0, RIG_TOTAL, RIG_FLOOR), 2);
  assert.equal(Mounts.rawVramBand(lines.redEnter, RIG_TOTAL, RIG_FLOOR), 1, "at the floor is not below it");
  assert.equal(Mounts.rawVramBand(lines.amberEnter - 1, RIG_TOTAL, RIG_FLOOR), 1);
  assert.equal(Mounts.rawVramBand(lines.amberEnter + 1, RIG_TOTAL, RIG_FLOOR), 0);
  assert.equal(Mounts.rawVramBand(RIG_TOTAL, RIG_TOTAL, RIG_FLOOR), 0);
  assert.equal(Mounts.rawVramBand(null, RIG_TOTAL, RIG_FLOOR), 0, "no reading is no alarm");
  assert.equal(Mounts.rawVramBand(1000, null, RIG_FLOOR), 2, "a floor with no capacity line still guards the floor");
});

test("first sighting is a baseline, not a crossing", () => {
  for (const free of [100, RIG_FLOOR - 1, RIG_FLOOR + 100, RIG_TOTAL]) {
    const r = Mounts.resolveVramBand(undefined, free, RIG_TOTAL, RIG_FLOOR);
    assert.equal(r.changed, false, `first sighting at ${free} changes nothing`);
    assert.equal(r.band, Mounts.rawVramBand(free, RIG_TOTAL, RIG_FLOOR));
    assert.equal(r.latched, false);
  }
});

test("ascending fires at the line, immediately", () => {
  const lines = Mounts.vramBandLines(RIG_TOTAL, RIG_FLOOR);
  const toAmber = Mounts.resolveVramBand(0, lines.amberEnter - 1, RIG_TOTAL, RIG_FLOOR);
  assert.equal(toAmber.band, 1);
  assert.equal(toAmber.changed, true);
  assert.equal(toAmber.ascent, true);

  const toRed = Mounts.resolveVramBand(1, lines.redEnter - 1, RIG_TOTAL, RIG_FLOOR);
  assert.equal(toRed.band, 2);
  assert.equal(toRed.changed, true);
  assert.equal(toRed.ascent, true);

  const straightToRed = Mounts.resolveVramBand(0, lines.redEnter - 1, RIG_TOTAL, RIG_FLOOR);
  assert.equal(straightToRed.band, 2, "a fast fall crosses both bands in the one change it lands as");
  assert.equal(straightToRed.changed, true);
});

test("a reading hovering at a boundary holds its band: no flicker", () => {
  const lines = Mounts.vramBandLines(RIG_TOTAL, RIG_FLOOR);
  let band = 2;
  let changes = 0;
  // Dither around the red entry line (the floor) while red is held: every
  // reading is below the exit line, so every one of them holds.
  const aroundFloor = [
    lines.redEnter - 300, lines.redEnter + 300, lines.redEnter - 100,
    lines.redEnter + 150, lines.redEnter - 50, lines.redEnter + 200,
  ];
  for (const free of aroundFloor) {
    const r = Mounts.resolveVramBand(band, free, RIG_TOTAL, RIG_FLOOR);
    assert.equal(r.band, 2, `free ${free} holds red while it has not cleared the exit line`);
    assert.equal(r.changed, false);
    if (r.changed) changes += 1;
    band = r.band;
  }
  // Dither just below the red exit line: still held, still zero changes.
  const belowExit = [lines.redExit - 200, lines.redExit - 300, lines.redExit - 100, lines.redExit - 50];
  for (const free of belowExit) {
    const r = Mounts.resolveVramBand(band, free, RIG_TOTAL, RIG_FLOOR);
    assert.equal(r.band, 2, `free ${free} holds red below its own exit line`);
    assert.equal(r.latched, true);
    assert.equal(r.held, true);
    if (r.changed) changes += 1;
  }
  assert.equal(changes, 0, "the hover is zero state changes, however many readings dither");

  // The one crossing: clearing the exit line releases exactly once, and the
  // dither on the far side cannot push it back up without a real crossing.
  let released = Mounts.resolveVramBand(band, lines.redExit + 1, RIG_TOTAL, RIG_FLOOR);
  assert.equal(released.changed, true);
  assert.equal(released.descent, true);
  band = released.band;
  for (const free of belowExit) {
    // Readings that fall back below the exit line now read raw band 1, the
    // band that was released into; no ascent, no second crossing.
    const r = Mounts.resolveVramBand(band, free, RIG_TOTAL, RIG_FLOOR);
    assert.equal(r.band, 1);
    assert.equal(r.changed, false);
  }

  // The same story at the amber exit line.
  band = 1;
  const aroundAmberExit = [
    lines.amberExit - 200, lines.amberExit - 300, lines.amberExit - 100, lines.amberExit - 50,
  ];
  for (const free of aroundAmberExit) {
    const r = Mounts.resolveVramBand(band, free, RIG_TOTAL, RIG_FLOOR);
    assert.equal(r.band, 1, `free ${free} holds amber below its own exit line`);
    assert.equal(r.held, true);
    band = r.band;
  }
});

test("descending releases only past the reading's own exit line", () => {
  const lines = Mounts.vramBandLines(RIG_TOTAL, RIG_FLOOR);

  const held = Mounts.resolveVramBand(2, lines.redExit - 1, RIG_TOTAL, RIG_FLOOR);
  assert.equal(held.band, 2);
  assert.equal(held.changed, false);
  assert.equal(held.latched, true);
  assert.equal(held.held, true);

  const released = Mounts.resolveVramBand(2, lines.redExit + 1, RIG_TOTAL, RIG_FLOOR);
  assert.equal(released.band, 1, "one release lands in the band the reading supports");
  assert.equal(released.changed, true);
  assert.equal(released.descent, true);
  assert.equal(released.latched, false);

  const amberHeld = Mounts.resolveVramBand(1, lines.amberExit - 1, RIG_TOTAL, RIG_FLOOR);
  assert.equal(amberHeld.band, 1);
  assert.equal(amberHeld.latched, true);

  const amberReleased = Mounts.resolveVramBand(1, lines.amberExit + 1, RIG_TOTAL, RIG_FLOOR);
  assert.equal(amberReleased.band, 0);
  assert.equal(amberReleased.descent, true);

  const far = Mounts.resolveVramBand(2, lines.amberExit + 1000, RIG_TOTAL, RIG_FLOOR);
  assert.equal(far.band, 0, "a recovery well past every line releases in the one change");
  assert.equal(far.changed, true);
});

test("re-ascent after a release is immediate again", () => {
  const lines = Mounts.vramBandLines(RIG_TOTAL, RIG_FLOOR);
  const recovered = Mounts.resolveVramBand(2, lines.redExit + 1, RIG_TOTAL, RIG_FLOOR);
  assert.equal(recovered.band, 1);
  const fellAgain = Mounts.resolveVramBand(recovered.band, lines.redEnter - 1, RIG_TOTAL, RIG_FLOOR);
  assert.equal(fellAgain.band, 2);
  assert.equal(fellAgain.ascent, true, "the guard delays exits, never alarms");
});

test("no reading keeps the band it had and crosses nothing", () => {
  const r = Mounts.resolveVramBand(2, null, RIG_TOTAL, RIG_FLOOR);
  assert.equal(r.band, 2);
  assert.equal(r.changed, false);
  assert.equal(r.latched, false);
  const fresh = Mounts.resolveVramBand(undefined, null, RIG_TOTAL, RIG_FLOOR);
  assert.equal(fresh.band, 0);
});

// ---------------------------------------------------------------------------
// The fill fraction
// ---------------------------------------------------------------------------

test("fill is headroom above the floor, as a fraction of everything above it", () => {
  assert.equal(Mounts.vramHeadroomFrac(RIG_FLOOR, RIG_TOTAL, RIG_FLOOR), 0, "at the floor the tank is empty");
  assert.equal(Mounts.vramHeadroomFrac(RIG_TOTAL, RIG_TOTAL, RIG_FLOOR), 1, "at capacity the tank is full");
  const half = Mounts.vramHeadroomFrac((RIG_FLOOR + RIG_TOTAL) / 2, RIG_TOTAL, RIG_FLOOR);
  assert.ok(Math.abs(half - 0.5) < EPS, "halfway between floor and capacity reads half");
  assert.equal(Mounts.vramHeadroomFrac(0, RIG_TOTAL, RIG_FLOOR), 0, "below the floor clamps at empty");
  assert.equal(Mounts.vramHeadroomFrac(RIG_TOTAL + 5000, RIG_TOTAL, RIG_FLOOR), 1, "over-full clamps at full");
  assert.equal(Mounts.vramHeadroomFrac(null, RIG_TOTAL, RIG_FLOOR), 0, "no reading draws nothing");
  assert.equal(Mounts.vramHeadroomFrac(100, 0, RIG_FLOOR), 0, "no capacity draws nothing");
  assert.equal(Mounts.vramHeadroomFrac(50, 100, 150), 0, "a floor at or above capacity leaves no drawable headroom");
  assert.equal(Mounts.vramHeadroomFrac(100, 100, 100), 0);
});

// ---------------------------------------------------------------------------
// The poll escalator
// ---------------------------------------------------------------------------

test("polling escalates only once the telltale is red", () => {
  assert.equal(Mounts.vramPollMs(0), Mounts.VRAM_POLL_NOMINAL_MS);
  assert.equal(Mounts.vramPollMs(1), Mounts.VRAM_POLL_NOMINAL_MS);
  assert.equal(Mounts.vramPollMs(2), Mounts.VRAM_POLL_ESCALATED_MS);
  assert.equal(Mounts.vramPollMs(3), Mounts.VRAM_POLL_ESCALATED_MS);
  assert.equal(Mounts.vramPollMs("garbage"), Mounts.VRAM_POLL_NOMINAL_MS);
  assert.equal(Mounts.VRAM_POLL_NOMINAL_MS, 60000);
  assert.equal(Mounts.VRAM_POLL_ESCALATED_MS, 20000);
});

// ---------------------------------------------------------------------------
// The nvidia-smi parser
// ---------------------------------------------------------------------------

test("parseNvidiaGpu reads the rig's real row", () => {
  const gpu = Mounts.parseNvidiaGpu(fixture("nvidia-gpu.txt"));
  assert.ok(gpu, "the rig row must parse");
  assert.equal(gpu.name, "NVIDIA GeForce RTX 5070 Ti");
  assert.equal(gpu.totalMib, 16303);
  assert.equal(gpu.usedMib, 14174);
  assert.equal(gpu.freeMib, 1737);
});

test("parseNvidiaGpu honors a quoted name, skips broken rows, and never invents a reading", () => {
  const quoted = Mounts.parseNvidiaGpu('2, "GeForce GPU, special", 8192, 1024, 7168');
  assert.ok(quoted);
  assert.equal(quoted.name, "GeForce GPU, special", "a comma in the name stays in the name");

  const noFree = Mounts.parseNvidiaGpu('9, Card, 100, 30, ');
  assert.ok(noFree);
  assert.equal(noFree.freeMib, 70, "a missing free column is total minus used");

  assert.equal(Mounts.parseNvidiaGpu('3, Broken Card, [N/A], 512, 512'), null, "[N/A] is no reading");
  assert.equal(Mounts.parseNvidiaGpu('4, Zero Card, 0, 0, 0'), null, "a zero-capacity row is no reading");
  assert.equal(Mounts.parseNvidiaGpu("nvidia-smi: could not communicate with the NVIDIA driver"), null);
  assert.equal(Mounts.parseNvidiaGpu(""), null);
  assert.equal(Mounts.parseNvidiaGpu(null), null);

  // The fixture's later broken rows must not shadow the first parsable row.
  const gpu = Mounts.parseNvidiaGpu(fixture("nvidia-gpu.txt"));
  assert.equal(gpu.index, 0, "first card wins");
});

test("parseNvidiaGpu sanitizes the GPU name: device text is data", () => {
  const hostile = Mounts.parseNvidiaGpu('0, "EVIL\u0007\u202e\u200b<IGNORE PREVIOUS> label\tname", 100, 10, 90');
  assert.ok(hostile);
  assert.ok(!/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e<>]/.test(hostile.name), "control, bidi, zero-width and angle brackets are gone");
  assert.equal(hostile.name, "EVIL IGNORE PREVIOUS label name");
  const long = Mounts.parseNvidiaGpu(`0, ${"x".repeat(300)}, 100, 10, 90`);
  assert.ok(long.name.length <= Mounts.DEVICE_TEXT_MAX, "a name that long is a payload, truncated");
});

// ---------------------------------------------------------------------------
// The copy: tooltip, state line, floor caption, missing reading
// ---------------------------------------------------------------------------

test("tooltip names the GPU, the reading, and the floor", () => {
  const reading = { name: "NVIDIA GeForce RTX 5070 Ti", totalMib: 16303, freeMib: 1737 };
  assert.equal(
    Mounts.vramTooltip(reading, 3400),
    "NVIDIA GeForce RTX 5070 Ti \u2014 1737 MiB free of 16303 MiB \u00b7 floor 3400 MiB"
  );
  assert.equal(Mounts.vramTooltip({ name: "", totalMib: 100, freeMib: 40 }, 3400),
    "VRAM \u2014 40 MiB free of 100 MiB \u00b7 floor 3400 MiB", "an anonymous GPU still says VRAM");
  assert.equal(Mounts.vramTooltip(null, 3400), "");
  const hostile = Mounts.vramTooltip({ name: "bad\u202ename", totalMib: 100, freeMib: 40 }, "4096");
  assert.ok(!hostile.includes("\u202e"), "the name is sanitized on the way out");
  assert.ok(hostile.includes("floor 4096 MiB"), "the tooltip reads the floor through the normalizer");
});

test("state line, floor caption, and missing-reading copy are exact", () => {
  assert.equal(Mounts.vramStateText(0), "above the floor");
  assert.equal(Mounts.vramStateText(1), "approaching the floor");
  assert.equal(Mounts.vramStateText(2), "below the floor");
  assert.equal(Mounts.vramStateText(9), "below the floor");
  assert.equal(Mounts.vramStateText("junk"), "above the floor");

  const caption = Mounts.vramFloorCaption();
  assert.ok(caption.includes("vramFloorMib"), "the caption names its setting");
  assert.ok(caption.includes("3400"), "the caption names the default");
  assert.equal(Mounts.vramFloorText(3400), "3400 MiB");
  assert.equal(Mounts.vramFloorText("junk"), "3400 MiB");

  const missing = Mounts.vramMissingText();
  assert.ok(missing.includes("nvidia-smi"), "the missing copy names the missing tool");
  assert.equal(Mounts.vramFreeLine({ totalMib: 16303, freeMib: 1737 }), "1737 MiB free of 16303 MiB");
  assert.equal(Mounts.vramFreeLine(null), "");
  assert.equal(Mounts.vramNameText({ name: "NVIDIA GeForce RTX 5070 Ti" }), "NVIDIA GeForce RTX 5070 Ti");
  assert.equal(Mounts.vramNameText({ name: "" }), "unknown GPU");
  assert.equal(Mounts.vramNameText(null), "");
});

// ---------------------------------------------------------------------------
// The severity tokens stay on RingKit's palette
// ---------------------------------------------------------------------------

test("vram tokens are RingKit's tokens, and the numbering matches the badge language", () => {
  assert.equal(Mounts.vramTokenFor(0), "plain");
  assert.equal(Mounts.vramTokenFor(1), "amber");
  assert.equal(Mounts.vramTokenFor(2), "red");
  assert.equal(Mounts.vramTokenFor("junk"), "plain");
  assert.equal(Mounts.vramTokenHex("amber"), RingKit.paletteToken("amber"));
  assert.equal(Mounts.vramTokenHex("red"), RingKit.paletteToken("alertRed"));
  assert.equal(Mounts.vramTokenHex("plain"), null, "plain is the bar's own foreground, not a token here");
  // Same severity numbering the RingKit badge uses: 1 amber, 2+ red.
  assert.equal(RingKit.badgeParams("", 1).colorToken, "amber");
  assert.equal(RingKit.badgeParams("", 2).colorToken, "alertRed");
});

// ---------------------------------------------------------------------------
// Delegation guards: the widget and the popup carry ids and readings, and
// every telltale decision is a Mounts call
// ---------------------------------------------------------------------------

const widgetQml = readFileSync(path.join(repo, "MountMonitor.qml"), "utf8");
const panelQml = readFileSync(path.join(repo, "VramPanel.qml"), "utf8");
const symbolQml = readFileSync(path.join(repo, "VramSymbol.qml"), "utf8");

test("MountMonitor.qml builds its VRAM sampling and its band through the shared module", () => {
  for (const [pattern, why] of [
    [/command: Mounts\.nvidiaGpuArgs\(\)/, "the nvidia-smi command must be Mounts.nvidiaGpuArgs()"],
    [/Mounts\.parseNvidiaGpu\(/, "the reading must come from Mounts.parseNvidiaGpu"],
    [/Mounts\.resolveVramBand\(/, "the guarded band must come from Mounts.resolveVramBand"],
    [/Mounts\.normalizeFloorMib\(/, "the floor must come from Mounts.normalizeFloorMib"],
    [/Mounts\.vramPollMs\(/, "the poll cadence must come from Mounts.vramPollMs"],
    [/Mounts\.normalizeBool\(root\.setting\("vramTelltale", true\), true\)/, "the off switch reads through Mounts.normalizeBool"],
    [/Mounts\.vramTooltip\(/, "the tooltip copy must come from Mounts.vramTooltip"],
    [/Mounts\.vramHeadroomFrac\(/, "the fill must come from Mounts.vramHeadroomFrac"],
    [/Mounts\.vramTokenFor\(/, "the tint token must come from Mounts.vramTokenFor"],
    [/Mounts\.vramTokenHex\(/, "the token hex must come from Mounts.vramTokenHex"],
  ]) {
    assert.match(widgetQml, pattern, why);
  }
});

test("the telltale hides when there is no reading and when it is switched off", () => {
  assert.match(
    widgetQml,
    /readonly property bool show: root\.vramTelltaleEnabled && root\.vramReading !== null/,
    "no reading is no telltale: an absent reading never renders as a level"
  );
  assert.match(widgetQml, /onVramTelltaleEnabledChanged: root\.syncVram/, "the off switch engages when the injected value arrives");
});

test("the telltale is silent: no notification lane, no agent, no prompt copy", () => {
  // VRAM notifications are Memory Monitor's job; this plugin's notification
  // lanes stay disk-only. The telltale changes pixels, not queues.
  assert.doesNotMatch(widgetQml, /vram[^\n]*(alertQueue|noticeQueue|notifyProc|notifyArgs|runAgent|agentProc)/i);
  assert.doesNotMatch(widgetQml, /(alertQueue|noticeQueue|notifyProc|notifyArgs|runAgent|agentProc)[^\n]*vram/i);
  for (const [name, qml] of [["VramPanel.qml", panelQml], ["VramSymbol.qml", symbolQml]]) {
    assert.doesNotMatch(qml, /Process\s*\{/, `${name} runs no process`);
    assert.doesNotMatch(qml, /execDetached|notify-send|agentCommand/i, `${name} launches nothing`);
  }
});

test("VramPanel.qml renders the picture and leaves every decision to mounts.js", () => {
  assert.match(panelQml, /import "mounts\.js" as Mounts/);
  for (const fn of [
    "vramStateText", "vramFreeLine", "vramFloorText", "vramFloorCaption",
    "vramMissingText", "vramNameText", "vramHeadroomFrac", "vramTokenFor", "vramTokenHex",
  ]) {
    assert.match(panelQml, new RegExp(`Mounts\\.${fn}\\(`), `the panel must read ${fn} from mounts.js`);
  }
  assert.match(panelQml, /monitor\.vramFloorMib|typeof monitor\.vramFloorMib/, "the floor comes from the monitor, not a re-decided copy");
  assert.match(panelQml, /readonly property int band: mon\("vramBand", 0\)/, "the panel shows the band the widget resolved");
});

test("VramSymbol.qml draws only what it is handed", () => {
  assert.doesNotMatch(symbolQml, /import "mounts\.js"/, "the renderer takes fill and tint as properties; it decides nothing");
  assert.match(symbolQml, /property real fill/);
  assert.match(symbolQml, /property color tint/);
});

// ---------------------------------------------------------------------------
// The offscreen probe: VramSymbol.qml loads and paints in a real Qt runtime
// ---------------------------------------------------------------------------

test("VramSymbol.qml loads and paints offscreen", { skip: spawnSync("sh", ["-c", "command -v qml6"]).status !== 0 ? "qml6 is not on the box" : false }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "vram-probe-"));
  try {
    // The symbol is copied beside the probe: same-directory QML types resolve
    // without an import path, which is how the widget's own directory import
    // works.
    const symbolCopy = path.join(dir, "VramSymbol.qml");
    writeFileSync(symbolCopy, readFileSync(path.join(repo, "VramSymbol.qml"), "utf8"));
    const probe = path.join(dir, "probe.qml");
    writeFileSync(probe, [
      "import QtQuick",
      "Item {",
      "  width: 64; height: 64",
      "  VramSymbol {",
      "    id: good",
      "    anchors.fill: parent",
      "    fill: 0.5",
      '    tint: "#e0a030"',
      "  }",
      "  VramSymbol {",
      "    id: clamped",
      "    x: 40; width: 20; height: 20",
      "    fill: -3",
      '    tint: "#ff2d2d"',
      "  }",
      "  VramSymbol {",
      "    id: empty",
      "    x: 0; y: 40; width: 20; height: 20",
      "    fill: 0",
      '    tint: "#ffffff"',
      "  }",
      "  Component.onCompleted: function() {",
      "    // The qml6 tool suppresses console output on this platform, so the",
      "    // exit code is the report: any failure path exits non-zero, and a",
      "    // handler that never ran leaves the loop alive for the timeout to catch.",
      '    if (good.fill !== 0.5) Qt.exit(10)',
      '    if (clamped.width !== 20) Qt.exit(11)',
      '    if (empty.fill !== 0) Qt.exit(12)',
      "    Qt.quit()",
      "  }",
      "}",
      "",
    ].join("\n"));
    const run = spawnSync("qml6", ["-platform", "offscreen", probe], {
      encoding: "utf8",
      timeout: 60000,
      env: Object.assign({}, process.env, { QT_QPA_PLATFORM: "offscreen" }),
    });
    // A killed run (null status) means Component.onCompleted never reached
    // Qt.quit(): the probe hung, which is itself the failure.
    if (run.error) throw new Error(`offscreen probe failed: ${run.error}`);
    if (run.status !== 0) {
      const why = run.status === null ? "the probe timed out" : `the probe exited ${run.status}`;
      throw new Error(`offscreen probe failed: ${why}\nstdout: ${run.stdout}\nstderr: ${run.stderr}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
