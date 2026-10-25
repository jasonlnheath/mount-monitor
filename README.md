# Mount Monitor

A simple visualizer of hd usage that monitors when space gets too high. At 98%
or above it throws a notification and glows red. Notifications are configured
to go to your agent of choice with a skill that suggests files to prune /
compress.

![Mount Monitor in the Omarchy bar](preview.png)

An [Omarchy](https://omarchy.org) bar plugin. One monochrome usage ring per
btrfs mount: the percent sits inside the circle, the solid arc is what's used,
the faint ring behind it is what's available. Hover any ring for the mount
name and exact numbers.

## Behavior

- Under 80%: calm monochrome ring, percent inside.
- 80% and again at 90%: desktop notification, ring and percent embolden.
- 98% and above: vibrant red ring that pulses (glows) at 0.5 Hz, critical
  notification that stays until dismissed.
- Click any notification and Mount Monitor sends a cleanup prompt to your
  agent of choice, which runs the included `disk-prune` skill: a read-only
  scan that reports ranked prune/compress candidates with sizes. Nothing is
  ever deleted automatically.

Alerts go one at a time, so the one on screen stays clickable, and a queued
alert is only dropped when the reading behind it stops holding — the mount
went away or its usage fell back below the band it was queued for. A popup
left unanswered is dismissed after two minutes so the queue keeps moving. A
mount that is already in a band when the shell starts or reloads is not
re-notified until it crosses again; 98% and above always notifies.

Rings refresh once a minute and only mounts you configure are shown. A
configured mount that is not currently mounted simply has no ring.

## Requirements

Omarchy Quattro (Quickshell) with third-party `schemaVersion: 1` bar widgets,
`findmnt` from util-linux to read the mounts, and `notify-send` from libnotify
for the alerts. Without `notify-send` the rings still draw, nothing alerts.

## Install

```bash
git clone https://github.com/jasonlnheath/mount-monitor \
  ~/.config/omarchy/plugins/io.github.jasonlnheath.mount-monitor
~/.config/omarchy/plugins/io.github.jasonlnheath.mount-monitor/install.sh
omarchy restart shell
```

`install.sh` copies the `disk-prune` skill into `~/.agents/skills/` and prints
the bar wiring line. `omarchy plugin add
https://github.com/jasonlnheath/mount-monitor --enable` also installs and
enables the widget and manages updates for you, but it does not run
`install.sh` and does not install the `disk-prune` skill — without also
running `install.sh` (or copying `skills/disk-prune/` into
`~/.agents/skills/` yourself), notifications still appear but clicking them
sends your agent a cleanup prompt it has no skill to run.

Then add it to the right side of your bar in `~/.config/omarchy/shell.json`:

```json
{ "id": "io.github.jasonlnheath.mount-monitor" }
```

## Remove

```bash
omarchy plugin remove io.github.jasonlnheath.mount-monitor
```

If you installed by cloning, delete the plugin folder and the skill, drop the
widget entry from `shell.json`, and restart the shell:

```bash
rm -rf ~/.config/omarchy/plugins/io.github.jasonlnheath.mount-monitor ~/.agents/skills/disk-prune
omarchy restart shell
```

Mount Monitor writes nothing outside those two folders and your `shell.json`.

## Configuration

All settings live on the widget's entry in `shell.json`:

```json
{
  "id": "io.github.jasonlnheath.mount-monitor",
  "mounts": ["/", "/srv/models"],
  "agentCommand": ["/path/to/your/agent/inbox", "note"]
}
```

- `mounts` — which btrfs mounts get rings. Default: `["/"]` (root only).
  Tell your agent to add or remove entries here whenever you want a drive
  watched.
- `agentCommand` — the command that receives the cleanup prompt when you
  click a notification. It is an argument list run directly, not a shell
  line, and the prompt is appended as the last argument. Default when unset:
  `omarchy agent prompt <prompt>`, which opens your default Omarchy agent in
  a terminal with the cleanup request. Point it at whatever your agent
  listens on — an inbox script, a CLI, a webhook.

## The disk-prune skill

`skills/disk-prune/SKILL.md` is agent-agnostic: it tells any capable agent how
to scan a mount for prune/compress candidates (package caches, journals, tool
caches, 1G+ files, compressible trees, cold-storage moves) and report them
ranked, sized, and read-only. Copy it wherever your agent loads skills from.

## Feedback

Bugs and suggestions: https://github.com/jasonlnheath/mount-monitor/issues —
open one yourself, or tell your agent to.

## License

MIT
