#!/usr/bin/env bash
# Mount Monitor checks: the node tests over mounts.js (mount filter, alert
# bands, alert text, partition onboarding, block-event detection, the VRAM
# headroom telltale's floor, guarded crossings, parser and copy) plus the node
# tests over ringkit.js - the repo's shared decision kernel, whose own contracts
# are pinned at the repo root because Mount Monitor is its future second
# consumer - an install.sh syntax check, a skills/ SKILL.md check, then a QML
# syntax/import check over the widget and the telltale files when Qt's qmllint
# is on the box. Run from anywhere: bash tests/run.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(dirname "$here")"

command -v node > /dev/null || { echo "node is required to run the tests" >&2; exit 1; }
# Name the test files, not the directory: node's --test only learned directory
# arguments in v23+, and older node (the v22 on a stock PATH) tries to load the
# directory as a module and dies before running a single test.
node --test "$here"/*.test.mjs

# The skills the repo ships are what install.sh copies, so check they are real
# skill directories and that the installer still parses.
bash -n "$repo/install.sh" || { echo "install.sh syntax check FAILED" >&2; exit 1; }
for skill_dir in "$repo"/skills/*/; do
  skill="$(basename "$skill_dir")"
  [[ -f "$skill_dir/SKILL.md" ]] || { echo "skills/$skill has no SKILL.md" >&2; exit 1; }
done
echo "install.sh parses; skills present: $(basename -a "$repo"/skills/*/ | tr '\n' ' ')"

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

# Warnings about QuickShell's own types are expected outside a running shell and
# are only shown when the check fails; a non-zero exit is a syntax error or a
# broken import.
qml_files=("$repo/MountMonitor.qml" "$repo/VramSymbol.qml" "$repo/VramPanel.qml" "$repo/CardBar.qml")
qml_out="$("$qmllint" "${qml_files[@]}" 2>&1)" || {
  echo "qmllint failed:" >&2
  echo "$qml_out" >&2
  exit 1
}
echo "qmllint: MountMonitor.qml, VramSymbol.qml, VramPanel.qml and CardBar.qml parse and their mounts.js imports resolve"
