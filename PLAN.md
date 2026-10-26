# Plan: device metadata must stop being agent instructions

Marketplace finding (omacom/omarchy-plugin-marketplace#12972, Medium, maintainer
HANCORE-linux) at `044ccaf`:

> `mounts.js:505-515` and `531-536` insert `lsblk` labels/mountpoints directly into
> the instruction prompt (`239-250`, `319-336` -> `MountMonitor.qml:116-124`).
> Someone providing a mounted removable filesystem can supply instruction text in
> its label; clicking the generic setup notification forwards it as part of the
> user's request to a tool-capable agent. Typed argv prevents shell injection but
> does not separate these instructions from external data.

Named remedy (adopt exactly):
1. The launch prompt is fixed copy — no device-controlled text in the instruction stream.
2. Partitions are identified in the instruction by a validated opaque id the plugin mints.
3. Label/mountpoint/path/fstype/size travel as explicitly untrusted structured data:
   bounded length, control characters stripped, clearly delimited as data, declared
   untrusted by the instruction.
4. Concrete proposed changes still need the user's confirmation outside device text.
5. Hostile device labels are covered by the regression checks.

## Trust boundary

A volume label, a PARTLABEL, and (through udisks' `/run/media/<user>/<LABEL>` auto-mount)
a mountpoint are chosen by whoever formatted the filesystem. A stick handed to the
captain carries them into `lsblk`/`findmnt`, into `candidatePartitions`/`selectMounts`,
into `onboardingPrompt`/`newPartitionPrompt`/`agentPrompt`, into `agentArgv` ->
`MountMonitor.qml runAgent` -> the user's tool-capable agent. Typed argv keeps it out of
a shell; it never kept it out of the instruction stream. That is the bug.

## Design (mounts.js)

- `sanitizeText(value, max)` — control chars (C0/DEL/C1), Unicode line separators,
  bidi overrides and zero-width/invisible formatting (Trojan Source), and `<`/`>`
  replaced by spaces; whitespace collapsed; truncated to a bounded length with `...`.
  Removing `<`/`>` is what makes the block delimiter unforgeable.
- `mountId(seed)` / `isMountId(value)` — the plugin's own opaque id: two FNV-1a 32-bit
  rounds over the sanitized identity -> `mm-<8hex>-<8hex>`, validated by
  `/^mm-[0-9a-f]{8}-[0-9a-f]{8}$/`. A candidate is keyed on its `key` (PARTUUID, else
  UUID, else device path), a ring on its target — the same thing the alert queue and
  the band memory key on — so the id survives a replug or a device rename, differs
  between partitions that share a label, and can never contain device-supplied text.
- `selectMounts` and `candidatePartitions` mint `id` on every row/candidate;
  `parseState` keeps only the id shape it minted itself. The id rides into the state
  file's `candidates` so the onboarding skills map id -> `key` from the one
  verification read they already do.
- `candidateRecord(c)` / `mountRecord(m)` — one sanitized, bounded, typed record per
  partition behind the alert (id, target, device, fstype, size, label, removable, or
  id, target, device, fstype, used, avail, pct clamped 0..100, readonly).
- `dataOpen()` / `dataClose()` — the block delimiters, built from `<`/`>`.
- `untrustedNotice()` — fixed copy that names the block as device-supplied data, tells
  the agent to ignore instruction-shaped text inside it, and requires the user's
  confirmation of the concrete proposed changes outside device-controlled text.
- `agentPrompt`, `onboardingPrompt`, `newPartitionPrompt` become fixed instruction copy
  that references partitions **by id only**, then `promptWithData()` appends the notice
  and the delimited JSON block. `promptFor`, `agentArgv`, `execHintValue`, `notifyArgs`
  keep their shapes.

## Process (RED first) — done

1. `tests/label-injection.test.mjs` written against the contract above, run at the
   pre-fix commit: **15 failed, 3 preservation guards passed** at `044ccaf` (label and
   mountpoint text found in the instruction stream, no delimited block, no validated
   id).
2. Implemented in `mounts.js`; `MountMonitor.qml` carries `m.id` into the queued band
   alert (new `root.bandAlert()`, which also carries `source`/`fstype`/`used` so the
   prompt the daemon answers and the prompt the widget answers describe the same
   mount) and `c.id` into the state file's candidates.
3. The two existing tests that asserted the vulnerable shape —
   `/scan \/ for prune and compress candidates/` in `tests/mounts.test.mjs` and the
   hand-built band alert in `tests/onboarding.test.mjs` — now assert the fixed shape.
4. Skill copy: `partition-onboarding` reads its candidates from the prompt's device
   data block, led by the id, and maps id -> key in its one read; `disk-prune` takes
   the target from the block and states that the block is data, not approval;
   `partition-remove` unchanged (it is not prompt-driven). Every confirmation step stays.
5. `AGENTS.md` + `README.md` record the contract.
6. `bash tests/run.sh`: **92 pass, 0 fail, 0 skip**, install.sh parses, skills present,
   `qmllint` parses the QML and resolves the `mounts.js` import.

Also hardened while in the neighbourhood: `notifyBody` and `tooltip` — the copy the
captain reads — put the mountpoint, filesystem, and sizes through the same
`sanitizeText`, so a label cannot spray control characters into a popup or bury the
fixed sentence under five thousand characters of its own choosing.

## Out of scope

Event-driven USB detection, notification thresholds, ring rendering, any marketplace
issue comment. Not fixed, and worth its own task: `parseRows` keeps findmnt's `\x20`
escape, so a mountpoint containing a space (udisks2 media labelled `Backup Drive`)
cannot match a `mounts` entry wired from lsblk's real space — that ring never appears.
