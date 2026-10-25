#!/usr/bin/env bash
# Mount Monitor installer: copies the disk-prune skill into your agent's
# skills directory and prints the bar wiring line. The plugin itself runs
# straight from a git clone of this repo (see README).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
skill="disk-prune"
skills_dir="$HOME/.agents/skills"

if [[ "$here" != *"omarchy/plugins/io.github.jasonlnheath.mount-monitor" ]]; then
  echo "Clone this repo to ~/.config/omarchy/plugins/io.github.jasonlnheath.mount-monitor first:" >&2
  echo "  git clone https://github.com/jasonlnheath/mount-monitor ~/.config/omarchy/plugins/io.github.jasonlnheath.mount-monitor" >&2
  exit 1
fi

if [[ ! -d "$here/skills/$skill" ]]; then
  echo "skills/$skill is missing from this checkout; re-clone or git checkout -- skills/" >&2
  exit 1
fi

# Replace rather than merge: a plain copy leaves files behind from whatever
# version of the skill was installed before.
mkdir -p "$skills_dir"
rm -rf "${skills_dir:?}/$skill"
cp -a "$here/skills/$skill" "$skills_dir/"

command -v notify-send > /dev/null \
  || echo "notify-send is not installed; Mount Monitor can draw its rings but cannot alert." >&2

echo "disk-prune skill installed to $skills_dir/$skill"
echo "Add to the right section of ~/.config/omarchy/shell.json:"
echo '  { "id": "io.github.jasonlnheath.mount-monitor" }'
echo "Then: omarchy restart shell"
