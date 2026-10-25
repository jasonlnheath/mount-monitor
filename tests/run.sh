#!/usr/bin/env bash
# Mount Monitor checks: the mount filter, alert bands, and alert text in
# mounts.js, then a QML syntax/import check over MountMonitor.qml when Qt's
# qmllint is on the box. Run from anywhere: bash tests/run.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(dirname "$here")"

command -v node > /dev/null || { echo "node is required to run the tests" >&2; exit 1; }
node --test "$here"

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
if ! qml_out="$("$qmllint" "$repo/MountMonitor.qml" 2>&1)"; then
  echo "qmllint failed:" >&2
  echo "$qml_out" >&2
  exit 1
fi
echo "qmllint: MountMonitor.qml parses and its mounts.js import resolves"
