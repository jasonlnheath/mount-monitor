import QtQuick
import QtQuick.Shapes
import "quattro.js" as Quattro

// One ISO 2575 / ISO 7000 road-vehicle telltale, drawn from quattro.js's
// verbatim symbol data - the artwork the board approved, Public domain / CC0
// on Wikimedia Commons, licenses recorded in the design report. This item only
// scales and tints: every path, its fill-or-stroke role and its stroke width
// are quattro.js data (SYMBOLS), so the artwork has exactly one source and no
// geometry lives in a QML file. Scaling is SVG's letterbox rule: the art is
// drawn uniformly at the smaller axis ratio and centered, the way an <svg>
// viewBox letterboxes under the default preserveAspectRatio, so a wide symbol
// in a square item is not stretched tall. The dashboard's instruments and the
// bar emblem's check-engine logo all render through this one component.
Item {
  id: root

  property string symbol: ""
  property color color: "#ffffff"

  readonly property var def: Quattro.SYMBOLS[symbol] === undefined ? null : Quattro.SYMBOLS[symbol]
  readonly property real vx: def ? Math.max(1, def.viewBox[2]) : 1
  readonly property real vy: def ? Math.max(1, def.viewBox[3]) : 1
  readonly property real fit: Math.min(root.width / root.vx, root.height / root.vy)

  implicitWidth: vx
  implicitHeight: vy

  Shape {
    width: root.vx * root.fit
    height: root.vy * root.fit
    x: (root.width - width) / 2
    y: (root.height - height) / 2
    transform: Scale {
      xScale: root.fit
      yScale: root.fit
    }

    // ShapePath is a QObject, not an Item, so a Repeater refuses it as a
    // delegate ("Delegate must be of Item type") and the symbol draws nothing.
    // Each artwork item therefore gets its own Shape - an Item the Repeater
    // accepts - holding one ShapePath. Item children share this Shape's local
    // coordinate system, so the fit Scale above carries them all: no path is
    // ever created outside this Shape.
    Repeater {
      model: root.def ? root.def.items : null

      delegate: Shape {
        required property var modelData
        anchors.fill: parent

        ShapePath {
          strokeColor: modelData.stroke === true ? root.color : "transparent"
          strokeWidth: modelData.stroke === true ? modelData.width : 0
          fillColor: modelData.fill === true ? root.color : "transparent"

          PathSvg {
            path: modelData.d
          }
        }
      }
    }
  }
}
