import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "memory.js" as Memory
import "ringkit.js" as RingKit

// Memory Monitor — the sibling plugin of Mount Monitor, and a separate product.
// It watches System RAM, VRAM and the drives Mount Monitor already watches, and
// alerts at ceilings the user sets. Every decision — thresholds, numerators,
// parsers, bands, hysteresis, the PSI re-alert gate, swap escalation, device
// dedup, severity, poll intervals, oomd discovery, toast templates, prompts,
// onboarding and guard copy — lives in memory.js so it is testable without a
// running shell. This file keeps state, processes, timers, and drawing, and
// builds every argv through Memory.*Args().
//
// Thresholds are ceilings the USER sets. Amber and red run at the spec defaults
// from install; critical ships unset, and until the user sets it there is no
// critical band, no critical toast, and no glowing badge. Nothing here ever
// writes a ceiling he did not set.
//
// The bar shows one badge: the most severe resource. With nothing over a line it
// is the plain white MM logo. Severity carries shape as well as hue — amber is a
// partial fill with a steady badge, red is a full badge plus a warning glyph,
// critical adds the pulse and halo — so amber-versus-red survives deuteranopia,
// and the glyph carries the type.
//
// Toasts are events, not states: an alert fires on a band ascent or on one of
// memory.js's re-fire conditions (severity increase, PSI crossing the stall
// floor, swap crossing the kernel's swap limit), never on a resource merely
// sitting in a band. `primed` is carried, so a shell restart does not re-toast a
// band that was already held.
//
// Amber rides normal urgency on the watchdog-released lane and is silenced by
// Do Not Disturb — but recorded, in the log and in the panel's "Alerts you did
// not see". Red and critical ride critical urgency, which is the only thing the
// shell's shouldBypassDnd lets through, and therefore timeout 0, their own
// never-expiring process lane, and a persisted exec hint that keeps a
// restart-surviving toast clickable.
//
// Amber and red clicks send an agent prompt. Critical clicks open the detail
// window through Quickshell IPC — never a second agent on top of the armed one.
// The critical arm is launched by the widget at queue time, single-flight per
// machine and gated by the guard's own memory cost, so the sentence "Agent has
// been notified and is guarding against OOM." is only ever emitted when an agent
// actually started. When it did not, or when it died, memory.js's other three
// copies are emitted instead, and a dead arm retracts its own claim by the
// notification id captured when the claim was sent.
//
// Memory Monitor runs no partition scan, emits no new-partition notice, keeps no
// decisions map, ships no partition skill, and runs no udevadm monitor: Mount
// Monitor owns which drives are watched, owns the machine's one block-event
// monitor, and owns the alerts for the drives it watches. Memory Monitor reads
// that same `mounts` setting for its HD rows, shows HD severity in its own badge
// and panel, and toasts HD only for drives Mount Monitor is not watching.
//
// One bar widget is instantiated once per monitor, so the queue, the notice lane,
// the poll timers, the baseline log append and the arm are screen-count
// independent: Memory.logWriterElection picks one instance per sample and the
// others only draw.
//
// Configure via the shell.json layout entry:
//   { "id": "io.github.jasonlnheath.memory-monitor", "mounts": ["/", "/mnt/models"] }
// Settings: mounts (fallback only — Mount Monitor's own entry wins when that
// widget is present), agentCommand, guard, onboarding, pollMs, testPct.
BarWidget {
  id: root

  moduleName: "io.github.jasonlnheath.memory-monitor"

  // ---- Readings. Each is a memory.js reading record, or null when the tool
  //      behind it is missing — which is rendered as unavailable, never as 0%.
  property var ramReading: null
  property var vramReading: null
  property var hdRows: []
  property var hdDevices: []
  property var oomd: null
  property var psi: null
  property var swaps: []
  property var zram: []

  // ---- Band memory, keyed by memory.js's device/resource key. A configured
  //      target that is temporarily unmounted keeps its last band here.
  property var bands: ({})
  // Carried in the settings state file so a shell restart does not re-toast a
  // band that was already held.
  property bool primed: false

  // ---- Settings state (thresholds per type, who set each, guard answer,
  //      whether the asks have been made, the arm records).
  property var state: ({})
  property bool stateLoaded: false
  property bool scanDone: false

  // ---- The notification service's own Do Not Disturb flag, read from the
  //      service's own persisted setting. null = unknown.
  property var dnd: null

  // ---- Queues. `alertQueue` is the watchdog-released amber lane;
  //      `noticeQueue` is the never-expiring red/critical lane. Band escalation
  //      preempts an unanswered lower-band toast rather than queueing behind it.
  property var alertQueue: []
  property var noticeQueue: []
  property int alertQueueMax: 8
  property int noticeQueueMax: 8

  // ---- The single-flight arm, machine-wide, keyed by the event identity.
  property var arm: null
  property var armClaimNotice: null
  property var liveArmKey: ""

  // ---- Which instance owns the shared side effects for this sample.
  readonly property var siblingInstances: bar && typeof bar.moduleWidgets === "function"
    ? bar.moduleWidgets(moduleName) : []
  readonly property int instanceIndex: {
    var items = siblingInstances;
    for (var i = 0; i < items.length; i++) if (items[i] === root) return i;
    return 0;
  }
  readonly property int instanceCount: siblingInstances ? siblingInstances.length : 1
  readonly property bool isWriter: Memory.logWriterElection(instanceIndex, instanceCount)

  readonly property string home: Quickshell.env("HOME") || ""
  readonly property string baselinePath: Memory.logPath(home)
  readonly property string settingsPath: Memory.settingsPath(home)
  readonly property string dndPath: Memory.dndStatePath(home)

  readonly property bool onboardingEnabled: Memory.normalizeBool(setting("onboarding", true), true)

  // ---------------------------------------------------------------------------
  // Settings reads. Every one through a Memory.normalize* helper: the value the
  // setting hand-off delivers is a Qt list, not a JavaScript Array.
  // ---------------------------------------------------------------------------

  function thresholds(type): var {
    return Memory.thresholdsFor(state, type);
  }

  function guardAnswered(): bool {
    return state && state.guard !== null && state.guard !== undefined;
  }

  function guardOn(): bool {
    return Memory.normalizeBool(state ? state.guard : null, true);
  }

  function ownMounts(): var {
    return Memory.normalizeMounts(setting("mounts", null));
  }

  // Mount Monitor owns which drives are watched. Read its layout entry's own
  // `mounts` setting when that widget is live; fall back to ours when it is not.
  function siblingMounts(): var {
    if (!bar || typeof bar.moduleWidgets !== "function") return null;
    var widgets = bar.moduleWidgets(Memory.mountMonitorPluginId());
    if (!widgets || widgets.length === 0) return null;
    var first = widgets[0];
    if (!first || typeof first.setting !== "function") return null;
    return first.setting("mounts", null);
  }

  function watchedMounts(): var {
    return Memory.hdWatchList(siblingMounts(), ownMounts());
  }

  function agentCommandConfigured(): bool {
    var value = setting("agentCommand", null);
    return Memory.normalizeAgentCommand(value) !== null;
  }

  function agentCommandArgv(): var {
    return Memory.normalizeAgentCommand(setting("agentCommand", null));
  }

  // ---------------------------------------------------------------------------
  // Polling. Adaptive per resource: nominal when healthy, escalated on red or
  // critical, faster still when PSI is stalling. A vanished mount stays at the
  // nominal interval.
  // ---------------------------------------------------------------------------

  function pollMs(type, band, absent): int {
    var override = Memory.normalizeNumber(setting("pollMs", -1), -1);
    var value = Memory.pollIntervalMs(type, band, {
      absent: absent,
      psi: psi,
      psiFloor: Memory.PSI_STALL_FLOOR,
    });
    return override > 0 ? override : value;
  }

  function bandOf(key): int {
    var value = bands[key];
    return value === undefined || value === null ? 0 : value;
  }

  function setBand(key, band): void {
    var next = JSON.parse(JSON.stringify(bands));
    next[key] = band;
    bands = next;
  }

  function refresh(): void {
    startSample();
  }

  function refreshSelf(): void {
    startSample();
  }

  // ---------------------------------------------------------------------------
  // One sample at a time. A bar widget exists per monitor, so every shared side
  // effect - the log append, the arm, the notices - is gated on isWriter, and a
  // second sample never overlaps the first.
  // ---------------------------------------------------------------------------

  property var cycleDone: ({})
  property bool cycleRunning: false
  property string meminfoText: ""
  property string psiText: ""
  property string swapsText: ""
  property string zramText: ""
  property string findmntText: ""
  property string gpuText: ""
  property string appsText: ""
  property var cycleFailures: ({})

  readonly property var readNames: ["meminfo", "psi", "swaps", "zram", "findmnt", "gpu", "apps"]

  function startSample(): void {
    if (cycleRunning) return;
    cycleRunning = true;
    cycleDone = ({});
    cycleFailures = ({});
    readWatchdog.restart();
    ramProc.running = true;
    psiProc.running = true;
    swapsProc.running = true;
    zramProc.running = true;
    dfProc.running = true;
    gpuProc.running = true;
  }

  function markDone(name): void {
    var done = JSON.parse(JSON.stringify(cycleDone));
    if (done[name]) return;
    done[name] = true;
    cycleDone = done;
    for (var i = 0; i < readNames.length; i++) {
      if (!cycleDone[readNames[i]]) return;
    }
    readWatchdog.stop();
    cycleRunning = false;
    commitSample();
  }

  function markFailed(name, detail): void {
    var failures = JSON.parse(JSON.stringify(cycleFailures));
    failures[name] = detail === undefined ? "" : String(detail);
    root.cycleFailures = failures;
    markDone(name);
  }

  // A wedged reader must not wedge the bar. Every child process gets a timeout,
  // and the reading it owed is recorded as failed rather than as zero.
  function abandonCycle(reason): void {
    if (ramProc.running) ramProc.running = false;
    if (psiProc.running) psiProc.running = false;
    if (swapsProc.running) swapsProc.running = false;
    if (zramProc.running) zramProc.running = false;
    if (dfProc.running) dfProc.running = false;
    if (gpuProc.running) gpuProc.running = false;
    if (appsProc.running) appsProc.running = false;
    console.warn("memory-monitor:", Memory.degradationSurface("wedged-process"), reason)
    for (var k = 0; k < readNames.length; k++) markDone(readNames[k]);
  }

  // ---------------------------------------------------------------------------
  // Commit a sample: build the readings, evaluate the bands, queue the alert
  // events, append the log row, and re-arm the poll timers for what was seen.
  // ---------------------------------------------------------------------------

  function commitSample(): void {
    if (!stateLoaded) return;
    buildReadings();
    evaluateBands();
    if (isWriter) appendLog();
    schedulePolls();
    evaluateOnboarding();
  }

  function buildReadings(): void {
    var meminfo = Memory.parseMeminfo(meminfoText);
    psi = Memory.parsePsi(psiText);
    swaps = Memory.parseSwaps(swapsText);
    zram = Memory.parseZramctl(zramText);
    var swap = Memory.swapTotals(swaps);
    var z = Memory.zramTotals(zram);
    var ram = Memory.ramReading(meminfo);
    if (ram !== null) {
      ram.psiSomeAvg10 = psi.some_avg10 === undefined ? null : psi.some_avg10;
      ram.psiFullAvg10 = psi.full_avg10 === undefined ? null : psi.full_avg10;
      ram.swapTotalKb = swap.swapTotalKb;
      ram.swapUsedKb = swap.swapUsedKb;
      ram.swapPct = swap.swapPct;
      ram.zramDiskKb = z.zramDiskKb;
      ram.zramDataKb = z.zramDataKb;
      ram.zramComprKb = z.zramComprKb;
      ram.zramPct = z.zramPct;
      ram.zramRatio = z.zramRatio;
      ram.oomdActive = oomd ? oomd.oomdActive : false;
      ram.oomdSwapLimitPct = oomd ? oomd.oomdSwapLimitPct : null;
      ram.oomdPsiLimitPct = oomd ? oomd.oomdPsiLimitPct : null;
      ram.oomdWatchedCgroup = oomd ? oomd.oomdWatchedCgroup : "";
      ram.band = bandOf("ram");
      ram.latched = latchedOf("ram");
    }
    ramReading = ram;

    var gpu = Memory.parseNvidiaGpu(gpuText);
    if (gpu === null) {
      vramReading = null;
      vramVerdict = Memory.nvidiaMissingVerdict(gpuText);
    } else {
      var vram = Memory.vramReading(gpu, Memory.parseNvidiaApps(appsText));
      if (vram !== null) {
        vram.band = bandOf("vram");
        vram.latched = latchedOf("vram");
      }
      vramReading = vram;
      vramVerdict = "";
    }

    var wanted = watchedMounts();
    hdRows = Memory.hdCandidates(findmntText, wanted);
    hdDevices = Memory.groupHdByDevice(hdRows, latchedMap);
    scanDone = true;
  }

  function latchedOf(key): bool {
    var l = JSON.parse(JSON.stringify(latchedMap));
    return l[key] === true;
  }

  function evaluateBands(): void {
    var seen = [];
    var nextLatched = JSON.parse(JSON.stringify(latchedMap));

    if (ramReading !== null) {
      seen.push("ram");
      applyBand("ram", "ram", ramReading.pct, thresholds("ram"), nextLatched, ramReading);
    }
    if (vramReading !== null) {
      seen.push("vram");
      applyBand("vram", "vram", vramReading.pct, thresholds("vram"), nextLatched, vramReading);
    }

    var wanted = watchedMounts();
    var targets = JSON.parse(JSON.stringify(deviceTargets));
    for (var i = 0; i < hdDevices.length; i++) {
      var device = hdDevices[i];
      seen.push(device.key);
      targets[device.key] = device.targets === undefined ? [] : Array.from(device.targets, t => String(t));
      applyBand(device.key, "hd", device.pct, thresholds("hd"), nextLatched, device);
    }
    deviceTargets = targets;

    // A configured target that is temporarily unmounted keeps its last band and
    // simply drops out of the bar; a device whose every target has left the
    // watch list loses its band.
    for (var k in bands) {
      if (seen.indexOf(k) >= 0 || k === "ram" || k === "vram") continue;
      var owned = targets[k] || [];
      var stillConfigured = false;
      for (var o = 0; o < owned.length; o++) if (wanted.indexOf(owned[o]) >= 0) stillConfigured = true;
      if (!stillConfigured) delete bands[k];
    }

    latchedMap = nextLatched;
    alertQueue = Memory.dropGoneAlerts(alertQueue, seen);
    noticeQueue = Memory.dropGoneAlerts(noticeQueue, seen);
  }

  function applyBand(key, type, pct, ceiling, latchedTarget, entry): void {
    var previous = bandOf(key);
    var result = Memory.resolveBand(pct, ceiling, previous, type);
    latchedTarget[key] = result.latched;
    var held = result.band;
    var next = JSON.parse(JSON.stringify(bands));
    next[key] = held;
    bands = next;

    var firstSample = !primed;
    var wasHeld = primed && previous > 0;
    var psiNow = type === "ram" && Memory.psiStalling(psi, Memory.PSI_STALL_FLOOR);
    var swapNow = type === "ram" && Memory.swapEscalates(ramReading, oomd);
    var fire = Memory.shouldFireAlert({
      band: held,
      previousBand: previous,
      firstSample: firstSample,
      wasHeld: wasHeld,
      psiCrossing: psiNow && !psiStalledLast,
      swapCrossing: swapNow && !swapEscalatedLast,
    });
    if (type === "ram") {
      psiStalledLast = psiNow;
      swapEscalatedLast = swapNow;
    }
    primed = true;
    if (isWriter && (held !== previous || firstSample)) saveState();
    if (!fire) return;
    if (entry) entry.band = held;
    queueAlert(entry, held, type, key, result.latched);
  }

  // ---------------------------------------------------------------------------
  // Alert events. Every event is logged with a delivery verdict, because the
  // daemon drops a silenced amber without keeping a record of dropping it.
  // ---------------------------------------------------------------------------

  function alertEvent(entry, band, type, key, latched): var {
    var base = entry === null || entry === undefined ? {} : entry;
    return {
      kind: "band",
      key: key,
      id: base.id === undefined ? Memory.memId(key) : base.id,
      type: type,
      band: band,
      pct: base.pct,
      latched: latched,
      target: base.target,
      device: base.device,
      fstype: base.fstype,
      label: base.label,
      partlabel: base.partlabel,
      sizeKb: base.sizeKb,
      usedKb: base.usedKb,
      availKb: base.availKb,
      ro: base.ro,
      epoch: Date.now(),
      at: new Date().toISOString(),
    };
  }

  function queueAlert(entry, band, type, key, latched): void {
    if (!isWriter) return;
    if (band === 0) return;
    var alert = alertEvent(entry, band, type, key, latched);

    // Mount Monitor already toasts the drives it watches, with its own words,
    // its own thresholds and its own click target. One toast per crossing.
    if (type === "hd" && Memory.hdAlertSuppressed(alert.target, siblingMounts())) {
      alert.delivered = "not-mine";
      alert.reason = "Mount Monitor watches " + String(alert.target);
      recordAlertEvent(alert);
      return;
    }

    alert.delivered = Memory.deliveryVerdict(alert, dnd);
    alert.reason = alert.delivered === "silenced-dnd" ? "amber silenced by Do Not Disturb" : "";
    recordAlertEvent(alert);

    if (band >= 2) {
      // Band escalation preempts an unanswered lower-band toast rather than
      // queueing behind it.
      for (var i = 0; i < noticeQueue.length; i++) {
        if (Memory.supersedesQueuedNotice(alert, noticeQueue[i])) noticeQueue[i].preempt = true;
      }
      if (Memory.displacesLiveNotice(alert, activeNotice)) {
        preemptLiveNotice(alert);
        return;
      }
      if (noticeQueue.length >= noticeQueueMax) noticeQueue.shift();
      noticeQueue = noticeQueue.concat([alert]);
      fireNextNotice();
    } else {
      if (alertQueue.length >= alertQueueMax) alertQueue.shift();
      alertQueue = alertQueue.concat([alert]);
      fireNextAlert();
    }
  }

  function recordAlertEvent(alert): void {
    pendingAlertEvents = pendingAlertEvents.concat([alert]);
    unseenAlerts = Memory.pushUnseenAlerts(unseenAlerts, alert);
  }

  // ---------------------------------------------------------------------------
  // The amber lane: normal urgency, bounded timeout, released by a watchdog so a
  // stuck popup cannot hold the rest of the resources shut.
  // ---------------------------------------------------------------------------

  function fireNextAlert(): void {
    if (!isWriter) return;
    if (notifyProc.running || alertQueue.length === 0) return;
    var alert = alertQueue[0];
    activeAlert = alert;
    notifyProcArgs = Memory.notifyArgs(alert, agentCommandArgv(), {
      clickArgv: Memory.clickArgvFor(alert, agentCommandArgv(), {
        inline: Memory.normalizeBool(setting("agentInline", false), false),
        reading: readingFor(alert.type, alert),
        oomd: oomd,
        logPath: baselinePath,
      }),
    });
    notifyProc.command = notifyProcArgs;
    notifyProc.running = true;
    alertWatchdog.restart();
  }

  function readingFor(type, event): var {
    if (type === "ram") return ramReading;
    if (type === "vram") return vramReading;
    return Memory.hdRowFor(hdRows, event ? event.key : (activeAlert ? activeAlert.key : ""));
  }

  function releaseActiveAlert(reason): void {
    if (!notifyProc.running) return;
    console.warn("memory-monitor: released an alert:", reason);
    notifyProc.running = false;
  }

  // ---------------------------------------------------------------------------
  // The never-expiring lane: red and critical. Its own process, because
  // notify-send blocks while its action is live and a critical toast has no
  // timeout. No timer ever releases it.
  // ---------------------------------------------------------------------------

  function fireNextNotice(): void {
    if (!isWriter) return;
    if (noticePreempting || noticeProc.running || noticeQueue.length === 0) return;
    var alert = noticeQueue[0];
    if (alert.preempt) {
      noticeQueue = noticeQueue.slice(1);
      fireNextNotice();
      return;
    }
    activeNotice = alert;
    var guardState = queueGuardState(alert);
    alert.guardState = guardState;
    var clickArgv = Memory.clickArgvFor(alert, agentCommandArgv(), {
      inline: Memory.normalizeBool(setting("agentInline", false), false),
      reading: readingFor(alert.type, alert),
      oomd: oomd,
      thresholds: state.thresholds,
      logPath: baselinePath,
      resting: alert.resting === undefined ? null : alert.resting,
    });
    var args = Memory.notifyArgs(alert, agentCommandArgv(), {
      clickArgv: clickArgv,
      printId: true,
      replaceId: alert.replaceId === undefined ? "" : alert.replaceId,
    });
    noticeProcArgs = args;
    noticePrintedId = "";
    noticeProc.command = args;
    noticeProc.running = true;
    // A question is not an emergency: the ceiling question and the guard ask ride
    // the critical lane so they stay clickable, and neither one arms an agent.
    if (Memory.isArmNotice(alert) && guardState === "armed") startArm(alert);
  }

  // A severity rise over the notice on the screen displaces it: the incoming
  // notice takes the lane at its head and re-sends over the live id, the
  // displaced one leaves the queue, and its process is stopped so the lane frees
  // at once. The displaced notice's own exit is what fires the replacement, and
  // a displaced question stays unrecorded - it is re-asked when the lane is free,
  // because it was interrupted, not answered.
  function preemptLiveNotice(incoming): void {
    incoming.replaceId = noticePrintedId;
    var live = activeNotice;
    activeNotice = null;
    noticePreempting = true;
    var rest = [];
    for (var i = 0; i < noticeQueue.length; i++) {
      if (noticeQueue[i] !== live) rest.push(noticeQueue[i]);
    }
    noticeQueue = [incoming].concat(rest);
    noticeProc.running = false;
  }

  // The claim is only ever emitted when the arm is about to start. Guard-off and
  // guard-refused are queue-time states, decided here, because the arm never ran.
  function queueGuardState(alert): string {
    var budget = Memory.armBudgetCheck(ramReading, oomd, { psiFloor: Memory.PSI_STALL_FLOOR });
    return Memory.guardStateFor({
      guard: guardOn(),
      budgetOk: budget.ok,
      armDied: false,
      armLive: Memory.armIsLive(arm),
    });
  }

  // ---------------------------------------------------------------------------
  // The critical arm: single-flight, machine-wide, budget-gated, watchdog-killed,
  // and logged with its pid, its outcome, whether it survived, and the claim
  // toast's notification id.
  // ---------------------------------------------------------------------------

  function startArm(alert): void {
    if (!isWriter) return;
    var eventKey = Memory.armEventKey(alert);
    if (Memory.armIsLive(arm) && liveArmKey === eventKey) return;
    if (Memory.armIsLive(arm)) return;
    var budget = Memory.armBudgetCheck(ramReading, oomd, { psiFloor: Memory.PSI_STALL_FLOOR });
    var decision = Memory.shouldStartArm({
      band: alert.band,
      guard: guardOn(),
      armLive: Memory.armIsLive(arm),
      budgetOk: budget.ok,
      writer: isWriter,
    });
    if (!decision.start) {
      armClaimNotice = null;
      arm = Memory.armRecord({
        eventKey: eventKey,
        type: alert.type,
        band: alert.band,
        outcome: decision.reason === "no headroom for the guard" ? "refused" : "skipped",
        reasons: budget.reasons.concat([decision.reason]),
        startedAt: new Date().toISOString(),
      });
      recordArm(arm);
      return;
    }
    var prompt = Memory.agentPrompt(alert, readingFor(alert.type, alert), oomd, baselinePath);
    var argv = Memory.normalizeBool(setting("agentInline", false), false)
      ? Memory.agentArgvWithInline(prompt, agentCommandArgv())
      : Memory.agentArgv(prompt, agentCommandArgv());
    liveArmKey = eventKey;
    armClaimNotice = alert;
    arm = Memory.armRecord({
      eventKey: eventKey,
      type: alert.type,
      band: alert.band,
      key: alert.key,
      id: alert.id,
      pct: alert.pct,
      target: alert.target,
      outcome: "started",
      startedAt: new Date().toISOString(),
      claimId: noticePrintedId,
      inline: Memory.normalizeBool(setting("agentInline", false), false),
    });
    recordArm(arm);
    armProc.command = argv;
    armProc.running = true;
    armWatchdog.restart();
  }

  function finishArm(outcome, survived, reasons): void {
    if (arm === null || arm.outcome !== "started") return;
    arm = Memory.armRecord(Object.assign({}, arm, {
      outcome: outcome,
      survived: survived,
      endedAt: new Date().toISOString(),
      reasons: (arm.reasons || []).concat(reasons || []),
    }));
    liveArmKey = "";
    armClaimNotice = null;
    armWatchdog.stop();
    recordArm(arm);
    if (outcome === "died") retractClaim(arm);
  }

  // A sentence claiming an agent is guarding may not outlive the arm it names.
  function retractClaim(record): void {
    var plan = Memory.retractClaimFor(record);
    if (plan === null || plan.args === null || plan.args === undefined) return;
    if (!plan.replaceable) console.warn("memory-monitor:", Memory.degradationText("claim-unretractable"));
    // Both shapes come from memory.js: a replace by captured id, or a fresh
    // critical toast when no id was captured. The widget builds neither.
    retractProc.command = plan.args;
    retractProc.running = true;
  }

  function recordArm(record): void {
    var next = JSON.parse(JSON.stringify(state));
    next.arms = (next.arms || []).concat([record]);
    if (next.arms.length > 50) next.arms = next.arms.slice(next.arms.length - 50);
    writeState(next);
  }

  // A widget generation that starts up and finds an arm whose guard did not
  // survive marks the persisted record died and retracts the standing claim by
  // the record's own id, before this generation has an arm of its own. The
  // widget's own state writes re-enter loadState through the file watch, so the
  // reconcile runs once per generation: a reload cannot re-arm it, and the
  // record of an arm this generation is running is skipped.
  function reconcilePersistedArms(): void {
    if (reconcileDone) return;
    reconcileDone = true;
    if (!isWriter) return;
    var plan = Memory.reconcileArms(state && state.arms ? state.arms : [], liveArmKey);
    if (plan === null) return;
    var next = JSON.parse(JSON.stringify(state));
    next.arms = plan.arms;
    writeState(next);
    retractClaim(plan.retract);
  }

  // ---------------------------------------------------------------------------
  // Poll timers, one per resource, each rescheduled from what that resource was
  // last seen doing.
  // ---------------------------------------------------------------------------

  function schedulePolls(): void {
    ramTimer.interval = pollMs("ram", ramReading === null ? 0 : ramReading.band, ramReading === null);
    vramTimer.interval = pollMs("vram", vramReading === null ? 0 : vramReading.band, vramReading === null);
    hdTimer.interval = pollMs("hd", worstHdBand(), hdDevices.length === 0);
  }

  function worstHdBand(): int {
    var worst = 0;
    for (var i = 0; i < hdDevices.length; i++) if (hdDevices[i].band > worst) worst = hdDevices[i].band;
    return worst;
  }

  // ---------------------------------------------------------------------------
  // State. Written only on change; a scan that exited non-zero records nothing;
  // deleting the state directory re-runs first run.
  // ---------------------------------------------------------------------------

  function loadState(raw): void {
    var parsed = Memory.normalizeSettings(parseJson(raw));
    state = parsed;
    stateLoaded = true;
    primed = parsed.primed;
    bands = parsed.bands;
    if (!stateDirDone) return;
    reconcilePersistedArms();
  }

  function parseJson(raw): var {
    var text = String(raw === undefined || raw === null ? "" : raw).trim();
    if (text === "") return {};
    try {
      return JSON.parse(text);
    } catch (e) {
      console.warn("memory-monitor: settings state is unreadable, falling back to the documented defaults");
      return {};
    }
  }

  function writeState(next): void {
    next.primed = primed;
    next.bands = bands;
    state = next;
    var payload = JSON.stringify(next);
    if (payload === lastStateWrite) return;
    lastStateWrite = payload;
    stateWritten = true;
    stateFile.setText(payload);
  }

  function saveState(): void {
    var next = JSON.parse(JSON.stringify(state));
    if (!next.firstRunAt) next.firstRunAt = new Date().toISOString();
    writeState(next);
  }

  // ---------------------------------------------------------------------------
  // Onboarding: the ceiling question and the insist-guard ask. Both are notices
  // that must be answered, so both ride the never-expiring lane, and both carry
  // a stable identity so a shell restart replaces them instead of stacking a
  // second copy of a restart-surviving notice.
  // ---------------------------------------------------------------------------

  function evaluateOnboarding(): void {
    if (!onboardingEnabled || !stateLoaded || !scanDone) return;
    if (!state.ceilingsAsked) askCeilings();
    if (!state.guardAsked) askGuard();
  }

  function baselineResting(): var {
    logFile.reload();
    return Memory.restingFromLog(logFile.text());
  }

  function askCeilings(): void {
    if (!isWriter) return;
    if (Memory.onboardingNoticePending(noticeQueue, activeNotice, "ceilings")) return;
    var resting = baselineResting();
    var notice = {
      kind: "ceilings",
      key: "ceilings",
      id: Memory.memId("ceilings"),
      type: "ram",
      band: 3,
      pct: ramReading === null ? null : ramReading.pct,
      guardState: "off",
      title: "Memory Monitor - your ceilings",
      resting: resting,
      body: Memory.ceilingsQuestion("ram", ramReading, oomd, state.thresholds, resting)
        + "\n\n" + Memory.ceilingsQuestion("vram", vramReading, oomd, state.thresholds, resting)
        + "\n\n" + Memory.ceilingsQuestion("hd", hdRows.length > 0 ? hdRows[0] : null, oomd, state.thresholds, resting),
      replaceId: state.ceilingsAskId,
      at: new Date().toISOString(),
    };
    notice.delivered = Memory.deliveryVerdict({ band: 3 }, dnd);
    recordAlertEvent(notice);
    noticeQueue = noticeQueue.concat([notice]);
    fireNextNotice();
  }

  function askGuard(): void {
    if (!isWriter) return;
    if (Memory.onboardingNoticePending(noticeQueue, activeNotice, "guard-ask")) return;
    var notice = {
      kind: "guard-ask",
      key: "guard-ask",
      id: Memory.memId("guard-ask"),
      type: "ram",
      band: 3,
      pct: null,
      title: Memory.guardAskTitle(),
      body: Memory.guardAskBody(state),
      replaceId: state.guardAskId,
      at: new Date().toISOString(),
    };
    notice.delivered = Memory.deliveryVerdict(notice, dnd);
    recordAlertEvent(notice);
    noticeQueue = noticeQueue.concat([notice]);
    fireNextNotice();
  }

  function answerGuardAsk(): void {
    root.broadcast("applyGuardAnswer");
  }

  function applyGuardAnswer(): void {
    var next = JSON.parse(JSON.stringify(state));
    next.guard = true;
    next.guardAsked = true;
    writeState(next);
  }

  function declineGuardAsk(): void {
    var next = JSON.parse(JSON.stringify(state));
    next.guard = false;
    next.guardAsked = true;
    writeState(next);
  }

  function setCeiling(type, level, value): var {
    var next = JSON.parse(JSON.stringify(state));
    var result = Memory.setCeiling(next, type, level, value);
    if (!result.ok) return result;
    next.thresholds = result.thresholds;
    writeState(next);
    return result;
  }

  // ---------------------------------------------------------------------------
  // The baseline log. Absolute numbers, one row per sample, one writer per
  // sample, appended without a shell and rotated by a window, not a truncate.
  // ---------------------------------------------------------------------------

  function appendLog(): void {
    if (pendingAlertEvents.length === 0 && ramReading === null && vramReading === null && hdDevices.length === 0) return;
    var record = Memory.logRecord({
      at: new Date().toISOString(),
      hd: hdRows,
      ram: ramReading,
      vram: vramReading,
      oomd: oomd,
      thresholds: state.thresholds,
      guard: state.guard,
      arm: arm,
      alerts: pendingAlertEvents,
    });
    pendingAlertEvents = [];
    var line = Memory.logLine(record);
    logBytesWritten += line.length + 1;
    logAppendProc.write(line + "\n");
    var plan = Memory.logRotatePlan(logBytesWritten, Memory.logMaxBytes(), Memory.logMaxLines());
    if (plan.rotate) {
      logBytesWritten = 0;
      logRotateProc.command = Memory.logRotateArgs(baselinePath, plan.keepLines);
      logRotateProc.running = true;
    }
  }

  function openDetail(): void {
    root.broadcast("showDetail");
  }

  function showDetail(): void {
    open();
  }

  // ---------------------------------------------------------------------------
  // State carried for the lanes above.
  // ---------------------------------------------------------------------------

  property var latchedMap: ({})
  property var deviceTargets: ({})
  property bool psiStalledLast: false
  property bool swapEscalatedLast: false
  property var activeAlert: null
  property var activeNotice: null
  property bool noticePreempting: false
  property var notifyProcArgs: []
  property var noticeProcArgs: []
  property string noticePrintedId: ""
  property var pendingAlertEvents: []
  property var unseenAlerts: []
  property int logBytesWritten: 0
  property bool stateDirDone: false
  property bool reconcileDone: false
  property bool stateWritten: false
  property string lastStateWrite: ""
  property string vramVerdict: ""

  // ---------------------------------------------------------------------------
  // Readers. Every argv is typed and comes from memory.js; none of them carries
  // a user-configured mount path, so a configured path can never become an argv.
  // ---------------------------------------------------------------------------

  Process {
    id: ramProc
    command: Memory.meminfoArgs()
    stdout: StdioCollector {
      onStreamFinished: {
        root.meminfoText = this.text;
        root.markDone("meminfo");
      }
    }
    stderr: StdioCollector {
      onStreamFinished: if (this.text.trim() !== "") console.warn("memory-monitor: meminfo:", this.text.trim())
    }
    onExited: function(exitCode, exitStatus) {
      if (exitCode !== 0) root.markFailed("meminfo", "exit " + exitCode);
    }
  }

  Process {
    id: psiProc
    command: Memory.psiArgs()
    stdout: StdioCollector {
      onStreamFinished: {
        root.psiText = this.text;
        root.markDone("psi");
      }
    }
    stderr: StdioCollector { onStreamFinished: void this.text }
    onExited: function(exitCode, exitStatus) {
      if (exitCode !== 0) root.markFailed("psi", Memory.degradationText("psi-missing"));
    }
  }

  Process {
    id: swapsProc
    command: Memory.swapsArgs()
    stdout: StdioCollector {
      onStreamFinished: {
        root.swapsText = this.text;
        root.markDone("swaps");
      }
    }
    stderr: StdioCollector { onStreamFinished: void this.text }
    onExited: function(exitCode, exitStatus) {
      if (exitCode !== 0) root.markFailed("swaps", "exit " + exitCode);
    }
  }

  Process {
    id: zramProc
    command: Memory.zramctlArgs()
    stdout: StdioCollector {
      onStreamFinished: {
        root.zramText = this.text;
        root.markDone("zram");
      }
    }
    stderr: StdioCollector { onStreamFinished: void this.text }
    onExited: function(exitCode, exitStatus) {
      if (exitCode !== 0) root.markFailed("zram", Memory.degradationText("zramctl-missing"));
    }
  }

  Process {
    id: dfProc
    command: ["findmnt"].concat(Memory.findmntArgs())
    stdout: StdioCollector {
      onStreamFinished: {
        root.findmntText = this.text;
        root.markDone("findmnt");
      }
    }
    stderr: StdioCollector {
      onStreamFinished: if (this.text.trim() !== "") console.warn("memory-monitor: findmnt:", this.text.trim())
    }
    onExited: function(exitCode, exitStatus) {
      if (exitCode !== 0) root.markFailed("findmnt", "exit " + exitCode);
    }
  }

  Process {
    id: gpuProc
    command: Memory.nvidiaGpuArgs()
    stdout: StdioCollector {
      onStreamFinished: {
        root.gpuText = this.text;
        root.markDone("gpu");
        if (Memory.parseNvidiaGpu(root.gpuText) !== null) appsProc.running = true;
        else markDone("apps");
      }
    }
    stderr: StdioCollector {
      onStreamFinished: {
        root.gpuText = root.gpuText + "\n" + this.text;
        if (this.text.trim() !== "") console.warn("memory-monitor: nvidia-smi:", this.text.trim())
      }
    }
    onExited: function(exitCode, exitStatus) {
      if (exitCode !== 0) root.markFailed("apps", Memory.nvidiaMissingVerdict(root.gpuText));
    }
  }

  Process {
    id: appsProc
    command: Memory.nvidiaAppsArgs()
    stdout: StdioCollector {
      onStreamFinished: {
        root.appsText = this.text;
        root.markDone("apps");
      }
    }
    stderr: StdioCollector { onStreamFinished: void this.text }
    onExited: function(exitCode, exitStatus) {
      if (exitCode !== 0) root.markFailed("apps", Memory.nvidiaMissingVerdict(root.appsText));
    }
  }

  // oomd is discovered, never assumed: its live limits and watched cgroup are
  // shown beside the user's own ceiling as "the kernel's ceiling".
  Process {
    id: oomdProc
    command: Memory.oomdActiveArgs()
    stdout: StdioCollector {
      onStreamFinished: {
        root.oomdActiveText = this.text.trim();
        if (Memory.parseOomdActive(root.oomdActiveText)) oomctlProc.running = true;
        else {
          root.oomd = { oomdActive: false, oomdSwapLimitPct: null, oomdPsiLimitPct: null, oomdWatchedCgroup: "" };
        }
      }
    }
    stderr: StdioCollector { onStreamFinished: void this.text }
    onExited: function(exitCode, exitStatus) {
      if (exitCode !== 0) root.oomd = { oomdActive: false, oomdSwapLimitPct: null, oomdPsiLimitPct: null, oomdWatchedCgroup: "" };
    }
  }

  Process {
    id: oomctlProc
    command: Memory.oomctlArgs()
    stdout: StdioCollector {
      onStreamFinished: root.oomd = Memory.parseOomctl(this.text)
    }
    stderr: StdioCollector { onStreamFinished: void this.text }
    onExited: function(exitCode, exitStatus) {
      if (exitCode !== 0) root.oomd = { oomdActive: false, oomdSwapLimitPct: null, oomdPsiLimitPct: null, oomdWatchedCgroup: "" };
    }
  }

  property string oomdActiveText: ""

  // ---------------------------------------------------------------------------
  // Notification lanes. `notifyProc` is the watchdog-released amber lane;
  // `noticeProc` is the never-expiring red/critical lane that no timer releases.
  // ---------------------------------------------------------------------------

  Process {
    id: notifyProc
    command: ["true"]
    stdout: StdioCollector { onStreamFinished: void this.text }
    stderr: StdioCollector {
      onStreamFinished: if (this.text.trim() !== "") console.warn("memory-monitor: notify-send:", this.text.trim())
    }
    onStarted: alertWatchdog.restart()
    onExited: function(exitCode, exitStatus) {
      alertWatchdog.stop();
      root.activeAlert = null;
      if (exitCode !== 0) console.warn("memory-monitor: notify-send failed for an alert");
      root.alertQueue = root.alertQueue.slice(1);
      root.fireNextAlert();
    }
  }

  Process {
    id: noticeProc
    command: ["true"]
    // Every notice on this lane carries -p, and the printed id is what lets an
    // escalation replace this notice while it is still on the screen and what
    // lets a later generation retract the claim when the arm it names dies. The
    // id is read as it arrives, not when the popup closes.
    stdout: SplitParser {
      splitMarker: "\n"
      onRead: (line) => {
        var id = Memory.parsePrintedId(line);
        if (id !== "") {
          root.noticePrintedId = id;
          var ownClaim = root.arm !== null && root.arm.outcome === "started"
            && root.activeNotice === root.armClaimNotice
            && Memory.isArmClaimNotice(root.arm, root.activeNotice);
          if (ownClaim) {
            root.arm = Memory.armRecord(Object.assign({}, root.arm, { claimId: id }));
            var next = JSON.parse(JSON.stringify(state));
            var patched = Memory.patchArmClaimId(next.arms, root.arm.eventKey, id);
            if (patched !== next.arms) {
              next.arms = patched;
              writeState(next);
            }
          }
        }
      }
    }
    stderr: StdioCollector {
      onStreamFinished: if (this.text.trim() !== "") console.warn("memory-monitor: notify-send:", this.text.trim())
    }
    onExited: function(exitCode, exitStatus) {
      var notice = root.activeNotice;
      root.activeNotice = null;
      root.noticePreempting = false;
      if (notice !== null) {
        root.recordNoticeDelivered(notice, exitCode);
        var at = root.noticeQueue.indexOf(notice);
        if (at >= 0) root.noticeQueue = root.noticeQueue.slice(at + 1);
      }
      root.fireNextNotice();
    }
  }

  // A notice is recorded when it is delivered, not when it is queued: a notice
  // dropped on a machine that went away leaves no record, so the question is
  // asked again when it comes back. The captured notify-send id is what lets the
  // next shell start replace this notice instead of stacking a second copy.
  function recordNoticeDelivered(notice, exitCode): void {
    if (!isWriter) return;
    if (exitCode !== 0) return;
    var next = JSON.parse(JSON.stringify(state));
    if (notice.kind === "guard-ask") {
      next.guardAsked = true;
      next.guardAskId = noticePrintedId;
    }
    if (notice.kind === "ceilings") {
      next.ceilingsAsked = true;
      next.ceilingsAskId = noticePrintedId;
    }
    writeState(next);
  }

  Process {
    id: retractProc
    command: ["true"]
    stdout: StdioCollector { onStreamFinished: void this.text }
    stderr: StdioCollector {
      onStreamFinished: if (this.text.trim() !== "") console.warn("memory-monitor: retract:", this.text.trim())
    }
    onExited: function(exitCode, exitStatus) {
      if (exitCode !== 0) console.warn("memory-monitor:", Memory.degradationText("claim-unretractable"));
    }
  }

  // The guard itself: one agent arm at a time across the machine.
  Process {
    id: armProc
    command: ["true"]
    stdout: StdioCollector { onStreamFinished: void this.text }
    stderr: StdioCollector {
      onStreamFinished: if (this.text.trim() !== "") console.warn("memory-monitor: guard:", this.text.trim())
    }
    onExited: function(exitCode, exitStatus) {
      if (exitStatus !== undefined && exitStatus !== 0) finishArm("died", false, ["terminated by signal"]);
      else if (exitCode === 0) finishArm("survived", true, []);
      else finishArm("died", false, ["exit " + exitCode]);
    }
  }

  // ---------------------------------------------------------------------------
  // State files. The plugin's own settings, and the notification service's own
  // persisted Do Not Disturb flag - the plugin reads the daemon's setting rather
  // than guessing at what the daemon did with a toast.
  // ---------------------------------------------------------------------------

  Process {
    id: stateDirProc
    command: ["mkdir", "-p", Memory.stateDir(Quickshell.env("HOME"))]
    stderr: StdioCollector {
      onStreamFinished: if (this.text.trim() !== "") console.warn("memory-monitor: state dir:", this.text.trim())
    }
    onExited: function(exitCode, exitStatus) {
      if (exitCode !== 0) console.warn("memory-monitor: could not create the state dir, state stays in memory");
      root.stateDirDone = true;
      stateFile.reload();
    }
  }

  FileView {
    id: stateFile
    path: root.settingsPath
    watchChanges: true
    atomicWrites: true
    printErrors: false
    onLoaded: root.loadState(text())
    onFileChanged: reload()
    onLoadFailed: root.loadState("")
  }

  FileView {
    id: dndFile
    path: root.dndPath
    watchChanges: true
    blockWrites: true
    printErrors: false
    onLoaded: root.dnd = Memory.parseDnd(text())
    onFileChanged: reload()
    onLoadFailed: root.dnd = null
  }

  FileView {
    id: logFile
    path: root.baselinePath
    preload: false
    blockLoading: true
    blockAllReads: true
    blockWrites: false
    atomicWrites: true
    printErrors: false
    onSaved: void 0
    onSaveFailed: console.warn("memory-monitor:", Memory.degradationText("log-append-failed"))
  }

  Process {
    id: logAppendProc
    command: Memory.logAppendArgs(root.baselinePath)
    onExited: function(exitCode, exitStatus) {
      if (exitCode !== 0) console.warn("memory-monitor:", Memory.degradationText("log-append-failed"))
    }
    stderr: StdioCollector { onStreamFinished: void this.text }
  }

  Process {
    id: logRotateProc
    command: ["true"]
    stdout: StdioCollector {
      onStreamFinished: logFile.setText(this.text)
    }
    stderr: StdioCollector { onStreamFinished: void this.text }
    onExited: function(exitCode, exitStatus) {
      if (exitCode !== 0) console.warn("memory-monitor:", Memory.degradationText("log-append-failed"));
    }
  }

  // ---------------------------------------------------------------------------
  // Timers. The poll timers are per resource and reschedule themselves from what
  // that resource was last seen doing. The watchdogs release a wedged child, and
  // no timer ever releases the never-expiring notice lane.
  // ---------------------------------------------------------------------------

  Timer {
    id: ramTimer
    interval: 30000
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: root.startSample()
  }

  // One timer per monitored resource. Every timer starts the same single shared
  // sample (startSample guards against overlap), so the resource that most
  // recently earned a short interval is the one that decides when the next
  // sample runs; the others simply re-arm. A resource with no timer of its own
  // is a resource that stops being sampled while its ring keeps drawing.
  Timer {
    id: vramTimer
    interval: 60000
    repeat: true
    running: true
    onTriggered: root.startSample()
  }

  Timer {
    id: hdTimer
    interval: 60000
    repeat: true
    running: true
    onTriggered: root.startSample()
  }

  Timer {
    id: readWatchdog
    interval: 8000
    repeat: false
    onTriggered: if (root.cycleRunning) root.abandonCycle("readers timed out")
  }

  Timer {
    id: alertWatchdog
    interval: 120000
    repeat: false
    onTriggered: root.releaseActiveAlert("watchdog")
  }

  Timer {
    id: armWatchdog
    interval: Memory.guardArmTimeoutMs()
    repeat: false
    onTriggered: {
      console.warn("memory-monitor:", Memory.degradationText("agent-arm-died"));
      armProc.running = false;
      root.finishArm("died", false, ["watchdog timeout"]);
    }
  }

  Timer {
    id: healthTimer
    interval: 300000
    repeat: true
    running: true
    triggeredOnStart: true
    onTriggered: {
      if (!oomdProc.running) oomdProc.running = true;
    }
  }

  IpcHandler {
    target: Memory.ipcTarget()

    // Critical's click lands here. It never starts an agent: the budget gate
    // stays authoritative in exactly the states where the gate found no headroom
    // or the guard is off, and there is never a second agent on top of the armed
    // one.
    function openDetail(): void { root.openDetail() }
    function answerGuardAsk(): void { root.answerGuardAsk() }
    function refresh(): void { root.refresh() }
  }

  Component.onCompleted: {
    if (!stateDirProc.running) stateDirProc.running = true;
    if (!dndFile.loaded) dndFile.reload();
  }

  // ---------------------------------------------------------------------------
  // The bar. One badge, the most severe resource, or the plain white MM logo
  // when nothing is over a line. Severity carries shape as well as hue.
  // ---------------------------------------------------------------------------

  function barEntries(): var {
    var out = [];
    if (ramReading !== null) {
      var ram = JSON.parse(JSON.stringify(ramReading));
      ram.critical = thresholds("ram").critical;
      out.push(ram);
    }
    if (vramReading !== null) {
      var vram = JSON.parse(JSON.stringify(vramReading));
      vram.critical = thresholds("vram").critical;
      out.push(vram);
    }
    for (var i = 0; i < hdDevices.length; i++) {
      var device = JSON.parse(JSON.stringify(hdDevices[i]));
      device.critical = thresholds("hd").critical;
      out.push(device);
    }
    return out;
  }

  readonly property var badgeEntry: {
    var test = Memory.normalizeNumber(setting("testPct", -1), -1);
    var entries = barEntries();
    if (test >= 0) {
      var forced = [];
      for (var i = 0; i < entries.length; i++) {
        var copy = JSON.parse(JSON.stringify(entries[i]));
        copy.pct = test;
        copy.band = Memory.resolveBand(test, thresholds(copy.type), 0, copy.type).band;
        forced.push(copy);
      }
      entries = forced;
    }
    return Memory.mostSevereForBar(entries);
  }

  readonly property var badgeList: barEntries()

  BarIconButton {
    id: badge
    bar: root.bar
    opticalSize: 22
    tooltipText: Memory.barTooltip(badgeList)
    iconComponent: badgeComponent

    Component {
      id: badgeComponent

      Item {
        id: badgeItem
        readonly property var entry: root.badgeEntry
        readonly property int band: entry === null || entry === undefined ? 0 : (entry.band === undefined ? 0 : entry.band)
        readonly property real pct: entry === null || entry === undefined ? 0
          : Math.min(1, Math.max(0, (entry.pct === undefined || entry.pct === null ? 0 : entry.pct) / 100))
        readonly property string label: entry === null || entry === undefined ? Memory.barLogoText() : Memory.badgeLabel(entry.type)
        // The badge itself is RingKit's decision, not this widget's: shape, the
        // severity name, whether it pulses, whether it carries a halo, and which
        // palette token paints it. Severity carries shape as well as hue here so
        // amber-versus-red (the deuteranopia pair) survives without colour, and
        // one kernel means a bar with both plugins draws them the same way.
        readonly property var badge: RingKit.badgeParams(
          entry === null || entry === undefined ? "" : entry.type,
          band,
          entry !== null && entry !== undefined && entry.latched === true)
        readonly property string shape: badge.shape
        readonly property color strokeColor: badge.colorToken === "plain" ? Color.foreground : RingKit.paletteToken(badge.colorToken)
        readonly property bool pulse: badge.pulse
        property real glowPhase: 0

        SequentialAnimation {
          running: badgeItem.pulse
          loops: Animation.Infinite
          NumberAnimation { target: badgeItem; property: "glowPhase"; from: 0.0; to: 1.0; duration: 1000; easing.type: Easing.InOutSine }
          NumberAnimation { target: badgeItem; property: "glowPhase"; from: 1.0; to: 0.0; duration: 1000; easing.type: Easing.InOutSine }
        }

        Canvas {
          id: disc
          anchors.fill: parent
          onPaint: {
            var ctx = getContext("2d")
            ctx.reset()
            var w = width
            var h = height
            var cx = w / 2
            var cy = h / 2
            var lw = Math.min(w, h) * 0.10
            var r = Math.min(w, h) / 2 - lw / 2 - 0.5
            var band = badgeItem.band

            if (band === 0) {
              // No alert: the MM logo. A full ring, filled, white.
              ctx.beginPath()
              ctx.arc(cx, cy, r, 0, Math.PI * 2)
              ctx.lineWidth = lw
              ctx.strokeStyle = badgeItem.strokeColor
              ctx.globalAlpha = 1.0
              ctx.stroke()
              ctx.beginPath()
              ctx.arc(cx, cy, r - lw * 0.9, 0, Math.PI * 2)
              ctx.globalAlpha = 0.16
              ctx.fillStyle = badgeItem.strokeColor
              ctx.fill()
              return
            }

            if (band === 3) {
              // Critical adds the halo, breathing with the pulse.
              ctx.beginPath()
              ctx.arc(cx, cy, r + lw * 2.0, 0, Math.PI * 2)
              ctx.fillStyle = badgeItem.strokeColor
              ctx.globalAlpha = 0.10 + 0.24 * badgeItem.glowPhase
              ctx.fill()
            }

            // Amber is a partial fill; red and critical are full. That is the
            // shape half of the amber-versus-red distinction.
            var fillTo = badgeItem.shape === "hollow" ? badgeItem.pct : 1.0
            ctx.globalAlpha = 1.0
            ctx.beginPath()
            ctx.arc(cx, cy, r, 0, Math.PI * 2)
            ctx.lineWidth = lw
            ctx.strokeStyle = badgeItem.strokeColor
            ctx.globalAlpha = 0.25
            ctx.stroke()
            ctx.globalAlpha = band === 3 ? 0.55 + 0.45 * badgeItem.glowPhase : 1.0
            ctx.beginPath()
            ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * fillTo)
            ctx.stroke()

            // Red and critical carry a warning glyph, so the severity survives
            // without colour and the glyph carries the type.
            if (badgeItem.shape === "glyph" || badgeItem.shape === "pulse") {
              ctx.globalAlpha = band === 3 ? 0.6 + 0.4 * badgeItem.glowPhase : 1.0
              ctx.beginPath()
              var g = r * 0.62
              ctx.moveTo(cx, cy - g)
              ctx.lineTo(cx + g * 0.86, cy + g * 0.7)
              ctx.lineTo(cx - g * 0.86, cy + g * 0.7)
              ctx.closePath()
              ctx.lineWidth = lw * 0.7
              ctx.stroke()
            }
          }
          Connections {
            target: badgeItem
            function onBandChanged() { disc.requestPaint() }
            function onPctChanged() { disc.requestPaint() }
            function onStrokeColorChanged() { disc.requestPaint() }
            function onGlowPhaseChanged() { disc.requestPaint() }
            function onShapeChanged() { disc.requestPaint() }
          }
          Component.onCompleted: disc.requestPaint()
        }

        Text {
          anchors.centerIn: parent
          text: badgeItem.label
          color: badgeItem.strokeColor
          font.pixelSize: Math.max(5, Math.round(parent.height * (badgeItem.band >= 2 ? 0.34 : 0.36)))
          font.letterSpacing: 0.5
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // The detail window. A Panel in this same widget directory, mounted through a
  // Loader the way the shell's own panels are mounted, and injected with the bar
  // and the anchor button. The bar-widget root forwards open/close/opened, which
  // is the shape the bar's panel routing looks for.
  // ---------------------------------------------------------------------------

  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false

  function open(): void {
    unseenAlerts = [];
    if (panelLoader.item) panelLoader.item.open();
  }

  function close(): void {
    if (panelLoader.item) panelLoader.item.close();
  }

  function togglePanel(): void {
    if (panelLoader.item) panelLoader.item.toggle();
  }

  readonly property bool popoutSwitchClosing: panelLoader.item ? panelLoader.item.popoutSwitchClosing === true : false

  function closeForPopoutSwitch(): void {
    if (panelLoader.item) panelLoader.item.closeForPopoutSwitch();
  }

  function injectPanel(): void {
    var target = panelLoader.item;
    if (!target) return;
    if ("bar" in target) target.bar = root.bar;
    if ("settings" in target) target.settings = root.settings;
    if ("moduleName" in target) target.moduleName = root.moduleName;
    if ("anchorItem" in target) target.anchorItem = badge;
    if ("hostWidget" in target) target.hostWidget = root;
    if ("monitor" in target) target.monitor = root;
  }

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("MemoryPanel.qml")
    visible: false
    onLoaded: {
      root.injectPanel();
      Qt.callLater(root.injectPanel);
    }
  }

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  implicitWidth: badge.implicitWidth
  implicitHeight: badge.implicitHeight

  // No alert hue is written here. The badge asks RingKit for its palette token,
  // so a bar carrying both plugins cannot draw two different ambers or reds.
}
