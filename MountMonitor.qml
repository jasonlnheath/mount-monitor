import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "mounts.js" as Mounts

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
// inbox). A read-only mount is alerted about too, but honestly: nothing can be
// pruned on it, so its alert asks the agent what to move off it instead.
// Configure mounts via the shell.json layout entry:
//   { "id": "io.github.jasonlnheath.mount-monitor", "mounts": ["/", "/mnt/models"] }
// Default when unconfigured: root only.
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

  function refresh(): void {
    root.broadcast("refreshSelf")
  }

  function refreshSelf(): void {
    if (!dfProc.running) dfProc.running = true
  }

  function wantedMounts(): var {
    var wanted = root.setting("mounts", ["/"])
    return Array.isArray(wanted) ? wanted : ["/"]
  }

  function bandFor(pct): int {
    return Mounts.bandFor(pct)
  }

  function agentPrompt(m): string {
    return Mounts.agentPrompt(m)
  }

  function runAgent(m): void {
    var cmd = root.setting("agentCommand", null)
    if (Array.isArray(cmd) && cmd.length > 0) {
      agentProc.command = cmd.concat([root.agentPrompt(m)])
    } else {
      if (cmd !== null && cmd !== undefined && !Array.isArray(cmd))
        console.warn("mount-monitor: agentCommand must be an argument list, using the default agent")
      agentProc.command = ["omarchy", "agent", "prompt", root.agentPrompt(m)]
    }
    agentProc.running = true
  }

  function queueAlert(m, band): void {
    for (var i = 0; i < root.alertQueue.length; i++) {
      if (root.alertQueue[i].target !== m.target) continue
      // One pending alert per mount, the more severe one: a mount that crosses
      // again while its first alert is still queued behind another mount gets a
      // single notification for the band it actually reached.
      if (band > root.alertQueue[i].band)
        root.alertQueue[i] = { target: m.target, pct: m.pct, avail: m.avail, readonly: m.readonly, band: band }
      return
    }
    root.alertQueue.push({ target: m.target, pct: m.pct, avail: m.avail, readonly: m.readonly, band: band })
  }

  // Band the latest reading reports for a mount, -1 when it is not mounted.
  function bandOf(target): int {
    for (var i = 0; i < root.mounts.length; i++)
      if (root.mounts[i].target === target) return root.bandFor(root.mounts[i].pct)
    return -1
  }

  function fireNextAlert(): void {
    if (root.activeAlert !== null || root.alertQueue.length === 0) return
    while (root.alertQueue.length > 0) {
      var alert = root.alertQueue.shift()
      var now = root.bandOf(alert.target)
      // Drop anything the latest reading no longer supports: the mount went
      // away, it is no longer configured, or its usage fell back below the
      // band it was queued for.
      if (now < alert.band) continue
      alert.band = now
      root.activeAlert = alert
      notifyProc.alert = alert
      notifyProc.lastOut = ""
      notifyProc.didStart = false
      notifyProc.command = [
        "notify-send",
        "-A", "default=" + Mounts.notifyAction(alert),
        "-u", alert.band === 3 ? "critical" : "normal",
        "-t", alert.band === 3 ? "0" : "6000",
        "Mount Monitor — " + (alert.band === 3 ? "CRITICAL" : "warning"),
        Mounts.notifyBody(alert)
      ]
      notifyProc.running = true
      return
    }
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
    var testOverride = Number(root.setting("testPct", -1))
    // Which mounts may draw a ring, and what their usage is, is mounts.js's
    // decision; this only feeds it the reading and the configured list.
    root.mounts = Mounts.selectMounts(text, wanted, testOverride)
    root.checkBands(root.mounts, wanted)
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
      // notify-send prints the action identifier ("default") only when the
      // popup's action was clicked before expiry
      if (alert && exitCode === 0 && notifyProc.lastOut.trim() === "default")
        root.runAgent(alert)
      else if (alert && exitCode !== 0)
        console.warn("mount-monitor: notify-send exited with code " + exitCode)
      root.fireNextAlert()
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
          var t = Number(root.setting("testPct", -1))
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
  }
}
