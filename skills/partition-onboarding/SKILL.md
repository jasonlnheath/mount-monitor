---
name: partition-onboarding
description: Mount Monitor partition onboarding - list the disk partitions that have no usage ring, ask the captain which to monitor, and wire the picks into the bar plugin's mounts setting. Use when Mount Monitor notifies that partitions were found or that a new partition appeared, when asked to add, start monitoring, or watch a partition or drive, or before wiring a new disk into the bar. Report first, wire only what the captain picks - never format, mount, or delete anything on its own.
---

# Partition onboarding

Goal: turn "N partitions found" into watched mounts. Report every candidate with
its size and filesystem, ask which to monitor, then wire the picks. Never pick
for the captain.

## Inputs

- **The scan the widget already ran**: `~/.local/state/mount-monitor/onboarding.json`.
  `candidates` is the list, each with `key`, `target`, `path`, `fstype`, `size`,
  `label`, `removable`, `monitored`. `decisions` is what has already been offered,
  declined, or accepted. Read this first.
- **If that file is missing or unreadable**, scan directly:
  `lsblk -P -o NAME,PATH,TYPE,FSTYPE,MOUNTPOINT,SIZE,LABEL,PARTLABEL,PARTUUID,UUID,RM`
  Keep a row only when TYPE is `part`, `disk`, or a mounted `crypt` (the
  decrypted LUKS volume - on a LUKS install that is the root, while its
  `crypto_LUKS` container partition carries no MOUNTPOINT), FSTYPE is set and
  not `swap`, MOUNTPOINT is set, and the device sits under `/dev/`. That drops
  swap, snap's loop images, optical drives, unformatted slices, and every pseudo
  filesystem - they are not block devices, so lsblk never lists them.
- **What is already watched**: the `mounts` array on the
  `io.github.jasonlnheath.mount-monitor` entry in `~/.config/omarchy/shell.json`.

## Procedure

1. **Read the state file, then `shell.json`.** Skip anything already monitored,
   already offered, or already declined. Do not re-ask a answered question.
2. **Watch for the same drive twice.** `/` and `/var/log` can be one btrfs
   partition mounted twice. Compare each candidate's `path` against the `SOURCE`
   of every monitored mount (`findmnt -rn -o SOURCE,TARGET`). A second mount of a
   watched partition gets no ring and is not offered.
3. **Report one line per candidate**, then ask:
   `<target> · <size> · <fstype> · <label> · fixed|removable`
   Name the ones already monitored or already declined instead of hiding them.
4. **Ask which to monitor. Wait for the answer.** Never assume the obvious drive.
5. **Wire the picks.** Edit only the `mounts` array of the widget entry in
   `~/.config/omarchy/shell.json`, in the order the captain wants the rings to
   appear. Leave every other key in that entry (`agentCommand`, `testPct`) intact,
   and leave the rest of `shell.json` alone.
6. **An unmounted partition cannot have a ring.** Say so. Mount it - `udisksctl
   mount` or an fstab entry - only if the captain says to, then wire it.
7. **Record the choices** in the state file's `decisions`, keyed by the
   candidate's `key` (PARTUUID, else UUID, else device path): accepted goes
   `monitored`, refused goes `declined`. Merge into the existing map, never
   replace it. This is what stops the plugin asking again.
8. **Apply it**: `omarchy restart shell`, then confirm a ring appeared for each
   pick and nothing else on the bar changed.

## Report shape

- One line per partition, then the question.
- Sizes exactly as lsblk prints them. No invented numbers.
- Close with what you wired and what you recorded as declined.
- Removable drives are called removable: they are legitimate long-term and backup
  storage, not noise.
