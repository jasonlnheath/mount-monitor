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
import { spawn, spawnSync } from "node:child_process";
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

// The target cap mirrors calibPlan's own rails: 80 percent of physical RAM
// (MemTotal minus the ceiling reserve), still clamped below the ceiling's
// margin. Keep this the twin of the plan builder so a drift fails here.
const physicalMibOf = (meminfo) =>
  Math.floor((meminfo.MemTotal - Quattro.CALIB_CEILING_RESERVE_KB) / 1024);
const targetCapOf = (meminfo) =>
  Math.min(
    Math.floor(Quattro.CALIB_CAP_PHYS_FRAC * physicalMibOf(meminfo)),
    physicalMibOf(meminfo) - Quattro.CALIB_CEILING_MARGIN_MIB,
  );

// ---------------------------------------------------------------------------
// The plan builder. Grades are DELTAS between consecutive targets, so the
// ladder retains and tops out just short of exhaustion: free memory minus a
// small fixed reserve, on every machine that clears the headroom gate. The
// ceiling is clamped below physical RAM, because a cgroup limit at or above
// physical is not a wall: it is an invitation to the global oom killer, which
// can shoot the browser instead of the helper.
// ---------------------------------------------------------------------------

test("calibPlan builds an eight-step ladder topping just short of exhaustion", () => {
  const plan = Quattro.calibPlan(RIG);
  assert.equal(plan.ok, true, "the rig fixture clears the headroom gate");
  assert.equal(plan.grades.length, 8);
  for (const g of plan.grades) assert.equal(g.secs, Quattro.CALIB_GRADE_SECS);

  // The climb tops at MemAvailable minus the fixed headroom reserve, in eight
  // equal twenty-second steps: 8192 - 1536 = 6656 MiB on the rig, so the last
  // grades sit where reclaim and swap actually engage.
  const top = 8192 - Quattro.CALIB_TOP_HEADROOM_MIB;
  let prev = 0;
  plan.grades.forEach((g, i) => {
    const target = Math.round((top / Quattro.CALIB_GRADE_STEPS) * (i + 1));
    assert.equal(g.mib, target - prev, `grade ${i} mib is the delta between cumulative targets`);
    prev = target;
  });
  assert.equal(plan.totalMib, 6656, "the plan tops at free memory minus the headroom reserve");
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
  // Tiny: 1.5 GiB available clears the headroom gate. Free minus the headroom
  // reserve would go negative, so the cumulative-target floor binds and the
  // ladder climbs at the floor: 256 MiB in eight positive steps.
  const small = Quattro.calibPlan({ MemTotal: 4 * MIB, MemAvailable: 1500 * 1024, SwapTotal: 0, SwapFree: 0 });
  assert.equal(small.ok, true);
  assert.equal(small.totalMib, Quattro.CALIB_GRADE_FLOOR_MIB, "less free than the reserve still climbs, at the floor");
  let prev = 0;
  for (const g of small.grades) {
    assert.ok(g.mib > 0, "deltas stay positive on a small rig");
    prev += g.mib;
  }
  assert.equal(small.totalMib, prev);

  // Huge: the climb tops at free-minus-reserve (100864 MiB), still under the
  // physical rails, and far past the old fixed 8 GiB cap.
  const hugeMachine = { MemTotal: 128 * MIB, MemAvailable: 100 * MIB, SwapTotal: 16 * MIB, SwapFree: 16 * MIB };
  const huge = Quattro.calibPlan(hugeMachine);
  assert.equal(huge.ok, true);
  assert.ok(huge.totalMib > 8192, "a huge machine's ladder scales past the old fixed 8 GiB cap");
  assert.equal(huge.totalMib, 100 * 1024 - Quattro.CALIB_TOP_HEADROOM_MIB, "the huge ladder tops at free minus the reserve");
  assert.ok(huge.totalMib <= targetCapOf(hugeMachine), "the cumulative top never exceeds the physical cap");

  // A well-populated small machine: free minus the reserve (2364 MiB) binds
  // here, and the physical rails sit above it with margin to spare.
  const populated = { MemTotal: 4 * MIB, MemAvailable: 3900 * 1024, SwapTotal: 0, SwapFree: 0 };
  const idleSmall = Quattro.calibPlan(populated);
  assert.equal(idleSmall.ok, true);
  assert.ok(idleSmall.grades.length > 0, "the clamped ladder still climbs");
  assert.ok(
    idleSmall.totalMib <=
      Math.floor((populated.MemTotal - Quattro.CALIB_CEILING_RESERVE_KB) / 1024) - Quattro.CALIB_CEILING_MARGIN_MIB,
    "the ladder tops out with its margin to spare under the physical bound",
  );
  assert.equal(
    idleSmall.totalMib,
    3900 - Quattro.CALIB_TOP_HEADROOM_MIB,
    "free-minus-reserve binds on this rig, under the rails with margin to spare",
  );

  // One step more available and the rails bind first: 4000 MiB free would ask
  // for 2464 MiB, the physical cap allows 2457, and the ladder lands on the
  // rail - the ceiling can always wall off the ladder that ships.
  const railBound = { MemTotal: 4 * MIB, MemAvailable: 4000 * 1024, SwapTotal: 0, SwapFree: 0 };
  const railPlan = Quattro.calibPlan(railBound);
  assert.equal(railPlan.ok, true);
  assert.equal(railPlan.totalMib, targetCapOf(railBound), "the physical rails bind before the climb reaches its top");
  assert.ok(
    railPlan.totalMib <=
      Math.floor((railBound.MemTotal - Quattro.CALIB_CEILING_RESERVE_KB) / 1024) - Quattro.CALIB_CEILING_MARGIN_MIB,
    "the rail-bound ladder still leaves the ceiling its margin",
  );

  // The ceiling is the kernel wall: above the ladder, below physical RAM.
  for (const { meminfo, plan } of [
    { meminfo: RIG, plan: Quattro.calibPlan(RIG) },
    { meminfo: { MemTotal: 4 * MIB, MemAvailable: 1500 * 1024, SwapTotal: 0, SwapFree: 0 }, plan: small },
    { meminfo: hugeMachine, plan: huge },
    { meminfo: populated, plan: idleSmall },
    { meminfo: railBound, plan: railPlan },
  ]) {
    const physicalMib = physicalMibOf(meminfo);
    assert.ok(plan.ceilingMib > plan.totalMib, "the ceiling sits above the ladder it bounds");
    assert.ok(plan.ceilingMib <= physicalMib, "the ceiling never reaches physical RAM minus the reserve");
    assert.equal(plan.ceilingMib, Math.min(plan.totalMib + Quattro.CALIB_CEILING_MARGIN_MIB, physicalMib));
  }
});

test("calibPlan lets a roomy machine climb into the pressure zone", () => {
  // The captain's rig: 64 GiB physical, 50 GiB free. The old fraction curve
  // left 10 GiB free at the top - watermark-scale pressure never engaged. The
  // climb now stops one reserve short of exhaustion: 50 GiB free minus 1.5 GiB
  // held back, 49664 MiB of ladder, so the run ends where the wall lives.
  const roomy = { MemTotal: 64 * MIB, MemAvailable: 50 * MIB, SwapTotal: 16 * MIB, SwapFree: 16 * MIB };
  const plan = Quattro.calibPlan(roomy);
  assert.equal(plan.ok, true);
  assert.ok(plan.totalMib > 8192, "the top cumulative target clears the old fixed 8 GiB cap");
  assert.equal(plan.totalMib, 50 * 1024 - Quattro.CALIB_TOP_HEADROOM_MIB, "the climb tops at the 50 GiB free minus the reserve");
  assert.ok(plan.totalMib <= targetCapOf(roomy), "the ladder never retains more than the physical cap");
  const physicalMib = physicalMibOf(roomy);
  assert.ok(plan.ceilingMib > plan.totalMib, "the ceiling sits above the ladder it bounds");
  assert.ok(plan.ceilingMib < physicalMib, "the ceiling stays below physical RAM minus the reserve");
  assert.equal(plan.ceilingMib, Math.min(plan.totalMib + Quattro.CALIB_CEILING_MARGIN_MIB, physicalMib));
});

test("calibPlan caps every grade where the helper's own parser does", () => {
  // A very large machine: 256 GiB physical, 200 GiB free. The eight steps plan
  // ~25408 MiB each - still inside the helper's bound - but the law is the
  // same either way: the builder and the helper enforce one per-grade bound,
  // so no plan the builder ships can die at the helper's parse. The helper
  // probes further down pin the helper's enforced bound to this same constant
  // by exit code, from both sides of the line.
  const big = { MemTotal: 256 * MIB, MemAvailable: 200 * MIB, SwapTotal: 32 * MIB, SwapFree: 32 * MIB };
  const plan = Quattro.calibPlan(big);
  assert.equal(plan.ok, true);
  const bound = Quattro.CALIB_GRADE_MAX_MIB;
  assert.ok(plan.grades.length > 0, "the ladder still climbs");
  for (const g of plan.grades) {
    assert.ok(g.mib >= 1 && g.mib <= bound, `a grade of ${g.mib} MiB stays inside the helper's 1..${bound}`);
  }
  assert.equal(plan.totalMib, plan.grades.reduce((n, g) => n + g.mib, 0),
    "totalMib is the ladder actually held, never a phantom unclamped target");
  const physicalMib = physicalMibOf(big);
  assert.ok(plan.ceilingMib > plan.totalMib, "the ceiling sits above the ladder it bounds");
  assert.ok(plan.ceilingMib <= physicalMib, "the ceiling never reaches physical RAM minus the reserve");
});

test("calibPlan splits an oversized step into sub-grades instead of shrinking the climb", () => {
  // 384 GiB physical, 320 GiB free: the ceiling rail binds the top at 313753
  // MiB, so each of the eight steps plans ~39219 MiB - over the helper's
  // 32768 per-grade bound. The step SPLITS into two sub-grades holding the
  // same memory in the same twenty seconds: the ladder keeps its top and its
  // clock, and no grade the helper would refuse ever ships.
  const big = { MemTotal: 384 * MIB, MemAvailable: 320 * MIB, SwapTotal: 64 * MIB, SwapFree: 64 * MIB };
  const plan = Quattro.calibPlan(big);
  assert.equal(plan.ok, true);
  // The most grades a conforming plan can carry: every step splits into at
  // most CALIB_GRADE_SECS sub-grades, because each holds at least one second
  // of its step's window. The helper probes further down pin the helper's
  // enforced count law to exactly this budget, from both sides of the line.
  const gradeBudget = Quattro.CALIB_GRADE_STEPS * Quattro.CALIB_GRADE_SECS;
  const bound = Quattro.CALIB_GRADE_MAX_MIB;
  assert.ok(plan.grades.length > Quattro.CALIB_GRADE_STEPS, "the oversized steps split into more grades");
  assert.ok(plan.grades.length <= gradeBudget, "the split ladder stays inside the helper's grade-count law");
  assert.equal(plan.totalMib, 313753, "the physical rails bind the top, and splitting never lowers it");
  for (const g of plan.grades) {
    assert.ok(g.mib >= 1 && g.mib <= bound, `a split grade of ${g.mib} MiB stays inside the helper's 1..${bound}`);
    assert.ok(g.secs >= 1, "a split grade still holds its seconds");
  }
  assert.equal(plan.totalMib, plan.grades.reduce((n, g) => n + g.mib, 0), "splitting moves no memory");
  assert.equal(
    plan.grades.reduce((n, g) => n + g.secs, 0),
    Quattro.CALIB_GRADE_STEPS * Quattro.CALIB_GRADE_SECS,
    "splitting moves no time: the ladder's clock survives the split",
  );
  const physicalMib = physicalMibOf(big);
  assert.ok(plan.ceilingMib > plan.totalMib, "the ceiling sits above the ladder it bounds");
  assert.ok(plan.ceilingMib <= physicalMib, "the ceiling never reaches physical RAM minus the reserve");
});

test("calibPlan climbs a busy machine by the same near-exhaustion contract", () => {
  // The November 13 rigs, re-pinned under the ruling: the climb tops at free
  // minus the reserve on ANY machine that clears the gate, loaded or idle -
  // that is what makes the run reach pressure on a busy box too. 2 GiB free
  // plans a 512 MiB ladder (8 x 64); 10 GiB free plans 8704 MiB (8 x 1088).
  const busy = { MemTotal: 16 * MIB, MemAvailable: 2048 * 1024, SwapTotal: 4 * MIB, SwapFree: 4 * MIB };
  const plan = Quattro.calibPlan(busy);
  assert.equal(plan.ok, true);
  assert.equal(plan.totalMib, 2048 - Quattro.CALIB_TOP_HEADROOM_MIB, "the busy rig tops at its free minus the reserve");
  same(plan.grades.map((g) => g.mib), [64, 64, 64, 64, 64, 64, 64, 64]);

  const tenFree = { MemTotal: 16 * MIB, MemAvailable: 10 * MIB, SwapTotal: 4 * MIB, SwapFree: 4 * MIB };
  const ten = Quattro.calibPlan(tenFree);
  assert.equal(ten.ok, true);
  assert.equal(ten.totalMib, 10 * 1024 - Quattro.CALIB_TOP_HEADROOM_MIB, "the 10 GiB-free rig tops at its free minus the reserve");
  same(ten.grades.map((g) => g.mib), [1088, 1088, 1088, 1088, 1088, 1088, 1088, 1088]);
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
  assert.equal(Quattro.gradeAt(plan, 19), 0);
  assert.equal(Quattro.gradeAt(plan, 20), 1);
  assert.equal(Quattro.gradeAt(plan, 40), 2);
  assert.equal(Quattro.gradeAt(plan, 60), 3);
  assert.equal(Quattro.gradeAt(plan, 80), 4);
  assert.equal(Quattro.gradeAt(plan, 100), 5);
  assert.equal(Quattro.gradeAt(plan, 120), 6);
  assert.equal(Quattro.gradeAt(plan, 140), 7);
  assert.equal(Quattro.gradeAt(plan, 159), 7);
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

test("the settle window's PSI floor mirrors memory.js's stall floor", () => {
  assert.equal(Quattro.CALIB_SETTLE_PSI_FLOOR, Memory.PSI_STALL_FLOOR,
    "the modules never import each other, so this pin is what holds the settle heat judge to the stall lane it mirrors");
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
  assert.equal(argv.includes(`--property=MemorySwapMax=${plan.swapMaxKiB}K`), true, "the swap exposure is bounded deliberately, not left at systemd's default");
  assert.equal(argv.includes("--property=RuntimeMaxSec=200"), true, "the machine-level hard time cap survives a dead shell");
  assert.equal(argv.includes("--property=TimeoutStopSec=5"), true, "cancel lands in seconds even against a thrashing helper");
  const py = argv.indexOf("python3");
  assert.ok(py > 0, "python3 is invoked directly");
  assert.equal(argv[py + 1], "/opt/plugin/calibrate.py");
  const planAt = argv.indexOf("--plan");
  same(JSON.parse(argv[planAt + 1]), plan.grades, "the helper receives the plan's grades, the array its own parser requires");
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
  for (const key of ["headroom", "systemd", "python", "running", "instance"]) {
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

// The test box's own free window, in MiB. The boundary probes below hand the
// real helper a plan whose first grade is tens of GiB: the box must be able to
// take that allocation, or the probe skips - the same law the live tests above
// already follow for python3, systemd-run and qml6.
function boxAvailMib() {
  const m = readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+) kB$/m);
  return m ? Math.floor(Number(m[1]) / 1024) : null;
}

// The most grades a conforming plan can carry: eight steps, each splitting into
// at most twenty one-second sub-grades, because no sub-grade holds less than
// one second of its step's twenty.
const gradeBudget = () => Quattro.CALIB_GRADE_STEPS * Quattro.CALIB_GRADE_SECS;

test("the helper refuses one grade over either plan law before allocating", () => {
  const probe = spawnSync("python3", ["-V"], { encoding: "utf8" });
  if (probe.error && probe.error.code === "ENOENT") {
    return test.skip("python3 is absent on this box");
  }

  // Over the per-grade bound: one MiB past CALIB_GRADE_MAX_MIB.
  const overMib = spawnSync("python3", [HELPER, "--plan",
    JSON.stringify([{ mib: Quattro.CALIB_GRADE_MAX_MIB + 1, secs: 1 }])], {
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(overMib.status, 3, "a grade one MiB over the bound exits 3");
  assert.equal(overMib.stdout.trim(), "", "a refused plan never printed progress");

  // Over the grade-count law: one one-MiB grade past the builder's own budget.
  const overCount = spawnSync("python3", [HELPER, "--plan",
    JSON.stringify(Array.from({ length: gradeBudget() + 1 }, () => ({ mib: 1, secs: 1 })))], {
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(overCount.status, 3, "a plan one grade over the count law exits 3");
  assert.equal(overCount.stdout.trim(), "", "a refused plan never printed progress");
});

test("the helper accepts plans exactly at both plan-law bounds", async () => {
  const probe = spawnSync("python3", ["-V"], { encoding: "utf8" });
  if (probe.error && probe.error.code === "ENOENT") {
    return test.skip("python3 is absent on this box");
  }

  // Exactly at the per-grade bound the plan runs for real and finishes. The
  // grade holds the bound's full MiB for a second, so the probe skips on a box
  // without the window to hold it.
  const avail = boxAvailMib();
  if (avail === null || avail < Quattro.CALIB_GRADE_MAX_MIB + 2048) {
    return test.skip("this box cannot hold a grade at the per-grade bound");
  }
  const atBound = spawnSync("python3", [HELPER, "--plan",
    JSON.stringify([{ mib: Quattro.CALIB_GRADE_MAX_MIB, secs: 1 }])], {
    encoding: "utf8",
    timeout: 60000,
  });
  assert.equal(atBound.status, 0, `the helper finishes a grade exactly at the bound (stderr: ${atBound.stderr})`);
  const events = atBound.stdout.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
  assert.equal(events.length, 2, "one grade line, plus the done line");
  assert.equal(events[0].event, "grade");
  assert.equal(events[0].mib, Quattro.CALIB_GRADE_MAX_MIB);
  assert.equal(events[1].event, "done");
  assert.equal(events[1].cumMib, Quattro.CALIB_GRADE_MAX_MIB);

  // Exactly at the count law the plan is accepted too. Every grade holds at
  // least one second, so a full budget-sized run is minutes of clock: the
  // first grade line is the handshake that the parse accepted the count - a
  // refused plan prints nothing and exits 3 - and SIGTERM ends the probe.
  const child = spawn("python3", [HELPER, "--plan",
    JSON.stringify(Array.from({ length: gradeBudget() }, () => ({ mib: 1, secs: 1 })))], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childErr = "";
  child.stderr.on("data", (chunk) => { childErr += chunk; });
  const first = await new Promise((resolve, reject) => {
    child.stdout.once("data", (chunk) => resolve(JSON.parse(chunk.toString().split("\n")[0])));
    child.once("exit", (code) => reject(new Error(`the helper exited ${code} before its first grade line (stderr: ${childErr.trim()})`)));
  });
  assert.equal(first.event, "grade");
  assert.equal(first.grade, 0);
  assert.equal(first.mib, 1, "the budget-sized plan started grading: the count law accepted it");
  const outcome = await new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.kill("SIGTERM");
    setTimeout(() => resolve(null), 5000);
  });
  assert.ok(outcome, "the probe's run dies rather than hanging");
  assert.equal(outcome.signal, "SIGTERM");
});

test("the split plan calibPlan ships on a huge rig clears the real helper's parse", async () => {
  const probe = spawnSync("python3", ["-V"], { encoding: "utf8" });
  if (probe.error && probe.error.code === "ENOENT") {
    return test.skip("python3 is absent on this box");
  }

  // The huge-rig boundary: 1.5 TiB physical, mostly idle. The physical rail
  // binds the top at 1257472 MiB, every one of the eight steps splits into
  // five sub-grades, and the plan ships 40 grades - the exact shape that must
  // clear the helper's grade-count law whole, not die at its parse.
  const titan = { MemTotal: 1610612736, MemAvailable: 1300000 * 1024, SwapTotal: 64 * MIB, SwapFree: 64 * MIB };
  const plan = Quattro.calibPlan(titan);
  assert.equal(plan.ok, true);
  assert.ok(plan.grades.length > Quattro.CALIB_GRADE_STEPS, "the huge rig's oversized steps split");
  assert.ok(plan.grades.length <= gradeBudget(), "the split plan stays inside the grade-count law");
  for (const g of plan.grades) {
    assert.ok(g.mib >= 1 && g.mib <= Quattro.CALIB_GRADE_MAX_MIB, `a split grade of ${g.mib} MiB stays inside the helper's 1..${Quattro.CALIB_GRADE_MAX_MIB}`);
    assert.ok(g.secs >= 1 && g.secs <= 60, `a split grade's ${g.secs} s stays inside the helper's 1..60`);
  }
  assert.equal(plan.totalMib, plan.grades.reduce((n, g) => n + g.mib, 0), "splitting moves no memory");

  // The first grade is tens of GiB: the box must be able to take its
  // allocation for the handshake, or the probe skips.
  const avail = boxAvailMib();
  if (avail === null || avail < plan.grades[0].mib + 2048) {
    return test.skip("this box cannot hold the boundary plan's first grade");
  }
  const child = spawn("python3", [HELPER, "--plan", JSON.stringify(plan.grades)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let childErr = "";
  child.stderr.on("data", (chunk) => { childErr += chunk; });
  const first = await new Promise((resolve, reject) => {
    child.stdout.once("data", (chunk) => resolve(JSON.parse(chunk.toString().split("\n")[0])));
    child.once("exit", (code) => reject(new Error(`the helper exited ${code} on calibPlan's own payload (stderr: ${childErr.trim()})`)));
  });
  assert.equal(first.event, "grade", "the real helper accepted the split plan and started grading it");
  assert.equal(first.grade, 0);
  assert.equal(first.mib, plan.grades[0].mib);
  assert.equal(first.cumMib, plan.grades[0].mib);
  const outcome = await new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.kill("SIGTERM");
    setTimeout(() => resolve(null), 5000);
  });
  assert.ok(outcome, "the probe's run dies rather than hanging");
  assert.equal(outcome.signal, "SIGTERM");
});

test("the runner-to-helper seam composes: the unit argv's own --plan payload runs in the real helper", async () => {
  const probe = spawnSync("python3", ["-V"], { encoding: "utf8" });
  if (probe.error && probe.error.code === "ENOENT") {
    return test.skip("python3 is absent on this box");
  }

  // A plan of calibPlan's own shape, sized to run for real: the seam must
  // compose on the payload the runner actually builds, not on a hand-made one.
  const plan = {
    ok: true,
    grades: [
      { mib: 16, secs: 1 },
      { mib: 16, secs: 1 },
    ],
    totalMib: 32,
    capSec: 2,
    ceilingMib: 544,
    swapMaxKiB: 0,
  };
  const argv = Quattro.calibUnitArgv(HELPER, plan);
  const payload = argv[argv.indexOf("--plan") + 1];
  same(JSON.parse(payload), plan.grades, "the runner sends the grades array, the helper's documented plan");

  // Handshake, end to end: execute the exact command the unit runs, from its
  // python3 token on. A payload the helper's parser rejects exits 3 with no
  // grade lines, so the assertions below are the seam's proof of life.
  const py = argv.indexOf("python3");
  const run = spawnSync(argv[py], argv.slice(py + 1), { encoding: "utf8", timeout: 30000 });
  assert.equal(run.status, 0, `the helper accepts the runner's own payload (stderr: ${run.stderr})`);
  const events = run.stdout.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
  assert.equal(events.length, 3, "one grade line per grade, plus the done line");
  assert.equal(events[0].event, "grade");
  assert.equal(events[0].grade, 0);
  assert.equal(events[0].mib, 16);
  assert.equal(events[1].event, "grade");
  assert.equal(events[1].cumMib, 32, "the ladder retains: the second grade holds both");
  assert.equal(events[2].event, "done");
  assert.equal(events[2].cumMib, 32);

  // Cancel: SIGTERM is what `systemctl stop` delivers to the unit's cgroup. A
  // live run must die by python's default disposition, in seconds, mid-grade.
  const longPlan = Object.assign({}, plan, { grades: [{ mib: 16, secs: 60 }], totalMib: 16, capSec: 60 });
  const longArgv = Quattro.calibUnitArgv(HELPER, longPlan);
  const longPy = longArgv.indexOf("python3");
  const child = spawn(longArgv[longPy], longArgv.slice(longPy + 1), { stdio: ["ignore", "pipe", "pipe"] });
  let childErr = "";
  child.stderr.on("data", (chunk) => { childErr += chunk; });
  await new Promise((resolve, reject) => {
    child.stdout.once("data", () => resolve());
    child.once("exit", (code) => reject(new Error(`the helper exited ${code} before its first grade line (stderr: ${childErr.trim()})`)));
  });
  const killAt = Date.now();
  let killTimer = null;
  const outcome = await new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.kill("SIGTERM");
    killTimer = setTimeout(() => resolve(null), 5000);
  });
  clearTimeout(killTimer);
  assert.ok(outcome, "a SIGTERM'd run dies rather than hanging");
  assert.equal(outcome.signal, "SIGTERM", "cancel is the default disposition, never trapped or masked");
  assert.ok(Date.now() - killAt < 3000, "cancel lands in seconds against a live grade");
});

test("systemd itself accepts the unit argv the runner builds, and the pipe delivers its events", async () => {
  const probe = spawnSync("systemd-run", ["--version"], { encoding: "utf8" });
  if (probe.error && probe.error.code === "ENOENT") {
    return test.skip("systemd-run is absent on this box");
  }
  // A user manager is not a given (containers, CI): distinguish "no bus" from
  // "systemd refused something in our argv" - only the former skips.
  const reach = spawnSync("systemd-run", ["--user", "--pipe", "--wait", "--collect", "--unit=quattrodash-calib-seam-probe", "/bin/true"], { encoding: "utf8", timeout: 30000 });
  if (reach.status !== 0 && /connect|bus/i.test(reach.stderr || "")) {
    return test.skip("no systemd user manager reachable here");
  }
  assert.equal(reach.status, 0, `a property-less probe unit must run (stderr: ${reach.stderr})`);

  // The whole argv, from its systemd-run token on: every --property spelling
  // the builder emits is accepted by the real parser (a suffix systemd rejects
  // fails the whole launch with exit 1 before the helper ever starts - the
  // KiB bug this test was written to hold shut), and --pipe carries the
  // helper's grade lines back to the caller.
  const plan = {
    ok: true,
    grades: [
      { mib: 16, secs: 1 },
      { mib: 16, secs: 1 },
    ],
    totalMib: 32,
    capSec: 2,
    ceilingMib: 544,
    swapMaxKiB: 8388604,
  };
  const argv = Quattro.calibUnitArgv(HELPER, plan).slice(0);
  const props = argv.filter((a) => String(a).startsWith("--property="));
  assert.equal(props.length, 4, "the rail properties are all present");
  const run = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", timeout: 60000 });
  assert.equal(run.status, 0, `systemd-run accepted every property and the helper finished (stderr: ${run.stderr})`);
  const events = run.stdout.split("\n").filter((l) => l.trim() !== "").map((l) => {
    try { return JSON.parse(l); } catch { return { event: "unparseable", line: l }; }
  });
  assert.equal(events.filter((e) => e.event === "grade").length, 2, "both grade lines arrived through the unit's pipe");
  assert.equal(events.filter((e) => e.event === "done").length, 1, "the done line arrived through the unit's pipe");
});
