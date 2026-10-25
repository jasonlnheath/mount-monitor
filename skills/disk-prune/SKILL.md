---
name: disk-prune
description: Mount Monitor cleanup pass - scan a filesystem for prune/compress candidates and report ranked suggestions with sizes. Use when Mount Monitor alerts that a mount crossed 80/90/98%, when asked what can be pruned, compressed, or freed on a drive, or before a disk fills. On a read-only mount, report only what can be moved off it. Read-only analysis - never delete or compress anything without the captain's explicit word.
---

# Disk prune scan

Goal: a ranked, sized list of what can be pruned or compressed on the target
mount, delivered plainly so the captain can say yes/no per line. The scan is
READ-ONLY. No deletion, no compression, no package cleanup runs happen here.

## Inputs

- Target mount (default `/`; the alert text names it). For non-root mounts,
  scan the mount path only.
- Whether that mount is mounted read-only: `findmnt -no OPTIONS <mount>` prints
  its options with `ro` or `rw` first. A read-only mount (a Windows NTFS
  partition mounted `ro`, a mounted ISO, a backup share) is handled under
  **Read-only mounts** below and never gets prune or compress suggestions.

## Procedure

1. **Overview first**: `df -h <mount>` and, for btrfs, note allocation vs
   visible usage divergence (snapshots pin deleted data - mention if present,
   do not act).
2. **Known cache lanes** (fast wins, sorted by size):
   - Package cache: `du -sh /var/cache/pacman/pkg` (suggest `paccache -rk1`
     as the action, list reclaimable size).
   - System journal: `journalctl --disk-usage` (suggest vacuum to 500M).
   - `~/.cache` top offenders (`du -sh ~/.cache/* | sort -h | tail -10`).
   - Language/tool caches: uv, pip, npm, cargo, playwright browsers, Gradle,
     Docker images/volumes (`docker system df` if the daemon runs).
   - `/tmp` files older than 7 days; `coredumpctl list` bulk.
3. **Large-file sweep**: files over 1G on the mount
   (`find <mount> -xdev -type f -size +1G -printf '%s %p\n' | sort -n`),
   top 15 by size. Flag: media (move candidate), VM/emulator images (in active
   use? ask, don't assume), model weights (cold? cold-storage candidate),
   archives (already-compressed: move, don't re-compress).
4. **Compress candidates**: directories that are large AND compressible
   (logs, text dumps, evidence trees) - suggest `tar + zstd` with an estimated
   ratio; never compress already-compressed media/model files.
5. **Cold-storage candidates**: anything unused >30 days that a server or
   slow tier can hold; name the destination tier if one is known.

## Read-only mounts

When the target is mounted `ro`, say it plainly in the first line: nothing on
this mount can be pruned, compressed, or deleted from this machine, so there are
no prune candidates to report. Do not run the cache lanes (they live on the
host's own filesystems, not on this mount) and do not suggest `paccache`,
journal vacuum, or compression here. Report instead:

1. **What is on it**: `du -sh <mount>/*` and the large-file sweep from step 3,
   so the captain can see where the space actually goes.
2. **Move-off candidates**: the same ranked list, with the action always *move*
   (or *delete from the machine that owns it*), a destination tier named when
   one is known, and a note on what is in active use (model weights a local
   server is still loading are not movable without saying so).
3. **What only the owning machine can do**: cleanup on the other OS, its own
   snapshots, its own recycle bin - name it as the only route to freeing space
   in place, and leave it as the captain's call.

## Report shape (captain-facing, plain language)

- One line per candidate: what it is, size, recommended action (prune /
   compress / move), risk note if any. On a read-only mount every action is
   `move` and the first line states that nothing can be pruned there.
- Totals: reclaimable now vs after moves.
- Top 3 recommendations first, then the long tail.
- Never execute; end with the ask for which lines to act on.
