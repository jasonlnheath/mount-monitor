# Quattro Dash — the bar icon tells the truth about latched codes, the clear path says itself, and the code click really sends

The captain deployed round 11, clicked into the engine codes, and found the
wedged boot's latched codes sitting under a WHITE bar icon: "i was surprised
when i clicked on it to see all the codes". Clicking a code did nothing
visible and he had to ask "so how do those codes get cleared out?". His
ruling: the icon must tell the truth - any unacknowledged latched code lights
the engine icon (amber for moderate, red for severe) until acknowledged - and
the acknowledge path must be discoverable without asking anyone.

An inbox scope addition adds the third ask: the click loop itself is broken.
The dash's plain click spawns `omarchy agent prompt ...`, and this rig has no
default agent configured, so the spawn dies silently - every code grayed out
with a success toast and nothing was delivered anywhere. The click must
deliver to firstmate directly, as an inbox note.

## Decisions

### Fix 1 - the bar icon aggregates latched crash codes

- quattro.js owns the decision, as it owns every crash decision:
  `crashBarEntry(sysEntries)` renders the worst latched crash band as a
  badge-shaped entry `{type: "crash", band, latched: true}`, null when none;
  `barBadgeWithCrash(liveEntry, sysEntries)` picks between the live
  readings' most-severe entry and the crash history.
- Bands come from `CRASH_BANDS`, no new thresholds: oom and power are
  band 1 (amber), lockup, rcu, hung, watchdog and nvrm are band 2 (red).
  Band 3 never comes from a crash code, so no pulse is added.
- The live fault keeps the badge exactly as it has always been: the live
  entry wins ties and every band the crash history does not outrank; the
  crash entry only ever RAISES the band (`crash.band > liveBand`).
- The unknown row (an unreadable journal scan) is not a latch and never
  lights the icon; nor do kernel/gpu/layer/disk/bar/ram live codes or drive
  codes - they are not latches, and live behavior is preserved exactly.
- `MemoryMonitor.qml badgeEntry` becomes
  `Quattro.barBadgeWithCrash(Memory.mostSevereForBar(entries), sysCodes)`.
  `testPct` still forces readings only (the forcing happens before the
  aggregation, over `barEntries()`); `mostSevereForBar`, `barTooltip` and the
  severity language (RingKit `badgeParams`) are untouched - the widget only
  feeds a different band into the same badge path.

### Fix 2 - the clear path says itself

- Crash entries get their own Fix copy in quattro.js (`CRASH_FIX`), stating
  the clear path plainly: right-click clears the code and it stays cleared
  for this boot. `SYS_FIX` stays untouched - it is the shared copy pinned on
  drive, bar, kernel, gpu, layer and disk entries, and telling a kernel code
  to right-click would be a lie (`codeAckable` refuses it).
- The hover tip's Clear row gains the same promise ("it stays cleared for
  this boot") so tooltip and fix line agree.
- The right-click acknowledge path is already on the row the captain clicks
  (`QuattroCodeRow` in the dash's codes area: `codeAckable` gate, the clear
  performed by the monitor, `crashAckToast` confirming). Verified in place,
  not moved; the existing delegation pins keep guarding it.

### Fix 3 - the plain code click delivers to firstmate

- memory.js owns the argv (`codeNoteArgv`), the click-routing home:
  `["env", "FM_HOME=/home/jason/Work/firstmate",
  "/home/jason/Work/firstmate/bin/fm-inbox.sh", "note", "--", payload]` -
  typed argv, no shell, exactly the shape the captain specified and verified
  against `fm-inbox.sh note`.
- quattro.js owns the payload (`codeNotePayload(entry, rows)`):
  `quattro engine code <code>: <one-line issue> - diagnosis: <single-line
  diagnosis JSON>`. Sys codes use the diagnosis doc with every evidence-line
  array summarized to a count (`evidenceLines: N`, no lines), drive codes use
  the existing `diagnosisJson` (bounded top consumers, no lines). The whole
  payload is scrubbed exactly like the diagnosis JSON already is
  (backticks and angle brackets become spaces); `issue` text passes through
  `sanitizeText` so the payload is always one line.
- `QuattroDash.qml dispatchCode` runs the note argv on the plain path. The
  arm path is UNCHANGED: `isArmNotice` codes still go through the arm's gate
  with the FULL diagnosis JSON, refusal toasts stay, and `startArm` still
  launches the guard. `markSent` behavior unchanged.
- Toast copy truthful: severe `to firstmate`, moderate
  `queued to firstmate, processing on next wake` (the note queues and firstmate
  processes on its next wake; the old "(default agent), processing now" was
  the lie that hid the broken loop).

## Adversarial pass (folded)

- Live red + latched amber must not downgrade: crash wins only strictly
  greater. Pinned.
- Live amber + latched red lights red. Pinned.
- Acking the last latched code with no live fault returns to white. Pinned.
- The unknown row never lights the icon. Pinned.
- Junk sys entries (nulls, non-objects, kernel/gpu/drive entries) never
  light the icon. Pinned.
- `testPct` cannot reach the crash band: it forces `barEntries()` copies
  before the aggregation is called. Shape-enforced, no new code.
- Hostile issue text (newlines, backticks, angle brackets, bidi overrides) in
  the payload: single line, scrubbed. Pinned.
- Evidence arrays never ride the note: count summary only. Pinned.
- The arm path keeps its full-diagnosis prompt and refusal toasts; existing
  pins stay green untouched.
- No fixed sentence moves into the QML: payload and copy live in quattro.js /
  memory.js, so the panel's long-literal guard stays green.
- New copy obeys the language law (no em dashes, no en dashes, no
  semicolons); the note payload rides the same scan.
- `mostSevereForBar`, `SYS_FIX`, RingKit conformance: untouched; the whole
  existing suite must stay green.

## RED tests first

1. crash.test.mjs - icon aggregation at each band, mixed bands, ties,
   unknown-row and junk immunity, acked codes stop lighting (partial and
   full ack), MemoryMonitor.qml delegates through `Quattro.barBadgeWithCrash`.
2. crash.test.mjs - the crash Fix line carries the acknowledge instruction
   (right-click, stays cleared for this boot) at both bands; `SYS_FIX`
   unchanged.
3. quattro.test.mjs - the truthful dispatch toasts; `codeNotePayload` exact
   shape, single line, scrubbed, evidence counts, drive-codes path; language
   scan over the payload.
4. memory.test.mjs - `codeNoteArgv` exact argv, no omarchy element.
5. quattro.test.mjs delegation - the panel runs the note argv, no
   `Memory.agentArgv(` on the click path any more; the arm pins stay.
