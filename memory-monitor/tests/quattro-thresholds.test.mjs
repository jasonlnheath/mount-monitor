// The QuattroDash gauge threshold settings (the captain's 2026-11-07 round-1
// ruling): one amber/red slider pair per gauge in a collapsible settings row at
// the bottom of the dash, each with its one-sentence description in the row
// itself, a reset button, and defaults set to the recommended values. The
// ordering law (red never sits below amber, inverted where the marks count
// what is LEFT) is enforced mechanically in quattro.js's slider model, never
// with a warning. RAM pressure and root drive pairs are the plugin's real
// alert ceilings; the swap-reserve ticks and the coolant thresholds are
// display pairs persisted beside them in the plugin state file.
import test from "node:test";
import assert from "node:assert/strict";
import { Memory, repoFile, same } from "./load.mjs";

// quattro.js is loaded here the way load.mjs loads memory.js: as a script in a
// fresh context, exactly as QML does, so an export would break both consumers.
import { readFileSync } from "node:fs";
import vm from "node:vm";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

const Quattro = (() => {
  const source = readFileSync(path.join(ROOT, "memory-monitor/quattro.js"), "utf8");
  const context = {
    Math, Number, parseInt, parseFloat, isFinite, String, Array, Object,
    JSON, Date, RegExp, Boolean, console,
  };
  vm.runInNewContext(source, context, { filename: "memory-monitor/quattro.js" });
  return context;
})();

const Q = Quattro;

// ---------------------------------------------------------------------------
// Defaults are the captain-approved recommended values
// ---------------------------------------------------------------------------

test("the defaults are the recommended values, per gauge", () => {
  same(Q.GAUGE_DEFAULTS.psi, { amber: 70, red: 90 }, "RAM pressure");
  same(Q.GAUGE_DEFAULTS.hd, { amber: 80, red: 90 }, "root drive");
  same(Q.GAUGE_DEFAULTS.batt, { amber: 20, red: 10 }, "swap reserve");
  same(Q.GAUGE_DEFAULTS.vram, { amber: 1500, red: 500 }, "VRAM coolant, MiB free");
  same(Q.GAUGE_KEYS, ["psi", "hd", "batt", "vram"]);
});

test("the dash defaults and the plugin's ceiling defaults are one set of numbers", () => {
  assert.equal(Q.GAUGE_DEFAULTS.psi.amber, Memory.DEFAULT_AMBER_RAM,
    "the RAM pressure slider's default is memory.js's recommended RAM amber");
  assert.equal(Q.GAUGE_DEFAULTS.psi.red, Memory.DEFAULT_RED);
  assert.equal(Q.GAUGE_DEFAULTS.hd.amber, Memory.DEFAULT_AMBER,
    "the root drive slider's default is the shared amber default");
  assert.equal(Q.GAUGE_DEFAULTS.hd.red, Memory.DEFAULT_RED);
  for (const key of Q.GAUGE_KEYS) {
    const p = Q.gaugePair(key, null);
    assert.equal(p.amber, Q.GAUGE_DEFAULTS[key].amber, `${key} amber falls back to the recommended default`);
    assert.equal(p.red, Q.GAUGE_DEFAULTS[key].red, `${key} red falls back to the recommended default`);
  }
});

// ---------------------------------------------------------------------------
// The slider model: sanitize, clamp, and the mechanical ordering law
// ---------------------------------------------------------------------------

test("a junk or absent pair takes the defaults, never garbage", () => {
  for (const junk of [null, undefined, {}, { amber: "hot" }, { red: null }, { amber: NaN, red: Infinity }]) {
    for (const key of Q.GAUGE_KEYS) {
      const p = Q.gaugePair(key, junk);
      assert.equal(p.amber, Q.GAUGE_DEFAULTS[key].amber, `${key} amber from junk ${JSON.stringify(junk)}`);
      assert.equal(p.red, Q.GAUGE_DEFAULTS[key].red, `${key} red from junk ${JSON.stringify(junk)}`);
    }
  }
});

test("pairs are rounded whole numbers inside the slider range", () => {
  same(Q.gaugePair("psi", { amber: 70.6, red: 89.2 }), { amber: 71, red: 89 });
  same(Q.gaugePair("psi", { amber: 0, red: 100 }), { amber: Q.GAUGE_PCT_MIN, red: Q.GAUGE_PCT_MAX },
    "out-of-range percent pairs clamp to the slider range");
  same(Q.gaugePair("vram", { amber: 99999, red: -5 }), { amber: Q.GAUGE_MIB_MAX, red: Q.GAUGE_PCT_MIN },
    "out-of-range MiB pairs clamp to the slider range");
  same(Q.gaugeRange("psi"), { min: 1, max: 99 });
  same(Q.gaugeRange("hd"), { min: 1, max: 99 });
  same(Q.gaugeRange("batt"), { min: 1, max: 99 });
  same(Q.gaugeRange("vram"), { min: 1, max: Q.GAUGE_MIB_MAX });
});

test("the ordering law holds wherever a pair comes from: red never sits below amber on psi and hd, and vram inverts", () => {
  same(Q.gaugePair("psi", { amber: 95, red: 70 }), { amber: 95, red: 95 },
    "a stored pair that arrives crossed is pushed back by the same rule the sliders use");
  same(Q.gaugePair("hd", { amber: 91, red: 90 }), { amber: 91, red: 91 });
  same(Q.gaugePair("vram", { amber: 300, red: 500 }), { amber: 500, red: 500 });
  // Round 7 item 1: the battery leaves the ordering law. Duplicates of a color
  // are allowed there; its bars are the threshold display.
  same(Q.gaugePair("batt", { amber: 5, red: 10 }), { amber: 5, red: 10 },
    "the battery keeps a crossed pair: the captain colors the bars he wants");
});

test("a coolant red the captain moved carries its amber on the fixed margin, the way the card always drew it", () => {
  same(Q.gaugePair("vram", { red: 3400 }), { amber: 4400, red: 3400 },
    "a shell vramFloorMib of 3400 lands amber at 4400, unchanged PR-18 behavior");
  same(Q.gaugePair("vram", { red: 3400, amber: 5000 }), { amber: 5000, red: 3400 },
    "an amber the pair carries wins over the margin");
  same(Q.gaugePair("vram", { red: Q.GAUGE_DEFAULTS.vram.red }), { amber: 1500, red: 500 },
    "the unset floor chain lands on the documented 500/1500");
});

// ---------------------------------------------------------------------------
// adjustGaugePair: moving one slider pushes the other, mechanically
// ---------------------------------------------------------------------------

test("moving red down through amber pushes amber down on the up-bad gauges, keeping the store's one-point gap", () => {
  same(Q.adjustGaugePair("psi", "red", 60, { amber: 70, red: 90 }), { amber: 59, red: 60 });
  same(Q.adjustGaugePair("hd", "red", 79, { amber: 80, red: 90 }), { amber: 78, red: 79 });
});

test("moving amber up through red pushes red up on the up-bad gauges, keeping the gap", () => {
  same(Q.adjustGaugePair("psi", "amber", 95, { amber: 70, red: 90 }), { amber: 95, red: 96 });
  same(Q.adjustGaugePair("hd", "amber", 92, { amber: 80, red: 90 }), { amber: 92, red: 93 });
});

test("moving amber down through red pushes red down only on the vram gauge; the battery is free", () => {
  same(Q.adjustGaugePair("vram", "amber", 400, { amber: 1500, red: 500 }), { amber: 400, red: 400 });
  // Round 7: the battery never pushes. Each slider colors its own bars.
  same(Q.adjustGaugePair("batt", "amber", 8, { amber: 20, red: 10 }), { amber: 8, red: 10 });
});

test("moving red up through amber pushes amber up on vram; the battery keeps its own red count", () => {
  same(Q.adjustGaugePair("vram", "red", 1600, { amber: 1500, red: 500 }), { amber: 1600, red: 1600 });
  // Round 7: two red bars or three red bars, whatever the captain drags.
  same(Q.adjustGaugePair("batt", "red", 30, { amber: 20, red: 10 }), { amber: 20, red: 30 });
});

test("a move that crosses nothing leaves the other slider alone", () => {
  same(Q.adjustGaugePair("psi", "amber", 40, { amber: 70, red: 90 }), { amber: 40, red: 90 });
  same(Q.adjustGaugePair("psi", "red", 95, { amber: 70, red: 90 }), { amber: 70, red: 95 });
  same(Q.adjustGaugePair("batt", "amber", 25, { amber: 20, red: 10 }), { amber: 25, red: 10 });
  same(Q.adjustGaugePair("batt", "red", 5, { amber: 20, red: 10 }), { amber: 20, red: 5 });
  same(Q.adjustGaugePair("vram", "red", 800, { amber: 1500, red: 500 }), { amber: 1500, red: 800 });
  same(Q.adjustGaugePair("vram", "amber", 3000, { amber: 1500, red: 500 }), { amber: 3000, red: 500 });
});

test("a dragged value clamps to the slider range, and a junk drag changes nothing", () => {
  same(Q.adjustGaugePair("psi", "amber", 0, { amber: 70, red: 90 }), { amber: 1, red: 90 });
  same(Q.adjustGaugePair("psi", "red", 500, { amber: 70, red: 90 }), { amber: 70, red: 99 });
  same(Q.adjustGaugePair("psi", "red", 1, { amber: 70, red: 90 }), { amber: 1, red: 2 },
    "dragging red onto the bottom boundary drags amber with it and holds the gap");
  same(Q.adjustGaugePair("psi", "amber", 99, { amber: 70, red: 90 }), { amber: 98, red: 99 },
    "dragging amber onto the top boundary holds the gap the same way");
  same(Q.adjustGaugePair("vram", "amber", 99999, { amber: 1500, red: 500 }), { amber: Q.GAUGE_MIB_MAX, red: 500 },
    "the clamp is on the moved slider; amber moving up through nothing pushes nothing");
  same(Q.adjustGaugePair("psi", "red", "junk", { amber: 70, red: 90 }), { amber: 70, red: 90 });
  same(Q.adjustGaugePair("psi", "red", null, { amber: 70, red: 90 }), { amber: 70, red: 90 });
});

test("every adjust result satisfies the ceiling store's strict order, swept over the boundaries", () => {
  const starts = [
    { amber: 70, red: 90 }, { amber: 20, red: 21 }, { amber: 98, red: 99 },
    { amber: 1, red: 2 }, { amber: 50, red: 51 },
  ];
  const moves = [1, 2, 50, 98, 99];
  for (const start of starts) {
    for (const which of ["amber", "red"]) {
      for (const value of moves) {
        const p = Q.adjustGaugePair("psi", which, value, start);
        assert.ok(p.amber >= 1 && p.red <= 99, `in range from ${JSON.stringify(start)} ${which} ${value}`);
        assert.ok(p.amber < p.red, `strict amber < red from ${JSON.stringify(start)} ${which} ${value}: ${JSON.stringify(p)}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// The drawn bands follow the pair live
// ---------------------------------------------------------------------------

test("psiZoneArcsFor at the locked 60/80 is the approved arc set", () => {
  same(Q.psiZoneArcsFor(60, 80), Q.psiZoneArcs);
});

test("psiZoneArcsFor moves the drawn zones with the pair", () => {
  same(Q.psiZoneArcsFor(70, 90), [
    { from: 0.7, to: 0.9, kind: "amber" },
    { from: 0.9, to: 1, kind: "red" },
  ]);
  same(Q.psiZoneArcsFor(null, null), Q.psiZoneArcsFor(70, 90), "no pair is the recommended default");
});

test("fuelZoneArcsFor maps used-percent ceilings onto the free-scale dial, extending the locked arcs", () => {
  same(Q.fuelZoneArcsFor(80, 90), [
    { from: 0, to: 0.1, kind: "red" },
    { from: 0.1, to: 0.2, kind: "amber" },
  ]);
  same(Q.fuelZoneArcsFor(80, 90)[0], Q.fuelZoneArcs[0],
    "at the defaults the red zone is exactly the locked one");
  same(Q.fuelZoneArcsFor(70, 90), [
    { from: 0, to: 0.1, kind: "red" },
    { from: 0.1, to: 0.3, kind: "amber" },
  ]);
});

test("ledBandWith at the locked 25/10 is ledBand, and moves with the pair", () => {
  for (const pct of [0, 5, 9.9, 10, 15, 24.9, 25, 60, 100, null]) {
    assert.equal(Q.ledBandWith(pct, 25, 10), Q.ledBand(pct), `ledBandWith(${pct}, 25, 10)`);
  }
  same([5, 10, 15, 20, 25].map(v => Q.ledBandWith(v, 20, 10)), ["red", "yellow", "yellow", "green", "green"],
    "at the recommended 20/10 the green edge is the amber tick");
});

test("the battery's bars are the threshold display: zone-colored segments, no tick lines", () => {
  // Round 7 item 1: the moving red and yellow lines (battTickFracs) are gone;
  // each LED segment wears its zone color, red checked first so a crossed or
  // duplicated pair still reads one way.
  assert.equal(Q.battTickFracs, undefined);
  assert.equal(Q.battSegmentZone(5, { amber: 20, red: 10 }), "red");
  assert.equal(Q.battSegmentZone(15, { amber: 20, red: 10 }), "amber");
  assert.equal(Q.battSegmentZone(25, { amber: 20, red: 10 }), "green");
  assert.equal(Q.battSegmentZone(15, { amber: 10, red: 30 }), "red", "red dominates the overlap");
});

test("coolantBandWith bands from the drawn thresholds, with the margin fallback", () => {
  assert.equal(Q.coolantBandWith(400, 8186, 500, 1500), 2);
  assert.equal(Q.coolantBandWith(800, 8186, 500, 1500), 1);
  assert.equal(Q.coolantBandWith(2000, 8186, 500, 1500), 0);
  assert.equal(Q.coolantBandWith(3500, 8186, 3400, null), 1,
    "no amber line falls back to the fixed margin above the red one");
  assert.equal(Q.coolantBandWith(3399, 8186, 3400, null), 2);
  assert.equal(Q.coolantBandWith(4500, 8186, 3400, null), 0);
  assert.equal(Q.coolantBandWith(null, 8186, 500, 1500), null, "no reading is never drawn as healthy");
  assert.equal(Q.coolantBandWith(400, null, 500, 1500), null);
});

test("the coolant band and hover keep a floor-chain pair past the slider scale", () => {
  // vramFloorMib 12288 with no stored pair hands the raw chain (amber 13288,
  // red 12288) to the band and the hover decode; neither may clamp it to the
  // 8192 slider ceiling or the light draws green where the floor is red.
  assert.equal(Q.coolantBandWith(10000, 16310, 12288, 13288), 2, "free below the floor stays red");
  assert.equal(Q.coolantBandWith(12600, 16310, 12288, 13288), 1, "the approach zone lights between the lines");
  assert.equal(Q.coolantBandWith(14000, 16310, 12288, 13288), 0);
  assert.equal(Q.coolantBandWith(12287, 16310, 12288, 13288), 2, "one MiB below the floor is red");
  assert.equal(Q.coolantBandWith(400, 16310, null, null), 2, "a junk pair falls back to the recommended 500/1500");
  const tip = Q.coolantTipWith({ present: true, usedMib: 3710, freeMib: 12600, totalMib: 16310 }, 12288, 13288);
  assert.equal(tip.rows.length, 1, "round 7 item 2: the hover is the simple reading, one line");
  assert.equal(tip.rows[0].text, "3.6 GiB used, 12.3 GiB free of 15.9 GiB.",
    "the Now row reports free OF TOTAL, the round-3 doctrine the lane and stat rows carry");
  assert.equal(Q.coolantTip({ present: true, usedMib: 3710, freeMib: 12600, totalMib: 16310 }, 12288).rows[0].text, tip.rows[0].text,
    "the locked wrapper and the drawn pair agree on the one-line reading");
});

// ---------------------------------------------------------------------------
// The settings row's copy: one sentence per setting, in the row
// ---------------------------------------------------------------------------

test("every gauge the row offers carries its what-is and why-we-measure lines, no band colors", () => {
  for (const key of Q.GAUGE_KEYS) {
    const copy = Q.SETTINGS.copy[key];
    assert.equal(typeof copy, "string", `${key} has a description`);
    const lines = copy.split("\n");
    assert.equal(lines.length, 2, `${key}'s copy is a what line and a why line`);
    assert.ok(/^[A-Z].*\.$/.test(lines[0]), `${key}'s what is one sentence ending in a period`);
    assert.ok(/^[A-Z].*\.$/.test(lines[1]), `${key}'s why is one sentence ending in a period`);
    assert.equal(/amber|red/i.test(copy), false, `${key}'s copy names no band color`);
  }
  assert.equal(Q.gaugeTitle("psi"), "RAM PRESSURE");
  assert.equal(Q.gaugeTitle("hd"), "ROOT DRIVE");
  assert.equal(Q.gaugeTitle("batt"), "SWAP RESERVE");
  assert.equal(Q.gaugeTitle("vram"), "VRAM", "round 7 item 4: the lane is VRAM everywhere");
  assert.equal(Q.SETTINGS.header.length > 0, true);
  assert.equal(Q.SETTINGS.reset.length > 0, true);
  assert.equal(Q.SETTINGS.hint, "Drag a slider to set where each color starts.",
    "the battery's bars are colored by the sliders now, so the hint says that");
});

// ---------------------------------------------------------------------------
// Persistence: the plugin state file carries the pairs, and the two kernels
// agree on what a stored pair means
// ---------------------------------------------------------------------------

test("normalizeGaugeSettings keeps well-formed pairs and drops everything else", () => {
  const kept = Memory.normalizeGaugeSettings({
    psi: { amber: 70, red: 90 },
    hd: { amber: 80.9, red: 90.4 },
    batt: { amber: 20, red: 10 },
    vram: { amber: 1500, red: 500 },
    junk: { amber: 1, red: 2 },
  });
  same(kept, {
    batt: { amber: 20, red: 10 },
    vram: { amber: 1500, red: 500 },
  }, "batt and vram round; psi and hd live only in the thresholds store; junk drops");

  for (const junk of [null, "x", 5, {}, { batt: null }, { batt: "x" }, { batt: { amber: 1 } }, { batt: { red: 2 } }, { batt: { amber: "hot", red: 10 } }, { psi: { amber: 70, red: 90 } }]) {
    same(Memory.normalizeGaugeSettings(junk), {}, `junk gauge settings ${JSON.stringify(junk)} store nothing`);
  }
});

test("the settings round trip keeps the gauge pairs beside the ceilings", () => {
  const settings = Memory.normalizeSettings({
    thresholds: { hd: { amber: 85, red: 92 } },
    gaugeSettings: { batt: { amber: 25, red: 5 }, vram: { amber: 2000, red: 800 } },
  });
  same(settings.gaugeSettings, { batt: { amber: 25, red: 5 }, vram: { amber: 2000, red: 800 } });
  same(settings.thresholds.hd, {
    amber: 85, amberSetBy: "user", red: 92, redSetBy: "user",
    critical: null, criticalSetBy: null, updatedAt: null,
  }, "the ceilings round trip beside them, with their provenance");

  const empty = Memory.normalizeSettings({});
  same(empty.gaugeSettings, {}, "no pairs stored is no pairs, not garbage");
});

test("any pair the state file could hold reads back in range, ordered on the law's gauges, in both kernels", () => {
  const stored = [
    { amber: 70, red: 90 }, { amber: 95, red: 70 }, { amber: 0, red: 100 },
    { amber: -10, red: 500 }, { amber: "hot", red: 90 }, { amber: 1.4, red: 98.9 },
    { amber: 6000, red: 800 }, { amber: 300, red: 500 },
  ];
  for (const raw of stored) {
    for (const key of Q.GAUGE_KEYS) {
      const fromDisk = Memory.normalizeGaugeSettings({ [key]: raw })[key];
      if (fromDisk === undefined) continue;
      const p = Q.gaugePair(key, fromDisk);
      const range = Q.gaugeRange(key);
      assert.ok(p.amber >= range.min && p.amber <= range.max, `${key} amber ${p.amber} in range from ${JSON.stringify(raw)}`);
      assert.ok(p.red >= range.min && p.red <= range.max, `${key} red ${p.red} in range from ${JSON.stringify(raw)}`);
      if (Q.gaugeRedAbove(key)) assert.ok(p.red >= p.amber, `${key} red above amber from ${JSON.stringify(raw)}`);
      else if (key !== "batt") assert.ok(p.amber >= p.red, `${key} amber above red from ${JSON.stringify(raw)}`);
      // batt keeps whatever it stored: duplicates of a color are allowed there.
    }
  }
});

// ---------------------------------------------------------------------------
// Delegation: the widget writes thresholds only through Memory.setCeiling, and
// the panel edits only through the widget's own functions
// ---------------------------------------------------------------------------

test("the widget applies the pair through the slider model and persists through setCeiling", () => {
  const QML = repoFile("memory-monitor/MemoryMonitor.qml");
  assert.equal(QML.includes("Quattro.adjustGaugePair("), true,
    "the push model is quattro.js's, never re-implemented in the widget");
  assert.equal(QML.includes("Quattro.gaugePair("), true);
  assert.equal(QML.includes("Quattro.GAUGE_DEFAULTS"), true,
    "the reset button writes the recommended defaults");
  assert.equal(QML.includes("Memory.setCeiling("), true,
    "the RAM and root pairs write the real alert ceilings through setCeiling");
  assert.equal(QML.includes("function gaugePairFor("), true);
  assert.equal(QML.includes("function setGaugePair("), true);
  assert.equal(QML.includes("function resetGaugeSettings("), true);
  assert.equal(QML.includes("gaugeSaveTimer.restart()"), true,
    "a drag lands per movement, so the disk write is coalesced");
  assert.equal(QML.includes("gaugeSettings: normalizeGaugeSettings(raw.gaugeSettings)") ||
    repoFile("memory-monitor/memory.js").includes("gaugeSettings: normalizeGaugeSettings(raw.gaugeSettings)"), true,
    "loadState keeps the persisted pairs through the settings normalizer");
  assert.equal(/setting\(\s*"gaugeSettings"/.test(QML), false,
    "the pairs live in the plugin state file, not a shell setting");
});

test("the panel renders the settings row from quattro.js and edits through the monitor", () => {
  const PANEL = repoFile("memory-monitor/QuattroDash.qml");
  assert.equal(PANEL.includes("Quattro.SETTINGS.copy[gaugeRow.gaugeKey]"), true,
    "each row's sentence is quattro.js's, not the panel's");
  assert.equal(PANEL.includes("Quattro.battSegmentZone("), true, "round 7 item 1: the battery colors its bars from the drawn pair, no tick lines");
  assert.equal(PANEL.includes("Quattro.coolantBandWith("), true,
    "the coolant light tints from the settings pair, not the fixed margin");
  assert.equal(PANEL.includes("onClicked: content.settingsOpen = !content.settingsOpen"), true,
    "the settings row collapses");
  assert.equal(PANEL.includes("RESET TO DEFAULTS") || PANEL.includes("Quattro.SETTINGS.reset"), true,
    "the row carries the reset button");
});

test("the settings copy carries no ordering warning and no band-color essay", () => {
  const strings = [Q.SETTINGS.hint].concat(Q.GAUGE_KEYS.map(key => Q.SETTINGS.copy[key]));
  assert.equal(strings.some(s => /warn/i.test(s)), false,
    "no warning message guards the ordering: the sliders and the coloring do");
  assert.equal(strings.some(s => /amber|red/i.test(s)), false,
    "round 7 item 3: the copy describes the metric, not the colors");
});

test("a refused threshold lands as quattro.js's toast naming the critical line", () => {
  const t = Q.ceilingBlockedToast("psi", 70, 90);
  assert.equal(t.mark, "\u2717");
  assert.equal(t.code, "THRESHOLD");
  assert.equal(t.text, "the RAM PRESSURE critical line at 70 must sit above red 90. raise critical first.");
  assert.equal(/[\u2013\u2014;]/.test(t.text), false, "the refusal copy keeps the language law");

  const hd = Q.ceilingBlockedToast("hd", 85, 90);
  assert.equal(hd.text.includes("ROOT DRIVE"), true, "the toast names the gauge that blocked it");

  const noCritical = Q.ceilingBlockedToast("psi", null, 90);
  assert.equal(noCritical.text, "the RAM PRESSURE red line could not move to 90.",
    "a refusal with no critical in the record still says what did not happen");
});

test("the widget returns quattro.js's toast on a blocked write and the dash shows it", () => {
  const QML = repoFile("memory-monitor/MemoryMonitor.qml");
  assert.equal(QML.includes("return Quattro.ceilingBlockedToast(key, cur.critical, next.red)"), true,
    "a refused drag hands back quattro.js's toast instead of returning silently");
  assert.equal(QML.includes("return Quattro.ceilingBlockedToast(key, cur.critical, pairs[key].red)"), true,
    "a blocked reset hands back quattro.js's toast naming the blocking gauge");

  const PANEL = repoFile("memory-monitor/QuattroDash.qml");
  assert.equal(PANEL.includes("root.showToast(refused, true)"), true,
    "the dash surfaces the refused write through its own toast lane");
});
