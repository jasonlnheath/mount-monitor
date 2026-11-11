// Round 7: the captain's 13 rulings over the QuattroDash. These tests pin the
// NEW laws before the implementation moves: RAM is pressure (PSI) and swap
// reserve, never percent-used; every toast is temporary and says Quattro Dash;
// the battery's bars are the threshold display; popups are one reading line.
// Red first - every assertion here failed against the round-6 code.
import test from "node:test";
import assert from "node:assert/strict";
import { Memory, Quattro, fixture } from "./load.mjs";

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

test("reserveBandFor: the battery pair is a real signal, red checked first", () => {
  assert.equal(Memory.reserveBandFor(null, BATT), 0, "no swap configured is no band");
  assert.equal(Memory.reserveBandFor(9.9, BATT), 2);
  assert.equal(Memory.reserveBandFor(10, BATT), 1);
  assert.equal(Memory.reserveBandFor(19.9, BATT), 1);
  assert.equal(Memory.reserveBandFor(20, BATT), 0);
  // A crossed or duplicated pair the new picker allows still reads one way:
  // red wins the overlap.
  assert.equal(Memory.reserveBandFor(15, { amber: 10, red: 30 }), 2, "red dominates the overlap");
});

test("the reserve pair inverts into the generic band machinery", () => {
  assert.equal(Memory.reserveUsedPct(20), 80);
  assert.equal(Memory.reserveUsedPct(null), null);
  const t = Memory.reserveThresholds(BATT);
  assert.equal(t.amber, 80);
  assert.equal(t.red, 90);
  assert.equal(t.critical, null);
  assert.equal(Memory.bandForPct(Memory.reserveUsedPct(9), t), 2, "9 percent free is band 2 through the same resolveBand math");
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
    ["Caution: Amber Alert", "Swap reserve is down to 18 percent.", "Click to address with agent, otherwise ignore."],
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
      "Swap reserve is down to 8 percent.",
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

test("the ram tooltip reads pressure and swap, not percent-used", () => {
  const tip = Memory.tooltipText({
    type: "ram", band: 1, pct: 62, psiSomeAvg10: 12.34,
    swapPct: 15.4, swapUsedKb: 12582912, swapTotalKb: 8388608,
    memAvailableKb: 10485760, memTotalKb: 27487790694, latched: false,
  });
  const lines = tip.split("\n");
  assert.match(lines[0], /RAM PRESSURE - 12\.3 PSI/);
  assert.match(tip, /swap 16% used/);
  assert.equal(lines.some(l => /62%/.test(l)), false, "the used percent is not the headline anymore");
});

test("a PSI band always releases: no MemAvailable gate on a pressure metric", () => {
  const reachable = Memory.descentReachable(2, PSI_T, "ram", 4_482_240, 65_588_588);
  assert.equal(reachable.reachable, true, "pressure falls on its own; the old memory gate is obsolete");
  const note = Memory.unreachableBandNote(2, PSI_T, "ram", 4_482_240, 65_588_588);
  assert.match(note, /releases below 86 PSI/);
  assert.equal(note.includes("GiB"), false, "a PSI release is not stated in memory bytes");
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
  assert.match(Memory.ceilingsQuestion("ram", null, null, {}, null), /^Quattro Dash - System RAM ceilings$/);
  assert.match(Memory.agentPrompt({ band: 2, type: "ram", key: "ram" }, null, null, "/log"), /Quattro Dash reports that/);
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
    Memory.tooltipText({ type: "ram", band: 1, pct: 62, psiSomeAvg10: 1 }),
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
// 10. The tooltip's dot column lines up in a proportional font
// ---------------------------------------------------------------------------

test("barTooltip pads by estimated glyph width, not character count", () => {
  assert.ok(Memory.textWidthUnits("Drive") > Memory.textWidthUnits("RAM"), "width, not length, is the measure");
  const tip = Memory.barTooltip([
    { type: "ram", band: 0, pct: 42 },
    { type: "vram", band: 1, pct: 63 },
    { type: "hd", band: 2, pct: 97 },
  ]);
  const lines = tip.split("\n").slice(1);
  const widths = lines.map(l => Memory.textWidthUnits(l));
  for (const w of widths) assert.equal(w, widths[0], "every row's estimated width matches, so the dots sit in one column");
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
  same2(barsAt({ amber: 40, red: 20 }), ["red", "red", "amber", "green", "green"]);
  same2(barsAt({ amber: 40, red: 30 }), ["red", "red", "red", "amber", "green"]);
  assert.equal(Quattro.battTickFracs, undefined, "the moving red and yellow lines are gone");
  assert.equal(Quattro.ledBandWith(15, 10, 30), "red", "the band word agrees with the crossed-pair coloring");
});

test("the settings copy says what each metric is and why we measure it, no amber and no red", () => {
  for (const key of Quattro.GAUGE_KEYS) {
    const copy = Quattro.SETTINGS.copy[key];
    assert.equal(typeof copy, "string", `${key} has copy`);
    const sentences = copy.split("\n");
    assert.equal(sentences.length, 2, `${key}'s copy is one what line and one why line`);
    assert.ok(/^[A-Z]/.test(sentences[0]) && /\.$/.test(sentences[0]), `${key}'s what is one sentence`);
    assert.ok(/^[A-Z]/.test(sentences[1]) && /\.$/.test(sentences[1]), `${key}'s why is one sentence`);
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
  assert.equal(fuel.rows[0].text, "1538 GB free of 1998 GB (77 percent).");
  const coolant = Quattro.coolantTipWith({ present: true, usedMib: 15200, freeMib: 1184, totalMib: 16384 }, 500, 1500);
  assert.equal(coolant.rows.length, 1);
  assert.equal(coolant.rows[0].text, "14.8 GiB used, 1.2 GiB free of 16.0 GiB.");
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

test("the dash gains a SWAP line", () => {
  const swap = { swapTotalKb: 8 * 1048576, swapUsedKb: Math.round(1.2 * 1048576) };
  assert.equal(Quattro.swapLine(swap), "15 percent used, 1.2 GiB of 8 GiB");
  assert.equal(Quattro.swapLine({ swapTotalKb: 0, swapUsedKb: 0 }), "none configured");
  assert.equal(Quattro.swapLine(null), "none configured");
  const rows = Quattro.valueRows(20, { present: true, pct: 85 }, swap,
    { availKb: 426757813, sizeKb: 546875001, pctFree: 78 },
    { vramUsedMib: 9000, vramFreeMib: 7303, vramTotalMib: 16303 }, []);
  const labels = rows.map(r => r.label);
  assert.deepEqual(labels, ["RAM PRESSURE", "SWAP RESERVE", "SWAP", "ROOT DRIVE", "VRAM"]);
  assert.equal(rows[2].value, "15 percent used, 1.2 GiB of 8 GiB");
});

test("the ram ceilings question speaks PSI", () => {
  const RAM = { type: "ram", pct: 62.4, memTotalKb: 65588588, memAvailableKb: 24672688, psiSomeAvg10: 12.34, swapPct: 15.4 };
  const text = Memory.ceilingsQuestion("ram", RAM, { oomdActive: false }, {}, { ram: 12 });
  assert.match(text, /Your amber: 70 PSI \(default\)\. Your red: 90 PSI \(default\)\./);
  assert.match(text, /Measured now: RAM PRESSURE 12\.3 PSI, swap 15% used/);
  assert.match(text, /Recommended defaults until measured: amber 70 PSI, red 90 PSI, critical unset\./);
});

test("the ram resting level is measured in PSI from the log", () => {
  const sample = psi => Memory.logLine(Memory.logRecord({
    at: "2026-11-04T00:00:00.000Z",
    ram: { pct: 40, psiSomeAvg10: psi },
  }));
  const full = Array.from({ length: Memory.RESTING_MIN_SAMPLES }, (_, i) => sample(i < 24 ? 2 : 4)).join("\n");
  const resting = Memory.restingFromLog(full);
  assert.equal(resting.ram, 4, "the median PSI of the log's own distribution");
  const rec = Memory.recommendCeilings("ram", { ram: 4 });
  assert.equal(rec.restingPct, 4);
  assert.ok(rec.amber > rec.restingPct, "a PSI recommendation still clears the resting level");
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
