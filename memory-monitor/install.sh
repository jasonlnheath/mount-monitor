#!/usr/bin/env bash
# Memory Monitor installer.
#
# This directory is SOURCE layout only. The shell's plugin registry scans exactly
# one level (~/.config/omarchy/plugins/*/manifest.json), so a manifest sitting at
# memory-monitor/manifest.json inside this checkout is invisible to it, and a
# clone-in-place of this repository cannot serve both plugins: the repo root's
# manifest is Mount Monitor's, and one directory yields exactly one registration.
#
# So this installer copies the plugin out of the checkout into its own top-level
# plugin directory, with manifest.json at that directory's root, plus ringkit.js -
# the repo-root module the widget imports - beside it. The copy is replaced whole,
# never merged, so a file deleted in the repo stays deleted on the bar.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
plugin_id="io.github.jasonlnheath.memory-monitor"
plugin_dir="$HOME/.config/omarchy/plugins/$plugin_id"
skills_dir="$HOME/.agents/skills"

if [[ ! -f "$here/manifest.json" || ! -f "$here/MemoryMonitor.qml" || ! -f "$here/memory.js" ]]; then
  echo "This script must run from the memory-monitor/ directory of a mount-monitor checkout." >&2
  echo "Found: $here" >&2
  exit 1
fi

if [[ "$here" == "$plugin_dir" ]]; then
  echo "Refusing to install from inside the installed plugin directory ($plugin_dir)." >&2
  echo "Run it from the checkout: <checkout>/memory-monitor/install.sh" >&2
  exit 1
fi

ringkit="$here/../ringkit.js"
if [[ ! -f "$ringkit" ]]; then
  echo "ringkit.js is missing at the repo root above $here." >&2
  echo "MemoryMonitor.qml imports it; the plugin cannot load without it." >&2
  exit 1
fi

# Replace rather than merge: a plain copy leaves files behind from whatever
# version of the plugin was installed before.
rm -rf "${plugin_dir:?}"
mkdir -p "$plugin_dir"

for name in manifest.json MemoryMonitor.qml MemoryPanel.qml QuattroDash.qml QuattroSymbol.qml CardBar.qml memory.js quattro.js README.md; do
  if [[ -f "$here/$name" ]]; then
    cp -a "$here/$name" "$plugin_dir/"
  fi
done

# The toast logo (round 7 item 11): the check-engine emblem in its three
# tints, resolved by the widget relative to its own directory. Copied whole
# like the rest, so a tint renamed in the repo stays renamed on disk.
if [[ -d "$here/icons" ]]; then
  rm -rf "${plugin_dir:?}/icons"
  cp -a "$here/icons" "$plugin_dir/icons"
fi

# The widget imports ringkit.js, and a QML-imported JS module cannot import
# another JS module, so the one RingKit source is copied beside its one consumer.
cp -a "$ringkit" "$plugin_dir/ringkit.js"

if [[ ! -d "$here/skills" ]]; then
  echo "No skills/ directory in $here; the plugin installs without its skill." >&2
else
  installed=()
  for skill_dir in "$here"/skills/*/; do
    skill="$(basename "$skill_dir")"
    if [[ ! -f "$skill_dir/SKILL.md" ]]; then
      echo "skills/$skill has no SKILL.md; skipped. Restore it or re-clone." >&2
      continue
    fi
    mkdir -p "$skills_dir"
    rm -rf "${skills_dir:?}/$skill"
    cp -a "$skill_dir" "$skills_dir/"
    installed+=("$skill")
  done
  if [[ ${#installed[@]} -gt 0 ]]; then
    echo "Skills installed to $skills_dir: ${installed[*]}"
  fi
fi

command -v notify-send > /dev/null \
  || echo "notify-send is not installed; Quattro Dash can draw its badge but cannot alert." >&2
command -v findmnt > /dev/null \
  || echo "findmnt is not installed; Quattro Dash cannot read your drives." >&2
command -v nvidia-smi > /dev/null \
  || echo "nvidia-smi is not installed; the VRAM ring is off. RAM and drives still monitor." >&2
command -v zramctl > /dev/null \
  || echo "zramctl is not installed; zram fill is not reported. Swap still reads /proc/swaps." >&2
command -v oomctl > /dev/null \
  || echo "oomctl is not installed; the kernel's ceiling is not reported and the swap escalator assumes 90%." >&2

echo "Installed $plugin_id to $plugin_dir"
echo "Add to the right section of ~/.config/omarchy/shell.json (edit it yourself; this script does not):"
echo '  { "id": "io.github.jasonlnheath.memory-monitor" }'
echo "Then: omarchy restart shell"
