// Delegation guards. The rest of the suite tests the decisions in memory.js;
// these tests only check that the widget actually asks memory.js and RingKit for
// them instead of inventing its own, and that the wiring a headless test cannot
// exercise is at least shaped correctly. A widget that builds its own findmnt
// command, its own prompt sentence, or its own device name is a widget that has
// quietly stopped being a monitor of one decision kernel.
import test from "node:test";
import assert from "node:assert/strict";
import { Memory, RingKit, repoFile, same } from "./load.mjs";

const QML = repoFile("memory-monitor/MemoryMonitor.qml");
const PANEL = repoFile("memory-monitor/MemoryPanel.qml");
const MANIFEST = JSON.parse(repoFile("memory-monitor/manifest.json"));
const INSTALL = repoFile("memory-monitor/install.sh");

test("the widget builds its read commands through Memory.*, and none of them carries a configured value", () => {
  for (const call of [
    "Memory.meminfoArgs()",
    "Memory.psiArgs()",
    "Memory.swapsArgs()",
    "Memory.zramctlArgs()",
    "Memory.findmntArgs()",
    "Memory.nvidiaGpuArgs()",
    "Memory.nvidiaAppsArgs()",
    "Memory.oomctlArgs()",
    "Memory.oomdActiveArgs()",
  ]) {
    assert.equal(QML.includes(call), true, `MemoryMonitor.qml must build its reads through ${call}`);
  }
  // The argvs themselves: fixed programs from a closed list, no user-supplied
  // path, no shell metacharacter anywhere.
  const PROGRAMS = ["cat", "findmnt", "nvidia-smi", "zramctl", "systemctl", "oomctl"];
  // findmntArgs is the one flags-only helper, the pattern Mount Monitor ships:
  // the widget names the program, memory.js owns every flag.
  const commands = [
    Memory.meminfoArgs(),
    Memory.psiArgs(),
    Memory.swapsArgs(),
    Memory.zramctlArgs(),
    ["findmnt"].concat(Memory.findmntArgs()),
    Memory.nvidiaGpuArgs(),
    Memory.nvidiaAppsArgs(),
    Memory.oomctlArgs(),
    Memory.oomdActiveArgs(),
  ];
  for (const argv of commands) {
    assert.equal(Array.isArray(argv), true);
    assert.equal(argv.length >= 1, true);
    assert.equal(PROGRAMS.includes(argv[0]), true, `unexpected program in ${JSON.stringify(argv)}`);
    for (const part of argv) {
      assert.equal(typeof part, "string");
      assert.equal(/[;|&`$\n]/.test(part), false, `no shell metacharacter in a typed argv: ${part}`);
    }
  }
  // The commands the widget can actually start are these and nothing else.
  const started = (QML.match(/command:[^\n]+/g) || []).join("\n");
  assert.equal(started.includes("Memory.meminfoArgs()"), true);
  assert.equal(started.includes("Memory.zramctlArgs()"), true);
  assert.equal(started.includes("Memory.oomctlArgs()"), true);
  // findmnt is the one command a mount list could have leaked into. It did not:
  // the watch list is applied to the rows in JS, so a configured path never
  // reaches an argv at all.
  assert.equal(Memory.findmntArgs().some(part => part.includes("/home") || part.includes("/mnt")), false);
  assert.equal(QML.includes("findmntArgs") && QML.includes("Memory.hdCandidates"), true);
});

test("the widget builds every notification through Memory.notifyArgs and never writes a notify-send argv of its own", () => {
  assert.equal(QML.includes("Memory.notifyArgs("), true);
  assert.equal(QML.includes("Memory.clickArgvFor("), true);
  assert.equal(QML.includes("printId:"), true, "the widget asks for the printed id when a claim must be retractable");
  assert.equal(QML.includes("Memory.parsePrintedId("), true);
  // Every notify-send argv the widget can run comes out of memory.js. The only
  // "notify-send" literal left in the widget is the log line that names a failure.
  assert.equal(QML.includes('command: ["notify-send"'), false, "the widget does not hand-build a notify-send argv");
  assert.equal(QML.includes('retractProc.command = ["notify-send"'), false);
  const plan = Memory.retractClaimFor({ outcome: "died", type: "ram", key: "ram", id: Memory.memId("ram"), pct: 97, claimId: "" });
  assert.equal(plan.replaceable, false);
  assert.equal(plan.args[0], "notify-send");
  assert.equal(plan.args.includes("-u"), true);
  assert.equal(plan.args[plan.args.indexOf("-u") + 1], "normal", "round 7 item 12: even the dead-guard toast is temporary");
  const replaceable = Memory.retractClaimFor({ outcome: "died", type: "ram", key: "ram", id: Memory.memId("ram"), pct: 97, claimId: "42" });
  assert.equal(replaceable.replaceable, true);
  assert.equal(replaceable.args[0], "notify-send");
  assert.equal(replaceable.args.includes("-r"), true);
});

test("the widget never writes a prompt sentence, so no device-supplied word can land in one", () => {
  const bothCopy = QML + "\n" + PANEL;
  assert.equal(QML.includes("Memory.agentPrompt("), true);
  assert.equal(bothCopy.includes("Memory.onboardingPrompt(") || QML.includes("Memory.ceilingsQuestion("), true, "the ceiling question is memory.js's copy");
  assert.equal(bothCopy.includes("Memory.healthCheckPrompt("), true);
  assert.equal(QML.includes("Memory.guardAskBody("), true);
  assert.equal(QML.includes("Memory.guardAskTitle("), true);
  // The fixed copy lives in memory.js. A sentence in a widget would be a second
  // copy of it, and the two would drift.
  // A long string in a widget is only allowed as a diagnostic the widget logs
  // about itself. Prompt copy, toast copy and ask copy all live in memory.js.
  const longLiterals = QML.split("\n").filter(line =>
    /"[^"\n]{40,}"/.test(line) && !/console\.(warn|log|info|error)/.test(line));
  assert.deepEqual(longLiterals, [], "no fixed sentence lives in the bar widget except its own log lines");
  const panelLiterals = PANEL.split("\n").filter(line =>
    /"[^"\n]{40,}"/.test(line) && !/console\.(warn|log|info|error)/.test(line));
  assert.deepEqual(panelLiterals, [], "no fixed sentence lives in the detail window except its own log lines");
  assert.equal(QML.includes("Memory.dataOpen"), false, "the widget does not open a data block of its own");
});

test("the widget carries minted ids rather than inventing names", () => {
  assert.equal(QML.includes("Memory.memId("), true);
  assert.equal(QML.includes(".label +"), false, "a volume label is never concatenated into a name");
  assert.equal(QML.includes(".partlabel +"), false);
  // Every id the widget puts in a prompt or a state file is validated by memory.js
  // on the way out; the widget must not build an id-shaped string itself.
  assert.equal(/mem-[0-9a-f]/.test(QML), false, "no hand-built id in the widget");
  assert.equal(QML.includes("Memory.armEventKey("), true);
});

test("the click path is typed argv, and the critical click opens the detail window rather than a second agent", () => {
  const critical = Memory.clickArgvFor({ kind: "alert", band: 3, type: "ram", key: "partuuid:1", id: Memory.memId("partuuid:1") }, null, {});
  same(critical, ["qs", "ipc", "call", "memory-monitor", "openDetail"]);
  const amber = Memory.clickArgvFor({ kind: "alert", band: 1, type: "ram", key: "ram", id: Memory.memId("ram"), pct: 82 }, null, {});
  assert.equal(amber[0], "omarchy");
  assert.equal(amber.slice(0, 3).join(" "), "omarchy agent prompt");
  assert.equal(amber.length, 4, "the whole prompt is one argument, never a shell string");
  assert.equal(amber[3].includes("\n"), true, "the prompt is a paragraph, and a paragraph in one argv element is why typed argv matters");
  assert.equal(amber[3].includes("&&"), false);
  assert.equal(amber[3].includes("82 PSI"), true, "the prompt carries the reading, rounded up, in the signal's own unit");
  // The hint the notification service prefers, and the live action it falls back
  // to, are both present on every band alert.
  const argv = Memory.notifyArgs({ kind: "alert", band: 2, type: "ram", key: "ram", id: Memory.memId("ram"), pct: 91.2 }, null);
  const joined = argv.join(" ");
  assert.equal(joined.includes("-h STRING:omarchy-exec-argv:["), true);
  assert.equal(joined.includes("-A default="), true, "round 7 item 12: the action label rides an equals, no colon form");
  assert.equal(joined.includes("-u normal"), true, "round 7 item 12: no toast is critical urgency any more");
});

test("the widget reads every setting through a normalize* helper, because a Qt list is not a JavaScript Array", () => {
  for (const call of [
    "Memory.normalizeSettings(",
    "Memory.normalizeMounts(",
    "Memory.normalizeBool(",
    "Memory.normalizeNumber(",
    "Memory.normalizeAgentCommand(",
  ]) {
    assert.equal(QML.includes(call), true, `MemoryMonitor.qml must read settings through ${call}`);
  }
  assert.equal(/Array\.isArray\([^)]*setting\(/.test(QML), false, "a bare array check rejects a correctly configured Qt list");
  assert.equal(QML.includes("Array.isArray"), false);
});

test("a held band and the priming survive a shell restart through the state file", () => {
  // primed carried across a restart only prevents a re-toast if the held band
  // itself survives the restart. Neither the load nor the write can live in a
  // node test, so the wiring is pinned at the exact hand-off points.
  const load = (QML.match(/function loadState\([^)]*\)[^{]*\{([^]*?)\n  \}/) || [])[1] || "";
  assert.match(load, /primed = parsed\.primed;/);
  assert.match(load, /bands = parsed\.bands;/, "the load must seed the held bands before the first sample");

  const write = (QML.match(/function writeState\(next\)[^{]*\{([^]*?)\n  \}/) || [])[1] || "";
  assert.match(write, /next\.primed = primed;/, "every writer stamps the priming, so no writer persists a stale one");
  assert.match(write, /next\.bands = bands;/, "every writer stamps the held bands, so a ceiling write cannot lose them");
  assert.match(write, /state = next;/, "what the writer wrote is what the widget holds: the show-time patch reads the record startArm just persisted");

  const apply = (QML.match(/function applyBand\([^)]*\)[^{]*\{([^]*?)\n  \}/) || [])[1] || "";
  assert.match(apply, /psiCrossing: psiNow && !psiStalledLast/, "PSI is passed as the crossing, not the standing level");
  assert.match(apply, /swapCrossing: swapNow && !swapEscalatedLast/, "swap is passed as the crossing, not the standing level");
  assert.match(apply, /psiStalledLast = psiNow;/, "the last sample's level is what the next crossing is measured against");
  assert.match(apply, /if \(isWriter && \(held !== previous \|\| firstSample\)\) saveState\(\);/,
    "the writer instance persists the band change; a non-writer writes nothing");
});

test("a band that releases leaves the rows, the badge and the tooltip in the same sample", () => {
  // The hold direction lives in buildReadings: the rebuilt rows carry bandOf,
  // so a held band never drops off the bar. The release direction is the other
  // half of the same binding-timing rule: applyBand returns before it touches
  // the entry when nothing fires, so on the sample that releases a band the
  // rows still carry the stale band while the bands memory has already let it
  // go — the badge tooltip would keep the red dot for one sample after the red
  // band has gone. The fix is ordering, and the node suite cannot run QML: the seam
  // is pinned here, and the release behavior itself is proven live against the
  // headless rig.
  const commit = (QML.match(/function commitSample\([^)]*\)[^{]*\{([^]*?)\n  \}/) || [])[1] || "";
  const builtAt = commit.indexOf("buildReadings();");
  const evaluatedAt = commit.indexOf("evaluateBands();");
  const reboundAt = commit.indexOf("rebindDisplayBands();");
  const loggedAt = commit.indexOf("appendLog();");
  assert.notEqual(builtAt, -1, "commitSample builds the readings");
  assert.notEqual(evaluatedAt, -1, "commitSample evaluates the bands");
  assert.notEqual(reboundAt, -1, "commitSample rebinds the display bands");
  assert.ok(reboundAt > evaluatedAt, "the rebind runs after evaluation, so it carries the band evaluateBands wrote");
  assert.ok(reboundAt < loggedAt, "the log row is built from the rebound rows, so it records the released band too");

  const rebind = (QML.match(/function rebindDisplayBands\([^)]*\)[^{]*\{([^]*?)\n  \}/) || [])[1] || "";
  assert.match(rebind, /bandOf\("ram"\)/, "System RAM rebinds from the band memory");
  assert.match(rebind, /bandOf\("vram"\)/, "VRAM rebinds from the band memory");
  assert.match(rebind, /bandOf\(row\.key\)/, "each drive row rebinds from the band memory by its own key");
  assert.match(rebind, /latchedOf\(/, "the latch rebinds with the band: a released band must not present as latched");
  assert.match(rebind, /ramReading = ram;/, "the readings are rebound by reassignment");
  assert.match(rebind, /vramReading = vram;/);
  assert.match(rebind, /hdDevices = rows;/);
  // The bindings evaluate on the property assignment and never see a later
  // in-place fix, so the rebind must clone before it writes.
  assert.equal(rebind.includes("ramReading.band ="), false, "no in-place fix the bindings would miss");
  assert.equal(rebind.includes("hdDevices[i].band ="), false);
});

test("the notice lane answers the notice it showed, and never asks a question twice at once", () => {
  // The close is attributed to activeNotice, and a question is only queued when
  // no copy of it is queued or live: the ask is re-fired by delivery failure,
  // never by a sample that found the queue holding it.
  assert.match(QML, /var notice = root\.activeNotice;/, "the close is attributed to the notice that was shown, not to the queue head");
  assert.match(QML, /root\.noticeQueue\.indexOf\(notice\)/, "the shown notice is the one removed from the queue");
  assert.equal(QML.includes("Memory.onboardingNoticePending(noticeQueue, activeNotice, \"ceilings\")"), true);
  assert.equal(QML.includes("Memory.onboardingNoticePending(noticeQueue, activeNotice, \"guard-ask\")"), true);
  assert.equal(QML.includes("Memory.groupHdByDevice(hdRows, latchedMap)"), true, "the latch map rides the group rebuild");
});

test("an escalation displaces the live notice by its show-time id, and the lane reads the id as it arrives", () => {
  const noticeProc = (QML.match(/id: noticeProc[^]*?\n  \}/) || [""])[0];
  assert.match(noticeProc, /stdout: SplitParser/, "the printed id arrives while the popup lives, not when it closes");
  assert.match(noticeProc, /noticePrintedId = id/, "the live id is what the escalation replaces and what a later generation retracts");
  assert.match(noticeProc, /Memory\.patchArmClaimId\(next\.arms, root\.arm\.eventKey, id\)/,
    "the printed id is persisted onto the started record, so a restart retracts by it");
  assert.match(noticeProc, /root\.activeNotice === root\.armClaimNotice/, "the id is accepted only from the lane slot the claim toast occupies");
  assert.match(noticeProc, /Memory\.isArmClaimNotice\(root\.arm, root\.activeNotice\)/, "whether a printed id names the claim is decided in memory.js");
  assert.match(noticeProc, /writeState\(next\)/, "the persisted id is what survives into the file");
  assert.match(noticeProc, /root\.noticePreempting = false;/, "the displaced process's own exit is what fires the replacement");

  const startArm = (QML.match(/function startArm\([^)]*\)[^{]*\{([^]*?)\n  \}/) || [""])[0];
  assert.match(startArm, /armClaimNotice = alert/, "the arm remembers the notice that is its claim toast");

  const queueGuardState = (QML.match(/function queueGuardState\([^)]*\)[^{]*\{([^]*?)\n  \}/) || [])[1] || "";
  assert.match(queueGuardState, /armLive: Memory\.armIsLive\(arm\)/, "the queue-time guard state knows whether an arm is already live");

  const queue = (QML.match(/function queueAlert\([^)]*\)[^{]*\{([^]*?)\n  \}/) || [])[1] || "";
  assert.match(queue, /Memory\.supersedesQueuedNotice\(alert, noticeQueue\[i\]\)/, "which queued notice a louder one supersedes is decided in memory.js");
  assert.match(queue, /Memory\.displacesLiveNotice\(alert, activeNotice\)/, "whether the live notice is displaced is decided in memory.js");
  assert.match(queue, /preemptLiveNotice\(alert\)/, "the escalation displaces instead of queueing behind the live notice");

  const preempt = (QML.match(/function preemptLiveNotice\([^)]*\)[^{]*\{([^]*?)\n  \}/) || [])[1] || "";
  assert.match(preempt, /replaceId = noticePrintedId/, "the replacement carries the live notice's own id");
  assert.match(preempt, /noticeProc\.running = false/, "the displaced notice frees the lane at once");
});

test("the unseen-alert ring survives samples and is emptied when the window opens", () => {
  const record = (QML.match(/function recordAlertEvent\([^)]*\)[^{]*\{([^]*?)\n  \}/) || [])[1] || "";
  assert.match(record, /Memory\.pushUnseenAlerts\(unseenAlerts, alert\)/, "the ring's cap and order are decided in memory.js");

  const log = (QML.match(/function appendLog\([^)]*\)[^{]*\{([^]*?)\n  \}/) || [])[1] || "";
  assert.match(log, /pendingAlertEvents = \[\];/, "the log row takes the sample's events and clears them");
  assert.equal(log.includes("unseenAlerts"), false, "the ring survives every writer sample");

  const open = (QML.match(/function open\(\): void \{([^]*?)\n  \}/) || [])[1] || "";
  assert.match(open, /unseenAlerts = \[\];/, "opening the window is what empties the ring");
  assert.equal(PANEL.includes('mon("unseenAlerts", [])'), true, "the detail window reads the ring, not the per-sample log feed");
  assert.equal(PANEL.includes("pendingAlertEvents"), false);
});

test("an arm finishes once, and a killed arm is never read as a survivor", () => {
  assert.match(QML, /if \(arm === null \|\| arm\.outcome !== "started"\) return;/,
    "the watchdog's synchronous finish is the record; the process's own exit cannot write a second one");
  assert.equal(QML.includes("exitStatus !== undefined && exitStatus !== 0"), true,
    "a signal death is a death even when the watchdog already gave up");
});

test("the arm is on the file when it starts, and the orphan decision is memory.js's", () => {
  const start = (QML.match(/function startArm\([^)]*\)[^{]*\{([^]*?)\n  \}/) || [])[1] || "";
  assert.equal((start.match(/recordArm\(arm\);/g) || []).length, 2,
    "the started record is persisted before the process runs, the refused record too");
  assert.match(start, /key: alert\.key/, "the persisted record carries what a retraction needs");
  assert.match(start, /pct: alert\.pct/, "the persisted record carries the reading");

  const reconcile = (QML.match(/function reconcilePersistedArms\(\)[^{]*\{([^]*?)\n  \}/) || [])[1] || "";
  assert.match(reconcile, /Memory\.reconcileArms\(/, "which persisted record is an orphan is decided in memory.js");
  assert.match(reconcile, /if \(reconcileDone\) return;/, "the reconcile runs once per widget generation: the widget's own state writes re-enter loadState through the file watch");
  assert.match(reconcile, /liveArmKey/, "the record of the arm this generation is running is skipped");
  assert.match(reconcile, /retractClaim\(plan\.retract\);/, "the retraction is built from the persisted record, not the in-memory arm");
  assert.equal(reconcile.includes("finishArm("), false, "reconciliation never depends on this generation holding an arm");
});

test("the reading a prompt carries is the reading of the alert being fired", () => {
  const reading = (QML.match(/function readingFor\([^)]*\)[^{]*\{([^]*?)\n  \}/) || [])[1] || "";
  assert.match(reading, /Memory\.hdRowFor\(hdRows/, "which row an event names is decided in memory.js");
  assert.match(reading, /event\.key/, "the event being fired picks the row, not a lane-global");
  assert.match(reading, /activeAlert\.key/, "the live alert still resolves a one-argument call");
  assert.equal(QML.includes("readingFor(alert.type, alert)"), true, "every lane passes the alert it is firing");
  assert.equal(QML.includes("readingFor(alert.type)"), false, "no call site is left resolving the type alone");
});

test("the widget delegates every band, poll, severity and alert decision to memory.js", () => {
  for (const call of [
    "Memory.resolveBand(",
    "Memory.pollIntervalMs(",
    "Memory.mostSevereForBar(",
    "Memory.shouldFireAlert(",
    "Memory.dropGoneAlerts(",
    "Memory.deliveryVerdict(",
    "Memory.psiStalling(",
    "Memory.swapEscalates(",
    "Memory.thresholdsFor(",
    "Memory.logWriterElection(",
    "Memory.logRecord(",
    "Memory.logAppendArgs(",
    "Memory.logRotateArgs(",
    "Memory.logRotatePlan(",
    "Memory.armBudgetCheck(",
    "Memory.shouldStartArm(",
  ]) {
    assert.equal(QML.includes(call), true, `MemoryMonitor.qml must ask ${call} instead of deciding locally`);
  }
  // And the drawing to RingKit, which is why ringkit.js is installed beside it.
  assert.equal(QML.includes('import "ringkit.js" as RingKit'), true);
  assert.equal(QML.includes("RingKit.badgeParams("), true);
  assert.equal(QML.includes("RingKit.paletteToken("), true);
});

test("the 60-second fallback sweep is never removed", () => {
  // Memory Monitor has no udevadm monitor in v1: the sweep is the whole detection,
  // so a widget that dropped it would stop noticing anything between restarts.
  assert.equal(QML.includes("Timer"), true);
  assert.equal(/interval:\s*Memory\.POLL_NOMINAL_MS|interval:\s*\d{4,}/.test(QML), true, "a long-running poll timer exists");
  assert.equal(QML.includes("Memory.POLL_NOMINAL_MS") || QML.includes("pollIntervalMs"), true);
});

test("Memory Monitor runs no partition scan and imports no Mount Monitor logic", () => {
  // The two plugins have two jobs. Mount Monitor owns partition onboarding;
  // Memory Monitor reads mount usage and must not re-derive a candidate list.
  const commands = (QML.match(/command:[^\n]+/g) || []).join("\n");
  assert.equal(commands.includes("lsblk"), false, "no partition scan here");
  assert.equal(commands.includes("udevadm"), false, "v1 watches no uevents");
  assert.equal(commands.includes("notify-send"), false, "no hand-built notify-send command");
  assert.equal(QML.includes('import "mounts.js"'), false);
  assert.equal(QML.includes("Mounts."), false);
  assert.equal(PANEL.includes("lsblk"), false);
  assert.equal(PANEL.includes('import "mounts.js"'), false);
});

test("the detail window is mounted by the bar widget and registers no second IPC target", () => {
  assert.equal(QML.includes("Memory.ipcTarget()"), true);
  assert.equal(QML.includes("panelLoader"), true);
  assert.equal(PANEL.includes('ipcTarget: ""'), true);
  assert.equal(PANEL.includes("manageIpc: false"), true);
  assert.equal(PANEL.includes("Memory.ipcTarget()"), false, "only the bar widget owns the plugin's IPC target");
  assert.equal(QML.includes("openDetail"), true);
});

test("the manifest is a bar-widget manifest and the installer copies what the widget imports", () => {
  assert.equal(MANIFEST.id, "io.github.jasonlnheath.memory-monitor");
  assert.equal(MANIFEST.kinds.includes("bar-widget"), true);
  assert.equal(MANIFEST.entryPoints.barWidget, "MemoryMonitor.qml");
  assert.equal(MANIFEST.kinds.includes("panel"), false, "the panel is mounted by the bar widget, not registered separately");
  for (const file of ["manifest.json", "MemoryMonitor.qml", "MemoryPanel.qml", "memory.js", "ringkit.js"]) {
    assert.equal(INSTALL.includes(file), true, `install.sh must copy ${file}`);
  }
  assert.equal(INSTALL.includes("io.github.jasonlnheath.memory-monitor"), true);
  // The installer may tell the captain the wiring line exists. It must never
  // write the live shell config itself.
  // The installer may tell the captain the wiring line exists. It must never
  // write the live shell config itself.
  const writes = INSTALL.split("\n").filter(line =>
    /shell\.json/.test(line) && !/^\s*(#|echo|printf)/.test(line));
  assert.deepEqual(writes, [], "the installer never edits the live shell config");
  assert.equal(INSTALL.includes("sed -i"), false);
  assert.equal(/>[^&\n]*shell\.json/.test(INSTALL), false, "no redirect into the live shell config");
});

test("no shell string, no hand-built redirect, and no process call qmllint cannot see", () => {
  for (const file of [QML, PANEL]) {
    assert.equal(file.includes("sh -c"), false);
    assert.equal(file.includes('"bash"'), false);
    assert.equal(/\bterminate\(/.test(file), false, "Process.terminate is not on Quickshell Process here");
    assert.equal(/\b\.kill\(/.test(file), false);
    assert.equal(/command:\s*"[^"]*>/.test(file), false, "no redirect inside a typed command");
  }
});

test("the widget's own copy is only the bar's logo and the tooltip, both of which memory.js supplies", () => {
  // QuattroDash is the bar emblem (the approved design): the MIL artwork
  // renders through QuattroSymbol, so the widget's own copy is only the bar
  // tooltip, which memory.js supplies.
  assert.equal(QML.includes("Memory.barTooltip("), true);
  const both = QML + "\n" + PANEL;
  assert.equal(both.includes("Memory.unavailableText("), true, "a missing reading is named, not drawn as zero");
  assert.equal(both.includes("Memory.unreachableBandNote("), true, "a stuck band says so instead of latching in silence");
  assert.equal(both.includes("Memory.alertsYouDidNotSeeText("), true, "a toast DND swallowed is still reported");
  assert.equal(both.includes("Memory.kernelCeilingText("), true, "oomd's ceiling is reported, not replaced");
  assert.equal(both.includes("Memory.swapText("), true);
  assert.equal(both.includes("Memory.psiText("), true);
});

test("a dash-launched severe dispatch rides the same arm gate the toast path rides", () => {
  const dispatch = (QML.match(/function dispatchCriticalCode\([^)]*\)[^{]*\{([^]*?)\n  \}/) || [])[1] || "";
  assert.notEqual(dispatch, "", "the widget owns the severe code's dispatch");
  assert.match(dispatch, /Memory\.shouldStartArm\(/,
    "the gate is the arm's own single-flight check, not a dash-local guess");
  assert.match(dispatch, /Memory\.armBudgetCheck\(/, "the budget gate rides along");
  assert.match(dispatch, /startArm\(alert, true, diagnosisJsonText\)/,
    "the dispatched agent IS the arm: one flight, one agent, the v1 doctrine");
  assert.match(dispatch, /why: decision\.why/, "the refusal names why so the dash can say so");
});
