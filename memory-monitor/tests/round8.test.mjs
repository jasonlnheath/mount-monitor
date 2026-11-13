// Round 8: the captain's third-test-drive rulings, from the rig, 2026-11-12.
// These pin the five rulings before anything else moves:
//   1. 2-second polling while any monitored resource is amber or worse, or while
//      a plugin window is open. The lax nominal intervals are only for passive
//      cruising with everything green and nothing open. The baseline log keeps
//      its round-7 resting window through that faster sampling.
//   2. System RAM pressure alerts at 15 PSI (amber) and 28 PSI (red). The
//      useful band measured on the rig is heavy-but-playable at a sustained 8-15
//      and 28 is the observed wall.
//   3. Swap alerts past 45G used (amber, or climbing fast) and at 55G red on a
//      64G swap file, kept portable as percent-of-swap-used at 70 and 86, and
//      shown per rig in gigabytes.
//   4. The swap settings move in 5 GB steps and the hover reads
//      "Now: XX% Free (x/y GB)". The bar visual does not change.
//   5. The pressure gauge's face is 0 to 35 with true tick numbers, no hidden
//      rescale from a 0-100 dial, so the red line at 28 sits near the top.
//   6. The toast emblem renders whole at every toast width (same drive's inbox
//      steering, 001.msg): the logo the plugin hands the notification daemon is
//      drawn on a square canvas with the artwork inset, so the daemon's
//      crop-fill of a sender's picture has nothing left to cut.
// Red first - every assertion here failed against the round-7/7.5 code.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Memory, Quattro, repoFile, same } from "./load.mjs";
import { decodePng, coloredBounds } from "./png.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SWAP64 = { swapTotalKb: 64 * 1024 * 1024, swapUsedKb: 0 };
const PSI_T = { amber: 15, red: 28, critical: null };

// A ram reading with no swap contributes no reserve band: the PSI signal alone
// decides, which is what lets these tests name one signal at a time.
const psiOnly = psi => ({ pct: 62, psiSomeAvg10: psi, swapPct: null });
const swapOnly = usedPct => ({ pct: 62, psiSomeAvg10: 0, swapPct: usedPct });

// ---------------------------------------------------------------------------
// 2. The pressure ceilings the rig measured
// ---------------------------------------------------------------------------

test("ruling 2: System RAM goes amber at 15 PSI and red at 28 PSI", () => {
  assert.equal(Memory.defaultAmberFor("ram"), 15);
  assert.equal(Memory.defaultRedFor("ram"), 28);
  assert.equal(Memory.DEFAULT_AMBER_RAM, 15);
  assert.equal(Memory.DEFAULT_RED_RAM, 28);
  assert.equal(Memory.defaultRedFor("hd"), 90, "the drive ceilings are untouched");
  assert.equal(Memory.defaultRedFor("vram"), 90, "VRAM is untouched");
  assert.equal(Memory.normalizeThresholds({}).ram.critical, null,
    "critical ships unset: no ceiling, and no critical alert, for a ceiling nobody chose");

  const held = (psi, previous) => Memory.resolveRamBand(psiOnly(psi), PSI_T, previous, null, 0);
  assert.equal(held(14.9, 0).band, 0, "14.9 PSI is green");
  assert.equal(held(15, 0).band, 1, "15 PSI is the amber edge");
  assert.equal(held(27.9, 1).band, 1, "27.9 PSI is still amber, not red");
  assert.equal(held(28, 1).band, 2, "28 PSI is the wall the rig hit");
  assert.equal(held(20, 0).band, 1, "the heavy-but-playable 8-15 band stays green below 15");
  assert.equal(held(33, 2).band, 2, "no critical ceiling exists unless the user set one");
  assert.equal(held(33, 2).signal, "psi", "a pressure band names pressure");
});

test("ruling 2: a held pressure band releases by the PSI margin, not by dipping under the line", () => {
  // 28 PSI held the red band; 26 PSI is under the line but inside the 4 pp
  // hysteresis, so the band - and the badge color - carry on.
  assert.equal(Memory.resolveRamBand(psiOnly(26), PSI_T, 2, null, 0).band, 2);
  assert.equal(Memory.resolveRamBand(psiOnly(26), PSI_T, 2, null, 0).latched, true,
    "a held band reads as latched, never as healthy");
  assert.equal(Memory.resolveRamBand(psiOnly(24), PSI_T, 2, null, 0).band, 1,
    "24 clears 28 by the 4 pp margin and drops to where the reading actually sits");
  assert.equal(Memory.resolveRamBand(psiOnly(11), PSI_T, 1, null, 0).band, 0,
    "11 clears 15 by the 4 pp margin and the machine reads healthy again");
});

test("ruling 2: a pressure toast speaks the new numbers in the spec's own words", () => {
  assert.equal(Memory.amberBody({ type: "ram", signal: "psi", pct: 15.2 }),
    [
      "Caution: Amber Alert",
      "System RAM pressure has reached 16 PSI.",
      "Click to address with agent, otherwise ignore.",
    ].join("\n"),
    "the reading is rounded up, and 15.2 PSI is not told 15 PSI");
  assert.equal(Memory.redBody({ type: "ram", signal: "psi", pct: 28 }),
    [
      "WARNING: RED ALERT",
      "System RAM pressure has reached 28 PSI.",
      "Click to open an agent to actively monitor/guard against OOM, otherwise ignore.",
    ].join("\n"));
});

// ---------------------------------------------------------------------------
// 3. Swap: portable percent ceilings, per-rig gigabytes, and a rate
// ---------------------------------------------------------------------------

test("ruling 3: the swap ceilings are 70% and 86% used, one set of numbers with the dash", () => {
  const t = Memory.reserveThresholds(null);
  assert.equal(t.amber, 70, "the portable amber is 70 percent of the swap used");
  assert.equal(t.red, 86, "the portable red is 86 percent of the swap used");
  assert.equal(t.critical, null, "critical ships unset for swap like everywhere else");
  assert.equal(100 - Quattro.GAUGE_DEFAULTS.batt.amber, t.amber);
  assert.equal(100 - Quattro.GAUGE_DEFAULTS.batt.red, t.red);

  const held = (used, previous) => Memory.resolveRamBand(swapOnly(used), PSI_T, previous, null, 0);
  assert.equal(held(69.9, 0).band, 0, "69.9 percent used is under the amber line");
  assert.equal(held(70, 0).band, 1, "70 percent used is amber");
  assert.equal(held(85.9, 1).band, 1, "85.9 is under the red line, so it stays amber");
  assert.equal(held(86, 1).band, 2, "86 percent used is red");
  assert.equal(held(86, 1).signal, "swap", "a reserve band names the reserve, not pressure");
});

test("ruling 3: on the rig's 64 GB swap file those percents are the captain's 45G and 55G", () => {
  const view = Quattro.gaugeViewFor("batt", null, SWAP64);
  assert.equal(view.amber, 45, "the amber line on a 64 GB swap is 45 GB used");
  assert.equal(view.red, 55, "the red line is 55 GB used");
  assert.equal(view.unit, "GiB");
  assert.equal(view.suffix, " GiB");
  assert.equal(view.step, 5, "ruling 4: the settings move in 5 GB steps");
  assert.equal(view.min, 5, "the smallest step is the row's minimum");
  assert.equal(view.max, 60, "the track ends on the last steppable number under the total");
  assert.equal(Quattro.settingsPairText(view), "AMBER 45 GiB   RED 55 GiB",
    "the row says which line is which in the units the machine has");
});

test("ruling 3: a bigger machine gets the same percent, priced in its own gigabytes", () => {
  // The rig's real total (a 64 GB zram device plus a 64 GB swapfile) and a
  // small laptop with 8 GB: the ceiling is the same fraction, the number is not.
  const big = Quattro.gaugeViewFor("batt", null, { swapTotalKb: 128 * 1024 * 1024 });
  assert.equal(big.amber, 90, "70 percent of 128 GB used is 89.6 GB, snapped to the 5 GB step");
  assert.equal(big.red, 110);
  assert.equal(big.step, 5);
  assert.equal(big.max, 125, "the track ends on the last whole step under the total");
  const small = Quattro.gaugeViewFor("batt", null, { swapTotalKb: 8 * 1024 * 1024 });
  assert.equal(small.unit, "percent", "8 GB of swap cannot hold two ordered 5 GB handles, so the row shows the percent it stores");
  assert.equal(small.step, 1);
  assert.equal(small.amber, 30);
  assert.equal(small.red, 14);
  const tight = Quattro.gaugeViewFor("batt", null, { swapTotalKb: 12 * 1024 * 1024 });
  assert.equal(tight.max, 10, "12 GB of swap gives a 10 GB track: two whole steps");
  assert.ok(tight.red > tight.amber, "and the pair stays ordered on it, never snapped onto one number");
  assert.equal(tight.amber, 5);
  assert.equal(tight.red, 10);
});

test("ruling 4: a dragged gigabyte is stored back as the percent the settings keep", () => {
  // What the row drags is gigabytes used against this machine's own swap total;
  // what stays stored is the percent of the reserve free that memory.js's whole
  // band machinery reads, so a drag cannot quietly rewrite the ceiling in units
  // the next machine cannot carry.
  assert.equal(Quattro.gaugeViewToStored("batt", 45, SWAP64), 30, "45 GB used of 64 leaves 30 percent free");
  assert.equal(Quattro.gaugeViewToStored("batt", 55, SWAP64), 14, "55 GB used of 64 leaves 14 percent free");
  assert.equal(Quattro.gaugeViewToStored("batt", 32, SWAP64), 50);
  assert.equal(Quattro.gaugeViewToStored("psi", 22, SWAP64), 22, "a PSI row stores what it dragged");
  assert.equal(Quattro.gaugeViewToStored("hd", 85, SWAP64), 85);
  assert.equal(Quattro.gaugeViewToStored("vram", 1500, SWAP64), 1500);
  const ok = Memory.setCeiling(Memory.normalizeSettings({}), "ram", "amber", 20);
  assert.equal(ok.ok, true);
  assert.equal(ok.thresholds.ram.amber, 20, "the stored settings stay plain numbers");
  assert.equal(ok.thresholds.ram.red, 28, "a drag of one line does not move the other");
  const crossed = Memory.setCeiling(Memory.normalizeSettings({}), "ram", "amber", 42);
  assert.equal(crossed.ok, false,
    "an amber line at 42 PSI cannot sit above the 28 PSI red line, and the gigabyte row cannot smuggle one in");
  assert.equal(crossed.thresholds, null, "a rejected ceiling leaves the settings alone");
  same(Quattro.gaugeViewFor("batt", { amber: 30, red: 14 }, SWAP64), {
    unit: "GiB", suffix: " GiB", min: 5, max: 60, step: 5, amber: 45, red: 55,
  }, "the stored 70/86 percent-used pair (30/14 percent free) is the rig's 45 GB and 55 GB");
});

test("ruling 4: only a machine with swap gets a gigabyte row", () => {
  const none = Quattro.gaugeViewFor("batt", null, { swapTotalKb: 0 });
  assert.equal(none.unit, "percent", "no swap total means no gigabytes to price the reserve in");
  assert.equal(none.suffix, "");
  assert.equal(none.step, 1);
  assert.equal(none.amber, 30, "the row falls back to the percent the settings really store");
  assert.equal(none.max, 99);
  assert.equal(Quattro.sliderStep("batt", SWAP64), 5, "5 GiB steps on a machine that has swap");
  assert.equal(Quattro.sliderStep("batt", { swapTotalKb: 0 }), 1);
  assert.equal(Quattro.sliderStep("batt"), 1);
  assert.equal(Quattro.sliderStep("vram", SWAP64), 50, "the coolant row keeps its 50 MiB step");
  assert.equal(Quattro.sliderStep("psi", SWAP64), 1);
  assert.equal(Quattro.sliderStep("hd", SWAP64), 1);
});

test("ruling 4: the swap hover reads Now: with the percent free first and gigabytes behind it", () => {
  // The ruling's "(x/y GB)" lands on the format round 7.5 item 17 already pins:
  // the percent free up front, the absolute pair behind it, GiB for swap and
  // VRAM, GB for disk. The gauge and the values popup's SWAP row are the same
  // sentence about the same reserve, built by the same helper.
  const swap = { swapTotalKb: 64 * 1024 * 1024, swapUsedKb: 25 * 1024 * 1024 };
  const tip = Quattro.battTipWith(Quattro.reserveReading(swap), 30, 14, swap);
  assert.equal(tip.header, "SWAP RESERVE");
  same(tip.rows.map(r => r.label), ["Now:"]);
  assert.equal(tip.rows[0].text, Quattro.swapLine(swap) + ".",
    "the hover and the values popup row cannot disagree about the same swap");
  assert.match(tip.rows[0].text, /^\d+% Free \([\d.]+\/[\d.]+ GiB\)\.$/, "the ruling's sentence shape");
  assert.equal(Quattro.battTipWith({ present: false, pct: 0 }, 30, 14, { swapTotalKb: 0, swapUsedKb: 0 })
    .rows[0].text, "no swap is configured.", "a machine without swap never draws a healthy zero");
  const rows = Quattro.valueRows(12, Quattro.reserveReading(swap), swap, null, null, []);
  const byLabel = rows.reduce((acc, r) => { acc[r.label] = r.value; return acc; }, {});
  assert.equal(byLabel["SWAP"], "61% Free (39/64 GiB)", "the row the popup carries is unchanged");
});

test("ruling 3: a fast-climbing reserve is amber on its own, and never red", () => {
  const step = Memory.SWAP_CLIMB_MIN_KB;
  const gap = 2000;
  const climb = (jumps, gapMs) => {
    let used = 8 * 1024 * 1024;
    const at = 1000000;
    const samples = [{ atMs: at, usedKb: used }];
    jumps.forEach((mult, i) => {
      used += Math.round(step * mult);
      samples.push({ atMs: at + gapMs * (i + 1), usedKb: used });
    });
    return Memory.swapClimbBand(samples);
  };
  assert.equal(Memory.SWAP_CLIMB_STEPS, 2, "a rate claim needs two consecutive intervals, not one lucky jump");
  assert.equal(Memory.SWAP_CLIMB_MAX_GAP_MS, 90000, "a gap the plugin did not take is a gap, not a climb");
  assert.equal(Memory.swapClimbBand([]), 0, "no history says nothing");
  assert.equal(Memory.swapClimbBand([{ atMs: 1, usedKb: 1 }, { atMs: 2, usedKb: 9 * 1024 * 1024 }]), 0,
    "one jump is not a rate");
  assert.equal(climb([1, 1], gap), 1, "two steps of at least 2 GiB inside 2 seconds is a climb");
  assert.equal(climb([1, 0.5], gap), 0, "the second interval below the floor breaks it");
  assert.equal(climb([1, 1], 120000), 0, "two GiB over two minutes is not fast on this machine");
  assert.equal(Memory.swapClimbBand([{ atMs: 0, usedKb: 0 }, null, { atMs: 5, usedKb: 0 }]), 0,
    "a sample the widget never took cannot be a data point");

  // The climb joins the reserve band rather than replacing it, and it can only
  // ever be amber.
  const r = Memory.resolveRamBand(swapOnly(20), PSI_T, 0, null, 1);
  assert.equal(r.band, 1, "a climbing reserve at 20 percent used is amber with no line crossed");
  assert.equal(r.signal, "swap", "and it names the reserve as the signal");
  assert.equal(r.rate, true, "the toast has to say the band is the rate's doing");
  const already = Memory.resolveRamBand(swapOnly(88), PSI_T, 0, null, 1);
  assert.equal(already.band, 2, "a reserve past its red line reads red whether or not it is still moving");
  assert.equal(already.rate, false, "a crossed line is not a rate");
  const pressureWins = Memory.resolveRamBand({ pct: 62, psiSomeAvg10: 31, swapPct: 20 }, PSI_T, 0, null, 1);
  assert.equal(pressureWins.band, 2, "pressure at the wall outranks an amber climb");
  assert.equal(pressureWins.signal, "psi", "and the toast speaks pressure");
  assert.equal(pressureWins.rate, false, "the red band is not the climb's doing");
  assert.equal(Memory.resolveRamBand(swapOnly(20), PSI_T, 0, null, 5).band, 1,
    "a climb is amber or nothing: no number of history turns it red");
});

test("ruling 3: the rate toast says climbing fast, and never quotes a low percent as a crossed line", () => {
  assert.equal(Memory.amberBody({ type: "ram", signal: "swap", rate: true, pct: 20 }),
    [
      "Caution: Amber Alert",
      "Swap reserve is climbing fast, 20 percent used right now.",
      "Click to address with agent, otherwise ignore.",
    ].join("\n"));
  assert.equal(Memory.amberBody({ type: "ram", signal: "swap", pct: 74 }),
    [
      "Caution: Amber Alert",
      "Swap reserve is 74 percent used.",
      "Click to address with agent, otherwise ignore.",
    ].join("\n"), "a crossed reserve line still reads as the line it crossed");
  const prompt = Memory.agentPrompt(
    { id: Memory.memId("ram"), type: "ram", band: 1, pct: 20, signal: "swap", rate: true },
    null, null, null);
  assert.match(prompt, /Reading: 20 percent used, climbing fast\./,
    "the prompt the click carries agrees with the toast the captain read");
  const crossed = Memory.agentPrompt(
    { id: Memory.memId("ram"), type: "ram", band: 1, pct: 74, signal: "swap" }, null, null, null);
  assert.match(crossed, /Reading: 74 percent used\./);
  assert.equal(crossed.includes("climbing fast"), false, "a crossed line is not described as a rate");
  const row = JSON.parse(Memory.logLine(Memory.logRecord({
    at: "2026-10-28T04:00:00Z", hd: [], ram: null, vram: null, oomd: null,
    thresholds: null, guard: null, arm: null,
    alerts: [
      { at: "2026-10-28T04:00:00Z", type: "ram", band: 1, pct: 20, signal: "swap", rate: true },
      { at: "2026-10-28T04:00:02Z", type: "hd", band: 1, pct: 82 },
    ],
  })));
  assert.equal(row.alerts[0].rate, true,
    "the log row carries the rate that alerted, so round 8's provisional calibration is re-anchorable from the log alone");
  assert.equal(row.alerts[0].signal, "swap", "and the signal the band came from");
  assert.equal("signal" in row.alerts[1], false, "a drive row carries neither: absent, not an empty word");
  assert.equal("rate" in row.alerts[1], false, "absent for the resources that have no signals");
  assert.match(
    Memory.alertsYouDidNotSeeText([{ at: "2026-10-28T04:00:00Z", type: "ram", band: 1, pct: 20, signal: "swap", rate: true, delivered: "silenced-dnd" }]),
    /20% used, climbing fast/,
    "the detail window's missed-alert row names the rate too: 20% used alone is not what that amber meant");
});

test("ruling 3: a held climb toasts once, like every other band", () => {
  assert.equal(Memory.shouldFireAlert({ band: 1, previousBand: 0 }), true, "the climb's crossing fires");
  assert.equal(Memory.shouldFireAlert({ band: 1, previousBand: 1 }), false,
    "a reserve that keeps climbing at 2-second polls does not toast every 2 seconds");
  assert.equal(Memory.shouldFireAlert({ band: 0, previousBand: 1 }), false, "and coming back down is not an alert");
});

// ---------------------------------------------------------------------------
// 1. The watch lane: 2 seconds while amber or worse, or while a window is open
// ---------------------------------------------------------------------------

test("ruling 1: the watch lane is 2 seconds, and cruising keeps the lazy nominal", () => {
  assert.equal(Memory.POLL_WATCH_MS, 2000);
  const types = ["hd", "vram", "ram"];
  const closed = { windowOpen: false, watchBand: 0 };
  for (const type of types) {
    assert.equal(Memory.pollIntervalMs(type, 0, closed), Memory.POLL_NOMINAL_MS[type],
      `${type}: green, nothing open, passive use - the lax nominal stands`);
    for (const band of [1, 2, 3]) {
      assert.equal(Memory.pollIntervalMs(type, band, { windowOpen: false, watchBand: band }), 2000,
        `${type} band ${band}: amber or worse anywhere is a watch, on every resource`);
      assert.equal(Memory.pollIntervalMs(type, 0, { windowOpen: false, watchBand: band }), 2000,
        `${type} at green while another resource is in trouble is watched too`);
      assert.equal(Memory.pollIntervalMs(type, band, { windowOpen: true, watchBand: 0 }), 2000,
        `${type} with a window open is watched even with everything green`);
      assert.ok(Memory.pollIntervalMs(type, band, { windowOpen: true, watchBand: band }) <=
        Memory.pollIntervalMs(type, band, closed), `${type} band ${band}: the watch only tightens`);
    }
    assert.equal(Memory.pollIntervalMs(type, 0, { windowOpen: true, watchBand: 0 }), 2000,
      `${type}: an open window polls at 2s even green`);
    assert.equal(Memory.pollIntervalMs(type, 3, { absent: true, windowOpen: true, watchBand: 3 }),
      Memory.POLL_NOMINAL_MS[type], `${type} absent: a vanished resource never asks for more`);
  }
  assert.equal(Memory.watchActive({ windowOpen: true }), true);
  assert.equal(Memory.watchActive({ watchBand: 1 }), true);
  assert.equal(Memory.watchActive({ watchBand: 0, windowOpen: false }), false);
  assert.equal(Memory.watchActive(), false, "no context means cruising");
});

test("ruling 1: the watch lane caps the old ladder, it does not replace it", () => {
  const off = { windowOpen: false, watchBand: 0 };
  assert.equal(Memory.pollIntervalMs("ram", 2, off), 10000, "the red ladder is still memory.js's answer");
  assert.equal(Memory.pollIntervalMs("hd", 2, off), 20000);
  assert.equal(Memory.pollIntervalMs("ram", 2, {
    ...off, psi: { some_avg10: 42 }, psiFloor: Memory.PSI_STALL_FLOOR,
  }), 5000, "a stalling PSI reading still outranks the red interval on the ladder");
  assert.equal(Memory.pollIntervalMs("ram", 2, {
    psi: { some_avg10: 42 }, psiFloor: Memory.PSI_STALL_FLOOR, watchBand: 2,
  }), 2000, "and the watch lane then caps it at 2 seconds");
  assert.equal(Memory.POLL_ESCALATED_MS.ram, 10000, "the ladder constants survive the ruling");
  assert.equal(Memory.POLL_PSI_MS, 5000);
  assert.equal(Memory.pollIntervalMs("ram", 1, off), 30000, "amber with no watch is not a hammer");
});

test("ruling 1: the log keeps its resting window through 2-second sampling", () => {
  assert.equal(Memory.LOG_ROW_MIN_MS, Memory.POLL_NOMINAL_MS.ram,
    "a row is due on the round-7 resting cadence, not on the new sample cadence");

  const at = seconds => new Date(Date.UTC(2026, 10, 12, 12, 0, seconds)).toISOString();
  const row = (seconds, over) => Memory.logRecord(Object.assign({
    at: at(seconds),
    hd: [{ key: "/", target: "/", device: "/dev/nvme0n1p3", fstype: "btrfs", usedKb: 24 * 1024 * 1024,
      availKb: 76 * 1024 * 1024, sizeKb: 100 * 1024 * 1024, pct: 24, band: 0 }],
    ram: { type: "ram", pct: 62, band: 0, psiSomeAvg10: 9.1, psiFullAvg10: 0.2,
      swapTotalKb: 64 * 1024 * 1024, swapUsedKb: 11 * 1024 * 1024, swapPct: 17.2 },
    vram: { pct: 78, band: 1, vramTotalMib: 16303, vramUsedMib: 12744 },
  }, over || {}));

  // A watched stretch: nine samples two seconds apart, the counters wobbling by
  // hundredths and kilobytes. One row, not nine - nine rows every 18 seconds is
  // 5.7 hours of history where the log used to hold days.
  let written = 0;
  let previous = null;
  for (let i = 0; i < 9; i++) {
    const jitter = row(i * 2, {
      ram: { type: "ram", pct: 62 + (i % 2) * 0.3, band: 0, psiSomeAvg10: 9.02 + i * 0.04,
        psiFullAvg10: 0.18 + i * 0.03, swapTotalKb: 64 * 1024 * 1024,
        swapUsedKb: 11 * 1024 * 1024 + i * 4096, swapPct: 17.18 + i * 0.02 },
      vram: { pct: 78, band: 1, vramTotalMib: 16303, vramUsedMib: 12744 + i * 12 },
    });
    if (Memory.logDue(jitter, previous)) { written += 1; previous = jitter; }
  }
  assert.equal(written, 1, "the first row of a watched stretch writes, the eight after it are the same fact");

  assert.equal(Memory.logDue(row(46), previous), true,
    "the resting cadence comes round, so the window keeps a row every 30 seconds");
  assert.equal(Memory.logDue(row(0), null), true, "the first row of a widget generation always writes");
  assert.equal(Memory.logDue(null, null), false, "a sample that produced nothing logs nothing");
});

test("ruling 1: a row that has something to say is never held back by the interval", () => {
  const at = seconds => new Date(Date.UTC(2026, 10, 12, 12, 0, seconds)).toISOString();
  const row = (seconds, over) => Memory.logRecord(Object.assign({
    at: at(seconds),
    hd: [{ key: "/", target: "/", device: "/dev/nvme0n1p3", fstype: "btrfs", usedKb: 24 * 1024 * 1024,
      availKb: 76 * 1024 * 1024, sizeKb: 100 * 1024 * 1024, pct: 24, band: 0 }],
    ram: { type: "ram", pct: 62, band: 0, psiSomeAvg10: 9.1, psiFullAvg10: 0.2,
      swapTotalKb: 64 * 1024 * 1024, swapUsedKb: 11 * 1024 * 1024, swapPct: 17.2 },
    vram: { pct: 78, band: 1, vramTotalMib: 16303, vramUsedMib: 12744 },
  }, over || {}));
  const first = row(0);

  const climbedSwap = { type: "ram", pct: 62, band: 0, psiSomeAvg10: 9.1, psiFullAvg10: 0.2,
    swapTotalKb: 64 * 1024 * 1024, swapUsedKb: 13 * 1024 * 1024, swapPct: 20.3 };
  assert.equal(Memory.logDue(row(2, { ram: climbedSwap }), first), true,
    "a 2 GiB reserve jump two seconds after the last row is exactly the climb the calibration needs");
  assert.equal(Memory.logDue(row(2, { ram: Object.assign({}, climbedSwap, { band: 1 }) }), first), true,
    "a band change writes at once");
  assert.equal(Memory.logDue(row(2, { ram: Object.assign({}, climbedSwap, {
    swapUsedKb: 11 * 1024 * 1024, swapPct: 19.3 }) }), first), true,
    "a whole percent of reserve used is a fact, not jitter");
  assert.equal(Memory.logDue(row(2, { ram: Object.assign({}, climbedSwap, {
    swapUsedKb: 11 * 1024 * 1024, swapPct: 17.2, psiSomeAvg10: 10.2 }) }), first), true,
    "a PSI move of a full point writes, on a face whose amber line is 15");
  assert.equal(Memory.logDue(row(2, { ram: Object.assign({}, climbedSwap, {
    swapUsedKb: 11 * 1024 * 1024, swapPct: 17.2, psiSomeAvg10: 9.1, band: 0, latched: true }) }), first), true,
    "a latched band writes, because the log has to say the band was held");
  assert.equal(Memory.logDue(row(2, { vram: { pct: 79, band: 1, vramTotalMib: 16303, vramUsedMib: 12905 } }), first), true,
    "a VRAM whole percent writes");
  assert.equal(Memory.logDue(row(2, {
    hd: [{ key: "/", target: "/", device: "/dev/nvme0n1p3", fstype: "btrfs", usedKb: 24 * 1024 * 1024,
      availKb: 76 * 1024 * 1024, sizeKb: 100 * 1024 * 1024, pct: 24, band: 0 },
      { key: "/mnt/backup", target: "/mnt/backup", device: "/dev/sdb1", fstype: "ext4", usedKb: 900 * 1024 * 1024,
        availKb: 100 * 1024 * 1024, sizeKb: 1000 * 1024 * 1024, pct: 90, band: 2 }],
  }), first), true, "a drive that appeared writes");
  assert.equal(Memory.logDue(row(2, { thresholds: { ram: { amber: 20, red: 28 } } }), first), true,
    "a ceiling the user dragged writes, so the log says which ceilings were live");
  assert.equal(Memory.logDue(row(2, { guard: true }), first), true, "the guard state writes");
  assert.equal(Memory.logDue(row(2, { alerts: [{ id: "mem-49ff1c63-54fdb774", key: "ram", type: "ram",
    band: 1, pct: 21.9, signal: "swap", rate: true, delivered: "shown" }] }), first), true,
    "an alert row is never held back - it carries the signal and rate the climb meant");
  assert.equal(Memory.logDue(row(2, { ram: Object.assign({}, climbedSwap, {
    swapUsedKb: 11 * 1024 * 1024 + 8192, swapPct: 17.26, psiSomeAvg10: 9.14, psiFullAvg10: 0.22 }) }), first), false,
    "kilobyte and hundredth wobble alone is not a fact about the machine");
});

// ---------------------------------------------------------------------------
// 5. The pressure dial: 0 to 35, true tick numbers, no hidden rescale
// ---------------------------------------------------------------------------

test("ruling 5: the pressure face is 0-35 and every number on it is a PSI number", () => {
  assert.equal(Quattro.PSI_SCALE_MAX, 35);
  assert.equal(Quattro.dialScaleFor("psi"), 35);
  same(Quattro.psiLabels.map(l => l.t), ["0", "5", "10", "15", "20", "25", "30", "35"]);
  const ticks = Quattro.psiTicks();
  assert.equal(ticks.length, 36, "one tick per PSI, 0 through 35");
  same(ticks.filter(t => t.major).map(t => Math.round(t.f * 35)), [0, 5, 10, 15, 20, 25, 30, 35],
    "the labelled ticks are the real numbers, not a 0-100 face wearing new labels");
  assert.equal(Quattro.psiNeedleFrac(28), 28 / 35, "28 PSI is 28/35 of the sweep: nothing rescales it");
  assert.ok(Quattro.psiNeedleFrac(28) > 0.75, "the red line sits near the top of the dial");
  assert.equal(Quattro.psiNeedleFrac(15), 15 / 35, "the amber line is 3/7 of the sweep");
  assert.equal(Quattro.psiNeedleFrac(35), 1, "the face tops out at 35");
  const arcs = Quattro.psiZoneArcsFor(15, 28);
  assert.equal(arcs[1].to, 1, "the red zone runs to the top of the face");
  assert.ok(arcs[1].from > 0.75, "and starts near it");
});

test("ruling 5: the other dials keep their own scales", () => {
  assert.equal(Quattro.dialScaleFor("hd"), 100, "ROOT DRIVE is a percent dial");
  assert.equal(Quattro.dialScaleFor("batt"), 100, "the reserve is a percent of the reserve");
  assert.equal(Quattro.dialScaleFor("vram"), 100, "the coolant dial maps its own MiB span to the sweep");
  assert.equal(Quattro.dialTicks().length, 41, "the drive dial's 41-tick ring is untouched");
  same(Quattro.fuelLabels.map(l => l.t), ["E", "¼", "½", "¾", "F"],
    "the fuel labels are untouched");

  // The rows that set those dials speak the same units the dials do, and a
  // stored line the dial cannot draw stays reachable instead of being lowered
  // to the top of the face by a drag that could not reach it.
  same(Quattro.gaugeViewFor("psi", { amber: 15, red: 28 }),
    { unit: "PSI", suffix: " PSI", min: 1, max: 35, step: 1, amber: 15, red: 28 },
    "the pressure row drags its own 0-35 face and says PSI on it");
  const deep = Quattro.gaugeViewFor("psi", { amber: 60, red: 90 });
  assert.ok(deep.max >= 90, "a pressure line above the face stays reachable from the row");
  assert.equal(deep.amber, 60, "the row shows the number it stores, not the number the dial can draw");
  same(Quattro.gaugeViewFor("hd", { amber: 80, red: 90 }),
    { unit: "percent", suffix: "", min: 1, max: 99, step: 1, amber: 80, red: 90 },
    "the drive row is untouched by the pressure face");
  same(Quattro.gaugeViewFor("vram", { amber: 1500, red: 500 }),
    { unit: "MiB", suffix: " MiB", min: Quattro.GAUGE_PCT_MIN, max: Quattro.GAUGE_MIB_MAX, step: 50,
      amber: 1500, red: 500 },
    "the coolant row keeps its MiB sliders and its 50 MiB step, and now says MiB on them");
});

// ---------------------------------------------------------------------------
// The QML stays a renderer of all of this
// ---------------------------------------------------------------------------

test("the widget and the dash ask for every round-8 decision", () => {
  const widget = repoFile("memory-monitor/MemoryMonitor.qml");
  const dash = repoFile("memory-monitor/QuattroDash.qml");
  assert.match(widget, /Memory\.POLL_WATCH_MS|watchBand:\s*root\.watchBand\(\)/,
    "the watch lane is memory.js's decision, asked for");
  assert.match(widget, /Memory\.swapClimbBand\(/, "the climb is memory.js's decision");
  assert.match(widget, /Memory\.logDue\(/, "the log's resting window is memory.js's decision");
  assert.match(widget, /root\.lastLoggedRecord/, "and the widget carries the row it last wrote to compare against");
  assert.match(widget, /recordSwapSample\(/, "the widget keeps the history the decision reads");
  assert.match(widget, /Memory\.SWAP_CLIMB_STEPS/, "and trims it to the length memory.js names");
  assert.match(widget, /gaugePairFor\("batt"\), climb\)/, "the display band rebinding folds the climb through memory.js");
  assert.match(widget, /gaugePairFor\("batt"\), root\.swapClimbBand\(\)/,
    "the held RAM band takes the climb from memory.js, not from a QML judgement");
  assert.match(dash, /Quattro\.psiTicks\(\)/, "the PSI dial asks quattro.js for its tick row");
  assert.match(dash, /Quattro\.gaugeViewFor\(/, "the settings row asks for its units and step");
  assert.match(dash, /Quattro\.gaugeViewToStored\(/, "and converts a drag back through quattro.js");
  assert.match(dash, /Quattro\.settingsPairText\(/, "and renders the pair string rather than writing one");

  // Ruling 4's second half: the bar visual is untouched. The emblem the bar draws
  // still comes from the same badge decision with the same symbol, and no
  // round-8 number or constant is written into a QML file - a kernel constant is
  // allowed only as the kernel's own, Memory.* or Quattro.*, never copied.
  assert.match(widget, /RingKit\.badgeParams\(/, "the bar badge is still RingKit's decision");
  assert.match(widget, /QuattroSymbol\s*\{/, "the bar emblem is still the same symbol artwork");
  const kernelNames = ["PSI_SCALE_MAX", "PSI_TICK_EVERY", "PSI_LABEL_EVERY", "SWAP_STEP_GIB",
    "POLL_WATCH_MS", "SWAP_CLIMB_MIN_KB", "SWAP_CLIMB_MAX_GAP_MS", "SWAP_CLIMB_STEPS",
    "DEFAULT_AMBER_RAM", "DEFAULT_RED_RAM", "GAUGE_DEFAULTS", "PSI_AMBER_AT", "PSI_RED_AT"];
  const literals = [/2 \* 1024 \* 1024/, /\b90000\b/, /interval:\s*2000\b/, /\bamber:\s*15\b/,
    /\bred:\s*28\b/, /\b:\s*35\b/, /\b5 \* 1024 \* 1024\b/];
  for (const [name, src] of [["MemoryMonitor.qml", widget], ["QuattroDash.qml", dash],
    ["MemoryPanel.qml", repoFile("memory-monitor/MemoryPanel.qml")]]) {
    for (const kernel of kernelNames) {
      let bare = src;
      for (const owner of ["Memory.", "Quattro.", "RingKit."])
        bare = bare.split(owner + kernel).join("");
      assert.equal(bare.includes(kernel), false,
        `${name} may ask ${kernel} through its own module, never carry it`);
    }
    for (const re of literals)
      assert.equal(re.test(src), false, `${name} must not write the round-8 numbers itself (${re})`);
  }
});

// ---------------------------------------------------------------------------
// 6. The toast emblem the daemon draws (inbox 001, 2026-11-12)
//
// The toast logo is not drawn by the plugin: memory.js hands the notification
// daemon a file (TOAST_ICONS through notifyArgs' -i), and the shell's
// notifications plugin paints it as a PICTURE - Toast.qml sets `photo:
// best === sent` for any file the sender supplied, and a picture is crop-FILLED
// (PreserveAspectCrop) into its square Style.space(40) slot, with
// sourceSize 40x40 on the Image. A wider-than-tall emblem is therefore scaled to
// COVER the square and the overflow is cut from the middle outwards: the
// round-7 assets were 128x86 with the artwork's own ink running to both edges,
// so the daemon cut 19px of the 59px it rendered - the emblem's two side
// brackets gone, which is what the rig screenshot shows. The contract that makes
// the crop cut nothing: a SQUARE canvas, with the emblem inset inside it. Then
// cover and fit are the same transform and every toast width shows the whole
// emblem.
// ---------------------------------------------------------------------------

const ICON_FILES = { plain: "mil-plain.png", amber: "mil-amber.png", red: "mil-red.png" };
// How far the artwork's ink must sit from the canvas edge to survive a cover
// crop into a slot that is not exactly square.
const INK_MARGIN_FRACTION = 0.04;

function dominantInk(image) {
  const seen = new Map();
  for (let i = 0; i < image.width * image.height; i++) {
    if (image.pixels[i * 4 + 3] <= 200) continue;
    const key = image.pixels[i * 4].toString(16).padStart(2, "0")
      + image.pixels[i * 4 + 1].toString(16).padStart(2, "0")
      + image.pixels[i * 4 + 2].toString(16).padStart(2, "0");
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  let best = null;
  let bestN = 0;
  for (const [hex, n] of seen) if (n > bestN) { best = hex; bestN = n; }
  return best;
}

test("ruling 6: the toast logo memory.js names is the file the plugin ships", () => {
  for (const [lane, name] of Object.entries(ICON_FILES)) {
    assert.equal(Memory.TOAST_ICONS[lane], name, `the ${lane} lane hands the daemon ${name}`);
    assert.ok(existsSync(path.join(HERE, "..", "icons", name)), `${name} exists: an -i that points at nothing draws no emblem at all`);
  }
});

test("ruling 6: every toast emblem is drawn on a canvas the daemon cannot crop", () => {
  const mil = Quattro.SYMBOLS.mil;
  const artAspect = mil.viewBox[2] / mil.viewBox[3];
  for (const name of Object.values(ICON_FILES)) {
    const image = decodePng(readFileSync(path.join(HERE, "..", "icons", name)));
    const margin = INK_MARGIN_FRACTION * Math.min(image.width, image.height);
    const box = coloredBounds(image);
    assert.ok(box !== null, `${name} drew nothing`);
    assert.equal(image.width, image.height,
      `${name} is square: the shell's toast paints a sender's file as a picture and crop-FILLS it into a square slot, so an asset wider than tall loses its left and right to the cut (the 2026-11-12 rig screenshot)`);
    assert.ok(box.minX >= margin,
      `${name}'s emblem ink starts ${box.minX}px from the left edge; a cover crop cuts from the middle out, so the ink needs room on both sides (${Math.round(margin)}px wanted)`);
    assert.ok(image.width - 1 - box.maxX >= margin,
      `${name}'s emblem ink reaches ${image.width - 1 - box.maxX}px from the right edge, which is the side the rig saw cut off`);
    assert.ok(box.minY >= margin && image.height - 1 - box.maxY >= margin,
      `${name} keeps the same room above and below, so no slot height cuts the emblem`);
    // The emblem keeps its own proportions: the frame is square, the artwork is
    // not, and stretching it would be its own kind of wrong.
    const inkAspect = (box.maxX - box.minX + 1) / (box.maxY - box.minY + 1);
    assert.ok(Math.abs(inkAspect / artAspect - 1) < 0.05,
      `${name} draws the mil artwork at its own ${artAspect.toFixed(3)} aspect, not stretched to the canvas (${inkAspect.toFixed(3)})`);
  }
});

test("ruling 6: each toast emblem carries the tint its lane claims", () => {
  const want = { plain: "ffffff", amber: "e3b341", red: "ff3b30" };
  assert.equal("#" + want.amber, Quattro.PAL.amber, "the amber toast is the palette's own amber");
  assert.equal("#" + want.red, Quattro.PAL.redHot, "the red toast is the palette's own red");
  for (const [lane, name] of Object.entries(ICON_FILES)) {
    const got = dominantInk(decodePng(readFileSync(path.join(HERE, "..", "icons", name))));
    assert.equal(got, want[lane], `${name} is tinted ${want[lane]}, the colour the ${lane} band means`);
  }
});
