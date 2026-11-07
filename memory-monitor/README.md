# Memory Monitor

An [Omarchy](https://omarchy.org) bar plugin that watches **System RAM, VRAM,
and your drives**, and tells you when one of them crosses a line **you** set.

It is a monitor first. It measures, shows, alerts, logs, and hands the reading
to your agent. It never kills, throttles, unloads, or reconfigures anything —
what happens when a line is crossed is your decision, made with your agent.

Memory Monitor is the sibling plugin of [Mount Monitor](../README.md) in this
repository. Mount Monitor owns which drives are watched (its `mounts` setting
and its partition onboarding); Memory Monitor reads that same list, shows the
severity of those drives, and alerts only for drives Mount Monitor is not
already alerting on — so one drive produces one toast, not two.

## What the bar shows

- **No alerts:** the QuattroDash emblem — the standard check-engine telltale
  (ISO 2575 artwork) in plain white. Monochrome means all systems go, just like
  an instrument cluster.
- **Amber / red / critical:** the same check-engine telltale, tinted by the
  most severe alert across the three types (amber, then red, then critical's
  red with a breathing pulse), chosen by a deterministic rule (severity, then
  the smallest headroom to its own critical line, then a fixed type order). A
  resource that is not on the machine is never named.
- **Click opens the QuattroDash** instrument cluster. The tooltip is the
  popup's compact form: a centered "Quattro Dash" title, the RAM / VRAM /
  Drive names in one aligned left column, and a status column that is a
  color dot only (white nothing over the line, orange amber, red red and
  critical). While a popup is open, bar hover tooltips hide instead of
  cutting off against it.

## Thresholds: you set the ceilings

- **Amber 80%** and **red 90%** are the documented defaults, except System RAM,
  whose recommended amber default is 70%: pressure is worth warning about
  earlier than a drive filling up.
- **Critical ships unset.** No critical band exists, no critical toast can fire,
  and the bar cannot glow for a ceiling you never chose. First run asks you for
  your ceilings; until the baseline log has enough samples the question says
  plainly it has no resting claim yet and recommends the documented defaults as
  defaults, and once measured it recommends from what your machine actually rests
  at. The recommendation is a recommendation, and your value wins.
- One critical control per memory type — hard drive, VRAM, system RAM — set in
  the detail window or answered at onboarding. Each value records whether you
  set it or it is still the default. The amber and red ceilings can also be
  dragged live from the QuattroDash's gauge settings row.
- Validation is `0 < amber < red < critical < 100`, with critical allowed to be
  unset. Thresholds live in `~/.local/state/memory-monitor/settings.json`.
- Memory Monitor never writes a system limit. Your ceiling and the kernel's
  ceiling (systemd-oomd's PSI and swap limits) are shown side by side, because
  they are different numbers and only one of them is yours.

## What "used" means

- **System RAM is measured by what is actually available:**
  `(MemTotal − MemAvailable) / MemTotal`, always shown beside the absolute
  `MemAvailable` in GiB. `MemFree` is the flattering number; `MemAvailable` is
  what the kernel thinks a large allocation can actually get.
- **PSI memory is not the band.** It is the re-alert gate, the poll escalator,
  and the evidence a later report re-anchors from. A held band re-fires when its
  severity increases, when PSI memory crosses the stall floor, or when swap
  crosses oomd's swap limit — because a machine sitting at its ceiling and a
  machine stalling are not the same event.
- **Toasts are events, not states.** An alert fires on a crossing. A resource
  that merely sits in a band is carried by the badge, the detail window, and the
  log — so a machine that rests high does not re-toast forever, and a genuinely
  worse excursion still gets a toast.
- **Swap and zram are in the RAM picture** (swap used%, zram fill, compression
  ratio) and act as the RAM alert's escalator. Swap is not a fourth thresholded
  control.
- **VRAM** shows total, used and free with absolute MiB beside every percent, the
  per-process breakdown `nvidia-smi` can see, and an explicit **desktop /
  compositor (unattributed)** row — clamped at zero — because `nvidia-smi` cannot
  see the compositor, and the desktop is what the red band exists to protect.
  First card only, and the detail window says so.

## Alerts

A toast on every amber, red and critical alert event, in the spec's own words:

```
Memory Monitor
Caution: Amber Alert
Device (System Ram) has reached 82% usage.
Click to address with agent, otherwise ignore.
```

```
Memory Monitor
WARNING: RED ALERT
Device (System RAM) has reached 91% usage.
Click to open an agent to actively monitor/guard against OOM, otherwise ignore.
```

```
Memory Monitor
CRITICAL ALERT!
Device has reached 98% usage.
Agent has been notified and is guarding against OOM.
```

The percentage is the **live reading, rounded up**, not the threshold: a mount at
97% is not told "reached 95%".

- **Amber** is normal urgency. If Do Not Disturb is on, the notification service
  silences it — and Memory Monitor records it, in the log and in the detail
  window's **"Alerts you did not see"** section. Silenced, never lost.
- **Red** rides critical urgency so it bypasses DND, and never expires.
- **Critical** rides critical urgency, never expires, and preempts an unanswered
  lower-band toast rather than queueing behind it.
- **Clicking** an amber or red toast opens your agent (Omarchy's default agent,
  `omarchy agent prompt`, overridable with `agentCommand`) with the reading.
  Clicking a critical toast opens the detail window — never a second agent on
  top of the one already armed.
- Every toast carries the typed-argv exec hint Omarchy's notification service
  prefers, so a notice that outlived a shell restart is still clickable.

## The guard

The sentence "Agent has been notified and is guarding against OOM." is only ever
emitted when an agent was actually started. The plugin arms one agent at a time
per machine, and only when the machine has headroom for it — the agent and the
terminal it opens are themselves memory consumers, inside the cgroup oomd is
watching. When the claim does not hold, the toast says so:

- `The standing guard is off. Click to open Memory Monitor, otherwise ignore.`
- `The guard could not start. Click to open Memory Monitor, otherwise ignore.`
- `The guard did not survive. Click to open Memory Monitor, otherwise ignore.`

The last one replaces the claim toast it retracts, by the notification id captured
when the claim was sent, so a guarantee cannot outlive the thing it names.

Onboarding asks whether you want the guard, and insists that it does guard. On
yes, it runs a read-only system health check first (the `memory-health` skill:
largest consumers of RAM, VRAM and drives, with ranked throttle/prune
recommendations — nothing is killed or throttled without your word). On decline,
monitoring continues and a critical still notifies you, with the guard-off copy.

## QuattroDash, the instrument cluster

Clicking the bar emblem opens the dashboard: two round meters drawn at
exactly the same size (RAM PRESSURE reading the kernel's Pressure Stall
Information from `/proc/pressure/memory`, some avg10, amber from 60, red at
80; ROOT DRIVE as a fuel gauge where F is 100 percent free and the red zone
sits below 10 percent free), a SWAP RESERVE battery telltale with a
ten-segment LED bar (green at 25 percent or more, yellow from 10, red below
10, pulsing when red, no swap configured reads as the empty state), and BELOW
the battery, centered, the STANDARD ISO coolant warning light: the
thermometer-in-liquid telltale, tinted by the free-VRAM thresholds (floor
500 MiB unset, the captain's defaults, sampled by this plugin's own nvidia-smi
read; red below the floor, amber the 1000 MiB approach zone above it, so amber
at 1500 MiB free when unset, green above that, unlit when no reading exists).
Hovering the light shows VRAM used / reserved in GiB. Under the cluster, the
codes area: ONE column under one check-engine head, DRIVE codes only, always
most critical at the top, rows stretched across the full card so each code
carries its reading and its status. The doctrine is round 2's: RAM monitoring
is PRESSURE + SWAP RESERVE, never amount used, so a high System RAM reading
is the pressure gauge and the reserve battery and NO code; VRAM high lights
the coolant light only. A code is a watched DRIVE sitting over your amber or
red ceiling, wearing an OBD-style name (C plus four stable digits) and a
hover decode (Issue / Status / Fix). An empty column reads "all clear." under
the unlit head; no severity ever gets an empty section of its own. Clicking a
code sends the same fixed prompt the toasts send to your default agent (inline
when `agentInline` is set) with the dashboard's own pre-computed diagnosis
appended as a fenced JSON block (code, severity, cause, top consumers,
recommendation), so the agent explains from the dashboard's numbers, and
lights the green toast, red codes with the "processing now" wording added.
Only a code at the critical band goes through the guard's arm gate first - the
same single-flight, budget-gated check that owns every critical-band agent
launch; its prompt carries the diagnosis too. Armed, the agent starts;
refused, nothing starts and the red "not sent." toast says why: the guard is
off, an agent is already on it, no memory headroom, or another screen owns
the guard. Hovering any instrument gives the plain-words teaching decode, PSI
included: it is a real kernel metric, not one we invented.

The bottom of the dash carries the gauge settings row, collapsed until you
open it: one amber/red slider pair per gauge, each with its one-sentence
description in the row, and a reset button that writes back the recommended
defaults. The pairs move the drawn bands live — the RAM and ROOT DRIVE dials
redraw their zones, the SWAP RESERVE gauge gains threshold ticks under its LED
bar, the VRAM COOLANT tube draws its amber and red as dashed floor lines — and
red can never sit below amber: moving one slider through the other pushes it.
There is no warning message; the push is the whole rule. The RAM pressure and
root drive pairs are the plugin's real alert ceilings (the same numbers the
detail window edits), and the reserve ticks and coolant lines are display
pairs stored beside them in `~/.local/state/memory-monitor/settings.json`, so
everything loads back on the next shell start.

## The detail window

A critical toast's click (or the `openDetail` IPC) opens the whole picture:
per-drive rows grouped by device, the RAM picture with absolute GiB, PSI, swap
and zram, the VRAM picture with its consumers and its unattributed remainder,
your ceilings next to the kernel's, the guard's real state, the alerts DND
silenced, and the baseline log path. Thresholds are set there: a value box per
threshold, changed by clicking the step buttons, by typing, or by arrow keys
(up/right increments, down/left decrements, one percentage point). An
unavailable measurement reads as unavailable — never as 0%.

## The baseline log

Every sample is appended to `~/.local/state/memory-monitor/baseline.log`,
size-capped and rotated, with **absolute numbers** — kB, MiB, bytes — not only
percentages, plus the band decisions, hysteresis state, poll interval, arm
records, and every alert event with its delivery verdict (`shown`,
`silenced-dnd`, `unknown`). A percent-only log cannot answer "how fast did it
climb". Logging never blocks monitoring: a failed append is reported and
monitoring continues.

## Adaptive polling

Nominal: drives 60 s, RAM 30 s, VRAM 60 s. Escalated for any resource at red or
critical, and further while PSI memory is stalling. Restored when a descent
holds. Memory Monitor runs no `udevadm monitor` of its own — Mount Monitor's is
this machine's event-driven block watcher.

## Install

```bash
memory-monitor/install.sh
```

The `memory-monitor/` directory in this checkout is **source layout only**: the
shell's plugin registry scans exactly one level
(`~/.config/omarchy/plugins/*/manifest.json`), so the installer copies the
plugin — plus `ringkit.js`, the module its widget imports — into its own
top-level plugin directory, `~/.config/omarchy/plugins/io.github.jasonlnheath.memory-monitor/`.

Then add it to the right section of `~/.config/omarchy/shell.json` yourself —
the installer does not touch that file:

```json
{ "id": "io.github.jasonlnheath.memory-monitor" }
```

Then `omarchy restart shell`. Plugin QML does not hot-reload.

Deleting `~/.local/state/memory-monitor/` re-runs first run on the next shell
start; restart the shell first, because a live widget keeps its state in memory
and writes it back.

## Settings

On the widget's entry in `shell.json`:

| Setting | Default | What it does |
|---|---|---|
| `mounts` | Mount Monitor's `mounts` list | The HD watch list, used only when no Mount Monitor widget is present. An empty list means no drive rows, not garbage. |
| `agentCommand` | `["omarchy", "agent", "prompt"]` | The agent an amber or red click opens. |
| `agentInline` | `false` | `true` passes `--inline` to `omarchy agent prompt`, skipping the terminal the agent normally opens. |
| `pollMs` | per resource (60000 HD / 30000 RAM / 60000 VRAM) | One override for all three resources. A positive value pins the interval and replaces the escalator — a resource at red or critical polls at it too. |
| `onboarding` | `true` | `false` skips the ceiling question and the guard ask. |
| `vramFloorMib` | `500` | The QuattroDash coolant light's floor, in MiB. Red sits below it; the amber approach zone is 1000 MiB above the floor (amber at 1500 MiB free when unset). A display floor only; it sets no alert ceiling. |
| `testPct` | unset | The manual hook: force every badge to one percentage, alerts included. |

Thresholds and the guard answer are not `shell.json` settings — they live in
`~/.local/state/memory-monitor/settings.json`, written by onboarding and the
detail window.

## Tests

```bash
bash memory-monitor/tests/run.sh
```

Node tests over `memory.js`, `quattro.js` and `ringkit.js` with fixtures for
every parser, character-pinned toast copy per kind, the QuattroDash bands and
code copy, the RingKit ↔ `mounts.js bandFor` conformance check, the
hostile-label regression, the multi-instance one-alert/one-log-row/one-arm
check, the install-layout check, an `install.sh` syntax check, a `SKILL.md`
check, and `qmllint` on the QML. There is no CI in
this repository: `bash tests/run.sh` and `bash memory-monitor/tests/run.sh` are
the gates.

### Verifying a change on the rig

Plugin QML does not hot-reload, and a bar change is only proven once the bar is
actually drawn. The loop:

```bash
memory-monitor/install.sh
# add { "id": "io.github.jasonlnheath.memory-monitor" } to the bar section of
# ~/.config/omarchy/shell.json, then:
omarchy restart shell
grim /tmp/mm-bar.png                      # the bar, unmodified
magick compare -metric AE /tmp/mm-bar.png memory-monitor/bar-screenshot.png null:   # 0 pixels
```

`compare -metric AE` reports the count of pixels that differ: an unrelated change
must report `0`. `memory-monitor/bar-screenshot.png` is the saved render the next
change is diffed against. No baseline ships with the repo: the first verified
change saves its render — `cp /tmp/mm-bar.png memory-monitor/bar-screenshot.png`
— and every later change is diffed against that baseline, updating it when
verified. Force a band without waiting for a real emergency with
`"testPct": 91` on the widget's `shell.json` entry. Remove `testPct` and restart
the shell again before the render counts as verified.
