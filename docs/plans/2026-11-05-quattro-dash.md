# Plan: Quattro Dash — the approved instrument-cluster popup for Memory Monitor

Source of truth (FINAL, board verdict "ship it", approved round 7 2026-11-05):

- Report: `/home/jason/Work/firstmate/data/mm-dashboard-standard-design/report.md`
  (rounds 1-7, the round-5/6 popup is the build target)
- Mockup: `/home/jason/Work/firstmate/data/mm-dashboard-standard-design/index.html`
  (the acceptance artifact, matched exactly)

Locked implementation defaults (round 7): LED bands green >= 25 / yellow 10-25 /
red < 10; severe codes dispatch on click with the "agent has the crash pattern
and is processing now" wording; single-code dispatch; popup width =
shell-standard `Style.space(380)`; live PSI from `/proc/pressure/memory`
(some avg10). Instrument names RAM PRESSURE / SWAP RESERVE / ROOT DRIVE.
One-line code descriptions; two-column popups; NO em dashes or semicolons in UI
copy; terse casual copy register (5 words ideal).

## Ripples measured before writing anything

1. **Panel mounting** — `MemoryPanel.qml` is a `qs.Ui.Panel` mounted by
   `MemoryMonitor.qml` through a `Loader` (`panelLoader`, `injectPanel()`),
   carrying `ipcTarget: ""` / `manageIpc: false` so the bar widget owns the one
   IPC target. Quattro Dash mounts the same way through a second Loader
   (`dashLoader`). The bar's panel routing looks for `open/close/opened` on the
   bar-widget root (`Bar.qml panelNavigationSlots`), and `requestPopout(owner)`
   switches popouts by owner object (`Bar.qml:559`: `closeForPopoutSwitch` on
   the active popout's owner). So each panel keeps its own owner identity: the
   dashboard's `PopupCard.owner` is the QuattroDash item, MemoryPanel keeps
   `owner: barIdentity`.
   [Superseded by review round 1, 2026-11-05: keying `owner` to the widget left
   the detail window with no dismissal path once the widget's close() routed to
   the dash. Each panel's card is now owned by that panel root, the cards read
   the bar through the inert CardBar facade, and the widget registers itself as
   the bar's popout owner from the panels' opened state (`MemoryMonitor.qml`
   `syncPopout`), which is also what lights the bar's open-panel dot.]
2. **Bar-facing panel shape repointed to the dashboard.** `Bar.qml` calls
   `open/close/opened` on the widget for hotkeys and panel switching, and the
   badge is the click surface the captain named ("user clicks to open the
   dashboard", round 2). The widget's `open()/close()/opened/togglePanel()/
   popoutSwitchClosing/closeForPopoutSwitch()` now route to `dashLoader`;
   `showDetail()` (the `openDetail` IPC the critical toast click runs) keeps
   opening MemoryPanel. `unseenAlerts = []` stays in `open()` (opening the
   dashboard counts as having seen the alert state, so the delegation contract
   and the seen-ring semantics both hold). Badge gets `onPressed -> togglePanel()`
   (Mount Monitor's ring buttons have no click handler; the precedent for
   click-to-panel is the shell's own clock BarWidget `onPressed`).
3. **Bar emblem** (round-2 spec, in the round-7 scope line): monochrome MIL =
   all go, yellow = moderate, red = severe, click opens the popup. Severity,
   color token and pulse keep coming from `RingKit.badgeParams` (band 0
   `plain` -> foreground, band 1 `amber`, band 2 `alertRed`, band 3
   `criticalRed` + pulse), so the RingKit delegation and conformance contracts
   stay intact. The drawing changes from the Canvas ring + MM text to the MIL
   emblem alone (ISO 7000 artwork from the mockup, `sym-mil` path) tinted by
   the token. The three-state emblem is the captain's own ruling; RingKit's
   shape-as-severity decision stays underneath it (the critical pulse rides
   `badgeParams.pulse`).
4. **Shared ringkit kernel** — untouched. `ringkit.js` gains nothing; its
   band/badge contracts are consumed exactly as before. The dashboard's own
   numbers (LED bands 25/10, PSI zones 60/80, fuel red 0-10) are Quattro Dash
   presentation bands on DIFFERENT quantities (percent-free swap, PSI, percent-
   free root), not the alert bands ringkit owns, so they live in quattro.js,
   not ringkit.js.
5. **Tests** — new `memory-monitor/tests/quattro.test.mjs` (RED first):
   PSI parsing/zone/needle decisions, LED band thresholds and lit-segment
   rounding, reserve reading, root-drive reading (memory.js), popup content
   structure per the approved design (header + labeled two-column rows, exact
   locked copies), the code taxonomy and dispatch toast, the language rule
   (no em/en dashes, no semicolons, programmatic scan over every copy output),
   the symbol data (4 ISO symbols, viewBox + fill/stroke items), and the
   palette pins. Updated: `qml-ids.test.mjs` (FILES gains QuattroDash.qml),
   `delegation.test.mjs` (install list, dashboard-mount and no-local-copy
   guards), `install.test.mjs` (installed-file list), `run.sh` (qmllint gains
   QuattroDash.qml).
6. **install.sh** — copies `QuattroDash.qml` and `quattro.js` beside the
   widget (replace-whole loop list). Manifest unchanged: the dashboard is
   mounted by the bar widget, not registered separately (same as MemoryPanel).
7. **AGENTS.md** — after the build, one minimal correction to the memory-
   monitor layout line (dashboard decisions live in `memory-monitor/quattro.js`),
   only because the existing sentence would otherwise be factually wrong about
   where the plugin's decisions live.

## Module split (the plugin's law: decisions in JS, widgets only draw)

- **`memory.js` gains one data reading: `rootDriveReading(findmntText)`** —
  scans `parseRows` for `TARGET === "/"` on a real device, returns
  `{ type: "root", target: "/", device, pctFree, pctUsed, usedKb, availKb,
  sizeKb }` or null. It reuses `parseRows`/`deviceOf`/`isRealDevice`/`asNumber`
  already there; the dashboard's own decisions never re-parse findmnt. Live
  check: exactly one row carries `TARGET /` on the rig (`/dev/nvme1n1p2[/@]`,
  23% used).
- **`memory-monitor/quattro.js` (new)** — the Quattro Dash decision kernel,
  plain top-level `function` declarations for the same node:vm/QML reason as
  memory.js (a QML JS module cannot import another). It owns:
  - instrument names (`RAM PRESSURE`, `SWAP RESERVE`, `ROOT DRIVE`),
  - the palette constants the mockup hard-codes (amber `#e3b341`, red-hot
    `#ff3b30`, green `#3fb950`, needle `#ff6b6f`, hub `#e5484d`, face/mut/line
    grays, tooltip bg `#0a0e13`),
  - dial geometry (viewBox 260x232, cx 130 cy 122, 240-degree sweep from -120,
    needle/zone-arc/tick/label radii), `polar`, `arcAngles`, `needleAngleDeg`,
    `psiZoneArcs` (amber 0.60-0.80, red 0.80-1.0), `fuelZoneArcs`
    (red 0-0.10), tick layout (41 ticks, majors every 10),
  - the LED bar (`LED_COUNT 10`, `ledBand`: green >= 25 / yellow >= 10 / red
    below, `litSegments` = round(pct/10) clamped 0-10, red pulses),
  - `reserveReading(swapTotals)` (percent FREE = 100 - swapPct; total 0 ->
    `{ present: false, pct: 0 }`), `psiZone` (red >= 80, amber >= 60),
    `psiNeedleFrac`/`fuelNeedleFrac` (null -> null: no needle, never a fake 0),
  - the popup content structure: `psiTip(psi)` / `battTip(reserve)` /
    `fuelTip(root)` / `codeTip(code)` each returning
    `{ header, rows: [{ label, text, cls? }] }` — the two-column label |
    sentence format from round 4, with the Metric row explaining PSI comes from
    `/proc/pressure/memory` (round 5), copy taken verbatim from the approved
    mockup with live numbers substituted,
  - the code area: `codesFromReadings(ram, vram, devices)` — the live codes the
    monitor itself already sees (see "Code source" below), OBD-style
    `P`/`C` + 4 stable digits (fnv1a of type|key, zero-padded), severity from
    the band (1 -> amber column, >= 2 -> red column), one-line terse desc, and
    the embedded alert-shaped record the click dispatches,
  - `dispatchToast(code, severe)` — the green toast copy, verbatim:
    `to firstmate (default agent)` / severe appends `, processing now`,
  - the ISO symbol data (temp, fuel, battery, mil) extracted verbatim from the
    mockup: rects/circles pre-converted to path `d` strings, per-item
    `fill` or `stroke` + width.
- **`memory-monitor/QuattroDash.qml` (new)** — Panel root, `PopupCard`
  `contentWidth: Style.space(380)`, cluster row (RAM PRESSURE dial + SWAP
  RESERVE battery unit + ROOT DRIVE dial, labels under the instruments per
  round 6), codes panel (amber column | hairline | red column, MIL heads,
  chips with one-line desc + severity dot), hover teaching popups, click
  dispatch with the in-card toast, sent-row dimming. Readings arrive through
  the `monitor` property exactly as MemoryPanel reads its own (`mon()`
  fallbacks, never a zero for an unavailable reading: a missing PSI or root
  reading hides its needle and says so in the Now row). Instrument painting is
  Canvas (dial face, zones, ticks, labels, needle with shadow glow) and
  `QtQuick.Shapes` `Shape`/`PathSvg` (the four ISO symbols), both driven by
  quattro.js data. No local sentences: every string the panel shows comes from
  `Quattro.*`, keeping the no-fixed-copy-in-widgets law.
- **In-card tooltip** — the round-3 note rules the adaptation: layer-shell
  popups cannot extend past their window bounds, so the hover detail renders
  inside the popup card as an overlay positioned against the hovered cell,
  flipping above when near the bottom, hidden on leave. Same structure and
  copy as the mockup tooltip.
- **Dispatch** — a code click runs
  `Quickshell.execDetached(Memory.agentArgv(Memory.agentPrompt(alert, reading,
  oomd, logPath), monitor.agentCommandArgv()))`: the SAME fixed prompt the
  toasts send (the trust boundary stays in memory.js), typed argv, one
  paragraph one argument. `clickArgvFor` is not reusable here because it
  routes band >= 3 to the IPC detail window; the dashboard's contract is
  click-dispatches-to-agent for both severities. MemoryPanel's
  health-check click already runs this exact argv shape, so the pattern has a
  precedent.
  [Superseded by review round 1, 2026-11-05: the captain ruled a critical-band
  (band 3) code click is a critical dispatch, never a second agent on top of
  an armed guard. Such clicks now ask the monitor to put them through the arm
  gate (`dispatchCriticalCode`) and say so in a red toast when refused; band 2
  and band 1 codes still dispatch directly exactly as written here.]

## Code source (the honest live subset)

The mockup's five rows are placeholder codes (gnome-shell crash loop, GPU
fault, kernel oops ...). The plugin has no crash-log or journal reader, and
adding one would be scope beyond the approved design. What the monitor
actually sees live: the band state of every resource it watches. So v1 codes
are the dashboard rendering the monitor's own live state, the way a real
check-engine light shows active faults and clears when they clear:

- System RAM in band 1 -> moderate P-code; band >= 2 -> severe.
- VRAM likewise -> C-code.
- Each watched drive in band >= 1 -> its own C-code (the mount target appears
  only as data in the Issue row, never in a sentence the agent is told to act
  on; the one-line desc stays type-worded).
- Code number = fnv1a(type + "|" + key) % 10000, so the same condition shows
  the same code while it is present. Healthy readings -> no rows, honest empty
  columns under the MIL heads.

The taxonomy (P process, C component, B UI, U network), the two-column amber |
red layout, the severity dots, the hover decode format (`Issue:` / `Status:` /
`Fix:`) and both locked Fix copies come straight from the approved design.

## RED sequence

1. Write `memory-monitor/tests/quattro.test.mjs` + the delegation/qml-ids/
   install/run.sh updates; run the suite; every new test fails for the right
   reason (quattro.js missing, rootDriveReading missing, install list short).
2. Implement memory.js `rootDriveReading` + quattro.js; tests for the decisions
   go green.
3. Implement QuattroDash.qml + MemoryMonitor mounting/emblem/click + install.sh;
   delegation, qml-ids, install and qmllint go green.
4. `bash memory-monitor/tests/run.sh` end to end, then the full repo suite
   (`bash tests/run.sh`) as the regression net.

## Out of scope (named so they stay out)

- Any journal/coredump reader, auto-engage of the agent at detection (round 7
  says auto-engage is finalized during build only in the sense that the locked
  wording is the click behavior), group dispatch, demo sliders,
  digital readouts, prose on the panel, a `testPct` hook for the dashboard,
  any change to ringkit.js, mounts.js, or Mount Monitor.
  [The spares row left this list in review round 1, 2026-11-05: the captain
  ruled the approved mockup footer's reserved spares row is contract, and the
  dashboard ships it (`QuattroDash.qml`, `quattro.js` SPARES and the oil /
  thermometer / triangle symbols).]
