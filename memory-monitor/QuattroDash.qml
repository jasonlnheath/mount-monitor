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
// hovering it shows VRAM used / free of total. Then the codes area: ONE column
// under one check-engine head, DRIVE codes only - RAM high is the pressure
// gauge and the reserve battery, never a code, and VRAM high lights the
// coolant light only. Clicking a code sends the plugin's agent prompt with
// the dash's own pre-computed diagnosis appended as a fenced JSON block, so
// Hermes explains from the dashboard's numbers.
//
// Round 3 (preview build): the plugin answers to "Quattro Dash". The popup
// opens with the native hero header - the name in the native title size and
// the ALL-CAPS tier phrase beneath it (the Bluetooth Panel.qml hero pattern
// exactly) - and the VRAM lane joins the cluster as its own instrument.
//
// Round 3 iteration 2 (the captain's board pass, verbatim rulings applied):
// the lane is called VRAM and shows the ENTIRE amount of VRAM; the bar keeps
// the gray field, yellow and red zones, has NO green anywhere, and only the
// red needle moves; a gas-tank scale rides along the bottom of the bar (F
// full, E empty, 3/4 1/2 1/4 marks, F green / E red / the rest gray); the
// coolant icon and the bar sit in a SQUARE exactly the size of the SWAP
// RESERVE square with the bar exactly the LED bar's width; the VRAM square
// sits BELOW the SWAP RESERVE gauge (the reserve gauge and its label moved
// up to make room); RAM PRESSURE, VRAM and ROOT DRIVE labels share one
// horizontal row; the twin-ring logo is GONE - the product logo is the
// check-engine emblem and it tints with the state (monochrome when clear,
// amber when amber, red when red), the same color the bar shows. A
// valuesOnly mode (the captain's popup ruling) renders the
// same card as a bare values list: numbers and units only, descriptions
// bound for the settings section.
//
// Round 3 iteration 3 (the captain's pass on the v2 renders): the VRAM gas-
// tank scale's letters and tick marks shrink to EXACTLY the scale the ROOT
// DRIVE fuel dial draws its own E/F/fraction marks at (quattro.js
// vramScaleSize over the dial Item's real laid-out width); and the SWAP
// RESERVE square packs down to the row so the battery label sits one
// laneGap above the VRAM square - the two center pieces read as one
// instrument column centered against the dials.
//
// Round 3 iteration 4 (the captain's pass on the v3 renders, measured not
// eyed): the shared RAM PRESSURE / VRAM / ROOT DRIVE label row is GONE - each
// label sits directly under its own gauge, so nothing hangs on a row another
// instrument owns. RAM PRESSURE and ROOT DRIVE are the primary gauges and
// render LARGER: their lanes widen to 148 of the 419-unit card and the dial
// Items fill those lanes (the v3 layout shrank them to a left-hugging 114,
// ten pixels off their section's center - the measured off-centering), while
// the SWAP RESERVE / VRAM middle lane takes the exact remainder and both
// squares shrink (battery icon 30 to 26, square padding 17 to 14). The VRAM
// gas-tank scale is TRUE TO FORM: one mapping (quattro.js vramTrackX) puts
// the needle, the zones, the tick marks and the letters on the bar's real
// track - E on the left edge, F on the right, 1/2 at the bar's exact
// midpoint. And the RAM PRESSURE dial carries its own mark: the plain ISO
// thermometer outline (quattro.js SYMBOLS.thermometer), no longer the
// coolant light's in-liquid glyph - every instrument wears a distinct icon.
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

  readonly property var swapTotals: Memory.swapTotals(swaps)
  readonly property var reserve: Quattro.reserveReading(swapTotals)
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
  // missing reading is the unlit tint, never a confident green. Iteration 2:
  // NO green anywhere on the VRAM instrument (the captain's ruling) - a clear
  // reading is the unlit monochrome glyph, amber lights amber, red lights red.
  readonly property var coolantZone: Quattro.coolantBandWith(
    vram === null ? null : vram.vramFreeMib,
    vram === null ? null : vram.vramTotalMib,
    root.vramPair.red, root.vramPair.amber)
  readonly property color coolantTint: coolantZone === 2 ? Quattro.PAL.redHot
    : (coolantZone === 1 ? Quattro.PAL.amber : Quattro.PAL.faceSym)

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

  // Round 3 hero: the machine's one tier, the worst thing the dash knows.
  // The phrase rides under the plugin name, ALL CAPS, uncolored ink.
  readonly property bool armLive: String(mon("liveArmKey", "")) !== ""
  readonly property int tier: Quattro.tierFromStateWith(codes, coolantZone, psiSome < 0 ? null : psiSome, reserve.present ? reserve.pct : null, armLive, psiPair, battPair)
  readonly property string tierPhrase: Quattro.tierPhrase(tier)

  // Round 3 headroom gauge: the needle position on the horizontal tank, plus
  // the zone markings - the coolant thresholds (the settings pair, the floor
  // chain when no pair is stored) mapped onto the track.
  // Zones draw even with no reading; the needle does not (an unavailable
  // reading never draws as healthy). The needle is the ONLY moving part: the
  // captain's iteration-2 ruling kept the gray field and the yellow/red zones
  // and retired the band-tinted fill (and every other green) on this gauge.
  readonly property real headFrac: Quattro.headroomFrac(
    vram === null ? null : vram.vramFreeMib,
    vram === null ? null : vram.vramTotalMib)
  readonly property var headroomZones: Quattro.headroomZonesWith(
    vram === null ? null : vram.vramTotalMib, vramPair.red, vramPair.amber)

  // The hero emblem tints exactly as the bar's badge does: monochrome ink
  // when all is good, amber at the first warning, red when severe or armed.
  readonly property color heroEmblemTint: Quattro.heroTint(tier) === "red" ? Quattro.PAL.redHot
    : (Quattro.heroTint(tier) === "amber" ? Quattro.PAL.amber : root.fg)

  // The captain's values-only popup: actual readings, no descriptions. A
  // dormant property in this build - the product can wire it to a setting
  // when the settings round lands.
  property bool valuesOnly: false
  // The card's height tracks whichever list is showing: the full dash, or
  // the captain's values-only popup (readings only, descriptions bound for
  // the settings section).
  readonly property real listHeight: (valuesOnly ? valuesContent : content).implicitHeight
  readonly property var valueRows: Quattro.valueRows(
    psiSome < 0 ? null : psiSome, reserve, swapTotals, rootDrive, vram, codes)

  // ---------------------------------------------------------------------------
  // Layout measures. The mockup is designed on the 443px card (the
  // shell-standard Style.space(380) at the shell's font scale), inner width 419.
  // Instruments scale with the card; fonts stay at the shell's own tokens.
  // Three lanes share the row since round 2, so each lane is a third of the
  // row and both gauges draw at exactly the same size, the captain's item 3.
  // Iteration 2: the SWAP RESERVE gauge and its label moved UP out of the row
  // (his ruling) into the strip between the hero and the cluster row, and the
  // VRAM square - the same exact size as the SWAP RESERVE square, both bound
  // to squareH - takes the middle lane below where the reserve sat. The
  // middle lane's VRAM label anchors to the dial lanes' own label row so
  // RAM PRESSURE, VRAM and ROOT DRIVE share one horizontal line (ruling 6).
  readonly property real innerW: card.contentWidth - card.padding * 2
  readonly property real unit: innerW / 419
  // Iteration 4 size hierarchy: the two dial lanes are the primary gauges and
  // each takes 148 of the 419-unit card; the SWAP RESERVE / VRAM middle lane
  // takes the EXACT remainder (the old thirds summed 0.2px over the row and
  // the layout shaved the fuel lane a full pixel narrower than the psi lane).
  // Round 4 (marks 1-4): the lanes come from quattro.js. The cluster is its
  // own width, centered in the frame, instead of three lanes tiling the card
  // edge to edge. Whole pixels throughout: a half-pixel dial lands as a soft
  // ring, and mark 6 is about sharpness.
  readonly property real dialLaneW: Math.round(Quattro.dialLaneWidthU() * unit)
  readonly property real midLaneW: Math.round(Quattro.midLaneWidthU() * unit)
  readonly property real clusterGap: Math.round(Quattro.clusterGapU() * unit)
  readonly property real clusterW: 2 * root.dialLaneW + root.midLaneW + 2 * root.clusterGap
  readonly property real laneGap: Math.round(4 * unit)
  // MARK 1/2: the instrument band is as tall as its TALLEST column. The dial
  // lanes want the viewbox aspect height (quattro.js dialItemHeightU); the
  // two-square column wants 2 squares + 3 gaps + 2 labels. Whichever is taller
  // sets the band and a dial Item's height is what is left over - a ring's size
  // is driven by the lane's WIDTH (the Canvas scales the viewbox by
  // itemWidth / viewW), so a couple of pixels of vertical slack does not touch
  // a gauge, and the three labels still share one bottom row.
  readonly property real instrumentLabelH: battLabel.implicitHeight
  readonly property real squareColumnH: 2 * root.squareH + 3 * root.laneGap
    + 2 * root.instrumentLabelH
  readonly property real instrumentBandH: Math.max(
    Math.round(Quattro.dialItemHeightU(Quattro.dialLaneWidthU()) * unit) + root.laneGap
      + root.instrumentLabelH,
    root.squareColumnH)
  readonly property real dialH: Math.round(root.instrumentBandH - root.laneGap - root.instrumentLabelH)
  // Iteration 4: both squares shrink with the middle lane (battery icon 30
  // to 26 below, padding 17 to 14 here).
  readonly property real squareH: Math.round(battContent.implicitHeight + 14 * root.unit)
  // Iteration 3: the fuel dial's own scale, sized off the dial Item's real
  // laid-out width (the Canvas's scale basis), not the lane - the scale's
  // letters and ticks shrink to exactly the marks the dial draws (the
  // captain's ruling).
  readonly property var scaleSize: Quattro.vramScaleSize(psiDial.width)

  CardBar { id: cardBar; api: root.bar }

  PopupCard {
    id: card
    anchorItem: root.anchorItem
    bar: cardBar
    owner: root
    open: root.opened
    contentWidth: Style.space(380)
    contentHeight: Math.min(card.availableCardHeight - card.padding * 2, root.listHeight + card.padding * 2)

    Flickable {
      width: card.contentWidth - card.padding * 2
      height: card.contentHeight - card.padding * 2
      contentHeight: root.listHeight
      clip: true
      boundsBehavior: Flickable.StopAtBounds

      ColumnLayout {
        id: content
        visible: !root.valuesOnly
        width: parent.width
        spacing: Style.space(9)

        // ---- The hero (round 3): the plugin's own mark, the name in the
        //      native title size, and the ALL-CAPS tier phrase beneath it -
        //      the Bluetooth Panel.qml hero pattern exactly: title in the
        //      bar foreground, descriptor in the caption size, bold,
        //      letter-spaced, foreground darkened 1.4.
        // ---- The hero (round 3, iteration 2): the twin-ring logo.svg is
        //      GONE - the product logo is the check-engine emblem itself, and
        //      it tints with the machine's state exactly as the bar's badge
        //      does: monochrome ink when clear, amber when amber, red when
        //      red. The name keeps the native title size and the ALL-CAPS
        //      tier phrase its caption slot (the Bluetooth Panel.qml hero
        //      pattern); in valuesOnly mode the phrase steps out so the card
        //      is values and nothing else.
        Item {
          Layout.fillWidth: true
          implicitHeight: Math.max(heroEmblem.height, heroLabels.implicitHeight)

          QuattroSymbol {
            id: heroEmblem
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            symbol: "mil"
            width: Style.font.display
            height: Math.round(Style.font.display * 53.03 / 79.55)
            color: root.heroEmblemTint
          }

          Column {
            id: heroLabels
            anchors.left: heroEmblem.right
            anchors.leftMargin: Style.space(14)
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            spacing: Style.space(2)

            Text {
              text: "Quattro Dash"
              textFormat: Text.PlainText
              color: root.fg
              font.family: Style.font.family
              font.pixelSize: Style.font.title
              font.bold: true
              elide: Text.ElideRight
              width: parent.width
            }

            Text {
              visible: !root.valuesOnly
              text: root.tierPhrase.toUpperCase()
              textFormat: Text.PlainText
              color: Qt.darker(root.fg, 1.4)
              font.family: Style.font.family
              font.pixelSize: Style.font.caption
              font.bold: true
              font.letterSpacing: 1.2
              elide: Text.ElideRight
              width: parent.width
            }
          }
        }

        PanelSeparator {
          Layout.fillWidth: true
          foreground: root.fg
        }

        // ---- The cluster row: RAM PRESSURE | SWAP RESERVE over VRAM | ROOT
        //      DRIVE. MARK 1/2/4: the row is the cluster's own width centered
        //      in the frame, with one lane gap between the lanes - the round
        //      gauges close on each other, the square column closes with them,
        //      and quattro.js frameMarginU is how far the instruments no
        //      longer sit on the card's edges.
        RowLayout {
          id: clusterRow
          Layout.preferredWidth: root.clusterW
          Layout.alignment: Qt.AlignHCenter
          spacing: root.clusterGap

          ColumnLayout {
            id: psiWrap
            spacing: root.laneGap
            Layout.alignment: Qt.AlignTop
            Layout.preferredWidth: root.dialLaneW
            Layout.maximumWidth: root.dialLaneW

            function tip() {
              return Quattro.psiTipWith(psiSome < 0 ? null : { some_avg10: psiSome }, root.psiPair.amber, root.psiPair.red)
            }

            Item {
              id: psiDial
              // Iteration 4: the dial FILLS its lane (the v3 layout shrank
              // the plain Item to a left-hugging 114 - the measured 10px
              // off-center), so face center = lane center = label center.
              Layout.fillWidth: true
              Layout.preferredHeight: root.dialH
              Layout.alignment: Qt.AlignHCenter

              QuattroDial {
                anchors.fill: parent
                zones: Quattro.psiZoneArcsFor(root.psiPair.amber, root.psiPair.red)
                labels: Quattro.psiLabels
                needle: root.psiNeedle
                faceSymbol: "thermometer"
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
              id: psiLabel
              text: Quattro.INSTRUMENTS.psi
              color: root.dim
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
              font.bold: true
              font.letterSpacing: 0.8
              horizontalAlignment: Text.AlignHCenter
              Layout.alignment: Qt.AlignHCenter
              Layout.fillWidth: true
            }
          }

          Item {
            id: battLane
            // MARK 1-3: the SWAP RESERVE square, its label, the VRAM square
            // and its label are ONE column - each gauge one laneGap above its
            // own label, each label one laneGap under its own gauge, which is
            // the relative spacing mark 3 said to keep - and the column centers
            // on the instrument band the two dial lanes define. Round 3's
            // ruling survives: both squares bind to root.squareH, so they are
            // still exactly the same size.
            Layout.preferredWidth: root.midLaneW
            Layout.maximumWidth: root.midLaneW
            Layout.preferredHeight: root.instrumentBandH
            Layout.fillHeight: true
            implicitWidth: root.midLaneW
            implicitHeight: root.instrumentBandH

            // Bottom-aligned, not centred: the VRAM caption then sits on the same
            // row as the RAM PRESSURE and ROOT DRIVE captions whatever the dial lane
            // width is. Any slack the band has over the square column lands above the
            // swap gauge, where the dial rings are inset anyway.
            readonly property real columnTop: Math.round(battLane.height - root.squareColumnH)

          Rectangle {
            id: battBox
            x: 0
            // MARK 1/2: the square starts at its own column's top - no
            // back-reference into another row's geometry.
            y: battLane.columnTop
            width: root.midLaneW
            height: root.squareH
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
                  width: 26 * root.unit
                  height: 26 * root.unit
                  Layout.alignment: Qt.AlignHCenter

                  QuattroSymbol {
                    id: battIcon
                    anchors.fill: parent
                    symbol: "battery"
                    color: {
                      var band = Quattro.ledBandWith(root.reserve.pct, root.battPair.amber, root.battPair.red)
                      return band === "green" ? Quattro.PAL.green
                        : (band === "yellow" ? Quattro.PAL.amber : Quattro.PAL.redHot)
                    }

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

                  // Round 7 item 1: the battery threshold display is a row of
                  // colored bars. Each bar's color comes from its CENTER
                  // percentage against the drawn pair - red first, duplicates
                  // allowed, no hidden reorder - and the moving tick lines are
                  // gone. Two red bars at 20, three at 30, exactly as drawn.
                  Repeater {
                    model: Quattro.LED_COUNT

                    Rectangle {
                      required property int index
                      width: (84 * root.unit - (Quattro.LED_COUNT - 1) * 2) / Quattro.LED_COUNT
                      height: 9
                      radius: 2
                      readonly property real center: (index + 0.5) * (100 / Quattro.LED_COUNT)
                      readonly property string zone: Quattro.battSegmentZone(center, root.battPair)
                      readonly property bool lit: index < Quattro.litSegments(root.reserve.pct)
                      readonly property color zoneColor: zone === "green" ? Quattro.PAL.green
                        : (zone === "amber" ? Quattro.PAL.amber : Quattro.PAL.redHot)
                      color: lit ? zoneColor : Quattro.PAL.ledOff
                      border.width: 1
                      border.color: lit ? zoneColor : Quattro.PAL.line
                      opacity: lit ? 1.0 : 0.45
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
              id: battLabel
              // MARK 3: the label keeps its place - one laneGap under its own
              // gauge, centered on it.
              y: battBox.y + battBox.height + root.laneGap
              anchors.horizontalCenter: battBox.horizontalCenter
              text: Quattro.INSTRUMENTS.batt
              color: root.dim
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
              font.bold: true
              font.letterSpacing: 0.8
              horizontalAlignment: Text.AlignHCenter
            }

            Rectangle {
              id: vramBox
              // MARK 2: no back-reference to the dial Item for its y. The
              // lane it lives in is as tall as the dial lanes and centers its
              // gauge column on that band, which IS the cluster's axis; the
              // square then sits in the column, one laneGap under the SWAP
              // RESERVE label.
              x: 0
              width: root.midLaneW
              y: battLabel.y + battLabel.implicitHeight + root.laneGap
              height: root.squareH
              color: Quattro.PAL.face
              radius: 10
              border.width: 1
              border.color: Quattro.PAL.line

              function tip() {
                return Quattro.coolantTipWith(
                  root.vram === null ? null : { present: true, usedMib: root.vram.vramUsedMib, freeMib: root.vram.vramFreeMib, totalMib: root.vram.vramTotalMib },
                  root.vramPair.red, root.vramPair.amber)
              }

              Column {
                id: vramContent
                anchors.centerIn: parent
                spacing: 2

                Item {
                  width: 14 * root.unit
                  height: 14 * root.unit
                  anchors.horizontalCenter: parent.horizontalCenter

                  QuattroSymbol {
                    anchors.fill: parent
                    symbol: "temp"
                    color: root.coolantTint
                  }
                }

                Item {
                  id: vramBar
                  width: 84 * root.unit
                  height: 9 * root.unit
                  anchors.horizontalCenter: parent.horizontalCenter

                  readonly property real inset: 2

                  Rectangle {
                    anchors.fill: parent
                    radius: 2.5 * root.unit
                    color: Quattro.PAL.face
                    border.width: 1
                    border.color: Quattro.PAL.faceRing
                  }

                  Repeater {
                    model: root.headroomZones

                    Rectangle {
                      required property var modelData
                      x: Quattro.vramTrackX(modelData.from, vramBar.width)
                      width: Quattro.vramTrackX(modelData.to, vramBar.width)
                        - Quattro.vramTrackX(modelData.from, vramBar.width)
                      anchors.top: parent.top
                      anchors.bottom: parent.bottom
                      anchors.margins: vramBar.inset
                      radius: 1.5
                      color: modelData.kind === "red" ? Quattro.PAL.redHot : Quattro.PAL.amber
                      opacity: modelData.kind === "red" ? 0.9 : 0.85
                    }
                  }

                  Rectangle {
                    visible: root.headFrac !== null
                    // Iteration 4: the needle, the zones, the ticks and the
                    // letters all read Quattro.vramTrackX - one mapping, the
                    // bar's real track, so the scale cannot disagree with the
                    // reading.
                    x: Quattro.vramTrackX(root.headFrac === null ? 0 : root.headFrac, vramBar.width) - 1.5
                    anchors.verticalCenter: parent.verticalCenter
                    width: 3
                    height: parent.height + 4
                    radius: 1.5
                    color: Quattro.PAL.needle
                  }
                }

                Item {
                  id: vramScale
                  width: 84 * root.unit
                  // Round 6: integer ticks at the dial's exact device length
                  // plus the one-point-smaller letters - the stack fits the
                  // rectangle with the border clear.
                  height: root.scaleSize.tickH + root.scaleSize.letterPx
                  anchors.horizontalCenter: parent.horizontalCenter

                  Repeater {
                    // Iteration 4 bug, found by the pixel audit: the model
                    // bound the FUNCTION (never called), so the tick marks
                    // never rendered in any earlier iteration. The letters
                    // rode vramScaleMarks (an array) and drew; the ticks did
                    // not. Call it.
                    model: Quattro.vramScaleTicks()

                    Rectangle {
                      required property int index
                      readonly property real f: Quattro.vramScaleTicks()[index]
                      // Iteration 4: ticks center on their mark on the bar's
                      // real track - E on the left edge, F on the right,
                      // 1/2 at the bar's exact midpoint.
                      x: Math.round(Quattro.vramTrackX(f, vramScale.width) - width / 2)
                      y: 0
                      width: root.scaleSize.tickW
                      height: root.scaleSize.tickH
                      // The dial's own MAJOR tick ink (iteration 4): the
                      // marks are the gauge's graduations, not a caption, so
                      // they wear the same token the fuel dial's major ticks
                      // do - dim mut vanished against the dark card.
                      color: Quattro.PAL.tickMajor
                    }
                  }

                  Repeater {
                    model: Quattro.vramScaleMarks

                    Text {
                      required property var modelData
                      readonly property real f: modelData.f
                      width: 16
                      // Iteration 4: centered on the same real track, NO
                      // clamping - E and F straddle the bar's edges like a
                      // real gas gauge, not eight pixels inside them.
                      x: Math.round(Quattro.vramTrackX(f, vramScale.width) - width / 2)
                      // Round 6: a hair up, so the letters sit inside the
                      // rectangle.
                      y: root.scaleSize.tickH - 1
                      text: modelData.t
                      // Round 6: E red, F green again (captain); the
                      // fraction letters stay grey.
                      color: modelData.color !== undefined
                        ? Quattro.PAL[modelData.color]
                        : Quattro.PAL[Quattro.faceLabelColor]
                      font.family: Style.font.family
                      font.pixelSize: root.scaleSize.letterPx
                      horizontalAlignment: Text.AlignHCenter
                    }
                  }
                }
              }

              MouseArea {
                id: vramArea
                anchors.fill: parent
                hoverEnabled: true
                acceptedButtons: Qt.NoButton
                cursorShape: Qt.PointingHandCursor
                onContainsMouseChanged: if (!containsMouse) root.hideTip()
                onPositionChanged: if (containsMouse) root.showTip(vramBox.tip(), vramArea, mouse.x, mouse.y)
              }
            }

            Text {
              id: vramLabel
              // Iteration 4: the shared label row is gone (the captain's
              // ruling) - the label sits directly under its own gauge.
              y: vramBox.y + vramBox.height + root.laneGap
              anchors.horizontalCenter: vramBox.horizontalCenter
              text: Quattro.INSTRUMENTS.coolant
              color: root.dim
              font.family: Style.font.family
              font.pixelSize: Style.font.bodySmall
              font.bold: true
              font.letterSpacing: 0.8
              horizontalAlignment: Text.AlignHCenter
            }
          }

          ColumnLayout {
            id: fuelWrap
            spacing: root.laneGap
            Layout.alignment: Qt.AlignTop
            Layout.preferredWidth: root.dialLaneW
            Layout.maximumWidth: root.dialLaneW

            function tip() {
              return Quattro.fuelTipWith(root.rootDrive, root.hdPair.amber, root.hdPair.red)
            }

            Item {
              // Iteration 4: fills its lane, exactly like psiDial above.
              Layout.fillWidth: true
              Layout.preferredHeight: root.dialH
              Layout.alignment: Qt.AlignHCenter

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
              font.pixelSize: Style.font.bodySmall
              font.bold: true
              font.letterSpacing: 0.8
              horizontalAlignment: Text.AlignHCenter
              Layout.alignment: Qt.AlignHCenter
              Layout.fillWidth: true
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

        // Round 7 item 9: the dash says swap on its own line, centered under
        // the cluster row, the same honest string the stat rows carry - or
        // that there is none configured.
        Text {
          Layout.alignment: Qt.AlignHCenter
          text: Quattro.swapLine(root.swapTotals)
          color: root.dim
          font.family: Style.font.family
          font.pixelSize: Style.font.caption
        }

        // The codes area is a plain Item, not a nested ColumnLayout: in this
        // Qt build a nested ColumnLayout caps at its implicit width and hugs
        // left, which hung the head, the rows and the empty state on the left
        // edge. A plain Item honors Layout.fillWidth; children anchor to its
        // horizontal center, rows stretch the full width (round 3: ENGINE
        // CLEAR in the gauge labels' voice, centered like them).
        Item {
          id: codesArea
          Layout.fillWidth: true
          // Explicit stack height: childrenRect does not track Repeater-inserted
          // rows reliably on this Qt build (the card clipped the first code row),
          // and a direct height write never reaches the layout's implicit-size
          // pass - Layout.preferredHeight is the supported channel. emblem 17 +
          // gap 5 + rows (44 + 5 apart); the empty state stacks the ENGINE
          // CLEAR line under the emblem.
          Layout.preferredHeight: root.codes.length > 0 ? 66 + (root.codes.length - 1) * 49 : 38

          Item {
            id: codesEmblem
            width: 17
            height: 17
            anchors.horizontalCenter: parent.horizontalCenter

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
              required property int index
              entry: modelData
              anchors.left: parent.left
              anchors.right: parent.right
              y: 22 + index * 49
            }
          }

          Text {
            visible: root.codes.length === 0
            text: Quattro.codesEmptyText()
            anchors.top: codesEmblem.bottom
            anchors.topMargin: 5
            anchors.horizontalCenter: parent.horizontalCenter
            color: root.dim
            font.family: Style.font.family
            font.pixelSize: Style.font.bodySmall
            font.bold: true
            font.letterSpacing: 0.8
            horizontalAlignment: Text.AlignHCenter
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
            onClicked: {
              var refused = callMonitor("resetGaugeSettings", [], null)
              if (refused !== null && refused !== undefined) root.showToast(refused, true)
            }
          }
        }

      }

        // ---- The values-only popup (the captain's popup ruling): the same
        //      card as a bare list of actual readings - numbers and units,
        //      no What/Why/Ranges copy, no ENGINE CLEAR, no tier phrase.
        //      The descriptions move to the settings section. One row per
        //      instrument (quattro.js valueRows), codes ride as their id
        //      plus the bare percent they are about. A SIBLING of the full
        //      dash content inside the Flickable - not a child of it, or it
        //      would hide whenever the full dash hides (the blank-card bug
        //      the first values render caught).
        ColumnLayout {
          id: valuesContent
          visible: root.valuesOnly
          width: parent.width
          spacing: Style.space(9)

          Repeater {
            model: root.valueRows

            RowLayout {
              required property var modelData
              Layout.fillWidth: true
              spacing: 10

              Text {
                text: modelData.label
                color: root.dim
                font.family: Style.font.family
                font.pixelSize: Style.font.bodySmall
                font.bold: true
                font.letterSpacing: 0.7
              }

              Text {
                text: modelData.value
                color: root.fg
                font.family: Style.font.family
                font.pixelSize: Style.font.body
                horizontalAlignment: Text.AlignRight
                elide: Text.ElideRight
                Layout.fillWidth: true
              }
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
    // The toast never grows past the card: the popup window clips at its own
    // bounds, and a refusal sentence long enough to overflow would lose its
    // first and last words (the gauge name and the fix) off both edges, so at
    // the cap the copy wraps inside the toast instead. A toast that fits
    // renders exactly as it did before the cap.
    Rectangle {
      id: toast
      anchors.horizontalCenter: parent.horizontalCenter
      anchors.bottom: parent.bottom
      anchors.bottomMargin: 12
      width: Math.min(toastRow.implicitWidth + 28, parent.width)
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
        width: Math.min(implicitWidth, toast.width - 28)
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
          wrapMode: Text.WordWrap
          Layout.fillWidth: true
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
        var oy = (dial.height - Quattro.DIAL.viewH * s) / 2
        var D = Quattro.DIAL
        var P = Quattro.PAL
        // MARK 6 ("I want the font to be legible. Sharp."). The face geometry
        // used to be painted through ctx.scale(viewbox -> device), which put
        // the ring center at cx*s = ..., a radius at ..., a 2.6-unit graduation
        // at 1.45 device pixels and every numeral at a fractional pen position:
        // a soft picture of a gauge. The numbers stay in the mockup's 260x232
        // viewbox (quattro.js DIAL), but the face is painted in DEVICE space
        // with the center, every radius and every pen rounded to whole pixels,
        // and every stroke width rounded to a whole device pixel.
        var CX = Math.round(D.cx * s)
        var CY = Math.round(oy + D.cy * s)
        function rd(viewR) {
          return Math.round(viewR * s)
        }
        function devpx(w) {
          return Math.max(1, Math.round(w * s))
        }

        ctx.beginPath()
        ctx.arc(CX, CY, rd(D.faceR), 0, Math.PI * 2)
        ctx.fillStyle = P.face
        ctx.fill()
        ctx.lineWidth = devpx(7)
        ctx.strokeStyle = P.faceRing
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(CX, CY, rd(D.faceR), 0, Math.PI * 2)
        ctx.lineWidth = devpx(1.5)
        ctx.globalAlpha = 0.7
        ctx.strokeStyle = P.line
        ctx.stroke()
        ctx.globalAlpha = 1

        for (var z = 0; z < dial.zones.length; z++) {
          var zone = dial.zones[z]
          var fromDeg = Quattro.needleAngleDeg(zone.from)
          var toDeg = Quattro.needleAngleDeg(zone.to)
          ctx.beginPath()
          ctx.arc(CX, CY, rd(D.zoneR), (fromDeg - 90) * Math.PI / 180, (toDeg - 90) * Math.PI / 180)
          ctx.lineWidth = devpx(D.zoneWidth)
          ctx.strokeStyle = zone.kind === "red" ? P.redHot : P.amber
          ctx.globalAlpha = zone.kind === "red" ? 0.9 : 0.85
          ctx.stroke()
          ctx.globalAlpha = 1
        }

        var ticks = Quattro.dialTicks()
        for (var t = 0; t < ticks.length; t++) {
          var tick = ticks[t]
          var deg = D.a0 + D.sweep * tick.f
          var p1 = Quattro.polar(CX, CY, rd(D.tickOuter), deg)
          var p2 = Quattro.polar(CX, CY, tick.major ? rd(D.tickMajor) : (tick.mid ? rd(D.tickMid) : rd(D.tickMinor)), deg)
          ctx.beginPath()
          ctx.moveTo(Math.round(p1.x), Math.round(p1.y))
          ctx.lineTo(Math.round(p2.x), Math.round(p2.y))
          ctx.lineWidth = tick.major ? devpx(2.6) : devpx(1.4)
          ctx.strokeStyle = tick.major ? P.tickMajor : P.tickMinor
          ctx.stroke()
        }

        // MARK 6: the face's words at an identity transform, at an integer
        // device font size from quattro.js gaugeFaceFontPx, at rounded pen
        // positions, in round 3's graduation grey - the control's look at
        // 13pt, drawn sharp instead of resampled; regular weight. textBaseline is
        // middle, so a numeral sits ON its radius instead of 5 viewbox units
        // below it (the +5 was the scaled-era nudge).
        var fpx = Quattro.gaugeFaceFontPx(dial.width)
        ctx.font = fpx + "px \"" + Style.font.resolvedFamily + "\""
        ctx.textAlign = "center"
        ctx.textBaseline = "middle"
        var faceLabelPx = rd(D.labelR)
        for (var l = 0; l < dial.labels.length; l++) {
          var label = dial.labels[l]
          var ldeg = D.a0 + D.sweep * label.f
          var lp = Quattro.polar(CX, CY, faceLabelPx, ldeg)
          ctx.fillStyle = label.color !== undefined ? P[label.color]
            : P[Quattro.faceLabelColor]
          ctx.fillText(label.t, Math.round(lp.x), Math.round(lp.y))
        }

        if (dial.needle !== null && dial.needle !== undefined) {
          var ndeg = Quattro.needleAngleDeg(dial.needle)
          ctx.save()
          ctx.translate(CX, CY)
          ctx.rotate(ndeg * Math.PI / 180)
          ctx.shadowColor = P.needle
          ctx.shadowBlur = 3
          ctx.beginPath()
          ctx.moveTo(0, rd(D.needleTail))
          ctx.lineTo(0, -rd(D.needleTip))
          ctx.lineWidth = devpx(4.5)
          ctx.lineCap = "round"
          ctx.strokeStyle = P.needle
          ctx.stroke()
          ctx.beginPath()
          ctx.arc(0, 0, rd(D.hubR), 0, Math.PI * 2)
          ctx.fillStyle = P.hub
          ctx.fill()
          ctx.shadowBlur = 0
          ctx.beginPath()
          ctx.arc(0, 0, rd(D.hubDotR), 0, Math.PI * 2)
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
        onMoved: function(v) {
          var refused = callMonitor("setGaugePair", [gaugeRow.gaugeKey, "amber", v], null)
          if (refused !== null && refused !== undefined) root.showToast(refused, true)
        }
      }

      GaugeSlider {
        Layout.fillWidth: true
        value: gaugeRow.pair.red
        min: gaugeRow.range.min
        max: gaugeRow.range.max
        tint: Quattro.PAL.redHot
        label: Quattro.SETTINGS.redLabel
        onMoved: function(v) {
          var refused = callMonitor("setGaugePair", [gaugeRow.gaugeKey, "red", v], null)
          if (refused !== null && refused !== undefined) root.showToast(refused, true)
        }
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
