import QtQuick
import QtQuick.Layouts
import Quickshell
import qs.Commons
import qs.Ui
import "memory.js" as Memory
import "quattro.js" as Quattro

// QuattroDash — Memory Monitor's instrument-cluster panel, the board-approved
// design (rounds 1-7, verdict "ship it"). A PopupCard at the shell-standard
// width, mounted from MemoryMonitor.qml through its own Loader the way
// MemoryPanel.qml is. Two round meters (RAM PRESSURE and ROOT DRIVE), the
// SWAP RESERVE battery telltale with its LED bar, plus the VRAM COOLANT
// reservoir the captain expected here: free VRAM above the floor, sampled by
// this plugin's own nvidia-smi read and floored by its own vramFloorMib
// setting. Then the codes area: ONE column under one check-engine head, red
// and amber codes together, always most critical at the top, rows stretched
// wide so each code carries its full description. The reserved spares row the
// old footer showed is gone: future additions are not visible on the dash.
// Hover any instrument or code for the two-column teaching decode; click a
// moderate code to send the issue to the default agent, and a critical-band
// one to put it through the arm's gate.
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

  // The coolant card's floor, the PR-18 way: the widget's own vramFloorMib
  // setting through memory.js, 500 MiB unset (the captain's 2026-11-06
  // defaults steer, amber then at 1500 via the 1000 MiB approach margin; the
  // bar telltale keeps its own 3400).
  function floorMib() {
    return monitor && typeof monitor.vramFloorMib === "function"
      ? monitor.vramFloorMib() : Memory.vramFloorMib(null)
  }

  readonly property var reserve: Quattro.reserveReading(Memory.swapTotals(swaps))
  readonly property real psiSome: psi !== null && psi.some_avg10 !== undefined ? psi.some_avg10 : -1
  readonly property var psiNeedle: Quattro.psiNeedleFrac(psiSome < 0 ? null : psiSome)
  readonly property var fuelNeedle: Quattro.fuelNeedleFrac(rootDrive === null ? null : rootDrive.pctFree)
  readonly property var codes: Quattro.codesFromReadings(ram, vram, devices)

  // The coolant level and its band, quattro.js's mirrors of the PR-18
  // decisions, over this plugin's own VRAM reading. A missing reading is a
  // dim empty tank, never a confident zero.
  readonly property var coolantLevel: Quattro.coolantFill(
    vram === null ? null : vram.vramFreeMib,
    vram === null ? null : vram.vramTotalMib,
    floorMib())
  readonly property var coolantZone: Quattro.coolantBand(
    vram === null ? null : vram.vramFreeMib,
    vram === null ? null : vram.vramTotalMib,
    floorMib())
  readonly property color coolantTint: coolantZone === 2 ? Quattro.PAL.redHot
    : (coolantZone === 1 ? Quattro.PAL.amber
    : (coolantZone === 0 ? Quattro.PAL.green : Quattro.PAL.faceSym))

  // The one check-engine head tints by the most severe code showing.
  readonly property color codesHeadTint: Quattro.codesHeadToken(codes) === "red" ? Quattro.PAL.redHot
    : (Quattro.codesHeadToken(codes) === "amber" ? Quattro.PAL.amber : Quattro.PAL.faceSym)

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
  // No shell, no sentence built here. A critical-band code is a critical
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
  // Four lanes share the row now, so each is 100 units wide where the old
  // three-lane row drew 112 to 132; the dials letterbox inside their lanes.
  readonly property real innerW: card.contentWidth - card.padding * 2
  readonly property real unit: innerW / 419
  readonly property real laneW: 100 * unit
  readonly property real dialW: laneW
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

        // ---- The cluster row: RAM PRESSURE - SWAP RESERVE - ROOT DRIVE -
        //      VRAM COOLANT. Four lanes, one data source each.
        RowLayout {
          Layout.fillWidth: true
          spacing: 6

          ColumnLayout {
            id: psiWrap
            spacing: 4 * root.unit
            Layout.alignment: Qt.AlignTop
            Layout.preferredWidth: root.laneW
            Layout.maximumWidth: root.laneW

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
                onContainsMouseChanged: if (!containsMouse) root.hideTip()
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
              Layout.preferredWidth: root.laneW - text.length * 1.5
              Layout.maximumWidth: root.laneW - text.length * 1.5
              fontSizeMode: Text.HorizontalFit
              minimumPixelSize: 7
              horizontalAlignment: Text.AlignHCenter
              Layout.alignment: Qt.AlignHCenter
            }
          }

          ColumnLayout {
            id: battWrap
            spacing: 4 * root.unit
            Layout.alignment: Qt.AlignTop
            Layout.preferredWidth: root.laneW
            Layout.maximumWidth: root.laneW

            Rectangle {
              id: battBox
              Layout.alignment: Qt.AlignHCenter
              width: root.laneW
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
                      width: (84 * root.unit - (Quattro.LED_COUNT - 1) * 2) / Quattro.LED_COUNT
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
                onContainsMouseChanged: if (!containsMouse) root.hideTip()
                onPositionChanged: if (containsMouse) root.showTip(battBox.tip(), battArea, mouse.x, mouse.y)
              }
            }

            Text {
              text: Quattro.INSTRUMENTS.batt
              color: root.dim
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              font.bold: true
              font.letterSpacing: 1.5
              Layout.preferredWidth: root.laneW - text.length * 1.5
              Layout.maximumWidth: root.laneW - text.length * 1.5
              fontSizeMode: Text.HorizontalFit
              minimumPixelSize: 7
              horizontalAlignment: Text.AlignHCenter
              Layout.alignment: Qt.AlignHCenter
            }
          }

          ColumnLayout {
            id: fuelWrap
            spacing: 4 * root.unit
            Layout.alignment: Qt.AlignTop
            Layout.preferredWidth: root.laneW
            Layout.maximumWidth: root.laneW

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
                onContainsMouseChanged: if (!containsMouse) root.hideTip()
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
              Layout.preferredWidth: root.laneW - text.length * 1.5
              Layout.maximumWidth: root.laneW - text.length * 1.5
              fontSizeMode: Text.HorizontalFit
              minimumPixelSize: 7
              horizontalAlignment: Text.AlignHCenter
              Layout.alignment: Qt.AlignHCenter
            }
          }

          ColumnLayout {
            id: coolantWrap
            spacing: 4 * root.unit
            Layout.alignment: Qt.AlignTop
            Layout.preferredWidth: root.laneW
            Layout.maximumWidth: root.laneW

            function tip() {
              return Quattro.coolantTip(
                root.vram === null ? null : { present: true, freeMib: root.vram.vramFreeMib, totalMib: root.vram.vramTotalMib },
                root.floorMib())
            }

            Item {
              width: root.dialW
              height: root.dialH

              QuattroCoolant {
                anchors.fill: parent
                fill: root.coolantLevel
                tint: root.coolantTint
              }

              MouseArea {
                id: coolantArea
                anchors.fill: parent
                hoverEnabled: true
                acceptedButtons: Qt.NoButton
                cursorShape: Qt.PointingHandCursor
                onContainsMouseChanged: if (!containsMouse) root.hideTip()
                onPositionChanged: if (containsMouse) root.showTip(coolantWrap.tip(), coolantArea, mouse.x, mouse.y)
              }
            }

            Text {
              text: Quattro.INSTRUMENTS.coolant
              color: root.dim
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              font.bold: true
              font.letterSpacing: 1.5
              Layout.preferredWidth: root.laneW - text.length * 1.5
              Layout.maximumWidth: root.laneW - text.length * 1.5
              fontSizeMode: Text.HorizontalFit
              minimumPixelSize: 7
              horizontalAlignment: Text.AlignHCenter
              Layout.alignment: Qt.AlignHCenter
            }
          }
        }

        // ---- The codes area: ONE column under one check-engine head. Red and
        //      amber codes share the space, always most critical at the top,
        //      rows stretched wide so each code carries its full description
        //      (the captain's live-look ruling). Rows are the monitor's own
        //      live faults; the head tints by the most severe code showing,
        //      and an empty column says so in words instead of showing a
        //      section with nothing under it.
        Item {
          Layout.fillWidth: true
          implicitHeight: 1
          Rectangle {
            anchors.fill: parent
            color: Quattro.PAL.line
          }
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
              color: root.codesHeadTint
            }
          }

          Repeater {
            model: root.codes

            QuattroCodeRow {
              required property var modelData
              entry: modelData
              Layout.fillWidth: true
            }
          }

          Text {
            visible: root.codes.length === 0
            text: Quattro.codesEmptyText()
            color: root.dim
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            Layout.alignment: Qt.AlignHCenter
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
  // QuattroCoolant: the VRAM headroom tank, the PR-18 reservoir artwork. The
  // level is the headroom quattro.js decided (coolantFill) and the tint the
  // band chose (coolantBand); the geometry numbers are quattro.js's COOLANT
  // record; this painter only draws, the same way QuattroDial only draws. The
  // outline is stroked dimmer than the liquid, so the level reads before the
  // tank does; the liquid's top edge carries the shallow fixed coolant wave,
  // drawn once - nothing animates, because a telltale that moves on its own is
  // a telltale that lies.
  component QuattroCoolant : Item {
    id: coolantTank

    property real fill: 1
    property color tint: "#ffffff"

    onFillChanged: tank.requestPaint()
    onTintChanged: tank.requestPaint()
    Component.onCompleted: tank.requestPaint()

    Canvas {
      id: tank
      anchors.fill: parent
      onPaint: {
        var ctx = getContext("2d")
        ctx.reset()
        var w = width
        var h = height
        if (w < 2 || h < 2) return
        var C = Quattro.COOLANT
        var lw = Math.max(1, Math.min(w, h) * C.strokeFract)
        var m = lw * C.insetFract
        var x = m
        var y = m
        var iw = w - m * 2
        var ih = h - m * 2
        var r = Math.min(iw, ih) * C.radiusFract

        var frac = coolantTank.fill
        if (!isFinite(frac)) frac = 0
        if (frac < 0) frac = 0
        if (frac > 1) frac = 1

        // tank outline
        ctx.beginPath()
        roundedRect(ctx, x, y, iw, ih, r)
        ctx.lineWidth = lw
        ctx.strokeStyle = coolantTank.tint
        ctx.globalAlpha = C.dimAlpha
        ctx.stroke()

        if (frac <= 0) return

        // liquid, from the inner bottom up to the level, kept inside the
        // stroke. A very low level draws a thin strip without a wave, because
        // the wave needs room the strip does not have.
        var level = y + ih * (1 - frac)
        var minLevel = y + ih - Math.max(lw * 0.75, ih * C.stripFract)
        var waveTop = Math.max(level, y + lw)
        var surface = Math.min(waveTop, minLevel)
        var amp = surface > minLevel - ih * C.waveFract ? 0 : ih * C.waveFract

        ctx.beginPath()
        ctx.moveTo(x + lw / 2, y + ih - lw / 2)
        ctx.lineTo(x + lw / 2, surface + amp)
        if (amp > 0) {
          ctx.quadraticCurveTo(x + iw * 0.25, surface - amp, x + iw * 0.5, surface)
          ctx.quadraticCurveTo(x + iw * 0.75, surface + amp, x + iw - lw / 2, surface + amp)
        }
        ctx.lineTo(x + iw - lw / 2, y + ih - lw / 2)
        ctx.closePath()
        ctx.fillStyle = coolantTank.tint
        ctx.globalAlpha = 1.0
        ctx.fill()
      }

      function roundedRect(ctx, x, y, w, h, r) {
        ctx.moveTo(x + r, y)
        ctx.lineTo(x + w - r, y)
        ctx.arcTo(x + w, y, x + w, y + r, r)
        ctx.lineTo(x + w, y + h - r)
        ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
        ctx.lineTo(x + r, y + h)
        ctx.arcTo(x, y + h, x, y + h - r, r)
        ctx.lineTo(x, y + r)
        ctx.arcTo(x, y, x + r, y, r)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // QuattroCodeRow: one code chip in the merged column. The code, its reading
  // line and its status line are quattro.js data. Rows stretch the full card
  // width so each code carries more description than the old half-width chip;
  // click sends the plugin's own agent prompt and lights the toast; a sent row
  // dims.
  component QuattroCodeRow : Rectangle {
    id: codeRow

    property var entry: null
    readonly property bool severe: entry !== null && entry.sev === "r"
    readonly property bool hovered: area.containsMouse
    readonly property bool sent: entry !== null && root.sentCodes[entry.code] === true

    radius: 8
    height: 44
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
      onContainsMouseChanged: if (!containsMouse) root.hideTip()
      onPositionChanged: if (containsMouse) root.showTip(codeRow.tip(), codeRow, mouse.x, mouse.y)
    }

    RowLayout {
      anchors.fill: parent
      anchors.leftMargin: 9
      anchors.rightMargin: 9
      spacing: 9

      Text {
        text: codeRow.entry !== null ? codeRow.entry.code : ""
        color: codeRow.severe ? Quattro.PAL.redHot : Quattro.PAL.amber
        font.family: Style.font.family
        font.pixelSize: Style.font.body
        font.bold: true
        font.letterSpacing: 0.7
      }

      ColumnLayout {
        spacing: 1
        Layout.fillWidth: true

        Text {
          text: codeRow.entry !== null ? codeRow.entry.issue : ""
          color: root.fg
          font.family: Style.font.family
          font.pixelSize: Style.font.bodySmall
          elide: Text.ElideRight
          Layout.fillWidth: true
        }

        Text {
          text: codeRow.entry !== null ? codeRow.entry.status : ""
          color: codeRow.severe ? Quattro.PAL.redHot : Quattro.PAL.amber
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
          elide: Text.ElideRight
          Layout.fillWidth: true
        }
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
