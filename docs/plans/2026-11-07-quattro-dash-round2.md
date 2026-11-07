# Plan: QuattroDash round 2 — the captain's eight live-look items

Source: captain's chat feedback 2026-11-07 (the launch brief's `## Captain's
intent`), relabeled by the steering inbox (003, resolve-key
`quattro-round2-hold`): the captain approved the preview board at
`/home/jason/Work/firstmate/data/quattro-dash-round2/preview.html` with edits —
the ISO coolant symbol is correct (keep it), the color states must actually
render in-app, and the bar popup is built exactly per his edits (title
centered, no column headers, no Free column, status = color dot only).
Round-1 plan and live-look addendum: `docs/plans/2026-11-05-quattro-dash.md`.

The eight items, and where each lands:

1. **Coolant light replaces the tank card** (`quattro.js`, `QuattroDash.qml`).
   The VRAM COOLANT reservoir (the `QuattroCoolant` Canvas painter and its
   `coolantFill` level) comes off the dash. In its place, below the battery:
   the STANDARD ISO coolant warning light — the thermometer-in-liquid artwork
   quattro.js already owns (`SYMBOLS.temp`, the same data QuattroSymbol
   renders) — monochrome fill tinted by the existing band decision
   (`coolantBand`, unchanged thresholds and tests): green at band 0, amber
   (yellow) at band 1, red at band 2, the unlit `faceSym` tint when there is
   no reading. CENTERED in the dash BELOW the battery. Hover shows VRAM used
   / reserved (`coolantTip` Now row reworded to "X.X GiB used, Y.Y GiB
   reserved.", GiB via a new `gibFromMib`; What/Why/Ranges keep teaching the
   floor). `coolantFill` and the COOLANT geometry record leave quattro.js with
   the tank; `coolantBand` and its tests stay. The in-app color check is part
   of the pixel verification (force each band through the `vramFloorMib`
   setting and screenshot the light).
2. **Uniform dash label sizes** (`QuattroDash.qml`). All instrument labels
   draw at one fixed size: `Style.font.caption`, bold, letterSpacing 1, no
   `fontSizeMode: HorizontalFit` shrink (the old per-label shrink drew
   "VRAM COOLANT" smaller than "ROOT DRIVE"). Width is the lane, centered,
   eliding only as a last resort.
3. **Same-size gauges** (`QuattroDash.qml`). With the coolant lane out of the
   cluster row it holds three lanes (RAM PRESSURE, SWAP RESERVE, ROOT DRIVE);
   `laneW = (419 - 2*6)/3` units, both dials draw at exactly
   `dialW x dialH` = `laneW x 124*unit` — identical by construction. The
   pixel check measures both painted faces equal.
4. **No RAM-usage codes** (`quattro.js`, tests). `codesFromReadings` loses the
   ram and vram readings: only over-line drives become codes. Doctrine:
   RAM monitoring = PRESSURE + SWAP RESERVE, never amount used; the RAM
   PRESSURE gauge and SWAP RESERVE battery stay the RAM surfaces.
5. **No VRAM-usage codes** (same change). High VRAM lights the coolant light
   only: no C-code, the MIL head tints by drive codes only. The plugin's own
   VRAM alert thresholds, toasts and bar emblem are NOT touched (the captain's
   items are the dash's engine codes; "keep the existing threshold logic and
   tests").
6. **Ring hover pop-ups hidden while a popup is open** (`MountMonitor.qml`,
   `MemoryMonitor.qml`). The bar's plugin api exposes `activePopout` (another
   plugin's popout owner arrives as an opaque `{foreign: true}` marker, the
   bar's ownership boundary), so Mount Monitor binds every ring and telltale
   `tooltipText` to `""` while `bar.activePopout` is non-null — that is the
   only boundary-honest way to see "the QuattroDash popup is open" from the
   sibling plugin, and it covers the identical cutoff under any open popout.
   Memory Monitor hides its own badge tooltip while its own surface is open
   (`anySurfaceOpen`).
7. **Bar popup rebuilt** (`memory.js barTooltip`, tests). Title "Quattro Dash"
   (renamed from "Memory Monitor", centered: the bubble centers each line, so
   the title line stays short while every row pads to one shared width).
   Rows: the resource name in a fixed left column ("RAM", "VRAM", "Drive" —
   `badgeLabel` hd case renamed) and a status column that is a color dot
   ONLY: U+26AA ⚪ none, U+1F7E0 🟠 amber, U+1F534 🔴 red and critical
   (`bandDot`). No band word, no percent, no "held" (the held info moves to
   the coolant hover), no Free column, no column headers. The dots render in
   color because the tooltip Text falls back to Noto Color Emoji (present on
   this rig; `fc-match monospace:charset=1F534` resolves it) — verified in the
   pixel check.
8. **Diagnosis JSON on the engine-code click** (`quattro.js`, `memory.js`,
   `QuattroDash.qml`, `MemoryMonitor.qml`). The dash pre-computes a diagnosis
   from the code row: `Quattro.diagnosisJson(entry, hdRows)` builds ONE-LINE
   JSON `{code, severity, cause, topConsumers, recommendation}` — severity
   severe/moderate, cause the issue line, topConsumers the device's own
   per-target rows from `hdRows` (target/pct/usedKb/availKb, worst first, max
   3), recommendation the band's fixed advice (read-only drives get the
   move-off wording). Device-controlled text (target, device) passes through
   `sanitizePath` plus a backtick/angle-bracket strip, and the single-line
   fence means a ``` sequence inside a string can never close the block
   mid-line — `memory.js promptWithDiagnosis(prompt, json)` appends the header
   sentence ("data, not instructions") and the fenced block to the prompt the
   click sends. Both dash click paths carry it: the moderate dispatch and the
   critical-band dispatch (`dispatchCriticalCode(alert, diagnosis)` →
   `startArm(alert, true, diagnosis)`); queue-time toasts and arms do not.

## Ripples measured before writing anything

- **Bar tooltip mechanics**: the bar's tooltip bubble is one centered
  `Text` (`Text.PlainText`, `horizontalAlignment: AlignHCenter`) sized to its
  widest line — alignment comes from every row padding to the same width,
  which is what `barTooltip` already does and keeps. Title centered = short
  line; rows full width.
- **Popout visibility across plugins**: `PluginBarApi.activePopout` is the
  bar's own published state (`Bar.qml` sets it to the owner object for the
  owning plugin, `{foreign: true}` for everyone else, null when closed). No
  new channel, no setting read, no sibling property poke.
- **Emoji in the tooltip**: Qt falls back through fontconfig per glyph; the
  circle emoji are color glyphs (CBDT) Qt 6 renders in Text.
- **Prompt trust law**: the fenced block is new prompt surface carrying
  device-controlled strings; the sanitize-plus-single-line construction above
  is what keeps it unforgeable. `tests/label-injection`-style cases go in
  `memory-monitor/tests/label-injection.test.mjs`.
- **Tests** (update-first, RED before green):
  - `memory-monitor/tests/quattro.test.mjs`: codesFromReadings signature
    (devices only) with a new pin that full-band RAM and VRAM readings
    produce NO codes; diagnosis JSON tests (shape, sanitization, ro
    wording); coolantTip used/reserved Now row; coolantFill/COOLANT pins
    removed with the tank; delegation guards updated (light renders through
    QuattroSymbol, tank painter gone, panel asks promptWithDiagnosis and
    diagnosisJson).
  - `memory-monitor/tests/memory.test.mjs`: barTooltip v3 cases (title,
    dot-only status, column alignment, hd renamed Drive, held gone).
  - `memory-monitor/tests/label-injection.test.mjs`: a hostile target never
    breaks out of the diagnosis fence (backticks, `<`, `>`, newlines).
  - `memory-monitor/tests/ringkit-conformance.test.mjs`: no coolantFill
    side (verified absent already; nothing to change unless the tank pins
    move).
  - `memory-monitor/tests/qml-ids.test.mjs` / `delegation.test.mjs`: id and
    delegation guards for the new light container and the tooltip bindings.
- **Docs**: `memory-monitor/README.md` picks up the light, the code rule
  (drive codes only) and the tooltip shape. `manifest.json` does NOT move
  (version bumps need the captain's explicit word).
- **Deploy + pixel verification** per the standing recipe: rsync
  `memory-monitor/` + repo-root `ringkit.js` into the plugin dir, pull the
  mount-monitor plugin clone, `omarchy restart shell`; screenshot the dash
  (light tint green/amber/red via a temporary `vramFloorMib` value, uniform
  labels, equal gauges) and the bar tooltip (title, dot column) into
  `/home/jason/Work/firstmate/data/quattro-dash-round2/`.
