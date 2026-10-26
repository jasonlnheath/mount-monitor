---
name: partition-remove
description: Mount Monitor unwire - stop monitoring a mount the captain no longer wants a usage ring for, and record it as declined so the plugin never offers it again. Use when asked to remove, unmonitor, stop watching, or delete a monitored partition or drive from the bar, or after a drive is retired. Touches the widget's mounts setting only - never deletes, unmounts, or formats anything on the partition.
---

# Partition remove

Goal: take a mount off the bar cleanly, and make sure Mount Monitor never offers
it again.

## Inputs

- **What is monitored today**: the `mounts` array on the
  `io.github.jasonlnheath.mount-monitor` entry in `~/.config/omarchy/shell.json`.
- **The partition behind each ring**: `findmnt -rn -o SOURCE,TARGET,FSTYPE,SIZE`,
  so a target is matched to its device instead of guessed at.
- **The onboarding memory**: `~/.local/state/mount-monitor/onboarding.json`,
  whose `candidates` give each partition its `key` (PARTUUID, else UUID, else
  device path) for the decline record.

## Procedure

1. **List what is monitored today**, one line per ring: target, device, size,
   filesystem. Read it from `shell.json` and `findmnt`, never from memory.
2. **Confirm which one to remove** before editing anything. If two targets sit on
   one partition (btrfs subvolumes), say so and ask whether both go.
3. **Remove that target from `mounts` only.** Change nothing else in the entry and
   nothing else in `shell.json`. Removing a monitor is a bar setting, not a disk
   operation: never delete the partition, never delete data on it, never unmount
   it, never format it. If the captain wants the drive unmounted, wiped, or
   retired, that is a separate ask with its own confirmation.
4. **Record the decline** in the state file's `decisions` under that partition's
   `key`, as `declined`. Merge into the existing map, never replace it. Without
   this the next scan offers the same partition straight back.
5. **Apply it**: `omarchy restart shell`, then confirm the ring is gone and the
   remaining rings are untouched.

## Report shape

- What was monitored, what you removed, what you recorded as declined.
- Say outright that nothing on the partition was touched: only the ring is gone.
- If the mount is still mounted, say the drive is still there and still usable.
