// Toast copy is the captain's copy, pinned verbatim. Urgency and timeout are
// what make a red survive the shell's Do Not Disturb routing, and the click argv
// is what makes it clickable after a shell restart.
import test from "node:test";
import assert from "node:assert/strict";
import { Memory, qtList, same } from "./load.mjs";

function ramAlert(band, pct) {
  return { type: "ram", key: "ram", id: Memory.memId("ram"), band, pct, target: null, device: null };
}

test("the amber copy is the spec's copy for each resource type", () => {
  same(
    Memory.amberBody({ type: "hd", pct: 82 }).split("\n"),
    ["Caution: Amber Alert", "Device (Hard drive) has reached 82% usage.", "Click to address with agent, otherwise ignore."],
  );
  same(
    Memory.amberBody({ type: "vram", pct: 82 }).split("\n"),
    ["Caution: Amber Alert", "Device (VRAM) has reached 82% usage.", "Click to address with agent, otherwise ignore."],
  );
  same(
    Memory.amberBody({ type: "ram", pct: 82 }).split("\n"),
    ["Caution: Amber Alert", "Device (System Ram) has reached 82% usage.", "Click to address with agent, otherwise ignore."],
  );
});

test("the red copy is the spec's copy, and its type word is capitalised as the spec writes it", () => {
  same(
    Memory.redBody({ type: "ram", pct: 91 }).split("\n"),
    [
      "WARNING: RED ALERT",
      "Device (System RAM) has reached 91% usage.",
      "Click to open an agent to actively monitor/guard against OOM, otherwise ignore.",
    ],
  );
  same(
    Memory.redBody({ type: "hd", pct: 91 }).split("\n"),
    [
      "WARNING: RED ALERT",
      "Device (Hard drive) has reached 91% usage.",
      "Click to open an agent to actively monitor/guard against OOM, otherwise ignore.",
    ],
  );
  same(
    Memory.redBody({ type: "vram", pct: 91 }).split("\n"),
    [
      "WARNING: RED ALERT",
      "Device (VRAM) has reached 91% usage.",
      "Click to open an agent to actively monitor/guard against OOM, otherwise ignore.",
    ],
  );
});

test("XX% is the live reading rounded up, never the threshold that fired", () => {
  // Crossed 90% at a reading of 90.01%: the toast says 91%, not 90%.
  assert.match(Memory.redBody({ type: "ram", pct: 90.01 }), /has reached 91% usage/);
  assert.match(Memory.amberBody({ type: "ram", pct: 80.4 }), /has reached 81% usage/);
  assert.match(Memory.criticalBody({ pct: 97.2, guardState: "armed" }), /has reached 98% usage/);
  assert.match(Memory.redBody({ type: "ram", pct: 91.0 }), /has reached 91% usage/);
});

test("the critical copy names the guard state it is actually in", () => {
  assert.match(Memory.criticalBody({ pct: 98, guardState: "armed" }), /Agent has been notified and is guarding against OOM\./);
  assert.match(Memory.criticalBody({ pct: 98, guardState: "off" }), /The standing guard is off\. Click to open Memory Monitor, otherwise ignore\./);
  assert.match(Memory.criticalBody({ pct: 98, guardState: "refused" }), /The guard could not start\. Click to open Memory Monitor, otherwise ignore\./);
  assert.match(Memory.criticalBody({ pct: 98, guardState: "died" }), /The guard did not survive\. Click to open Memory Monitor, otherwise ignore\./);
  // An unknown state never produces the claim sentence.
  const fallback = Memory.criticalBody({ pct: 98, guardState: "who knows" });
  assert.equal(fallback.includes("has been notified"), false);
  assert.match(fallback, /The guard could not start/);
});

test("only an armed guard emits the claim", () => {
  for (const state of Memory.criticalGuardStates()) {
    const body = Memory.criticalBody({ pct: 98, guardState: state });
    const claims = body.includes("has been notified and is guarding");
    assert.equal(claims, state === "armed", state);
  }
});

test("red and critical are critical urgency; amber is normal", () => {
  assert.equal(Memory.urgencyFor(ramAlert(1, 82)), "normal");
  assert.equal(Memory.urgencyFor(ramAlert(2, 91)), "critical");
  assert.equal(Memory.urgencyFor(ramAlert(3, 98)), "critical");
});

test("a never-expiring alert goes to the notice lane, so it cannot hold the alert queue shut", () => {
  assert.equal(Memory.notifyLaneFor(ramAlert(1, 82)), "alert");
  assert.equal(Memory.notifyLaneFor(ramAlert(2, 91)), "notice");
  assert.equal(Memory.notifyLaneFor(ramAlert(3, 98)), "notice");
  assert.equal(Memory.timeoutFor(ramAlert(1, 82)), 20000);
  assert.equal(Memory.timeoutFor(ramAlert(2, 91)), 0);
  assert.equal(Memory.timeoutFor(ramAlert(3, 98)), 0);
});

test("escalation displaces the live notice instead of queueing behind it", () => {
  const red = ramAlert(2, 91);
  const critical = ramAlert(3, 98);
  const ceilings = { kind: "ceilings", band: 3, key: "ceilings" };
  assert.equal(Memory.noticeSeverity(red), 2);
  assert.equal(Memory.noticeSeverity(critical), 3);
  assert.equal(Memory.noticeSeverity(ceilings), 0, "a question sits below every alert");

  assert.equal(Memory.displacesLiveNotice(critical, red), true, "critical displaces a live red");
  assert.equal(Memory.displacesLiveNotice(red, ceilings), true, "red displaces a live question");
  assert.equal(Memory.displacesLiveNotice(red, red), false);
  assert.equal(Memory.displacesLiveNotice(critical, critical), false, "the live claim of an armed guard is never displaced");
  assert.equal(Memory.displacesLiveNotice(critical, null), false);
  assert.equal(Memory.displacesLiveNotice(null, red), false, "nothing comes from nothing");

  assert.equal(Memory.supersedesQueuedNotice(critical, red), true, "a queued red superseded by a critical is dropped");
  assert.equal(Memory.supersedesQueuedNotice(critical, ceilings), false, "a queued question survives the emergency and is answered after it");
  assert.equal(Memory.supersedesQueuedNotice(red, red), false);
  assert.equal(Memory.supersedesQueuedNotice(critical, null), false);
});

test("every notice-lane send prints its id, so an escalation can replace the live notice by it", () => {
  const red = Memory.notifyArgs(ramAlert(2, 91), null, { printId: true });
  assert.equal(red.includes("-p"), true, "a red toast is replaceable by the critical that displaces it");
  const critical = Memory.notifyArgs(ramAlert(3, 98), null, { clickArgv: Memory.ipcOpenDetailArgv(), printId: true });
  assert.equal(critical.includes("-p"), true, "the claim's id is what a later generation retracts");
  const ask = Memory.notifyArgs({ kind: "guard-ask", band: 3 }, null, { printId: true });
  assert.equal(ask.includes("-p"), true, "a displaced question is replaced by the ask that follows it");
  const amber = Memory.notifyArgs(ramAlert(1, 82), null, { printId: true });
  assert.equal(amber.includes("-p"), false, "the amber lane has nothing to displace and no claim to retract");
  const replace = Memory.notifyArgs(ramAlert(3, 98), null, { printId: true, replaceId: "47" });
  assert.equal(replace[replace.indexOf("-r") + 1], "47", "the displacing notice carries the live id it replaces");
});

test("amber is silenced by DND, red is not", () => {
  assert.equal(Memory.deliveryVerdict(ramAlert(1, 82), true), "silenced-dnd");
  assert.equal(Memory.deliveryVerdict(ramAlert(2, 91), true), "shown");
  assert.equal(Memory.deliveryVerdict(ramAlert(3, 98), true), "shown");
  assert.equal(Memory.deliveryVerdict(ramAlert(1, 82), false), "shown");
  assert.equal(Memory.deliveryVerdict(ramAlert(1, 82), null), "unknown", "an unreadable DND setting is not assumed");
  assert.equal(Memory.bypassesDnd(ramAlert(2, 91)), true);
  assert.equal(Memory.bypassesDnd(ramAlert(1, 82)), false);
});

test("a silenced amber is recorded, not lost", () => {
  const events = [
    { type: "ram", band: 1, pct: 82, delivered: "silenced-dnd" },
    { type: "hd", band: 2, pct: 91, delivered: "shown" },
    { type: "ram", band: 2, pct: 93, delivered: "silenced-dnd" },
  ];
  const silenced = Memory.silencedAlerts(events);
  assert.equal(silenced.length, 2);
  const text = Memory.alertsYouDidNotSeeText(events);
  assert.match(text, /Do Not Disturb/);
  assert.match(text, /System RAM|System Ram/);
});

test("the unseen ring keeps the newest twenty, in order, without touching its input", () => {
  assert.equal(Memory.unseenAlertsMax(), 20);
  const original = [{ pct: 1 }, { pct: 2 }];
  const copy = JSON.parse(JSON.stringify(original));
  const grown = Memory.pushUnseenAlerts(original, { pct: 3 });
  same(original, copy, "the caller's list is not mutated");
  same(grown, [{ pct: 1 }, { pct: 2 }, { pct: 3 }], "each new alert appends at the end");
  same(Memory.pushUnseenAlerts(null, { pct: 4 }), [{ pct: 4 }], "no list yet is an empty ring, not a crash");

  let ring = [];
  const pushed = [];
  for (let i = 0; i < Memory.unseenAlertsMax() + 3; i++) {
    const event = { pct: 80 + i };
    pushed.push(event);
    ring = Memory.pushUnseenAlerts(ring, event);
    assert.equal(ring.length, Math.min(i + 1, Memory.unseenAlertsMax()));
  }
  assert.equal(ring.length, Memory.unseenAlertsMax(), "the cap holds no matter how many alerts arrive");
  same(ring[0], pushed[3], "the oldest fell off, never the newest");
  same(ring[ring.length - 1], pushed[pushed.length - 1], "the newest is last");
});

test("the notify-send argv is typed, carries the app name, and carries the click hint", () => {
  const argv = Memory.notifyArgs(ramAlert(2, 91), null, {
    clickArgv: Memory.ipcOpenDetailArgv(),
    logPath: "/home/jason/.local/state/memory-monitor/baseline.log",
  });
  assert.equal(argv[0], "notify-send");
  assert.equal(argv[1], "-a");
  assert.equal(argv[2], "Memory Monitor");
  assert.equal(argv.includes("-e"), true);
  assert.equal(argv[argv.indexOf("-u") + 1], "critical");
  assert.equal(argv.includes("-t"), false, "a critical alert never carries a timeout");
  assert.equal(argv[argv.indexOf("-A") + 1], "default:Open guarding agent");
  const hint = argv[argv.indexOf("-h") + 1];
  assert.match(hint, /^STRING:omarchy-exec-argv:/);
  same(JSON.parse(hint.slice("STRING:omarchy-exec-argv:".length)), ["qs", "ipc", "call", "memory-monitor", "openDetail"]);
  assert.equal(argv[argv.length - 2], "Memory Monitor");
  assert.match(argv[argv.length - 1], /^WARNING: RED ALERT/);
});

test("an amber carries a bounded timeout so it cannot hold the queue", () => {
  const argv = Memory.notifyArgs(ramAlert(1, 82), null, { clickArgv: ["omarchy", "agent", "prompt", "p"] });
  assert.equal(argv[argv.indexOf("-u") + 1], "normal");
  assert.equal(argv[argv.indexOf("-t") + 1], "20000");
  assert.equal(argv[argv.indexOf("-A") + 1], "default:Address with agent");
});

test("critical's click opens the detail window, never a second agent on top of the guard", () => {
  same(Memory.ipcOpenDetailArgv(), ["qs", "ipc", "call", "memory-monitor", "openDetail"]);
  same(Memory.clickArgvFor(ramAlert(3, 98), null, {}), ["qs", "ipc", "call", "memory-monitor", "openDetail"]);
  assert.equal(Memory.actionFor(ramAlert(3, 98)), "Open Memory Monitor");
});

test("amber and red clicks run the agent prompt as one typed argument", () => {
  const argv = Memory.clickArgvFor(ramAlert(2, 91), null, { logPath: "/log" });
  same(argv.slice(0, 3), ["omarchy", "agent", "prompt"]);
  assert.equal(argv.length, 4, "the whole prompt is one argument, never a shell string");
  assert.equal(argv[3].includes("\n"), true, "a multi-line prompt stays one argument");
  assert.equal(argv[3].includes("&&"), false, "no shell operator is smuggled into the prompt either");
});

test("a configured agentCommand replaces the default and the prompt is still one argument", () => {
  const argv = Memory.clickArgvFor(ramAlert(2, 91), qtList(["my-agent", "--ask"]), { logPath: "/log" });
  same(argv.slice(0, 2), ["my-agent", "--ask"]);
  assert.equal(argv.length, 3);
  assert.equal(argv[2].includes("Memory Monitor reports"), true);
  assert.equal(Memory.clickArgvFor(ramAlert(2, 91), qtList([]), { logPath: "/log" })[0], "omarchy", "an empty override is not an override");
});

test("the exec hint sends nothing the notification service's own validator would refuse", () => {
  assert.equal(Memory.execHintValue(["-rm", "-rf", "/"]), "", "a program with a leading dash is refused");
  assert.equal(Memory.execHintValue([]), "");
  assert.equal(Memory.execHintValue(null), "");
  same(JSON.parse(Memory.execHintValue(["qs", "ipc", "call", "memory-monitor", "openDetail"])), ["qs", "ipc", "call", "memory-monitor", "openDetail"]);
});

test("a replacement notice carries the id of the notice it answers, and the click its copy promises", () => {
  const args = Memory.notifyReplaceArgs("42", "Memory Monitor", "body", {
    clickArgv: Memory.ipcOpenDetailArgv(),
    action: Memory.actionFor({ kind: "alert", band: 3 }),
  });
  same(args.slice(0, 7), ["notify-send", "-a", "Memory Monitor", "-e", "-r", "42", "-u"]);
  assert.equal(args[args.indexOf("-u") + 1], "critical");
  assert.equal(args[args.indexOf("-A") + 1], "default:Open Memory Monitor");
  const hint = args[args.indexOf("-h") + 1];
  assert.match(hint, /^STRING:omarchy-exec-argv:/);
  same(JSON.parse(hint.slice("STRING:omarchy-exec-argv:".length)), ["qs", "ipc", "call", "memory-monitor", "openDetail"]);
  assert.equal(args[args.length - 2], "Memory Monitor");
  assert.equal(args[args.length - 1], "body");
  assert.equal(Memory.notifyReplaceArgs("", "t", "b", {}), null, "no id, no replacement - the caller sends a fresh notice");

  const refused = Memory.notifyReplaceArgs("42", "t", "b", { clickArgv: ["-rm", "-rf", "/"], action: "Open" });
  assert.equal(refused.includes("-h"), false, "a program the notification service would refuse is not sent as a hint");
  assert.equal(refused[refused.indexOf("-A") + 1], "default:Open", "the live action stays");
});

test("the printed id is parsed from notify-send's output as it arrives", () => {
  assert.equal(Memory.parsePrintedId("12\n"), "12");
  assert.equal(Memory.parsePrintedId("notify-send: nothing\n"), "", "a non-numeric line is not an id");
  assert.equal(Memory.parsePrintedId(""), "");
});

test("the DND setting is read from the notification service's own file", () => {
  assert.equal(Memory.dndStatePath("/home/jason"), "/home/jason/.local/state/omarchy/notifications.json");
  assert.equal(Memory.parseDnd('{"dnd":true}'), true);
  assert.equal(Memory.parseDnd('{"dnd":false}'), false);
  assert.equal(Memory.parseDnd("not json"), null);
  assert.equal(Memory.parseDnd(""), null);
});
