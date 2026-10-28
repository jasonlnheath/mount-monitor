#!/usr/bin/env bash
# Mount Monitor checks: the node tests over mounts.js (mount filter, alert
# bands, alert text, partition onboarding, block-event detection) and
# streetview.js (the wallpaper's quota guard, meters, and copy), an
# install.sh syntax check, a skills/ SKILL.md check, then a QML syntax/import
# check over both QML entry points (MountMonitor.qml, StreetView.qml) when
# Qt's qmllint is on the box. Run from anywhere: bash tests/run.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(dirname "$here")"

command -v node > /dev/null || { echo "node is required to run the tests" >&2; exit 1; }
node --test "$here"

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
# broken import. Both entry points are checked - the bar widget and the
# wallpaper service.
qml_fail=""
for qml_file in "$repo/MountMonitor.qml" "$repo/StreetView.qml"; do
  if ! qml_out="$("$qmllint" "$qml_file" 2>&1)"; then
    echo "qmllint failed for $qml_file:" >&2
    echo "$qml_out" >&2
    qml_fail="1"
  fi
done
if [ -n "$qml_fail" ]; then exit 1; fi
echo "qmllint: MountMonitor.qml and StreetView.qml parse and their imports resolve"
