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

- **No alerts:** the Memory Monitor logo — a full ring filled in white with
  `MM` in white in the middle. Plain white, plain Jane.
- **Amber / red / critical:** the resource in trouble, with a graphic badge —
  a drive glyph, a memory-chip glyph, a GPU-card glyph. Only the **most severe**
  alert across the three types is shown, chosen by a deterministic rule
  (severity, then the smallest headroom to its own critical line, then a fixed
  type order). A resource that is not on the machine is never named.
- **Severity carries shape as well as colour:** amber is a hollow partial fill,
  red is a full badge with a warning glyph, critical adds the pulse and halo. A
  latched band renders as latched. The tooltip always carries the numbers in
  text.

## Thresholds: you set the ceilings

- **Amber 80%** and **red 90%** are the documented defaults.
- **Critical ships unset.** No critical band exists, no critical toast can fire,
  and the bar cannot glow for a ceiling you never chose. First run reports what
  your machine actually rests at and asks you for your ceilings; the
  recommendation is a recommendation, and your value wins.
- One critical control per memory type — hard drive, VRAM, system RAM — set in
  the detail window or answered at onboarding. Each value records whether you
  set it or it is still the default.
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

## The detail window

Click the widget (or a critical toast) for the whole picture: per-drive rows
grouped by device, the RAM picture with absolute GiB, PSI, swap and zram, the
VRAM picture with its consumers and its unattributed remainder, your ceilings
next to the kernel's, the guard's real state, the alerts DND silenced, and the
baseline log path. Thresholds are set there: a value box per threshold, changed
by clicking the step buttons, by typing, or by arrow keys (up/right increments,
down/left decrements, one percentage point). An unavailable measurement reads as
unavailable — never as 0%.

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
| `pollMs` | per resource (60000 HD / 30000 RAM / 60000 VRAM) | Override the nominal poll interval. Escalation still applies on top of it. |
| `onboarding` | `true` | `false` skips the ceiling question and the guard ask. |
| `testPct` | unset | The manual hook: force every badge to one percentage, alerts included. |

Thresholds and the guard answer are not `shell.json` settings — they live in
`~/.local/state/memory-monitor/settings.json`, written by onboarding and the
detail window.

## Tests

```bash
bash memory-monitor/tests/run.sh
```

Node tests over `memory.js` and `ringkit.js` with fixtures for every parser,
character-pinned toast copy per kind, the RingKit ↔ `mounts.js bandFor`
conformance check, the hostile-label regression, the multi-instance
one-alert/one-log-row/one-arm check, the install-layout check, an `install.sh`
syntax check, a `SKILL.md` check, and `qmllint` on the QML. There is no CI in
this repository: `bash tests/run.sh` and `bash memory-monitor/tests/run.sh` are
the gates, and the visual deliverables are verified by installing, restarting
the shell, and pixel-diffing the bar against the previous render.
