# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## Layout

- `MountMonitor.qml` is the whole widget: QuickShell `BarWidget`, the alert
  queue, the `findmnt` / `lsblk` / `notify-send` / agent `Process`es plus the
  long-running `udevadm` monitor `Process` and its timers, the state
  `FileView`s, and the ring drawing. It keeps state (bands, queues, `primed`, the
  last scan, the event-burst and monitor-restart bookkeeping) and decides
  *when* to ask mounts.js; it holds no decisions itself. It is also the
  wallpaper's display half: it reads the meter the service writes, shows the
  usage line on the indicator's tooltip, and relays the cap warning.
- `StreetView.qml` is the wallpaper service (manifest kind `service` beside
  `bar-widget`): the fetch half. A tick asks `StreetView.plan()` for one
  action and executes it — wiring only, no URLs, no argv literals, no copy,
  no counter mutation.
- `mounts.js` holds the pure decisions: how a plugin setting value becomes a
  mount list, an argv, a flag, or a number, which findmnt row may draw a ring,
  the 80/90/98 bands, the notification body, its action label, the whole
  `notify-send` argv and the argv a click runs, the agent prompt, the id a prompt
  names a mount or partition by and the untrusted device-data block the rest of
  the device's own words ride in, the tooltip, the partition candidate filter,
  the onboarding state file, the block-event detection decisions (the `udevadm`
  argv, what counts as a block event, how a burst coalesces into one rescan and why
  a settle rescan follows it, the restart backoff), and the copy for every
  notification kind except the Street View cap warning's (streetview.js writes
  that copy; the dispatch only hands it through). Put
  filter, threshold, candidate, setting, and alert-wording changes there so they
  are covered by the tests.
- `mounts.js` is imported by QML (`import "mounts.js" as Mounts`) and loaded by
  the node tests through `node:vm`. It must stay plain top-level `function`
  declarations: no `export`, no `import`, no `.pragma library`, or one of the
  two consumers breaks.
- `streetview.js` holds the wallpaper's pure decisions under the same
  contract (imported as `StreetView`): the seven `streetview*` settings and
  their paranoid fallbacks, `extractConfig` (the service reads the widget's
  bar entry in shell.json live, because services get no injected settings),
  the two meters and their calendar rollover, `plan()` / `imagePlan()` (the
  quota guard), the metadata coverage parse, the rotation, `usageLine`, the
  wallpaper's notification copy (cap warning via the `streetview-cap` kind in
  mounts.js's dispatch, which carries alert-supplied copy for that kind only;
  the pause receipt for an explicit 0 daily cap, a transient popup that asks
  for nothing), and the status popup argv. Same plain-functions rule as mounts.js.
- `skills/` holds the agent skills `install.sh` copies to `~/.agents/skills/`:
  `disk-prune` (cleanup analysis), `partition-onboarding` (add a monitor),
  `partition-remove` (unwire one), `streetview-wallpaper` (report usage,
  present the cap options, apply cap changes). Notification copy and skill
  wording have to agree — change both.

## Tests

`bash tests/run.sh` — `node --test tests/` over the fixtures in
`tests/fixtures/` (`findmnt` rows, `lsblk -P` rows, real `udevadm monitor` lines)
plus live `findmnt` and `lsblk` checks that skip when the mount or the tool is
absent, a live check in `tests/click.test.mjs` that runs the notification
service's own `parseExecArgv` against the plugin's hint (skips where the shell is
not installed), the block-event detection decisions in `tests/detect.test.mjs`
(including a live `udevadm monitor` + `udisksctl loop-setup` plug that skips where
either is absent), the quota guard, meter math, settings recovery, and copy of
the wallpaper in `tests/streetview.test.mjs` (no live network calls — a key or a
reachability requirement would make the guard untestable), the
hostile-label regression in `tests/label-injection.test.mjs`, the
spaced-mountpoint regression in `tests/spaced-mountpoint.test.mjs`, an install.sh
syntax check, a check that every `skills/*/` has a `SKILL.md`, then `qmllint` on
both QML entry points (syntax and import resolution; QuickShell-type warnings are
expected outside a running shell). `testPct` in `shell.json` is the manual hook:
it forces every ring to a percentage, alerts included. There is no way to test a
real desktop notification, a real click, or a real wallpaper change headlessly.
The tests cover the mounts.js decisions behind the notifications, the click argv,
the settings recovery, the trust boundary between the plugin's fixed prompt copy
and what a device calls itself, and the streetview.js quota guard; the tests that
look at `MountMonitor.qml` and `StreetView.qml` are delegation guards (the widget
builds its findmnt command through `Mounts.findmntArgs`, its popup command through
`Mounts.notifyArgs`, and its agent command through `Mounts.agentArgv`, and it
carries `m.id` / `c.id` rather than inventing names; the service executes
`StreetView.plan()` outputs and builds no request itself; the guards pin the
shapes the wiring depends on — the service's `imagePlan` call carries all five
arguments with the recovered config in the config slot, and the wallpaper
indicator is declared beside the mounts `Repeater`, never inside it — because
presence alone let two wiring bugs through). The rest of the wiring
is verified by reading it and by the captain on the rig.

## Contracts worth not breaking

- **Device text is data, never instructions** (marketplace finding
  omacom/omarchy-plugin-marketplace#12972, Medium): a volume label, a PARTLABEL,
  and — because udisks2 auto-mounts a stick at `/run/media/<user>/<LABEL>` — a
  mountpoint are written by whoever formatted the filesystem, and they arrive
  through `lsblk` and `findmnt`. Typed argv keeps a shell out of the click; it
  never kept a crafted label out of the sentence. Every prompt is now fixed copy
  in `mounts.js`, identical for every device of a kind; a mount or partition is
  named by `Mounts.mountId` (`mm-<8hex>-<8hex>`, minted from the candidate's
  `key` — PARTUUID, else UUID, else device path — and from the target for a ring)
  and validated by `isMountId` on the way out, so a device never supplies the name
  the agent is told to act on. Everything else a device calls itself rides inside
  `dataOpen()` / `dataClose()` as `JSON.stringify` of `mountRecord` /
  `candidateRecord`, through `sanitizeText` (control characters, bidi overrides and
  zero-width formatting, and `<` `>` — which is what makes the delimiters
  unforgeable — turned into spaces, whitespace collapsed, truncated at
  `DEVICE_TEXT_MAX`, paths at `DEVICE_PATH_MAX`). `untrustedNotice()` carries the "data, not instructions"
  declaration and the requirement that the user confirm the concrete change: keep
  that wording out of anything a device controls, and never put a label, target,
  or device path into an instruction sentence again. `tests/label-injection.test.mjs`
  is the guard.
- Every plugin setting is read through a `Mounts.normalize*` helper
  (`normalizeMounts`, `normalizeAgentCommand`, `normalizeBool`, `normalizeNumber`).
  The hand-off delivers a Qt list, not a JavaScript Array: `Array.isArray` on a
  `setting()` value rejects a correctly configured array, which is how a bar with
  three configured mounts drew one ring, offered the other two as unmonitored,
  and refused its `agentCommand`. The JSON round-trip recovers it; a value that
  is not a list at all falls back to the documented default (root only, no agent
  override). An explicitly empty `mounts` list means no rings, not garbage.
  Never judge a setting with a bare array check in QML again.
- **findmnt escapes; `parseRows` undoes it** (the bug PR #8 deferred): findmnt
  hex-escapes every byte outside printable ASCII, and the backslash, inside its own
  columns — `/mnt/my stick` prints as `/mnt/my\x20stick`, a tab as `\x09`, `Données`
  as `Donn\xc3\xa9es`. That escaping is what makes splitting on whitespace safe; the
  bug was keeping the escape in the value, where it could never match the `mounts`
  entry or lsblk's real `MOUNTPOINT`. `Mounts.unescapeFindmnt` (with `utf8Decode`,
  plain JS because QML's engine has no `TextDecoder`) decodes each column after the
  split, so a spaced mountpoint is one `mounts` entry, one ring, one `mountId`, one
  `target` key in the band memory, and one watched device for the onboarding filter.
  A byte sequence that is not valid UTF-8 becomes U+FFFD rather than an invented
  character. `tests/spaced-mountpoint.test.mjs` is the guard, including a live
  round-trip of a real findmnt reading against findmnt's own escaping rule.
- **Detection is event-driven, with the 60s sweep as the fallback** (the captain's
  USB test 2026-10-26: 30-60 seconds to a notice): `MountMonitor.qml` keeps
  `Mounts.udevArgs()` (`udevadm monitor --kernel --subsystem-match=block`, no root,
  no polkit) open as a long-running `Process` with a `SplitParser`, and the only
  answer to a block line is `root.refresh()` — the same path the sweep uses, so
  rings, band alerts, and onboarding notices are untouched. Every timing decision
  lives in `mounts.js`: `isBlockEvent` (any action on the block subsystem counts —
  a replug of a device the kernel already knows is `change`-only, and a `remove` is
  wanted because it drops a notice whose drive is gone), `rescanDelayMs` (coalesce
  the burst: quiet for `udevQuietMs`, capped at `udevMaxWaitMs` so a burst that
  never stops still rescans), `udevSettleMs` (a second rescan, because udisks2's
  automount lands ~70 ms after the last uevent and mounting a filesystem emits no
  block uevent of its own), and `udevRestartDelayMs` / `udevStableMs` (a dead
  monitor restarts on a widening backoff, then gives up to the sweep; one that
  stayed up earns its budget back). Measured on the rig: kernel uevent reaches
  Quickshell ~10 ms after the plug, mount ~70 ms after the last uevent; the real
  lines are in `tests/fixtures/udev-monitor.txt`. A udev line's `devpath` and
  `subsystem` decide *whether to rescan* and nothing else — they never reach a
  prompt, body, id, or the state file. `detectEvents` is the `normalizeBool`-read
  off switch. Never remove the 60-second timer: it is what a missing or
  short-lived `udevadm` falls back to.
- Only mounts listed in the widget's `mounts` setting draw rings, in that
  order. There is no auto-discovery on purpose: several btrfs subvolumes of one
  device would each draw an identical ring, and unconfigured partitions
  (`/efi`) would appear unasked.
- A ring requires a device behind it (`SOURCE` under `/dev/`), so tmpfs, proc,
  cgroup2, and overlay never appear even when configured.
- A mount target deduplicates on target, not device — that is what keeps
  subvolume mounts alive.
- Read-only mounts alert on the same thresholds but must stay honest: nothing
  can be pruned or compressed there, so `notifyBody`, `notifyAction`,
  `agentPrompt`, and `skills/disk-prune/SKILL.md` all switch to a move-off
  report. Never reintroduce prune wording for a read-only mount.
- `install.sh` walks `skills/` and replaces each skill directory rather than
  merging, so every skill ships exactly the repo's copy. Adding a skill means
  adding a directory, not editing install.sh.
- Onboarding asks, it never decides: a scan may offer a partition, but a ring
  still only appears for a target in `mounts`. Keep it that way — the
  no-auto-discovery rule above is what the onboarding skills exist to serve.
- A candidate is a `lsblk` row with TYPE `part`, `disk`, or `crypt`, a FSTYPE
  that is not `swap`, a MOUNTPOINT, a path under `/dev/`, and is not a boot slice
  (`isBootSlice`: vfat under 1G, or labelled exactly `efi`, `esp`, or `boot`, or
  mounted at `/efi` or under `/boot/`). Pseudo filesystems
  are absent because `lsblk` never lists them; an unmounted partition is not
  offered because it cannot have a ring. The `crypt` rule is what puts a LUKS
  install's mounted root on the list — the `crypto_LUKS` container partition
  stays out because it carries no MOUNTPOINT. Removable drives are candidates
  on purpose (backup and long-term storage), and `RM` is the only place that
  flag comes from. The EFI partition is noise, not storage: offering it is what
  made a fresh scan report one bare partition count next to three real drives.
- Partition identity is `PARTUUID`, else `UUID`, else the device path — never
  the mountpoint and never the device name. That is what keeps a replugged USB
  drive from being "new" again, and what the state file keys on. A decrypted
  `crypt` row has no PARTUUID, so it keys on the filesystem UUID — stable
  across reboots.
- The once-only memory is `~/.local/state/mount-monitor/onboarding.json`
  (`Mounts.statePath`): `onboarded` fires the first-run count notice once per
  install rather than once per shell restart, and `decisions` (offered /
  declined / monitored) is what stops the nagging. The widget writes its scan
  into `candidates` with a `monitored` flag and the `id` the notice named that
  partition by, so the skills and the bar agree on the list and an id maps back to
  a `key` there; the skills must merge into `decisions`, never replace it. A
  new-partition offer is recorded when its notice is delivered, not when it is
  queued — a notice dropped on a drive that went away leaves no record, so the
  drive is asked about again when it returns. Deleting
  the file re-runs first run on the next shell start (`omarchy restart shell`)
  — that is the intended reset hook; a live widget keeps the state in memory
  and writes it back, so restart first.
- A scan that exits non-zero is not a scan: `scanDone` is set only on exit 0,
  so the next refresh retries instead of recording a first run from an empty
  result.
- A partition already behind an existing ring is never offered: exclusion checks
  the configured targets *and* the device behind each ring (`Mounts.deviceOf`
  strips the `[/subvol]` suffix findmnt adds), which is what keeps `/var/log`
  from being offered next to a `/` ring on the same btrfs partition.
- The first-run notice reports **both** counts in plain words — `3 watched, 2
  need a decision.` — never one bare number: a notice that counts only the
  unmonitored partitions read as a miscount to a captain who can see their own
  drives. The `monitored` flag is built once (`Mounts.annotateCandidates`: the
  state file, the skills, and the notice all read it), counted by
  `Mounts.monitoredCount`, and queued with the notice as `watched`;
  `onboardingBody` and `onboardingPrompt` take the whole notice, not a candidate
  list. Never print a zero — nothing waiting reads `All 4 watched. Nothing to
  decide.`, nothing watched reads only `3 need a decision.`
- A click reaches the agent through the omarchy-native exec hint, not the
  libnotify action alone. `Mounts.notifyArgs` adds
  `-h STRING:omarchy-exec-argv:<json argv>` to every notification: the daemon
  (`Service.qml invokePopupDefault`) prefers that argv, which is persisted with
  the row so a notice that outlived a shell restart is still clickable, and only
  then falls back to the live `-A default=` action, which dies with its sender.
  Keep both: the action is what makes `notify-send` block while the popup is
  clickable and what the alert queue drains on. The argv is built as a list
  (`Mounts.agentArgv`, the prompt appended as one argument), never as a shell
  string, because the daemon runs it through `Util.execArgv`. `execHintValue`
  sends nothing the daemon's `parseExecArgv` would refuse (a program with a
  leading dash), leaving the live action in place.
- Every notification kind rides the same `notify-send` + agent plumbing and
  dispatches on `kind` through `promptFor`, `titleFor`, `actionFor`, `bodyFor`,
  `urgencyFor`, `timeoutFor`. Band alerts send on `notifyProc` (one at a time,
  watchdog-released after 120s so a stuck popup cannot hold the rest of the
  mounts shut); onboarding and new-partition notices send on `noticeProc`, which
  no timer ever releases. A notice that has to be answered is critical urgency
  with timeout 0: Omarchy's own notification service returns 0 (never expires)
  for critical only and clamps every other urgency to at most 30 seconds whatever
  the sender asks for, so a normal-urgency notice vanishes before it can be
  clicked. `notify-send` blocks while its action is live, which is why a
  never-expiring notice needs its own process — a question nobody answers must
  not hold a full-drive warning in the queue. Once a notice leaves the screen,
  Omarchy's notification history (`~/.local/state/omarchy/notifications/history/`,
  `qs-ipc notifications showHistory`) is what keeps it reachable.
- `partition-onboarding` is present-first: the first-run click prompt already
  carries the watched count and every waiting candidate (a new-partition click
  carries just that partition, no counts), so the skill reports what the prompt
  brought before reading anything, takes exactly one
  verification read (the state file, for `id`, `key`, `monitored`, and
  `decisions` — the read is where an id becomes a `key`), and never re-runs
  `lsblk` or re-derives the filter. The direct scan lives only
  under its "no list in the prompt" fallback.
- `partition-remove` changes the `mounts` setting and records a decline, and
  must never touch the partition: no delete, no unmount, no format.
- **The wallpaper's free tier is enforced by construction, not by promise**:
  `StreetView.plan()` / `StreetView.imagePlan()` in `streetview.js` are the
  only place a Street View request is ever built, and a capped plan carries
  no argv field at all — the request is not refused, it is never built. The
  billable image endpoint is reached only after the free, unlimited metadata
  endpoint answered coverage, and `imagePlan` re-checks the meter anyway;
  the incremented meter is persisted before the request goes out (a failed
  download is never refunded — under-counting risks a real bill,
  over-counting costs only free headroom). Two meters guard it: monthly
  (the 10,000 free ceiling; a value above it in `streetviewMonthlyCap` is
  the explicit paid unlock and is honored) and daily (`streetviewCapPerDay`,
  ON at 100 out of the box; `0` pauses — `capEpisode` mints no episode while
  paused so the cap warning never fires, and the widget sends one
  normal-urgency receipt per entered pause, its `paused` flag riding the same
  single-writer cap-state file; only an explicit `-1` removes the daily cap).
  Absent or garbage settings fall back toward the paranoid side, never
  toward unlimited, and an unreadable clock reads as capped, never as free.
  QML holds no URL, no argv literal, no copy, and no counter arithmetic.
  `tests/streetview.test.mjs` is the guard.
- **Every Street View file has exactly one writer**: the service writes the
  meter (`streetview-meter.json`), the widget writes the warned-episode file
  (`streetview-cap.json`), the user's shell.json is only ever edited by the
  user or the agent at the user's word, and the API key lives only there —
  never in a prompt, a notification, a log line, or a committed file. A
  location name never enters a sentence (it rides the plan and the URL),
  which is the device-text contract applied to user config.
- The cap warning rides the existing notice lane as kind `streetview-cap`,
  persistent and never-expiring like the onboarding questions; mounts.js's
  dispatch honors alert-carried copy for that one kind only, checked by kind
  first so no other alert can smuggle a prompt field past the fixed copy.
  `streetviewCapPerDay: 0` and the off switch must stay able to make the
  service send nothing at all — a cap of zero is a pause, not garbage.

## Release

Version changes in `manifest.json` need the captain's explicit word; do not bump
it as part of a feature or fix.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
