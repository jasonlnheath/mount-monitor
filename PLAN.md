# Plan: a mount point containing a space must get its ring

Deferred by the device-metadata hardening pass (PR #8, `f787f3f`), which named it
in its own "out of scope":

> Not fixed, and worth its own task: `parseRows` keeps findmnt's `\x20` escape, so
> a mountpoint containing a space (udisks2 media labelled `Backup Drive`) cannot
> match a `mounts` entry wired from lsblk's real space — that ring never appears.

## Reproduced before touching anything

Verified on this rig inside a user+mount namespace (`unshare -rm`, bind-mount
`/mnt/models` at `/tmp/my stick`, so a real block device carries a spaced
mountpoint into both tools):

- `/proc/self/mountinfo` escapes the space as octal: `/tmp/my\040stick`.
- `findmnt -rn -o SOURCE,TARGET,...` escapes it hex, and escapes **every** byte
  outside printable ASCII: `/tmp/my\x20stick`, a tab as `\x09`, a backslash as
  `\x5c`, a non-ASCII name as `/tmp/uni-\xc3\xa9\xc3\xa8`. `--raw` and `--nofsroot`
  do not change that: the escaping is what keeps findmnt's columns separable.
- `lsblk -P -o ...,MOUNTPOINT,...` on the same device prints the space **literally
  inside the quotes**: `MOUNTPOINT="/tmp/my stick"`, and `parseLsblkPairs` already
  undoes lsblk's escapes.

So the two halves of the same mount arrive in two different spellings, and the
configured `mounts` entry (wired from lsblk's real path by `partition-onboarding`)
spells it the lsblk way.

## Root cause (one place)

`mounts.js parseRows()` splits each findmnt line on `/\s+/` — which is *safe*,
because findmnt escapes every whitespace byte — but then keeps the escaped token
as the row's `target`. `selectMounts()` then looks up `byTarget[wanted[j]]` with
the configured `/mnt/my stick` against a row keyed `/mnt/my\x20stick`: no match,
no ring, no alert, no tooltip, and the mount is invisible to
`monitoredDevices()` as well.

## Fix (minimal)

`mounts.js`: undo findmnt's escaping where the row is built, not where it is
compared.

- `unescapeFindmnt(text)` — turn each `\xNN` back into its byte, and decode a run
  of escaped bytes as UTF-8, so `/mnt/Données` matches the configured entry
  instead of arriving as mojibake. A pure-JS `utf8Decode()` helper: no
  `TextDecoder`, because `mounts.js` also runs inside QML's `QJSEngine`, which
  does not have it.
- `parseRows()` applies it to the text columns (`SOURCE`, `TARGET`, `FSTYPE`,
  `USED`, `AVAIL`, `OPTIONS`) after the split. The split stays on whitespace:
  escaping guarantees no column can contain a literal space.
- Nothing else changes shape: `selectMounts`, `mountId`, the band memory, the
  alert queue, and the prompt copy all keep working on `row.target`, which is now
  the real path.

## Ripples, named and checked

- **Ring + id** (`selectMounts`): the ring appears; `m.id = mountId(m.target)` is
  minted from the real target. Ids for already-working mounts do not change (their
  targets were never escaped).
- **Band memory and alerts** (`MountMonitor.qml checkBands`, `root.bands[target]`,
  `bandOf`, the alert queue's `target` dedup): keyed on the same `target`, so a
  spaced mount now crosses bands like any other. No QML change needed — verified by
  reading it.
- **Onboarding matching** (`annotateCandidates` / `monitoredCount` /
  `newCandidates`): a candidate's `target` comes from lsblk (real space) and is
  compared with the configured `wanted` list (real space) — that half already
  matched. What was broken is the *other* half: `monitoredDevices(root.mounts)` had
  no ring for the spaced mount, so its device was not watched and its other mounts
  could be offered as unmonitored. Fixing `parseRows` fixes that too.
- **New-partition notice** (`newPartitionBody`/`Prompt`, `candidateAlive`): keyed on
  `key` (PARTUUID/UUID/device), not the target — untouched.
- **`isBootSlice`**: compares `mountpoint` against `/efi` and `/boot/…` — unaffected
  (a spaced mountpoint is not a boot slice).
- **State file** (`serializeState`/`parseState`): JSON, spaces are ordinary
  characters — unaffected.
- **Popups** (`notifyBody`, `tooltip`): now print `/mnt/my stick` instead of
  `/mnt/my\x20stick`; both already run the target through `sanitizeText`, which
  keeps an ordinary space.
- **`partition-remove` skill**: its own matching step reads
  `findmnt -rn -o SOURCE,TARGET,...` and compares it to the `mounts` entry — the
  same two spellings, on the agent side. Skill copy now says the findmnt column is
  escaped and the `mounts` entry is not, and that a target is one string whatever
  it contains.
- **`disk-prune` skill**: its commands interpolate `<mount>` (`df -h <mount>`,
  `du -sh <mount>/*`, `find <mount> -xdev …`), which breaks on a path with a
  space. Skill copy now quotes it.
- **`partition-onboarding` skill**: wires lsblk's real targets into `mounts` —
  already correct; copy adds "one entry per mountpoint, spaces included".
- **Label-injection contract**: unchanged. Decoding happens in `parseRows`, before
  `sanitizeText`, and every device string still leaves through
  `mountRecord`/`candidateRecord` as declared data. findmnt never escapes a
  printable `<` or `>`, so decoding cannot mint a delimiter `sanitizeText` would
  not already have removed. `tests/label-injection.test.mjs` stays green; its
  hostile findmnt row now spells the *configured* side the way a real config does
  (real spaces) and the *findmnt* side the way findmnt does (`\x20`), which is the
  shape this bug was.

## Process (RED first) — done

1. `tests/spaced-mountpoint.test.mjs` written against the contract above and run at
   the pre-fix commit `f787f3f`: **11 failed, 5 passed** (the guards that were
   already true, and the counterexample test that records the old behaviour: the
   configured stick reported as a partition needing a decision).
2. Fixed in `mounts.js`: `unescapeFindmnt()` + `utf8Decode()`, applied to the text
   columns in `parseRows()` after the whitespace split. No QML change: the widget
   never renders or compares a target itself, it only keys its band memory on
   `m.target`.
3. Fixture: `tests/fixtures/findmnt-rig.txt` grew the row for the exfat stick the
   lsblk fixture already carries, in findmnt's escaped spelling.
4. `tests/label-injection.test.mjs` now spells the hostile mount the way a real rig
   does — the configured entry with its real spaces, the findmnt row with `\x20` —
   and asserts the ring still matches. Its popup test compares the **fixed sentence**
   against an ordinary mountpoint instead of asserting the hostile words are absent
   from a body that legitimately prints the mountpoint.
5. Skill copy: `partition-remove` (findmnt's column is escaped, the `mounts` entry is
   not, one entry is one mountpoint), `disk-prune` (every `<mount>` quoted),
   `partition-onboarding` (wire the block's target verbatim, spaces included).
6. `AGENTS.md` records the escaping rule; `README.md` says a `mounts` entry is the
   mountpoint as it is.
7. `bash tests/run.sh`: **114 pass, 0 fail, 0 skip**, install.sh parses, skills
   present, `qmllint` parses the QML and resolves the `mounts.js` import.

## Out of scope

Event-driven USB detection, any marketplace posting, thresholds and ring visuals,
and accepting a `mounts` entry hand-written in findmnt's escaped spelling — the
configured side stays the real path, because `partition-onboarding` wires it from
lsblk.
