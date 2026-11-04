// The RAM band is an availability band, not a percent-used band, and swap is
// not a fourth threshold. Fixtures are this rig's own /proc and tool output.
import test from "node:test";
import assert from "node:assert/strict";
import { Memory, fixture, same } from "./load.mjs";

test("MemAvailable drives the band, not MemFree and not percent-used", () => {
  const info = Memory.parseMeminfo(fixture("meminfo.txt"));
  assert.equal(info.MemTotal, 65588588);
  const pct = Memory.ramUsedPct(info);
  assert.equal(pct, ((info.MemTotal - info.MemAvailable) / info.MemTotal) * 100);
  // On this rig MemAvailable is BELOW MemFree plus cache: a MemFree-based
  // monitor would report a machine at 97.96% as if it had room.
  assert.ok(pct > 90, "the honest reading is the alarming one");
  assert.ok(Memory.bandForPct(pct, { amber: 80, red: 90, critical: null }) === 2);
});

test("a missing MemAvailable is unknown, never 0%", () => {
  assert.equal(Memory.ramUsedPct({ MemTotal: 1000 }), null);
  assert.equal(Memory.ramUsedPct({ MemAvailable: 1000 }), null);
  assert.equal(Memory.ramUsedPct({ MemTotal: 0, MemAvailable: 0 }), null);
  const reading = Memory.ramReading({ MemTotal: 1000 });
  assert.equal(reading.pct, null);
});

test("the rig's meminfo parses to a full reading", () => {
  const reading = Memory.ramReading(Memory.parseMeminfo(fixture("meminfo.txt")));
  assert.equal(reading.type, "ram");
  assert.equal(reading.memTotalKb, 65588588);
  assert.equal(reading.memUsedKb, reading.memTotalKb - reading.memAvailableKb);
  assert.equal(reading.swapTotalKb, 132697080);
  assert.equal(reading.swapUsedKb, 132697080 - 112194832);
  assert.equal(Memory.isMemId(reading.id), true);
});

test("PSI is parsed as key=value and is a gate, not a band", () => {
  const psi = Memory.parsePsi(fixture("psi-memory.txt"));
  assert.equal(psi.some_avg10, 0.18);
  assert.equal(psi.full_avg300, 0.83);
  assert.equal(Memory.psiStalling(psi, Memory.PSI_STALL_FLOOR), false);

  const stall = Memory.parsePsi(fixture("psi-stall.txt"));
  assert.equal(Memory.psiStalling(stall, Memory.PSI_STALL_FLOOR), true);
});

test("no PSI interface is not 'no pressure'", () => {
  const none = Memory.parsePsi("");
  assert.equal(Memory.psiStalling(none, Memory.PSI_STALL_FLOOR), false);
  assert.match(Memory.psiText({}), /No PSI reading/);
});

test("/proc/swaps totals every swap device", () => {
  const totals = Memory.swapTotals(Memory.parseSwaps(fixture("swaps.txt")));
  assert.equal(totals.swapTotalKb, 65588220 + 67108860);
  assert.equal(totals.swapUsedKb, 20502132);
  assert.ok(totals.swapPct > 15 && totals.swapPct < 16, "the rig is at about 15% swap");
});

test("no swap devices reads as no swap, not as 0% of something", () => {
  const totals = Memory.swapTotals(Memory.parseSwaps(fixture("swaps-none.txt")));
  assert.equal(totals.swapTotalKb, 0);
  assert.equal(totals.swapPct, null);
  assert.match(Memory.swapText({ swapPct: null }), /^swap none/);
});

test("zramctl's human-readable sizes are read as sizes", () => {
  const zram = Memory.parseZramctl(fixture("zramctl.txt"));
  assert.equal(zram.length, 1);
  assert.equal(zram[0].device, "/dev/zram0");
  assert.equal(zram[0].disksizeKb, 65536000);
  assert.equal(zram[0].dataKb, 19713229);
  assert.equal(zram[0].comprKb, 9122611);
  assert.equal(zram[0].compalg, "zstd");

  const totals = Memory.zramTotals(zram);
  assert.ok(totals.zramPct > 30 && totals.zramPct < 31);
  assert.ok(totals.zramRatio > 2.1 && totals.zramRatio < 2.2, "the compression ratio is a real number, not a guess");
});

test("zram units survive a GiB spelling and a bare number", () => {
  assert.equal(Memory.kbFromUnit("62.5G"), 65536000);
  assert.equal(Memory.kbFromUnit("1.5GiB"), 1572864);
  assert.equal(Memory.kbFromUnit("512M"), 524288);
  assert.equal(Memory.kbFromUnit("1024K"), 1024);
  assert.equal(Memory.kbFromUnit("2T"), 2147483648);
  assert.equal(Memory.kbFromUnit("100"), 100);
  assert.equal(Memory.kbFromUnit("not a size"), null);
});

test("no zram device is reported as no zram", () => {
  const totals = Memory.zramTotals(Memory.parseZramctl(fixture("zramctl-none.txt")));
  assert.equal(totals.zramPct, null);
  assert.equal(totals.zramRatio, null);
  assert.match(Memory.degradationText("zramctl-missing"), /No zram reading/);
});

test("oomctl's live limits are read from this rig's spelling", () => {
  const oomd = Memory.parseOomctl(fixture("oomctl.txt"));
  assert.equal(oomd.oomdSwapLimitPct, 90);
  assert.equal(oomd.oomdPsiLimitPct, 50);
  assert.equal(oomd.oomdPsiLimitDurationMs, 20000);
  assert.equal(oomd.oomdWatchedCgroup, "/user.slice/user-1000.slice/user@1000.service/app.slice");
});

test("oomctl's older spelling is read too", () => {
  const oomd = Memory.parseOomctl([
    "Dry Run: no",
    "Swap used limit: 80% (relative)",
    "Working set limit: 10%",
    "PSI some limit: 60%",
    "PSI some duration: 10s",
    "Cgroup /user.slice/user-1000.slice",
  ].join("\n"));
  assert.equal(oomd.oomdSwapLimitPct, 80);
  assert.equal(oomd.oomdSwapLimitType, "relative");
  assert.equal(oomd.oomdPsiLimitPct, 60);
  assert.equal(oomd.oomdPsiLimitDurationMs, 10000);
  assert.equal(oomd.oomdWorkingSetPct, 10);
  assert.equal(oomd.oomdWatchedCgroup, "/user.slice/user-1000.slice");
});

test("oomd active is a separate discovery from oomctl", () => {
  assert.equal(Memory.parseOomdActive(fixture("systemctl-is-active.txt")), true);
  assert.equal(Memory.parseOomdActive(fixture("systemctl-is-inactive.txt")), false);
  same(Memory.oomdActiveArgs(), ["systemctl", "is-active", "systemd-oomd"]);
  same(Memory.oomctlArgs(), ["oomctl"]);
});

test("the kernel's ceiling is stated beside the user's, and says when there is none", () => {
  const active = Memory.parseOomctl(fixture("oomctl.txt"));
  active.oomdActive = true;
  const text = Memory.kernelCeilingText(active);
  assert.match(text, /oomd at PSI 50% for 20s/);
  assert.match(text, /swap at 90%/);
  assert.match(text, /watching \/user\.slice/);

  assert.match(Memory.kernelCeilingText({ oomdActive: false }), /systemd-oomd is not active - no kernel ceiling is in force/);
});

test("with no oomd the swap escalator assumes 90% and says so", () => {
  assert.equal(Memory.oomdSwapLimit({ oomdActive: false, oomdSwapLimitPct: null }), 90);
  assert.match(Memory.degradationText("oomd-absent"), /assumes 90%/);
});

test("swap is an escalator on the RAM alert, not a fourth threshold", () => {
  const oomd = { oomdActive: true, oomdSwapLimitPct: 90 };
  assert.equal(Memory.swapEscalates({ swapPct: 91 }, oomd), true);
  assert.equal(Memory.swapEscalates({ swapPct: 90 }, oomd), true, "crossing the limit is crossing it");
  assert.equal(Memory.swapEscalates({ swapPct: 40 }, oomd), false);
  assert.equal(Memory.swapEscalates({ swapPct: null }, oomd), false, "no swap is not an escalation");
  assert.equal(Memory.swapEscalates({ swapPct: 91 }, { oomdActive: false }), true, "the assumed 90% still applies");
});

test("there are exactly three thresholded types", () => {
  same(Memory.CEILING_TYPES, ["hd", "vram", "ram"]);
  for (const type of ["hd", "vram", "ram"]) {
    assert.equal(Memory.kindLabel(type) !== type, true);
  }
  assert.match(Memory.kindLabel("swap"), /resource/, "swap has no ceiling of its own");
});

test("nvidia-smi's GPU row and process table parse, commas in a process name included", () => {
  const gpu = Memory.parseNvidiaGpu(fixture("nvidia-gpu.txt"));
  assert.equal(gpu.totalMib, 16303);
  assert.equal(gpu.usedMib, 11383);
  assert.equal(gpu.freeMib, 4529);
  assert.match(gpu.name, /RTX 5070 Ti/);

  const apps = Memory.parseNvidiaApps(fixture("nvidia-apps.txt"));
  assert.equal(apps.length, 4);
  for (const app of apps) {
    assert.equal(app.usedMib > 0, true, `${app.processName} keeps its own MiB`);
    assert.equal(app.processName.includes(","), false, "a field is not split inside a quoted name");
  }
});

test("unattributed VRAM is named as unattributed and never goes negative", () => {
  const apps = [{ usedMib: 3000 }, { usedMib: 2000 }];
  assert.equal(Memory.vramUnattributedMib(10267, apps), 5267);
  // Shared contexts and double-counted processes can make the sum exceed `used`.
  assert.equal(Memory.vramUnattributedMib(4000, apps), 0);
  assert.equal(Memory.vramUnattributedMib(null, apps), null);
});

test("no nvidia-smi and no driver are two different degradations", () => {
  assert.equal(Memory.nvidiaMissingVerdict(fixture("nvidia-gpu-missing.txt")), "not-installed");
  assert.equal(Memory.nvidiaMissingVerdict(fixture("nvidia-gpu-nodriver.txt")), "no-driver");
  assert.match(Memory.unavailableText("vram", "not-installed"), /nvidia-smi is not available/);
  assert.match(Memory.unavailableText("vram", "no-driver"), /could not reach the driver/);
  assert.equal(Memory.unavailableText("vram", "not-installed").includes("RAM and drives still monitor"), true);
});

test("the VRAM argv asks for exactly the fields the reader fills", () => {
  same(Memory.nvidiaGpuArgs(), [
    "nvidia-smi",
    "--query-gpu=index,name,memory.total,memory.used,memory.free",
    "--format=csv,nounits,noheader",
  ]);
  same(Memory.nvidiaAppsArgs(), [
    "nvidia-smi",
    "--query-compute-apps=pid,process_name,used_memory",
    "--format=csv,nounits,noheader",
  ]);
});

test("every read argv is typed, fixed, and carries no user-supplied value", () => {
  const programs = ["cat", "cat", "cat", "zramctl", "systemctl", "oomctl", "nvidia-smi", "nvidia-smi"];
  const argvs = [
    Memory.meminfoArgs(),
    Memory.psiArgs(),
    Memory.swapsArgs(),
    Memory.zramctlArgs(),
    Memory.oomdActiveArgs(),
    Memory.oomctlArgs(),
    Memory.nvidiaGpuArgs(),
    Memory.nvidiaAppsArgs(),
  ];
  argvs.forEach((argv, i) => {
    same(argv.length > 0, true);
    assert.equal(argv[0], programs[i], "argv[0] is a bare program name, never a dash-prefixed value");
    for (const part of argv) {
      assert.equal(typeof part, "string", "every argument is a string, never a nested list");
      assert.equal(part.includes(";"), false);
      assert.equal(part.includes("|"), false);
      assert.equal(part.includes("$"), false);
      assert.equal(part.includes("`"), false);
      assert.equal(part.includes("\n"), false);
    }
  });
});
