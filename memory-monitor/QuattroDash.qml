import QtQuick
import QtQuick.Layouts
import Quickshell
import qs.Commons
import qs.Ui
import "memory.js" as Memory
import "quattro.js" as Quattro

// QuattroDash — Memory Monitor's instrument-cluster panel, the board-approved
// design (rounds 1-7, verdict "ship it"), reworked by the captain's round-2
// live-look feedback (2026-11-07). A PopupCard at the shell-standard width,
// mounted from MemoryMonitor.qml through its own Loader the way MemoryPanel
// is. Two round meters (RAM PRESSURE and ROOT DRIVE) drawn at exactly the
// same size, the SWAP RESERVE battery telltale with its LED bar, and BELOW
// the battery the STANDARD ISO coolant warning light: the thermometer-in-
// liquid telltale quattro.js owns, centered, tinted green / amber / red by
// the free-VRAM thresholds (floor 500 MiB unset, amber 1000 MiB above it);
// hovering it shows VRAM used / reserved. Then the codes area: ONE column
// under one check-engine head, DRIVE codes only - RAM high is the pressure
// gauge and the reserve battery, never a code, and VRAM high lights the
// coolant light only. Clicking a code sends the plugin's agent prompt with
// the dash's own pre-computed diagnosis appended as a fenced JSON block, so
// Hermes explains from the dashboard's numbers.
//
// This file draws. Every decision lives in quattro.js (bands, needle
// geometry, zones, LED counts, code taxonomy, the diagnosis JSON, all copy)
// and memory.js (the swap totals, the agent prompt, the agent argv, the arm
// gate), so the fixed sentences the design approved exist in exactly one
// testable place. The popup never renders an unavailable reading as a
// number: a missing PSI or root reading hides its needle and the Now line
// says so.
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
  readonly property var vram: mon("vramReading", null)
  readonly property var devices: mon("hdDevices", [])
  readonly property var hdRows: mon("hdRows", [])

  // The coolant light's floor: the widget's own vramFloorMib
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

  // The gauge threshold pairs (the captain's 2026-11-07 ruling): one amber/red
  // pair per gauge, read from the monitor's persisted state through
  // gaugePairFor, and moved live by the settings row at the bottom. With no
  // monitor attached the pairs fall back to quattro.js's recommended defaults.
  function pairFor(key) {
    var p = callMonitor("gaugePairFor", [key], null)
    return p === null ? Quattro.gaugePair(key, null) : p
  }
  readonly property var psiPair: pairFor("psi")
  readonly property var hdPair: pairFor("hd")
  readonly property var battPair: pairFor("batt")
  readonly property var vramPair: pairFor("vram")

  // The coolant light's band (round 2: the tank card became the ISO light),
  // quattro.js's coolantBandWith over this plugin's own VRAM reading, fed the
  // settings pair, so the light's thresholds move live with the sliders. A
  // missing reading is the unlit tint, never a confident green.
  readonly property var coolantZone: Quattro.coolantBandWith(
    vram === null ? null : vram.vramFreeMib,
    vram === null ? null : vram.vramTotalMib,
    root.vramPair.red, root.vramPair.amber)
  readonly property color coolantTint: coolantZone === 2 ? Quattro.PAL.redHot
    : (coolantZone === 1 ? Quattro.PAL.amber
    : (coolantZone === 0 ? Quattro.PAL.green : Quattro.PAL.faceSym))

  // Round 2 doctrine: DRIVE codes only. RAM high is the pressure gauge and
  // the reserve battery, never an engine code; VRAM high lights the coolant
  // light only.
  readonly property var codes: Quattro.codesFromReadings(devices)

  // Codes stay dimmed once their issue was dispatched (mockup .code.sent).
  property var sentCodes: ({})

  function markSent(code) {
    var next = JSON.parse(JSON.stringify(sentCodes))
    next[code] = true
    sentCodes = next
  }

  // The click path is the plugin's own typed argv: the SAME fixed prompt the
  // toasts send, built by memory.js, with the dash's own pre-computed
  // diagnosis (quattro.js, round 2 item 8) appended as a fenced JSON block.
  // One paragraph in one argv element, run detached, with the same
  // agentInline setting every other click path honors. No shell, no sentence
  // built here. A critical-band code is a critical dispatch, so it never
  // launches an agent of its own: it asks the monitor to put it through the
  // arm's gate and launch, and a refused click says so.
  function dispatchCode(code) {
    var diagnosis = Quattro.diagnosisJson(code, hdRows)
    if (Memory.isArmNotice(code.alert)) {
      var decision = callMonitor("dispatchCriticalCode", [code.alert, diagnosis], null)
      if (decision === null || decision.started !== true) {
        showToast(Quattro.dispatchRefused(code.code, decision === null ? "" : decision.why), true)
        return
      }
      markSent(code.code)
      showToast(Quattro.dispatchToast(code.code, true))
      return
    }
    var reading = callMonitor("readingFor", [code.alert.type, code.alert], null)
    var prompt = Memory.promptWithDiagnosis(
      Memory.agentPrompt(code.alert, reading, mon("oomd", null), mon("baselinePath", "")),
      diagnosis)
    var argv = Memory.normalizeBool(callMonitor("setting", ["agentInline", false], false), false)
      ? Memory.agentArgvWithInline(prompt, callMonitor("agentCommandArgv", [], null))
      : Memory.agentArgv(prompt, callMonitor("agentCommandArgv", [], null))
    Quickshell.execDetached(argv)
    markSent(code.code)
    showToast(Quattro.dispatchToast(code.code, code.sev === "r"))
  }

  // The codes area head tints by the most severe DRIVE code showing; a
  // column with no drive codes is the unlit emblem, whatever RAM and VRAM
  // are doing.
  readonly property color codesHeadTint: Quattro.codesHeadToken(codes) === "red" ? Quattro.PAL.redHot
    : (Quattro.codesHeadToken(codes) === "amber" ? Quattro.PAL.amber : Quattro.PAL.faceSym)

  // ---------------------------------------------------------------------------
  // Layout measures. The mockup is designed on the 443px card (the
  // shell-standard Style.space(380) at this rig's font scale), inner width 419.
  // Instruments scale with the card; fonts stay at the shell's own tokens.
  // Three lanes share the row since round 2 (the coolant light moved below
  // the battery), so each lane is a third of the row and both gauges draw at
  // exactly the same size, the captain's item 3.
  readonly property real innerW: card.contentWidth - card.padding * 2
  readonly property real unit: innerW / 419
  readonly property real laneW: (419 - 2 * 6) * unit / 3
  readonly property real dialW: laneW
  readonly property real dialH: 124 * unit

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
        //      Three lanes, one data source each; the VRAM COOLANT light sits
        //      centered below the battery, out of the row (round 2).
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
              return Quattro.psiTipWith(psiSome < 0 ? null : { some_avg10: psiSome }, root.psiPair.amber, root.psiPair.red)
            }

            Item {
              width: root.dialW
              height: root.dialH

              QuattroDial {
                anchors.fill: parent
                zones: Quattro.psiZoneArcsFor(root.psiPair.amber, root.psiPair.red)
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
              horizontalAlignment: Text.AlignHCenter
              Layout.alignment: Qt.AlignHCenter
              Layout.fillWidth: true
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
                return Quattro.battTipWith(root.reserve, root.battPair.amber, root.battPair.red)
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
                    color: root.reserve.pct >= root.battPair.amber ? Quattro.PAL.green
                      : (root.reserve.pct >= root.battPair.red ? Quattro.PAL.amber : Quattro.PAL.redHot)

                    SequentialAnimation {
                      running: Quattro.ledBandWith(root.reserve.pct, root.battPair.amber, root.battPair.red) === "red"
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
                      readonly property string ledWord: Quattro.ledBandWith(root.reserve.pct, root.battPair.amber, root.battPair.red)
                      readonly property color bandColor: ledWord === "green" ? Quattro.PAL.green
                        : (ledWord === "yellow" ? Quattro.PAL.amber : Quattro.PAL.redHot)
                      color: lit ? bandColor : Quattro.PAL.ledOff
                      border.width: 1
                      border.color: lit ? bandColor : Quattro.PAL.line
                    }
                  }
                }

                // The reserve's threshold ticks (the captain's 2026-11-07
                // ruling): where the drawn amber and red lines sit, red below
                // amber, because this gauge's bad end is empty.
                Item {
                  width: 84 * root.unit
                  height: 5
                  Layout.alignment: Qt.AlignHCenter

                  Rectangle {
                    anchors.bottom: parent.bottom
                    width: parent.width
                    height: 1
                    color: Quattro.PAL.line
                  }

                  Repeater {
                    model: Quattro.battTickFracs(root.battPair)

                    Rectangle {
                      required property var modelData
                      x: Math.max(0, Math.min(parent.width - 1.5, parent.width * modelData.f - 0.75))
                      y: 0
                      width: 1.5
                      height: parent.height
                      color: modelData.cls === "red" ? Quattro.PAL.redHot : Quattro.PAL.amber
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
              horizontalAlignment: Text.AlignHCenter
              Layout.alignment: Qt.AlignHCenter
              Layout.fillWidth: true
            }
          }

          ColumnLayout {
            id: fuelWrap
            spacing: 4 * root.unit
            Layout.alignment: Qt.AlignTop
            Layout.preferredWidth: root.laneW
            Layout.maximumWidth: root.laneW

            function tip() {
              return Quattro.fuelTipWith(root.rootDrive, root.hdPair.amber, root.hdPair.red)
            }

            Item {
              width: root.dialW
              height: root.dialH

              QuattroDial {
                anchors.fill: parent
                zones: Quattro.fuelZoneArcsFor(root.hdPair.amber, root.hdPair.red)
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
              horizontalAlignment: Text.AlignHCenter
              Layout.alignment: Qt.AlignHCenter
              Layout.fillWidth: true
            }
          }

        }

        // ---- The VRAM COOLANT light (round 2): the STANDARD ISO coolant
        //      warning glyph, the thermometer-in-liquid artwork quattro.js
        //      owns, CENTERED in the dash BELOW the battery. The tank card is
        //      gone; the light tinted by the free-VRAM thresholds is the whole
        //      message, and high VRAM lights this light and throws no code.
        //      Hover shows VRAM used / reserved.
        // The wrap is a plain Item, not a ColumnLayout: in this Qt build a
        // nested ColumnLayout caps at its implicit width and hugs left, while
        // a plain Item honors Layout.fillWidth and stretches across the lane.
        // Children anchor to its horizontal center.
        Item {
          id: coolantWrap
          Layout.fillWidth: true
          height: childrenRect.height

          function tip() {
            return Quattro.coolantTipWith(
              root.vram === null ? null : { present: true, usedMib: root.vram.vramUsedMib, freeMib: root.vram.vramFreeMib, totalMib: root.vram.vramTotalMib },
              root.vramPair.red, root.vramPair.amber)
          }

          Item {
            id: coolantGlyph
            width: 40 * root.unit
            height: 40 * root.unit
            anchors.horizontalCenter: parent.horizontalCenter

            QuattroSymbol {
              anchors.fill: parent
              symbol: "temp"
              color: root.coolantTint
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
            id: coolantLabel
            text: Quattro.INSTRUMENTS.coolant
            anchors.top: coolantGlyph.bottom
            anchors.topMargin: 4 * root.unit
            anchors.horizontalCenter: parent.horizontalCenter
            color: root.dim
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            font.bold: true
            font.letterSpacing: 1.5
            horizontalAlignment: Text.AlignHCenter
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

        // ---- The gauge settings row (the captain's 2026-11-07 ruling):
        //      collapsible, at the bottom of the dash. One amber/red slider
        //      pair per gauge, each with its one-sentence description in the
        //      row itself, and a reset button. The pairs live in the
        //      monitor's persisted state; a drag lands in setGaugePair and
        //      every gauge above moves in the same frame. The row renders and
        //      calls: every decision is quattro.js's or the monitor's.
        Item {
          Layout.fillWidth: true
          implicitHeight: 1
          Rectangle {
            anchors.fill: parent
            color: Quattro.PAL.line
          }
        }

        property bool settingsOpen: false

        Item {
          id: settingsHeader
          Layout.fillWidth: true
          implicitHeight: 18

          Text {
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            text: Quattro.SETTINGS.header
            color: root.dim
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            font.bold: true
            font.letterSpacing: 1.5
          }

          Text {
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            text: content.settingsOpen ? "\u25be" : "\u25b8"
            color: root.dim
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
          }

          MouseArea {
            anchors.fill: parent
            cursorShape: Qt.PointingHandCursor
            onClicked: content.settingsOpen = !content.settingsOpen
          }
        }

        Text {
          visible: content.settingsOpen
          text: Quattro.SETTINGS.hint
          color: root.dim
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
          wrapMode: Text.Wrap
          Layout.fillWidth: true
        }

        Repeater {
          model: content.settingsOpen ? Quattro.GAUGE_KEYS : []

          GaugeSettingsRow {
            required property string modelData
            gaugeKey: modelData
            Layout.fillWidth: true
          }
        }

        Rectangle {
          visible: content.settingsOpen
          Layout.alignment: Qt.AlignHCenter
          width: 190
          height: 24
          radius: 8
          color: resetArea.containsMouse ? Quattro.PAL.hoverBg : Quattro.PAL.face
          border.width: 1
          border.color: Quattro.PAL.line

          Text {
            anchors.centerIn: parent
            text: Quattro.SETTINGS.reset
            color: root.fg
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            font.bold: true
            font.letterSpacing: 1
          }

          MouseArea {
            id: resetArea
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: callMonitor("resetGaugeSettings", [], null)
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

  // ---------------------------------------------------------------------------
  // GaugeSlider: one threshold slider, drawn by hand on the dash's palette.
  // Click jumps, press-drag follows. The component never decides: it reports
  // the dragged value through moved() and the monitor's slider model answers
  // with the pushed pair, which re-binds value, so the constraint is felt in
  // the handle, never said in words.
  // ---------------------------------------------------------------------------
  component GaugeSlider : Item {
    id: slider

    property real value: 0
    property real min: 1
    property real max: 99
    property color tint: Quattro.PAL.amber
    property string label: ""
    signal moved(real newValue)

    readonly property real frac: Math.max(0, Math.min(1, (value - min) / Math.max(1, max - min)))

    width: 160
    height: 30

    Rectangle {
      id: track
      anchors.left: parent.left
      anchors.right: parent.right
      anchors.top: parent.top
      height: 6
      radius: 3
      color: Quattro.PAL.face
      border.width: 1
      border.color: Quattro.PAL.line
    }

    Rectangle {
      anchors.left: parent.left
      anchors.top: parent.top
      width: parent.width * slider.frac
      height: 6
      radius: 3
      color: slider.tint
      opacity: 0.55
    }

    Rectangle {
      anchors.top: parent.top
      anchors.topMargin: -3
      x: Math.max(0, Math.min(parent.width - 12, parent.width * slider.frac - 6))
      width: 12
      height: 12
      radius: 6
      color: slider.tint
      border.width: 1
      border.color: Quattro.PAL.face
    }

    Text {
      anchors.left: parent.left
      anchors.top: track.bottom
      anchors.topMargin: 3
      text: slider.label
      color: slider.tint
      font.family: Style.font.family
      font.pixelSize: 9
      font.bold: true
      font.letterSpacing: 1
    }

    MouseArea {
      function valueAt(px) {
        var f = Math.max(0, Math.min(1, px / parent.width))
        return Math.round(slider.min + f * (slider.max - slider.min))
      }
      anchors.fill: parent
      cursorShape: Qt.PointingHandCursor
      onClicked: function(mouse) { slider.moved(valueAt(mouse.x)) }
      onPressed: function(mouse) { slider.moved(valueAt(mouse.x)) }
      onPositionChanged: function(mouse) {
        var v = valueAt(mouse.x)
        if (v !== Math.round(slider.value)) slider.moved(v)
      }
    }
  }

  // ---------------------------------------------------------------------------
  // GaugeSettingsRow: one gauge's amber/red pair in the settings row, with its
  // one-sentence description in the row itself (the captain's 2026-11-07
  // ruling). The pair comes from the monitor's persisted state, the push law
  // from quattro.js's slider model, the sentence from quattro.js's SETTINGS
  // record; a drag lands in setGaugePair and every gauge on the dash moves in
  // the same frame the state changes.
  // ---------------------------------------------------------------------------
  component GaugeSettingsRow : ColumnLayout {
    id: gaugeRow

    property string gaugeKey: ""
    readonly property var pair: root.pairFor(gaugeKey)
    readonly property var range: Quattro.gaugeRange(gaugeKey)

    spacing: 3

    RowLayout {
      Layout.fillWidth: true

      Text {
        text: Quattro.gaugeTitle(gaugeRow.gaugeKey)
        color: root.fg
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
        font.bold: true
        font.letterSpacing: 1
      }

      Item { Layout.fillWidth: true }

      Text {
        text: Quattro.SETTINGS.amberLabel + " " + gaugeRow.pair.amber + "   " + Quattro.SETTINGS.redLabel + " " + gaugeRow.pair.red
        color: root.dim
        font.family: Style.font.family
        font.pixelSize: Style.font.caption
      }
    }

    RowLayout {
      Layout.fillWidth: true
      spacing: 10

      GaugeSlider {
        Layout.fillWidth: true
        value: gaugeRow.pair.amber
        min: gaugeRow.range.min
        max: gaugeRow.range.max
        tint: Quattro.PAL.amber
        label: Quattro.SETTINGS.amberLabel
        onMoved: function(v) { callMonitor("setGaugePair", [gaugeRow.gaugeKey, "amber", v], null) }
      }

      GaugeSlider {
        Layout.fillWidth: true
        value: gaugeRow.pair.red
        min: gaugeRow.range.min
        max: gaugeRow.range.max
        tint: Quattro.PAL.redHot
        label: Quattro.SETTINGS.redLabel
        onMoved: function(v) { callMonitor("setGaugePair", [gaugeRow.gaugeKey, "red", v], null) }
      }
    }

    Text {
      text: Quattro.SETTINGS.copy[gaugeRow.gaugeKey] || ""
      color: root.dim
      font.family: Style.font.family
      font.pixelSize: Style.font.caption
      wrapMode: Text.Wrap
      Layout.fillWidth: true
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
