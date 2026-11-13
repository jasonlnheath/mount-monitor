// Round 10: the stress-calibration button. These tests are the contract for the
// calibration decisions before they exist: the plan builder (graded, bounded,
// physically-honest ceilings), the grade clock, the abort conditions, the quiet
// window (which families a deliberate stress may hold, and which it must never),
// the band proposal math, the copy law, and the helper's own law (ships with the
// plugin, allocates anonymous memory, writes nothing anywhere).
//
// Written RED before the implementation, per the process law for a feature that
// stresses the captain's own machine.

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Memory, Quattro, repoFile, same } from "./load.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const HELPER = path.join(ROOT, "memory-monitor", "calibrate.py");

// The rig fixtures. 16 GiB physical, 8 GiB available, 4 GiB swap: big enough
// that no clamp binds on the ladder, small enough to check the arithmetic by
// hand. KiB everywhere, the unit /proc/meminfo speaks.
const MIB = 1024 * 1024;
const RIG = {
  MemTotal: 16 * MIB,
  MemAvailable: 8 * MIB,
  SwapTotal: 4 * MIB,
  SwapFree: 4 * MIB - 2 * 1024 * 1024,
};

// ---------------------------------------------------------------------------
// The plan builder. Grades are DELTAS between clamped cumulative targets, so
// the ladder retains and tops out at 0.8x available - never the 2.0x a naive
// per-grade fraction plans. The ceiling is clamped below physical RAM, because
// a cgroup limit at or above physical is not a wall: it is an invitation to the
// global oom killer, which can shoot the browser instead of the helper.
// ---------------------------------------------------------------------------

test("calibPlan builds four bounded grades as deltas of cumulative targets", () => {
  const plan = Quattro.calibPlan(RIG);
  assert.equal(plan.ok, true, "the rig fixture clears the headroom gate");
  assert.equal(plan.grades.length, 4);
  for (const g of plan.grades) assert.equal(g.secs, Quattro.CALIB_GRADE_SECS);

  // Cumulative targets: clamp(round(frac * availMiB), floor, cap), fracs .2/.4/.6/.8.
  const availMib = 8192;
  const clamps = (v) => Math.max(Quattro.CALIB_GRADE_FLOOR_MIB, Math.min(Quattro.CALIB_GRADE_CAP_MIB, Math.round(v)));
  const targets = [0.2, 0.4, 0.6, 0.8].map((f) => clamps(f * availMib));
  let prev = 0;
  plan.grades.forEach((g, i) => {
    assert.equal(g.mib, targets[i] - prev, `grade ${i} mib is the delta between cumulative targets`);
    prev = targets[i];
  });
  assert.equal(plan.totalMib, targets[3], "the plan tops out at 0.8x available, not at the fracs' sum");
  assert.equal(plan.capSec, Quattro.CALIB_CAP_SEC);
  assert.equal(plan.grades.reduce((n, g) => n + g.secs, 0), 160, "the ladder itself stays inside the cap");
});

test("calibPlan refuses a loaded rig instead of flooring over it", () => {
  const tight = { MemTotal: 4 * MIB, MemAvailable: 500 * 1024, SwapTotal: 0, SwapFree: 0 };
  const plan = Quattro.calibPlan(tight);
  assert.equal(plan.ok, false);
  assert.equal(plan.why, "headroom");
});

test("calibPlan clamps tiny and huge machines into honest ladders", () => {
  // Tiny: 1.5 GiB available clears the headroom gate, the floor never binds,
  // and every delta stays positive (the ladder still climbs).
  const small = Quattro.calibPlan({ MemTotal: 4 * MIB, MemAvailable: 1500 * 1024, SwapTotal: 0, SwapFree: 0 });
  assert.equal(small.ok, true);
  let prev = 0;
  for (const g of small.grades) {
    assert.ok(g.mib > 0, "deltas stay positive on a small rig");
    prev += g.mib;
  }
  assert.equal(small.totalMib, prev);

  // Huge: the cap binds, so the ladder never retains more than 8 GiB whatever
  // the machine has, and the ceiling still sits under physical RAM.
  const huge = Quattro.calibPlan({ MemTotal: 128 * MIB, MemAvailable: 100 * MIB, SwapTotal: 16 * MIB, SwapFree: 16 * MIB });
  assert.equal(huge.ok, true);
  assert.equal(huge.totalMib <= Quattro.CALIB_GRADE_CAP_MIB, true, "the cumulative top never exceeds the per-target cap");

  // The ceiling is the kernel wall: above the ladder, below physical RAM.
  for (const { meminfo, plan } of [
    { meminfo: RIG, plan: Quattro.calibPlan(RIG) },
    { meminfo: { MemTotal: 4 * MIB, MemAvailable: 1500 * 1024, SwapTotal: 0, SwapFree: 0 }, plan: small },
    { meminfo: { MemTotal: 128 * MIB, MemAvailable: 100 * MIB, SwapTotal: 16 * MIB, SwapFree: 16 * MIB }, plan: huge },
  ]) {
    const physicalMib = Math.floor((meminfo.MemTotal - Quattro.CALIB_CEILING_RESERVE_KB) / 1024);
    assert.ok(plan.ceilingMib > plan.totalMib, "the ceiling sits above the ladder it bounds");
    assert.ok(plan.ceilingMib <= physicalMib, "the ceiling never reaches physical RAM minus the reserve");
    assert.equal(plan.ceilingMib, Math.min(plan.totalMib + Quattro.CALIB_CEILING_MARGIN_MIB, physicalMib));
  }
});

test("calibPlan bounds the swap exposure at half the reserve", () => {
  const plan = Quattro.calibPlan(RIG);
  assert.equal(plan.swapMaxKiB, Math.floor(RIG.SwapTotal / 2));
  const noSwap = Quattro.calibPlan({ MemTotal: 16 * MIB, MemAvailable: 8 * MIB, SwapTotal: 0, SwapFree: 0 });
  assert.equal(noSwap.swapMaxKiB, 0, "no reserve means nothing to bound");
});

test("the plan survives a JSON round trip (it crosses a process boundary as argv)", () => {
  const plan = Quattro.calibPlan(RIG);
  const back = JSON.parse(JSON.stringify(plan));
  same(back, plan);
});

// ---------------------------------------------------------------------------
// The grade clock. Display fallback only - the widget bins real samples by the
// helper's own grade events - but the fallback must still be correct.
// ---------------------------------------------------------------------------

test("gradeAt walks the planned ladder by seconds", () => {
  const plan = Quattro.calibPlan(RIG);
  assert.equal(Quattro.gradeAt(plan, 0), 0);
  assert.equal(Quattro.gradeAt(plan, 39), 0);
  assert.equal(Quattro.gradeAt(plan, 40), 1);
  assert.equal(Quattro.gradeAt(plan, 80), 2);
  assert.equal(Quattro.gradeAt(plan, 120), 3);
  assert.equal(Quattro.gradeAt(plan, 159), 3);
  assert.equal(Quattro.gradeAt(plan, 160), null, "past the ladder there is no grade");
});

// ---------------------------------------------------------------------------
// The abort conditions. Sustained walls abort; single spikes do not; dirty
// pages are recorded curve data and never a wall sign. Samples are the
// widget's own 2 s readings, oldest first: { atMs, elapsedSec, psiSome10,
// swapUsedKb, dirtyKb }.
// ---------------------------------------------------------------------------

function sample(elapsedSec, psiSome10, swapUsedKb, dirtyKb) {
  return { atMs: elapsedSec * 1000, elapsedSec, psiSome10, swapUsedKb, dirtyKb };
}

test("a sustained PSI wall aborts, a single spike does not", () => {
  const plan = Quattro.calibPlan(RIG);
  const calm = [
    sample(4, 2, 100 * 1024, 50 * 1024),
    sample(6, 3, 100 * 1024, 50 * 1024),
    sample(8, 2, 100 * 1024, 50 * 1024),
  ];
  same(Quattro.calibAbortFor(calm, plan), { abort: false, why: null, grade: null });

  const spike = [
    sample(4, 10, 100 * 1024, 50 * 1024),
    sample(6, 44, 100 * 1024, 50 * 1024),
    sample(8, 12, 100 * 1024, 50 * 1024),
  ];
  same(Quattro.calibAbortFor(spike, plan), { abort: false, why: null, grade: null }, "one sample over the wall is a spike, not a wall");

  const wall = [
    sample(4, 10, 100 * 1024, 50 * 1024),
    sample(6, 44, 100 * 1024, 50 * 1024),
    sample(8, 46, 100 * 1024, 50 * 1024),
  ];
  const abort = Quattro.calibAbortFor(wall, plan);
  assert.equal(abort.abort, true);
  assert.equal(abort.why, "psi-wall");
  assert.equal(abort.grade, 0, "the abort names the grade it happened in");
});

test("a swap storm aborts at the wall rate, not below it", () => {
  const plan = Quattro.calibPlan(RIG);
  const wall = Quattro.CALIB_SWAP_WALL_KB_PER_MIN;

  // Exactly at the wall rate over a 2 s gap: rate = jump / (2/60) min.
  const jumpAtWall = Math.round(wall * (2 / 60));
  const at = [
    sample(4, 10, 1000 * 1024, 0),
    sample(6, 10, 1000 * 1024 + jumpAtWall, 0),
  ];
  assert.equal(Quattro.calibAbortFor(at, plan).why, "swap-storm");

  // A whisker below is heavy but not a storm: measured, not aborted.
  const below = [
    sample(4, 10, 1000 * 1024, 0),
    sample(6, 10, 1000 * 1024 + jumpAtWall - 1, 0),
  ];
  same(Quattro.calibAbortFor(below, plan), { abort: false, why: null, grade: null });

  // A wide sample gap is a gap, not a rate: the widget did not take that pair.
  const gapped = [
    sample(4, 10, 1000 * 1024, 0),
    sample(30, 10, 1000 * 1024 + 4 * MIB, 0),
  ];
  same(Quattro.calibAbortFor(gapped, plan), { abort: false, why: null, grade: null });
});

test("dirty pages never abort a run", () => {
  const plan = Quattro.calibPlan(RIG);
  const dirty = [
    sample(4, 2, 100 * 1024, 200 * MIB),
    sample(6, 3, 100 * 1024, 900 * MIB),
    sample(8, 4, 100 * 1024, 1500 * MIB),
  ];
  same(Quattro.calibAbortFor(dirty, plan), { abort: false, why: null, grade: null }, "reclaim moving pages is expected during a memory ladder");
});

test("fewer than two samples can abort nothing", () => {
  const plan = Quattro.calibPlan(RIG);
  same(Quattro.calibAbortFor([], plan), { abort: false, why: null, grade: null });
  same(Quattro.calibAbortFor([sample(2, 99, 4 * MIB, 0)], plan), { abort: false, why: null, grade: null });
});

// ---------------------------------------------------------------------------
// The quiet window. KERNEL and DISK are the two code families a memory ladder
// can cause, so those two are held; BAR, GPU and LAYER pass through, because a
// fault there during a run is genuine. The decoders' session state (kernel
// cursor, layer memory, disk run) must ALWAYS advance, quiet or not - a frozen
// cursor would replay calibration-era journal lines after the run.
// ---------------------------------------------------------------------------

test("sysCodesQuiet holds kernel and disk, passes bar, gpu and layer through", () => {
  const kernel = { cursor: { epochMs: 1234 }, entry: { code: "KERNEL", band: 1 } };
  const gpu = { code: "GPU", band: 1 };
  const layer = { entries: [{ code: "LAYER", band: 1 }], next: { climbs: 1 } };
  const disk = { next: { amberRuns: 3 }, entry: { code: "DISK", band: 1 } };

  const loud = Quattro.sysCodesQuiet({ code: "BAR", band: 1 }, kernel, gpu, layer, disk, false);
  same(
    loud.entries.map((e) => e.code),
    ["BAR", "KERNEL", "GPU", "LAYER", "DISK"],
    "not quiet: every family shows",
  );

  const quiet = Quattro.sysCodesQuiet({ code: "BAR", band: 1 }, kernel, gpu, layer, disk, true);
  same(
    quiet.entries.map((e) => e.code),
    ["BAR", "GPU", "LAYER"],
    "quiet: kernel and disk held, the causal families only",
  );

  // The session state advances in BOTH directions - that is the point.
  assert.equal(quiet.cursor, kernel.cursor);
  assert.equal(quiet.layerNext, layer.next);
  assert.equal(quiet.diskNext, disk.next);
  assert.equal(loud.cursor, kernel.cursor);
  assert.equal(loud.layerNext, layer.next);
  assert.equal(loud.diskNext, disk.next);
});

test("sysCodesQuiet tolerates a family that read nothing this cycle", () => {
  const kernel = { cursor: null, entry: null };
  const layer = { entries: [], next: null };
  const disk = { next: { amberRuns: 0 }, entry: null };
  const quiet = Quattro.sysCodesQuiet(null, kernel, null, layer, disk, true);
  same(quiet.entries, []);
  assert.equal(quiet.cursor, null);
  assert.equal(quiet.diskNext, disk.next);
});

test("calibQuietFor holds through the run and the hot aftermath, releases on calm or cap", () => {
  const running = Quattro.calibQuietFor({ phase: "running" }, 5000, 30, 20);
  assert.equal(running, true, "running is quiet, whatever the readings say");

  const end = 10 * 1000;
  // Straight after the run, io PSI avg60 still holds the ladder's history.
  assert.equal(Quattro.calibQuietFor({ phase: "proposing", endedAtMs: end }, end + 5000, 14, 0.2), true, "the avg60 window remembers the ladder: still quiet");
  assert.equal(Quattro.calibQuietFor({ phase: "proposing", endedAtMs: end }, end + 5000, 2, 0.2), false, "calm aftermath releases early");
  assert.equal(Quattro.calibQuietFor({ phase: "proposing", endedAtMs: end }, end + 5000, 2, 5), true, "PSI still over the stall floor is hot too");

  // The settle cap: 90 s after the end, quiet is over whatever the readings say.
  assert.equal(Quattro.calibQuietFor({ phase: "proposing", endedAtMs: end }, end + 91 * 1000, 40, 30), false);

  // No run ever happened: nothing to hold.
  assert.equal(Quattro.calibQuietFor({ phase: "idle" }, 999999, 40, 30), false);
});

// ---------------------------------------------------------------------------
// The band proposal. PSI scales down from the observed wall (fractions 0.35 /
// 0.65); the reserve pair scales between knee and wall; no wall floors at the
// fleet defaults; a reserve that never moved earns no proposal; a user-set
// critical that blocks the proposed red blocks APPLY, never gets rewritten.
// ---------------------------------------------------------------------------

function record(grade, psiSome10Avg, psiSome10Max, swapUsedPctEnd, swapKbPerMinMax) {
  return {
    grade,
    targetMib: 1000 + grade,
    psiSome10Avg,
    psiSome10Max,
    psiSome60Last: psiSome10Avg / 2,
    swapUsedPctEnd,
    swapKbPerMinMax,
    dirtyKbAvg: 100 * 1024,
  };
}

const QUIET_CURVE = [
  record(0, 0.5, 1.0, 5, 0),
  record(1, 2.0, 3.0, 20, 0),
  record(2, 6.0, 8.0, 45, 0),   // the knee: the first grade with sustained measurable stalls
  record(3, 45.0, 48.0, 88, 0), // the wall: the ladder found where this machine gives out
];

test("the proposal scales the PSI pair down from the observed wall", () => {
  const plan = Quattro.calibPlan(RIG);
  const proposal = Quattro.calibProposalFor(QUIET_CURVE, plan, {
    psi: { amber: 15, red: 28, critical: null },
    batt: { amber: 30, red: 14 },
  });
  assert.equal(proposal.wallGrade, 3);
  assert.equal(proposal.kneeGrade, 2);
  assert.equal(proposal.psi.amber, Math.round(0.35 * 45), "amber is 0.35 of the wall's sustained PSI");
  assert.equal(proposal.psi.red, Math.round(0.65 * 45), "red is 0.65 of the wall's sustained PSI");
  assert.equal(proposal.confidence, "wall");
  assert.equal(proposal.blocked, false);
});

test("the reserve pair scales between knee and wall, never at the raw wall", () => {
  const plan = Quattro.calibPlan(RIG);
  const proposal = Quattro.calibProposalFor(QUIET_CURVE, plan, {
    psi: { amber: 15, red: 28, critical: null },
    batt: { amber: 30, red: 14 },
  });
  // knee 45 percent used, wall 88: amber 45 + 0.35x43, red 45 + 0.65x43.
  assert.equal(proposal.batt.amber, 45 + Math.round(0.35 * 43));
  assert.equal(proposal.batt.red, 45 + Math.round(0.65 * 43));
  assert.ok(proposal.batt.red < 88, "the red line sits below the percent the run proved dangerous");
});

test("a machine that shrugged off the ladder floors at the fleet defaults", () => {
  const plan = Quattro.calibPlan(RIG);
  const strong = [
    record(0, 0.5, 1.0, 5, 0),
    record(1, 1.0, 2.0, 12, 0),
    record(2, 2.0, 2.5, 18, 0),
    record(3, 3.0, 3.5, 24, 0),
  ];
  const proposal = Quattro.calibProposalFor(strong, plan, {
    psi: { amber: 15, red: 28, critical: null },
    batt: { amber: 30, red: 14 },
  });
  assert.equal(proposal.wallGrade, null);
  assert.equal(proposal.psi.amber, Quattro.GAUGE_DEFAULTS.psi.amber, "no wall means the fleet amber is the honest floor");
  assert.equal(proposal.psi.red, Quattro.GAUGE_DEFAULTS.psi.red);
  assert.equal(proposal.confidence, "floor");
  // The reserve moved 19 points but never found a wall: the fleet floor pair.
  assert.equal(proposal.batt.amber, 100 - Quattro.GAUGE_DEFAULTS.batt.amber, "the fleet floor speaks used-percent, the defaults speak free");
  assert.equal(proposal.batt.red, 100 - Quattro.GAUGE_DEFAULTS.batt.red);
});

test("a reserve the ladder never exercised earns no proposal", () => {
  const plan = Quattro.calibPlan(RIG);
  const flat = [
    record(0, 0.5, 1.0, 6, 0),
    record(1, 2.0, 3.0, 7, 0),
    record(2, 6.0, 8.0, 8, 0),
    record(3, 45.0, 48.0, 9, 0),
  ];
  const proposal = Quattro.calibProposalFor(flat, plan, {
    psi: { amber: 15, red: 28, critical: null },
    batt: { amber: 30, red: 14 },
  });
  assert.equal(proposal.batt, null, "a reserve that moved under 10 points says nothing about itself");

  const swapless = QUIET_CURVE.map((r) => ({ ...r, swapUsedPctEnd: null }));
  const p2 = Quattro.calibProposalFor(swapless, plan, {
    psi: { amber: 15, red: 28, critical: null },
    batt: { amber: 30, red: 14 },
  });
  assert.equal(p2.batt, null, "no reserve, no reserve proposal");
});

test("a user-set critical that blocks the proposed red blocks APPLY and rewrites nothing", () => {
  const plan = Quattro.calibPlan(RIG);
  const proposal = Quattro.calibProposalFor(QUIET_CURVE, plan, {
    psi: { amber: 14, red: 24, critical: 25, criticalSetBy: "user" },
    batt: { amber: 30, red: 14 },
  });
  assert.equal(proposal.blocked, true, "proposed red 29 cannot sit under a critical at 25");
  same(proposal.psi, { amber: 14, red: 24 }, "the effective pair is the stored one: the proposal never silently clobbers the critical");
});

test("the proposal applies through setCeiling's ordered steps and never touches critical", () => {
  const plan = Quattro.calibPlan(RIG);
  const proposal = Quattro.calibProposalFor(QUIET_CURVE, plan, {
    psi: { amber: 20, red: 40, critical: 60, criticalSetBy: "user" },
    batt: { amber: 30, red: 14 },
  });
  const steps = [
    ["red", Math.max(40, proposal.psi.amber + 1, proposal.psi.red)],
    ["amber", proposal.psi.amber],
    ["red", proposal.psi.red],
  ];
  let thresholds = { ram: { amber: 20, red: 40, critical: 60, criticalSetBy: "user" } };
  for (const [level, value] of steps) {
    const step = Memory.setCeiling({ thresholds }, "ram", level, value);
    assert.equal(step.ok, true, `ordered step ${level}=${value} validates`);
    thresholds = step.thresholds;
  }
  assert.equal(thresholds.ram.critical, 60, "the user's critical survives the calibration");
  assert.equal(thresholds.ram.criticalSetBy, "user");
  assert.equal(thresholds.ram.amber, proposal.psi.amber);
  assert.equal(thresholds.ram.red, proposal.psi.red);
});

// ---------------------------------------------------------------------------
// The unit argv. The one place the runner is assembled; the widget only runs
// it. --pipe is what makes the helper's progress lines arrive here instead of
// the journal; the ceilings come from the plan the tests above pin; TimeoutStopSec
// is what makes cancel honest; no shell anywhere.
// ---------------------------------------------------------------------------

test("calibUnitArgv assembles the bounded transient unit", () => {
  const plan = Quattro.calibPlan(RIG);
  const argv = Quattro.calibUnitArgv("/opt/plugin/calibrate.py", plan);
  assert.equal(Array.isArray(argv), true);
  assert.equal(argv[0], "systemd-run");
  for (const flag of ["--user", "--pipe", "--wait", "--collect", "--unit=quattrodash-calib"]) {
    assert.equal(argv.includes(flag), true, `the unit must carry ${flag}`);
  }
  assert.equal(argv.includes(`--property=MemoryMax=${plan.ceilingMib}M`), true, "MemoryMax comes from the pinned plan");
  assert.equal(argv.includes(`--property=MemorySwapMax=${plan.swapMaxKiB}KiB`), true, "the swap exposure is bounded deliberately, not left at systemd's default");
  assert.equal(argv.includes("--property=RuntimeMaxSec=200"), true, "the machine-level hard time cap survives a dead shell");
  assert.equal(argv.includes("--property=TimeoutStopSec=5"), true, "cancel lands in seconds even against a thrashing helper");
  const py = argv.indexOf("python3");
  assert.ok(py > 0, "python3 is invoked directly");
  assert.equal(argv[py + 1], "/opt/plugin/calibrate.py");
  const planAt = argv.indexOf("--plan");
  same(JSON.parse(argv[planAt + 1]), plan, "the helper reads the same plan the tests pin");
  for (const part of argv) {
    assert.equal(/[;&|`$<>]/.test(String(part)), false, `no shell metacharacter in ${JSON.stringify(part)}`);
  }
});

test("calibPreflightArgvs are the two typed preflight reads", () => {
  const argvs = Quattro.calibPreflightArgvs();
  assert.equal(argvs.length, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(argvs[0])), ["systemd-run", "--version"]);
  assert.deepEqual(JSON.parse(JSON.stringify(argvs[1])), ["python3", "-V"]);
});

test("calibBattToStored inverts used percent into the store's free percent", () => {
  same(Quattro.calibBattToStored({ amber: 70, red: 86 }), { amber: 30, red: 14 },
    "the fleet defaults round-trip: 70/86 used stores as 30/14 free");
  same(Quattro.calibBattToStored({ amber: 60, red: 73 }), { amber: 40, red: 27 });
  assert.equal(Quattro.calibBattToStored(null), null);
  assert.equal(Quattro.calibBattToStored({ amber: null, red: 86 }), null);
});

test("calibStopArgv and calibProbeArgv name exactly the calibration unit", () => {
  same(Quattro.calibStopArgv(), ["systemctl", "--user", "stop", "quattrodash-calib.service"]);
  same(Quattro.calibProbeArgv(), ["systemctl", "--user", "is-active", "quattrodash-calib"]);
});

// ---------------------------------------------------------------------------
// Copy. The honest warning is the captain's sentence; the language rule bans
// em dashes, en dashes and semicolons from every string a captain reads.
// ---------------------------------------------------------------------------

function walkStrings(value) {
  if (typeof value === "string") return [value];
  if (typeof value === "function") return [];
  if (Array.isArray(value)) return value.flatMap(walkStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(walkStrings);
  return [];
}

test("the confirm copy carries the honest warning, and every CALIB string obeys the language rule", () => {
  const all = walkStrings(Quattro.CALIB).concat([Quattro.SETTINGS.calibrate]);
  assert.ok(all.length > 5, "the calibration has copy to speak");
  const joined = all.join("\n");
  assert.ok(joined.includes("may stutter"), "the captain's honest warning is present verbatim in substance");
  assert.ok(/cancel anytime/i.test(joined), "cancel is promised up front");
  const bad = all.filter((t) => /[\u2014\u2013;]/.test(t));
  same(bad, [], `em dashes, en dashes and semicolons are banned: ${JSON.stringify(bad)}`);
});

test("calibSampleRecord summarizes a grade's samples, skipping failed readings", () => {
  const samples = [
    { atMs: 0, psiSome10: 2.0, psiSome60: 0.5, swapUsedKb: 100 * 1024, swapPct: 5, dirtyKb: 50 * 1024 },
    { atMs: 2000, psiSome10: 4.0, psiSome60: 1.5, swapUsedKb: 100 * 1024 + 100 * 1024, swapPct: 7, dirtyKb: 150 * 1024 },
    { atMs: 4000, psiSome10: null, psiSome60: 2.5, swapUsedKb: 100 * 1024 + 200 * 1024, swapPct: 9, dirtyKb: null },
  ];
  const record = Quattro.calibSampleRecord(1, 1638, samples);
  assert.equal(record.grade, 1);
  assert.equal(record.targetMib, 1638);
  assert.equal(record.psiSome10Avg, 3.0, "the failed PSI reading is skipped, never read as zero");
  assert.equal(record.psiSome10Max, 4.0);
  assert.equal(record.psiSome60Last, 2.5);
  assert.equal(record.swapUsedPctEnd, 9);
  // Last pair: 100 MiB over 2 s = 3000 MiB/min.
  assert.equal(record.swapKbPerMinMax, (100 * 1024) / (2 / 60));
  assert.equal(record.dirtyKbAvg, 100 * 1024);
  same(Quattro.calibSampleRecord(0, 100, []), {
    grade: 0, targetMib: 100, psiSome10Avg: null, psiSome10Max: null, psiSome60Last: null,
    swapUsedPctEnd: null, swapKbPerMinMax: null, dirtyKbAvg: null,
  }, "a grade with no samples reads unknown, never zero");
});

test("the curve and proposal line builders speak used percent and obey the language rule", () => {
  const line = Quattro.calibCurveLine({ grade: 2, targetMib: 1638, psiSome10Avg: 6.25, swapUsedPctEnd: 45.2, dirtyKbAvg: 102400 });
  assert.ok(line.includes("GRADE 3"), line);
  assert.ok(line.includes("PSI 6.3"), line);
  assert.ok(line.includes("SWAP 45%"), line);
  const lines = Quattro.calibProposalLines(
    { psi: { amber: 16, red: 29 }, batt: { amber: 60, red: 73 }, confidence: "wall" },
    { psi: { amber: 15, red: 28 }, batt: { amber: 30, red: 14 } },
  );
  assert.ok(lines.some((l) => l.includes("AMBER 16 PSI (WAS 15)")), lines.join(" | "));
  assert.ok(lines.some((l) => l.includes("60% USED (WAS 70)")), "the stored free pair is inverted into the proposal's used percent");
  const untouched = Quattro.calibProposalLines(
    { psi: { amber: 15, red: 28 }, batt: null, confidence: "floor" },
    { psi: { amber: 15, red: 28 }, batt: { amber: 30, red: 14 } },
  );
  assert.ok(untouched.some((l) => l.includes("UNTOUCHED")));
  assert.ok(untouched.some((l) => l.includes("NO WALL FOUND")));
  const bad = lines.concat([line, untouched.join(" ")]).filter((t) => /[\u2014\u2013;]/.test(t));
  same(bad, [], `em dashes, en dashes and semicolons are banned: ${JSON.stringify(bad)}`);
});

test("the refusal copy names every honest way a start can refuse", () => {
  for (const key of ["headroom", "systemd", "python", "running", "instance", "exists"]) {
    assert.equal(typeof Quattro.CALIB.refused[key], "string", `refused.${key} has words`);
    assert.ok(Quattro.CALIB.refused[key].length > 10);
  }
});

// ---------------------------------------------------------------------------
// The helper: ships with the plugin, allocates anonymous memory, writes
// NOTHING anywhere - no files, no logs, no subprocesses. The smoke test runs
// two tiny grades for real.
// ---------------------------------------------------------------------------

test("the helper exists and its source carries no file-write machinery", () => {
  const src = readFileSync(HELPER, "utf8");
  for (const banned of [/open\(/, /shutil/, /subprocess/, /os\.remove/, /os\.rename/, /os\.mkdir/, /write_text/, /write_bytes/, /tempfile/]) {
    assert.equal(banned.test(src), false, `calibrate.py must not contain ${banned}`);
  }
  assert.ok(src.includes("--plan"), "the helper reads its plan from argv");
});

test("the helper really allocates the plan it is given, and writes only stdout", () => {
  const probe = spawnSync("python3", ["-V"], { encoding: "utf8" });
  if (probe.error && probe.error.code === "ENOENT") {
    return test.skip("python3 is absent on this box");
  }

  const plan = [{ mib: 16, secs: 1 }, { mib: 16, secs: 1 }];
  const run = spawnSync("python3", [HELPER, "--plan", JSON.stringify(plan)], {
    encoding: "utf8",
    timeout: 30000,
  });
  assert.equal(run.status, 0, `the helper exits 0 (stderr: ${run.stderr})`);

  const lines = run.stdout.split("\n").filter((l) => l.trim() !== "");
  assert.equal(lines.length, 3, "one progress line per grade, plus the done line");
  const events = lines.map((l) => JSON.parse(l));
  assert.equal(events[0].event, "grade");
  assert.equal(events[0].grade, 0);
  assert.equal(events[0].mib, 16);
  assert.equal(events[1].grade, 1);
  assert.equal(events[1].cumMib, 32, "the ladder retains: the second grade holds both");
  assert.equal(events[2].event, "done");
  assert.equal(events[2].cumMib, 32);

  // A bad plan is refused before any allocation happens.
  const bad = spawnSync("python3", [HELPER, "--plan", JSON.stringify([{ mib: 0, secs: 1 }])], {
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(bad.status, 3, "a bad plan exits 3 and never allocates");
  assert.equal(bad.stdout.trim(), "", "a refused plan never printed progress");
});
