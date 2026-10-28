import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "mounts.js" as Mounts
import "streetview.js" as StreetView

// Mount Monitor — one ring per configured disk mount.
// Bright arc = used, dim ring = available, percent inside, mount details on hover.
// A ring is drawn for any block-device-backed filesystem you configure (btrfs,
// NTFS, ext4, ...), including the read-only NTFS partition holding the models.
// Virtual filesystems (tmpfs, proc, cgroup2, ...) never do. The mount filter
// and the alert text live in mounts.js so they are tested without a running
// shell.
// Alerts at 80% and 90% (notification + emboldened ring), 98%+ (notification +
// vibrant red ring pulsing at 0.5 Hz). Clicking a notification sends a cleanup
// prompt to the configured agent (default: the omarchy default agent in a
// terminal; override with the agentCommand setting, e.g. your fleet agent's
// inbox). The prompt is fixed copy from mounts.js: it names a mount or partition
// by an id the plugin mints and carries the mountpoint, device, filesystem, and
// label as a delimited block of explicitly untrusted device data, because a volume
// label is written by whoever formatted the filesystem and must not reach a
// tool-capable agent as part of the ask. The user's confirmation of the concrete
// change is required outside that text. The click is handed over two ways, because
// the shell can only use one of them at a time: the popup's exec hint
// (Mounts.notifyArgs), which Omarchy's notification service runs itself and which
// its persisted history row keeps, and the libnotify action, which only answers
// while this widget's notify-send is alive. A notice that outlived a shell restart
// is clickable through the hint.
// A read-only mount is alerted about too, but honestly: nothing can be
// pruned on it, so its alert asks the agent what to move off it instead.
// Onboarding: on first run the widget scans the disk table (lsblk) and notifies
// both counts - how many partitions are already watched and how many still need
// a decision - never one bare number, which reads as a miscount to anyone who
// can see their own drives. A clicked notice opens the agent on the
// partition-onboarding skill, which asks which to monitor and wires the picks
// into the mounts setting. A partition that appears later notifies once. What
// has been offered, declined, or accepted lives in the state file at
// Mounts.statePath, so the same partition is never offered twice. Set
// "onboarding": false on the shell.json entry to skip the scan and its notices.
// An onboarding notice never expires: it stays until it is read, clicked, or
// dismissed, because the answer is the only door to the flow. It rides its own
// notify-send process for that reason - a question nobody answers must not hold
// a full-drive warning in the queue. Once it leaves the screen Omarchy's own
// notification history keeps it, exec hint and all, so a row restored after a
// shell restart still opens the agent.
// Detection: a plugged drive is noticed on the kernel's own block-device events
// (Mounts.udevArgs, kept open as a long-running udevadm monitor), not on the
// polling sweep. A plug is a burst of uevent lines, so they coalesce into one
// rescan, and one more rescan follows because udisks2 mounts a stick after the
// last event lands. The 60-second sweep stays, and it is what detection falls
// back to when udevadm cannot start or will not stay up. Set "detectEvents":
// false on the shell.json entry to skip the monitor.
// Configure mounts via the shell.json layout entry:
//   { "id": "io.github.jasonlnheath.mount-monitor", "mounts": ["/", "/mnt/models"] }
// Default when unconfigured: root only. Every setting is read through the
// Mounts.normalize* helpers: the value the plugin setting hand-off delivers is a
// Qt list, not a JavaScript Array, and a plain array check rejects it - which is
// how a correctly configured bar used to draw one ring and refuse its
// agentCommand.
// Street View wallpaper: the fetching half is the plugin's service entry
// (StreetView.qml); this widget is the display half. It reads the meter the
// service writes (never the reverse), shows the usage line on the indicator's
// tooltip, sends a usage popup on demand, and relays the cap warning once per
// episode - a persistent, never-expiring notice whose click offers the
// captain the two options: stay capped, or unlock paid usage at their own
// risk. The wallpaper NEVER sends a billable request unless the month's meter
// says there is free headroom; that guard lives in streetview.js, and this
// widget builds no copy of its own. The settings (streetview, streetviewKey,
// streetviewCapPerDay, streetviewMonthlyCap, streetviewIntervalMinutes,
// streetviewSize, streetviewLocations) ride this entry in shell.json like
// every other setting, and the service reads them from the same file.
BarWidget {
  id: root
  moduleName: "io.github.jasonlnheath.mount-monitor"

  // [{ target, source, fstype, used, avail, pct, readonly }]
  property var mounts: []
  // last alert band per mount: 0 = below 80, 1 = 80s, 2 = 90s, 3 = 98+
  property var bands: ({})
  // queued/active desktop alerts, fired one at a time so each stays clickable
  property var alertQueue: []
  property var activeAlert: null
  // Whether this instance has taken its first reading. A rebuilt widget starts
  // with empty bands, so the first reading is a baseline rather than a
  // crossing: otherwise every config reload or shell restart re-notifies every
  // mount that is already in a band. Critical is exempt, a full drive is never
  // swallowed by the baseline.
  property bool primed: false
  readonly property color alertRed: "#ff2d2d"

  // --- onboarding -----------------------------------------------------------
  // The last candidate scan: [{ key, target, path, fstype, size, label, removable }].
  property var candidates: []
  // What has already been offered, declined, or accepted, read from the state
  // file. This is the memory that keeps a partition from being offered twice.
  property var onboardingState: Mounts.parseState("")
  // queued onboarding notices, on their own process slot so a notice that never
  // expires cannot hold a band alert behind it
  property var noticeQueue: []
  property var activeNotice: null
  // The scan is evaluated once all four inputs of a cycle have landed: the state
  // directory, the state file, the disk table, and the mount table (which says
  // what is already watched).
  property bool stateDirDone: false
  property bool stateLoaded: false
  // Set while a changed state file is being re-read, cleared once the fresh
  // content has landed: an evaluate that runs in between would read the
  // previous decisions and answer over the newest one.
  property bool reloadPending: false
  property bool scanDone: false
  property bool mountsDone: false
  // The payload last written, so an unchanged scan does not rewrite the file.
  property string lastStateWrite: ""
  property bool stateWritten: false
  readonly property bool onboardingEnabled:
    Mounts.normalizeBool(root.setting("onboarding", true), true)
  readonly property string onboardingStatePath: Mounts.statePath(Quickshell.env("HOME"))

  // --- Street View wallpaper -------------------------------------------------
  // The meter the service writes and this widget only reads; the warned-
  // episode memory is this widget's own file, so neither file has two
  // writers.
  property var svMeter: StreetView.parseMeter("")
  property var svCapState: StreetView.parseCapState("")
  property string svLastCapWrite: ""
  property bool svMeterLoaded: false
  property bool svCapLoaded: false
  // A FileView cannot watch a file that has never been created, so a fresh
  // install's failed load leaves the watcher dead; these flags say so, and
  // the 60-second sweep retries the load until the service creates the file.
  property bool svMeterFileOk: false
  property bool svCapFileOk: false
  property string svTooltip: ""
  readonly property string svHome: Quickshell.env("HOME")
  // The same settings the service extracts from shell.json, built from this
  // widget's injected entry, so a cap change reaches the warning relay
  // without a restart.
  readonly property var svConfig: StreetView.configFromSettings(root.svSettingsRaw())
  readonly property bool svFeatureOn: root.svConfig.enabled && root.svConfig.key !== ""
  onSvConfigChanged: {
    root.updateSvTooltip()
    root.relayCapWarning()
  }

  function svSettingsRaw(): var {
    return {
      streetview: root.setting("streetview", null),
      streetviewKey: root.setting("streetviewKey", null),
      streetviewCapPerDay: root.setting("streetviewCapPerDay", null),
      streetviewMonthlyCap: root.setting("streetviewMonthlyCap", null),
      streetviewIntervalMinutes: root.setting("streetviewIntervalMinutes", null),
      streetviewSize: root.setting("streetviewSize", null),
      streetviewLocations: root.setting("streetviewLocations", null)
    }
  }

  function loadSvMeter(raw): void {
    root.svMeter = StreetView.parseMeter(raw)
    root.svMeterLoaded = true
    root.updateSvTooltip()
    root.relayCapWarning()
  }

  function loadSvCapState(raw): void {
    root.svCapState = StreetView.parseCapState(raw)
    root.svCapLoaded = true
    root.relayCapWarning()
  }

  function updateSvTooltip(): void {
    if (!root.svFeatureOn) {
      root.svTooltip = ""
      return
    }
    var now = new Date().toISOString()
    root.svTooltip = StreetView.usageLine(root.svMeter, root.svConfig, now)
      + " · " + StreetView.todayLine(root.svMeter, root.svConfig, now)
  }

  // The cap warning, once per episode. The episode and every sentence come
  // from streetview.js; this relay only decides that the popup has not fired
  // for this episode yet and hands it to the notice lane the onboarding
  // questions already ride - critical, never-expiring, on its own process so
  // it cannot hold a full-drive warning behind it.
  function relayCapWarning(): void {
    if (!root.svFeatureOn || !root.svMeterLoaded || !root.svCapLoaded) return
    if (root.reloadPending || !root.stateDirDone) return
    var now = new Date().toISOString()
    var episode = StreetView.capEpisode(root.svMeter, root.svConfig, now)
    if (episode === "" || episode === root.svCapState.episode) return
    var reason = StreetView.capReason(root.svMeter, root.svConfig, now)
    // A broken clock must only refuse to spend, never nag.
    if (reason === "") return
    var usage = StreetView.usageLine(root.svMeter, root.svConfig, now)
    root.noticeQueue.push({
      kind: "streetview-cap",
      prompt: StreetView.capWarningPrompt(usage, reason),
      title: StreetView.capWarningTitle(),
      body: StreetView.capWarningBody(usage, reason),
      action: StreetView.capWarningAction()
    })
    root.writeSvCapState({ episode: episode })
    root.fireNextNotice()
  }

  function writeSvCapState(next): void {
    root.svCapState = StreetView.parseCapState(StreetView.serializeCapState(next))
    var payload = StreetView.serializeCapState(next)
    if (payload === root.svLastCapWrite) return
    root.svLastCapWrite = payload
    svCapFile.setText(payload)
  }

  function svStatus(): void {
    svStatusProc.command = StreetView.statusArgs(root.svMeter, root.svConfig, new Date().toISOString())
    svStatusProc.running = true
  }

  // --- block events ---------------------------------------------------------
  // The burst being coalesced, in wall-clock milliseconds, 0 when nothing is
  // pending. Milliseconds since the epoch do not fit in an int.
  property real burstFirst: 0
  property real burstLast: 0
  // Restart attempts spent on the monitor.
  property int monitorRestarts: 0
  readonly property bool eventsEnabled:
    Mounts.normalizeBool(root.setting("detectEvents", true), true)
  // The bar injects settings after Component.onCompleted has read the fallback,
  // so the off switch cannot live in the start gate alone: the decision rides
  // the setting, wherever and whenever it lands.
  onEventsEnabledChanged: root.syncMonitor()

  function refresh(): void {
    root.broadcast("refreshSelf")
  }

  function refreshSelf(): void {
    if (!dfProc.running) dfProc.running = true
    // The state file is read once at startup and then on every change to it - a
    // decline the onboarding skill wrote lands through onFileChanged. Re-reading
    // it each cycle would race this widget's own write and re-offer what it has
    // already offered.
    if (root.onboardingEnabled && !scanProc.running) scanProc.running = true
    // The wallpaper files may not exist yet on a fresh install; retry those
    // loads until they land, then the watchers keep them fresh.
    if (root.stateDirDone && !root.svMeterFileOk) svMeterFile.reload()
    if (root.stateDirDone && !root.svCapFileOk) svCapFile.reload()
  }

  // One line from udevadm monitor. Only a block-device line is answered, and the
  // only answer is a rescan: what a device's path is called never travels any
  // further than this decision, the way a volume label never reaches the copy.
  function noteBlockEvent(line): void {
    if (!Mounts.isBlockEvent(line)) return
    var now = Date.now()
    // A burst older than the cap starts over, so a stale first stamp can only
    // make the next rescan sooner, never later.
    if (root.burstFirst === 0 || now - root.burstFirst > Mounts.udevMaxWaitMs())
      root.burstFirst = now
    root.burstLast = now
    var delay = Mounts.rescanDelayMs(now, root.burstFirst, root.burstLast)
    if (delay <= 0) { root.eventRescan(); return }
    eventTimer.interval = delay
    eventTimer.restart()
  }

  // The rescan a burst buys, and why a second one has to follow it: the first
  // reading catches the device, the settle reading catches the automount that
  // lands after the last uevent. Both go through the path the sweep uses, so a
  // mount that appears mid-session gets its ring, its band alert, and its
  // onboarding notice exactly as it would on the next tick.
  function eventRescan(): void {
    root.burstFirst = 0
    root.burstLast = 0
    root.refresh()
    settleTimer.restart()
  }

  function settleRescan(): void {
    root.refresh()
  }

  // Keep the monitor in agreement with eventsEnabled. The start gate in
  // Component.onCompleted reads the setting's fallback because the real value
  // has not been injected yet, so a switch configured off engages here, when
  // the value arrives; a stop exits through onExited, where !eventsEnabled
  // keeps it from restarting. A switch turned back on starts the monitor and
  // clears a give-up marker recorded while it was off.
  function syncMonitor(): void {
    if (!root.eventsEnabled) {
      udevProc.running = false
      return
    }
    udevProc.gaveUp = false
    if (!udevProc.running) udevProc.running = true
  }

  function wantedMounts(): var {
    // The default lives in mounts.js so "unconfigured" and "configured garbage"
    // fall back the same way the tests say they do.
    return Mounts.normalizeMounts(root.setting("mounts", null))
  }

  function bandFor(pct): int {
    return Mounts.bandFor(pct)
  }

  function runAgent(alert): void {
    var cmd = Mounts.normalizeAgentCommand(root.setting("agentCommand", null))
    if (cmd === null && root.agentCommandConfigured())
      console.warn("mount-monitor: agentCommand must be an argument list, using the default agent")
    // The same argv the popup's exec hint carries: the alert's kind decides the
    // ask, so a click the daemon runs and a click this widget answers cannot
    // disagree about what the agent is asked to do.
    agentProc.command = Mounts.agentArgv(alert, cmd)
    agentProc.running = true
  }

  // A configured agentCommand that the normalizer refused is worth a warning; an
  // absent one is just the default agent.
  function agentCommandConfigured(): bool {
    var raw = root.setting("agentCommand", null)
    return raw !== null && raw !== undefined && String(raw).trim() !== ""
  }

  function queueAlert(m, band): void {
    for (var i = 0; i < root.alertQueue.length; i++) {
      if (root.alertQueue[i].target !== m.target) continue
      // One pending alert per mount, the more severe one: a mount that crosses
      // again while its first alert is still queued behind another mount gets a
      // single notification for the band it actually reached.
      if (band > root.alertQueue[i].band)
        root.alertQueue[i] = root.bandAlert(m, band)
      return
    }
    root.alertQueue.push(root.bandAlert(m, band))
  }

  // The alert for one ring: the row's own fields, including the id mounts.js minted
  // for it. The prompt the click sends names the mount by that id and carries the
  // rest as untrusted device data (see the device text section of mounts.js), so
  // whatever a volume label calls itself never reaches the agent as an instruction.
  function bandAlert(m, band): var {
    return {
      kind: "band", target: m.target, source: m.source, id: m.id, fstype: m.fstype,
      used: m.used, pct: m.pct, avail: m.avail, readonly: m.readonly, band: band
    }
  }

  // Band the latest reading reports for a mount, -1 when it is not mounted.
  function bandOf(target): int {
    for (var i = 0; i < root.mounts.length; i++)
      if (root.mounts[i].target === target) return root.bandFor(root.mounts[i].pct)
    return -1
  }

  // The next band alert to put on screen. A band alert the latest reading no
  // longer supports is dropped on the way: its mount went away, or fell back
  // below the band it was queued for.
  function takeNextAlert(): var {
    while (root.alertQueue.length > 0) {
      var alert = root.alertQueue.shift()
      var now = root.bandOf(alert.target)
      if (now < alert.band) continue
      alert.band = now
      return alert
    }
    return null
  }

  // The next onboarding notice. A notice whose drive was ejected while it waited
  // is dropped, and delivering a notice is what records the offer.
  function takeNextNotice(): var {
    while (root.noticeQueue.length > 0) {
      var notice = root.noticeQueue.shift()
      if (notice.kind === "new-partition" && !Mounts.candidateAlive(root.candidates, notice.key)) continue
      if (notice.kind !== "streetview-cap") root.recordDelivered(notice)
      return notice
    }
    return null
  }

  function notifyArgs(alert): var {
    // The whole notify-send command lives in mounts.js: the action, urgency, and
    // timeout the queue and the persistence depend on, plus the omarchy exec hint
    // that keeps the click alive when this widget's sender process does not.
    return Mounts.notifyArgs(alert, root.setting("agentCommand", null))
  }

  function fireNextAlert(): void {
    if (root.activeAlert !== null) return
    var alert = root.takeNextAlert()
    if (alert === null) return

    root.activeAlert = alert
    notifyProc.alert = alert
    notifyProc.lastOut = ""
    notifyProc.didStart = false
    notifyProc.command = root.notifyArgs(alert)
    notifyProc.running = true
  }

  // Onboarding notices ride their own process. notify-send blocks while its
  // action is live, and a notice that never expires blocks for as long as it is
  // on screen, so it cannot share notifyProc: a question nobody answers would
  // hold every later full-drive warning in the queue. Band alerts drain on
  // notifyProc regardless.
  function fireNextNotice(): void {
    if (root.activeNotice !== null) return
    var notice = root.takeNextNotice()
    if (notice === null) return

    root.activeNotice = notice
    noticeProc.alert = notice
    noticeProc.lastOut = ""
    noticeProc.didStart = false
    noticeProc.command = root.notifyArgs(notice)
    noticeProc.running = true
  }

  // notify-send blocks until its popup closes and a critical alert never
  // expires, so a popup nobody dismisses must not hold the queue shut for the
  // remaining mounts.
  function releaseActiveAlert(reason): void {
    if (root.activeAlert === null) return
    console.warn("mount-monitor: releasing queued alert (" + reason + ")")
    if (!notifyProc.running) {
      // Nothing is live, so no exit will arrive: clear the markers here.
      root.activeAlert = null
      notifyProc.alert = null
      root.fireNextAlert()
      return
    }
    // The kill's exit has not arrived yet: the alert stays marked active so
    // nothing else stages onto this process, and that exit — attributed to
    // its own alert, with a non-zero code so it is not read as a click —
    // advances the queue.
    notifyProc.signal(15)
  }

  // A notice that never started has no exit to wait for: clear the slot and let
  // the next one through. Nothing here releases a live notice - it waits for the
  // captain, and this slot has no watchdog. Killing it would take the only door
  // to the onboarding flow with it.
  function dropUnstartedNotice(reason): void {
    if (root.activeNotice === null) return
    console.warn("mount-monitor: dropping queued notice (" + reason + ")")
    root.activeNotice = null
    noticeProc.alert = null
    root.fireNextNotice()
  }

  // A command that never started reports no exit at all, so running going
  // false without a start is the only signal a missing binary produces.
  function startFailed(proc): bool {
    return !proc.running && !proc.didStart
  }

  function checkBands(list, wanted): void {
    var byTarget = ({})
    for (var i = 0; i < list.length; i++) byTarget[list[i].target] = list[i]

    var next = ({})
    for (var j = 0; j < wanted.length; j++) {
      var target = wanted[j]
      var m = byTarget[target]
      // A configured mount that is not mounted keeps its last band, so
      // remounting at the same usage is not read as a new crossing.
      var band = m ? root.bandFor(m.pct)
        : (root.bands[target] !== undefined ? root.bands[target] : 0)
      next[target] = band

      var prev = root.bands[target]
      var crossedUp = prev !== undefined && band > prev
      var firstSighting = prev === undefined && m !== undefined
      if (band > 0 && (crossedUp || (firstSighting && (root.primed || band === 3))))
        root.queueAlert(m, band)
    }

    root.bands = next
    root.primed = true
    root.fireNextAlert()
  }

  function parseDf(text): void {
    var wanted = root.wantedMounts()
    var testOverride = Mounts.normalizeNumber(root.setting("testPct", -1), -1)
    // Which mounts may draw a ring, and what their usage is, is mounts.js's
    // decision; this only feeds it the reading and the configured list.
    root.mounts = Mounts.selectMounts(text, wanted, testOverride)
    root.mountsDone = true
    root.checkBands(root.mounts, wanted)
    root.evaluateOnboarding()
  }

  // --- onboarding: scan, memory, notices ------------------------------------

  function parseScan(text): void {
    root.candidates = Mounts.candidatePartitions(text)
    root.scanDone = true
    root.evaluateOnboarding()
  }

  function loadState(raw): void {
    if (String(raw === undefined || raw === null ? "" : raw).trim() === "" && root.stateWritten) {
      // The file exists because this widget wrote it. An empty read is the
      // watcher racing its own save, not a fresh install: keep what we know
      // rather than re-offering everything.
      root.stateLoaded = true
      root.evaluateOnboarding()
      return
    }
    root.onboardingState = Mounts.parseState(raw)
    root.stateLoaded = true
    root.evaluateOnboarding()
  }

  // The scan mirrored into the state file, each candidate marked with whether a
  // ring already covers it. The rule lives in mounts.js because the state file,
  // the onboarding skills, and the first-run notice's watched count all read the
  // same flag.
  function annotatedCandidates(wanted, watched): var {
    return Mounts.annotateCandidates(root.candidates, wanted, watched)
  }

  // The state as it now stands, written only when its payload changed: the
  // timestamp changes every cycle and must not turn every refresh into a disk
  // write.
  function writeState(next): void {
    root.onboardingState = next
    var payload = Mounts.serializeState(next, "")
    if (payload !== root.lastStateWrite) {
      root.lastStateWrite = payload
      root.stateWritten = true
      stateFile.setText(Mounts.serializeState(next, new Date().toISOString()))
    }
  }

  // A new-partition offer is recorded when its notice is delivered, not when it
  // was queued - a notice dropped on a drive that went away while it waited
  // leaves no record, so the drive is asked about again when it returns - and
  // never over a decision that landed while the notice sat in the queue. While
  // a state-file reload is in flight the record is skipped: the popup still
  // shows, and the next evaluate either finds the decision already recorded or
  // queues the still-undecided partition again.
  function recordDelivered(notice): void {
    if (root.reloadPending) return
    var state = root.onboardingState
    if (state.decisions[notice.key] !== undefined) return
    root.writeState(Mounts.markOffered(state, [notice.candidate], "offered"))
  }

  function isQueued(key): bool {
    for (var i = 0; i < root.noticeQueue.length; i++)
      if (root.noticeQueue[i].kind === "new-partition" && root.noticeQueue[i].key === key) return true
    return false
  }

  function evaluateOnboarding(): void {
    if (!root.onboardingEnabled || !root.stateDirDone || !root.stateLoaded || root.reloadPending
      || !root.scanDone || !root.mountsDone)
      return

    var wanted = root.wantedMounts()
    var watched = Mounts.monitoredDevices(root.mounts)
    var fresh = Mounts.newCandidates(root.candidates, root.onboardingState, wanted, watched)
    var annotated = root.annotatedCandidates(wanted, watched)
    var next = root.onboardingState

    if (!next.onboarded) {
      // First run: one notice for everything the scan found. It carries the
      // already-watched count next to the waiting list, because a notice that
      // reports only the unmonitored partitions reads as a miscount to anyone
      // who can see their own drives. Recording it - even when the list is
      // empty - is what makes the notice fire once per install rather than once
      // per shell restart.
      if (fresh.length > 0)
        root.noticeQueue.push({ kind: "onboarding", candidates: fresh, watched: Mounts.monitoredCount(annotated) })
      next = Mounts.markOffered(next, fresh, "offered")
    } else if (fresh.length > 0) {
      // A partition that appeared after onboarding gets its own notice, once;
      // the offer is recorded when the notice is delivered, so a partition
      // whose notice is already waiting is not queued a second time.
      for (var i = 0; i < fresh.length; i++)
        if (!root.isQueued(fresh[i].key))
          root.noticeQueue.push({ kind: "new-partition", key: fresh[i].key, candidate: fresh[i] })
    }

    next.candidates = annotated
    root.writeState(next)

    root.fireNextAlert()
    root.fireNextNotice()
  }

  implicitWidth: row.implicitWidth
  implicitHeight: row.implicitHeight

  Process {
    id: dfProc
    command: ["findmnt"].concat(Mounts.findmntArgs())
    stdout: StdioCollector {
      onStreamFinished: root.parseDf(this.text)
    }
    stderr: StdioCollector {
      onStreamFinished: if (this.text.trim() !== "") console.warn("mount-monitor: findmnt:", this.text.trim())
    }
    onExited: function(exitCode, exitStatus) {
      if (exitCode !== 0) console.warn("mount-monitor: findmnt exited with code " + exitCode + ", keeping the last reading")
    }
  }

  // The candidate scan. lsblk is per partition, which is what keeps several
  // btrfs subvolume mounts of one drive down to one candidate, and it is the
  // only place the removable flag lives. util-linux, same package as findmnt.
  Process {
    id: scanProc
    command: ["lsblk"].concat(Mounts.lsblkArgs())
    property string scanText: ""
    stdout: StdioCollector {
      onStreamFinished: scanProc.scanText = this.text
    }
    stderr: StdioCollector {
      onStreamFinished: if (this.text.trim() !== "") console.warn("mount-monitor: lsblk:", this.text.trim())
    }
    onExited: function(exitCode, exitStatus) {
      if (exitCode !== 0) {
        console.warn("mount-monitor: lsblk exited with code " + exitCode + ", keeping the last scan")
        return
      }
      root.parseScan(scanProc.scanText)
    }
  }

  // The state directory has to exist before any file in it can be read or
  // watched: FileView cannot observe a file that has never been created. The
  // Street View meter and cap files live here too, so the mkdir runs whether
  // or not onboarding is on.
  Process {
    id: stateDirProc
    command: ["mkdir", "-p", Mounts.stateDir(Quickshell.env("HOME"))]
    stderr: StdioCollector {
      onStreamFinished: if (this.text.trim() !== "") console.warn("mount-monitor: state dir:", this.text.trim())
    }
    onExited: function(exitCode, exitStatus) {
      if (exitCode !== 0) console.warn("mount-monitor: could not create the state dir, onboarding stays in memory and the wallpaper cannot write its meter")
      // Nothing may write a state file before its directory is known to
      // exist, and FileView cannot watch a file that has never been created:
      // all three files reload here, and their watchers take it from there.
      root.stateDirDone = true
      stateFile.reload()
      svMeterFile.reload()
      svCapFile.reload()
    }
  }

  FileView {
    id: stateFile
    path: root.onboardingStatePath
    watchChanges: true
    atomicWrites: true
    printErrors: false
    onLoaded: {
      root.reloadPending = false
      root.loadState(text())
    }
    // text() is stale inside the change signal, so route a change through reload
    // to onLoaded and always parse fresh content; evaluates wait for that read.
    onFileChanged: {
      root.reloadPending = true
      reload()
    }
    onLoadFailed: {
      root.reloadPending = false
      root.loadState("")
    }
  }

  // The meter the service writes; this widget never writes it. The reload on
  // change is what keeps the tooltip and the cap relay honest while the
  // service counts.
  FileView {
    id: svMeterFile
    path: StreetView.meterPath(root.svHome)
    watchChanges: true
    printErrors: false
    onLoaded: {
      root.svMeterFileOk = true
      root.svMeterLoaded = true
      root.loadSvMeter(text())
    }
    onFileChanged: reload()
    onLoadFailed: {
      root.svMeterFileOk = false
      root.svMeterLoaded = true
      root.loadSvMeter("")
    }
  }

  // Which cap-warning episodes have already fired: this widget's own file,
  // its own writer, so a warning fires once per episode across restarts.
  FileView {
    id: svCapFile
    path: StreetView.capStatePath(root.svHome)
    watchChanges: true
    atomicWrites: true
    printErrors: false
    onLoaded: {
      root.svCapFileOk = true
      root.svCapLoaded = true
      root.loadSvCapState(text())
    }
    onFileChanged: reload()
    onLoadFailed: {
      root.svCapFileOk = false
      root.svCapLoaded = true
      root.loadSvCapState("")
    }
  }

  // The on-demand usage popup: it reports and asks for nothing, so no action
  // rides on it and it needs no lane of its own.
  Process {
    id: svStatusProc
    command: ["true"]
    stderr: StdioCollector {
      onStreamFinished: if (this.text.trim() !== "") console.warn("mount-monitor: streetview status:", this.text.trim())
    }
  }

  Process {
    id: notifyProc
    command: ["true"]
    property string lastOut: ""
    property var alert: null
    property bool didStart: false
    stdout: StdioCollector {
      onStreamFinished: notifyProc.lastOut = this.text
    }
    onStarted: notifyProc.didStart = true
    onRunningChanged: {
      // notify-send missing: the popup never existed, so the queue has to move
      // on without waiting for an exit that cannot come.
      if (root.startFailed(notifyProc))
        root.releaseActiveAlert("notify-send could not start")
    }
    onExited: function(exitCode, exitStatus) {
      var alert = notifyProc.alert
      notifyProc.alert = null
      if (root.activeAlert === alert) root.activeAlert = null
      // The popup's own click normally runs the exec hint and dismisses the
      // popup, so nothing prints here. notify-send prints the action identifier
      // ("default") only when the action is invoked through the live sender — the
      // fallback route, taken when the hint is absent or the sender is what the
      // daemon has to answer through.
      if (alert && exitCode === 0 && notifyProc.lastOut.trim() === "default")
        root.runAgent(alert)
      else if (alert && exitCode !== 0)
        console.warn("mount-monitor: notify-send exited with code " + exitCode)
      root.fireNextAlert()
    }
  }

  // An onboarding notice, on its own process because it never expires: notify-send
  // stays alive while its action is clickable, so sharing notifyProc would let a
  // question nobody answers hold every later band alert in the queue.
  Process {
    id: noticeProc
    command: ["true"]
    property string lastOut: ""
    property var alert: null
    property bool didStart: false
    stdout: StdioCollector {
      onStreamFinished: noticeProc.lastOut = this.text
    }
    onStarted: noticeProc.didStart = true
    onRunningChanged: {
      if (root.startFailed(noticeProc))
        root.dropUnstartedNotice("notify-send could not start")
    }
    onExited: function(exitCode, exitStatus) {
      var alert = noticeProc.alert
      noticeProc.alert = null
      if (root.activeNotice === alert) root.activeNotice = null
      // As with a band alert: the exec hint is what answers a click on an
      // omarchy popup, live or restored. The action identifier is the fallback
      // route, printed only when the live sender is what got invoked.
      if (alert && exitCode === 0 && noticeProc.lastOut.trim() === "default")
        root.runAgent(alert)
      else if (alert && exitCode !== 0)
        console.warn("mount-monitor: notify-send (notice) exited with code " + exitCode)
      root.fireNextNotice()
    }
  }

  Process {
    id: agentProc
    command: ["true"]
    property bool didStart: false
    stderr: StdioCollector {
      onStreamFinished: if (this.text.trim() !== "") console.warn("mount-monitor: agent command:", this.text.trim())
    }
    onStarted: agentProc.didStart = true
    onRunningChanged: if (root.startFailed(agentProc))
      console.warn("mount-monitor: agent command could not start, check the agentCommand setting")
    onExited: function(exitCode, exitStatus) {
      if (exitCode !== 0) console.warn("mount-monitor: agent command exited with code " + exitCode)
    }
  }

  // The kernel's own block-device announcements, kept open for the life of the
  // shell: this is what turns "plugged in" into "ask for a scan" in seconds
  // instead of on the next sweep. StdioCollector is useless for a stream that
  // never finishes, so a SplitParser hands the lines over one at a time.
  Process {
    id: udevProc
    command: Mounts.udevArgs()
    property bool didStart: false
    property bool gaveUp: false
    property real startedAt: 0
    stdout: SplitParser {
      splitMarker: "\n"
      onRead: (line) => root.noteBlockEvent(line)
    }
    stderr: StdioCollector {
      onStreamFinished: if (this.text.trim() !== "") console.warn("mount-monitor: udevadm monitor:", this.text.trim())
    }
    onStarted: {
      udevProc.didStart = true
      udevProc.startedAt = Date.now()
    }
    onRunningChanged: {
      // udevadm missing: a command that never started reports no exit, so this
      // is the only signal there is. Say it once and stop trying - the sweep is
      // the detection path again.
      if (root.startFailed(udevProc)) {
        udevProc.gaveUp = true
        console.warn("mount-monitor: udevadm monitor could not start, detection falls back to the 60-second sweep")
      }
    }
    onExited: function(exitCode, exitStatus) {
      // A monitor that died is not a failed scan: the sweep never stopped. It is
      // restarted on a widening delay and given up on after a bounded number of
      // tries, because a udevadm that is gone would otherwise spin. One that
      // stayed up has earned its retries back.
      var up = udevProc.startedAt > 0 ? Date.now() - udevProc.startedAt : 0
      if (up >= Mounts.udevStableMs()) root.monitorRestarts = 0
      var delay = Mounts.udevRestartDelayMs(root.monitorRestarts + 1)
      if (!root.eventsEnabled || delay < 0) {
        console.warn("mount-monitor: udevadm monitor gave up, detection falls back to the 60-second sweep")
        udevProc.gaveUp = true
        return
      }
      root.monitorRestarts += 1
      console.warn("mount-monitor: udevadm monitor exited with code " + exitCode + ", restarting in " + delay + "ms (try " + root.monitorRestarts + ")")
      monitorTimer.interval = delay
      monitorTimer.restart()
    }
  }

  Timer {
    id: eventTimer
    interval: Mounts.udevQuietMs()
    repeat: false
    onTriggered: root.eventRescan()
  }

  Timer {
    id: settleTimer
    interval: Mounts.udevSettleMs()
    repeat: false
    onTriggered: root.settleRescan()
  }

  Timer {
    id: monitorTimer
    interval: Mounts.udevRestartDelayMs(1)
    repeat: false
    onTriggered: {
      // didStart marks the current attempt, so a restart that cannot start is
      // still caught by startFailed.
      udevProc.didStart = false
      if (root.eventsEnabled && !udevProc.running && !udevProc.gaveUp) udevProc.running = true
    }
  }

  Timer {
    id: alertWatchdog
    interval: 120000
    running: root.activeAlert !== null
    onTriggered: root.releaseActiveAlert("popup left open")
  }

  Timer {
    interval: 60000
    running: true
    repeat: true
    triggeredOnStart: true
    onTriggered: root.refresh()
  }

  Component.onCompleted: {
    stateDirProc.running = true
    if (root.eventsEnabled && !udevProc.running) udevProc.running = true
  }

  Row {
    id: row
    anchors.centerIn: parent
    spacing: 2

    Repeater {
      model: root.mounts

      BarIconButton {
        id: ringButton
        required property var modelData
        readonly property int effPct: {
          var t = Mounts.normalizeNumber(root.setting("testPct", -1), -1)
          return t >= 0 ? t : modelData.pct
        }
        readonly property bool warn: effPct >= 80
        readonly property bool critical: effPct >= 98
        bar: root.bar
        opticalSize: 22
        tooltipText: Mounts.tooltip(modelData)
        iconComponent: ringComponent

        Component {
          id: ringComponent

          Item {
            id: ringItem
            property real pct: Math.min(1, Math.max(0, ringButton.effPct / 100))
            property color strokeColor: ringButton.critical ? root.alertRed : Color.foreground
            property real glowPhase: 0

            // 0.5 Hz pulse while critical: 1s up, 1s down, forever
            SequentialAnimation {
              running: ringButton.critical
              loops: Animation.Infinite
              NumberAnimation {
                target: ringItem; property: "glowPhase"
                from: 0.0; to: 1.0; duration: 1000
                easing.type: Easing.InOutSine
              }
              NumberAnimation {
                target: ringItem; property: "glowPhase"
                from: 1.0; to: 0.0; duration: 1000
                easing.type: Easing.InOutSine
              }
            }

            Canvas {
              id: ring
              anchors.fill: parent
              onPaint: {
                var ctx = getContext("2d")
                ctx.reset()
                var w = width
                var h = height
                var base = Math.min(w, h) * 0.09
                var lw = ringButton.warn ? base * 1.5 : base
                var r = Math.min(w, h) / 2 - lw / 2 - 0.5
                var cx = w / 2
                var cy = h / 2
                if (ringButton.critical) {
                  // soft red halo breathing with the pulse
                  ctx.beginPath()
                  ctx.arc(cx, cy, r + lw * 2.2, 0, Math.PI * 2)
                  ctx.fillStyle = ringItem.strokeColor
                  ctx.globalAlpha = 0.08 + 0.22 * ringItem.glowPhase
                  ctx.fill()
                }
                // available track: dim full circle
                ctx.beginPath()
                ctx.arc(cx, cy, r, 0, Math.PI * 2)
                ctx.lineWidth = lw
                ctx.strokeStyle = ringItem.strokeColor
                ctx.globalAlpha = ringButton.critical
                  ? 0.25 + 0.2 * ringItem.glowPhase : 0.25
                ctx.stroke()
                // used arc: solid, from the top, clockwise
                ctx.globalAlpha = ringButton.critical
                  ? 0.55 + 0.45 * ringItem.glowPhase : 1.0
                ctx.beginPath()
                ctx.arc(cx, cy, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ringItem.pct)
                ctx.stroke()
              }
              Connections {
                target: ringItem
                function onPctChanged() { ring.requestPaint() }
                function onStrokeColorChanged() { ring.requestPaint() }
                function onGlowPhaseChanged() { ring.requestPaint() }
              }
              Connections {
                target: ringButton
                function onWarnChanged() { ring.requestPaint() }
                function onCriticalChanged() { ring.requestPaint() }
              }
              Component.onCompleted: ring.requestPaint()
            }

            Text {
              anchors.centerIn: parent
              text: Math.round(ringItem.pct * 100)
              color: ringItem.strokeColor
              font.pixelSize: Math.max(5, Math.round(parent.height * (ringButton.warn ? 0.45 : 0.38)))
              font.bold: false
            }
          }
        }
      }
    }

    // The wallpaper's own indicator: present only while the feature is on
    // with a key, so nobody who has not opted in sees it. Hover shows the
    // usage line; click sends the usage popup. It draws no ring - rings are
    // disks, this is a meter the service owns.
    BarIconButton {
      id: svButton
      visible: root.svFeatureOn
      bar: root.bar
      opticalSize: 22
      text: "\uf03e"
      tooltipText: root.svTooltip
      onPressed: function(button) {
        root.svStatus()
      }
    }
  }
}
