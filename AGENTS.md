# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

## Layout

- `MountMonitor.qml` is the whole widget: QuickShell `BarWidget`, the alert
  queue, the `findmnt` / `notify-send` / agent `Process`es, and the ring
  drawing. It keeps state (bands, queue, `primed`).
- `mounts.js` holds the pure decisions: which findmnt row may draw a ring, the
  80/90/98 bands, the notification body, its action label, the agent prompt,
  the tooltip. Put filter, threshold, and alert-wording changes there so they
  are covered by the tests.
- `mounts.js` is imported by QML (`import "mounts.js" as Mounts`) and loaded by
  the node tests through `node:vm`. It must stay plain top-level `function`
  declarations: no `export`, no `import`, no `.pragma library`, or one of the
  two consumers breaks.

## Tests

`bash tests/run.sh` — `node --test tests/` over the fixtures in
`tests/fixtures/` plus a live `findmnt` check that skips when a mount is absent,
then `qmllint` on the QML (syntax and import resolution; QuickShell-type
warnings are expected outside a running shell). `testPct` in `shell.json` is the
manual hook: it forces every ring to a percentage, alerts included.

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
- `install.sh` replaces `~/.agents/skills/disk-prune` rather than merging, so
  the skill ships exactly the repo's copy.

## Release

Version changes in `manifest.json` need the captain's explicit word; do not bump
it as part of a feature or fix.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
