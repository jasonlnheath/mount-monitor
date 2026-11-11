# Quattro Dash round 7 — the captain's 13 rulings (2026-11-11)

Captain test-drove the live QuattroDash (post-PR-22 deploy) and ruled 13 changes.
His words on the dash itself: "damn the dash looks awesome along with your settings."
This plan maps every ruling to files, decisions, ripples, and tests before any code moves.
Reference screenshots (read and interpreted):

- `screenshot-2026-11-11_13-10-31.png` — the bar badge hover tooltip: "Quattro Dash" title,
  RAM / VRAM / Drive rows with status dots; the dots do NOT sit on one vertical line
  (RAM's dot is horizontally off the VRAM/Drive dots). This is ruling 10's evidence:
  the tooltip pads names by CHARACTER COUNT, and a proportional font makes equal counts
  unequal widths.
- `screenshot-2026-11-11_13-13-58.png` — the check-engine emblem tinted red with its
  bottom line missing. Reproduced offscreen before this plan (QuattroSymbol mil at
  17x17 square: zero colored pixels in the bottom three rows; at 22x15: ragged) —
  the artwork itself is complete (cairo render of the same path draws the bottom line),
  so it is a renderer dropout: the thin filled strip between the outer bottom edge and
  the inner cutout vanishes when the scaled strip approaches one device pixel.

## The 13 rulings → decisions

### 1. Threshold picker redesign — the battery's bars are the threshold display
Captain: instead of the moving red and yellow lines creating one red bar and one
yellow bar, pulling the slider just colors the bars; two red bars fine, three red bars
fine. Firstmate gloss: bars are colorable discrete slots, duplicates of a color allowed.

- Only the battery (SWAP RESERVE LED bar) has bars and threshold lines — this ruling
  is scoped to the battery picker. The other gauges (psi/hd dials, VRAM reservoir)
  keep their zone rendering and their ordering law.
- `quattro.js`:
  - DELETE the battery threshold ticks (`battTickFracs` and its QuattroDash Repeater):
    that is the "moving red and yellow lines".
  - NEW `battSegmentZone(fracCenter, pair)`: a segment's zone color from its center
    position on the 0-100 charge scale — below `red` → red, below `amber` → amber,
    else green; red checked first so overlapping/crossed pairs read deterministically
    (red dominates the overlap). Slider at ~20 → two red bars; ~30 → three.
  - DUPLICATES ALLOWED: the batt pair loses its ordering law. `gaugePair("batt")`
    stops reordering (vram keeps its law); `adjustGaugePair("batt")` stops pushing —
    each slider sets its own line, no clamp between them. psi/hd/vram laws unchanged.
  - `ledBandWith` goes red-first (below red → red, below amber → amber, else green) so
    the icon tint, tooltip word, tier judgment, and the segment coloring agree even on
    crossed pairs. For sane pairs (amber ≥ red) results are identical to today.
  - SETTINGS.hint "Red never crosses amber." is now false for the battery — replaced
    (see item 3 wording).
- `QuattroDash.qml` battery box: remove the ticks Item; each LED segment wears its
  zone color (fill when lit, border when unlit) so dragging a slider colors the bars
  in the same frame the pair changes.

### 2. Popup simplicity — the simple current reading, one line
Captain: "pop ups are so verbose. remember i just wanted the simple reading? one line only."

- `quattro.js` hover decodes shrink to ONE reading row each (header + the reading):
  `psiTipWith` ("12.3 PSI, green, healthy."), `battTipWith` ("20 percent remaining
  right now." / "no swap is configured."), `fuelTipWith` ("437 GB free of 1.9 TB
  (77 percent)."), `coolantTipWith` ("7.1 GiB used, 8.7 GiB free of 15.9 GiB."),
  `codeTip` (the status line). The Metric/What/Why/Ranges rows leave the popups;
  the locked wrappers (`psiTip`, `battTip`, `fuelTip`, `coolantTip`) shrink with them.
- `MemoryPanel.qml` (the detail window) per-metric sections collapse to one reading
  line each, copy from `memory.js`:
  - NEW `ramReadingLine(ram)`: pressure PSI + swap used (percent, GiB) + GiB free,
    held marker when latched — one line ("RAM PRESSURE 12.3 PSI - swap 15% used
    (1.2 GiB of 8 GiB) - 9.8 GiB free of 25.7 GiB").
  - NEW `vramReadingLine(vram)`: one line ("VRAM 45% used - 7.1 GiB free of 12.9 GiB").
  - The psiText / swapText / unreachableBandNote prose lines leave the RAM section
    (folded into the one line); drives stay one reading line + dim device caption.
  - Controls (ceiling editors, guard buttons, health check, kernel ceiling) stay.
- The bar badge tooltip is already the simple form (names + dots) — only its
  alignment changes (item 10).

### 3. Settings copy — amber/red descriptions out, what+why in
- `quattro.js` SETTINGS: `copy` per gauge becomes two lines, ONE sentence on what the
  metric IS + ONE line on WHY we measure it; no amber, no red words; quattro language
  law (no em/en dashes, no semicolons) holds. GaugeSettingsRow renders the two lines.
  - psi: what = the kernel's memory PSI (stall share from /proc/pressure/memory);
    why = stalling is when the machine actually slows.
  - hd: what = free space on the root disk; why = a full root drive freezes the machine.
  - batt: what = the emergency swap the kernel falls back to; why = an empty reserve
    stops the machine like a car out of fuel.
  - vram: what = the GPU's memory, the light tracks what is free; why = the next big
    model load needs free VRAM.
  - hint: "Drag a slider to set where each color starts." (replaces the crossing rule).

### 4. RENAME: 'VRAM COOLANT' → 'VRAM' everywhere
- `quattro.js` `GAUGE_TITLES.vram`: "VRAM COOLANT" → "VRAM" (the last user-visible
  occurrence; `INSTRUMENTS.coolant` is already "VRAM"). Ceiling-blocked toast and the
  settings row inherit the rename. Repo grep is the guard; README wording updated.

### 5. RENAME + TOASTS: the product is 'Quattro Dash' (round 7 item 5, widened by ruling 14)
- RULING 14 (mid-build, from the captain via firstmate): the plugin RENAME - it is
  'Quattro Dash' now, not 'Memory Monitor'. Sweep every user-visible 'Memory
  Monitor' string (manifest name, settings title, UI copy) into the rename
  alongside item 5; the technical plugin id and directory stay unchanged this
  round.
- `memory.js`: `NOTIFIER_APP` = "Quattro Dash" (the -a app name and toast title);
  `guardAskTitle`/`guardAskBody`; GUARD_VARIANTS off/refused/died lines ("Click to
  open Quattro Dash"); `actionFor` band 3 ("Open Quattro Dash"); `ceilingsQuestion`
  header; agent prompt openers ("Quattro Dash reports that...", health check,
  onboarding first run); panel copy (`guardNoteText`, `twoCeilingsNote`,
  `guardStateText`, degradations, tooltips) - the round7 sweep test pins that no
  user-visible copy string still says Memory Monitor.
- `manifest.json`: name + displayName "Quattro Dash", description swept; the id
  `io.github.jasonlnheath.memory-monitor`, the directory, entryPoints, IPC target
  and the trust fence ("MEMORY MONITOR DEVICE DATA") stay technical and unchanged.
- `MemoryPanel.qml` header → "Quattro Dash"; `memory-monitor/README.md` swept;
  `skills/memory-health/SKILL.md` copy swept (directory name stays).
- README toast examples updated.

### 6. KILL the RAM-percentage warning toast; watch swap and PSI now
- The RAM band is no longer resolved from used-percent, so a percent crossing can
  never toast. See item 8 for the replacement model. `resolveBand`/`bandForPct`
  stay generic (VRAM and drives still use them; RingKit conformance untouched).

### 7. EMBLEM: the bar logo no longer turns red from RAM percentage
- `MemoryMonitor.qml` `barEntries()`: the ram entry's band comes from the combined
  pressure+swap-reserve band (item 8), never from used-percent. Entry `pct` becomes
  the PSI reading so RingKit's severity headroom stays in one unit. testPct forces
  the PSI reading for ram.

### 8. RAM METRIC REPURPOSED: RAM monitors RAM PRESSURE (PSI), swap alongside
Captain: "I want the RAM to monitor Ram pressure" ... "we watch swap and psi now."

- `memory.js` NEW decisions:
  - `psiBandFor(psi, thresholds)` — the ram threshold store (amber 70 / red 90
    defaults, critical user-set) now judges PSI some avg10 (0-100), same store,
    same validation, same defaults — the psi gauge pair and these ceilings remain
    the same numbers, so settings persistence needs NO schema change.
  - `reserveBandFor(reservePct, battPair)` — the swap RESERVE battery becomes a real
    signal: red-first mapping of the batt display pair (free % below red → 2, below
    amber → 1). No swap configured → 0.
  - `ramCombinedBand(psiBand, reserveBand)` — max.
  - `reserveUsedPct`/`reserveThresholds` — the battery pair inverted into the
    generic resolveBand machinery (used-equivalent = 100 − free).
- `MemoryMonitor.qml` `evaluateBands()`: two signal lanes under the ram resource —
  `ram:psi` (applyBand over psiSome vs thresholds("ram"), PSI-stall crossing as the
  re-fire flag) and `ram:swap` (applyBand over used-equivalent reserve vs the batt
  pair, oomd swap-limit crossing as the re-fire flag); `bands.ram` = combined for
  badge/tooltip/log. Each lane primes and hystereses independently.
- Toast copy says the signal: psi → "System RAM pressure has reached X PSI.";
  swap → "Swap reserve is down to X percent."; hd/vram wording unchanged. The alert
  event carries `signal` ("psi" | "swap").
- Hysteresis margin (4) now PSI/reserve points; `descentReachable` loses the
  used-percent MemAvailable gate (a PSI or reserve release is always reachable);
  `unreachableBandNote` states the release line in PSI for ram.
- Swap's oomd-limit escalator and PSI stall floor keep their existing roles
  (`swapEscalates`, `psiStalling`, poll escalator) — they ride the new lanes.
- `restingFromLog`/`recommendCeilings`/`ceilingsQuestion`/`restingText` for ram move
  to PSI numbers (the baseline log already stores psiSomeAvg10 per record).

### 9. NEW LINE for SWAP in the dash
- `quattro.js` NEW `swapLine(swapTotals)`: "15 percent used, 1.2 GiB of 8 GiB" /
  "none configured" (terse register, language law). `valueRows` gains a SWAP row
  after SWAP RESERVE (signature gains the swap totals). The full dash gains a
  centered one-line SWAP caption under the cluster row showing the same string.

### 10. POPUP FORMAT FIX: the tooltip's dot column must line up
- `memory.js` `barTooltip` pads by ESTIMATED GLYPH WIDTH, not character count:
  NEW `textWidthUnits(text)` (per-class widths: caps, lowercase, narrow i/l/j/t/f/r,
  wide m/w, digits, space) and the pad count evens the estimated widths, so RAM,
  VRAM and Drive dots sit on one vertical line in a proportional font. Deterministic
  and pinned by test (equal estimated widths per row).

### 11. TOAST LOGO: the check-engine emblem
- NEW committed assets `memory-monitor/icons/mil-plain.png` / `mil-amber.png` /
  `mil-red.png` (128px, PAL amber/redHot, generated from quattro.js's own mil path
  — provenance recorded in README). `memory.js` NEW `toastIconFor(band)` (amber for
  band 1, red ≥ 2, plain otherwise) and `notifyArgs`/`notifyReplaceArgs` accept
  `iconDir` and add `-i <dir>/<file>`; `MemoryMonitor.qml` resolves its own
  `icons/` directory and passes it; `install.sh` copies the directory.

### 12. Toast button prefix + no permanent toasts
- The button read "default: <label>" because `notifyArgs` passed `-A "default:" +
  action` — a colon, which libnotify reads as part of the TEXT. Mount Monitor's
  working form is `-A "default=" + action` (equals). memory.js switches to the
  equals form; the button then reads the label alone.
- "I no longer want permanent toasts. make all temporary. the colored logo is
  enough." — `TIMEOUT_MS` {2,3} 0 → finite (30000); onboarding notices get finite
  timeouts; `URGENCE` 2/3 drop critical urgency (this shell's service forces
  never-expire for critical only, so temporary REQUIRES normal urgency — red and
  critical ride normal like amber; DND silences are recorded by the existing
  machinery and the tinted logo carries the persistent state). `notifyReplaceArgs`
  claim toast rides normal urgency + finite timeout. The notice lane gains the same
  120s watchdog release the alert lane has, so nothing can hold it forever.
  `bypassesDnd` stays structural (it reads urgencyFor).

### 13. LOGO RENDER BUG: colored logo bottom line missing/clipped
- `QuattroSymbol.qml`: fill-only items ALSO stroke their path with a device-pixel
  width (`1 / fit`, so exactly 1px after the Scale) in the same color — thin filled
  regions can no longer drop out at any size or renderer. Declared widths on
  stroke items are untouched. Verified offscreen at the four shipped sizes
  (220/44/22/17px) by a NEW pixel probe test that requires colored pixels spanning
  the bottom strip of the 17x17 square emblem (pre-fix: zero pixels there — the
  test is red before the fix).

## Ripples measured (named per the brief)

- Bar ring/badge state machine: ram entry band = combined PSI+reserve band; entry
  pct = PSI; testPct forces PSI for ram. Mount Monitor's own rings untouched
  (out of scope). Sibling HD suppression unchanged.
- Ring hover tooltip: barTooltip width-aligned (item 10); ram dot = combined band.
- Popup panels: MemoryPanel (one-line readings, header rename), QuattroDash
  (battery coloring, swap line, settings copy, one-line tips), VramPanel/CardBar —
  Mount Monitor side untouched (out of scope); the memory-monitor CardBar facade
  is unaffected (no api change).
- quattro.js thresholds consumers: psi pair still IS thresholds("ram") (same store,
  now PSI); batt pair free-form (duplicates); vram pair unchanged; tier from state,
  hero tint, coolant bands all read the same pairs.
- Settings persistence schema: NO change (thresholds store keeps amber/red/critical;
  gaugeSettings keeps batt/vram pairs). Stale `bands.ram` in existing state files is
  overwritten by the combined band on the first sample; new `ram:psi` / `ram:swap`
  keys ride the existing normalizeBands.
- Tests asserting RAM% behavior or toast copy: memory.test.mjs, toast.test.mjs,
  ram.test.mjs, guard.test.mjs, onboarding.test.mjs, quattro.test.mjs,
  quattro-thresholds.test.mjs, delegation/qml-ids guards — updated after their
  red-first replacements exist.
- Check-engine emblem conditions: hero/badge/codes tint from RingKit badges and
  quattro tier — unchanged code paths, now fed PSI+reserve bands for ram; the mil
  render fix (item 13) applies to every emblem surface.
- NOT touched (scope law): mount-monitor plugin, manifest.json version, trust-fence
  wording, Mount Monitor's VRAM telltale, the wallpaper ruling.

## Order of work

1. Red tests for the metric-model changes (items 6/7/8) and the copy/behavior
   changes above, run to show RED.
2. memory.js + quattro.js decisions; QML renderers; icons; install.sh; README.
3. Full suite green (`bash memory-monitor/tests/run.sh` + `bash tests/run.sh`),
   qmllint clean, offscreen emblem probe green.
4. Commit on fm/mm-quattro-round7; visual verify on Strata after build
   (screenshots into the task report data dir); then the no-mistakes pipeline.
