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

Alerts go one at a time, so the one on screen stays clickable, and an alert is
only dropped when the reading behind it stops holding — the mount went away or
its usage fell back below the band it was queued for. A mount that is already
in a band when the shell starts or reloads is not re-notified until it crosses
again; 98% and above always notifies.

Rings refresh once a minute and only mounts you configure are shown. A
configured mount that is not currently mounted simply has no ring.

## Install

```bash
git clone https://github.com/jasonlnheath/mount-monitor \
  ~/.config/omarchy/plugins/io.github.jasonlnheath.mount-monitor
~/.config/omarchy/plugins/io.github.jasonlnheath.mount-monitor/install.sh
omarchy restart shell
```

`install.sh` copies the `disk-prune` skill into `~/.agents/skills/` and prints
the bar wiring line. `omarchy plugin add
https://github.com/jasonlnheath/mount-monitor --enable` is the equivalent if
you want Omarchy to manage updates for you.

Then add it to the right side of your bar in `~/.config/omarchy/shell.json`:

```json
{ "id": "io.github.jasonlnheath.mount-monitor" }
```

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

## License

MIT
