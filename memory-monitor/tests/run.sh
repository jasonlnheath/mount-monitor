#!/usr/bin/env bash
# Memory Monitor checks: the node tests over memory.js, quattro.js and
# ringkit.js (ceilings, bands, hysteresis, the pressure+swap RAM signal, swap
# escalation, oomd visibility, VRAM, drive dedup, toast copy, DND routing, the
# guard arm, the baseline log, onboarding, the trust boundary, the QuattroDash
# bands, code taxonomy and copy-language rule), a conformance check that pins
# RingKit against memory.js and mounts.js, the multi-instance gate (two live
# widgets produce one alert, one log row, one arm), a check that install.sh
# really installs a self-contained plugin at the one level the shell's registry
# scans, an install.sh syntax check, a skills/
# SKILL.md check, then a QML syntax/import check over the plugin's QML when
# Qt's qmllint is on the box.
#
# Run from anywhere: bash memory-monitor/tests/run.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
plugin="$(dirname "$here")"
repo="$(dirname "$plugin")"

command -v node > /dev/null || { echo "node is required to run the tests" >&2; exit 1; }
node --test "$here"

bash -n "$plugin/install.sh" || { echo "memory-monitor/install.sh syntax check FAILED" >&2; exit 1; }
for skill_dir in "$plugin"/skills/*/; do
  skill="$(basename "$skill_dir")"
  [[ -f "$skill_dir/SKILL.md" ]] || { echo "memory-monitor/skills/$skill has no SKILL.md" >&2; exit 1; }
done
echo "install.sh parses; skills present: $(basename -a "$plugin"/skills/*/ | tr '\n' ' ')"

# The manifest is what the shell's one-level plugin scan reads, so it must be a
# plugin manifest at the directory install.sh copies into, not a note.
node -e '
const fs = require("node:fs");
const manifest = JSON.parse(fs.readFileSync(process.argv[1] + "/manifest.json", "utf8"));
const want = "io.github.jasonlnheath.memory-monitor";
if (manifest.id !== want) { console.error("manifest.json id is " + manifest.id + ", expected " + want); process.exit(1); }
if (manifest.entryPoints.barWidget !== "MemoryMonitor.qml") { console.error("manifest.json entryPoints.barWidget must be MemoryMonitor.qml"); process.exit(1); }
if (!Array.isArray(manifest.kinds) || manifest.kinds.indexOf("bar-widget") < 0) { console.error("manifest.json kinds must include bar-widget"); process.exit(1); }
const install = fs.readFileSync(process.argv[1] + "/install.sh", "utf8");
for (const needed of [manifest.entryPoints.barWidget, "memory.js", "ringkit.js", "manifest.json"]) {
  if (!install.includes(needed)) { console.error("install.sh never copies " + needed + "; the installed plugin would not load"); process.exit(1); }
}
' "$plugin"
echo "manifest.json registers $plugin as a bar-widget and install.sh copies what the widget imports"

qmllint=""
if command -v qmllint > /dev/null 2>&1; then
  qmllint="qmllint"
elif [ -x /usr/lib/qt6/bin/qmllint ]; then
  qmllint="/usr/lib/qt6/bin/qmllint"
fi

if [ -z "$qmllint" ]; then
  echo "qmllint not found; skipped the QML syntax/import check" >&2
  exit 0
fi

# Warnings about QuickShell's own types and about the runtime-injected members a
# Loader hands the panel are expected outside a running shell - first-party
# Omarchy panels produce the same ones. A non-zero exit is a syntax error or a
# broken import.
for qml in MemoryMonitor.qml MemoryPanel.qml QuattroDash.qml QuattroSymbol.qml CardBar.qml; do
  if ! qml_out="$("$qmllint" "$plugin/$qml" 2>&1)"; then
    echo "qmllint failed on $qml:" >&2
    echo "$qml_out" >&2
    exit 1
  fi
done
echo "qmllint: MemoryMonitor.qml, MemoryPanel.qml, QuattroDash.qml, QuattroSymbol.qml and CardBar.qml parse and their memory.js / quattro.js / ringkit.js imports resolve"
