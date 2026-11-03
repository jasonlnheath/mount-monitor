// Onboarding: report what the machine actually rests at, recommend from that,
// ask for the ceilings, and ask the guard question. A recommendation is never a
// ceiling, and a critical line never exists until the captain sets it.
import test from "node:test";
import assert from "node:assert/strict";
import { Memory, repoFile, same } from "./load.mjs";

const RAM = {
  pct: 97.95,
  ramRestingPct: 93.0,
  memTotalKb: 65588588,
  memAvailableKb: 4587520,
  psiSomeAvg10: 0.18,
  swapPct: 15,
  zramPct: 30,
};
const OOMD = {
  oomdActive: true,
  oomdPsiLimitPct: 50,
  oomdPsiLimitDurationMs: 20000,
  oomdSwapLimitPct: 90,
  oomdWatchedCgroup: "/user.slice/user-1000.slice/user@1000.service/app.slice",
};

test("first run is decided by the state file, not by the wall clock", () => {
  assert.equal(Memory.firstRunNeeded({}), true);
  assert.equal(Memory.firstRunNeeded(Memory.normalizeSettings({})), true);
  assert.equal(Memory.firstRunNeeded({ firstRunAt: "2026-11-02T00:00:00.000Z" }), false);
  assert.equal(Memory.firstRunNeeded(Memory.normalizeSettings({ firstRunAt: "2026-11-02T00:00:00.000Z" })), false);
});

test("the state lives in its own directory, and deleting it is the reset hook", () => {
  assert.equal(Memory.stateDir("/home/jason"), "/home/jason/.local/state/memory-monitor");
  assert.equal(Memory.settingsPath("/home/jason"), "/home/jason/.local/state/memory-monitor/settings.json");
  assert.equal(Memory.logPath("/home/jason"), "/home/jason/.local/state/memory-monitor/baseline.jsonl");
});

test("the ceiling question reports the reading before it asks anything", () => {
  const text = Memory.ceilingsQuestion("ram", RAM, OOMD, {});
  const lines = text.split("\n");
  assert.match(lines[0], /^Memory Monitor - System RAM ceilings$/);
  assert.match(lines[1], /^Measured now: System RAM 98% used, .* available of .*$/);
  assert.match(lines[2], /Your amber: 80% \(default\)\. Your red: 90% \(default\)\./);
  assert.match(lines[3], /^Your critical: not set - you have no ceiling, and no critical alert can fire\.$/);
  assert.match(lines[4], /^The kernel's ceiling: oomd at PSI 50% for 20s, or swap at 90%, watching \/user\.slice/);
  assert.match(lines[5], /^Recommended from this machine: amber 95%, red 98%, critical 99%\.$/);
  assert.match(lines[6], /^This machine rests at 93%, which is inside your amber line\.$/);
});

test("a ceiling the user set is reported as his, with its number", () => {
  const settings = Memory.setCeiling(Memory.setCeiling({}, "ram", "critical", 96), "ram", "amber", 70);
  const text = Memory.ceilingsQuestion("ram", RAM, OOMD, settings.thresholds);
  assert.match(text, /Your amber: 70% \(you set it\)/);
  assert.match(text, /Your critical: 96% \(you set it\)\./);
  assert.equal(text.includes("not set - you have no ceiling"), false);
});

test("no oomd is stated as no kernel ceiling, not as a zero", () => {
  const text = Memory.ceilingsQuestion("ram", RAM, { oomdActive: false }, {});
  assert.match(text, /The kernel's ceiling: systemd-oomd is not active - no kernel ceiling is in force/);
});

test("a recommendation is a recommendation: derived from the resting reading, capped, and marked provisional without one", () => {
  const rec = Memory.recommendCeilings("ram", RAM, OOMD);
  assert.equal(rec.restingPct, 93);
  assert.equal(rec.provisional, false);
  assert.ok(rec.amber > rec.restingPct, "a recommendation that sits under the resting reading would alert forever");
  assert.ok(rec.critical <= 99);
  const none = Memory.recommendCeilings("ram", null, OOMD);
  assert.equal(none.provisional, true);
  assert.equal(none.restingPct, null);
});

test("a recommendation fills only the ceilings he never set, and is refused rather than applied broken", () => {
  const settings = Memory.setCeiling({}, "ram", "critical", 96);
  // This machine rests at 93%, so the recommendation is amber 95 / red 98 / critical 99.
  const resting = Memory.recommendCeilings("ram", { ramRestingPct: 93 }, OOMD);
  const buried = Memory.applyRecommendation(settings.thresholds, "ram", resting);
  assert.equal(buried.ok, false);
  assert.match(buried.errors.join(" "), /critical must sit above red/);
  assert.equal(buried.thresholds, null, "a recommendation that would sit over his critical is refused, not applied and left invalid");

  const gentle = Memory.applyRecommendation(settings.thresholds, "ram", { amber: 85, red: 92, critical: 97 });
  assert.equal(gentle.ok, true);
  assert.equal(gentle.thresholds.ram.amber, 85);
  assert.equal(gentle.thresholds.ram.red, 92);
  assert.equal(gentle.thresholds.ram.critical, 96, "a recommendation never becomes a ceiling the captain did not set");
  assert.equal(gentle.thresholds.ram.criticalSetBy, "user");

  const fresh = Memory.applyRecommendation({}, "ram", { amber: 85, red: 92, critical: 97 });
  assert.equal(fresh.thresholds.ram.amber, 85);
  assert.equal(fresh.thresholds.ram.amberSetBy, "default");
  assert.equal(fresh.thresholds.ram.critical, null, "a recommendation never invents a critical line for him");
});

test("the onboarding prompt carries the readings as data and never a device name in an instruction", () => {
  const prompt = Memory.onboardingPrompt(RAM, OOMD, {});
  assert.match(prompt, /Memory Monitor first run\. Report what this machine is resting at, then ask for the ceilings\./);
  assert.match(prompt, /critical stays unset until he sets it/);
  assert.match(prompt, /Never set a ceiling yourself, and never write over one the user has set\./);
  assert.match(prompt, /swap is not a fourth threshold/);
  assert.equal(prompt.includes(Memory.dataOpen()) && prompt.includes(Memory.dataClose()), true);
  const block = prompt.slice(prompt.indexOf(Memory.dataOpen()), prompt.indexOf(Memory.dataClose()));
  assert.match(block, /"memTotalKb":65588588/);
});

test("the onboarding prompt's data block is the same block a hostile device cannot forge", () => {
  const prompt = Memory.onboardingPrompt(RAM, OOMD, {});
  assert.equal(prompt.split(Memory.dataOpen()).length - 1, 1, "the delimiter appears exactly once");
  assert.equal(prompt.split(Memory.dataClose()).length - 1, 1);
});

test("settings survive the round trip, and garbage does not become a ceiling", () => {
  const settings = Memory.normalizeSettings({
    thresholds: { ram: { amber: 70, red: 85, critical: 95 } },
    guard: false,
    guardAsked: true,
    ceilingsAsked: true,
    firstRunAt: "2026-11-02T00:00:00.000Z",
    guardAskId: "42",
    arms: [{ eventKey: "ram|3|ram|1", type: "ram", outcome: "started", pid: 7 }],
  });
  assert.equal(settings.thresholds.ram.critical, 95);
  assert.equal(settings.guard, false);
  assert.equal(settings.guardAsked, true);
  assert.equal(settings.ceilingsAsked, true);
  assert.equal(settings.guardAskId, "42");
  assert.equal(settings.arms.length, 1);
  assert.equal(settings.arms[0].pid, 7);

  const garbage = Memory.normalizeSettings({ thresholds: { ram: { amber: "hot", red: null, critical: 500 } } });
  assert.equal(garbage.thresholds.ram.amber, 80);
  assert.equal(garbage.thresholds.ram.red, 90);
  assert.equal(garbage.thresholds.ram.critical, null, "a garbage critical stays unset rather than becoming a ceiling");
});

test("the health-check prompt is fixed copy that reports before it asks", () => {
  const prompt = Memory.healthCheckPrompt("/log", { ram: { amber: 80, red: 90 } }, OOMD);
  assert.match(prompt, /Memory Monitor health check\./);
  assert.match(prompt, /Read the baseline log at \/log/);
  assert.match(prompt, /Do not change any setting, limit, or file yourself\./);
  assert.match(prompt, /Report first, then ask\./);
  assert.equal(prompt.includes(Memory.dataOpen()), true);
});

test("the memory-health skill exists, is analysis-only, and names the sibling's skill instead of competing with it", () => {
  const skill = repoFile("memory-monitor/skills/memory-health/SKILL.md");
  assert.match(skill, /^name: memory-health$/m);
  assert.match(skill, /Read-only analysis - never kill, throttle, delete, compress, or change any limit/);
  assert.match(skill, /MemAvailable/);
  assert.match(skill, /disk-prune/);
  assert.match(skill, /never as a process list you invented/);
});

test("a question is not an emergency: neither onboarding notice arms the guard", () => {
  assert.equal(Memory.isArmNotice({ kind: "ceilings", band: 3 }), false);
  assert.equal(Memory.isArmNotice({ kind: "guard-ask", band: 3 }), false);
  assert.equal(Memory.isArmNotice({ kind: "band", band: 3, type: "ram" }), true);
  assert.equal(Memory.isArmNotice({ kind: "band", band: 2, type: "ram" }), false);
});

test("the ceiling question's click opens the agent that reports the reading and asks for the numbers", () => {
  const argv = Memory.clickArgvFor({ kind: "ceilings", band: 3 }, null, { reading: RAM, oomd: OOMD, thresholds: {} });
  same(argv.slice(0, 3), ["omarchy", "agent", "prompt"]);
  assert.equal(argv.length, 4);
  assert.match(argv[3], /Memory Monitor first run\./);
  assert.equal(argv[3].includes("memTotalKb"), true);
  assert.equal(Memory.actionFor({ kind: "ceilings", band: 3 }), "Set my ceilings with agent");
});

test("the guard ask's click is the answer, delivered to the widget that owns the state file", () => {
  same(Memory.clickArgvFor({ kind: "guard-ask", band: 3 }, null, {}), ["qs", "ipc", "call", "memory-monitor", "answerGuardAsk"]);
  assert.equal(Memory.actionFor({ kind: "guard-ask", band: 3 }), "Turn the guard on");
});

test("an onboarding notice says its own piece instead of reading like a band toast", () => {
  const args = Memory.notifyArgs(
    { kind: "ceilings", band: 3, title: "Memory Monitor - your ceilings", body: "Measured now: ..." },
    null,
    { clickArgv: Memory.answerGuardAskArgv(), printId: true },
  );
  assert.equal(args[args.length - 2], "Memory Monitor - your ceilings");
  assert.equal(args[args.length - 1], "Measured now: ...");
  assert.equal(args.join(" ").includes("has reached"), false, "a question never claims a usage percent");
  assert.equal(args[args.indexOf("-u") + 1], "critical", "a notice that must be answered never expires and bypasses DND");
  assert.equal(args.includes("-t"), false);
  assert.equal(args.includes("-p"), true);
  assert.equal(Memory.notifyLaneFor({ kind: "ceilings", band: 1 }), "notice");
  assert.equal(Memory.bypassesDnd({ kind: "ceilings", band: 1 }), true);
});
