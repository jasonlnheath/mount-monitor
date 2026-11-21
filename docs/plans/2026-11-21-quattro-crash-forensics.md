# Quattro Dash round 11 — crash forensics and sustained-pressure engine codes

The machine wedged (2026-11-20 → 11-21) and the captain hard-cycled it. His words:
"quattro dash ought to be good enough where i don't have to ask you what went wrong.
i should be able to go back into quattro dash after a crash and it should throw a code.
it should be monitoring the logs that you're looking at." And: "if there's something
else we need to monitor quattro dash should do that. maybe not with a gauge but with
an engine code."

Two capabilities, both extending the round-9 system-code system (codeFor, the codes
column, locked decodes and Fix lines in quattro.js) rather than a parallel one:

1. **Crash forensics codes.** A journal watcher scans the system journal for wedge
   signatures across the current AND the previous boot, latches a persistent code per
   signature with the evidence (timestamps plus the actual log lines), and persists the
   latches to the plugin state dir so they survive restarts and show after a crash.
2. **Sustained RAM-pressure code.** RAM PSI some avg10 held over the existing red
   ceiling for a sustained window lights a code (the captain's revision of the round-2
   "RAM is never a code" ruling — sustained pressure is a code now; a single spike and
   a cache-resident footprint with PSI 0 stay gauge-only). It clears when pressure
   falls back under amber for a clearing window.

Latched codes clear only per the existing code-clear rules (manual acknowledge or
condition-clear); crash latches persist across restarts by design until acknowledged.
No new gauges, no notification plumbing, no VRAM/HD changes.

## Measured on this rig before touching anything

The wedged boot is still `journalctl -b -1` here (boot list: -1 ended
Sat 2026-11-21 05:13:42 EST, the hard cycle; boot 0 started 11:31:14). All commands
run as the ordinary user, no root, no polkit.

- **The wedge signatures are in boot -1's kernel log.** One bounded grep answers for
  them all (158 ms over five days of journal, output capped at 80 lines):
  `journalctl -k -b -1 --output=short-unix --no-pager --grep '<pattern>' -n 80` →
  exit 0, 8 lines: two `watchdog: BUG: soft lockup - CPU#19 stuck for Ns!
  [kcompactd0:225]`, three `rcu: INFO: rcu_preempt detected (expedited )stalls on
  CPUs/tasks:`, three memcg oom lines (`python3 invoked oom-killer`, `oom-kill:
  constraint=CONSTRAINT_MEMCG,...task=python3`, `Memory cgroup out of memory: Killed
  process 87209 (python3)`). Current boot: same grep, 11 ms, exit 1, `-- No entries --`.
- **`journalctl --grep` exit codes are the readable/clean/unknown split**: no matches
  → exit 1 (a clean scan, the same line the GPU wedge code already draws); matches →
  exit 0 (output may still be `-- No entries --` when `--since` crosses a boundary —
  both are clean; the parser already skips that line); anything past 1 → unreadable →
  the honest unknown row, never a clean zero.
- **`--grep` is case-sensitive** without `(?i)` (`SOFT LOCKUP` finds nothing), and the
  kernel filter `-k` is mandatory: the full-journal grep matches Discord's
  `heartbeat blocked for more than 10 seconds` and would forge hung-task codes out of
  userspace noise. Every journal signature is a kernel message, so `-k` loses nothing.
- **The delta rule works**: `--since=@<epoch>` (short-unix epochs, the KERNEL cursor
  precedent in production) bounds each cycle's scan to the lines after the cursor.
  The previous boot never changes during a session, so its scan runs once per session;
  boot 0 rescans on the cursor. Both scans are grep-bounded, so "full" never means
  "the whole boot's output".
- **Multi-boot greps emit `-- Boot <id> --` separator lines** (no `-b` filter). With a
  single `-b`/`-b -1` they do not appear, and `parseJournalLines` already skips
  non-epoch lines, so separators are harmless wherever they slip in.
- **Unclean shutdown is NOT in the journal.** journald is stopped before systemd logs
  the final shutdown targets: boot -2's tail (a clean reboot, 54 s gap to boot -1)
  carries no `Reached target Shutdown/Power-Off` marker even 250 lines back, and the
  wedged boot's tail is kernel lockup spam. The honest source is wtmp, world-readable
  through `last -x --time-format=iso shutdown reboot`, no root: every clean boundary
  pairs `reboot system boot` with `shutdown system down`; the hard cycle left NO
  shutdown row — boot -1's reboot row still reads "still running" and the user rows
  say `- crash`. Decision is ordinal: newest row is the current boot; the first older
  row is a `shutdown` (clean) or another `reboot` (unclean — the previous boot never
  ended cleanly). No date parsing: the ISO timestamp stays text evidence.
- **The incident shape** (from the plugin's own baseline.log and these scans): healthy
  48% RAM, PSI 0, until a ~05:10 local restart attempt; teardown triggered RCU stalls
  (10:10:36Z), kcompactd0 soft lockups (10:13Z), hung tasks; the machine wedged; hard
  cycle. Hermes Telegram polling had failed since 19:08 the prior evening and the
  display would not wake, both predating the stall. The dash showed none of it, because
  every round-9 code is live-only and dies with the bar.
- **Calibration induces the very pressure the new code watches.** The round-10 quiet
  window already holds KERNEL and DISK entries while their state still advances; the
  PSI-pressure code must ride the same rule (a calibration run must never latch or
  sustain the pressure window), and crash latches pass through (a crash is never
  calibration noise).

## Design

Decisions in `quattro.js` (dash codes), the state path in `memory.js`, state and
processes in `MemoryMonitor.qml`, the acknowledge affordance in `QuattroDash.qml`.
Plain top-level `function` declarations everywhere, per the plain-module law.

### The seven signatures

One PCRE alternation (measured against the rig's real lines), classified per line by
first match in a fixed precedence, so `watchdog: BUG: soft lockup ...` is evidence for
the lockup code and is not double-counted as watchdog:

| sig | pattern fragment | band | culprits from |
|-----|------------------|------|---------------|
| lockup | `soft lockup` / `softlockup` | 2 | the bracketed task `[kcompactd0:225]` |
| rcu | `rcu.*(stall\|starv)` | 2 | `kernelModuleOf` (rcu) |
| hung | `blocked for more than` / `hung task` / `hung_task` | 2 | the task after `INFO: task ` |
| watchdog | `watchdog: BUG` | 2 | `kernelModuleOf` (watchdog) |
| nvrm | `NVRM:.*(Xid\|RmInitAdapter failed)` | 2 | fixed NVRM |
| oom | `Out of memory: Killed process` / `oom-kill` / `invoked oom-killer` / `Memory cgroup out of memory` | 1 | the `(python3)` victim name or `task=` |
| power | (not journal: the wtmp boundary) | 1 | none |

Kernel-text trust law unchanged: culprit names and evidence lines are data —
`sanitizeText` everywhere, the diagnosis JSON's scrub, never a prompt sentence.

### quattro.js — argvs and parsers

- `crashWedgeArgs(cursor)` — `journalctl -k -b --output=short-unix --no-pager
  --grep <pattern> -n <CRASH_MAX_LINES>` plus `--since=@<cursor>` when a cursor
  exists; boot 0, every cycle.
- `crashWedgePrevArgs()` — the same argv with `-b -1`, no since; the previous boot,
  once per session (the boot never changes while the session lives).
- `crashLastArgs()` — `last -x --time-format=iso shutdown reboot`; once per session.
- `parseLastBoots(text)` — rows of `{ kind, iso, raw }`, newest first, skipping every
  line that is not a `reboot`/`shutdown` row (user rows, `wtmp begins`).
- `uncleanShutdown(rows)` — the ordinal boundary rule; returns
  `{ unclean: true, iso, raw }` for a reboot-follows-reboot boundary, `{ unclean:
  false }` for reboot-follows-shutdown, null when nothing answers.
- `classifyCrashLine(message)` — precedence table above.
- `parseJournalLines` reused untouched (it already skips separators and
  `-- No entries --`).

### quattro.js — the latch

- Records live in a map keyed by signature:
  `{ sig, boot, firstEpoch, lastEpoch, count, saturated, bootIso, lines[] }` where
  `lines` keeps the newest `SYS_DETAIL_MAX_LINES` exact journal lines as
  `{ epoch, message }` (power keeps raw wtmp rows and `bootIso` instead of epochs).
  Only facts are persisted; the copy is derived at render so wording changes apply.
- `crashSysUpdate(prev, last, boot, cursor, latched)` →
  `{ cursor, latched, entries, changed }`: merges each readable scan's
  classifications into the map (counts are cursor- and dedup-honest: only lines past
  the record's `lastEpoch` add to the count, so the once-per-session prev scan and the
  per-cycle boot deltas never double-count), derives one entry per record, and renders
  the unknown row when any scan came back unreadable (exit past 1, `last` missing).
  Nothing here can fabricate a signature: unknown signatures in the file are dropped
  by the normalizer.
- `crashRecordEntry(record)` — the sysCode entry, subject `sys|crash:<sig>` (the
  `layerSubject` precedent, stable digits over a stable subject), band per signature,
  locked Fix lines untouched, status words of its own
  (`SYS_STATUS.crashSevere` / `SYS_STATUS.crashModerate`, "crash evidence in the
  journal."), issue lines terse per the round-4 language law.
- `ackCrashRecord(latched, sig)` — pure map-minus-signature. `codeAckable(entry)` and
  `crashSigOf(entry)` keep the dash from deciding.
- `crashClearArgs` does not exist: clearing is a state-file write, not a command.
- Clear rules: a latch refreshes whenever a scan finds the signature again (new
  evidence, newer lastEpoch); a reboot does NOT clear it (persistence is the point);
  the manual acknowledge is the primary clear (right-click on the row, monitor-owned
  write); the unknown row clears itself the next cycle a scan is readable, like every
  round-9 dynamic row.

### quattro.js — the sustained-pressure code

- `PSI_CODE_SUSTAIN_SEC = 180` (the captain-tunable default, "on the order of
  minutes"), `PSI_CODE_CLEAR_SEC = 300`, `PSI_CODE_GAP_MS = 120000` (a clock gap
  bigger than this — sleep, suspended bar — restarts both windows instead of
  latching across a jump).
- `psiPressureSysCode(psiSomeAvg10, thresholds, prev, nowMs, sustainSecOverride,
  quiet)` → `{ next, entry }`. The red line is the EXISTING alert ceiling
  (`thresholdsFor(state, "ram").red`, user-set or the 28 PSI floor); amber is the
  same pair's amber. Hold at or over red for the window → latch band 2
  (`sys|ram` subject); fall under amber for the clearing window → unlatch; between
  amber and red mid-clear holds the latch and restarts the clear window; at or over
  red mid-clear restarts it the same way. A null reading keeps the state and renders
  nothing (never a healthy zero, never a forged fault). `quiet` (a calibration run or
  its hot aftermath) neither latches nor accumulates — the ladder's own pressure is
  induced, not organic. Pressure is stall time: the code's copy and inputs never
  touch MemAvailable or percent used, so a cache-resident machine at PSI 0 cannot
  light it by any path.
- The override rides the plugin's `psiPressureSustainSec` setting through
  `Memory.normalizeNumber(setting(...), -1)`, the `pollMs` / `vramFloorMib` pattern.
- The round-2 doctrine comment gains the dated revision (sustained pressure is a code
  now; amount high still is not); no locked copy changes.

### memory.js

- `CRASH_FILE_NAME = "crash-codes.json"`, `crashPath(home)` beside
  `settingsPath` / `logPath`. The state file stays the settings state's; the latch
  gets its own file so evidence blobs (up to seven records x 20 lines) never ride
  a settings write.

### MemoryMonitor.qml

- Three readers on the existing sample cycle (no second timer system): `crashboot`
  every cycle, `crashprev` and `crashlast` once per session (a satisfied reader is
  marked done synchronously so the cycle gate stays exact); `readNames` grows; the
  abandon path stops all three. Command lines are `Quattro.crashWedgeArgs(...)` and
  siblings — never assembled in QML.
- `crashLatched` mirrors the file; a `crashFile` FileView (atomic writes, loaded
  after `stateDirProc` makes the dir) feeds `Quattro.normalizeCrashLatched` and
  `Quattro.crashMergeLatched` (in-memory wins on newer lastEpoch). The writer
  instance alone writes, only when `crashSysUpdate` says `changed`.
- `buildSystemCodes` extends: crash entries concat after `sysCodesQuiet`'s five
  families (they pass through the quiet window), the PSI entry rides
  `psiPressureSysCode` and is held while `root.calibQuiet()`.

### QuattroDash.qml

- `QuattroCodeRow` gains a right-click: left still dispatches the diagnosis to the
  agent; right asks the monitor to `ackCrashCode` (the monitor decides via
  `Quattro.codeAckable`, writes, and the dash toasts `Quattro.crashAckToast`).
- `codeTip` for crash entries carries the detail the captain asked to view: Seen
  (first and last epochs), Evidence (the newest line, machine data), and the "right
  click clears the code" hint. Drive and round-9 rows keep the one Status line.

## Ripples, named and checked

- **The five round-9 codes**: untouched functions, untouched locked copies. The
  `sysCodesQuiet` signature stays 6-arg; crash and PSI entries concat outside it.
- **KERNEL's live lane**: still the err/crit delta with its own cursor; the crash
  watcher's cursor is a second, separate value. First-look baselines unchanged, so a
  restart after a crash still counts nothing live — the crash family is what speaks.
- **Tier, hero, check-engine head**: a band-2 crash latch raises the tier through
  `allCodes` exactly like any severe code — wanted: the dash must throw a code.
- **Alerts, toasts, the guard arm**: nothing registers crash or PSI codes as alerts;
  no notification plumbing changes (explicitly out of scope).
- **Baseline log**: no new rows, no logDue changes.
- **The settings state file**: untouched shape; the latch's own file normalizes
  junk to an empty map, and losing it is self-healing (the first prev-boot scan
  re-derives everything still inside `-b -1`).
- **Multi-instance**: writes gated on `isWriter` like every shared side effect;
  `allowMultiple: false` in the manifest keeps one live widget anyway.
- **Calibration**: quiet holds the PSI entry and freezes its windows; crash latches
  pass through (a lockup during a run is genuine); the calibration unit's own memcg
  oom already proved it can land in the journal (boot -1 carries one) — it latches
  like any oom, which is honest evidence of what happened.
- **Trust boundary**: argvs are fixed programs and constants (the grep pattern's
  `|` is argv data to journalctl, the precedent the GPU wedge words already ship);
  journal/wtmp text never enters a prompt sentence; ids and code digits come from
  subjects minted in quattro.js; the diagnosis JSON scrubs as before.
- **Language law**: every new user-visible string passes the em-dash/en-dash/
  semicolon scan, which grows to cover the new outputs.

## Tests (RED before the fix) — `tests/crash.test.mjs`

Fixtures from the rig: `crash-journal-prev.txt` (the eight real wedge/oom lines),
`crash-journal-boot.txt` (synthetic boot-0 lines with separators), `crash-last-unclean.txt`
and `crash-last-clean.txt` (real wtmp shapes).

1. Module shape: the new declarations exist; the plain-module law still holds.
2. Argvs: fixed programs from a closed list, typed arrays, no shell metacharacter
   beyond the grep alternation's own `|`, cursor only through `--since=@`.
3. `classifyCrashLine`: every signature classified from the real fixture lines,
   precedence (`watchdog: BUG: soft lockup` is lockup, not watchdog), non-matching
   kernel lines null.
4. `parseLastBoots` / `uncleanShutdown`: the unclean fixture answers unclean with the
   boot ISO; the clean fixture answers false; empty text answers null; junk rows skip.
5. Latch + persistence across a simulated restart: `crashSysUpdate` over the prev
   fixture latches lockup/rcu/oom with evidence and ids `Memory.isMemId` accepts;
   `JSON.stringify` → `normalizeCrashLatched` → `crashSysCodes` renders the same
   entries (same code digits, same band); unknown sigs and junk fields dropped.
6. Cursor and dedup: the boot delta never double-counts what the prev scan latched;
   a saturated scan says so.
7. The unknown row: unreadable exits render it and latch nothing; a later readable
   cycle clears it.
8. Power latch: the unclean boundary latches power with its ISO; a later clean
   boundary does NOT clear it; a second unclean boundary refreshes the evidence.
9. Acknowledge: `ackCrashRecord` removes exactly the named signature; the others
   survive; `codeAckable` refuses drive and round-9 entries.
10. `psiPressureSysCode`: a single spike latches nothing; samples spanning the
    window latch band 2; PSI 0 forever (however high used% goes) never latches;
    the clear window unlatches; mid-clear crossings restart the window; null keeps
    state; quiet neither latches nor accumulates; the override and the defaults are
    named constants; a sleep-sized gap restarts the windows.
11. Language rule and delegation pins extend in `tests/quattro.test.mjs`: the new
    copy in the banned-character scan, the new QML command lines and the
    `callMonitor("ackCrashCode"` / `Quattro.codeAckable(` pins, and the dash banned
    from touching the latch map directly.
