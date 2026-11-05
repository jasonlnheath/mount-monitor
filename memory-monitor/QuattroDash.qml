import QtQuick
import QtQuick.Layouts
import Quickshell
import qs.Commons
import qs.Ui
import "memory.js" as Memory
import "quattro.js" as Quattro

// Quattro Dash — Memory Monitor's instrument-cluster panel, the board-approved
// design (rounds 1-7, verdict "ship it"). A PopupCard at the shell-standard
// width, mounted from MemoryMonitor.qml through its own Loader the way
// MemoryPanel.qml is. Two round meters (RAM PRESSURE and ROOT DRIVE), a
// SWAP RESERVE battery telltale with its LED bar, the codes area: two
// columns under the check-engine heads, one amber for moderate codes and one
// red for severe ones, and the reserved spares row the approved footer shows.
// Hover any instrument or code for the two-column teaching decode; click a
// moderate code to send the issue to the default agent, and a severe one to
// put it through the arm's gate.
//
// This file draws. Every decision lives in quattro.js (bands, needle geometry,
// zones, LED counts, code taxonomy, all copy) and memory.js (the swap totals,
// the agent prompt, the agent argv, the arm gate), so the fixed sentences the
// design approved exist in exactly one testable place. The popup never renders
// an unavailable reading as a number: a missing PSI or root reading hides its
// needle and the Now line says so.
Panel {
  id: root

  moduleName: "io.github.jasonlnheath.memory-monitor"
  // The bar widget owns the IPC target for this plugin; the dashboard is driven
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

  function callMonitor(name, args, fallback) {
    if (monitor && typeof monitor[name] === "function") return monitor[name].apply(monitor, args)
    return fallback
  }

  // ---- Readings, straight from the monitor's own sample state.
  readonly property var psi: mon("psi", null)
  readonly property var swaps: mon("swaps", null)
  readonly property var rootDrive: mon("rootReading", null)
  readonly property var ram: mon("ramReading", null)
  readonly property var vram: mon("vramReading", null)
  readonly property var devices: mon("hdDevices", [])

  readonly property var reserve: Quattro.reserveReading(Memory.swapTotals(swaps))
  readonly property real psiSome: psi !== null && psi.some_avg10 !== undefined ? psi.some_avg10 : -1
  readonly property var psiNeedle: Quattro.psiNeedleFrac(psiSome < 0 ? null : psiSome)
  readonly property var fuelNeedle: Quattro.fuelNeedleFrac(rootDrive === null ? null : rootDrive.pctFree)
  readonly property var codes: Quattro.codesFromReadings(ram, vram, devices)

  // Codes stay dimmed once their issue was dispatched (mockup .code.sent).
  property var sentCodes: ({})

  function markSent(code) {
    var next = JSON.parse(JSON.stringify(sentCodes))
    next[code] = true
    sentCodes = next
  }

  // The click path is the plugin's own typed argv: the SAME fixed prompt the
  // toasts send, built by memory.js, one paragraph in one argv element, run
  // detached, with the same agentInline setting every other click path honors.
  // No shell, no sentence built here. A severe code is a critical-band
  // dispatch, so it never launches an agent of its own: it asks the monitor to
  // put it through the arm's gate and launch, and a refused click says so.
  function dispatchCode(code) {
    if (Memory.isArmNotice(code.alert)) {
      var decision = callMonitor("dispatchCriticalCode", [code.alert], null)
      if (decision === null || decision.started !== true) {
        showToast(Quattro.dispatchRefused(code.code, decision === null ? "" : decision.why), true)
        return
      }
      markSent(code.code)
      showToast(Quattro.dispatchToast(code.code, true))
      return
    }
    var reading = callMonitor("readingFor", [code.alert.type, code.alert], null)
    var prompt = Memory.agentPrompt(code.alert, reading, mon("oomd", null), mon("baselinePath", ""))
    var argv = Memory.normalizeBool(callMonitor("setting", ["agentInline", false], false), false)
      ? Memory.agentArgvWithInline(prompt, callMonitor("agentCommandArgv", [], null))
      : Memory.agentArgv(prompt, callMonitor("agentCommandArgv", [], null))
    Quickshell.execDetached(argv)
    markSent(code.code)
    showToast(Quattro.dispatchToast(code.code, code.sev === "r"))
  }

  // ---------------------------------------------------------------------------
  // Layout measures. The mockup is designed on the 443px card (the
  // shell-standard Style.space(380) at this rig's font scale), inner width 419.
  // Instruments scale with the card; fonts stay at the shell's own tokens.
  readonly property real innerW: card.contentWidth - card.padding * 2
  readonly property real unit: innerW / 419
  readonly property real dialW: 132 * unit
  readonly property real dialH: 118 * unit

  CardBar { id: cardBar; api: root.bar }

  PopupCard {
    id: card
    anchorItem: root.anchorItem
    bar: cardBar
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

        // ---- The cluster row: RAM PRESSURE - SWAP RESERVE - ROOT DRIVE.
        RowLayout {
          Layout.fillWidth: true
          spacing: 6

          ColumnLayout {
            id: psiWrap
            spacing: 4 * root.unit
            Layout.alignment: Qt.AlignTop

            function tip() {
              return Quattro.psiTip(psiSome < 0 ? null : { some_avg10: psiSome })
            }

            Item {
              width: root.dialW
              height: root.dialH

              QuattroDial {
                anchors.fill: parent
                zones: Quattro.psiZoneArcs
                labels: Quattro.psiLabels
                needle: root.psiNeedle
                faceSymbol: "temp"
              }

              MouseArea {
                id: psiArea
                anchors.fill: parent
                hoverEnabled: true
                acceptedButtons: Qt.NoButton
                cursorShape: Qt.PointingHandCursor
                onContainsMouseChanged: if (containsMouse) root.showTip(psiWrap.tip(), psiArea, mouse.x, mouse.y)
                else root.hideTip()
                onPositionChanged: if (containsMouse) root.showTip(psiWrap.tip(), psiArea, mouse.x, mouse.y)
              }
            }

            Text {
              text: Quattro.INSTRUMENTS.psi
              color: root.dim
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              font.bold: true
              font.letterSpacing: 1.5
              Layout.alignment: Qt.AlignHCenter
            }
          }

          Item { Layout.fillWidth: true }

          ColumnLayout {
            id: battWrap
            spacing: 4 * root.unit
            Layout.alignment: Qt.AlignTop

            Rectangle {
              id: battBox
              Layout.alignment: Qt.AlignHCenter
              width: 112 * root.unit
              height: battContent.implicitHeight + 17 * root.unit
              color: Quattro.PAL.face
              radius: 10
              border.width: 1
              border.color: Quattro.PAL.line

              function tip() {
                return Quattro.battTip(root.reserve)
              }

              ColumnLayout {
                id: battContent
                anchors.centerIn: parent
                spacing: 4 * root.unit

                Item {
                  width: 30 * root.unit
                  height: 30 * root.unit
                  Layout.alignment: Qt.AlignHCenter

                  QuattroSymbol {
                    id: battIcon
                    anchors.fill: parent
                    symbol: "battery"
                    color: root.reserve.pct >= Quattro.LED_GREEN_AT ? Quattro.PAL.green
                      : (root.reserve.pct >= Quattro.LED_YELLOW_AT ? Quattro.PAL.amber : Quattro.PAL.redHot)

                    SequentialAnimation {
                      running: Quattro.ledBand(root.reserve.pct) === "red"
                      loops: Animation.Infinite
                      NumberAnimation { target: battIcon; property: "opacity"; from: 1.0; to: 0.4; duration: 550 }
                      NumberAnimation { target: battIcon; property: "opacity"; from: 0.4; to: 1.0; duration: 550 }
                    }
                  }
                }

                Row {
                  spacing: 2
                  Layout.alignment: Qt.AlignHCenter

                  Repeater {
                    model: Quattro.LED_COUNT

                    Rectangle {
                      required property int index
                      width: (92 * root.unit - (Quattro.LED_COUNT - 1) * 2) / Quattro.LED_COUNT
                      height: 9
                      radius: 2
                      readonly property bool lit: index < Quattro.litSegments(root.reserve.pct)
                      readonly property color bandColor: Quattro.ledBand(root.reserve.pct) === "green" ? Quattro.PAL.green
                        : (Quattro.ledBand(root.reserve.pct) === "yellow" ? Quattro.PAL.amber : Quattro.PAL.redHot)
                      color: lit ? bandColor : Quattro.PAL.ledOff
                      border.width: 1
                      border.color: lit ? bandColor : Quattro.PAL.line
                    }
                  }
                }
              }

              MouseArea {
                id: battArea
                anchors.fill: parent
                hoverEnabled: true
                acceptedButtons: Qt.NoButton
                cursorShape: Qt.PointingHandCursor
                onContainsMouseChanged: if (containsMouse) root.showTip(battWrap.tip(), battArea, mouse.x, mouse.y)
                else root.hideTip()
                onPositionChanged: if (containsMouse) root.showTip(battWrap.tip(), battArea, mouse.x, mouse.y)
              }
            }

            Text {
              text: Quattro.INSTRUMENTS.batt
              color: root.dim
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              font.bold: true
              font.letterSpacing: 1.5
              Layout.alignment: Qt.AlignHCenter
            }
          }

          Item { Layout.fillWidth: true }

          ColumnLayout {
            id: fuelWrap
            spacing: 4 * root.unit
            Layout.alignment: Qt.AlignTop

            function tip() {
              return Quattro.fuelTip(root.rootDrive)
            }

            Item {
              width: root.dialW
              height: root.dialH

              QuattroDial {
                anchors.fill: parent
                zones: Quattro.fuelZoneArcs
                labels: Quattro.fuelLabels
                needle: root.fuelNeedle
                faceSymbol: "fuel"
              }

              MouseArea {
                id: fuelArea
                anchors.fill: parent
                hoverEnabled: true
                acceptedButtons: Qt.NoButton
                cursorShape: Qt.PointingHandCursor
                onContainsMouseChanged: if (containsMouse) root.showTip(fuelWrap.tip(), fuelArea, mouse.x, mouse.y)
                else root.hideTip()
                onPositionChanged: if (containsMouse) root.showTip(fuelWrap.tip(), fuelArea, mouse.x, mouse.y)
              }
            }

            Text {
              text: Quattro.INSTRUMENTS.fuel
              color: root.dim
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              font.bold: true
              font.letterSpacing: 1.5
              Layout.alignment: Qt.AlignHCenter
            }
          }
        }

        // ---- The codes area: amber column | hairline | red column, each under
        //      its check-engine head. Rows are the monitor's own live faults.
        Item {
          Layout.fillWidth: true
          implicitHeight: 1
          Rectangle {
            anchors.fill: parent
            color: Quattro.PAL.line
          }
        }

        RowLayout {
          Layout.fillWidth: true
          spacing: 10

          ColumnLayout {
            Layout.fillWidth: true
            spacing: 5

            Item {
              Layout.alignment: Qt.AlignHCenter
              width: 17
              height: 17
              QuattroSymbol {
                anchors.fill: parent
                symbol: "mil"
                color: Quattro.PAL.amber
              }
            }

            Repeater {
              model: root.amberCodes

              QuattroCodeRow {
                required property var modelData
                entry: modelData
                severe: false
                Layout.fillWidth: true
              }
            }
          }

          Rectangle {
            Layout.fillHeight: true
            implicitWidth: 1
            color: Quattro.PAL.line
          }

          ColumnLayout {
            Layout.fillWidth: true
            spacing: 5

            Item {
              Layout.alignment: Qt.AlignHCenter
              width: 17
              height: 17
              QuattroSymbol {
                anchors.fill: parent
                symbol: "mil"
                color: Quattro.PAL.redHot
              }
            }

            Repeater {
              model: root.severeCodes

              QuattroCodeRow {
                required property var modelData
                entry: modelData
                severe: true
                Layout.fillWidth: true
              }
            }
          }
        }

        // ---- The reserved spares row: the approved footer. The three unlit
        //      telltales for the lanes the design held back (oil, thermometer,
        //      hazard triangle), and the caption that says so. The symbols and
        //      the words are quattro.js data; this file only lays them out.
        Item {
          Layout.fillWidth: true
          implicitHeight: 1
          Rectangle {
            anchors.fill: parent
            color: Quattro.PAL.line
          }
        }

        RowLayout {
          Layout.alignment: Qt.AlignHCenter
          spacing: 10

          Repeater {
            model: Quattro.SPARES.symbols

            Item {
              required property var modelData
              width: 17
              height: 17

              QuattroSymbol {
                anchors.fill: parent
                symbol: parent.modelData
                color: Quattro.PAL.faceSym
              }
            }
          }

          Text {
            text: Quattro.SPARES.caption
            color: root.dim
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            font.bold: true
            font.letterSpacing: 1.5
          }
        }
      }
    }

    // ---- The hover decode, rendered inside the popup card (a layer-shell
    //      popup cannot extend past its window bounds - the round-3 note).
    //      Pointer events pass straight through it.
    Item {
      id: tipLayer
      anchors.fill: parent
      visible: false

      Rectangle {
        id: tipCard
        visible: tipLayer.visible
        width: Math.min(320 * root.unit, tipLayer.width - 12)
        height: tipContent.implicitHeight + 18
        color: Quattro.PAL.tooltipBg
        radius: 10
        border.width: 1
        border.color: root.dim

        ColumnLayout {
          id: tipContent
          x: 9
          y: 9
          width: tipCard.width - 18
          spacing: 4

          Text {
            id: tipHeader
            text: root.tipHeaderText
            color: root.tipSevColor
            font.family: Style.font.family
            font.pixelSize: Style.font.bodySmall
            font.bold: true
            font.letterSpacing: 0.8
          }

          Repeater {
            model: root.tipRows

            RowLayout {
              id: tipRow
              required property var modelData
              Layout.fillWidth: true
              spacing: 8

              Text {
                text: tipRow.modelData.label
                color: root.dim
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
                Layout.preferredWidth: 56
              }

              Text {
                text: tipRow.modelData.text
                color: tipRow.modelData.cls === "st-r" ? Quattro.PAL.redHot
                  : (tipRow.modelData.cls === "st-a" ? Quattro.PAL.amber : root.fg)
                font.family: Style.font.family
                font.pixelSize: Style.font.caption
                wrapMode: Text.Wrap
                Layout.fillWidth: true
              }
            }
          }
        }
      }
    }

    // ---- The dispatch toast: green-edged, bottom center, transient.
    Rectangle {
      id: toast
      anchors.horizontalCenter: parent.horizontalCenter
      anchors.bottom: parent.bottom
      anchors.bottomMargin: 12
      width: toastRow.implicitWidth + 28
      height: toastRow.implicitHeight + 16
      color: Quattro.PAL.tooltipBg
      radius: 10
      border.width: 1
      border.color: root.toastBad ? Quattro.PAL.redHot : Quattro.PAL.green
      z: 20
      visible: toastTimer.running
      opacity: toastTimer.running ? 1 : 0

      Behavior on opacity {
        NumberAnimation { duration: 200; easing.type: Easing.OutCubic }
      }

      RowLayout {
        id: toastRow
        anchors.centerIn: parent
        spacing: 8

        Text {
          text: root.toastMark
          color: root.toastBad ? Quattro.PAL.redHot : Quattro.PAL.green
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
          font.bold: true
        }

        Text {
          text: root.toastCode + " " + root.toastText
          color: root.fg
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
        }
      }

      Timer {
        id: toastTimer
        interval: 3800
      }
    }
  }

  // Which codes go in which column, severe first inside each.
  readonly property var amberCodes: {
    var out = []
    for (var i = 0; i < codes.length; i++) if (codes[i].sev === "a") out.push(codes[i])
    return out
  }
  readonly property var severeCodes: {
    var out = []
    for (var i = 0; i < codes.length; i++) if (codes[i].sev === "r") out.push(codes[i])
    return out
  }

  // ---- Tooltip state and placement -------------------------------------------

  property string tipHeaderText: ""
  property string tipSev: ""
  property var tipRows: []

  readonly property color tipSevColor: tipSev === "r" ? Quattro.PAL.redHot
    : (tipSev === "a" ? Quattro.PAL.amber : root.fg)

  function showTip(tip, sourceItem, px, py) {
    if (tip === null || tip === undefined) return
    tipHeaderText = tip.header === undefined ? "" : tip.header
    tipSev = tip.sev === undefined ? "" : tip.sev
    tipRows = tip.rows === undefined ? [] : tip.rows
    var pos = sourceItem.mapToItem(tipLayer, px, py)
    var w = tipCard.width
    var tx = Math.max(6, Math.min(pos.x + 14, tipLayer.width - w - 6))
    var ty = pos.y + 16
    if (ty + tipCard.height > tipLayer.height - 6) ty = pos.y - tipCard.height - 10
    tipCard.x = tx
    tipCard.y = Math.max(6, ty)
    tipLayer.visible = true
  }

  function hideTip() {
    tipLayer.visible = false
  }

  // ---------------------------------------------------------------------------
  // QuattroDial: one 240-degree meter. The face, zones, ticks, labels and the
  // glowing needle are painted from quattro.js geometry; nothing here decides.
  component QuattroDial : Item {
    id: dial

    property var zones: []
    property var labels: []
    property var needle: null
    property string faceSymbol: ""

    onNeedleChanged: face.requestPaint()
    onZonesChanged: face.requestPaint()
    onLabelsChanged: face.requestPaint()
    onWidthChanged: face.requestPaint()
    onHeightChanged: face.requestPaint()
    Component.onCompleted: face.requestPaint()

    Canvas {
      id: face
      anchors.fill: parent
      onPaint: {
        var ctx = getContext("2d")
        ctx.reset()
        var s = dial.width / Quattro.DIAL.viewW
        ctx.translate(0, (dial.height - Quattro.DIAL.viewH * s) / 2)
        ctx.scale(s, s)
        var D = Quattro.DIAL
        var P = Quattro.PAL

        ctx.beginPath()
        ctx.arc(D.cx, D.cy, D.faceR, 0, Math.PI * 2)
        ctx.fillStyle = P.face
        ctx.fill()
        ctx.lineWidth = 7
        ctx.strokeStyle = P.faceRing
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(D.cx, D.cy, D.faceR, 0, Math.PI * 2)
        ctx.lineWidth = 1.5
        ctx.globalAlpha = 0.7
        ctx.strokeStyle = P.line
        ctx.stroke()
        ctx.globalAlpha = 1

        for (var z = 0; z < dial.zones.length; z++) {
          var zone = dial.zones[z]
          var fromDeg = Quattro.needleAngleDeg(zone.from)
          var toDeg = Quattro.needleAngleDeg(zone.to)
          ctx.beginPath()
          ctx.arc(D.cx, D.cy, D.zoneR, (fromDeg - 90) * Math.PI / 180, (toDeg - 90) * Math.PI / 180)
          ctx.lineWidth = D.zoneWidth
          ctx.strokeStyle = zone.kind === "red" ? P.redHot : P.amber
          ctx.globalAlpha = zone.kind === "red" ? 0.9 : 0.85
          ctx.stroke()
          ctx.globalAlpha = 1
        }

        var ticks = Quattro.dialTicks()
        for (var t = 0; t < ticks.length; t++) {
          var tick = ticks[t]
          var deg = D.a0 + D.sweep * tick.f
          var p1 = Quattro.polar(D.cx, D.cy, D.tickOuter, deg)
          var p2 = Quattro.polar(D.cx, D.cy, tick.major ? D.tickMajor : (tick.mid ? D.tickMid : D.tickMinor), deg)
          ctx.beginPath()
          ctx.moveTo(p1.x, p1.y)
          ctx.lineTo(p2.x, p2.y)
          ctx.lineWidth = tick.major ? 2.6 : 1.4
          ctx.strokeStyle = tick.major ? P.tickMajor : P.tickMinor
          ctx.stroke()
        }

        ctx.font = "15px " + Style.font.resolvedFamily
        ctx.textAlign = "center"
        for (var l = 0; l < dial.labels.length; l++) {
          var label = dial.labels[l]
          var ldeg = D.a0 + D.sweep * label.f
          var lp = Quattro.polar(D.cx, D.cy, D.labelR, ldeg)
          ctx.fillStyle = label.color !== undefined ? P[label.color] : P.mut
          ctx.fillText(label.t, lp.x, lp.y + 5)
        }

        if (dial.needle !== null && dial.needle !== undefined) {
          var ndeg = Quattro.needleAngleDeg(dial.needle)
          ctx.save()
          ctx.translate(D.cx, D.cy)
          ctx.rotate(ndeg * Math.PI / 180)
          ctx.shadowColor = P.needle
          ctx.shadowBlur = 3
          ctx.beginPath()
          ctx.moveTo(0, D.needleTail)
          ctx.lineTo(0, -D.needleTip)
          ctx.lineWidth = 4.5
          ctx.lineCap = "round"
          ctx.strokeStyle = P.needle
          ctx.stroke()
          ctx.beginPath()
          ctx.arc(0, 0, D.hubR, 0, Math.PI * 2)
          ctx.fillStyle = P.hub
          ctx.fill()
          ctx.shadowBlur = 0
          ctx.beginPath()
          ctx.arc(0, 0, D.hubDotR, 0, Math.PI * 2)
          ctx.fillStyle = P.hubDot
          ctx.fill()
          ctx.restore()
        }
      }
    }

    QuattroSymbol {
      symbol: dial.faceSymbol
      width: 20 * root.unit
      height: 20 * root.unit
      x: dial.width / 2 - width / 2
      y: dial.height * 0.66 - height / 2
      color: Quattro.PAL.faceSym
    }
  }

  // ---------------------------------------------------------------------------
  // QuattroCodeRow: one code chip. The code, its one-line description, the
  // severity dot and both Fix lines are quattro.js data. Click sends the
  // plugin's own agent prompt and lights the toast; a sent row dims.
  component QuattroCodeRow : Rectangle {
    id: codeRow

    property var entry: null
    property bool severe: false
    readonly property bool hovered: area.containsMouse
    readonly property bool sent: entry !== null && root.sentCodes[entry.code] === true

    radius: 8
    height: 26
    color: hovered ? Quattro.PAL.hoverBg : Quattro.PAL.face
    border.width: 1
    border.color: hovered ? (severe ? Quattro.PAL.redHi : Quattro.PAL.mut) : Quattro.PAL.line
    opacity: sent ? 0.5 : 1

    function tip() {
      return Quattro.codeTip(entry)
    }

    MouseArea {
      id: area
      anchors.fill: parent
      hoverEnabled: true
      cursorShape: Qt.PointingHandCursor
      onClicked: {
        if (codeRow.entry === null) return
        root.dispatchCode(codeRow.entry)
      }
      onContainsMouseChanged: if (containsMouse) root.showTip(codeRow.tip(), codeRow, mouse.x, mouse.y)
      else root.hideTip()
      onPositionChanged: if (containsMouse) root.showTip(codeRow.tip(), codeRow, mouse.x, mouse.y)
    }

    RowLayout {
      anchors.fill: parent
      anchors.leftMargin: 9
      anchors.rightMargin: 9
      spacing: 7

      Text {
        text: codeRow.entry !== null ? codeRow.entry.code : ""
        color: codeRow.severe ? Quattro.PAL.redHot : Quattro.PAL.amber
        font.family: Style.font.family
        font.pixelSize: Style.font.body
        font.bold: true
        font.letterSpacing: 0.7
      }

      Text {
        text: codeRow.entry !== null ? codeRow.entry.desc : ""
        color: root.dim
        font.family: Style.font.family
        font.pixelSize: Style.font.bodySmall
        elide: Text.ElideRight
        Layout.fillWidth: true
      }

      Rectangle {
        width: 7
        height: 7
        radius: 3.5
        color: codeRow.sent ? Quattro.PAL.green : (codeRow.severe ? Quattro.PAL.redHot : Quattro.PAL.amber)
      }
    }
  }

  // ---- Toast state ------------------------------------------------------------

  property string toastMark: ""
  property string toastCode: ""
  property string toastText: ""
  property bool toastBad: false

  function showToast(t, bad) {
    toastMark = t.mark
    toastCode = t.code
    toastText = t.text
    toastBad = bad === true
    toastTimer.restart()
  }
}
