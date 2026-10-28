---
name: streetview-wallpaper
description: Mount Monitor Street View wallpaper - report the free-tier usage meter, present the two options when the cap is reached (stay capped, or unlock paid usage), and apply cap changes the captain asks for. Use when Mount Monitor warns that the Street View cap is reached, when asked how much of the Street View budget is used, or when asked to raise, lower, or remove the wallpaper cap. Edits the widget's shell.json settings only - never sends a request itself, never touches the meter's counters, never handles the API key beyond leaving it where it is.
---

# Street View wallpaper

Goal: make the wallpaper's cost visible and let the captain steer it. The free
tier is a guarantee, not a hope: the plugin never sends a billable Static Street
View request unless the month's meter says there is free headroom, and your job
never involves sending one either.

## The cost model (say these numbers when they matter)

- The SKU is Static Street View (Essentials): **10,000 free panorama loads per
  month, then $7 per 1,000 loads**.
- The metadata endpoint (the coverage check) is **always free and unlimited**.
  The plugin uses it so uncovered locations never cost a billable load.
- Two caps guard the spend, and a fetch needs headroom in both:
  `streetviewMonthlyCap` (default 10000, the free ceiling) and
  `streetviewCapPerDay` (default 100 — the paranoid default, ON out of the
  box). `streetviewCapPerDay: 0` pauses the wallpaper entirely; `-1` removes
  the daily limit.

## Inputs

- **The meter**: `~/.local/state/mount-monitor/streetview-meter.json` —
  `monthlyUsed` against `month` (resets when the month turns),
  `dailyUsed` against `day`. Read it; never write it. The service owns that
  file, and hand-edited counters would only lie to the guard.
- **The settings**: the `io.github.jasonlnheath.mount-monitor` entry in
  `~/.config/omarchy/shell.json` — `streetview`, `streetviewKey`,
  `streetviewCapPerDay`, `streetviewMonthlyCap`,
  `streetviewIntervalMinutes`, `streetviewSize`, `streetviewLocations`.

## Procedure

1. **Report first, from the meter**: the month's usage, the month key it
   counts, today's usage, and the two caps as configured. The plugin's own
   wording is "`3,214 / 10,000 free loads (32% this month)`"; match it. If the
   click prompt already carried the usage line, report what it brought and
   read the meter only to confirm it.
2. **On a cap warning, present exactly two options** and apply only the one
   the captain picks:
   - **Stay capped**: change nothing. The wallpaper keeps the last cached
     image — until tomorrow for the daily cap, until next month for the
     monthly cap. This is the no-action option; say so plainly.
   - **Unlock paid usage**: the captain's billing, the captain's risk. Raise
     `streetviewMonthlyCap` above 10,000 (overage is $7 per 1,000), or set
     `streetviewCapPerDay` to -1 to drop the daily limit. Restate the price
     before editing.
3. **Apply cap changes to the settings only.** Edit that one entry in
   `shell.json`; change nothing else in the file. Then `omarchy restart shell`
   (or wait: the service re-reads `shell.json` live, so the next tick honors
   the change — say which you did).
4. **To lower a cap or pause**: set `streetviewCapPerDay` to a smaller number
   or `0` (pause). Lowering needs no confirmation beyond the ask itself; it
   only ever reduces what the plugin may spend.
5. **Never** edit the meter file, never echo or move the API key (it stays in
   `shell.json`, unredacted but untouched), never send a request to Google
   yourself, and never touch the mounts/ring settings as part of this skill —
   different feature, different skill.

## Report shape

- The usage line, today's count, both caps, and when each resets.
- What you changed, if anything, and how it takes effect (live on the next
  tick, or after `omarchy restart shell`).
- On an unlock: the overage price, once, in the same breath as the change.
