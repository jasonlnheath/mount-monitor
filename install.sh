#!/usr/bin/env bash
# Mount Monitor installer: copies the disk-prune skill into your agent's
# skills directory and prints the bar wiring line. The plugin itself runs
# straight from a git clone of this repo (see README).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "$here" != *"omarchy/plugins/io.github.jasonlnheath.mount-monitor" ]]; then
  echo "Clone this repo to ~/.config/omarchy/plugins/io.github.jasonlnheath.mount-monitor first:" >&2
  echo "  git clone https://github.com/jasonlnheath/mount-monitor ~/.config/omarchy/plugins/io.github.jasonlnheath.mount-monitor" >&2
  exit 1
fi

mkdir -p ~/.agents/skills
cp -r "$here/skills/disk-prune" ~/.agents/skills/

echo "disk-prune skill installed to ~/.agents/skills/disk-prune"
echo "Add to the right section of ~/.config/omarchy/shell.json:"
echo '  { "id": "io.github.jasonlnheath.mount-monitor" }'
echo "Then: omarchy restart shell"
