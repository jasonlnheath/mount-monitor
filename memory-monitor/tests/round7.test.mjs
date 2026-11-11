// Round 7: the captain's 13 rulings over the QuattroDash. These tests pin the
// NEW laws before the implementation moves: RAM is pressure (PSI) and swap
// reserve, never percent-used; every toast is temporary and says Quattro Dash;
// the battery's bars are the threshold display; popups are one reading line.
// Red first - every assertion here failed against the round-6 code.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Memory, Quattro, fixture, repoFile } from "./load.mjs";

const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ID = "io.github.jasonlnheath.memory-monitor";

const PSI_T = { amber: 70, red: 90, critical: null };
const BATT = { amber: 20, red: 10 };

function ramAlert(band, pct, signal) {
  return { type: "ram", key: signal === "swap" ? "ram:swap" : "ram:psi", id: Memory.memId("ram"), band, pct, signal };
}

// ---------------------------------------------------------------------------
// 6/7/8. The RAM metric is PSI pressure + the swap reserve, never percent-used
// ---------------------------------------------------------------------------

test("psiBandFor judges PSI against the ram threshold store", () => {
  assert.equal(Memory.psiBandFor(69.9, PSI_T), 0);
  assert.equal(Memory.psiBandFor(70, PSI_T), 1);
  assert.equal(Memory.psiBandFor(89.9, PSI_T), 1);
  assert.equal(Memory.psiBandFor(90, PSI_T), 2);
  assert.equal(Memory.psiBandFor(null, PSI_T), 0, "no reading is no band, not a healthy zero");
  const withCritical = Memory.psiBandFor(95, { amber: 70, red: 90, critical: 95 });
  assert.equal(withCritical, 3, "a user-set critical PSI makes the critical band");
});

test("the swap reserve resolves through the generic band machinery", () => {
  // The battery pair is free-percent; the reserve thresholds invert it into
  // the used-percent lines the generic resolveBand judges (amber 20 free = 80
  // used, red 10 free = 90 used).
  const t = Memory.reserveThresholds(BATT);
  assert.equal(t.amber, 80);
  assert.equal(t.red, 90);
  assert.equal(t.critical, null);
  assert.equal(Memory.bandForPct(9, t), 0, "9 percent used is a healthy reserve");
  assert.equal(Memory.bandForPct(85, t), 1, "85 percent used = 15 percent free, under the amber line");
  assert.equal(Memory.bandForPct(95, t), 2, "95 percent used = 5 percent free, under the red line");
});

test("the ram badge band is the worse of pressure and reserve", () => {
  assert.equal(Memory.ramCombinedBand(0, 2), 2);
  assert.equal(Memory.ramCombinedBand(2, 0), 2);
  assert.equal(Memory.ramCombinedBand(1, 1), 1);
  assert.equal(Memory.ramCombinedBand(0, 0), 0);
});

test("the ram toast says the signal, never percent-used", () => {
  same2(
    Memory.amberBody(ramAlert(1, 72, "psi")).split("\n"),
    ["Caution: Amber Alert", "System RAM pressure has reached 72 PSI.", "Click to address with agent, otherwise ignore."],
  );
  same2(
    Memory.amberBody(ramAlert(1, 18, "swap")).split("\n"),
    ["Caution: Amber Alert", "Swap reserve is 18 percent used.", "Click to address with agent, otherwise ignore."],
  );
  same2(
    Memory.redBody(ramAlert(2, 91, "psi")).split("\n"),
    [
      "WARNING: RED ALERT",
      "System RAM pressure has reached 91 PSI.",
      "Click to open an agent to actively monitor/guard against OOM, otherwise ignore.",
    ],
  );
  same2(
    Memory.redBody(ramAlert(2, 8, "swap")).split("\n"),
    [
      "WARNING: RED ALERT",
      "Swap reserve is 8 percent used.",
      "Click to open an agent to actively monitor/guard against OOM, otherwise ignore.",
    ],
  );
  assert.match(Memory.criticalBody({ pct: 96, signal: "psi", guardState: "armed" }), /System RAM pressure has reached 96 PSI\./);
  // hd and vram keep the spec's own wording.
  assert.match(Memory.amberBody({ type: "hd", pct: 82 }), /Device \(Hard drive\) has reached 82% usage\./);
  assert.match(Memory.redBody({ type: "vram", pct: 91 }), /Device \(VRAM\) has reached 91% usage\./);
  // A ram alert without a signal defaults to the pressure reading.
  assert.match(Memory.amberBody({ type: "ram", band: 1, pct: 75 }), /System RAM pressure has reached 75 PSI\./);
});

function same2(actual, expected) {
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
}

test("the detail window's ram headline reads pressure and swap, not percent-used", () => {
  const line = Memory.ramReadingLine({
    type: "ram", band: 1, pct: 62, psiSomeAvg10: 12.34,
    swapPct: 15.4, swapUsedKb: 1258291, swapTotalKb: 8388608,
    memAvailableKb: 10485760, memTotalKb: 27487790694, latched: false,
  });
  assert.match(line, /RAM PRESSURE 12\.3 PSI/);
  assert.match(line, /swap 16% used/);
  assert.match(line, /1\.2 GiB of 8 GiB/);
  assert.equal(line.includes("62%"), false, "the used percent is not the headline anymore");
});

test("a PSI band always releases: no MemAvailable gate on a pressure metric", () => {
  const reachable = Memory.descentReachable(2, PSI_T, "ram", 4_482_240, 65_588_588);
  assert.equal(reachable.reachable, true, "pressure falls on its own; the old memory gate is obsolete");
  const note = Memory.unreachableBandNote(2, PSI_T, "ram", 4_482_240, 65_588_588);
  assert.match(note, /releases below 86 PSI/);
  assert.equal(note.includes("GiB"), false, "a PSI release is not stated in memory bytes");
});

test("a held ram band's release note reads the store that resolved the band", () => {
  const store = Memory.ramReleaseStore("swap", PSI_T, BATT);
  assert.equal(store.type, "swap");
  assert.equal(store.thresholds.amber, 80);
  assert.equal(store.thresholds.red, 90);
  assert.equal(
    Memory.unreachableBandNote(2, store.thresholds, store.type, 1, 1, "swap"),
    "This band releases below 88% used.",
    "the swap-held band releases on the reserve's own line and margin, never the PSI pair's",
  );
  const psi = Memory.ramReleaseStore("psi", PSI_T, BATT);
  assert.equal(psi.type, "ram");
  assert.equal(psi.thresholds, PSI_T);
  assert.equal(Memory.unreachableBandNote(2, psi.thresholds, psi.type, 1, 1, "psi"), "This band releases below 86 PSI.");
});

// ---------------------------------------------------------------------------
// 5. The toasts are Quattro Dash's, not Memory Monitor's
// ---------------------------------------------------------------------------

test("the notifier app is Quattro Dash", () => {
  assert.equal(Memory.NOTIFIER_APP, "Quattro Dash");
  assert.equal(Memory.titleFor(ramAlert(2, 91, "psi")), "Quattro Dash");
  assert.equal(Memory.criticalTitle(), "Quattro Dash");
  assert.equal(Memory.actionFor(ramAlert(3, 98, "psi")), "Open Quattro Dash");
  assert.equal(Memory.guardAskTitle(), "Quattro Dash - the guard");
  assert.match(Memory.guardAskBody({}), /Quattro Dash watches System RAM, VRAM and your drives\./);
  assert.match(Memory.ceilingsQuestion("ram", null, null, {}, null), /^Quattro Dash - System RAM ceilings/);
  assert.match(Memory.agentPrompt({ band: 2, type: "ram", key: "ram" }, null, null, "/log"), /^Quattro Dash reports that/);
  assert.match(Memory.healthCheckPrompt("/log", null, null), /Quattro Dash health check\./);
  assert.match(Memory.onboardingPrompt(null, null, {}, "/log", null), /Quattro Dash first run\./);
});

test("no user-visible copy still says Memory Monitor", () => {
  const texts = [];
  texts.push(
    Memory.amberBody({ type: "hd", pct: 82 }),
    Memory.redBody({ type: "vram", pct: 91 }),
    Memory.criticalBody({ pct: 98, guardState: "armed" }),
    Memory.criticalBody({ pct: 98, guardState: "off" }),
    Memory.criticalBody({ pct: 98, guardState: "refused" }),
    Memory.criticalBody({ pct: 98, guardState: "died" }),
    Memory.titleFor(ramAlert(1, 82, "psi")),
    Memory.actionFor(ramAlert(3, 98, "psi")),
    Memory.guardAskTitle(),
    Memory.guardAskBody({}),
    Memory.ceilingsQuestion("ram", null, null, {}, null),
    Memory.ceilingsQuestion("vram", null, null, {}, null),
    Memory.ceilingsQuestion("hd", null, null, {}, null),
    Memory.guardStateText({}),
    Memory.ceilingText("ram", {}),
    Memory.twoCeilingsNote(),
    Memory.guardNoteText(),
    Memory.guardArmTooltip(),
    Memory.guardDeclineTooltip(),
    Memory.healthCheckTooltip(),
    Memory.kernelCeilingText(null),
    Memory.noWatchedDrivesText(),
    Memory.unreachableBandNote(2, PSI_T, "ram", 1, 1),
    Memory.unreachableBandNote(2, { amber: 80, red: 90, critical: null }, "ram", 1, 1, "swap"),
    Memory.ramReadingLine({ psiSomeAvg10: 1, swapPct: 1, swapUsedKb: 1, swapTotalKb: 1, memAvailableKb: 1, memTotalKb: 1 }),
    Memory.psiText({}),
    Memory.swapText({}),
    Memory.vramUnattributedText(null),
    Memory.alertsYouDidNotSeeText([]),
    Memory.latchedText(true),
    Memory.barTooltip([]),
    Memory.onboardingPrompt(null, null, {}, "/log", null),
    Memory.healthCheckPrompt("/log", null, null),
    Memory.agentPrompt({ band: 1, type: "ram", key: "ram" }, null, null, "/log"),
  );
  for (const key of Object.keys(Memory.DEGRADATIONS)) texts.push(Memory.degradationText(key));
  for (const alert of [ramAlert(1, 82, "psi"), ramAlert(2, 91, "psi"), ramAlert(3, 98, "psi"), { kind: "ceilings", band: 3 }, { kind: "guard-ask", band: 3 }]) {
    texts.push(Memory.notifyArgs(alert, null, {}).join(" "));
    texts.push(Memory.clickArgvFor(alert, null, { logPath: "/log" })[3] || "");
  }
  const bad = texts.filter(t => typeof t === "string" && t.includes("Memory Monitor"));
  assert.deepEqual(bad, [], `the toasts rename to Quattro Dash: ${JSON.stringify(bad)}`);
});

// ---------------------------------------------------------------------------
// 12. Every toast is temporary, and the button reads its label alone
// ---------------------------------------------------------------------------

test("no toast is permanent any more", () => {
  for (const band of [0, 1, 2, 3]) {
    assert.equal(Memory.urgencyFor(ramAlert(band === 0 ? 1 : band, 90, "psi")), "normal",
      `band ${band} rides normal urgency: this shell's service forces critical to never expire`);
    assert.ok(Memory.timeoutFor(ramAlert(band === 0 ? 1 : band, 90, "psi")) > 0, `band ${band} has a finite timeout`);
  }
  for (const kind of ["ceilings", "guard-ask"]) {
    const notice = { kind, band: 3 };
    assert.equal(Memory.urgencyFor(notice), "normal");
    assert.ok(Memory.timeoutFor(notice) > 0);
  }
  for (const band of [1, 2, 3]) {
    assert.equal(Memory.bypassesDnd(ramAlert(band, 90, "psi")), false, "nothing bypasses DND when nothing is permanent");
  }
  for (const band of Object.keys(Memory.TIMEOUT_MS)) {
    assert.ok(Memory.TIMEOUT_MS[band] > 0, `TIMEOUT_MS[${band}] is finite`);
  }
});

test("the claim toast is temporary too", () => {
  const args = Memory.notifyReplaceArgs("42", "Quattro Dash", "body", {
    clickArgv: Memory.ipcOpenDetailArgv(),
    action: Memory.actionFor({ kind: "alert", band: 3 }),
  });
  assert.equal(args[args.indexOf("-u") + 1], "normal");
  assert.ok(Number(args[args.indexOf("-t") + 1]) > 0, "the claim expires like every other toast");
});

test("the action button carries its label without the default: prefix", () => {
  for (const alert of [ramAlert(1, 82, "psi"), ramAlert(2, 91, "psi"), ramAlert(3, 98, "psi")]) {
    const action = Memory.notifyArgs(alert, null, {})[Memory.notifyArgs(alert, null, {}).indexOf("-A") + 1];
    assert.match(action, /^default=[A-Z]/, "libnotify's NAME=TEXT form: the button shows TEXT alone");
    assert.equal(action.startsWith("default:"), false, "a colon makes the button read 'default: ...'");
  }
});

test("the toast logo is the check-engine emblem", () => {
  assert.equal(Memory.toastIconFor(0), "mil-plain.png");
  assert.equal(Memory.toastIconFor(1), "mil-amber.png");
  assert.equal(Memory.toastIconFor(2), "mil-red.png");
  assert.equal(Memory.toastIconFor(3), "mil-red.png");
  assert.equal(Memory.toastIconFor({ kind: "ceilings", band: 3 }), "mil-plain.png", "a question carries the plain mark");
  const argv = Memory.notifyArgs(ramAlert(2, 91, "psi"), null, { iconDir: "/plugins/mm/icons" });
  assert.equal(argv[argv.indexOf("-i") + 1], "/plugins/mm/icons/mil-red.png");
  const plain = Memory.notifyArgs(ramAlert(1, 82, "psi"), null, {});
  assert.equal(plain.includes("-i"), false, "no icon directory, no icon flag, no invented path");
});

// ---------------------------------------------------------------------------
// 10, reshaped by round 7.5 item 22: the shell renders the tooltip in a
// monospace font, so the pad is a character count and the dots align by
// construction. The width-estimate law is gone (see round75.test.mjs).
// ---------------------------------------------------------------------------

test("barTooltip aligns its dot column by character count in the mono font", () => {
  const tip = Memory.barTooltip([
    { type: "ram", band: 0, pct: 42 },
    { type: "vram", band: 1, pct: 63 },
    { type: "hd", band: 2, pct: 97 },
  ]);
  const lines = tip.split("\n").slice(1);
  const charLens = lines.map((l) => [...l].length);
  assert.equal(new Set(charLens).size, 1, "every row is the same character count: one dot column");
  const dots = lines.map((l) => [...l].lastIndexOf(" ") + 1);
  assert.equal(new Set(dots).size, 1, "every dot starts at the same character index");
});

test("the ram band is the more severe of the pressure and swap bands, and names its signal", () => {
  const RAM_T = { amber: 70, red: 90, critical: null };
  const BATT = { amber: 20, red: 10 };
  // swapPct is the USED percent everywhere: swapTotals computes used/size, the
  // toast says "N percent used", and the reserve thresholds invert the free
  // pair into used lines (80/90). The band function takes the same field.
  const band = (psi, swapPct, prev) => Memory.resolveRamBand(
    { psiSomeAvg10: psi, swapPct: swapPct }, RAM_T, prev === undefined ? 0 : prev, BATT);
  assert.equal(band(75, 15).band, 1, "75 PSI crosses the 70 amber");
  assert.equal(band(75, 15).signal, "psi");
  assert.equal(band(92, 15).band, 2, "92 PSI crosses the 90 red");
  assert.equal(band(40, 5).band, 0, "swap 5 percent used is a healthy reserve, not a red band");
  assert.equal(band(40, 85).band, 1, "swap 85 percent used is 15 percent free, under the 20 amber");
  assert.equal(band(40, 85).signal, "swap");
  assert.equal(band(40, 95).band, 2, "swap 95 percent used is 5 percent free, under the 10 red");
  assert.equal(band(40, 95).signal, "swap");
  assert.equal(band(40, 30).band, 0);
  assert.equal(band(40, null).band, 0, "no swap configured is no band, never a healthy zero");
  assert.equal(band(null, null).band, 0, "no PSI reading is no band");
  assert.equal(band(92, 95).signal, "psi", "both signals red: the toast says pressure");
  // Each signal hysteresizes in its own unit against the same held band.
  assert.equal(band(87, 30, 2).band, 2, "leaving red 90 needs 4 PSI of margin, not a dip to 87");
  assert.equal(band(85, 30, 2).band, 1, "85 PSI is below the 86 release line");
  assert.equal(band(40, 86, 2).band, 1, "leaving the red reserve needs 4 used-percent of margin: 86 used is below the 90 line by exactly the margin");
  assert.equal(band(40, 89, 2).band, 2, "89 used does not clear the reserve release line");
});

// ---------------------------------------------------------------------------
// 3/4/1/9/2 in quattro.js: settings copy, rename, the battery picker, swap line,
// one-line popups
// ---------------------------------------------------------------------------

test("the settings row title is VRAM, not VRAM COOLANT", () => {
  assert.equal(Quattro.gaugeTitle("vram"), "VRAM");
  assert.equal(Quattro.GAUGE_TITLES.vram, "VRAM");
});

test("the battery picker allows duplicates: no reorder, no push", () => {
  same2(Quattro.gaugePair("batt", { amber: 5, red: 10 }), { amber: 5, red: 10 },
    "a crossed stored pair is kept: duplicates of a color are allowed");
  same2(Quattro.gaugePair("batt", { amber: 30, red: 30 }), { amber: 30, red: 30 });
  same2(Quattro.adjustGaugePair("batt", "red", 30, { amber: 20, red: 10 }), { amber: 20, red: 30 },
    "pulling red past amber colors more bars red and pushes nothing");
  same2(Quattro.adjustGaugePair("batt", "amber", 8, { amber: 20, red: 10 }), { amber: 8, red: 10 });
  // The other gauges keep their ordering law.
  same2(Quattro.gaugePair("psi", { amber: 95, red: 70 }), { amber: 95, red: 95 });
  same2(Quattro.adjustGaugePair("vram", "red", 1600, { amber: 1500, red: 500 }), { amber: 1600, red: 1600 });
});

test("the battery's bars are the threshold display: red-first zones, no tick lines", () => {
  assert.equal(Quattro.battSegmentZone(5, BATT), "red");
  assert.equal(Quattro.battSegmentZone(15, BATT), "amber");
  assert.equal(Quattro.battSegmentZone(25, BATT), "green");
  assert.equal(Quattro.battSegmentZone(25, { amber: 20, red: 30 }), "red", "a crossed pair extends red upward");
  assert.equal(Quattro.battSegmentZone(35, { amber: 30, red: 30 }), "green", "a duplicated pair draws one run");
  // Two red bars at ~20, three red bars at ~30: the captain's example.
  const barsAt = pair => [5, 15, 25, 35, 45].map(c => Quattro.battSegmentZone(c, pair));
  same2(barsAt({ amber: 40, red: 20 }), ["red", "red", "amber", "amber", "green"]);
  same2(barsAt({ amber: 40, red: 30 }), ["red", "red", "red", "amber", "green"]);
  assert.equal(Quattro.battTickFracs, undefined, "the moving red and yellow lines are gone");
  assert.equal(Quattro.ledBandWith(15, 10, 30), "red", "the band word agrees with the crossed-pair coloring");
});

test("the settings copy says what each metric is and why we measure it, no amber and no red", () => {
  for (const key of Quattro.GAUGE_KEYS) {
    const copy = Quattro.SETTINGS.copy[key];
    assert.equal(typeof copy, "string", `${key} has copy`);
    // Round 7.5 item 18: one flowing paragraph, two sentences.
    assert.doesNotMatch(copy, /\n/, `${key}'s copy is one paragraph, not two lines`);
    const parts = copy.split(". ");
    assert.equal(parts.length, 2, `${key}'s copy is one what sentence and one why sentence`);
    assert.ok(/^[A-Z]/.test(copy) && /\.$/.test(copy), `${key}'s paragraph starts and ends cleanly`);
    assert.equal(/amber|red/i.test(copy), false, `${key}'s copy names no band color`);
  }
  assert.equal(Quattro.SETTINGS.hint, "Drag a slider to set where each color starts.");
});

test("the hover popups are the simple reading, one line", () => {
  const psi = Quattro.psiTipWith({ some_avg10: 12.8 }, 70, 90);
  assert.equal(psi.header, "RAM PRESSURE");
  assert.equal(psi.rows.length, 1);
  assert.equal(psi.rows[0].text, "12.8 PSI, green, healthy.");
  const batt = Quattro.battTipWith({ present: true, pct: 38 }, 20, 10);
  assert.equal(batt.rows.length, 1);
  assert.equal(batt.rows[0].text, "38 percent remaining right now.");
  const fuel = Quattro.fuelTipWith({ pctFree: 77, availKb: 1501820186, sizeKb: 1950990074 }, 80, 90);
  assert.equal(fuel.rows.length, 1);
  assert.equal(fuel.rows[0].text, "77% Free (1538/1998 GB).",
    "round 7.5 item 17: the standard free format");
  const coolant = Quattro.coolantTipWith({ present: true, usedMib: 15200, freeMib: 1184, totalMib: 16384 }, 500, 1500);
  assert.equal(coolant.rows.length, 1);
  assert.equal(coolant.rows[0].text, "7% Free (1.2/16.0 GiB).",
    "round 7.5 item 17: the standard free format");
  assert.equal(Quattro.psiTipWith(null, 70, 90).rows[0].text, "no pressure reading yet.");
  assert.equal(Quattro.battTipWith({ present: false, pct: 0 }, 20, 10).rows[0].text, "no swap is configured.");
  assert.equal(Quattro.fuelTipWith(null, 80, 90).rows[0].text, "no root reading yet.");
  assert.equal(Quattro.coolantTipWith(null, 500, 1500).rows[0].text, "no VRAM reading yet.");
});

test("the code row's hover is one line too", () => {
  const codes = Quattro.codesFromReadings([
    { type: "hd", key: "partuuid:aabb", id: "mem-2b4e1c05", band: 2, pct: 96, target: "/", ro: false }]);
  const tip = Quattro.codeTip(codes[0]);
  assert.equal(tip.rows.length, 1);
  assert.equal(tip.rows[0].label, "Status:");
  assert.equal(tip.rows[0].text, codes[0].status);
});

test("the values popup carries the SWAP row in the standard free format", () => {
  const swap = { swapTotalKb: 8 * 1048576, swapUsedKb: Math.round(1.2 * 1048576) };
  assert.equal(Quattro.swapLine(swap), "85% Free (6.8/8 GiB)");
  assert.equal(Quattro.swapLine({ swapTotalKb: 0, swapUsedKb: 0 }), "none configured");
  assert.equal(Quattro.swapLine(null), "none configured");
  const rows = Quattro.valueRows(20, { present: true, pct: 85 }, swap,
    { availKb: 426757813, sizeKb: 546875001, pctFree: 78 },
    { vramUsedMib: 9000, vramFreeMib: 7303, vramTotalMib: 16303 }, []);
  const labels = rows.map(r => r.label);
  same2(labels, ["RAM PRESSURE", "SWAP RESERVE", "SWAP", "ROOT DRIVE", "VRAM"]);
  assert.equal(rows[2].value, "85% Free (6.8/8 GiB)");
  assert.match(rows[3].value, /^78% Free \([\d.]+\/[\d.]+ GB\)$/);
  assert.match(rows[4].value, /^45% Free \([\d.]+\/[\d.]+ GiB\)$/);
});

test("the ram ceilings question speaks PSI", () => {
  const RAM = { type: "ram", pct: 62.4, memTotalKb: 65588588, memAvailableKb: 24672688, psiSomeAvg10: 12.34, swapPct: 15.4 };
  const text = Memory.ceilingsQuestion("ram", RAM, { oomdActive: false }, {}, null);
  assert.match(text, /Your amber: 70 PSI \(default\)\. Your red: 90 PSI \(default\)\./);
  assert.match(text, /Measured now: RAM PRESSURE 12\.3 PSI, swap 16% used/);
  assert.match(text, /Recommended defaults until measured: amber 70 PSI, red 90 PSI, critical unset\./);
});

test("the ram resting level is measured in PSI from the log", () => {
  const sample = psi => Memory.logLine(Memory.logRecord({
    at: "2026-11-04T00:00:00.000Z",
    ram: { pct: 40, psiSomeAvg10: psi },
  }));
  const full = Array.from({ length: Memory.RESTING_MIN_SAMPLES }, (_, i) => sample(i < 24 ? 2 : 4)).join("\n");
  const resting = Memory.restingFromLog(full);
  assert.equal(resting.ram, 2, "the log's own PSI distribution decides, not the live reading");
  const rec = Memory.recommendCeilings("ram", { ram: 4 });
  assert.equal(rec.restingPct, 4);
  assert.ok(rec.amber > rec.restingPct, "a PSI recommendation still clears the resting level");
  // The PSI recommendation floors at the captain-approved defaults: a resting
  // 4 is not a machine that wants an amber at 6.
  same2([rec.amber, rec.red, rec.critical], [70, 90, 95]);
});

// ---------------------------------------------------------------------------
// The new copy obeys the quattro language law
// ---------------------------------------------------------------------------

test("the round-7 strings keep the no-em-dash law", () => {
  const texts = [
    Quattro.SETTINGS.hint,
    ...Quattro.GAUGE_KEYS.map(key => Quattro.SETTINGS.copy[key]),
    Quattro.swapLine(null),
    Quattro.swapLine({ swapTotalKb: 8 * 1048576, swapUsedKb: 1048576 }),
  ];
  const tips = [
    Quattro.psiTipWith({ some_avg10: 12.8 }, 70, 90),
    Quattro.battTipWith({ present: true, pct: 38 }, 20, 10),
    Quattro.fuelTipWith({ pctFree: 77, availKb: 1501820186, sizeKb: 1950990074 }, 80, 90),
    Quattro.coolantTipWith({ present: true, usedMib: 15200, freeMib: 1184, totalMib: 16384 }, 500, 1500),
    Quattro.psiTipWith(null, 70, 90),
  ];
  for (const tip of tips) {
    texts.push(tip.header);
    for (const row of tip.rows) texts.push(row.label, row.text);
  }
  const bad = texts.filter(t => /[\u2014\u2013;]/.test(t));
  assert.deepEqual(bad, [], `banned characters in round-7 copy: ${JSON.stringify(bad)}`);
});

// ---------------------------------------------------------------------------
// Ruling 14 (mid-build, from the captain): the product RENAME. Every
// user-visible "Memory Monitor" string becomes "Quattro Dash"; the technical
// plugin id, directory, IPC target and the trust fence stay unchanged.
// ---------------------------------------------------------------------------

test("ruling 14: the manifest names the product Quattro Dash, keeping the technical id", () => {
  const manifest = JSON.parse(repoFile("memory-monitor/manifest.json"));
  assert.equal(manifest.id, "io.github.jasonlnheath.memory-monitor", "the technical id is unchanged");
  assert.equal(manifest.name, "Quattro Dash");
  assert.equal(manifest.barWidget.displayName, "Quattro Dash");
  assert.equal(manifest.description.includes("Memory Monitor"), false);
  assert.equal(manifest.barWidget.description.includes("Memory Monitor"), false);
});

test("ruling 14: the plugin README speaks Quattro Dash", () => {
  const readme = repoFile("memory-monitor/README.md");
  assert.equal(readme.includes("Memory Monitor"), false, "the user-facing docs carry the rename");
});

test("ruling 14: install.sh copies the toast icons beside the installed widget", () => {
  const home = mkdtempSync(path.join(tmpdir(), "mm-round7-install-"));
  try {
    const run = spawnSync("bash", [path.join(PLUGIN_DIR, "install.sh")], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });
    assert.equal(run.status, 0, `install.sh failed: ${run.stderr}`);
    const icons = path.join(home, ".config", "omarchy", "plugins", PLUGIN_ID, "icons");
    for (const name of ["mil-plain.png", "mil-amber.png", "mil-red.png"]) {
      assert.ok(existsSync(path.join(icons, name)), `${name} is installed beside the widget`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
