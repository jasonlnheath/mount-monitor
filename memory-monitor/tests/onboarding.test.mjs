// Onboarding: report what the machine actually rests at, recommend from that,
// ask for the ceilings, and ask the guard question. A recommendation is never a
// ceiling, and a critical line never exists until the captain sets it.
import test from "node:test";
import assert from "node:assert/strict";
import { Memory, repoFile, same } from "./load.mjs";

const RAM = {
  pct: 97.95,
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

test("the state lives in its own directory, and deleting it is the reset hook", () => {
  assert.equal(Memory.stateDir("/home/jason"), "/home/jason/.local/state/memory-monitor");
  assert.equal(Memory.settingsPath("/home/jason"), "/home/jason/.local/state/memory-monitor/settings.json");
  assert.equal(Memory.logPath("/home/jason"), "/home/jason/.local/state/memory-monitor/baseline.log");
});

test("the ceiling question reports the reading before it asks anything", () => {
  const text = Memory.ceilingsQuestion("ram", RAM, OOMD, {}, { ram: 12 });
  const lines = text.split("\n");
  assert.match(lines[0], /^Quattro Dash - System RAM ceilings$/);
  assert.match(lines[1], /^Measured now: RAM PRESSURE 0\.2 PSI, swap 15% used, .* free of .*$/);
  assert.match(lines[2], /Your amber: 70 PSI \(default\)\. Your red: 90 PSI \(default\)\./);
  assert.match(lines[3], /^Your critical: not set - you have no ceiling, and no critical alert can fire\.$/);
  assert.match(lines[4], /^The kernel's ceiling: oomd at PSI 50% for 20s, or swap at 90%, watching \/user\.slice/);
  assert.match(lines[5], /^Recommended from this machine: amber 14 PSI, red 19 PSI, critical 22 PSI\.$/);
  assert.match(lines[6], /^This machine rests at 12 PSI, which is inside your amber line\.$/);
});

test("a ceiling the user set is reported as his, with its number", () => {
  const settings = Memory.setCeiling(Memory.setCeiling({}, "ram", "critical", 96), "ram", "amber", 70);
  const text = Memory.ceilingsQuestion("ram", RAM, OOMD, settings.thresholds, { ram: 12 });
  assert.match(text, /Your amber: 70 PSI \(you set it\)/);
  assert.match(text, /Your critical: 96 PSI \(you set it\)\./);
  assert.equal(text.includes("not set - you have no ceiling"), false);
});

test("no oomd is stated as no kernel ceiling, not as a zero", () => {
  const text = Memory.ceilingsQuestion("ram", RAM, { oomdActive: false }, {}, null);
  assert.match(text, /The kernel's ceiling: systemd-oomd is not active - no kernel ceiling is in force/);
});

test("the resting claim is measured from the log, and withheld until the log holds 48 samples", () => {
  assert.equal(Memory.RESTING_MIN_SAMPLES, 48);
  const sample = psi => Memory.logLine(Memory.logRecord({ at: "2026-11-04T00:00:00.000Z", ram: { pct: 40, psiSomeAvg10: psi } }));
  const short = Array.from({ length: Memory.RESTING_MIN_SAMPLES - 1 }, () => sample(12)).join("\n");
  const full = Array.from({ length: Memory.RESTING_MIN_SAMPLES }, () => sample(12)).join("\n");

  const withheld = Memory.restingFromLog(short);
  assert.equal(withheld.ram, null, "47 samples say nothing about where this machine rests");
  assert.equal(withheld.vram, null);
  assert.equal(withheld.hd, null);
  const measured = Memory.restingFromLog(full);
  assert.equal(measured.ram, 12, "the median of the log's own PSI distribution, never the live reading");

  const question = Memory.ceilingsQuestion("ram", RAM, OOMD, {}, withheld);
  assert.match(
    question,
    /No resting claim yet - the baseline log needs 48 samples before this machine's resting level is known\./,
  );
  assert.equal(question.includes("rests at"), false, "the live reading never becomes a resting claim");

  const answered = Memory.ceilingsQuestion("ram", RAM, OOMD, {}, measured);
  assert.match(answered, /^This machine rests at 12 PSI, which is inside your amber line\.$/m);
  assert.equal(answered.includes("No resting claim yet"), false);
});

test("an unmeasured machine is recommended the documented defaults, never 'from this machine'", () => {
  const unmeasured = Memory.ceilingsQuestion("ram", RAM, OOMD, {}, null);
  assert.match(unmeasured, /Recommended defaults until measured: amber 70 PSI, red 90 PSI, critical unset\./);
  assert.equal(unmeasured.includes("from this machine"), false, "an unmeasured machine claims no provenance");
  const rec = Memory.recommendCeilings("ram", null);
  assert.ok(rec.amber < rec.red, "the provisional pair is never amber above red");

  const measured = Memory.ceilingsQuestion("ram", RAM, OOMD, {}, { ram: 12 });
  assert.match(measured, /^Recommended from this machine: amber 14 PSI, red 19 PSI, critical 22 PSI\.$/m);
  assert.equal(measured.includes("Recommended defaults until measured"), false);
});

test("a recommendation is a recommendation: derived from the resting reading, capped, and marked provisional without one", () => {
  const rec = Memory.recommendCeilings("ram", { ram: 12 });
  assert.equal(rec.restingPct, 12);
  assert.equal(rec.provisional, false);
  assert.ok(rec.amber > rec.restingPct, "a recommendation that sits under the resting reading would alert forever");
  assert.ok(rec.critical <= 99);
  const none = Memory.recommendCeilings("ram", null);
  assert.equal(none.provisional, true);
  assert.equal(none.restingPct, null);
});

test("the onboarding prompt carries the readings as data and never a device name in an instruction", () => {
  const prompt = Memory.onboardingPrompt(RAM, OOMD, {}, "/log", { ram: 12 });
  assert.match(prompt, /Quattro Dash first run\. Report what this machine is resting at, then ask for the ceilings\./);
  assert.match(prompt, /critical stays unset until he sets it/);
  assert.match(prompt, /Never set a ceiling yourself, and never write over one the user has set\./);
  assert.match(prompt, /swap is not a fourth threshold/);
  assert.equal(prompt.includes(Memory.dataOpen()) && prompt.includes(Memory.dataClose()), true);
  const block = prompt.slice(prompt.indexOf(Memory.dataOpen()), prompt.indexOf(Memory.dataClose()));
  assert.match(block, /"memTotalKb":65588588/);
});

test("the onboarding prompt's data block is the same block a hostile device cannot forge", () => {
  const prompt = Memory.onboardingPrompt(RAM, OOMD, {}, "/log", null);
  assert.equal(prompt.split(Memory.dataOpen()).length - 1, 1, "the delimiter appears exactly once");
  assert.equal(prompt.split(Memory.dataClose()).length - 1, 1);
});

test("the ceilings click-through prompt is honest about what the log can say", () => {
  const withheld = Memory.onboardingPrompt(RAM, OOMD, {}, "/log", null);
  assert.match(withheld, /Read the baseline log at \/log/);
  assert.match(withheld, /no resting claim yet/);
  assert.equal(withheld.includes("This machine rests at"), false, "a single reading is never a resting claim");
  assert.match(withheld, /no ceiling recommendation derived from a single reading/);
  assert.match(withheld, /recommend the defaults and say plainly they are defaults/);

  const measured = Memory.onboardingPrompt(RAM, OOMD, {}, "/log", { ram: 12 });
  assert.match(measured, /Read the baseline log at \/log/);
  assert.match(measured, /This machine rests at 12 PSI\./);
  assert.match(measured, /derived from that resting distribution/);
  assert.equal(measured.includes("no resting claim yet"), false);
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
  assert.equal(garbage.thresholds.ram.amber, 70);
  assert.equal(garbage.thresholds.ram.red, 90);
  assert.equal(garbage.thresholds.ram.critical, null, "a garbage critical stays unset rather than becoming a ceiling");
});

test("the held band rides the state file, so a restart knows what the machine was sitting in", () => {
  const key = "partuuid:a02330f1-304d-459b-8274-e52ab1cf11ba";
  const settings = Memory.normalizeSettings({ bands: { ram: 2, vram: 1, [key]: 3 } });
  assert.equal(settings.bands.ram, 2);
  assert.equal(settings.bands.vram, 1);
  assert.equal(settings.bands[key], 3);

  const garbage = Memory.normalizeSettings({ bands: { ram: 9, [key]: 0, "": 2, "not a number": "hot" } });
  assert.equal(garbage.bands.ram, 3, "a band is 0..3, never more");
  assert.equal(garbage.bands[key], undefined, "band 0 is not a held band and stores nothing");
  assert.equal(garbage.bands[""], undefined, "an unnamed key stores nothing");
  assert.equal(garbage.bands["not a number"], undefined, "a value that is not a number stores nothing");

  same(Memory.normalizeSettings({}).bands, {});
  same(Memory.normalizeSettings({ bands: "not a map" }).bands, {});
});

test("a question already queued or already on the screen is not asked again", () => {
  const ceilings = { kind: "ceilings", key: "ceilings", band: 3 };
  const guardAsk = { kind: "guard-ask", key: "guard-ask", band: 3 };
  assert.equal(Memory.onboardingNoticePending([ceilings], null, "ceilings"), true);
  assert.equal(Memory.onboardingNoticePending([], ceilings, "ceilings"), true, "the live notice counts too");
  assert.equal(Memory.onboardingNoticePending([guardAsk], ceilings, "ceilings"), true);
  assert.equal(Memory.onboardingNoticePending([guardAsk], null, "ceilings"), false, "the other question does not stand in");
  assert.equal(Memory.onboardingNoticePending([], null, "ceilings"), false, "nothing pending is an ask that may be sent");
  assert.equal(Memory.onboardingNoticePending([ceilings], null, ""), false, "no kind names no ask");
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
  const argv = Memory.clickArgvFor({ kind: "ceilings", band: 3 }, null, { reading: RAM, oomd: OOMD, thresholds: {}, logPath: "/log", resting: null });
  same(argv.slice(0, 3), ["omarchy", "agent", "prompt"]);
  assert.equal(argv.length, 4);
  assert.match(argv[3], /Quattro Dash first run\./);
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
  assert.equal(args[args.length - 2], "Quattro Dash - your ceilings");
  assert.equal(args[args.length - 1], "Measured now: ...");
  assert.equal(args.join(" ").includes("has reached"), false, "a question never claims a usage percent");
  assert.equal(args[args.indexOf("-u") + 1], "critical", "a notice that must be answered never expires and bypasses DND");
  assert.equal(args.includes("-t"), false);
  assert.equal(args.includes("-p"), true);
  assert.equal(Memory.notifyLaneFor({ kind: "ceilings", band: 1 }), "notice");
  assert.equal(Memory.bypassesDnd({ kind: "ceilings", band: 1 }), true);
});
