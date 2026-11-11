import QtQuick
import QtQuick.Layouts
import Quickshell
import qs.Commons
import qs.Ui
import "memory.js" as Memory

// Memory Monitor's detail window. It is a qs.Ui.Panel mounted from
// MemoryMonitor.qml through a Loader, the way the shell's own panels are
// mounted, with a PopupCard doing the windowing the way the third-party plugin
// precedents do theirs. Panel owns the open()/close()/opened contract the bar's
// panel routing looks for; this file owns the picture.
//
// Everything here is a reading or a ceiling, never a lever. The window shows
// "your ceiling" and "the kernel's ceiling" side by side because they are
// different numbers and only one of them is yours. It shows absolute GiB and MiB
// beside every percent, the clamped unattributed VRAM row labelled with what it
// is not, the swap and zram fill that escalate a System RAM alert, PSI as the
// re-alert gate, the amber alerts Do Not Disturb ate, and which bands are
// latched or unreachable. It never renders an unavailable measurement as 0%.
Panel {
  id: root

  moduleName: "io.github.jasonlnheath.memory-monitor"
  // The bar widget owns the IPC target for this plugin; the panel is driven
  // through it, so it must not register a second handler on the same target.
  ipcTarget: ""
  manageIpc: false

  property var monitor: null
  property var anchorItem: null
  property var hostWidget: null

  readonly property color fg: bar ? bar.foreground : Color.foreground
  readonly property color dim: Qt.darker(fg, 1.5)
  readonly property color warnColor: "#e0a030"
  readonly property color redColor: "#ff2d2d"

  function mon(name, fallback) {
    if (!monitor || typeof monitor[name] === "undefined") return fallback
    var value = monitor[name]
    return value === null || value === undefined ? fallback : value
  }

  function callMonitor(name, args, fallback) {
    if (monitor && typeof monitor[name] === "function") return monitor[name].apply(monitor, args)
    return fallback
  }

  function setCeiling(type, level, value) {
    var result = callMonitor("setCeiling", [type, level, value], { ok: false, errors: [Memory.setCeilingUnavailableText()] })
    ceilingError = result.ok ? "" : result.errors.join("; ")
    if (result.ok) ceilingError = ""
  }

  property string ceilingError: ""

  function runHealthCheck() {
    if (!monitor) return
    var prompt = Memory.healthCheckPrompt(monitor.baselinePath, monitor.state, monitor.oomd)
    var argv = Memory.agentArgv(prompt, monitor.agentCommandArgv())
    Quickshell.execDetached(argv)
  }

  readonly property var entries: monitor ? monitor.barEntries() : []
  readonly property var ram: mon("ramReading", null)
  readonly property var vram: mon("vramReading", null)
  readonly property var devices: mon("hdDevices", [])
  readonly property var oomd: mon("oomd", null)
  readonly property var mmState: mon("state", {})
  readonly property var alertEvents: mon("unseenAlerts", [])
  // The store that resolved the held ram band, so its release note quotes the
  // line the band actually crossed: the PSI pair for a pressure-held band,
  // the drawn batt pair inverted for a swap-held one.
  readonly property var ramRelease: root.ram === null ? null : Memory.ramReleaseStore(
    root.ram.signal, Memory.thresholdsFor(root.mmState, "ram"),
    callMonitor("gaugePairFor", ["batt"], null))

  function bandColor(band) {
    if (band >= 2) return root.redColor
    if (band === 1) return root.warnColor
    return root.fg
  }

  function rowLabel(text) {
    return text
  }

  CardBar { id: cardBar; api: root.bar }

  PopupCard {
    id: card
    anchorItem: root.anchorItem
    bar: cardBar
    // The card's close is this panel's own close (Panel.close), the way
    // QuattroDash's card does it: the bar widget's close() closes the dash, so
    // delegating to the widget would leave this window with no dismissal path.
    owner: root
    open: root.opened
    contentWidth: Style.space(380)
    contentHeight: Math.min(card.availableCardHeight - card.padding * 2, content.implicitHeight + card.padding * 2)

    Flickable {
      width: card.contentWidth - card.padding * 2
      height: card.contentHeight - card.padding * 2
      contentHeight: content.implicitHeight
      clip: true
      boundsBehavior: Flickable.StopAtBounds

      ColumnLayout {
        id: content
        width: parent.width
        spacing: Style.space(9)

        RowLayout {
          Layout.fillWidth: true
          Text {
            text: "Quattro Dash"
            color: root.fg
            font.family: Style.font.family
            font.pixelSize: Style.font.title
            font.bold: true
            Layout.fillWidth: true
          }
          Text {
            text: "guard: " + Memory.guardStateText(root.mmState)
            color: root.dim
            font.pixelSize: Style.font.caption
          }
        }

        PanelSeparator { Layout.fillWidth: true; foreground: root.fg }

        // ---- System RAM. The band reads MemAvailable, not percent-used, and
        //      the absolute number is shown beside the percent so the percent
        //      is never taken on faith.
        PanelSectionHeader { text: "System RAM"; foreground: root.fg }
        Text {
          visible: root.ram !== null
          // Round 7 item 2: the detail window's ram headline is the one-line
          // reading - pressure in PSI, the swap reserve, the available number,
          // and the held note when a band is stuck.
          text: root.ram === null ? "no reading"
            : Memory.ramReadingLine(root.ram)
          color: root.bandColor(root.ram === null ? 0 : root.ram.band)
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
          Layout.fillWidth: true
        }
        Text {
          visible: root.ram !== null
          text: root.ram === null ? "" : Memory.swapText(root.ram).split("\n").join("   ")
          color: root.dim
          font.pixelSize: Style.font.bodySmall
          Layout.fillWidth: true
        }
        Text {
          visible: root.ram !== null
          text: root.ram === null ? "" : Memory.psiText(root.ram)
          color: root.dim
          wrapMode: Text.Wrap
          font.pixelSize: Style.font.bodySmall
          Layout.fillWidth: true
        }
        Text {
          visible: root.ram !== null && root.ram.band >= 1
          text: root.ram === null || root.ramRelease === null ? "" : Memory.unreachableBandNote(
            root.ram.band, root.ramRelease.thresholds, root.ramRelease.type,
            root.ram.memAvailableKb, root.ram.memTotalKb, root.ram.signal)
          color: root.warnColor
          wrapMode: Text.Wrap
          font.pixelSize: Style.font.bodySmall
          Layout.fillWidth: true
        }

        PanelSeparator { Layout.fillWidth: true; foreground: root.fg }

        // ---- VRAM. First card only, named. The unattributed row is clamped at
        //      zero and labelled with what it is not.
        PanelSectionHeader { text: "VRAM"; foreground: root.fg }
        Text {
          visible: root.vram !== null
          text: root.vram === null ? "" : (root.vram.gpuName || "GPU") + "  (first card only)"
          color: root.dim
          font.pixelSize: Style.font.caption
          Layout.fillWidth: true
        }
        Text {
          visible: root.vram !== null
          text: root.vram === null ? "" : Memory.vramReadingLine(root.vram)
          color: root.bandColor(root.vram === null ? 0 : root.vram.band)
          font.pixelSize: Style.font.bodySmall
          Layout.fillWidth: true
        }
        Text {
          visible: root.vram !== null
          text: root.vram === null ? "" : Memory.vramUnattributedText(root.vram.vramUnattributedMib)
          color: root.dim
          wrapMode: Text.Wrap
          font.pixelSize: Style.font.bodySmall
          Layout.fillWidth: true
        }
        Text {
          visible: root.vram === null
          text: Memory.unavailableText("vram", monitor ? monitor.vramVerdict : "")
          color: root.warnColor
          wrapMode: Text.Wrap
          font.pixelSize: Style.font.bodySmall
          Layout.fillWidth: true
        }

        PanelSeparator { Layout.fillWidth: true; foreground: root.fg }

        // ---- Hard drives. Rows are per mount; alerts are per device, so five
        //      subvolumes read as five rows and one alert.
        PanelSectionHeader { text: "Hard drives"; foreground: root.fg }
        Repeater {
          model: root.devices
          ColumnLayout {
            Layout.fillWidth: true
            spacing: Style.space(2)
            required property var modelData
            readonly property string rowNote: {
              var note = Memory.hdRowNote(modelData.ro, modelData.fstype);
              var held = Memory.latchedText(modelData.latched);
              return held.length > 0 ? note + "   " + held : note;
            }
            Text {
              text: (modelData.targets || []).join(", ") + "   "
                + Memory.readingPct(modelData.pct) + "%   " + Memory.mib(modelData.usedKb) + " of " + Memory.mib(modelData.sizeKb)
              color: root.bandColor(modelData.band)
              font.pixelSize: Style.font.bodySmall
              Layout.fillWidth: true
            }
            Text {
              text: modelData.device + "   " + rowNote
              color: root.dim
              font.pixelSize: Style.font.caption
              Layout.fillWidth: true
            }
          }
        }
        Text {
          visible: root.devices.length === 0
          text: Memory.noWatchedDrivesText()
          color: root.dim
          wrapMode: Text.Wrap
          font.pixelSize: Style.font.bodySmall
          Layout.fillWidth: true
        }

        PanelSeparator { Layout.fillWidth: true; foreground: root.fg }

        // ---- Ceilings. Yours, and the kernel's, side by side. Amber and red
        //      are NumberFields; critical is a NumberField plus an explicit
        //      unset state, because "unset" is a value this plugin must be able
        //      to show and a SpinBox cannot hold it.
        PanelSectionHeader { text: "Your ceilings"; foreground: root.fg }
        Repeater {
          model: ["ram", "vram", "hd"]
          ColumnLayout {
            Layout.fillWidth: true
            spacing: Style.space(4)
            required property var modelData

            Text {
              text: Memory.kindLabel(modelData)
              color: root.dim
              font.pixelSize: Style.font.caption
            }
            RowLayout {
              spacing: Style.space(8)
              NumberField {
                label: "amber"
                value: Memory.thresholdsFor(root.mmState, modelData).amber
                from: 1
                to: 99
                foreground: root.fg
                accent: root.warnColor
                onModified: root.setCeiling(modelData, "amber", value)
              }
              NumberField {
                label: "red"
                value: Memory.thresholdsFor(root.mmState, modelData).red
                from: 1
                to: 99
                foreground: root.fg
                accent: root.fg
                onModified: root.setCeiling(modelData, "red", value)
              }
              NumberField {
                label: "critical"
                value: Memory.thresholdsFor(root.mmState, modelData).critical === null ? 99
                  : Memory.thresholdsFor(root.mmState, modelData).critical
                from: 1
                to: 99
                foreground: root.fg
                accent: root.redColor
                onModified: root.setCeiling(modelData, "critical", value)
              }
              Text {
                text: Memory.criticalIsSet(root.mmState, modelData) ? "" : "unset"
                color: root.warnColor
                font.pixelSize: Style.font.caption
              }
            }
            Text {
              text: Memory.ceilingText(modelData, root.mmState)
              color: root.dim
              wrapMode: Text.Wrap
              font.pixelSize: Style.font.caption
              Layout.fillWidth: true
            }
          }
        }
        Text {
          visible: root.ceilingError !== ""
          text: root.ceilingError
          color: root.redColor
          wrapMode: Text.Wrap
          font.pixelSize: Style.font.bodySmall
          Layout.fillWidth: true
        }

        PanelSeparator { Layout.fillWidth: true; foreground: root.fg }

        PanelSectionHeader { text: "The kernel's ceiling"; foreground: root.fg }
        Text {
          text: Memory.kernelCeilingText(root.oomd)
          color: root.dim
          wrapMode: Text.Wrap
          font.pixelSize: Style.font.bodySmall
          Layout.fillWidth: true
        }
        Text {
          text: Memory.twoCeilingsNote()
          color: root.dim
          wrapMode: Text.Wrap
          font.pixelSize: Style.font.caption
          Layout.fillWidth: true
        }

        PanelSeparator { Layout.fillWidth: true; foreground: root.fg }

        // ---- The standing guard. The ask is an insist: unanswered means armed.
        //      This is the only place a decline can be recorded, because a
        //      dismissed notification is not an answer the plugin can observe.
        PanelSectionHeader { text: "Standing guard"; foreground: root.fg }
        Text {
          text: Memory.guardStateText(root.mmState)
          color: root.dim
          wrapMode: Text.Wrap
          font.pixelSize: Style.font.bodySmall
          Layout.fillWidth: true
        }
        Text {
          text: Memory.guardNoteText()
          color: root.dim
          wrapMode: Text.Wrap
          font.pixelSize: Style.font.caption
          Layout.fillWidth: true
        }
        RowLayout {
          Layout.fillWidth: true
          Item { Layout.fillWidth: true }
          PanelActionButton {
            iconText: "turn guard on"
            tooltipText: Memory.guardArmTooltip()
            foreground: root.fg
            onClicked: if (monitor) monitor.applyGuardAnswer()
          }
          PanelActionButton {
            iconText: "turn guard off"
            tooltipText: Memory.guardDeclineTooltip()
            foreground: root.fg
            onClicked: if (monitor) monitor.declineGuardAsk()
          }
        }

        PanelSeparator { Layout.fillWidth: true; foreground: root.fg }

        PanelSectionHeader { text: "Alerts you did not see"; foreground: root.fg }
        Text {
          text: Memory.alertsYouDidNotSeeText(root.alertEvents)
          color: root.dim
          wrapMode: Text.Wrap
          font.pixelSize: Style.font.bodySmall
          Layout.fillWidth: true
        }

        PanelSeparator { Layout.fillWidth: true; foreground: root.fg }

        RowLayout {
          Layout.fillWidth: true
          Text {
            text: "Baseline log: " + (monitor ? monitor.baselinePath : "")
            color: root.dim
            font.pixelSize: Style.font.caption
            Layout.fillWidth: true
          }
          PanelActionButton {
            iconText: "health check"
            tooltipText: Memory.healthCheckTooltip()
            foreground: root.fg
            onClicked: root.runHealthCheck()
          }
        }
      }
    }
  }
}
