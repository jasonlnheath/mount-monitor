# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## Layout

- `MountMonitor.qml` is the whole widget: QuickShell `BarWidget`, the alert
  queue, the `findmnt` / `lsblk` / `notify-send` / agent `Process`es, the state
  `FileView`, and the ring drawing. It keeps state (bands, queues, `primed`, the
  last scan) and decides *when* to ask mounts.js; it holds no decisions itself.
- `mounts.js` holds the pure decisions: which findmnt row may draw a ring, the
  80/90/98 bands, the notification body, its action label, the agent prompt, the
  tooltip, the partition candidate filter, the onboarding state file, and the
  copy for every notification kind. Put filter, threshold, candidate, and
  alert-wording changes there so they are covered by the tests.
- `mounts.js` is imported by QML (`import "mounts.js" as Mounts`) and loaded by
  the node tests through `node:vm`. It must stay plain top-level `function`
  declarations: no `export`, no `import`, no `.pragma library`, or one of the
  two consumers breaks.
- `skills/` holds the agent skills `install.sh` copies to `~/.agents/skills/`:
  `disk-prune` (cleanup analysis), `partition-onboarding` (add a monitor),
  `partition-remove` (unwire one). Notification copy and skill wording have to
  agree — change both.

## Tests

`bash tests/run.sh` — `node --test tests/` over the fixtures in
`tests/fixtures/` (`findmnt` rows, `lsblk -P` rows) plus live `findmnt` and
`lsblk` checks that skip when the mount or the tool is absent, an install.sh
syntax check, a check that every `skills/*/` has a `SKILL.md`, then `qmllint`
on the QML (syntax and import resolution; QuickShell-type warnings are expected
outside a running shell). `testPct` in `shell.json` is the manual hook: it
forces every ring to a percentage, alerts included. There is no way to test a
real desktop notification or a real click headlessly — the notification layer is
verified by reading the wiring in the tests, and by the captain on the rig.

## Contracts worth not breaking

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
  that is not `swap`, a MOUNTPOINT, and a path under `/dev/`. Pseudo filesystems
  are absent because `lsblk` never lists them; an unmounted partition is not
  offered because it cannot have a ring. The `crypt` rule is what puts a LUKS
  install's mounted root on the list — the `crypto_LUKS` container partition
  stays out because it carries no MOUNTPOINT. Removable drives are candidates
  on purpose (backup and long-term storage), and `RM` is the only place that
  flag comes from.
- Partition identity is `PARTUUID`, else `UUID`, else the device path — never
  the mountpoint and never the device name. That is what keeps a replugged USB
  drive from being "new" again, and what the state file keys on. A decrypted
  `crypt` row has no PARTUUID, so it keys on the filesystem UUID — stable
  across reboots.
- The once-only memory is `~/.local/state/mount-monitor/onboarding.json`
  (`Mounts.statePath`): `onboarded` fires the first-run count notice once per
  install rather than once per shell restart, and `decisions` (offered /
  declined / monitored) is what stops the nagging. The widget writes its scan
  into `candidates` with a `monitored` flag so the skills and the bar agree on
  the list; the skills must merge into `decisions`, never replace it. A
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
- Every notification kind rides the same `notify-send` + agent plumbing and
  dispatches on `kind` through `promptFor`, `titleFor`, `actionFor`, `bodyFor`,
  `urgencyFor`, `timeoutFor`. Band alerts drain from the queue before onboarding
  notices, so a full drive never waits behind a question.
- `partition-remove` changes the `mounts` setting and records a decline, and
  must never touch the partition: no delete, no unmount, no format.

## Release

Version changes in `manifest.json` need the captain's explicit word; do not bump
it as part of a feature or fix.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
