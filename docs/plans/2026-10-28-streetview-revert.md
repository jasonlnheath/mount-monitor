# Plan: revert Street View out of Mount Monitor

Captain's ruling (2026-10-28, words via Telegram): "I never intended you to
merge the wallpaper with mount monitor. These are two separate plug-ins. They
do two completely different things." Street View had just landed here as PR 11
(50ee046) and PR 12 (80e6944). The ruling: revert it out of this plugin
cleanly. Mount Monitor stays a standalone disk/drive monitor, unchanged
otherwise. The Street View feature is being relocated to the wallpaper project
in a parallel task; this task only cleans Mount Monitor.

## Method

HEAD is exactly 80e6944 and its parent is 50ee046, so both commits revert
cleanly with nothing in between: `git revert --no-commit 80e6944 50ee046`
(newest first), folded into one commit whose message names what left and why.

## What leaves (the full footprint, all of it introduced by the two PRs)

- `streetview.js`, `StreetView.qml`, `tests/streetview.test.mjs`,
  `skills/streetview-wallpaper/`, `docs/plans/2026-10-27-streetview-wallpaper.md`
- the `service` kind and wallpaper entries in `manifest.json`
- the Street View indicator, cap-relay wiring, and sv* procs in `MountMonitor.qml`
- the `streetview-cap` branches in mounts.js's notification dispatch
- the Street View sections of `README.md` and `AGENTS.md`
- the Street View lines in `tests/run.sh`

## What must not change

Every drive/disk monitoring decision: mount filter, bands, alerts, onboarding,
block-event detection, the notification plumbing itself, install.sh, the other
skills. No manifest version bump beyond what the revert restores.

## Guard (process law: red test first)

`tests/streetview-removed.test.mjs` pins the behavioral contract that remains
after removal, written before the revert and red under the current tree:

1. No notification kind in this plugin carries alert-supplied copy through the
   dispatch: `promptFor` / `titleFor` / `actionFor` / `bodyFor` given a
   `streetview-cap` alert with injected fields must fall through to the fixed
   band-alert copy, never echo the injected fields.
2. `isPersistent` no longer recognizes the kind.
3. The Street View files and skill do not exist.
4. A source scan over the shipped tree (mounts.js, MountMonitor.qml, manifest,
   README, AGENTS, skills, tests, run.sh — excluding docs/plans, which record
   history including this plan) finds zero streetview references.

## Verification

- New guard red before the revert, green after.
- Full suite (`bash tests/run.sh`) green after, qmllint over the one remaining
  QML entry point, `omarchy restart shell` not needed from a worktree.
- `grep -ri streetview` over the shipped tree returns nothing.

## AGENTS.md

The revert restores the pre-PR AGENTS.md; one line is added recording that the
wallpaper service briefly lived here and was reverted 2026-10-28 to the
wallpaper project, so no future session re-absorbs it.
