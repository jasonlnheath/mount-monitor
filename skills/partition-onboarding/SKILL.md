---
name: partition-onboarding
description: Mount Monitor partition onboarding - present the disk partitions the click prompt already lists, ask the captain which to monitor, and wire the picks into the bar plugin's mounts setting. Use when Mount Monitor notifies that partitions were found or that a new partition appeared, when asked to add, start monitoring, or watch a partition or drive, or before wiring a new disk into the bar. Report first, wire only what the captain picks - never format, mount, or delete anything on its own.
---

# Partition onboarding

Goal: turn "3 watched, 2 need a decision" into watched mounts. The click that
opened this skill already carried how many partitions are already behind a ring
and every waiting candidate with its target, filesystem, size, label (or the
device path when there is no label), and whether it is removable.
Present them, ask, wire the picks. Never re-derive what
the prompt already told you: a live run that rescans the disk table spends
minutes reproducing a list that is already on screen.

## Present first

1. **Put the candidates on screen immediately, from the prompt.** Lead with the
   two counts the notice reported - watched, and waiting for a decision - then
   one line per waiting candidate:
   `<target> · <size> · <fstype> · <label, or the device path when there is no label> · fixed|removable`
   Nothing is read or run before this. The question is the point of the notice;
   everything else is detail you fetch afterwards. Never report the waiting count
   as "N partitions found": the watched ones exist, the bar already shows them.
2. **Ask which to monitor. Wait for the answer.** Never assume the obvious drive.

## The one verification read

Read `~/.local/state/mount-monitor/onboarding.json` once - after the list is on
screen, before wiring anything. It carries the same candidates with `key`
(PARTUUID, else UUID, else device path), `monitored`, and `decisions` (offered /
declined / monitored), so this single read is where the keys come from, what is
already behind a ring, and what the captain already answered. Do not re-ask an
answered question: name the already-monitored and already-declined partitions
instead of hiding them.

That is the entire verification budget - one read. **Never run `lsblk`, never run
`findmnt`, never re-derive the candidate filter when the prompt carries the
list.** The widget ran the scan, its filter is the authority, and a second scan
disagrees with the bar the captain is looking at.

## Wire it

3. **Wire the picks.** Edit only the `mounts` array of the
   `io.github.jasonlnheath.mount-monitor` entry in `~/.config/omarchy/shell.json`,
   in the order the captain wants the rings to appear. Leave every other key in
   that entry (`agentCommand`, `onboarding`, `testPct`) intact, and leave the rest
   of `shell.json` alone.
4. **An unmounted partition cannot have a ring.** Say so. Mount it - `udisksctl
   mount` or an fstab entry - only if the captain says to, then wire it.
5. **Record the choices** in the state file's `decisions`, keyed by the
   candidate's `key`: accepted goes `monitored`, refused goes `declined`. Merge
   into the existing map, never replace it. This is what stops the plugin asking
   again.
6. **Apply it**: `omarchy restart shell`, then confirm a ring appeared for each
   pick and nothing else on the bar changed.

## Only when the prompt carries no list

If the notice carried no candidates, or the state file is missing or unreadable,
scan directly:

`lsblk -P -o NAME,PATH,TYPE,FSTYPE,MOUNTPOINT,SIZE,LABEL,PARTLABEL,PARTUUID,UUID,RM`

Keep a row only when TYPE is `part`, `disk`, or a mounted `crypt` (the decrypted
LUKS volume - on a LUKS install that is the root, while its `crypto_LUKS`
container partition carries no MOUNTPOINT), FSTYPE is set and not `swap`,
MOUNTPOINT is set, the device sits under `/dev/`, and the row is not a boot slice
(a vfat under 1G, or one labelled exactly `efi`, `esp`, or `boot`, or mounted at
`/efi` or under `/boot/`). That drops swap, snap's loop images, optical drives,
unformatted slices, every pseudo filesystem - they are not block devices, so
lsblk never lists them - and the EFI partition that is noise next to real
drives. Then present the list and continue at step 2.

## Report shape

- One line per partition, then the question.
- Sizes exactly as lsblk prints them. No invented numbers.
- Close with what you wired and what you recorded as declined.
- Removable drives are called removable: they are legitimate long-term and backup
  storage, not noise.
