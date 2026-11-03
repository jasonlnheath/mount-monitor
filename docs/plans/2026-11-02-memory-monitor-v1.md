# Plan: Memory Monitor v1 — monitor-first build (sibling plugin)

The captain delivered the full product spec at bedtime 2026-11-02, verbatim capture at
`~/Work/firstmate/data/memory-monitor/spec-captain-2026-11-02.md` (firstmate home). That
spec is the acceptance contract: all six design calls (Q1–Q6) are answered and the spec is
complete for v1. Three inputs are folded into this plan:

1. **The spec** (authoritative — where it conflicts with either other input, the spec wins).
2. **The prior suite plan** (`~/Work/firstmate/data/rm-suite-plan/plan.md`) — architecture,
   RingKit, platform facts, what Mount Monitor v1 proves.
3. **The adversarial attack** (`~/Work/firstmate/data/rm-suite-attack/report.md`) — 3
   blockers + 22 findings; the four the captain named to fold are the visibility-first
   rescope, the oomd reality, the one-action toast surface, and the measurement gaps.

**Ruling that shapes v1 (spec Q1): ship as a MONITOR FIRST.** Alerts can be used to
trigger throttling/actions later; v1 monitors, surfaces, logs, and routes to the agent.
The plugin itself never kills, throttles, or unloads anything — levers are determined
together with the captain (Q2) and act through the agent and the captain's own hands.

## The attack folds, honestly

- **Oomd reality (blocker 1).** The rig already runs `systemd-oomd`: active, configured by
  Omarchy at pressure ≥ 50% sustained 20s and swap ≥ 90%, watching `app.slice`, and it has
  already marked `strata.service` for killing (2026-10-29, swap at 100%). "OS-first, Strata
  yields" is installed policy, not our invention. v1 therefore designs as **visibility into
  the guard**, not the guard: it discovers oomd's live limits and watched cgroup
  (`systemctl is-active systemd-oomd` + `oomctl`), surfaces them in the detail window, the
  tooltips, the agent prompt's data block, and the log, and states the relationship plainly
  — our spec thresholds (percent-used bands) and oomd's PSI/swap rules are different
  signals; the widget makes both visible so the human and the agent see how close the
  kernel-side killer is. When oomd is absent it says so; no invented numbers.
- **One-action toast surface (blocker 2).** Omarchy's notification card carries exactly one
  click action (`invokePopupDefault`: exec hint first, then the single `default` action).
  The spec copy is already one-action compliant: every toast's single line of instruction
  is "Click to …, otherwise ignore" — one action, implicit dismiss. No multi-button toasts
  anywhere in v1. Rung choices, if the captain wants them later, live in the widget-owned
  detail panel, never in a notification.
- **Measurement gaps (majors 4–9, 19–20, 22b).** Prior-plan band numbers were anchored to
  stale or invented constants (a 2000 MiB reserve that does not exist; a red VRAM line
  inside the rig's documented healthy range; a ~600 MiB kill line the incident contradicts).
  Fold per the captain's word: **v1 ships armed with spec-default thresholds AND a one-week
  baseline logger runs alongside the armed monitor**, recording the raw measurement set;
  thresholds are then re-anchored from the measured distribution before any number is
  treated as final (PR 7). VRAM bands especially stay provisional until that week speaks.
- **Swap in the RAM picture (major 5).** The recorded emergency was a **swap** rule firing
  at 100% swap. The RAM measurement set is MemAvailable + PSI + **swap used% + zram fill%
  + zram compression ratio** (`/proc/swaps`, `zramctl`), and swap climbing is surfaced as
  the earlier signal on this machine.
- **Consumer visibility (major 9).** `nvidia-smi --query-compute-apps` cannot see the
  compositor and shell; the VRAM picture carries an explicit **"desktop / compositor
  (unattributed)"** row computed as `used − Σ(compute apps)`, and the desktop is the thing
  the red band exists to protect.
- **Queue and watchdog law (major 13).** v1's alert queue works; an unanswered toast holds
  it, and `notify-send` blocks while its action is live. The RingKit contract carries v1's
  watchdogs explicitly: bounded queue depth, a 120 s watchdog release, and **band
  escalation preempts an unanswered lower-band toast** rather than queueing behind it.
- **Cursor-marker defect (major 14).** The fleet check's journal dedupe stalls its cursor
  during sustained low-VRAM periods and replays the whole window on recovery. v1 skips
  journal-signature watching entirely (out of scope, below); the rule is still written into
  the RingKit contract for any future consumer: advance the marker on every run, cap the
  window.
- **Agent identity (blocker 3) — resolved by the spec.** The attack recommended wiring to
  firstmate's intake; the captain's Q4 ruling overrides it: **alerts route to
  `omarchy-default-agent`** — "Product routes to whatever agent the user's system names
  default." That is exactly Mount Monitor's existing default argv
  (`["omarchy","agent","prompt",prompt]`), with the `agentCommand` setting still available
  as the user's override. The honest cost the attack found is carried, not hidden: the
  remediation agent is itself a memory consumer (~250 MB for hermes), so the *proactive*
  arm fires only at critical, and the log records every arm.
- **Marketplace-shipped skills (major 12).** `install.sh` copies `skills/*/` into
  `~/.agents/skills`, which every agent on the machine loads. v1 ships only generic,
  analysis-only skill seeds (health check, consumer report); **Strata-specific action
  instructions never ship from the plugin** — Q6 makes skills something developed WITH the
  user during onboarding and normal use, which is exactly the gate the attack asked for.
- **Rig facts age (major 20).** Every rig number quoted here was measured 2026-11-02 by the
  attack; none is load-bearing for a shipped threshold until the baseline week confirms it.
- **Process lifecycle (major 22a).** Every child process gets Mount Monitor's hardening:
  timeouts, watchdog release, one-at-a-time lanes, restart backoff. A wedged `nvidia-smi`
  must not wedge the bar.
- **Latching (major 4).** Descent margins are reachable (2 pp above the ascent line, held
  3 polls), and a latched band is visible as latched in the detail window — a stuck band
  must never read as healthy.

## Product contract (what ships in v1)

### Bar display

- **No alerts:** the Memory Monitor logo — a **full ring filled in white with the letters
  "MM" in white in the middle**. Plain white, plain Jane, no bold, no color.
- **Amber/red/critical:** the resource in trouble is shown — **only the MOST SEVERE alert**
  across all three types is displayed, resolved by `mostSevere()` (severity first, then
  smallest headroom to its critical line, then a fixed type order; deterministic and
  tested).
- **Custom GRAPHIC badges for the three memory types:** hard drive badge (drive glyph),
  RAM badge (memory-chip glyph), VRAM badge (GPU-card glyph) — visually distinct at bar
  optical size (~22 px). Color carries severity: amber `#fbbf24`, red `#ff2d2d` (Mount
  Monitor's `alertRed`), critical glowing red (v1's pulse + halo treatment, reused).
  Color-blind redundancy: the pulse marks critical; the glyph marks identity; the tooltip
  and detail window always carry the numbers in text.

### Thresholds

- **Amber = 80% default. Red = 90% default. Critical = user-set**, any value strictly
  between red and 100% (`validateThresholds`: `0 < amber < red < critical < 100`).
- **ONE critical manual threshold control per memory type** — hard drive, VRAM, system RAM
  get one control each, type-wide (never per mount/device). Amber and red are likewise
  type-wide, settable with defaults 80/90.
- Thresholds live in the plugin's state file (`~/.local/state/memory-monitor/settings.json`,
  seeded 80/90/95), written by the detail window's value boxes; they are read through a
  `normalize*` helper like every setting in this repo. Proposed critical default 95 — the
  user adjusts it in the window; the value is theirs by design.
- Bands follow the spec's percent-used model on all three types (the spec is the contract;
  the prior plan's headroom-anchored bands are not adopted). Honesty about what used%
  hides is delivered by the *picture*, not by moving the captain's thresholds: the detail
  window and tooltips always show the complementary truth — available memory, PSI, swap,
  oomd's numbers, free VRAM, consumers.

### Adaptive polling

- "Monitoring occurs MORE OFTEN on the resource that triggers a red alert."
  `pollIntervalMs(resource, band)` decides in RingKit: nominal per resource (HD 60 s via
  the findmnt pattern; RAM 30 s — `/proc` reads are file reads; VRAM 60 s via one
  `nvidia-smi --query-gpu=...` call, measured 12–14 ms even saturated), escalated for any
  resource at red or critical (proposed 20 s HD/VRAM, 10 s RAM), restored after a descent
  holds. Escalation and restore are tested decisions, not timer folklore.

### Click-to-open detail window

- Click widget → a widget-owned panel (the way Omarchy's own panels work) showing ALL fine
  details:
  - **HD:** one row per monitored mount — target, device, percent used, band, latched flag.
  - **RAM:** used/total, available (absolute + %), PSI `some`/`full` avg10/60/300,
    swap used% (zram + swapfile separately), zram fill and compression ratio, and the oomd
    block (active?, pressure limit/duration, swap limit, watched cgroup).
  - **VRAM:** total, used, free, per-compute-app breakdown, the unattributed
    desktop/compositor remainder, adaptive-poll state.
- **Thresholds are set there:** a value box per threshold (amber, red, critical for each of
  the three types — one critical control per type), adjustable three ways per the spec:
  up/down arrow **clicks**, by **typing**, or by **arrow keys** (up/right = increment,
  down/left = decrement; step 1 percentage point). Edits validate live
  (`amber < red < critical < 100`) and persist to the settings state file.
- A latched band shows as latched. An unavailable measurement (tool missing) shows as
  unavailable — never as 0%.

### Toast copy — verbatim from the spec

Templates are fixed copy in `memory.js`, identical for every device of a type. The
`(HD/VRAM/System Ram)` parenthetical resolves to the troubled resource's type word, and the
percentage interpolates the resource's live threshold; at the default thresholds the
emitted copy matches the spec character-for-character. The critical template's own `XX%`
proves interpolation is intended. Both template variants of "System Ram"/"System RAM" are
kept exactly as the spec captured them.

| Kind | Title | Body (verbatim template) |
|---|---|---|
| amber | `Memory Monitor` | `Caution: Amber Alert` ⏎ `Device (HD/VRAM/System Ram) has reached 80% usage.` ⏎ `Click to address with agent, otherwise ignore.` |
| red | `Memory Monitor` | `WARNING: RED ALERT` ⏎ `Device (HD/VRAM/System RAM) has reached 90% usage.` ⏎ `Click to open an agent to actively monitor/guard against OOM, otherwise ignore.` |
| critical | `Memory Monitor` | `CRITICAL ALERT!` ⏎ `Device has reached XX% usage.` ⏎ `Agent has been notified and is guarding against OOM.` |

- Toast on every amber, red, and critical alert (spec Q2), on band ascent with the
  `primed` baseline rule carried (a shell restart does not re-toast existing bands; true
  emergencies always fire).
- Amber/red: normal urgency, bounded timeout, single click action = the agent prompt.
- Critical: **critical urgency, timeout 0** (Omarchy returns 0 only for critical and clamps
  everything else to ≤ 30 s — the v1 law), and the **arm happens at queue time**: the
  widget launches the agent prompt itself so the copy's claim "Agent has been notified and
  is guarding against OOM" is true even if the toast is never clicked. The arm runs on the
  bounded one-at-a-time agent lane with a watchdog; if it fails, a follow-up error notice
  (fixed copy, decided at implementation, in the spec's voice) says so and the log records
  it — nothing fails silently. Critical's single click action opens the detail window (the
  agent is already running; the human wants the picture).
- The dual click path is carried verbatim from Mount Monitor: `-h STRING:omarchy-exec-argv:<json argv>`
  hint (survives shell restarts via persisted history) plus the live `-A default=` action.
  The argv is a typed list through `agentArgv` — default
  `["omarchy","agent","prompt",prompt]` = `omarchy-default-agent` (spec Q4), `agentCommand`
  setting overridable. Nothing a measurement reads (process names, mount labels) ever
  enters an instruction sentence; numbers and names ride the delimited untrusted data block.

### Log AND arm from day one (spec Q5)

- The monitor arms at install (monitoring + alerts live immediately) **and** every poll
  sample is appended to a rotating, size-capped log under
  `~/.local/state/memory-monitor/baseline.log`: timestamp; per monitored mount
  target/percent/band; RAM used%/available/PSI/swap/zram figures; VRAM free/used/apps/
  unattributed; oomd block; the widget's own band decisions. Logging never blocks
  monitoring — a failed log append is logged to the console and monitoring continues.
- The log is the re-anchoring dataset (PR 7) and the fleet side's data source: spec Q1's
  fleet note (captain and firstmate throttle Strata together at critical) lives in
  firstmate's surface, outside this plugin; the log is what gives it the same numbers.

### Onboarding (install-time, spec section)

- **Same flow as Mount Monitor's partition onboarding:** first-run scan → HD candidates via
  the lsblk filter semantics this repo already ships (TYPE part/disk/crypt, non-swap
  FSTYPE, MOUNTPOINT present, path under `/dev/`, not a boot slice), candidates annotated
  with `monitored`, the both-counts notice ("N watched, M need a decision" — never a bare
  zero), decisions merged (never replaced) into
  `~/.local/state/memory-monitor/onboarding.json`, a new-partition notice offered once per
  appearance. RAM and VRAM are always monitored — they are the point of the plugin — and
  the onboarding notice counts them as watched.
- **The insist-guard step:** the onboarding asks the user if they want the guard against
  OOMs — and insists that it does guard: a never-expiring critical-urgency notice (own
  process lane, as v1's law requires), re-fired until answered, the decision recorded in
  the state file. On yes: run the **system health check** (agent + `memory-health` skill —
  largest consumers of RAM/VRAM/HD, recommend throttling/pruning options; read-only
  analysis, nothing killed or throttled without the captain's word), then arm the standing
  guard (skills wired to threshold prompts) and record it armed. On decline: record it;
  monitoring continues; the standing guard stays off — but a critical still notifies the
  agent for that event (the toast copy must stay true in both states).
- **Onboarding answers must produce a verified arm:** "asked" is not "armed"; the state
  file records the difference and the detail window shows it.

### Skills (spec Q6)

- Skills are determined WITH the user during onboarding and during normal use; they trigger
  at threshold levels. v1 ships the seed: **`memory-health`** — consumer analysis,
  throttle/prune recommendations, guard stance; analysis-only law like `disk-prune`. The
  alert prompts reference the skill; the user and the agent refine the skill's content
  during onboarding and use, with every change gated by the user's word — which also
  satisfies the attack's rule that action instructions never ship blindly from a
  marketplace plugin.

### The one design: RingKit

RingKit (per the prior plan) is the pure-decision module shared by this repo's plugins:
palette tokens, threshold validation, band resolver, hysteresis/ascent-descent state
machine, most-severe selector, poll-interval escalation, badge/tooltip parameters, and the
trust primitives this repo already perfected (`sanitizeText`, untrusted data block,
fixed-prompt builder, minted instance ids + validation). Plain top-level `function`
declarations, no imports, `node:vm`-testable — the mounts.js law, so both consumers hold.
Mount Monitor's *migration* onto RingKit is out of v1 scope (its decisions stay in
mounts.js); RingKit v1 serves Memory Monitor and pins the contracts the next consumer
inherits (watchdogs, cursor rule, one-action law, device-text-is-data).

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

`memory.js` owns every decision — thresholds, parsers, bands, hysteresis, severity, poll
intervals, oomd discovery, toast templates, prompts, onboarding copy — exactly as mounts.js
does for Mount Monitor; `MemoryMonitor.qml` keeps state, processes, timers, and drawing and
builds every argv through `Memory.*Args()`. Plain-JS module law applies to both JS files.
Local run on the rig: a second plugin directory (clone or symlink of `memory-monitor/`)
alongside the existing Mount Monitor install; the marketplace-listing mechanics (this repo
hosting two plugins vs. a separate listing/repo with RingKit vendored by the prior plan's
sync script) are the captain's call at ship time — named below, not blocking the build.

## Deliverable steps, sized as PRs

| PR | Delivers | Owns the decisions in |
|---|---|---|
| 1 | Scaffolding + **RingKit**: `ringkit.js`, repo-root tests wired into `tests/run.sh`, `memory-monitor/` skeleton (manifest, empty widget shell, run.sh) | ringkit.js |
| 2 | **Measurement + band decisions**: parsers and argvs (findmnt HD rows; meminfo/PSI/swaps/zramctl; nvidia-smi memory + compute apps + unattributed remainder), `validateThresholds`, band evaluation + hysteresis, `mostSevere`, `pollIntervalMs`, oomd discovery/parse, baseline record schema + append/rotate rules, toast templates + dispatch (`promptFor`/`titleFor`/`actionFor`/`bodyFor`/`urgencyFor`/`timeoutFor`), `agentArgv` | memory.js |
| 3 | **Bar widget**: MM logo ring (white, plain), three graphic badges, most-severe display, adaptive-poll timers, all child processes with timeout/watchdog/backoff hardening, state FileView, baseline logging wired to every sample, band-escalation preemption + 120 s watchdog in the alert queue | MemoryMonitor.qml |
| 4 | **Detail window**: click-to-open panel with the full per-type picture (incl. swap/zram + oomd block + unattributed VRAM row), threshold value boxes (arrow clicks, typing, arrow keys), live validation, persistence to the settings state file, latched/unavailable visibility | MemoryMonitor.qml + memory.js validators |
| 5 | **Toasts + agent routing**: notify-send plumbing with dual click path, verbatim copy emission (character-pinned in tests at defaults), critical-urgency/timeout-0 law, critical proactive arm on the bounded agent lane with failure surfaced | memory.js copy + QML lanes |
| 6 | **Onboarding + skills**: first-run HD scan + both-counts notice + new-partition notice, insist-guard ask (never-expiring, re-fired, recorded), health-check run + verified arm, `memory-health` skill seed, sibling `install.sh` | memory.js onboarding + skills/ |
| 7 | **Week-two re-anchor** (time-gated: after one week of baseline logs): distributions from the log → recommended thresholds per type (VRAM especially), report to the captain, approved values applied as defaults/docs | report + memory.js defaults |

Every PR keeps `bash tests/run.sh` green (node:test suites with fixtures for every parser,
verbatim-copy pins, hostile-label regression carried into the sibling, delegation guards
asserting the QML builds its argvs through `Memory.*Args`, install.sh syntax check, the
skills/SKILL.md check, qmllint on the new QML).

## Contracts carried from Mount Monitor (non-negotiable)

- **Device/process text is data, never instructions.** Mount labels, process names, and
  consumer lists are written by whoever ran them; they ride the delimited untrusted data
  block through `sanitizeText` and never enter an instruction sentence. Prompts are fixed
  copy, identical per kind. `tests/label-injection`-equivalent is a gate from PR 2 onward.
- **Typed argv everywhere.** No shell strings; the daemon's `parseExecArgv` must accept
  what we hint.
- **Every setting through a `normalize*` helper**; Qt lists round-trip through JSON before
  `Array.isArray`; a non-list falls back to the documented default.
- **Only-most-severe in the bar; every alert still toasts.** The bar dedupes for legibility;
  the toast stream does not silently drop a lower-band alert that fired.
- **Critical = critical urgency, timeout 0, own process lane; band alerts on the
  watchdog-released lane.** A question nobody answered must never hold a full-drive-style
  warning.
- **State file law:** write only on change; a scan that exits non-zero records nothing;
  onboarding decisions merge, never replace; deleting the state dir re-runs first run.
- **A plugin never auto-discovers what it was not asked to watch** — HD monitoring follows
  the ask-first law; RAM/VRAM are the plugin's purpose and need no ask.
- **Version changes in any manifest.json need the captain's explicit word.**

## Omarchy protection law applied to this plugin

Nothing fails silently: a missing tool (nvidia-smi, zramctl), a missing oomd, a failed
agent arm, a failed log append, a wedged child process, a PSI-less kernel — each has a
surfaced state (detail window, one-time notice or console log as appropriate) and a
defined degradation; the widget never shows a confident 0% for an unknown, and monitoring
never stops because a side channel died. "We're always guarding against OOM. Number one is
to protect the health of Omarchy" (spec Q6) — this plugin's contribution to that is honest
visibility, honest logging, and an agent that is told the truth.

## Out of scope for v1

- Any automatic lever or kill path (rung-0 automatic yield — `min_free_vram_mib`,
  `idle_unload_s`, `MemoryHigh` on strata.service — is a later phase the captain must
  explicitly arm; Q1 makes v1 monitor-first).
- Journal GL-signature watching (the incident class is unclassified per the attack; the
  baseline week informs whether v1.x adds it, with the cursor rule from the RingKit
  contract).
- Fleet-side throttle actions (firstmate's surface; the log feeds it).
- Mount Monitor's migration onto RingKit; separate marketplace listings; multi-GPU (first
  card only, named honestly in the detail window); a non-quickshell alert path.

## Open questions for the captain (none block the build)

1. **Ship mechanics:** sibling-in-this-repo now; separate marketplace listing/repo (with
   RingKit vendored per the prior plan's sync script) is the captain's call at release.
2. **Critical default 95%** until the user sets their own in the detail window.
3. **HD default watch set** before onboarding answers: none (ask-first law).
