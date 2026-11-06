import QtQuick
import QtQuick.Layouts
import Quickshell
import qs.Commons
import qs.Ui
import "mounts.js" as Mounts

// The VRAM headroom telltale's detail window - Mount Monitor's MemoryPanel-
// style popup, mounted from MountMonitor.qml through a Loader the way the
// shell's own panels are mounted, with a PopupCard doing the windowing. Panel
// owns the open()/close()/opened contract the bar's panel routing looks for;
// this file owns the picture. The bar telltale shows severity only (the
// severity-only bar posture); this window is where the numbers live: the
// reading, the floor it is judged against, and the guarded state the telltale
// holds.
//
// Every decision lives in mounts.js - the state line, the number lines, the
// floor caption, the missing-reading copy - and the widget supplies the
// reading, the band, and the floor through the monitor reference, so the
// popup renders exactly what the telltale resolved and never re-decides.
// Everything here is a reading or a setting, never a lever.
Panel {
  id: root

  moduleName: "io.github.jasonlnheath.mount-monitor"
  // The bar widget owns the IPC target for this plugin; the panel is driven
  // through it, so it must not register a second handler on the same target.
  ipcTarget: ""
  manageIpc: false

  property var monitor: null
  property var anchorItem: null
  property var hostWidget: null

  readonly property color fg: bar ? bar.foreground : Color.foreground
  readonly property color dim: Qt.darker(fg, 1.5)

  function mon(name, fallback) {
    if (!monitor || typeof monitor[name] === "undefined") return fallback
    var value = monitor[name]
    return value === null || value === undefined ? fallback : value
  }

  readonly property var reading: mon("vramReading", null)
  readonly property int band: mon("vramBand", 0)
  readonly property string token: Mounts.vramTokenFor(band)
  readonly property color tint: token === "plain" ? fg : Mounts.vramTokenHex(token)
  function floorMib(): int {
    return monitor && typeof monitor.vramFloorMib === "function"
      ? monitor.vramFloorMib() : Mounts.normalizeFloorMib(null)
  }

  CardBar { id: cardBar; api: root.bar }

  PopupCard {
    id: card
    anchorItem: root.anchorItem
    bar: cardBar
    // The card's close is this panel's own close (Panel.close), the way the
    // memory monitor's panels do it: the bar widget's close() closes the
    // telltale panel, so delegating to the widget keeps one dismissal path.
    owner: root
    open: root.opened
    contentWidth: Style.space(280)
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
            text: "VRAM headroom"
            color: root.fg
            font.family: Style.font.family
            font.pixelSize: Style.font.title
            font.bold: true
            Layout.fillWidth: true
          }
          Text {
            text: Mounts.vramStateText(root.band)
            color: root.tint
            font.family: Style.font.family
            font.pixelSize: Style.font.bodySmall
          }
        }

        // The telltale at instrument size: same renderer, same fill, same
        // severity tint the bar shows, sized for reading rather than spotting.
        Item {
          Layout.fillWidth: true
          Layout.preferredHeight: Style.space(84)
          VramSymbol {
            id: gauge
            width: Style.space(84)
            height: Style.space(84)
            anchors.horizontalCenter: parent.horizontalCenter
            anchors.top: parent.top
            fill: root.reading !== null
              ? Mounts.vramHeadroomFrac(root.reading.freeMib, root.reading.totalMib, root.floorMib())
              : 0
            tint: root.tint
          }
        }

        Text {
          visible: root.reading !== null
          text: Mounts.vramFreeLine(root.reading)
          color: root.fg
          font.family: Style.font.family
          font.pixelSize: Style.font.body
          Layout.fillWidth: true
        }

        RowLayout {
          visible: root.reading !== null
          Layout.fillWidth: true
          Text {
            text: "Floor"
            color: root.dim
            font.family: Style.font.family
            font.pixelSize: Style.font.body
            Layout.fillWidth: true
          }
          Text {
            text: Mounts.vramFloorText(root.floorMib())
            color: root.fg
            font.family: Style.font.family
            font.pixelSize: Style.font.body
          }
        }

        RowLayout {
          visible: root.reading !== null
          Layout.fillWidth: true
          Text {
            text: Mounts.vramNameText(root.reading)
            color: root.dim
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            elide: Text.ElideRight
            Layout.fillWidth: true
          }
        }

        Text {
          visible: root.reading === null
          text: Mounts.vramMissingText()
          color: root.dim
          font.family: Style.font.family
          font.pixelSize: Style.font.body
          wrapMode: Text.WordWrap
          Layout.fillWidth: true
        }

        Text {
          text: Mounts.vramFloorCaption()
          color: root.dim
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
          wrapMode: Text.WordWrap
          Layout.fillWidth: true
        }
      }
    }
  }
}
