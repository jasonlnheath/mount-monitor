# QUATTRO DASH 🏁
### the instrument cluster that bolts into your omarchy bar

omarchy is stupid fast. featherweight. a kick-ass distribution that stays out of your way. quattro dash is the plugin for people who want to wring everything out of it.

**🟥 STALL GAUGE**
rpm tells you how fast you're going. this tells you if the engine is STRUGGLING. the kernel literally snitches on itself — the needle shows how much of your machine's work is stuck waiting on memory. pedal flat with a model loaded and the needle's asleep? full throttle. needle climbing? that's your knock sensor. back off before you spin a bearing — the oom killer does not leave a note.

**🔧 DYNO STRESS TEST**
you wouldn't race on someone else's tune. one button, and this thing does a full pull on your RAM — climbs grade by grade to the wall, finds the exact point where YOUR machine taps out, then paints amber and red lines that are real. not factory guesses. not vibes. your tune.
and it's done safe: the pull takes your rig right up to the limit and backs off before anything bad happens. your machine never sees the cliff.

**🎮 THE VRAM DIAL**
your card has a fuel gauge. amber and red lines for free memory, set where YOU want them — so you know the card's running dry before your generation chokes, not after. hover the dial and it names names: top three hogs on the card, one line for everything else, total always matches the needle. live, not a snapshot.

**🔋 SWAP MONITOR**
your reserve light. when the kernel starts leaning on zram to keep going, it lights up. not a panic button — a "battery's low now, plan your stop."

**⚠️ CHECK ENGINE CODES**
check-engine lights for linux. five telltales — bar, kernel, gpu, layer, disk. something wedges mid-generation, the dash tells you which system coughed.

**🧑‍🔧 TOASTS**
every warning is one click from answers. tap the alert and your agent opens with the reading AND the dash's own diagnosis already in its hands. on a critical, the dash arms a spotter to guard against the big one — and it never claims it did unless it really did.

**🛡️ IT NEVER GRABS THE WHEEL**
this is a monitor, not a backseat driver. it doesn't kill, throttle, or touch your system, period. crossing a line is your call, made with your crew. the scary band doesn't even exist until you set it. your lines, your tune, your car.

**🎓 FIRST LAP ONBOARDING**
bolt it on and it asks for your ceilings like a good crew chief. drive a bit and the recommendations start coming from your machine's real resting numbers. it suggests. you decide.

## Keep Omarchy fast. Quattro Dash. 🏁

# Quattro Dash

An [Omarchy](https://omarchy.org) bar plugin that watches **System RAM, VRAM,
and your drives**, and tells you when one of them crosses a line **you** set.

It is a monitor first. It measures, shows, alerts, logs, and hands the reading
to your agent. It never kills, throttles, unloads, or reconfigures anything —
what happens when a line is crossed is your decision, made with your agent.

Quattro Dash is the sibling plugin of [Mount Monitor](../README.md) in this
repository. Mount Monitor owns which drives are watched (its `mounts` setting
and its partition onboarding); Quattro Dash reads that same list, shows the
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

- **Amber 80%** and **red 90%** are the documented drive and VRAM defaults.
  System RAM reads in PSI, and its defaults are the round 8 rig numbers:
  **amber 15 PSI** and **red 28 PSI** — the rig played comfortably at a sustained
  8-15 and hit its wall at 28, so pressure is worth warning about far earlier than
  a drive filling up. The swap reserve defaults to **70%** and **86%** of the swap
  used (30% and 14% of it left), the same pair any machine can carry, and the dash
  prices it in your own gigabytes.
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
- Quattro Dash never writes a system limit. Your ceiling and the kernel's
  ceiling (systemd-oomd's PSI and swap limits) are shown side by side, because
  they are different numbers and only one of them is yours.

## What "used" means

- **The RAM band is pressure plus the swap reserve** (round 7): the kernel's
  Pressure Stall Information (`/proc/pressure/memory`, some avg10) against the
  PSI pair, and the swap reserve's used percent against the reserve pair —
  whichever band is more severe — and the toast names its signal, pressure or
  swap. **A reserve that is climbing fast is a band of its own** (round 8): two
  consecutive samples at least 2 GiB apart, no more than 90 s between them, reads
  amber with no ceiling crossed, because the direction is the finding. A climb is
  never red, it never rewrites a ceiling, and its toast says *climbing fast*
  instead of quoting a percent nobody set a line at.
  Percent-used never resolves a band: it stays a reading, logged and
  handed to the agent beside the absolute `MemAvailable` in GiB (`MemFree` is
  the flattering number; `MemAvailable` is what the kernel thinks a large
  allocation can actually get).
- **PSI is also the re-alert gate.** A held band re-fires
  when its severity increases, when PSI memory crosses the stall floor, or when
  swap crosses oomd's swap limit — because a machine sitting at its ceiling and
  a machine stalling are not the same event. Polling is not the escalator's job
  any more: round 8's watch lane (§Adaptive polling) shortens the whole loop.
- **Toasts are events, not states.** An alert fires on a crossing. A resource
  that merely sits in a band is carried by the badge, the detail window, and the
  log — so a machine that rests high does not re-toast forever, and a genuinely
  worse excursion still gets a toast.
- **Swap and zram are in the RAM picture** (swap used%, zram fill, compression
  ratio). The swap reserve is one of the RAM band's signals, a fast climb is
  another, and swap past oomd's own limit re-fires a held band; swap is not a
  fourth resource with an alert of its own. The reserve ceilings are stored as
  percents and **shown as gigabytes with a 5 GB step** (on a 64 GB swap that is
  your 45 GB and 55 GB), and the gauge hover reads
  `Now: 61% Free (39/64 GiB)`.
- **VRAM** shows total, used and free with absolute MiB beside every percent, the
  per-process breakdown `nvidia-smi` can see, and an explicit **desktop /
  compositor (unattributed)** row — clamped at zero — because `nvidia-smi` cannot
  see the compositor, and the desktop is what the red band exists to protect.
  The per-process breakdown also surfaces on the dash: hovering the VRAM
  instrument shows the top three processes by MiB held (percent of total VRAM
  beside each), an "Other" remainder row, and the Total row matching the dial;
  a fresh sample refreshes the open popover in place.
  First card only, and the detail window says so.

## Alerts

A toast on every amber, red and critical alert event, in the spec's own words:

```
Quattro Dash
Caution: Amber Alert
System RAM pressure has reached 16 PSI.
Click to address with agent, otherwise ignore.
```

```
Quattro Dash
Caution: Amber Alert
Swap reserve is climbing fast, 20 percent used right now.
Click to address with agent, otherwise ignore.
```

```
Quattro Dash
WARNING: RED ALERT
Swap reserve is 88 percent used.
Click to open an agent to actively monitor/guard against OOM, otherwise ignore.
```

```
Quattro Dash
CRITICAL ALERT!
System RAM pressure has reached 33 PSI.
Agent has been notified and is guarding against OOM.
```

A ram toast names its signal's own number: PSI for a pressure band, the used
percent for the swap reserve — and when the band is a fast climb rather than a
ceiling it crossed, it says **climbing fast** instead of quoting a low percent as
if it were an alarm line. Drives and VRAM keep the percent-used wording,
and the percentage is the **live reading, rounded up**, not the threshold: a
mount at 97% is not told "reached 95%". Every toast wears the check-engine
emblem logo, tinted plain, amber or red by the band. The logo is a file handed to
the notification daemon (`-i icons/mil-<tint>.png`), and Omarchy's toast paints a
sender's file as a **picture**: it crop-fills it into a square slot, so an asset
wider than tall loses its left and right to the cut. The three emblems in
`icons/` are therefore square, rendered from `quattro.js`'s own `mil` artwork by
the same `QuattroSymbol` the bar and the dash draw, with the emblem inset inside
the canvas so cover and fit are the same transform and nothing is cut at any
toast width (`tests/round8.test.mjs` pins the square canvas, the inset and the
tint).

- **Amber** is normal urgency. If Do Not Disturb is on, the notification service
  silences it — and Quattro Dash records it, in the log and in the detail
  window's **"Alerts you did not see"** section. Silenced, never lost.
- **Red and critical ride normal urgency too** (round 7: every toast is
  temporary — normal urgency with a finite timeout, the tinted emblem logo
  carrying the severity). Critical preempts an unanswered lower-band toast
  rather than queueing behind it.
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

- `The standing guard is off. Click to open Quattro Dash, otherwise ignore.`
- `The guard could not start. Click to open Quattro Dash, otherwise ignore.`
- `The guard did not survive. Click to open Quattro Dash, otherwise ignore.`

The last one replaces the claim toast it retracts, by the notification id captured
when the claim was sent, so a guarantee cannot outlive the thing it names.

Onboarding asks whether you want the guard, and insists that it does guard. On
yes, it runs a read-only system health check first (the `memory-health` skill:
largest consumers of RAM, VRAM and drives, with ranked throttle/prune
recommendations — nothing is killed or throttled without your word). On decline,
monitoring continues and a critical still notifies you, with the guard-off copy.

## QuattroDash, the instrument cluster

Clicking the bar emblem opens the dashboard under a hero header: the
check-engine emblem again, tinted by the machine's one tier, beside the
"Quattro Dash" title and its ALL-CAPS tier phrase naming the worst thing the
dash knows. Below it, two round meters drawn at
exactly the same size (RAM PRESSURE reading the kernel's Pressure Stall
Information from `/proc/pressure/memory`, some avg10, on a face scaled 0 to 35
PSI with a tick for every PSI and true numbers at 0, 5, 10, 15, 20, 25, 30 and
35 - no hidden rescale from a 0-100 dial, so 28 PSI sits 28/35 of the sweep,
near the top, with the red zone running to the top of the face; amber from 15
and red at 28 by default; ROOT DRIVE as a fuel gauge where F is 100 percent free, the amber zone
from 20 down to 10 percent free, the red zone below 10 percent free), a SWAP
RESERVE battery telltale with a
ten-segment LED bar (the recommended pair colors the bars at 30 percent of the
reserve left and 14 percent left, pulsing when red, no swap configured reads as the empty state), and BELOW
the battery, centered, the VRAM instrument: a square the size of the SWAP
RESERVE square carrying the STANDARD ISO coolant warning light (the
thermometer-in-liquid telltale) over a reservoir bar that drains right to
left behind a red needle, with a gas-tank scale along its bottom (E red, F
green, quarter marks grey). The light and the bar's red and amber zones take
the free-VRAM thresholds (floor
500 MiB unset, the captain's defaults, sampled by this plugin's own nvidia-smi
read; red below the floor, amber the 1000 MiB approach zone above it, so amber
at 1500 MiB free when unset). The instrument has no green anywhere: clear is
the unlit monochrome glyph, and a missing reading reads unlit with no needle.
The three percent-gauge bands start at the settings row's recommended
defaults, the coolant light follows the VRAM floor until its sliders are
touched, and the row moves them all live.
Hovering the instrument reads the standard free format, and hovering the reserve
tells the same story the values popup's SWAP row tells: `Now: 61% Free
(39/64 GiB).` When the VRAM sample carries a per-process list (nvidia-smi saw
current compute processes), the VRAM hover becomes the per-process grid
instead: the top three processes by MiB held, sorted descending, each with its
percent of total VRAM, then one remainder row labelled "Other", then a Total
row matching the dial's own used number. A fresh sample refreshes the open
popover in place, so the grid and the dial never disagree while it shows.
With no per-process list - an idle GPU or no NVML - the hover keeps the plain
free-percent line, never a broken or empty grid. Under the cluster, the
codes area: ONE column under one check-engine head, always most critical at
the top, rows stretched across the full card so each code carries its reading
and its status. The doctrine is round 2's: RAM monitoring is PRESSURE + SWAP
RESERVE, never amount used, so a high System RAM reading is the pressure gauge
and the reserve battery and NO code (revised round 11: PRESSURE HELD over your
red line for minutes IS a code, see RAM below - a spike and a cache-resident
machine still stay gauge-only); VRAM high lights the coolant light only.
A drive code is a watched DRIVE sitting over your amber or red ceiling,
wearing an OBD-style name (C plus four stable digits) and a one-line hover
status (round 7: the severity line only). Round 9 extends the codes family to
system health, five boolean faults on the same taxonomy, no calibration
curves and no settings of their own (the gauges stay four; gauges watch
calibrated curves, codes watch discrete faults):

- **BAR** - the bar shell process (quickshell) died or restarted itself
  recently. A shell younger than fifteen minutes that did not start with the
  session is the moderate code; a missing shell process is severe; a process
  that came up with the machine is a boot, not a fault. The visible row names
  the restart age in minutes, never a PID.
- **KERNEL** - new kernel fault lines (err priority and above) since the last
  look, with a count and the culprit module named (NVRM, igc, usb, Out of
  memory). The first look of a session sets the baseline and counts nothing,
  and the cursor keeps honest books: a line can never report twice.
- **GPU** - the driver-wedge fingerprint: the NVRM `GspRmAlloc` /
  `NV_ERR_STATE_IN_USE` signature in this boot's kernel log. This is the big
  red one, and its copy says plainly that a reboot clears it: there is no
  in-place GPU reset on this hardware, and neither the code row nor the
  diagnosis ever pretends otherwise. A scan capped past five hundred matching
  lines reads "500+".
- **LAYER** - a background systemd user unit (a small built-in list of the
  Omarchy background units, wallpaper hosts included) climbing its own restart
  count. Two restarts in one poll interval, or one climb on each of two
  consecutive polls, is the fault; one restart alone - your own deliberate
  `systemctl restart` - never is. A unit that is not installed drops off the
  list.
- **DISK** - IO pressure sustained past a bar: the kernel's IO stall score
  (`some avg60` from `/proc/pressure/io`) at or over 10 for two consecutive
  polls lights amber, at or over 25 lights red. These are honest first cuts,
  revisited when calibration exists. Swap stays the predictive gauge tripwire
  it is; DISK is the present-tense stall code and reads the pressure file
  only.

Round 11 adds two families. The first answers the night the machine wedged and
a hard cycle was the only way out: the round-9 codes all die with the bar, so
after a crash the dash showed nothing. **CRASH** reads the system journal for
the wedge signatures across the current boot AND the previous one - soft
lockup, RCU stall, hung task, watchdog BUG, NVRM Xid, oom-kill - and latches
one code per signature with the evidence: the hit count, the culprit or victim
name, and the exact journal lines, visible on the code's hover and in the
click payload's diagnosis. Each code is seeded from the signatures' own
kernel text (kernel messages only, so userspace chatter cannot forge one),
scanned as bounded deltas (a journal cursor, plus one bounded grep of the
previous boot per session) so the sample cycle never blocks. The latches live
in their own file beside the settings (`~/.local/state/memory-monitor/crash-codes.json`),
so they survive the restart that follows the crash: opening the dash after a
hard cycle throws the code for what happened. A reboot never clears them; the
journal's read of the shutdown boundary (via `last -x`, wtmp, no root) also
latches a **POWER** code when the previous boot did not end cleanly. The
second family is **RAM** - the round-2 revision: RAM pressure held at or over
your red PSI ceiling for a sustained window (three minutes by default, the
`psiPressureSustainSec` setting tunes it) lights a severe code; falling back
under your amber line for five minutes clears it. Pressure is stall time, not
footprint: a single spike and a cache-resident machine reading PSI 0 can
never light it. A crash latch clears by acknowledge - right-click the code's
row, which says "cleared, the journal keeps the evidence" - or by the same
condition-clear rules as every other code; nothing is deleted from the
journal. A calibration run induces the pressure it measures, so a run holds
the RAM code (and the KERNEL and DISK codes, as before) and freezes its
windows; crash latches pass through, a lockup during a run is genuine.

A system read that cannot be taken (the journal unreadable, systemd
unreadable, no pressure file) renders the honest unknown row, never a fake
clean zero. The visible rows stay terse - subject, count, culprit name, never
a raw PID - while the click payload carries the full detail. An empty column reads "ENGINE CLEAR" under
the unlit head; no severity ever gets an empty section of its own. Clicking a
code sends its fixed prompt to your default agent (a drive code's is the same
prompt its toast sends; a system fault has no toast; inline
when `agentInline` is set) with the dashboard's own pre-computed diagnosis
appended as a fenced JSON block (code, severity, cause, top consumers,
recommendation - for a system fault: subject, cause and the exact detail,
journal lines, unit names and counts), so the agent explains from the
dashboard's numbers, and
lights the green toast, red codes with the "processing now" wording added.
Only a code at the critical band goes through the guard's arm gate first - the
same single-flight, budget-gated check that owns every critical-band agent
launch; its prompt carries the diagnosis too. Armed, the agent starts;
refused, nothing starts and the red "not sent." toast says why: the guard is
off, an agent is already on it, no memory headroom, or another screen owns
the guard. Swap's numbers live in the values
popup (the SWAP row), not on the bar card, and swap, VRAM and disk free-ness
all read one standard format: "80% Free (6.4/8 GiB)".

The bottom of the dash carries the gauge settings row, collapsed until you
open it (and always collapsed when the popup opens or closes: the section
never survives a screen exit expanded): one amber/red slider pair per gauge,
each with its two-sentence paragraph in the row (what the metric is, why we
measure it), and a reset button that writes back the recommended defaults
without closing the popup: the state watcher skips this widget's own write,
so the reset cannot bounce the card shut mid-click. The VRAM sliders move in
50 MiB steps, the swap reserve sliders in **5 GiB** on a machine that has swap,
priced against its own measured swap total (and shown as the percent they really
store when the swap is too small for two ordered 5 GiB handles, or when there is
no swap at all), and the RAM pressure sliders drag across the dial's own 0-35
face. The mouse wheel works on any of them while hovered: a plain scroll nudges
the value by that row's own step — up increments, down decrements — with no
button or modifier. The pairs move the drawn
bands live — the RAM and ROOT DRIVE dials redraw their zones, and the battery
under SWAP RESERVE recolors its bars: each bar takes its color from its own
center percentage against the drawn pair, two red bars at 20, three at 30,
duplicates allowed, no hidden reorder. The VRAM battery re-tints amber or red
as free VRAM crosses its thresholds — and red never crosses amber on the RAM
and root drive pairs: moving one slider through the other pushes it.
There is no warning message; the push is the whole rule. The RAM pressure and
root drive pairs are the plugin's real alert ceilings (the same numbers the
detail window edits), the reserve pair resolves the RAM band's swap signal —
stored as percents of the swap used, so the ceiling you set here is the ceiling
the next machine can carry — and
the coolant thresholds stay a display pair — all stored in
`~/.local/state/memory-monitor/settings.json`, so everything loads back on the
next shell start.

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

Samples are appended to `~/.local/state/memory-monitor/baseline.log`, size-capped
and rotated, with **absolute numbers** — kB, MiB, bytes — not only percentages,
plus the band decisions, hysteresis state, poll interval, arm records, and every
alert event with its delivery verdict (`shown`, `silenced-dnd`, `unknown`). A
percent-only log cannot answer "how fast did it climb". Logging never blocks
monitoring: a failed append is reported and monitoring continues.

Not every sample writes a row, and that is what keeps the log a **window of days**
rather than an hour of trace: a row is due when the resting cadence comes round
(30 s, `Memory.LOG_ROW_MIN_MS`), or at once when the row has something to say —
an alert event, a band change or latch, a whole percent of a watched resource, a
PSI move of a full point, a drive that appeared or went, a ceiling the user
moved, the guard state. Round 8's 2-second watch lane is where the climb is
*caught*; the kilobyte-and-hundredth wobble between two of its samples is not a
fact about the machine, and a row each 2 seconds would erase the resting
distribution the ceilings question and the recommendation read.

## Adaptive polling

**Round 8's watch lane comes first: any monitored resource at amber or worse, or
a Quattro Dash window open, polls everything every 2 seconds.** A resource
already at red or critical is amber-or-worse, so it is watched too. The lax
nominal intervals — drives 60 s, RAM 30 s, VRAM 60 s — are what normal passive
cruising gets: everything green and nothing open. The older escalator (red or
critical at 10-20 s, 5 s while PSI memory is stalling) still decides the ladder a
watch only caps, so a `pollMs` override or a vanished mount still behaves, and a
resource that is gone never holds the loop at 2 s. Opening or closing a surface
re-arms the timers at once instead of waiting for the next sample. Quattro Dash
runs no `udevadm monitor` of its own — Mount Monitor's is
this machine's event-driven block watcher. Faster sampling does not make the log
faster: `Memory.logDue` decides which of those samples earns a row (§The baseline
log), so a watched stretch at 2 seconds still leaves the log's window the length
it was.

The five round-9 system reads (the bar probe, the kernel fault delta, the GPU
wedge grep, the unit show, the IO pressure file) ride this same sample cycle —
no second timer system, no poll cadence of their own. They are cheap reads:
process liveness, unit properties, a journaled delta and a pressure file. Their
decision state is session-only — the kernel log cursor, the layer climb memory
and the disk amber run — and a shell restart re-baselines all of it.

## Stress calibration (round 10)

The settings section has a button under RESET TO DEFAULTS: **RUN STRESS
CALIBRATION** — the twin function. Reset says use the fleet's numbers; this
says measure this machine. It exists so a new install gets honest bands in
minutes, and a hardware change gets a re-tune, without anyone guessing.

What a run does: about three minutes of graded MEMORY-ONLY pressure (eight
steps of roughly twenty seconds, each step holding its allocation — the ladder
climbs until the machine holds everything but a small reserve, about 1.5 GiB,
of its free memory, so the run ends where reclaim and swap actually engage on
any machine with headroom; a step larger than the stressor's own per-grade
bound splits into sub-grades rather than shrinking the climb) while the dash
records this machine's own stall curve grade by
category: memory PSI, swap used and its rate, dirty pages. No files are
written anywhere; the stressor (`calibrate.py`, shipped beside the widget)
allocates and touches anonymous memory and nothing else.

The rails, none optional: the stressor runs as a transient systemd **user
unit** (`quattrodash-calib`) whose `MemoryMax` is the kernel wall above the
ladder and clamped below physical RAM, whose `MemorySwapMax` bounds the
reserve exposure at half the reserve, whose `RuntimeMaxSec` kills it at the
cap even if the shell dies, and whose `TimeoutStopSec` makes CANCEL land in
seconds. The stressor never runs unbounded: if `systemd-run` or `python3` is
missing, calibration refuses. Under 1 GiB of MemAvailable it refuses too —
close something and try again.

The run auto-aborts on sustained memory PSI: three consecutive `some avg10`
readings at or over 40 (the wall class), or two consecutive `some avg60`
readings at or over 25 (the sustained bar). The two stops speak their own
sentences — the class hit says the class was hit, the sustained bar says
pressure held at its bar — and the proposal's wall scan recognizes both
signs, so a stop always has a wall to propose. The avg60 bar arms only once
the run itself is 60 seconds old — avg60 is the kernel's own 60 s window, so
a younger run's readings still carry the minute before the run, and pre-run
PSI carryover never stops a fresh run. One- and two-sample transients are
fault-in reclaim, not a wall — they land in the record's MAX column and
never abort. The swap rate never aborts either: on zram-backed swap a
high rate is compression throughput, not danger (the rig probe measured
16 GB/min of swap-in at PSI 1.4), so the rate is recorded curve data
that still feeds the proposal's wall detection. A wall abort stops the
ladder early and still proposes — the partial curve is real data. The
watchdog cap, a surprise exit and a cancel dismiss instead: they say
nothing about where this machine's wall is.

While a run is live — and through the settle window after it — the dash holds
the alert lanes a deliberate stress could trip: the KERNEL and DISK codes stay
quiet (a calibration causes those two; it can cause none of BAR, GPU and
LAYER, so a genuine fault there still shows), RAM/swap band toasts are held
until quiet releases, the critical guard does not arm, and baseline log rows
written inside the window carry a `calib` mark so the round-8 evidence reads
can exclude the excursion. The gauges keep showing the honest live bands
throughout; nothing is hidden, only the paging is held.

The proposal screen shows the measured curve beside the proposed numbers: RAM
amber/red as fractions (0.35 / 0.65) of the anchored wall — the greater of
the wall grade's sustained average and the 40 PSI wall class, so a
spike-found, swap-rate or sustained-bar wall cannot talk the pair below the
class — the swap
reserve pair scaled between the knee and the wall in percent used, and — when
the machine shrugged off the whole ladder — the fleet defaults as the honest
floor. APPLY and KEEP DEFAULTS are equal citizens; APPLY writes through the
same paths a slider drag uses, so ordering rules and a user-set critical
ceiling are enforced unchanged (a critical that blocks the proposed red blocks
the apply and says so). Root drive and VRAM are never proposed — a memory-only
run measures pressure and the reserve. Only the writer instance starts a run;
a fixed unit name means one calibration per machine, enforced by systemd.

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
| `pollMs` | per resource (60000 HD / 30000 RAM / 60000 VRAM) | One override for all three resources. A positive value pins the interval and replaces the escalator — a resource at red or critical, and round 8's 2-second watch lane, poll at it too. |
| `onboarding` | `true` | `false` skips the ceiling question and the guard ask. |
| `vramFloorMib` | `500` | The QuattroDash coolant light's floor, in MiB. Red sits below it; the amber approach zone is 1000 MiB above the floor (amber at 1500 MiB free when unset). A display floor only; it sets no alert ceiling. The light follows it until the dash's gauge settings row sets the coolant thresholds. |
| `testPct` | unset | The manual hook: force every badge to one percentage, alerts included. |

Thresholds and the guard answer are not `shell.json` settings — they live in
`~/.local/state/memory-monitor/settings.json`, written by onboarding, the
detail window, and the dash's gauge settings row.

## Tests

```bash
bash memory-monitor/tests/run.sh
```

Node tests over `memory.js`, `quattro.js` and `ringkit.js` with fixtures for
every parser, character-pinned toast copy per kind, the QuattroDash bands and
code copy (round 9's system codes included: the real 2026-11-10 NVRM wedge
lines as a fixture, synthetic IO pressure files, and fake process and unit
state for BAR and LAYER), the RingKit ↔ `mounts.js bandFor` conformance check,
the
hostile-label regression, the multi-instance one-alert/one-log-row/one-arm
check, the install-layout check, an `install.sh` syntax check, a `SKILL.md`
check, and `qmllint` on the QML. `tests/round8.test.mjs` pins the captain's
third-test-drive rulings (the 2-second watch lane, 15/28 PSI, the 70%/86% swap
ceilings shown in gigabytes on a 5 GB step, the `Now: XX% Free (x/y GiB)` hover,
the 0-35 pressure face with true tick numbers, and the square-canvas toast
emblem the notification daemon cannot crop) and guards that the QML asks for
every one of those decisions instead of carrying its own copy of them;
`tests/qml-ids.test.mjs` drives the declared poll timers on a virtual clock.
`tests/calibration.test.mjs` pins round 10's stress calibration (the bounded
grade plan, the wall-abort and quiet-window decisions, the proposal math, the
copy) and executes the runner-to-helper seam for real: the unit argv's own
`--plan` payload runs in `calibrate.py` and a cancelled run dies in seconds,
and systemd itself accepts every property that argv builds (the live checks
skip where `python3` or `systemd-run` is absent). `tests/vram-grid.test.mjs`
pins the VRAM hover grid (the top-three/Other/Total rows, the shortened
process names, the no-list fallback to the plain free-percent tip) and guards
that the popover stays hover-only. There is no CI in
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
