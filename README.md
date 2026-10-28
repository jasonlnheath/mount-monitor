# Mount Monitor

<p align="center"><img src="logo.svg" width="220" alt="Mount Monitor MM mark"></p>

A simple visualizer of disk usage that monitors when space gets too high, on
any disk mount you configure (btrfs, NTFS, ext4, ...). At 98% or above it
throws a notification and glows red. Notifications are configured to go to your
agent of choice with a skill that suggests files to prune / compress, or what
to move off a read-only mount. It also finds the partitions on your machine and
asks which ones you want watched.

![Mount Monitor in the Omarchy bar](bar-screenshot.png)

An [Omarchy](https://omarchy.org) bar plugin. One monochrome usage ring per
mount you configure, on any filesystem sitting on a real device — btrfs, NTFS,
ext4, vfat, including a partition mounted read-only: the percent sits inside
the circle, the solid arc is what's used, the faint ring behind it is what's
available. Hover any ring for the mount name, filesystem, exact numbers, and
whether it is read-only.

## Behavior

- Under 80%: calm monochrome ring, percent inside.
- 80% and again at 90%: desktop notification, ring and percent embolden.
- 98% and above: vibrant red ring that pulses (glows) at 0.5 Hz, critical
  notification that stays until dismissed.
- Click a disk alert and Mount Monitor sends a cleanup prompt to your
  agent of choice, which runs the included `disk-prune` skill: a read-only
  scan that reports ranked prune/compress candidates with sizes. Nothing is
  ever deleted automatically.
- A mount that is read-only (a Windows NTFS partition mounted `ro`, a mounted
  ISO) is alerted about on the same 80/90/98 thresholds, but its alert and its
  agent prompt say so up front and ask what to **move off** it instead: nothing
  can be pruned or compressed on a read-only mount, and the plugin does not
  pretend otherwise.
- First run scans your partitions, and the notice reports both counts — how many
  are already watched and how many still need a decision (`3 watched, 2 need a
  decision.`), never one bare number. Nothing waiting reads `All 4 watched.
  Nothing to decide.` Clicking it hands your agent the waiting list — size,
  filesystem, label, fixed or removable — plus the count already behind a ring,
  to ask which to monitor and wire into `mounts`. A drive that shows up later
  (a new partition, a USB stick you mounted for backup) gets one dismissable
  notice — `Detected new drive. Click now to set up disk monitoring.` — once,
  and clicking it hands your agent that drive's specifics. The plugin never
  decides for you whether to monitor it, pool it, or leave it alone. What has
  been offered, declined, or accepted is remembered, so the same partition is
  never offered twice. Set `"onboarding": false` on the entry to skip the scan
  and its notices.

Disk alerts go one at a time, so the one on screen stays clickable, and a
queued alert is only dropped when the reading behind it stops holding — the
mount went away or its usage fell back below the band it was queued for. A
disk alert left unanswered is dismissed after two minutes so the queue keeps
moving. A mount that is already in a band when the shell starts or reloads is
not re-notified until it crosses again; 98% and above always notifies.
Onboarding and new-drive notices are different: they stay up until you read,
act on, or dismiss them, and a dismissed one remains reachable in Omarchy's
notification history. They ride their own lane too, so a notice and a disk
alert can be on screen at once — a full drive is never made to wait behind a
question.

A plugged drive is noticed in seconds, not on the next sweep: the widget keeps
`udevadm monitor --kernel --subsystem-match=block` open for the life of the shell
and rescans when a block device appears, changes, or goes away. One plug is a burst of kernel lines, so they coalesce into a single rescan, and a second rescan
follows it because the automount lands just after the last event. The 60-second
sweep stays as the fallback — without `udevadm`, or if the monitor will not stay
up, detection is the sweep again and nothing else about the widget changes. Set
`"detectEvents": false` on the entry to skip the monitor. Rings refresh on that
path and only mounts you configure are shown. A
configured mount that is not currently mounted simply has no ring. Virtual
filesystems — tmpfs, proc, sysfs, cgroup2, overlay, and anything else without a
device behind it — never draw a ring, even when configured.

## Street View wallpaper — free forever, enforced

The plugin also ships an optional wallpaper service that rotates a Google Street
View panorama onto your desktop, and it is built around one rule: **the wallpaper
never sends a billable request unless the month's meter says there is free
headroom.** No credit card, no surprise bill — when the cap is reached the
request is never even built; your desktop keeps the last cached image (or your
own wallpaper, before the first fetch), and a warning notice offers the two
options: stay capped, or unlock paid usage at your own risk.

How the free tier is guaranteed:

- **Two meters, one gate.** A monthly meter guards the free tier itself
  (10,000 free loads/month, then Google bills $7 per 1,000) and a daily meter
  guards the day, defaulting ON at 100/day so cautious users are hard-limited
  out of the box. A fetch needs headroom in both; when either is spent, the
  next tick builds nothing at all.
- **The free metadata endpoint gates every load.** Before any billable image
  fetch, the always-free, unlimited metadata endpoint is asked whether the
  location has coverage at all. No coverage costs nothing — the rotation just
  moves to the next location.
- **Count before send.** The meter records the load before the request goes
  out, so a failed download never under-counts. The meter survives restarts
  and resets on the calendar (a suspend across midnight or month's end cannot
  leak last period's budget); a clock that cannot be read is treated as "no
  headroom", never as free.

What you see:

- While the feature is on, a small indicator sits beside your rings. Hover it
  for `3,214 / 10,000 free loads (32% this month) · 12/100 today`; click for a
  usage popup. No key, no indicator.
- When a cap is hit, a persistent warning names the number and offers the two
  options. Clicking it sends your agent the `streetview-wallpaper` skill, which
  reports the usage and applies only the option you pick.

To turn it on, set your own API key ([enable the Street View Static API for the
key in Google Cloud console](https://console.cloud.google.com/apis/library/streetview-backend.googleapis.com))
and optionally tune the caps:

```json
{ "id": "io.github.jasonlnheath.mount-monitor", "streetviewKey": "AIza..." }
```

The key stays in your `shell.json`; it is never committed, never logged, and
never appears in a notification or an agent prompt. The free-tier guarantee
holds for your key because the gate consults only the meter.

Fetch locations rotate through `streetviewLocations` (default: a built-in list
of famous landmarks) with a different heading each pass, and the wallpaper
changes on `streetviewIntervalMinutes`. Manual controls:
`omarchy-shell io.github.jasonlnheath.mount-monitor status` (usage popup) and
`... next` (one fetch cycle now — still through the meter; a click is not a
loophole).

## What a clicked alert sends your agent

The prompt is fixed copy written in this plugin, and it is the same sentence for
every device of a kind: it names the mount or partition by an id Mount Monitor
mints itself (`mm-` plus 16 hex digits, derived from the partition's PARTUUID or
UUID, or the mount's target) and asks the matching skill to do its job.

Everything a device calls itself — mountpoint, device path, filesystem, size, and
the volume or partition label, which is text whoever formatted the drive wrote —
travels in a delimited **device data block** that the prompt declares untrusted
data, never instructions. Control characters, invisible and bidirectional
formatting, and the block's own delimiters are stripped out of those strings, and
every string is length-bounded, so a drive cannot bury the fixed copy or close the
block and speak outside it. A filesystem handed to you cannot put an instruction
into your agent's ask by wearing one as a label.

Nothing in that block counts as your approval either: the skills report and ask,
and only you say what gets wired, pruned, compressed, or removed.

## Requirements

Omarchy Quattro (Quickshell) with third-party `schemaVersion: 1` bar widgets,
`findmnt` and `lsblk` from util-linux to read the mounts and the partition
table, `notify-send` from libnotify for the alerts, and `udevadm` from systemd to
notice a plugged drive right away. Without `notify-send` the rings still draw,
nothing alerts. Without `lsblk` the rings still draw, no onboarding notices.
Without `udevadm` the rings still draw and still alert — detection just falls back
to the 60-second sweep. The Street View wallpaper additionally uses `curl` and
the `omarchy-theme-bg-set` command Omarchy ships; without them it stays
off-screen and sends nothing.

## Install

```bash
git clone https://github.com/jasonlnheath/mount-monitor \
  ~/.config/omarchy/plugins/io.github.jasonlnheath.mount-monitor
~/.config/omarchy/plugins/io.github.jasonlnheath.mount-monitor/install.sh
omarchy restart shell
```

`install.sh` copies the skills in `skills/` — `disk-prune`,
`partition-onboarding`, `partition-remove`, `streetview-wallpaper` — into
`~/.agents/skills/` and prints the bar wiring line. `omarchy plugin add
https://github.com/jasonlnheath/mount-monitor --enable` also installs and
enables the widget and manages updates for you, but it does not run
`install.sh` and does not install the skills — without also running
`install.sh` (or copying `skills/` into `~/.agents/skills/` yourself),
notifications still appear but clicking them sends your agent a prompt it has no
skill to run.

Then add it to the right side of your bar in `~/.config/omarchy/shell.json`:

```json
{ "id": "io.github.jasonlnheath.mount-monitor" }
```

## Remove

```bash
omarchy plugin remove io.github.jasonlnheath.mount-monitor
```

If you installed by cloning, delete the plugin folder, the skills, and the
onboarding state, drop the widget entry from `shell.json`, and restart the
shell:

```bash
rm -rf ~/.config/omarchy/plugins/io.github.jasonlnheath.mount-monitor \
  ~/.agents/skills/disk-prune ~/.agents/skills/partition-onboarding ~/.agents/skills/partition-remove \
  ~/.agents/skills/streetview-wallpaper \
  ~/.local/state/mount-monitor
omarchy restart shell
```

Mount Monitor writes nothing outside those folders, your `shell.json`, and its
state directory `~/.local/state/mount-monitor/`: the onboarding state file
(`onboarding.json` — the list of partitions it found and what you decided about
each one), the wallpaper's `streetview-meter.json` (the two usage counters),
`streetview-cap.json` (which cap warnings have fired), and the `streetview/`
cache holding the current wallpaper image. Delete a file and restart the shell
to reset that part: the onboarding file re-runs the first-run notice, the meter
file re-arms the full free tier (it counts loads Google may already have billed
for — delete it honestly), the cap file lets the cap warning fire again.

## Configuration

All settings live on the widget's entry in `shell.json`:

```json
{
  "id": "io.github.jasonlnheath.mount-monitor",
  "mounts": ["/", "/srv/models", "/mnt/models"],
  "agentCommand": ["/path/to/your/agent/inbox", "note"]
}
```

- `mounts` — which mounts get rings, in the order their rings appear. Any
  fixed, block-device-backed mount counts, not only btrfs: a second internal
  drive, an external disk, or a Windows partition mounted read-only at
  `/mnt/models`. Write each one as the mountpoint itself, spaces included —
  `"/mnt/my stick"` is one entry (what `lsblk` and the onboarding skill give
  you), not findmnt's escaped column (`/mnt/my\x20stick`). Default: `["/"]`
  (root only). An explicitly empty list means no rings. Tell your agent to add
  or remove entries here whenever you want a drive watched — that is what the
  `partition-onboarding` and `partition-remove` skills do.
- `onboarding` — `true` unless you set it to `false`. With it on, the widget
  scans the partition table with `lsblk`, notifies on first run, and notifies
  once for each partition that appears later. With it off it draws only the
  rings you configured and says nothing about the rest of your disks.
- `detectEvents` — `true` unless you set it to `false`. With it on the widget runs
  `udevadm monitor` as a long-running child process, so a plugged drive or a newly
  mounted partition gets its notice in seconds instead of on the next 60-second
  sweep, and a drive you pulled has its waiting notice withdrawn in seconds too.
  With it off the sweep is the only detection path.
- `agentCommand` — the command that receives the cleanup prompt when you
  click a notification. It is an argument list run directly, not a shell
  line, and the prompt is appended as the last argument. Default when unset:
  `omarchy agent prompt <prompt>`, which opens your default Omarchy agent in
  a terminal with the cleanup request. Point it at whatever your agent
  listens on — an inbox script, a CLI, a webhook. Every notification kind
  rides this same path: a disk alert and a partition notice differ in the
  prompt, not the plumbing.
- `streetview` — `true` unless you set it to `false`: the wallpaper service.
  Inert until `streetviewKey` is set, so on it costs nothing by default.
- `streetviewKey` — your own Google API key with the Street View Static API
  enabled. Never committed, never logged, never echoed into a prompt or a
  notification.
- `streetviewCapPerDay` — the daily cap, **ON by default at 100** (the
  paranoid default). A fetch needs headroom in the daily and the monthly
  meter both. `0` pauses the wallpaper entirely; `-1` removes the daily
  limit (the monthly cap still applies). Anything else unusable falls back
  to 100, never to unlimited.
- `streetviewMonthlyCap` — the monthly cap, default `10000`: Google's free
  ceiling, hard. Setting it **above 10,000** is the explicit paid unlock —
  overage is $7 per 1,000 loads, your billing, your risk. Zero, negative, or
  garbage falls back to the free ceiling.
- `streetviewIntervalMinutes` — how often the wallpaper may change. Default
  `30`, floored at 5.
- `streetviewSize` — requested image size as `"<w>x<h>"`, default
  `"1920x1080"`.
- `streetviewLocations` — the rotation, in addresses or `lat,lng`. Default:
  a built-in list of famous landmarks.

The wallpaper's state lives beside the onboarding state:
`~/.local/state/mount-monitor/streetview-meter.json` (the counters, which the
service writes and nothing else does) and `streetview-cap.json` (which cap
warnings have fired). Delete the meter file while the shell is stopped to
re-arm the free tier — honestly, that is: the counters exist so the plugin can
keep its promise to you; deleting them cannot un-bill what Google already
counted on your key.

## Skills

Everything a clicked notification asks for lives in `skills/`, agent-agnostic
`SKILL.md` files. Copy them wherever your agent loads skills from.

- **`disk-prune`** — how to scan a mount for prune/compress candidates (package
  caches, journals, tool caches, 1G+ files, compressible trees, cold-storage
  moves) and report them ranked, sized, and read-only. On a read-only mount it
  reports the opposite instead: plainly that nothing there can be pruned or
  compressed, what the space is actually taken up by, and ranked candidates to
  move off to another drive.
- **`partition-onboarding`** — how to report the partitions that have no ring,
  ask which to monitor, and wire the picks into `mounts`, recording each answer
  so the question is not asked twice. Removable drives count: plenty of people
  keep backups and long-term storage on them.
- **`partition-remove`** — how to take a mount off the bar and record it as
  declined so it is not offered again. It changes the `mounts` setting only:
  never deletes data, never unmounts, never formats.
- **`streetview-wallpaper`** — how to report the wallpaper's usage from the
  meter, present the two options on a cap warning (stay capped, or unlock
  paid usage), and apply cap changes the captain asks for. It edits the
  wallpaper settings only: never the meter's counters, never the key, and it
  never sends a request to Google itself.

## Development

The mount filter, the 80/90/98 bands, the alert text, the partition onboarding
decisions, and the block-event detection timings live in `mounts.js`; the
wallpaper's meter math, cap logic, metadata-vs-paid gating, fallback choice,
and copy live in `streetview.js` — both plain top-level-function modules that
the QML imports and the tests load directly:

```bash
bash tests/run.sh
```

That runs `node --test tests/` against the fixtures in `tests/fixtures/` (plus
live `findmnt` and `lsblk` checks that skip when a mount or the tool is not
present) and, when Qt's `qmllint` is installed, checks that `MountMonitor.qml`
and `StreetView.qml` parse and their imports resolve. `testPct` is a setting
for trying a band out: `{ "id": "io.github.jasonlnheath.mount-monitor",
"testPct": 98 }` reports every ring at 98% — display and alerts alike. Remove
it when you are done.

## Feedback

Bugs and suggestions: https://github.com/jasonlnheath/mount-monitor/issues —
open one yourself, or tell your agent to.

## License

MIT
