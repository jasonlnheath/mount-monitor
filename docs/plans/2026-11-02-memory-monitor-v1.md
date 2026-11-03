# Plan: Memory Monitor v1 — monitor-first build (sibling plugin)

The captain delivered the full product spec at bedtime 2026-11-02, verbatim capture at
`~/Work/firstmate/data/memory-monitor/spec-captain-2026-11-02.md` (firstmate home). That
spec is the acceptance contract: all six design calls (Q1–Q6) are answered and the spec is
complete for v1. **The ratified sections are the "Continuation received (same night) — spec
COMPLETE" block, the "Amendment (same night, captain correction)" block, and the
"Clarification (same night, final)" block.** The file's own top-of-document header still
reads `Status: PARTIAL — message cut off mid red-alert toast copy`; that header is stale
(the continuation landed in the same file) and is corrected in the spec record, not here.
Wherever the spec and this plan differ, the spec wins.

Four inputs are folded into this plan:

1. **The spec** (authoritative).
2. **The prior suite plan** (`~/Work/firstmate/data/rm-suite-plan/plan.md`) — architecture,
   RingKit, platform facts, what Mount Monitor v1 proves.
3. **The prior adversarial attack** (`~/Work/firstmate/data/rm-suite-attack/report.md`) —
   3 blockers + 22 findings.
4. **The attack on this plan** (`~/Work/firstmate/data/memory-monitor-plan-attack/report.md`)
   — 5 blockers + 10 majors + 13 minors, measured live on the rig 2026-11-03. This revision
   folds it.

**Ruling that shapes v1 (spec Q1): ship as a MONITOR FIRST.** Alerts can be used to
trigger throttling/actions later; v1 monitors, surfaces, logs, and routes to the agent.
The plugin itself never kills, throttles, unloads, or reconfigures anything — levers are
determined together with the captain (Q2) and act through the agent and the captain's own
hands.

---

## Revision 2 — the fold tally (this pass)

Folded from `memory-monitor-plan-attack/report.md`:

- **Blockers 1–5: all five fixed in this plan** (B1 RAM band signal, B2 thresholds-as-ceilings
  onboarding, B3 DND silent-drop, B4 the critical arm's own cost, B5 coexistence with Mount
  Monitor). Each is written as a decision with its mechanism named, not as a note.
- **Majors 6–15: 10 folded, of which 3 are folded with a different answer than the report
  proposed** (10, 12, 14) and 4 carry a named sub-rejection (6, 10, 12, 14). None dropped.
- **Minors 1–13: 12 folded, 1 noted-only** (minor 12, the stale spec header — that is the
  spec record's correction, not this plan's file; this plan cites the ratified sections).
- **Sub-findings rejected, with reasons** (all named in *Rejected, and why* below): making
  every band ride critical urgency; a second `udevadm monitor` inside Memory Monitor;
  dropping or deferring RingKit; the plugin aligning oomd's limits; normalising the spec's
  `System Ram`/`System RAM` copy without the captain's word.
- **Prior-attack findings this plan had missed are now open in the plan**: prior majors 15,
  16, 18, 10, 11 and 21 (see *Fold list, corrected*).

---

## The blocker fixes

### B1 — what "used%" means for RAM, and what the bar shows on a healthy machine

**The decision, stated in the plan and not left to `memory.js`:**

- **The RAM band signal is available-based used percent:**
  `ramUsedPct = (MemTotal − MemAvailable) / MemTotal × 100`, computed in `memory.js`, always
  shown beside the absolute `MemAvailable` in GiB. This is the numerator, named.
- **PSI memory is not the band. PSI is the re-alert gate, the poll escalator, and the
  re-anchoring evidence.** It never moves the bar's band and never moves a threshold.

**Why available-based, and why not `MemFree`:** `MemFree` is the flattering number — it
excludes reclaimable page cache and is not what the kernel thinks a large allocation can
actually get. On this rig, measured 2026-11-03 by this fold pass, `MemAvailable` is *below*
`MemFree` (2,051,652 kB against 3,473,948 kB of 65,588,588 kB total) because the reclaimable
cache is not reclaimable and the low watermarks subtract: the kernel's own estimate is worse
than the naive one, which is exactly the direction a monitor must not be wrong in.
`MemAvailable` is also the quantity the captain's own detail window already promises
("available (absolute + %)"), so the band and the picture read the same number.

**Why not PSI as the band:** PSI is a stall measure, not a capacity measure. On this rig it
reads `avg10=0.00` through 40 minutes of a pressure-free machine and `some avg10=1.02` when
the machine is genuinely tight (measured 2026-11-03: MemAvailable 2.05 GB, zram 18.2 GB
filled, PSI `some`/`full` avg10 1.02, avg60 0.88). oomd acts at PSI 50% sustained 20 s. A
0–100 percent value box with 80/90 defaults and a one-percentage-point step is a *capacity*
control; put PSI in it and the captain's number never means anything, and the spec's
thresholds are percent-used by its own words. PSI belongs where it is honest: deciding
whether a band is a ceiling or an emergency.

**The measured problem, kept in front of the captain rather than explained away.** This rig
rests high on either natural numerator — the attack measured 92.48% / 95.62% / 93.44%
available-based and 90.25% / 93.52% / 91.48% free-based while PSI held 0.00 and oomd reported
pressure 0.00. `oomctl` reports `app.slice` holding 48.6 GB with `strata` alone near 40 GB
RSS. That is not a measurement error and not a defect: it is a machine deliberately running
at its limit, which is what the spec asks for ("Goal of the monitor: PUSH THE SYSTEM TO ITS
LIMITS"). The plan's answer is not to move the captain's thresholds and not to hide the
number. It is these four rules:

1. **The captain sets his ceilings against his own machine's measured resting band** (B2).
   With the spec's 80/90 defaults, this rig's RAM badge is amber-to-red at rest; the plan
   says so out loud at onboarding, shows the resting distribution, and recommends from it.
   The user's value wins (spec amendment) — but it is set informed, and the widget states
   plainly when a chosen line sits inside the resting band.
2. **Toasts are events, not states.** An alert fires on a band *ascent* (a crossing), never
   on a resource that is merely sitting in a band. `primed` is carried (a shell restart does
   not re-toast a band that was already held), and a held band does not re-toast. This is
   what makes "toast on every alert" and "this resource rests in a band" compatible: every
   alert *event* toasts; a state that never changes produces exactly one event. The standing
   condition is carried visibly by the bar badge, the detail window, and the log.
3. **PSI is what makes a held band re-fire when it becomes real.** A held band produces a
   fresh alert event when (a) its severity increases, (b) PSI memory crosses the stall floor
   (`psiStallFloor`, provisional `some avg10 ≥ 1.0` from the rig readings above, re-anchored
   by PR 7), or (c) swap/zram crosses oomd's swap limit. This is the signal the fixed 2 pp
   descent margin could not provide: on this rig leaving red at 90% needs more than 7.5 GB
   available and the machine has 2–4.9 GB, so a percent-only descent is unreachable and a
   genuinely worse excursion produced no new toast. PSI moves 0.00 → 1.02 between "at the
   ceiling" and "stalling"; that is the discriminating signal, and it is the one v1 uses.
4. **Descent margins are measured, not asserted.** Hysteresis margins are derived per
   resource from the baseline log's own distribution (provisional values in PR 2, re-anchored
   in PR 7). A band whose descent margin is unreachable at its current value is reported as
   such in the detail window ("this band cannot clear at its current margin") instead of
   silently latching, and a latched band renders as latched.

**What the bar shows in a healthy state:** plain white MM logo. It gets there because the
captain's amber/red/critical lines were set above his machine's measured resting band at
onboarding — not because the plan moved a threshold, and not because the plan picked a
numerator that flatters the machine.

### B2 — onboarding asks for the ceilings; the plan presets nothing critical

The spec's amendment is the loudest instruction in the contract and the previous revision of
this plan inverted it by seeding `80/90/95`. It is removed.

- **Settings state file** (`~/.local/state/memory-monitor/settings.json`): `amber` 80 and
  `red` 90 per type (the spec's stated defaults), **`critical` unset (`null`) per type until
  the user sets it**. `validateThresholds` accepts an unset critical and reports it as unset;
  no critical band can exist, no critical toast copy can be emitted, and the bar cannot show
  glowing red for a ceiling the user never chose. Amber and red run at the spec defaults from
  install (spec Q1 names them as defaults; only critical is user-set).
- **A named onboarding step — the ceiling question (PR 6).** One ask per memory type (hard
  drive, VRAM, system RAM), in the spec's own order: report the machine's measured first-run
  reading (resting percent, `MemAvailable` in GiB, PSI, swap/zram, oomd's limits), give a
  recommendation derived from that reading, state what each line means on *this* machine, and
  ask. The user decides. Amber, red and critical are each settable there; amber and red
  default to 80/90 if the user does not touch them.
- **Recorded as asked ≠ answered ≠ set.** The state file stores, per type,
  `criticalSetBy: "user" | null`, the value, and the timestamp; the detail window shows
  "critical not set — you have no ceiling" rather than pretending a default is his. The log
  records the unset state.
- **PR 7 re-anchors proposals, never ceilings.** Week-two values from the baseline log are
  **recommendations offered to the user** (detail window + a report to the captain). A
  re-anchored value may become the default for a type whose critical the user has *not* set,
  and may be offered as a change for a type he has; it is never written over a user-set
  ceiling, and never moved without his word. "USER SETS EXPECTATIONS FIRST, then the agent
  finds ways to make it happen" (spec amendment).
- **Open question 2 of the previous revision ("bless 95%") is deleted.** There is no seeded
  critical to bless.

### B3 — alerts actually surface: amber respects DND, red bypasses it

The shell's real behaviour, verified in `plugins/notifications/Service.qml` and
`NotificationLogic.js`: `shouldBypassDnd()` returns true only for `appName === "omarchy-action"`
or `appName === "notify-send"` **with critical urgency**; `notify-send` is classified
ephemeral, so under DND a non-critical `notify-send` is dropped **with no history row at
all**. The previous revision inherited that silent drop while promising "nothing fails
silently".

Ruling, per the captain's DND intent and the spec's "toast on every alert":

- **Amber respects DND.** Amber stays normal urgency. Silencing an amber is a legitimate
  choice the user made by turning DND on — but it may not be invisible:
  - The widget reads the notification service's own DND state — `~/.local/state/omarchy/notifications.json`'s
    `dnd` key through a `FileView` (the service's own persisted setting), with
    `qs ipc call notifications isDnd` as the live check. No new daemon, no polling of a
    process.
  - Every alert event the widget emits is logged with a delivery verdict
    (`delivered: shown | silenced-dnd | unknown`), so the log is the record the daemon
    refused to keep.
  - The detail window carries an **"Alerts you did not see"** section: amber events emitted
    while DND was on, with time, type, percent, and band. Amber is silenced, never lost.
- **Red bypasses DND.** Red rides **critical urgency** so `shouldBypassDnd` lets it through,
  and takes on what that urgency means on this shell: timeout 0 (never expires), survives a
  shell restart, and needs its own `notify-send` process lane because `notify-send` blocks
  while its action is live. Red therefore runs on the **never-expiring notice lane**, not the
  watchdog-released band-alert lane, and the queue rule is explicit: a red that nobody
  answered must not hold a critical behind it — critical preempts, and the queue is bounded.
  - The cost is named, not hidden: an unanswered red toast stays on screen across restarts.
    The plan accepts that for red (an emergency the user should not sleep through) and
    refuses it for amber (a caution the user may legitimately have silenced).
  - Red's persisted exec hint is what makes a restart-surviving toast still clickable, which
    is the mechanism this repo already ships.
- **Critical is unchanged:** critical urgency, timeout 0, own lane.
- **Rejected alternative:** making *every* band, amber included, ride critical urgency. It
  would make amber indistinguishable from a never-expiring emergency and would train the
  captain to ignore the one urgency that means "act now". Amber's honesty comes from being
  silenced-and-recorded, not from shouting.

### B4 — the critical arm is re-scoped against its own cost

Measured: `~/.config/omarchy/defaults/agent` = `hermes`, live `hermes` RSS 263–271 MB;
`omarchy agent prompt <p>` → `exec omarchy-agent --prompt "$*"`, which by default runs
`omarchy-launch-tui --app-id=org.omarchy.agent …` — a terminal emulator on top of the agent.
`oomctl` shows the pressure-monitored cgroup is
`/user.slice/user-1000.slice/user@1000.service/app.slice` — the slice quickshell lives in, so
every process the widget spawns lands there, inside the cgroup oomd kills at PSI 50%/20 s or
swap 90%.

Rules, decided here:

1. **Single-flight, machine-wide arm lane.** One agent arm at a time across the whole
   machine, keyed by an event identity (resource type + band + measurement epoch), with a
   watchdog kill at a named timeout and a log row recording the pid, the outcome, and whether
   the arm survived. A second critical while an arm is live does not start a second agent; it
   appends to the live arm's record and re-notifies.
2. **An arm budget gate.** Before launching, `memory.js` reads `MemAvailable`, PSI, and swap
   against the arm's measured cost (agent RSS plus the terminal it opens). If the machine has
   no headroom for the guard, the widget **does not launch** — it emits the guard-failed copy
   below and logs `arm: skipped (no headroom)`. The floor is provisional in PR 2 and
   re-anchored from the baseline log in PR 5/7; the gate exists in the design from day one.
3. **The arm's terminal is a named cost, and `--inline` is the tested lever.**
   `omarchy agent prompt --inline` skips `omarchy-launch-tui`. Whether the default agent's
   TUI behaves correctly when launched inline from a detached quickshell process is a **PR 5
   rig measurement, decided before shipping**, with the terminal launch as the fallback. The
   plan does not assume inline works.
4. **The arm is a kill candidate and the plan says so.** The guard lands in the cgroup oomd
   is watching; a guard that dies with the emergency is not a guard. The log records whether
   it survived, and a dead arm surfaces as a failed guard — never as a silent absence.
5. **The toast may not claim what did not happen.** The verbatim critical copy — "Agent has
   been notified and is guarding against OOM." — is emitted **only when the arm actually
   started**. The two states where it did not are decided now, in the plan, not at
   implementation, because the rest of the toast surface is pinned verbatim copy and these
   are the most important words in the product:

   - Standing guard declined at onboarding (title `Memory Monitor`):
     ```
     CRITICAL ALERT!
     Device has reached 97% usage.
     The standing guard is off. Click to open an agent, otherwise ignore.
     ```
   - Arm refused for no headroom, or the arm died (title `Memory Monitor`):
     ```
     CRITICAL ALERT!
     Device has reached 97% usage.
     The guard could not start. Click to open an agent, otherwise ignore.
     ```
   `97%` is the live reading (see *Copy*, below). These variants are the plan's copy, are
   pinned in tests, and are flagged for the captain's word as a change to the spec's copy
   family (open question 5) — but the plan does not ship a sentence that is false.

6. **Critical's click opens the detail window, and it is a real mechanism.** The previous
   revision said "critical's single click opens the detail window" without naming how, and
   the fallback was a second agent launch on top of the armed one (or `focusApp`, i.e.
   clicking a memory emergency focuses quickshell). The mechanism is QuickShell's IPC:
   the widget exposes `IpcHandler { target: "memory-monitor"; function openDetail() }`, and
   the persisted exec hint is the typed argv
   `["qs", "ipc", "call", "memory-monitor", "openDetail"]` — `parseExecArgv` accepts it
   (`qs` has no leading dash), it survives a shell restart because the handler is re-created
   with the shell, and it never starts an agent. The live `-A default=` action calls the same
   handler. Amber and red keep the agent-prompt click the spec's copy describes.

### B5 — coexistence: one HD owner, one onboarding surface, one alert per drive

Mount Monitor **ships today** on this bar (`io.github.jasonlnheath.mount-monitor`, enabled in
`shell.json`'s right section), and it already alerts mounts at 80/90/98, runs the first-run
`lsblk` scan, the both-counts notice, the new-partition notice,
`~/.local/state/mount-monitor/onboarding.json`, `partition-onboarding` / `partition-remove`,
and the long-lived `udevadm monitor`. The previous revision carried Mount Monitor's *safety
laws* into Memory Monitor without ever mentioning that Mount Monitor exists and already does
the HD half of the job. Coexistence is not a ship-time question; it is what the bar looks
like on day one.

**The coexistence rule (v1):**

- **Mount Monitor owns which drives are watched.** Its `mounts` layout-setting, its partition
  onboarding, its `onboarding.json` decisions, and its two partition skills remain the single
  partition-ask surface on this machine. **Memory Monitor runs no partition scan, emits no
  new-partition notice, keeps no second `decisions` map, and ships no partition skill.**
- **Memory Monitor's HD watch list is Mount Monitor's watch list**: the mount-monitor widget's
  `mounts` setting, read through `normalizeMounts` from the same layout entry (the ask-first
  law's already-shipped answer). Memory Monitor also carries its own optional `mounts`
  setting, used only when no mount-monitor widget is present — the named fallback, so the
  plugin is not silently crippled on a machine without its sibling. An empty list means no
  HD rows, not garbage.
- **HD bands and alerts are per device, not per mount.** `hdDeviceKey` (PARTUUID, else UUID,
  else device path — the repo's existing identity law) deduplicates rows and alerts: five
  btrfs subvolumes of `/dev/nvme1n1p2` are five detail rows and **one** alert event. This is
  the finding the previous plan carried as a candidate filter without carrying the dedup.
- **One alert per device per crossing.** Memory Monitor does not toast HD for a target already
  behind a Mount Monitor ring — those drives keep Mount Monitor's words, thresholds and click
  target, and the captain gets one toast. Memory Monitor toasts HD only for drives Mount
  Monitor is not watching, and it always shows the HD band severity in its own bar badge and
  detail window. The bar may show the same severity twice by design; the toast stream does
  not repeat it.
- **One block monitor per machine.** Memory Monitor runs no `udevadm monitor` in v1 (see
  major 10).
- **Distinct everything else:** distinct state directory
  (`~/.local/state/memory-monitor/`), distinct id prefix (`mem-<8hex>-<8hex>`, never `mm-`),
  distinct product-named notice titles (`Memory Monitor — …`), distinct skills.
- **The follow-up is the captain's, not the plan's:** retiring Mount Monitor's own 80/90/98
  alerts so Memory Monitor owns every HD alert is a change to a shipped product and needs the
  captain's explicit word (open question 3). v1 does not touch Mount Monitor's code.

---

## The attack folds, honestly (prior attack, re-checked)

- **Oomd reality (prior blocker 1).** The rig already runs `systemd-oomd`: active, configured
  by Omarchy at pressure ≥ 50% sustained 20 s and swap ≥ 90%, watching `app.slice`, and it has
  already marked `strata.service` for killing (2026-10-29, swap at 100%). "OS-first, Strata
  yields" is installed policy, not our invention. v1 designs as **visibility into the guard**,
  not the guard: it discovers oomd's live limits and watched cgroup (`systemctl is-active
  systemd-oomd` + `oomctl`), surfaces them in the detail window, the tooltips, the agent
  prompt's data block, and the log. When oomd is absent it says so; no invented numbers.
  **And per major 6 below, it states which ceiling actually kills.**
- **One-action toast surface (prior blocker 2).** Omarchy's notification card carries exactly
  one click action (`invokePopupDefault`: exec hint first, then the single `default` action,
  then `focusApp`). The spec copy is already one-action compliant. No multi-button toasts
  anywhere in v1. Rung choices, if the captain wants them later, live in the widget-owned
  detail panel, never in a notification.
- **Measurement gaps (prior majors 4–9, 19–20, 22b) — labelled honestly.** **Folded:** 5
  (swap in the RAM set), 9 (unattributed VRAM), 19 (poll cost, corrected number), 20 (rig
  facts age), 22a (process lifecycle), 13 (queue and watchdog law), 12 (skills gate), 14
  (cursor-marker rule written for future consumers only). **Deliberately deferred to PR 7,
  still open:** 6, 7, 8 (the VRAM anchors — the baseline week must speak before any VRAM
  number is treated as final). **Changed by this revision, not deferred:** 4 — the previous
  revision claimed the 2 pp descent margin fixed the latching failure; B1 shows it is
  unreachable on this rig, so the fix is now the PSI re-alert gate plus measured margins, and
  the claim is withdrawn.
- **Swap in the RAM picture (prior major 5, and this attack's minor 1).** The recorded
  emergency was a **swap** rule firing at 100% swap. The RAM measurement set is MemAvailable +
  PSI + swap used% + zram fill% + zram compression ratio (`/proc/swaps`, `zramctl`,
  `oomctl`), and swap climbing is surfaced as the earlier signal on this machine. Swap is not
  a fourth thresholded type (the spec names exactly three controls); it is an **escalator** —
  swap used% crossing oomd's swap limit (90% today; 90% assumed when oomd is absent) raises
  the RAM alert event's severity and re-fires a held RAM band, and onboarding says so out
  loud rather than surprising the user with an alert he did not set a line for.
- **Consumer visibility (prior major 9).** `nvidia-smi --query-compute-apps` cannot see the
  compositor and shell; the VRAM picture carries an explicit **"desktop / compositor
  (unattributed)"** row computed as `used − Σ(compute apps)`, **clamped at zero** and labelled
  with what the remainder is *not* (shared contexts and double-counted processes can make the
  sum exceed `used`). The desktop is the thing the red band exists to protect.
- **Queue and watchdog law (prior major 13).** Bounded queue depth, a 120 s watchdog release,
  and **band escalation preempts an unanswered lower-band toast** rather than queueing behind
  it. Red and critical ride the never-expiring notice lane (B3); amber rides the
  watchdog-released lane.
- **Cursor-marker defect (prior major 14).** v1 skips journal-signature watching entirely.
  The rule (advance the marker on every run, cap the window) stays written into the RingKit
  contract labelled *no consumer in v1* — it exists so a future journal watcher does not
  re-import the defect, and it is not presented as something v1 uses.
- **Agent identity (prior blocker 3) — resolved by the spec.** Q4 overrides the attack's
  recommendation: **alerts route to `omarchy-default-agent`**, which is Mount Monitor's
  existing default argv (`["omarchy","agent","prompt",prompt]`), with `agentCommand` as the
  user's override. The honest cost is carried, not hidden: the remediation agent is itself a
  memory consumer (measured 263–271 MB for hermes, plus a terminal), so the arm is
  single-flight, budget-gated, and logged (B4).
- **Marketplace-shipped skills (prior major 12).** v1 ships only generic, analysis-only skill
  seeds; **Strata-specific action instructions never ship from the plugin** — Q6 makes skills
  something developed WITH the user during onboarding and normal use.
- **Rig facts age (prior major 20).** Every rig number quoted here was measured live (2026-11-02
  by the prior attack, 2026-11-03 by this fold pass and by the attack on this plan). None is
  load-bearing for a shipped threshold until the baseline week confirms it.
- **Process lifecycle (prior major 22a).** Every child process gets Mount Monitor's
  hardening: timeouts, watchdog release, one-at-a-time lanes, restart backoff. A wedged
  `nvidia-smi` must not wedge the bar.
- **Latching (prior major 4).** A latched band is visible as latched in the bar and the detail
  window; a stuck band must never read as healthy; an unreachable descent margin is reported
  as unreachable (B1 rule 4).

## Fold list, corrected (this attack's major 15)

The previous revision's fold list claimed more than it delivered. Corrected above: majors 6,
7 and 8 are **deferred to PR 7, deliberately, and stay open**; major 4's claimed fix is
withdrawn and replaced. Prior findings the previous plan never addressed are now named in
this plan:

- **prior 16 — the widget is silent in exactly the resting state the captain most wants
  reported.** Addressed by B1's standing-vs-event rule plus the onboarding resting-band
  report: the resting state is carried by the badge, the detail window and the log, and the
  toast stream is reserved for crossings.
- **prior 18 — the colour-blind defence covers red only.** Addressed in the bar contract:
  severity carries **shape as well as hue** — amber is a partial/hollow ring fill with a
  steady badge, red is a full badge plus a warning glyph, critical adds the pulse and halo.
  Amber-versus-red (the deuteranopia pair) is distinguishable without colour, and the glyph
  carries type. Verified by the pixel-diff loop, not by prose.
- **prior 15 — RingKit vendoring is weaker than claimed for marketplace installs, and global
  auto-merge removes the human gate.** Addressed by narrowing the claim: v1 ships RingKit as
  an in-repo module with one consumer and **no vendoring and no sync script**; the
  marketplace vendoring question is the captain's ship-time call (open question 1), and this
  plan assumes no automatic merge gate anywhere.
- **prior 10 and 11 — the levers.** Still out of v1 (Q1: monitor-first), but now named as an
  open lever inventory the captain arms explicitly later, including the finding that rung-1
  is documented by the engine as blocking or failing exactly when pressure is highest, and
  that automatic yield levers already exist on both sides. v1's contribution is the baseline
  log those decisions will be made from.
- **prior 21 — "never drop caches" reasoning is weaker than stated.** Not carried: this plan
  makes no claim about dropping caches. If PR 7's re-anchoring wants one, it is measured then,
  not asserted now.

## This attack's majors 6–15, where each landed

| Major | Verdict | Where it landed, in one line |
|---|---|---|
| 6 — "the critical thresholds ARE the ceilings" is false while oomd runs | **folded** (its oomd-alignment branch rejected) | Two ceilings shown side by side in the detail window, the tooltips, the prompt data block and the log: "your ceiling" (or "not set") versus "the kernel's ceiling" (oomd's PSI/swap limits); the plugin never writes a system limit (open question 2). |
| 7 — five btrfs subvolumes, five identical toasts, no device named; vanished mount | **folded** | `hdDeviceKey` device-level dedup for rows and alerts (one alert per device per crossing), plus `mostSevere()`'s absent-mount rule and Mount Monitor's keep-the-last-band rule. |
| 8 — nobody owns Memory Monitor's watch list | **folded** | B5: the mount-monitor widget's `mounts` setting read through `normalizeMounts`, with Memory Monitor's own `mounts` setting as the named no-sibling fallback; an empty list means no HD rows. |
| 9 — no named panel mechanism; manifest invisible to the registry | **folded** | `qs.Ui.Panel`/`PanelController`/`PanelSectionHeader`/`NumberField` named, the two third-party `Panel.qml` precedents cited, `open()`/`close()`/`opened` proven in PR 1, and the top-level install directory fixed in the repo layout; critical's click resolved through `qs ipc call`. |
| 10 — adaptive polling drops the shipped block-event path | **folded via its second branch** (first branch rejected) | One block monitor per machine, owned by Mount Monitor; Memory Monitor polls 60 s nominal / 20 s escalated / faster on PSI, and says why it does not run a second `udevadm monitor`. |
| 11 — a bar widget is instantiated once per monitor | **folded** | Screen-count-independent queue, notice lane, timers, log append and arm, with a test that two live instances produce one alert, one log row, one arm. |
| 12 — copy fidelity pins the wrong things | **folded, with the normalisation rejected** | `XX%` = the live reading; the parenthetical's type words named; onboarding and guard copy pinned in the plan; the spec's `System Ram`/`System RAM` kept verbatim and flagged (open question 4), as is the resource-less critical line. |
| 13 — the insist-guard re-fires a restart-surviving notice | **folded** | Stable `mem-guard-ask` identity, re-fired at shell start only, replaced via `notify-send -p` + `-r <id>`, recorded when delivered — Mount Monitor's `onboarded` discipline. |
| 14 — RingKit has one consumer and its bands will disagree | **folded, RingKit kept** | Framed as a bet, not a fact; a RingKit ↔ `mounts.js bandFor` conformance test pins the shared band semantics; contracts with no v1 consumer labelled as such. |
| 15 — the fold list claims more than it delivers | **folded** | The fold list is re-labelled: deferred items marked deferred and kept open, major 4's withdrawn fix named, and prior majors 15, 16, 18, 10, 11, 21 opened in *Fold list, corrected*. |

## Rejected, and why (named, not silently dropped)

- **Every band rides critical urgency** (this attack's blocker-3 option A) — rejected: it
  makes amber indistinguishable from a never-expiring emergency and erodes the one urgency
  that means "act now"; amber is instead silenced-by-DND and *recorded*.
- **Carry Mount Monitor's `udevadm` event path into Memory Monitor** (major 10's first
  branch) — rejected in favour of its second branch: the machine already runs one
  event-driven block monitor, owned by Mount Monitor; a second identical long-lived process
  buys nothing and is blocker 5's duplication. Memory Monitor's HD is a severity view of
  drives the machine already watches, on a 60 s nominal / 20 s escalated poll.
- **Drop or defer RingKit** (major 14's implied alternative) — rejected: it is the prior
  plan's architecture and the next consumer needs the contracts pinned now. What is accepted
  is the finding's real demand: call it a bet, and pin a band-semantics conformance test so
  the two HD alert engines cannot disagree.
- **The plugin aligning oomd's limits with the user's critical thresholds** (major 6's first
  branch) — rejected for the plugin: the spec's amendment forbids the app setting ceilings
  and Q1 forbids v1 writing system limits. Alignment is the captain's own hands (open
  question 2); v1 states which ceiling kills.
- **Normalising the spec's `System Ram` / `System RAM`** (major 12's first bullet) — rejected
  *in the plan*: the spec is the acceptance contract and out-bids the plan, so the copy ships
  verbatim and the inconsistency is flagged for the captain's ruling (open question 4). Tests
  pin each kind's own string so a normalisation is a visible, deliberate change rather than a
  silent one.

---

## Product contract (what ships in v1)

### Bar display

- **No alerts:** the Memory Monitor logo — a **full ring filled in white with the letters "MM"
  in white in the middle**. Plain white, plain Jane, no bold, no color.
- **Amber/red/critical:** the resource in trouble is shown — **only the MOST SEVERE alert**
  across all three types is displayed, resolved by `mostSevere()` (severity first, then
  smallest headroom to its critical line, then a fixed type order; deterministic and tested).
  `mostSevere()` has an explicit rule for an absent mount: an unmounted target is not severe,
  its badge drops, and a queued alert whose device is gone is dropped — the bar never names a
  device that is no longer on the machine. A configured target that is temporarily unmounted
  keeps its last band (Mount Monitor's shipped rule) so remounting at the same usage is not
  read as a new crossing.
- **Custom GRAPHIC badges for the three memory types:** hard drive badge (drive glyph), RAM
  badge (memory-chip glyph), VRAM badge (GPU-card glyph) — visually distinct at bar optical
  size (~22 px). Color carries severity: red `#ff2d2d` (Mount Monitor's `alertRed`, reused),
  amber `#fbbf24` — a new RingKit palette token, since Mount Monitor ships only `alertRed`
  (`MountMonitor.qml:78`) — and critical glowing red (v1's pulse + halo treatment, reused).
- **Severity also carries shape** (prior major 18): amber = partial/hollow ring fill, steady
  badge; red = full badge plus a warning glyph; critical = the pulse and halo on top. A
  latched band renders as latched. Color-blind redundancy: glyph = type, shape = severity,
  pulse = critical, and the tooltip and detail window always carry the numbers in text.

### Thresholds

- **Amber = 80% default. Red = 90% default. Critical = user-set, unset until set** — any value
  strictly between red and 100%. `validateThresholds`: `0 < amber < red < critical < 100`, with
  `critical` permitted to be unset, in which case no critical band exists for that type.
- **ONE critical manual threshold control per memory type** — hard drive, VRAM, system RAM,
  type-wide (never per mount or device). Amber and red are likewise type-wide, settable, with
  defaults 80/90.
- Thresholds live in `~/.local/state/memory-monitor/settings.json`, written only by the
  onboarding ceiling question (B2) and the detail window's value boxes, and read through a
  `normalize*` helper like every setting in this repo. **No seeded critical value.** Each
  value carries `setBy: "user" | null` and a timestamp.
- Bands follow the spec's percent-used model on all three types, with the **RAM numerator
  named** (B1): `(MemTotal − MemAvailable) / MemTotal`. Honesty about what used% hides is
  delivered by the *picture* plus the PSI re-alert gate, not by moving the captain's
  thresholds: the detail window and tooltips always show the complementary truth — available
  memory in absolute GiB, PSI, swap, zram, oomd's numbers, free VRAM, consumers.

### Adaptive polling

- "Monitoring occurs MORE OFTEN on the resource that triggers a red alert."
  `pollIntervalMs(resource, band)` decides in RingKit: nominal per resource (HD 60 s via the
  findmnt pattern; RAM 30 s — `/proc` reads are file reads; VRAM 60 s via one
  `nvidia-smi --query-gpu=…` call, **measured 22 ms per query on this rig 2026-11-03** — the
  prior plan's 12–14 ms is not this machine's number, same order of magnitude, conclusion
  unchanged), escalated for any resource at red or critical (proposed 20 s HD/VRAM, 10 s RAM),
  and escalated further whenever PSI memory is above the stall floor. Restored after a descent
  holds. Escalation and restore are tested decisions, not timer folklore.
- **No second block monitor** (B5, major 10): Memory Monitor runs no `udevadm monitor`; Mount
  Monitor's shipped one is the machine's event-driven block watcher, and Memory Monitor's new
  -drive awareness comes from Mount Monitor's onboarding, not its own scan.

### Click-to-open detail window

- Click widget → a **widget-owned panel built on the shell's own primitives**, named now
  rather than discovered in PR 4: `qs.Ui.Panel`, `PanelController`, `PanelSectionHeader`,
  `PanelSeparator`, `NumberField`, `PopupCard`, imported alongside `qs.Commons` exactly as the
  two third-party precedents do — `mrpbennett.sesh` and `io.github.ylaung-uod.omarchy-rdp` are
  both `bar-widget`-only third-party plugins whose entry point is `Panel.qml`. `Bar.qml`
  duck-types widgets exposing `open()` / `close()` / `opened` to route panel hotkeys, so the
  widget exposes all three. **PR 1 proves a panel opens from a bar-widget manifest before PR 4
  builds its contents.**
- Contents:
  - **HD:** one row per monitored mount — target, device, percent used, band, latched flag —
    grouped under its device, with the device-level band shown once.
  - **RAM:** used/total percent **with the numerator named in the label**, available (absolute
    GiB + %), PSI `some`/`full` avg10/60/300, swap used% (zram and swapfile separately), zram
    fill and compression ratio, the stall-floor state, and the oomd block.
  - **VRAM:** total, used, free (absolute MiB beside every percent), per-compute-app
    breakdown, the clamped unattributed desktop/compositor remainder, adaptive-poll state.
  - **Alerts you did not see:** amber events silenced by DND (B3).
  - **Two ceilings, side by side** (major 6): "your ceiling" (the user's critical line, or
    "not set") and "the kernel's ceiling" (oomd's PSI limit/duration and swap limit, or
    "oomd not running").
- **Thresholds are set there:** a value box per threshold (amber, red, critical for each of the
  three types — one critical control per type), adjustable three ways per the spec: up/down
  arrow **clicks**, by **typing**, or by **arrow keys** (up/right = increment, down/left =
  decrement; step 1 percentage point). `qs.Ui.NumberField` wraps a spinbox, and in a focused
  editable field left/right are cursor keys — so PR 4 **names the widget and the key mapping**
  (spinbox step buttons for the click mode, an explicit key override that only applies when the
  field is not in text-editing mode, or a `TextField` + step-button pair) and **demonstrates
  all three modes or states which two it ships**. No promise without a mechanism.
  Edits validate live (`amber < red < critical < 100`) and persist to the settings state file.
- A latched band shows as latched. An unavailable measurement (tool missing) shows as
  unavailable — never as 0%.

### Toast copy — verbatim from the spec

Templates are fixed copy in `memory.js`, identical for every device of a type. The
`(HD/VRAM/System Ram)` parenthetical resolves to the troubled resource's type word, **named
here so a character-pinned test cannot freeze whatever an implementer types**: `Hard drive`,
`VRAM`, `System Ram` (amber) / `System RAM` (red). The spec's two spellings are kept exactly
as captured and flagged for the captain (open question 4).

**`XX%` is the live reading, rounded up to a whole percent — not the threshold.** The previous
revision interpolated the threshold, which understates the emergency by exactly the margin
that matters (a mount at 97% against a 95% ceiling was told "reached 95%"). Amber and red
have the same problem when a poll jumps past the line: the copy reports what was measured.
The threshold is shown in the detail window, the tooltip, and the log.

| Kind | Title | Body (verbatim template) |
|---|---|---|
| amber | `Memory Monitor` | `Caution: Amber Alert` ⏎ `Device (HD/VRAM/System Ram) has reached 80% usage.` ⏎ `Click to address with agent, otherwise ignore.` |
| red | `Memory Monitor` | `WARNING: RED ALERT` ⏎ `Device (HD/VRAM/System RAM) has reached 90% usage.` ⏎ `Click to open an agent to actively monitor/guard against OOM, otherwise ignore.` |
| critical | `Memory Monitor` | `CRITICAL ALERT!` ⏎ `Device has reached XX% usage.` ⏎ `Agent has been notified and is guarding against OOM.` |
| critical, guard off | `Memory Monitor` | `CRITICAL ALERT!` ⏎ `Device has reached XX% usage.` ⏎ `The standing guard is off. Click to open an agent, otherwise ignore.` |
| critical, guard failed | `Memory Monitor` | `CRITICAL ALERT!` ⏎ `Device has reached XX% usage.` ⏎ `The guard could not start. Click to open an agent, otherwise ignore.` |

- Toast on every amber, red, and critical **alert event** (spec Q2), where an event is a band
  ascent or one of B1's re-fire conditions — not a standing state. `primed` is carried.
- **Urgency and lanes:** amber = normal urgency, bounded timeout, watchdog-released band lane,
  silenced by DND but recorded (B3). red = **critical urgency** (the DND bypass), timeout 0,
  never-expiring notice lane. critical = critical urgency, timeout 0, never-expiring notice
  lane, and **band escalation preempts an unanswered lower-band toast**.
- **Critical's arm happens at queue time** (B4): the widget launches the agent prompt itself,
  single-flight and budget-gated, so the copy's claim is true *when it is emitted*; the
  guard-off and guard-failed variants are what the widget emits when it is not.
- **Click actions:** amber and red = the agent prompt. critical = open the detail window
  through `["qs","ipc","call","memory-monitor","openDetail"]` — never a second agent on top of
  the armed one.
- The dual click path is carried verbatim from Mount Monitor:
  `-h STRING:omarchy-exec-argv:<json argv>` hint (survives shell restarts via persisted
  history) plus the live `-A default=` action. The argv is a typed list through `agentArgv` —
  default `["omarchy","agent","prompt",prompt]` = `omarchy-default-agent` (spec Q4),
  `agentCommand` setting overridable. Nothing a measurement reads (process names, mount
  labels) ever enters an instruction sentence; numbers and names ride the delimited untrusted
  data block.

### Log AND arm from day one (spec Q5)

- The monitor arms at install (monitoring + alerts live immediately) **and** every poll sample
  is appended to a rotating, size-capped log under
  `~/.local/state/memory-monitor/baseline.log`.
- **The log records absolute numbers, not only percentages** (minor 2): timestamp; per
  monitored mount target/device/used bytes/available bytes/percent/band/latched; RAM total,
  used, available (kB), used%, PSI `some`/`full` avg10/60/300, swap used/total per device,
  zram disk/data/compr/total; VRAM total/used/free MiB, per-app sums, unattributed remainder;
  oomd block; the widget's band decisions, hysteresis state, poll interval, arm records (pid,
  outcome, survived), and every alert event with its delivery verdict (`shown |
  silenced-dnd | unknown`). A percent-only log cannot answer "how fast did it climb", and PR 7
  and the fleet side both need the raw numbers.
- Logging never blocks monitoring — a failed log append is logged to the console and monitoring
  continues. The append is idempotent per sample (major 11): one writer instance, chosen by a
  deterministic rule, so N bar surfaces do not produce N copies of one sample.
- The log is the re-anchoring dataset (PR 7) and the fleet side's data source: spec Q1's fleet
  note (captain and firstmate throttle Strata together at critical) lives in firstmate's
  surface, outside this plugin; the log is what gives it the same numbers.

### Onboarding (install-time, spec section)

- **RAM and VRAM are always monitored** — they are the point of the plugin — and the onboarding
  notice counts them as watched.
- **HD follows the ask-first law as already shipped** (B5): Memory Monitor runs no partition
  scan and no partition notice of its own; its HD watch list is Mount Monitor's `mounts`
  setting (or its own, when Mount Monitor is absent).
- **The ceiling question (B2) is the onboarding centrepiece**, in the spec's order: report the
  measured first-run reading per type, recommend from it, say what each line means on this
  machine, ask the user to set amber/red/critical per type, record what he set.
- **The insist-guard step:** the onboarding asks whether the user wants the guard against OOMs,
  and insists that it does guard. Copy is pinned here, not left to implementation:
  - title `Memory Monitor — the guard`, body
    `Memory Monitor watches System RAM, VRAM and your drives.` ⏎
    `The guard is the agent that steps in when a critical line is crossed.` ⏎
    `It does guard: it runs when your critical threshold is reached.` ⏎
    `Turn it on?`
  - Identity discipline (major 13): a never-expiring critical-urgency notice **survives shell
    restarts**, so the insist-guard carries a stable identity (`mem-guard-ask`, one question
    per install per machine), is **re-fired at shell start only** (never on a timer), replaces
    rather than accumulates — the widget captures the id from `notify-send -p/--print-id` and
    re-sends with `-r <id>`, which the service honours as freedesktop `replaces_id` — and is
    recorded **when delivered** — a notice dropped on a
    machine that went away leaves no record and is asked again when it returns. This is Mount
    Monitor's shipped `onboarded` / delivered-at-queue-time discipline, applied here.
  - On yes: run the **system health check** (agent + `memory-health` skill — largest consumers
    of RAM/VRAM/HD, recommend throttling/pruning options; read-only analysis, nothing killed or
    throttled without the captain's word), then arm the standing guard and record it armed.
  - On decline: record it; monitoring continues; the standing guard stays off; a critical still
    notifies the user through the **guard-off copy** (B4), never through a sentence that claims
    the agent is guarding.
- **Onboarding answers must produce a verified arm:** "asked" is not "armed"; the state file
  records the difference and the detail window shows it.
- Onboarding decisions merge, never replace; deleting the state dir re-runs first run.

### Skills (spec Q6)

- Skills are determined WITH the user during onboarding and during normal use; they trigger at
  threshold levels. v1 ships the seed: **`memory-health`** — consumer analysis, throttle/prune
  recommendations, guard stance; analysis-only law like `disk-prune`.
- **Skill-name ownership is named** (minor 9): Memory Monitor ships `memory-health` and nothing
  else; `disk-prune`, `partition-onboarding` and `partition-remove` belong to Mount Monitor.
  `install.sh` replaces skill directories wholesale, so no name may be shipped by both — a
  shared name would let installing one plugin clobber the other's copy.

### The one design: RingKit (a bet, stated as one)

RingKit (per the prior plan) is the pure-decision module intended to be shared by this repo's
plugins: palette tokens, threshold validation, band resolver, hysteresis/ascent-descent state
machine, most-severe selector, poll-interval escalation, badge/tooltip parameters, and the
trust primitives this repo already perfected (`sanitizeText`, untrusted data block,
fixed-prompt builder, minted instance ids + validation). Plain top-level `function`
declarations, no imports, `node:vm`-testable — the mounts.js law, so both consumers hold.

Honest framing (major 14): **in v1 RingKit has one consumer.** Mount Monitor's migration onto
it is out of v1 scope and its decisions stay in `mounts.js`. That is a bet paid now and cashed
in later, not a fact, and the divergence risk it creates is closed by a test rather than by
prose:

- **Band-semantics conformance test:** RingKit's band resolver is tested against
  `mounts.js bandFor` on the same fixtures (80/90/98 step function), so the two HD alert
  engines running on the same drives cannot disagree about which band a given percentage is.
  RingKit's hysteresis is additive on top of the same step function, not a different step
  function.
- Contracts written for consumers that do not exist in v1 (the cursor-marker rule) are labelled
  as such in the module and in this plan.
- No vendoring, no sync script, no marketplace copy of RingKit in v1 (prior major 15).

## Repo layout (per the captain's ruling: sibling plugin in this repo)

```
ringkit.js                     ← shared pure-decision module (repo root)
tests/ringkit*.test.mjs        ← its tests, wired into tests/run.sh
memory-monitor/                ← the sibling plugin, self-contained
  manifest.json                ← io.github.jasonlnheath.memory-monitor, kinds [bar-widget]
  MemoryMonitor.qml            ← bar widget + detail panel: state, processes, timers, drawing
  memory.js                    ← all v1 decisions (the mounts.js of this plugin)
  install.sh                   ← walks memory-monitor/skills/ (replace, never merge)
  README.md
  skills/memory-health/SKILL.md
  tests/run.sh  tests/*.test.mjs  tests/fixtures/
```

**Installability is a PR 1 fact, not a PR 4 discovery** (major 9). `PluginRegistry.qml`'s
`scan_thirdparty` reads only `~/.config/omarchy/plugins/*/manifest.json` — "Third-party
plugins stay at the top level" — so a manifest at `memory/memory-monitor/manifest.json` inside
this checkout is **invisible to the shell**. The plugin therefore installs at its own top-level
directory, `~/.config/omarchy/plugins/io.github.jasonlnheath.memory-monitor/`, its `install.sh`
hard-checks that its own path matches that directory (the way Mount Monitor's `install.sh`
does), and `omarchy plugin add <git-url>` is only viable if the repo layout the shell sees has
the manifest at the top level. The panel lives in the same widget directory as the two
third-party precedents put theirs.

`memory.js` owns every decision — thresholds, numerators, parsers, bands, hysteresis, PSI gate,
swap escalation, device dedup, severity, poll intervals, oomd discovery, toast templates,
prompts, onboarding and guard copy — exactly as mounts.js does for Mount Monitor;
`MemoryMonitor.qml` keeps state, processes, timers, and drawing and builds every argv through
`Memory.*Args()`. Plain-JS module law applies to both JS files.

**Multi-monitor rule (major 11).** `Bar.qml` instantiates a widget once per screen, so a
widget that appears once in the layout is live N times. This rig has one monitor, which is why
the finding belongs in the plan and not in a bug report: Memory Monitor's alert queue, notice
lane, adaptive-poll timers, baseline log append, and the critical arm are
**screen-count-independent** — single-flight guards keyed on the event identity, one log writer
per sample chosen by a deterministic rule, and one arm per machine. A test asserts that two
live instances produce one alert event, one log row, and one arm.

## Deliverable steps, sized as PRs

| PR | Delivers | Owns the decisions in |
|---|---|---|
| 1 | Scaffolding + **RingKit**: `ringkit.js`, repo-root tests wired into `tests/run.sh`, `memory-monitor/` skeleton (manifest, empty widget shell, run.sh), **the install layout proven** (top-level plugin directory, `install.sh` path guard) and **a panel proven to open from a `bar-widget`-only manifest** using `qs.Ui.Panel` / `PanelController` and the `open()`/`close()`/`opened` contract | ringkit.js, install.sh |
| 2 | **Measurement + band decisions**: parsers and argvs (findmnt HD rows; meminfo/PSI/swaps/zramctl; nvidia-smi memory + compute apps + clamped unattributed remainder), `ramUsedPct` numerator, `validateThresholds` with unset critical, band evaluation + measured hysteresis, `psiStallFloor` re-alert gate, swap/zram escalation, `hdDeviceKey` device dedup, absent-mount rule, `mostSevere`, `pollIntervalMs`, oomd discovery/parse, baseline record schema (absolute numbers) + append/rotate rules, toast templates + dispatch (`promptFor`/`titleFor`/`actionFor`/`bodyFor`/`urgencyFor`/`timeoutFor`), `agentArgv` | memory.js |
| 3 | **Bar widget**: MM logo ring (white, plain), three graphic badges, severity-by-shape (amber hollow / red glyph / critical pulse+halo), most-severe display with the absent-mount rule, adaptive-poll timers, child-process timeout/watchdog/backoff hardening, state FileView, baseline logging wired to every sample, band-escalation preemption + 120 s watchdog in the alert queue, **screen-count-independent queue/append/arm guards**, **the visual verification loop** (install to the plugins directory, `omarchy restart shell`, grim pixel-diff of the bar against the previous render — plugin QML does not hot-reload, and eyeballing two unchanged screenshots reads as a change) | MemoryMonitor.qml |
| 4 | **Detail window**: click-to-open panel with the full per-type picture (absolute GiB/MiB beside every percent, swap/zram, PSI, oomd block, clamped unattributed VRAM row, "your ceiling" vs "the kernel's ceiling", "Alerts you did not see", latched/unavailable visibility), threshold value boxes with the **named** widget and key mapping for all three input modes, live validation, persistence to the settings state file | MemoryMonitor.qml + memory.js validators |
| 5 | **Toasts + agent routing**: notify-send plumbing with the dual click path, verbatim copy emission (character-pinned per kind at defaults), amber normal-urgency + DND-silenced-but-recorded, red critical-urgency/timeout-0 bypass, critical timeout-0 law, `notifications.json` `dnd` read, critical proactive arm on the single-flight budget-gated lane with the guard-off and guard-failed copies, `--inline` versus terminal measured on the rig, `qs ipc call` click for critical | memory.js copy + QML lanes |
| 6 | **Onboarding + skills**: the ceiling question (per-type report → recommendation → ask → record `setBy`), the insist-guard ask with its pinned copy and its delivered-at-queue-time identity, health-check run + verified arm, `memory-health` skill seed, sibling `install.sh`, **the visual verification loop for the onboarding notices** | memory.js onboarding + skills/ |
| 7 | **Week-two re-anchor** (time-gated: after one week of baseline logs): distributions from the log → **recommended** thresholds, descent margins, `psiStallFloor`, VRAM anchors, and the arm budget; report to the captain; approved values applied only as defaults for ceilings the user never set, and as proposals the user accepts in the detail window | report + memory.js defaults |

Every PR keeps `bash tests/run.sh` green (node:test suites with fixtures for every parser,
verbatim-copy pins per kind, hostile-label regression carried into the sibling, delegation
guards asserting the QML builds its argvs through `Memory.*Args`, the RingKit ↔ `bandFor`
conformance test, the multi-instance single-alert/single-log/single-arm test, install.sh syntax
check, the skills/SKILL.md check, qmllint on the new QML). **There is no CI in this repo**
(`.github/` holds issue templates only), so `bash tests/run.sh` is a local convention enforced
per PR, and the visual deliverables (PRs 3, 4, 6) are verified by the install → restart →
pixel-diff loop, including the recorded hazard that a `shell.json` plugin entry has silently
vanished twice in one day.

## Contracts carried from Mount Monitor (non-negotiable)

- **Device/process text is data, never instructions.** Mount labels, process names, and consumer
  lists are written by whoever ran them; they ride the delimited untrusted data block through
  `sanitizeText` and never enter an instruction sentence. Prompts are fixed copy, identical per
  kind. `tests/label-injection`-equivalent is a gate from PR 2 onward.
- **Typed argv everywhere.** No shell strings; the daemon's `parseExecArgv` must accept what we
  hint.
- **Every setting through a `normalize*` helper**; Qt lists round-trip through JSON before
  `Array.isArray`; a non-list falls back to the documented default.
- **Only-most-severe in the bar; every alert event still toasts.** The bar dedupes for
  legibility; the toast stream does not silently drop a lower-band alert that fired — with the
  DND rule (B3) as the one place the daemon, not the plugin, decides delivery, and the plugin
  recording it.
- **Critical = critical urgency, timeout 0, own process lane; red = critical urgency for the
  DND bypass, same lane; amber = normal urgency on the watchdog-released lane.** A question
  nobody answered must never hold a worse warning.
- **State file law:** write only on change; a scan that exits non-zero records nothing;
  onboarding decisions merge, never replace; deleting the state dir re-runs first run.
- **A plugin never auto-discovers what it was not asked to watch** — HD monitoring follows the
  ask-first law through the existing `mounts` setting; RAM/VRAM are the plugin's purpose and
  need no ask.
- **Never set a ceiling the user did not set** (spec amendment): not a system limit, not a
  seeded critical, not a re-anchored value written over his.
- **Version changes in any manifest.json need the captain's explicit word.**

## Omarchy protection law applied to this plugin

Nothing fails silently: a missing tool (nvidia-smi, zramctl), a missing oomd, a silenced amber,
a failed agent arm, an arm that could not fit, an arm killed by oomd, a failed log append, a
wedged child process, a PSI-less kernel, an unset critical line, a band whose descent margin is
unreachable — each has a surfaced state (detail window, one-time notice, or console log as
appropriate) and a defined degradation; the widget never shows a confident 0% for an unknown,
and monitoring never stops because a side channel died. "We're always guarding against OOM.
Number one is to protect the health of Omarchy" (spec Q6) — this plugin's contribution is honest
visibility, honest logging, an agent that is told the truth, and no sentence the widget cannot
back up.

## Out of scope for v1

- Any automatic lever or kill path (rung-0 automatic yield — `min_free_vram_mib`, `idle_unload_s`,
  `MemoryHigh` on strata.service — is a later phase the captain must explicitly arm; Q1 makes v1
  monitor-first, and the spec's amendment forbids the app setting ceilings). The lever inventory
  (prior majors 10 and 11) stays open for that phase.
- Journal GL-signature watching (the incident class is unclassified; the baseline week informs
  whether v1.x adds it, with the cursor rule from the RingKit contract).
- Fleet-side throttle actions (firstmate's surface; the log feeds it).
- Mount Monitor's migration onto RingKit; **any change to Mount Monitor's shipped code,
  including retiring its 80/90/98 alerts** (the captain's word, open question 3); separate
  marketplace listings; multi-GPU (first card only, named honestly in the detail window).
- **A non-quickshell alert path.** Named against blocker 3 rather than next to it: the
  quickshell/`notify-send` path is the one that silently drops a non-critical alert under DND,
  and the alternative was considered and rejected for v1 in favour of the urgency-and-record
  rule, because a second alert surface would compete with the history the captain already has.

## Open questions for the captain (none block the build)

1. **Ship mechanics:** sibling-in-this-repo now (its own top-level plugin directory, per the
   registry's top-level-only rule); a separate marketplace listing/repo with RingKit vendored is
   the captain's call at release.
2. **oomd alignment:** align oomd's PSI/swap limits with the user's critical thresholds (the
   captain's own hands, never the plugin's), or accept the plan's two-ceilings wording — "your
   ceiling" and "the kernel's ceiling" — as the product's honest answer.
3. **HD ownership follow-up:** keep the v1 rule (Mount Monitor owns which drives are watched and
   alerts the drives it watches; Memory Monitor shows HD severity and alerts only what Mount
   Monitor does not), or retire Mount Monitor's own 80/90/98 alerts so Memory Monitor owns every
   HD alert. The second changes a shipped product.
4. **Copy rulings:** keep `System Ram` (amber) and `System RAM` (red) exactly as dictated, or
   normalise; and should the critical toast name the resource — the spec's critical line names
   none, and "guarding against OOM" is the wrong failure mode for a full disk. Proposed minimal
   change, needing the captain's word: `Device has reached XX% usage.` →
   `System RAM has reached XX% usage.`
5. **Guard-off and guard-failed copy** (B4): the plan has written both; they change the spec's
   copy family and need the captain's blessing.
6. **DND policy for amber:** the plan's answer is *silenced but recorded*, with an "Alerts you
   did not see" section. If the captain wants amber to bypass silence too, that is a one-line
   urgency change with the never-expiring-toast consequences spelled out in B3.

## Minor findings folded into this revision

- **Swap has no threshold (minor 1)** → swap/zram as RAM severity escalators and re-fire
  conditions, at oomd's swap limit; not a fourth thresholded type; stated at onboarding.
- **Log schema too thin (minor 2)** → absolute bytes/kB/MiB and the raw RAM/VRAM/oomd/arm/alert
  records, not percents only.
- **No visual verification loop, no CI (minor 3)** → the install → `omarchy restart shell` →
  grim pixel-diff loop written into PRs 3, 4 and 6, plus the vanished-`shell.json`-entry hazard
  and the no-CI reality.
- **`NumberField` versus three input modes (minor 4)** → PR 4 names the widget and the key
  mapping and proves all three modes or states which two it ships.
- **Unattributed VRAM row (minor 5)** → clamped at zero, labelled with what it is not.
- **VRAM percent bands fire below the documented healthy reserve (minor 6)** → VRAM bands ship
  provisional, every VRAM band shows absolute MiB free beside the percent, and PR 7 re-anchors
  them from the measured week.
- **i18n (minor 7)** → stated as a decision, not an accident: v1 is English-only, and the
  character-pinned copy tests are the acceptance contract; a translation surface is a later,
  explicit product call.
- **Rename ripple (minor 8)** → distinct id prefix (`mem-<8hex>-<8hex>`), distinct state paths,
  product-named notice titles (`Memory Monitor — …`), no shared `mm-` prefix.
- **Skill clobbering (minor 9)** → named ownership: `memory-health` is Memory Monitor's; the
  three Mount Monitor skills stay Mount Monitor's.
- **Deferred arm-failure copy (minor 10)** → written in this plan (B4), not left to
  implementation.
- **Out-of-scope alert path next to a known silent drop (minor 11)** → recorded in Out of scope
  with the alternative named and rejected.
- **Stale spec header (minor 12)** → **noted, not fixed here**: the spec file's own
  `Status: PARTIAL` header is the spec record's correction to make; this plan cites the
  ratified "spec COMPLETE" + Amendment + Clarification sections as the acceptance contract.
- **Optimistic `nvidia-smi` cost (minor 13)** → corrected to 22 ms per `--query-gpu` call on
  this rig (2026-11-03); the design conclusion is unchanged.
