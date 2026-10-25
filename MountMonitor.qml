import QtQuick
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui

// Mount Monitor — one ring per configured btrfs mount.
// Bright arc = used, dim ring = available, percent inside, mount details on hover.
// Alerts at 80% and 90% (notification + emboldened ring), 98%+ (notification +
// vibrant red ring pulsing at 0.5 Hz). Clicking a notification sends a cleanup
// prompt to the configured agent (default: the omarchy default agent in a
// terminal; override with the agentCommand setting, e.g. your fleet agent's
// inbox). Configure mounts via the shell.json layout entry:
//   { "id": "io.github.jasonlnheath.mount-monitor", "mounts": ["/", "/srv/models"] }
// Default when unconfigured: root only.
BarWidget {
  id: root
  moduleName: "io.github.jasonlnheath.mount-monitor"

  // [{ target, used, avail, pct }]
  property var mounts: []
  // last alert band per mount: 0 = below 80, 1 = 80s, 2 = 90s, 3 = 98+
  property var bands: ({})
  // queued/active desktop alerts, fired one at a time so each stays clickable
  property var alertQueue: []
  property var activeAlert: null
  readonly property color alertRed: "#ff2d2d"

  function refresh(): void {
    root.broadcast("refreshSelf")
  }

  function refreshSelf(): void {
    if (!dfProc.running) dfProc.running = true
  }

  function bandFor(pct): int {
    if (pct >= 98) return 3
    if (pct >= 90) return 2
    if (pct >= 80) return 1
    return 0
  }

  function agentPrompt(m): string {
    return "Mount Monitor: " + m.target + " is " + m.pct + "% full. Run the disk-prune skill: scan " +
           m.target + " for prune and compress candidates, then report ranked suggestions with sizes."
  }

  function runAgent(m): void {
    var cmd = root.setting("agentCommand", null)
    if (cmd && cmd.length > 0) {
      agentProc.command = cmd.concat([root.agentPrompt(m)])
    } else {
      agentProc.command = ["omarchy", "agent", "prompt", root.agentPrompt(m)]
    }
    agentProc.running = true
  }

  function fireNextAlert(): void {
    if (root.activeAlert !== null || root.alertQueue.length === 0) return
    root.activeAlert = root.alertQueue.shift()
    var m = root.activeAlert
    var band = bandFor(m.pct)
    notifyProc.command = [
      "notify-send",
      "-A", "default=Run cleanup analysis",
      "-u", band === 3 ? "critical" : "normal",
      "-t", band === 3 ? "0" : "6000",
      "Mount Monitor — " + (band === 3 ? "CRITICAL" : "warning"),
      m.target + " is " + m.pct + "% full — " + m.avail + " free. Click to have your agent find prune/compress candidates."
    ]
    notifyProc.running = true
  }

  function checkBands(list): void {
    var next = ({})
    for (var i = 0; i < list.length; i++) {
      var m = list[i]
      var band = bandFor(m.pct)
      next[m.target] = band
      var prev = root.bands[m.target]
      // alert only when a mount crosses UP into a new band
      if ((prev === undefined || band > prev) && band > 0) {
        root.alertQueue.push(m)
      }
    }
    root.bands = next
    root.fireNextAlert()
  }

  function parseDf(text): void {
    var wanted = root.setting("mounts", ["/"])
    if (wanted === null || wanted === undefined) wanted = ["/"]
    var seen = ({})
    var byTarget = ({})
    var lines = String(text).split("\n")
    for (var i = 0; i < lines.length; i++) {
      var cols = lines[i].trim().split(/\s+/)
      if (cols.length < 5) continue
      var dev = cols[0].split("[")[0]
      if (seen[dev]) continue
      seen[dev] = true
      var pct = parseInt(cols[4], 10)
      if (isNaN(pct)) continue
      byTarget[cols[1]] = { target: cols[1], used: cols[2], avail: cols[3], pct: pct }
    }
    var list = []
    for (var j = 0; j < wanted.length; j++) {
      var m = byTarget[wanted[j]]
      if (m) list.push(m)
    }
    root.mounts = list
    root.checkBands(list)
  }

  implicitWidth: row.implicitWidth
  implicitHeight: row.implicitHeight

  Process {
    id: dfProc
    command: ["findmnt", "-rn", "-t", "btrfs", "-o", "SOURCE,TARGET,USED,AVAIL,USE%"]
    stdout: StdioCollector {
      onStreamFinished: root.parseDf(this.text)
    }
  }

  Process {
    id: notifyProc
    command: ["true"]
    property string lastOut: ""
    stdout: StdioCollector {
      onStreamFinished: notifyProc.lastOut = this.text
    }
    onExited: function(exitCode) {
      // notify-send prints the action identifier ("default") only when the
      // popup's action was clicked before expiry
      if (notifyProc.lastOut.indexOf("default") !== -1 && root.activeAlert) {
        root.runAgent(root.activeAlert)
      }
      root.activeAlert = null
      root.fireNextAlert()
    }
  }

  Process {
    id: agentProc
    command: ["true"]
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
          var t = root.setting("testPct", -1)
          return t >= 0 ? t : modelData.pct
        }
        readonly property bool warn: effPct >= 80
        readonly property bool critical: effPct >= 98
        bar: root.bar
        opticalSize: 22
        tooltipText: modelData.target + " — " + effPct + "% used · " +
                     modelData.used + " used · " + modelData.avail + " free"
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
