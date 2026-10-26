#!/usr/bin/env bash
# Mount Monitor installer: copies the agent skills into your agent's skills
# directory and prints the bar wiring line. The plugin itself runs straight from
# a git clone of this repo (see README).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
skills_dir="$HOME/.agents/skills"

if [[ "$here" != *"omarchy/plugins/io.github.jasonlnheath.mount-monitor" ]]; then
  echo "Clone this repo to ~/.config/omarchy/plugins/io.github.jasonlnheath.mount-monitor first:" >&2
  echo "  git clone https://github.com/jasonlnheath/mount-monitor ~/.config/omarchy/plugins/io.github.jasonlnheath.mount-monitor" >&2
  exit 1
fi

if [[ ! -d "$here/skills" ]]; then
  echo "No skills/ directory in $here; nothing to install." >&2
  exit 1
fi

# Install every skill in skills/, so shipping a new skill never means remembering
# to add its name here as well.
installed=()
for skill_dir in "$here"/skills/*/; do
  skill="$(basename "$skill_dir")"
  if [[ ! -f "$skill_dir/SKILL.md" ]]; then
    echo "skills/$skill has no SKILL.md; skipped. Restore it or re-clone." >&2
    continue
  fi
  # Replace rather than merge: a plain copy leaves files behind from whatever
  # version of the skill was installed before.
  mkdir -p "$skills_dir"
  rm -rf "${skills_dir:?}/$skill"
  cp -a "$skill_dir" "$skills_dir/"
  installed+=("$skill")
done

if [[ ${#installed[@]} -eq 0 ]]; then
  echo "No skills found in $here/skills; nothing installed." >&2
  exit 1
fi

command -v notify-send > /dev/null \
  || echo "notify-send is not installed; Mount Monitor can draw its rings but cannot alert." >&2
command -v lsblk > /dev/null \
  || echo "lsblk is not installed; Mount Monitor can draw its rings but cannot scan partitions." >&2

echo "Skills installed to $skills_dir: ${installed[*]}"
echo "Add to the right section of ~/.config/omarchy/shell.json:"
echo '  { "id": "io.github.jasonlnheath.mount-monitor" }'
echo "Then: omarchy restart shell"
