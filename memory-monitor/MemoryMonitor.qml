import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "memory.js" as Memory
import "quattro.js" as Quattro
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
// The bar shows one emblem: the QuattroDash check-engine telltale (the ISO
// artwork QuattroSymbol renders), plain white when nothing is over a line and
// tinted by the most severe resource — amber, red, and critical's pulse — with
// severity, the palette token and the pulse still RingKit's decision
// (badgeParams), so a bar carrying both plugins draws one severity language.
// Clicking it opens the QuattroDash; the detail window keeps the critical
// click and the openDetail IPC.
//
// Toasts are events, not states: an alert fires on a band ascent or on one of
// memory.js's re-fire conditions (severity increase, PSI crossing the stall
// floor, swap crossing the kernel's swap limit), never on a resource merely
// sitting in a band. `primed` is carried, so a shell restart does not re-toast a
// band that was already held.
//
// Round 7: every toast rides normal urgency with a finite timeout — the tinted
// logo carries the severity — so a toast of any band can be silenced by Do Not
// Disturb, and is recorded when it is, in the log and in the panel's "Alerts
// you did not see". Red and critical keep their own process lane,
// watchdog-released like the amber one, and a persisted exec hint keeps a
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
  // QuattroDash's root-drive reading (memory.js rootDriveReading). A reading,
  // not a watch decision: it feeds the fuel gauge whether or not the watch
  // list covers root, and it never produces an alert.
  property var rootReading: null

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
  //      `noticeQueue` is the red/critical/question lane, watchdog-released
  //      too (round 7: every toast is temporary). Band escalation preempts an
  //      unanswered lower-band toast rather than queueing behind it.
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

  // The QuattroDash coolant card's floor, the PR-18 way: this plugin's own
  // vramFloorMib setting in MiB, 500 MiB when unset (the captain's
  // 2026-11-06 defaults steer, amber then at 1500 via quattro.js's 1000 MiB
  // approach margin), read through the memory.js normalizer. A display
  // floor, never an alert ceiling.
  function vramFloorMib(): int {
    return Memory.vramFloorMib(setting("vramFloorMib", null));
  }

  // ---------------------------------------------------------------------------
  // Polling. The lax nominal intervals are for normal passive use with every
  // resource green and no window open: a red or critical band drops to the
  // escalated interval, a stalling PSI reading further, and round 8 ruling 1's
  // watch lane - any monitored resource amber or worse, or a Quattro Dash window
  // open - to 2 seconds. A vanished mount stays at the nominal interval.
  // ---------------------------------------------------------------------------

  // The worst band across everything this widget monitors, watch-lane material.
  // The shared sample reads all three resources anyway (startSample starts every
  // reader), so one resource going amber shortens every timer, not just its own.
  function watchBand(): int {
    var worst = ramReading === null ? 0 : ramReading.band;
    if (vramReading !== null && vramReading.band > worst) worst = vramReading.band;
    if (worstHdBand() > worst) worst = worstHdBand();
    return worst;
  }

  function pollMs(type, band, absent): int {
    var override = Memory.normalizeNumber(setting("pollMs", -1), -1);
    var value = Memory.pollIntervalMs(type, band, {
      absent: absent,
      psi: psi,
      psiFloor: Memory.PSI_STALL_FLOOR,
      windowOpen: root.anySurfaceOpen,
      watchBand: root.watchBand(),
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
  // Round 8 ruling 3's second half, the swap climb telltale's own memory: the
  // last few swap readings this widget took, oldest first, each { atMs, usedKb }.
  // It is the same /proc/swaps total the RAM reading already carries, remembered
  // a few cycles longer, and nothing else - no second measurement, no second
  // reader. A widget generation starts empty, so an offline gap is a gap and
  // never reads as a jump.
  property var swapSamples: ([])
  property string zramText: ""
  property string findmntText: ""
  property string gpuText: ""
  property string appsText: ""
  property var cycleFailures: ({})

  // Round 9: the system fault codes ride this same sample. Five cheap reads
  // (bar probe, kernel delta, wedge grep, unit show, IO PSI) join the cycle,
  // and the decisions - argvs, parsers, thresholds, copy - stay in quattro.js.
  property string barProbeText: ""
  property int barProbeExit: -1
  property string kernelJournalText: ""
  property bool kernelJournalOk: false
  property string wedgeJournalText: ""
  property int wedgeJournalExit: -1
  property string unitShowText: ""
  property bool unitShowOk: false
  property string ioPsiText: ""
  property bool ioPsiOk: false
  // Session state the decoders need: the kernel cursor (epoch of the newest
  // fault line already seen), the layer climb memory and the disk amber run.
  // None of it persists: a shell restart re-baselines, so "since the last
  // look" always means a look this monitor made.
  property var sysKernelCursor: null
  property var sysLayerPrev: null
  property var sysDiskPrev: null
  // The merged system code entries the dashboard reads.
  property var sysCodes: []

  readonly property var readNames: ["meminfo", "psi", "swaps", "zram", "findmnt", "gpu", "apps", "bar", "kernel", "wedge", "units", "iopsi"]

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
    barProc.running = true;
    kernelProc.running = true;
    wedgeProc.running = true;
    unitsProc.running = true;
    ioPsiProc.running = true;
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
    if (barProc.running) barProc.running = false;
    if (kernelProc.running) kernelProc.running = false;
    if (wedgeProc.running) wedgeProc.running = false;
    if (unitsProc.running) unitsProc.running = false;
    if (ioPsiProc.running) ioPsiProc.running = false;
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
    buildSystemCodes();
    evaluateBands();
    rebindDisplayBands();
    if (isWriter) appendLog();
    schedulePolls();
    evaluateOnboarding();
  }

  // Round 9: decode the five system reads into the merged codes column. Every
  // decision (thresholds, sustain, climb, copy) is quattro.js's; this only
  // carries the session state between polls: the kernel cursor, the layer
  // climb memory, the disk amber run. An abandoned cycle reads as unreadable,
  // and an unreadable read renders the honest unknown row, never a healthy
  // zero.
  function buildSystemCodes(): void {
    var bar = Quattro.barSysCode(Quattro.parseBarProbe(barProbeText), barProbeExit);
    var kernel = Quattro.kernelSysCode(Quattro.parseJournalLines(kernelJournalText), kernelJournalOk, sysKernelCursor);
    sysKernelCursor = kernel.cursor;
    var gpu = Quattro.gpuSysCode(wedgeJournalText, wedgeJournalExit);
    var layer = Quattro.layerSysCode(Quattro.parseUnitShow(unitShowText), unitShowOk, sysLayerPrev);
    sysLayerPrev = layer.next;
    var disk = Quattro.diskSysCode(Quattro.parseIoPsi(ioPsiText), ioPsiOk, sysDiskPrev);
    sysDiskPrev = disk.next;
    sysCodes = [bar, kernel.entry, gpu].concat(layer.entries, [disk.entry])
      .filter(function (c) { return c !== null && c !== undefined; });
  }

  function buildReadings(): void {
    var meminfo = Memory.parseMeminfo(meminfoText);
    psi = Memory.parsePsi(psiText);
    swaps = Memory.parseSwaps(swapsText);
    zram = Memory.parseZramctl(zramText);
    var swap = Memory.swapTotals(swaps);
    root.recordSwapSample(swap);
    var climb = root.swapClimbBand();
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
      // Which signal holds the band, so the panel's release note speaks the
      // right unit (PSI for pressure, percent used for the reserve).
      ram.signal = Memory.resolveRamBand(ram, thresholds("ram"), bandOf("ram"), gaugePairFor("batt"), climb).signal;
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
    rootReading = Memory.rootDriveReading(findmntText);
    // The rebuilt rows carry the held band the way ram.band carries bandOf
    // above — before the assignment, because the badge and tooltip bindings
    // evaluate on the assignment itself and never see a later in-place fix. A
    // row rebuilt at band 0 drops a held band off the bar until the next
    // escalation re-fires it.
    var devices = Memory.groupHdByDevice(hdRows, latchedMap);
    for (var h = 0; h < devices.length; h++) devices[h].band = bandOf(devices[h].key);
    hdDevices = devices;
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

  // The display rows carry the band the bands memory held BEFORE this sample
  // (buildReadings binds it, so a held band never drops off the bar); this is
  // the release direction. On the sample that releases a band, evaluateBands()
  // has already written the released band into the bands memory while the rows
  // still carry the stale one — an early-returning applyBand never touches the
  // entry when nothing fires — so the badge tooltip would keep the red dot
  // for one sample after the red band has gone. Rebind from the band
  // memory evaluateBands just wrote. The copy-and-reassign is not a style
  // choice: the badge and tooltip bindings evaluate on the property assignment
  // itself and never see a later in-place fix (see buildReadings).
  function rebindDisplayBands(): void {
    if (ramReading !== null) {
      var ram = JSON.parse(JSON.stringify(ramReading));
      ram.band = bandOf("ram");
      ram.latched = latchedOf("ram");
      ram.signal = Memory.resolveRamBand(ram, thresholds("ram"), bandOf("ram"), gaugePairFor("batt"), root.swapClimbBand()).signal;
      ramReading = ram;
    }
    if (vramReading !== null) {
      var vram = JSON.parse(JSON.stringify(vramReading));
      vram.band = bandOf("vram");
      vram.latched = latchedOf("vram");
      vramReading = vram;
    }
    var rows = [];
    for (var i = 0; i < hdDevices.length; i++) {
      var row = JSON.parse(JSON.stringify(hdDevices[i]));
      row.band = bandOf(row.key);
      row.latched = latchedOf(row.key);
      rows.push(row);
    }
    hdDevices = rows;
  }

  function applyBand(key, type, pct, ceiling, latchedTarget, entry): void {
    var previous = bandOf(key);
    var result;
    if (type === "ram") {
      // Round 7 item 8: the ram store watches PRESSURE (PSI) and the swap
      // reserve. The held band is the more severe of the two signals' bands,
      // each hysteresized against the same previous band in its own unit.
      result = Memory.resolveRamBand(ramReading, ceiling, previous, gaugePairFor("batt"), root.swapClimbBand());
    } else {
      result = Memory.resolveBand(pct, ceiling, previous, type);
    }
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
    // The toast says the signal's own number: PSI for a pressure band, the
    // used percent for a swap band. The MemAvailable percent is data for the
    // agent's block, never the toast's headline number.
    var signalPct = entry === null || entry === undefined ? undefined : entry.pct;
    if (type === "ram" && ramReading !== null) {
      signalPct = result.signal === "swap" ? ramReading.swapPct : ramReading.psiSomeAvg10;
    }
    queueAlert(entry, held, type, key, result.latched, result.signal, signalPct, result.rate);
  }

  // ---------------------------------------------------------------------------
  // Alert events. Every event is logged with a delivery verdict, because the
  // daemon drops a silenced amber without keeping a record of dropping it.
  // ---------------------------------------------------------------------------

  function alertEvent(entry, band, type, key, latched, signal, signalPct, rate): var {
    var base = entry === null || entry === undefined ? {} : entry;
    return {
      kind: "band",
      key: key,
      id: base.id === undefined ? Memory.memId(key) : base.id,
      type: type,
      band: band,
      // Round 7 item 8: a ram alert's pct is the signal's own reading, so the
      // toast and the agent prompt never print MemAvailable percent as PSI.
      pct: signalPct === undefined ? base.pct : signalPct,
      latched: latched,
      // Round 7 item 8: which ram signal produced the band, so the toast can
      // say pressure or swap. Absent for hd and vram.
      signal: signal === undefined ? undefined : signal,
      // Round 8 ruling 3: a swap band the climb produced says so, so the toast
      // and the prompt never quote a low percent as if it were a crossed line.
      // Absent for every other alert, like signal.
      rate: rate === undefined ? undefined : rate === true,
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

  function queueAlert(entry, band, type, key, latched, signal, signalPct, rate): void {
    if (!isWriter) return;
    if (band === 0) return;
    var alert = alertEvent(entry, band, type, key, latched, signal, signalPct, rate);

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
      iconDir: root.iconDir,
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
    if (type === "sys") return event === undefined || event === null ? null : event.detail;
    return Memory.hdRowFor(hdRows, event ? event.key : (activeAlert ? activeAlert.key : ""));
  }

  function releaseActiveAlert(reason): void {
    if (!notifyProc.running) return;
    console.warn("memory-monitor: released an alert:", reason);
    notifyProc.running = false;
  }

  // ---------------------------------------------------------------------------
  // The notice lane: red, critical and the questions. Its own process, because
  // notify-send blocks while its action is live. Round 7 released it too: a
  // stuck question cannot wedge the lane forever.
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
      iconDir: root.iconDir,
      clickArgv: clickArgv,
      printId: true,
      replaceId: alert.replaceId === undefined ? "" : alert.replaceId,
    });
    noticeProcArgs = args;
    noticePrintedId = "";
    noticeProc.command = args;
    noticeProc.running = true;
    noticeWatchdog.restart();
    // A question is not an emergency: the ceiling question and the guard ask ride
    // the notice lane so they stay on screen, and neither one arms an agent.
    if (Memory.isArmNotice(alert) && guardState === "armed") startArm(alert);
  }

  function releaseActiveNotice(reason): void {
    if (!noticeProc.running) return;
    console.warn("memory-monitor: released a notice:", reason);
    noticeWatchdogFired = true;
    noticeProc.running = false;
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

  // fromDash marks the QuattroDash's critical-band code click: an arm with no
  // claim notice behind it, so it captures no printed id and a later death
  // retracts by a fresh toast instead of by a notice it never showed.
  // diagnosisJsonText is the dash's pre-computed diagnosis (round 2, item 8):
  // a critical code's click arms with the same fenced block a moderate
  // click's prompt carries. Queue-time arms pass nothing and keep the plain
  // prompt.
  function startArm(alert, fromDash, diagnosisJsonText): void {
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
        signal: alert.signal,
        outcome: decision.reason === "no headroom for the guard" ? "refused" : "skipped",
        reasons: budget.reasons.concat([decision.reason]),
        startedAt: new Date().toISOString(),
      });
      recordArm(arm);
      return;
    }
    var prompt = Memory.agentPrompt(alert, readingFor(alert.type, alert), oomd, baselinePath);
    if (diagnosisJsonText !== undefined && diagnosisJsonText !== null && diagnosisJsonText !== "") {
      prompt = Memory.promptWithDiagnosis(prompt, diagnosisJsonText);
    }
    var argv = Memory.normalizeBool(setting("agentInline", false), false)
      ? Memory.agentArgvWithInline(prompt, agentCommandArgv())
      : Memory.agentArgv(prompt, agentCommandArgv());
    liveArmKey = eventKey;
    if (fromDash !== true) armClaimNotice = alert;
    arm = Memory.armRecord({
      eventKey: eventKey,
      type: alert.type,
      band: alert.band,
      key: alert.key,
      id: alert.id,
      pct: alert.pct,
      // The signal rides the record so a restart's retraction toast names the
      // same signal and unit the original toast did.
      signal: alert.signal,
      target: alert.target,
      outcome: "started",
      startedAt: new Date().toISOString(),
      claimId: fromDash === true ? "" : noticePrintedId,
      inline: Memory.normalizeBool(setting("agentInline", false), false),
    });
    recordArm(arm);
    armProc.command = argv;
    armProc.running = true;
    armWatchdog.restart();
  }

  // The QuattroDash's critical-band code click is a critical dispatch, so it
  // rides the arm: the same gate chain the queue-time arm passes, and the same
  // launch through startArm, which is what keeps the machine's single-flight
  // lane the one guarantee there is never a second agent on top of the armed
  // one. The refusal rides back to the dash so it can say so in words. The
  // dash's diagnosis rides with it when the click brought one.
  function dispatchCriticalCode(alert, diagnosisJsonText): var {
    var budget = Memory.armBudgetCheck(ramReading, oomd, { psiFloor: Memory.PSI_STALL_FLOOR });
    var decision = Memory.shouldStartArm({
      band: alert.band,
      guard: guardOn(),
      armLive: Memory.armIsLive(arm),
      budgetOk: budget.ok,
      writer: isWriter,
    });
    if (decision.start) startArm(alert, true, diagnosisJsonText);
    return { started: decision.start, why: decision.why };
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
    var plan = Memory.retractClaimFor(record, { iconDir: root.iconDir });
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

  // The climb telltale's history, and the verdict memory.js reads off it. The
  // widget keeps the samples; memory.js owns the GiB floor a step must clear,
  // how stale a gap may be, how many intervals a rate needs, and what a climb
  // is worth (amber, never red).
  function recordSwapSample(swap): void {
    if (swap === null || swap === undefined) return;
    if (swap.swapTotalKb === null || swap.swapTotalKb === undefined) return;
    if (swap.swapUsedKb === null || swap.swapUsedKb === undefined) return;
    var next = JSON.parse(JSON.stringify(root.swapSamples));
    next.push({ atMs: Date.now(), usedKb: swap.swapUsedKb });
    while (next.length > Memory.SWAP_CLIMB_STEPS + 2) next.shift();
    root.swapSamples = next;
  }

  function swapClimbBand(): int {
    return Memory.swapClimbBand(root.swapSamples);
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
    lastStateWriteAt = new Date().getTime();
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
  // that must be answered, so both ride the notice lane, and both carry
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
      title: "Quattro Dash - your ceilings",
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
  // The QuattroDash gauge threshold settings (the captain's 2026-11-07 ruling):
  // one amber/red pair per gauge, editable from the dash's settings row, and
  // persisted in the plugin state file. The RAM pressure and root drive pairs
  // ARE the plugin's alert ceilings, so they write through Memory.setCeiling
  // and nothing else; the swap-reserve ticks and the coolant thresholds are
  // display pairs stored beside them under gaugeSettings. The ordering law
  // (red never below amber, inverted for the reserve and coolant marks)
  // lives in quattro.js's slider model and is enforced mechanically, never
  // in words.
  //
  // A drag lands here per movement, so the disk write is coalesced: the state
  // updates live in memory and one timer flushes it once the dragging stops.
  // ---------------------------------------------------------------------------

  function gaugePairFor(key): var {
    if (key === "psi") return Quattro.gaugePair(key, {
      amber: thresholds("ram").amber,
      red: thresholds("ram").red,
    });
    if (key === "hd") return Quattro.gaugePair(key, {
      amber: thresholds("hd").amber,
      red: thresholds("hd").red,
    });
    var stored = state && state.gaugeSettings ? state.gaugeSettings[key] : null;
    if (key === "vram" && (stored === null || stored === undefined)) {
      // No dash pair yet: the PR-18 floor chain stays the red line, and the
      // amber rides the same fixed margin above it quattro.js has always drawn.
      // A pair the slider scale cannot hold returns before gaugePair(), whose
      // clamp would pull the clipped lines onto GAUGE_MIB_MAX and recolor
      // the bands.
      var floor = vramFloorMib();
      if (floor + Quattro.VRAM_AMBER_MARGIN_MIB > Quattro.GAUGE_MIB_MAX)
        return { amber: floor + Quattro.VRAM_AMBER_MARGIN_MIB, red: floor };
      return Quattro.gaugePair(key, { amber: null, red: floor });
    }
    return Quattro.gaugePair(key, stored);
  }

  function setGaugePair(key, which, value): var {
    var next = Quattro.adjustGaugePair(key, which, value, gaugePairFor(key));
    var merged = JSON.parse(JSON.stringify(state));
    if (key === "psi" || key === "hd") {
      var type = key === "psi" ? "ram" : "hd";
      // The ceiling store demands strictly amber < red, so the pair lands in
      // three always-valid steps: lift red above both targets, drop amber in,
      // then set red. Every step validates on its own; none reorders silently.
      // A step whose level already sits at its target is skipped, so a level
      // the drag never moved keeps its provenance. A step the critical ceiling
      // blocks is not silent either: the refused drag hands the dash
      // quattro.js's toast naming the critical line, and returns without
      // touching the stored state.
      var cur = thresholds(type);
      var steps = [
        ["red", Math.max(cur.red, next.amber + 1, next.red)],
        ["amber", next.amber],
        ["red", next.red],
      ];
      var out = merged.thresholds;
      for (var i = 0; i < steps.length; i++) {
        if (steps[i][1] === Memory.thresholdsFor({ thresholds: out }, type)[steps[i][0]]) continue;
        var step = Memory.setCeiling({ thresholds: out }, type, steps[i][0], steps[i][1]);
        if (!step.ok) return Quattro.ceilingBlockedToast(key, cur.critical, next.red);
        out = step.thresholds;
      }
      merged.thresholds = out;
    } else {
      var gauge = JSON.parse(JSON.stringify(merged.gaugeSettings || {}));
      gauge[key] = next;
      merged.gaugeSettings = gauge;
    }
    state = merged;
    gaugeSaveTimer.restart();
    return null;
  }

  function resetGaugeSettings(): var {
    var merged = JSON.parse(JSON.stringify(state));
    var thresholds = merged.thresholds;
    var pairs = { psi: Quattro.GAUGE_DEFAULTS.psi, hd: Quattro.GAUGE_DEFAULTS.hd };
    for (var key in pairs) {
      var type = key === "psi" ? "ram" : "hd";
      // The same three always-valid steps, so a reset works from any current
      // pair, however far it sits above or below the recommended defaults, and
      // a level already at its target is skipped so untouched provenance stays.
      // A user-set critical ceiling can block the restore (critical must sit
      // above red, and the recommended red may climb past it): the reset then
      // says which gauge's critical line blocked it, through quattro.js's
      // toast, and touches nothing. Critical ceilings are the user's own and
      // reset never lowers one.
      var cur = Memory.thresholdsFor({ thresholds: thresholds }, type);
      var steps = [
        ["red", Math.max(cur.red, pairs[key].amber + 1, pairs[key].red)],
        ["amber", pairs[key].amber],
        ["red", pairs[key].red],
      ];
      for (var i = 0; i < steps.length; i++) {
        if (steps[i][1] === Memory.thresholdsFor({ thresholds: thresholds }, type)[steps[i][0]]) continue;
        var step = Memory.setCeiling({ thresholds: thresholds }, type, steps[i][0], steps[i][1]);
        if (!step.ok) return Quattro.ceilingBlockedToast(key, cur.critical, pairs[key].red);
        thresholds = step.thresholds;
      }
    }
    merged.thresholds = thresholds;
    merged.gaugeSettings = {
      batt: JSON.parse(JSON.stringify(Quattro.GAUGE_DEFAULTS.batt)),
      vram: JSON.parse(JSON.stringify(Quattro.GAUGE_DEFAULTS.vram)),
    };
    state = merged;
    gaugeSaveTimer.restart();
    return null;
  }

  Timer {
    id: gaugeSaveTimer
    interval: 400
    repeat: false
    onTriggered: root.saveState()
  }

  // ---------------------------------------------------------------------------
  // The baseline log. Absolute numbers, one row per sample, one writer per
  // sample, appended without a shell and rotated by a window, not a truncate.
  // Round 8 ruling 1 samples every 2 seconds while anything is amber or a window
  // is open; Memory.logDue keeps the log's resting window at its round-7 rate
  // and writes at once for an alert row or a row that carries a changed fact.
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
    if (!Memory.logDue(record, root.lastLoggedRecord)) return;
    root.lastLoggedRecord = record;
    pendingAlertEvents = [];
    var line = Memory.logLine(record);
    logBytesWritten += line.length + 1;
    appendLogLine(line);
    var plan = Memory.logRotatePlan(logBytesWritten, Memory.logMaxBytes(), Memory.logMaxLines());
    if (plan.rotate) {
      logBytesWritten = 0;
      logRotateProc.command = Memory.logRotateArgs(baselinePath, plan.keepLines);
      logRotateProc.running = true;
    }
  }

  // One dd per line: start it, feed the row, close its stdin so dd flushes at
  // EOF and exits. A line that arrives while the previous dd is still running
  // waits for that exit, so nothing is written into a closing pipe.
  function appendLogLine(line): void {
    if (logAppendProc.running) {
      logAppendPending = logAppendPending.length > 0 ? logAppendPending + "\n" + line : line;
      return;
    }
    logAppendProc.command = Memory.logAppendArgs(root.baselinePath);
    logAppendProc.stdinEnabled = true;
    logAppendProc.running = true;
    logAppendProc.write(line + "\n");
    logAppendProc.stdinEnabled = false;
  }

  function openDetail(): void {
    root.broadcast("showDetail");
  }

  function showDetail(): void {
    unseenAlerts = [];
    hideDash();
    if (panelLoader.item) panelLoader.item.open();
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
  // Round 7 item 12: every toast is temporary, so the notice lane can no longer
  // promise to hold a popup forever - it carries the same 120s watchdog release
  // the alert lane has. A question the watchdog releases was interrupted, not
  // answered: it stays unrecorded and is asked again when the lane is free.
  property bool noticeWatchdogFired: false
  // The toast logo lives beside this file; Qt.resolvedUrl anchors it to the
  // plugin directory wherever the shell installed it.
  readonly property string iconDir: {
    var url = Qt.resolvedUrl("icons").toString();
    if (url.indexOf("file://") === 0) url = url.substring(7);
    return decodeURIComponent(url);
  }
  property var notifyProcArgs: []
  property var noticeProcArgs: []
  property string noticePrintedId: ""
  property var pendingAlertEvents: []
  property var unseenAlerts: []
  property int logBytesWritten: 0
  property var lastLoggedRecord: null
  property string logAppendPending: ""
  property bool stateDirDone: false
  property bool reconcileDone: false
  property bool stateWritten: false
  property string lastStateWrite: ""
  // Round 7.5 item 20: when this widget last wrote the state file, in epoch
  // ms. The FileView watcher fires on our own atomic writes too; a reload
  // within 500 ms of our own write is our own echo, and reloading it rebinds
  // every dash binding in one frame - the height flicker that could bounce
  // the popup shut mid-reset. Our memory is already the truth, so the echo is
  // skipped.
  property real lastStateWriteAt: 0
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

  // Round 9: the system fault codes' readers. Five cheap reads on the same
  // sample cadence, every argv from quattro.js. Each collector stores its
  // text and its exit status; the decode in buildSystemCodes decides. The
  // journal tools may be unreadable on a rig whose journal is closed: that
  // decodes as the honest unknown row, never as a clean zero.
  Process {
    id: barProc
    command: Quattro.barArgs()
    stdout: StdioCollector {
      onStreamFinished: root.barProbeText = this.text
    }
    stderr: StdioCollector { onStreamFinished: void this.text }
    onExited: function(exitCode, exitStatus) {
      root.barProbeExit = exitCode;
      root.markDone("bar");
    }
  }

  Process {
    id: kernelProc
    command: Quattro.journalDeltaArgs(root.sysKernelCursor)
    stdout: StdioCollector {
      onStreamFinished: root.kernelJournalText = this.text
    }
    stderr: StdioCollector { onStreamFinished: void this.text }
    onExited: function(exitCode, exitStatus) {
      root.kernelJournalOk = exitCode === 0;
      if (exitCode !== 0) console.warn("memory-monitor: journalctl -k unreadable, exit", exitCode)
      root.markDone("kernel");
    }
  }

  Process {
    id: wedgeProc
    command: Quattro.gpuWedgeArgs()
    stdout: StdioCollector {
      onStreamFinished: root.wedgeJournalText = this.text
    }
    stderr: StdioCollector { onStreamFinished: void this.text }
    onExited: function(exitCode, exitStatus) {
      root.wedgeJournalExit = exitCode;
      if (exitCode !== 0 && exitCode !== 1) console.warn("memory-monitor: journalctl wedge grep unreadable, exit", exitCode)
      root.markDone("wedge");
    }
  }

  Process {
    id: unitsProc
    command: Quattro.layerUnitsArgs()
    stdout: StdioCollector {
      onStreamFinished: root.unitShowText = this.text
    }
    stderr: StdioCollector { onStreamFinished: void this.text }
    onExited: function(exitCode, exitStatus) {
      root.unitShowOk = exitCode === 0;
      if (exitCode !== 0) console.warn("memory-monitor: systemctl show unreadable, exit", exitCode)
      root.markDone("units");
    }
  }

  Process {
    id: ioPsiProc
    command: Quattro.ioPsiArgs()
    stdout: StdioCollector {
      onStreamFinished: root.ioPsiText = this.text
    }
    stderr: StdioCollector { onStreamFinished: void this.text }
    onExited: function(exitCode, exitStatus) {
      root.ioPsiOk = exitCode === 0;
      if (exitCode !== 0) console.warn("memory-monitor: /proc/pressure/io unreadable, exit", exitCode)
      root.markDone("iopsi");
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
  // Notification lanes. Both lanes build their argv in memory.js and both are
  // watchdog-released now that every toast is temporary: `notifyProc` carries
  // the band alerts, `noticeProc` the notices and questions. A notice the
  // watchdog releases stays unrecorded, so the question is asked again.
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

  Timer {
    id: noticeWatchdog
    interval: 120000
    repeat: false
    onTriggered: root.releaseActiveNotice("watchdog")
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
      noticeWatchdog.stop();
      var notice = root.activeNotice;
      var interrupted = root.noticeWatchdogFired;
      root.activeNotice = null;
      root.noticePreempting = false;
      root.noticeWatchdogFired = false;
      if (notice !== null && !interrupted) {
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
    // Round 7.5 item 20: a write this widget just made is not a foreign
    // change. Skip the echo reload so a settings write (a slider drag, a
    // reset) can never bounce the popup shut under the captain's hand.
    onFileChanged: if (new Date().getTime() - lastStateWriteAt > 500) reload()
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
      if (logAppendPending.length > 0) {
        var line = logAppendPending;
        logAppendPending = "";
        appendLogLine(line);
      }
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
  // that resource was last seen doing. The watchdogs release a wedged child on
  // either lane, each after 120 s (round 7 gave the notice lane one too).
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
  // The bar. One emblem — the QuattroDash telltale — plain white when nothing
  // is over a line, tinted by the most severe resource.
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
    // The popup's own hover decode lives under it once it is open (round 2,
    // item 6): while a surface of this plugin is open the badge tooltip
    // hides, the way Mount Monitor's ring tooltips hide while any popout is
    // open.
    tooltipText: root.anySurfaceOpen ? "" : Memory.barTooltip(badgeList)
    iconComponent: badgeComponent

    // The captain's round-2 ruling: the user clicks the emblem to open the
    // dashboard.
    onPressed: function(button) {
      if (button === Qt.LeftButton) root.togglePanel()
    }

    Component {
      id: badgeComponent

      Item {
        id: badgeItem
        readonly property var entry: root.badgeEntry
        readonly property int band: entry === null || entry === undefined ? 0 : (entry.band === undefined ? 0 : entry.band)
        readonly property bool latched: entry !== null && entry !== undefined && entry.latched === true
        // QuattroDash is the bar emblem (the approved round-2 spec): the
        // check-engine telltale alone - monochrome = all systems go, yellow =
        // moderate, red = severe. Severity, the token that tints it and the
        // critical pulse stay RingKit's decision, so a bar carrying both
        // plugins draws one severity language, and the artwork is the same ISO
        // MIL path the dashboard renders through QuattroSymbol.
        readonly property var badge: RingKit.badgeParams(
          entry === null || entry === undefined ? "" : entry.type,
          band,
          latched)
        readonly property color tint: badge.colorToken === "plain" ? Color.foreground : RingKit.paletteToken(badge.colorToken)
        readonly property bool pulse: badge.pulse
        property real glowPhase: 0

        SequentialAnimation {
          running: badgeItem.pulse
          loops: Animation.Infinite
          NumberAnimation { target: badgeItem; property: "glowPhase"; from: 0.0; to: 1.0; duration: 1000; easing.type: Easing.InOutSine }
          NumberAnimation { target: badgeItem; property: "glowPhase"; from: 1.0; to: 0.0; duration: 1000; easing.type: Easing.InOutSine }
        }

        QuattroSymbol {
          anchors.centerIn: parent
          symbol: "mil"
          width: 22
          height: Math.round(22 * 53.03 / 79.55)
          color: badgeItem.tint
          opacity: badgeItem.pulse ? 0.6 + 0.4 * badgeItem.glowPhase : 1.0
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

  // The bar-facing panel shape. The badge click and the shell's panel routing
  // open the QuattroDash instrument cluster (the approved round-2 ruling: the
  // user clicks the emblem to open the dashboard); the critical-click IPC
  // (openDetail) still lands on the MemoryPanel detail window via showDetail.
  // Opening either counts as having seen the alert state.
  readonly property bool opened: dashLoader.item ? dashLoader.item.opened === true : false

  // The bar keys the open-panel dot and popout switching on the bar-widget root
  // (Bar.qml compares its active popout to the slot's item), while each popup
  // card is owned by its own panel so every window keeps a dismissal path of
  // its own. The widget carries the popout identity instead: a change in the
  // panels' opened state registers and releases it with the bar's coordinator.
  readonly property bool detailOpen: panelLoader.item ? panelLoader.item.opened === true : false
  readonly property bool anySurfaceOpen: opened || detailOpen
  onAnySurfaceOpenChanged: {
    syncPopout()
    // Round 8 ruling 1: opening a Quattro Dash window is a watch state, and a
    // watch doctrine that only took hold on the next sample would leave the dash
    // showing a reading up to a minute old while the captain is looking at it.
    // Setting a running Timer's interval restarts its countdown, so an open
    // window is live on the next 2-second tick rather than the next nominal one.
    root.schedulePolls()
  }

  function syncPopout(): void {
    if (!bar || typeof bar.requestPopout !== "function") return;
    if (anySurfaceOpen) bar.requestPopout(root);
    else bar.releasePopout(root);
  }

  function open(): void {
    unseenAlerts = [];
    hideDetail();
    if (dashLoader.item) dashLoader.item.open();
  }

  function close(): void {
    hideDetail();
    hideDash();
  }

  function togglePanel(): void {
    unseenAlerts = [];
    hideDetail();
    if (dashLoader.item) dashLoader.item.toggle();
  }

  readonly property bool popoutSwitchClosing: dashLoader.item ? dashLoader.item.popoutSwitchClosing === true : false

  function closeForPopoutSwitch(): void {
    if (detailOpen === true && panelLoader.item) panelLoader.item.closeForPopoutSwitch();
    else if (dashLoader.item) dashLoader.item.closeForPopoutSwitch();
  }

  function hideDetail(): void {
    if (detailOpen === true && panelLoader.item) panelLoader.item.close();
  }

  function hideDash(): void {
    if (opened === true && dashLoader.item) dashLoader.item.close();
  }

  function injectPanel(): void {
    var target = panelLoader.item;
    if (target) {
      if ("bar" in target) target.bar = root.bar;
      if ("settings" in target) target.settings = root.settings;
      if ("moduleName" in target) target.moduleName = root.moduleName;
      if ("anchorItem" in target) target.anchorItem = badge;
      if ("hostWidget" in target) target.hostWidget = root;
      if ("monitor" in target) target.monitor = root;
    }
    var dash = dashLoader.item;
    if (dash) {
      if ("bar" in dash) dash.bar = root.bar;
      if ("settings" in dash) dash.settings = root.settings;
      if ("moduleName" in dash) dash.moduleName = root.moduleName;
      if ("anchorItem" in dash) dash.anchorItem = badge;
      if ("hostWidget" in dash) dash.hostWidget = root;
      if ("monitor" in dash) dash.monitor = root;
    }
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

  Loader {
    id: dashLoader
    active: true
    source: Qt.resolvedUrl("QuattroDash.qml")
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
