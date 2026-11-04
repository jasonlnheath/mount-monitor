// The guard: asked, claimed, budget-gated, single-flight, and retracted when it
// does not survive. The claim "an agent is guarding" is only ever emitted when an
// agent is guarding.
import test from "node:test";
import assert from "node:assert/strict";
import { Memory, qtList, same } from "./load.mjs";

const HEALTHY = { memAvailableKb: 8 * 1048576, psi: { some_avg10: 0.2 }, swapPct: 15 };
const OOMD = { oomdActive: true, oomdSwapLimitPct: 90 };

test("the guard is on unless the user says otherwise - the ask is an insist, not a suggestion", () => {
  assert.equal(Memory.normalizeSettings({}).guard, null, "unanswered is recorded as unanswered");
  assert.equal(Memory.normalizeBool(null, true), true, "an unanswered guard still arms: the plan's insist-guard");
  assert.equal(Memory.normalizeBool(false, true), false, "only an explicit no turns it off");
  assert.equal(Memory.shouldStartArm({ band: 3, guard: null }).start, true);
  assert.equal(Memory.shouldStartArm({ band: 3, guard: false }).start, false);
  assert.match(Memory.shouldStartArm({ band: 3, guard: false }).reason, /guard is off/);
});

test("the ask is the captain's copy, critical urgency, and never expires", () => {
  const args = Memory.guardAskArgs({ guard: null });
  assert.equal(args[0], "notify-send");
  assert.equal(args[args.indexOf("-u") + 1], "critical");
  assert.equal(args.includes("-t"), false, "a question that expires is a question that is never answered");
  assert.equal(args[args.indexOf("-A") + 1], "default:Turn the guard on");
  const hint = JSON.parse(args[args.indexOf("-h") + 1].slice("STRING:omarchy-exec-argv:".length));
  same(hint, ["qs", "ipc", "call", "memory-monitor", "answerGuardAsk"]);
  const body = args[args.length - 1];
  assert.match(body, /The guard is the agent that steps in when a critical line is crossed\./);
  assert.match(body, /It does guard: it runs when your critical threshold is reached\./);
  assert.match(body, /Turn it on\?$/);
  assert.match(Memory.guardAskBody({ guard: false }), /It is currently off\./);
});

test("a re-fired ask replaces the ask it answers instead of stacking one notice per shell restart", () => {
  const withId = Memory.guardAskReplaceArgs("17", { guard: null });
  assert.equal(withId[withId.indexOf("-r") + 1], "17");
  const without = Memory.guardAskReplaceArgs("", { guard: null });
  assert.equal(without.includes("-r"), false, "no captured id yet: send a fresh notice");
  assert.deepEqual(without.slice(0, 4), Memory.guardAskArgs({ guard: null }).slice(0, 4));
});

test("the arm is refused when the machine has no headroom for it", () => {
  const cost = Memory.guardArmCostKb();
  assert.ok(cost > 0, "the guard's cost is a named number, not a guess at launch time");
  const ok = Memory.armBudgetCheck(HEALTHY, OOMD);
  assert.equal(ok.ok, true);
  same(ok.reasons, []);

  const tight = Memory.armBudgetCheck({ memAvailableKb: cost - 1 }, OOMD);
  assert.equal(tight.ok, false);
  assert.match(tight.reasons.join(" "), /MemAvailable .* is below the guard's cost/);

  const unknown = Memory.armBudgetCheck({ memAvailableKb: null }, OOMD);
  assert.equal(unknown.ok, false);
  assert.match(unknown.reasons.join(" "), /unknown - the arm is refused rather than guessed at/);

  const stalling = Memory.armBudgetCheck(Object.assign({}, HEALTHY, { psi: { some_avg10: 40 } }), OOMD);
  assert.equal(stalling.ok, false);
  assert.match(stalling.reasons.join(" "), /PSI memory is already stalling/);

  const swapped = Memory.armBudgetCheck(Object.assign({}, HEALTHY, { swapPct: 95 }), OOMD);
  assert.equal(swapped.ok, false);
  assert.match(swapped.reasons.join(" "), /swap is past the kernel's swap limit \(90%\)/);
});

test("the arm is single-flight per machine", () => {
  assert.equal(Memory.shouldStartArm({ band: 3, guard: true, armLive: true }).start, false);
  assert.match(Memory.shouldStartArm({ band: 3, guard: true, armLive: true }).reason, /already live/);
  assert.equal(Memory.shouldStartArm({ band: 2, guard: true }).start, false, "only the critical band arms");
  assert.equal(Memory.shouldStartArm({ band: 3, guard: true, budgetOk: false }).start, false);
  assert.equal(Memory.shouldStartArm({ band: 3, guard: true, writer: false }).start, false, "one instance owns the arm");
  assert.equal(Memory.armIsLive({ outcome: "started" }), true);
  assert.equal(Memory.armIsLive({ outcome: "survived" }), false);
  assert.equal(Memory.armIsLive({ outcome: "refused" }), false);
});

test("the arm event identity is the event, not the wall clock", () => {
  const a = Memory.armEventKey({ type: "ram", band: 3, key: "ram", epoch: 4 });
  assert.equal(a, Memory.armEventKey({ type: "ram", band: 3, key: "ram", epoch: 4 }));
  assert.notEqual(a, Memory.armEventKey({ type: "ram", band: 3, key: "ram", epoch: 5 }));
  assert.notEqual(a, Memory.armEventKey({ type: "ram", band: 2, key: "ram", epoch: 4 }));
  assert.notEqual(a, Memory.armEventKey({ type: "hd", band: 3, key: "partuuid:x", epoch: 4 }));
});

test("the claim toast is critical, captures its id, and clicks to the detail window", () => {
  const args = Memory.claimArgs("Memory Monitor", "body");
  assert.equal(args[args.indexOf("-u") + 1], "critical");
  assert.equal(args.includes("-p"), true, "the claim's id is captured so a dead guard can retract it");
  assert.equal(args[args.indexOf("-A") + 1], "default:Open Memory Monitor");
  same(JSON.parse(args[args.indexOf("-h") + 1].slice("STRING:omarchy-exec-argv:".length)), ["qs", "ipc", "call", "memory-monitor", "openDetail"]);
});

test("the critical copy states the guard state the guard is actually in", () => {
  assert.equal(Memory.guardStateFor({ guard: false }), "off");
  assert.equal(Memory.guardStateFor({ guard: true, budgetOk: false }), "refused");
  assert.equal(Memory.guardStateFor({ guard: true, budgetOk: true, armDied: true }), "died");
  assert.equal(Memory.guardStateFor({ guard: true, budgetOk: true }), "armed");
  assert.equal(Memory.guardStateFor({}), "armed", "unanswered still means armed");
});

test("a dead guard retracts its claim by the captured id", () => {
  const died = Memory.retractClaimFor({ outcome: "died", claimId: "99", pct: 98 });
  assert.equal(died.replaceable, true);
  assert.equal(died.args[died.args.indexOf("-r") + 1], "99");
  assert.match(died.args[died.args.length - 1], /The guard did not survive/);

  const noId = Memory.retractClaimFor({ outcome: "died", type: "ram", key: "ram", id: Memory.memId("ram"), claimId: "", pct: 98 });
  assert.equal(noId.replaceable, false);
  assert.equal(noId.args.includes("-r"), false, "nothing to replace: the widget sends a fresh notice");
  assert.equal(noId.args[0], "notify-send", "the fresh notice is memory.js's argv, not one the widget builds");
  assert.match(noId.args[noId.args.length - 1], /The guard did not survive/);
  assert.match(Memory.degradationText("claim-unretractable"), /could not be retracted/);

  assert.equal(Memory.retractClaimFor({ outcome: "survived", claimId: "99" }), null);
  assert.equal(Memory.retractClaimFor({ outcome: "started", claimId: "99" }), null);
});

test("an arm record is written the same way every time", () => {
  const record = Memory.armRecord({
    eventKey: "ram|3|ram|1",
    type: "ram",
    band: 3,
    outcome: "who knows",
    pid: 4242,
    survived: true,
    claimId: "77",
    reasons: qtList(["one reason"]),
    inline: true,
  });
  assert.equal(record.outcome, "skipped", "an unknown outcome is recorded as skipped, never as a success");
  assert.equal(record.pid, 4242);
  assert.equal(record.survived, true);
  assert.equal(record.claimId, "77");
  same(record.reasons, ["one reason"]);
  assert.equal(record.inline, true);
});

test("the guard state is stated in the detail window in words", () => {
  assert.match(Memory.guardStateText({ guard: null }), /arms anyway when your critical line is crossed/);
  assert.match(Memory.guardStateText({ guard: false }), /off/);
});

test("an arm record carries what a retraction needs, so a restart can act on the file alone", () => {
  const started = Memory.armRecord({
    eventKey: "ram|3|ram|1",
    type: "ram",
    band: 3,
    key: "ram",
    id: Memory.memId("ram"),
    pct: 97.2,
    target: null,
    outcome: "started",
    startedAt: "2026-11-04T00:00:00.000Z",
    claimId: "",
  });
  assert.equal(started.outcome, "started");
  assert.equal(started.key, "ram");
  assert.equal(started.id, Memory.memId("ram"));
  assert.equal(started.pct, 97.2);

  const died = Memory.armRecord(Object.assign({}, started, {
    outcome: "died",
    survived: false,
    endedAt: "2026-11-04T00:02:00.000Z",
    reasons: ["orphaned by a shell restart"],
  }));
  const plan = Memory.retractClaimFor(died);
  assert.equal(plan.replaceable, false, "the captured id died with the shell: a fresh honest toast, not a replace");
  assert.equal(plan.args[0], "notify-send");
  const body = plan.args[plan.args.length - 1];
  assert.match(body, /The guard did not survive/);
  assert.match(body, /has reached 98% usage/, "the fresh toast carries the record's own reading, rounded up");
});

test("a restart reconciles an orphaned arm from the file alone, once, and never the arm it is running", () => {
  const survived = Memory.armRecord({ eventKey: "ram|3|ram|1", type: "ram", band: 3, outcome: "survived", survived: true });
  const orphan = Memory.armRecord({
    eventKey: "hd|3|partuuid:x|1",
    type: "hd",
    band: 3,
    key: "partuuid:x",
    id: Memory.memId("partuuid:x"),
    pct: 96.4,
    target: "/data",
    outcome: "started",
    startedAt: "2026-11-03T00:00:00.000Z",
    claimId: "",
  });
  const live = Memory.armRecord({
    eventKey: "ram|3|ram|2",
    type: "ram",
    band: 3,
    key: "ram",
    id: Memory.memId("ram"),
    pct: 97.2,
    outcome: "started",
    startedAt: "2026-11-04T00:00:00.000Z",
  });

  const plan = Memory.reconcileArms([survived, orphan, live], live.eventKey);
  assert.notEqual(plan, null);
  assert.equal(plan.arms[0].outcome, "survived");
  assert.equal(plan.arms[1].outcome, "died", "the orphaned record is marked died in place, not appended");
  assert.equal(plan.arms[2].outcome, "started", "the arm this generation is running is never its own orphan");
  assert.equal(plan.retract.eventKey, "hd|3|partuuid:x|1", "the retraction is built from the persisted record");
  assert.match(plan.retract.reasons.join(" "), /shell restarted/);

  const args = Memory.retractClaimFor(plan.retract).args;
  assert.equal(args[0], "notify-send", "a restart acts on the file alone");
  assert.match(args[args.length - 1], /has reached 97% usage/);

  assert.equal(Memory.reconcileArms(plan.arms, live.eventKey), null, "reconciliation is exactly once");
  assert.equal(Memory.reconcileArms([live], live.eventKey), null, "a live arm's own record is skipped");
  assert.equal(Memory.reconcileArms([orphan], orphan.eventKey), null);
  assert.equal(Memory.reconcileArms([], ""), null);
  assert.equal(Memory.reconcileArms(null, ""), null);
  const noLive = Memory.reconcileArms([survived, orphan], "");
  assert.equal(noLive.arms[0].outcome, "survived");
  assert.equal(noLive.arms[1].outcome, "died", "no live arm: a persisted started record is the orphan");

  const beyond = [];
  for (let i = 0; i < 6; i++) {
    beyond.push(Memory.armRecord({ eventKey: "ram|3|ram|" + i, type: "ram", band: 3, outcome: "started" }));
  }
  const old = Memory.reconcileArms(beyond, "");
  assert.equal(old.arms[0].outcome, "started", "a record outside the newest-five window waits for a later generation");
  assert.equal(old.arms[5].outcome, "died", "the newest orphan is the one reconciled");
});

test("a started record with a terminal successor is a finished arm, not an orphan", () => {
  const started = Memory.armRecord({
    eventKey: "ram|3|ram|4",
    type: "ram",
    band: 3,
    key: "ram",
    id: Memory.memId("ram"),
    pct: 97.2,
    outcome: "started",
    startedAt: "2026-11-03T00:00:00.000Z",
    claimId: "",
  });
  const survived = Memory.armRecord(Object.assign({}, started, {
    outcome: "survived",
    survived: true,
    endedAt: "2026-11-03T00:05:00.000Z",
    claimId: "77",
  }));
  const died = Memory.armRecord(Object.assign({}, started, {
    outcome: "died",
    survived: false,
    endedAt: "2026-11-03T00:05:00.000Z",
  }));
  const refused = Memory.armRecord(Object.assign({}, started, { outcome: "refused" }));

  assert.equal(Memory.reconcileArms([started, survived], ""), null,
    "a completed arm's own start is history: no false death, no false never-expiring toast");
  assert.equal(Memory.reconcileArms([started, died], ""), null,
    "a death announced when the arm finished is not re-announced by the next generation");
  assert.equal(Memory.reconcileArms([started, refused], ""), null);

  const orphan = Memory.armRecord({
    eventKey: "vram|3|vram|9",
    type: "vram",
    band: 3,
    key: "vram",
    id: Memory.memId("vram"),
    pct: 96.0,
    outcome: "started",
    startedAt: "2026-11-02T00:00:00.000Z",
  });
  const plan = Memory.reconcileArms([orphan, started, survived], "");
  assert.notEqual(plan, null);
  assert.equal(plan.arms[0].outcome, "died", "a genuine orphan behind a finished pair is still found");
  assert.equal(plan.arms[1].outcome, "started", "the finished arm's start record stays as history");
  assert.equal(plan.arms[2].outcome, "survived");
  assert.equal(plan.retract.eventKey, "vram|3|vram|9");
});

test("the arm timeout is a named number", () => {
  assert.ok(Memory.guardArmTimeoutMs() > 0);
  assert.ok(Memory.guardArmTimeoutMs() < 10 * 60 * 1000);
});
