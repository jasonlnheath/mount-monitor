// Mount Monitor shared logic.
//
// Imported by MountMonitor.qml (import "mounts.js" as Mounts) and loaded by
// tests/mounts.test.mjs, so the mount filter, the alert bands, and the alert
// text are testable without a running shell. Pure functions only: no QML
// objects, no state. The widget keeps the state (bands, alert queue, processes).

// The findmnt arguments the widget runs. There is no filesystem-type filter
// here on purpose: the ring filter lives in isRingable(), so a fixed disk mount
// that is not btrfs - the read-only NTFS partition holding the models - reaches
// the parser instead of being hidden by findmnt.
function findmntArgs() {
  return ["-rn", "-o", "SOURCE,TARGET,FSTYPE,USED,AVAIL,USE%,OPTIONS"]
}

// One findmnt row, in the column order findmntArgs() asks for. Rows without a
// target, or whose USE% is not a number (pseudo filesystems and filesystems
// that report no usage print those columns empty), are dropped here.
function parseRows(text) {
  var rows = []
  var lines = String(text).split("\n")
  for (var i = 0; i < lines.length; i++) {
    var cols = lines[i].trim().split(/\s+/)
    if (cols.length < 7) continue
    var target = cols[1]
    if (!target) continue
    var pct = parseInt(String(cols[5]).replace("%", ""), 10)
    if (!isFinite(pct) || pct < 0 || pct > 100) continue
    rows.push({
      source: cols[0],
      target: target,
      fstype: cols[2],
      used: cols[3],
      avail: cols[4],
      pct: pct,
      // findmnt lists mount options comma-separated and "ro"/"rw" first.
      readonly: String(cols[6]).split(",")[0] === "ro"
    })
  }
  return rows
}

// Which rows may draw a ring: fixed, block-device-backed mounts. Dropping the
// type filter lets every filesystem findmnt knows about into the reading, so
// this is what keeps tmpfs, proc, cgroup2, overlay, and the rest of the virtual
// filesystems off the bar even when someone configures one. A mount whose
// source is not a device path (a tmpfs, a network mount, a named storage pool)
// is not a disk this plugin can watch.
function isRingable(row) {
  return String(row.source).indexOf("/dev/") === 0
}

// The ring list for the configured mounts, in configured order. Only configured
// mounts ever draw a ring; a configured mount that is not mounted is absent.
// testPct >= 0 is the test hook: it overrides the reported usage everywhere,
// display and alerts alike.
function selectMounts(text, wanted, testPct) {
  var rows = parseRows(text)
  var byTarget = ({})
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i]
    if (!isRingable(row)) continue
    // Two rows can report the same target (a subvolume and its parent); the
    // first one wins. Deduplicating on the device instead drops every
    // subvolume mount after the first one on the same drive.
    if (byTarget[row.target]) continue
    byTarget[row.target] = row
  }

  var list = []
  for (var j = 0; j < wanted.length; j++) {
    var m = byTarget[wanted[j]]
    if (!m) continue
    if (testPct >= 0) m.pct = testPct
    list.push(m)
  }
  return list
}

// Alert band: 0 = below 80, 1 = 80s, 2 = 90s, 3 = 98+.
function bandFor(pct) {
  if (pct >= 98) return 3
  if (pct >= 90) return 2
  if (pct >= 80) return 1
  return 0
}

// The prompt the configured agent receives when a notification is clicked.
// A read-only mount can never be pruned or compressed from here, so its prompt
// asks for the disk-prune skill's read-only branch instead of a scan that would
// come back promising nothing.
function agentPrompt(m) {
  if (m.readonly)
    return "Mount Monitor: " + m.target + " is " + m.pct + "% full and mounted read-only, so nothing on it " +
           "can be pruned or compressed from this machine. Run the disk-prune skill read-only: say plainly that " +
           "nothing can be pruned on " + m.target + ", then report its largest files and directories and ranked " +
           "candidates to move off it to another drive."
  return "Mount Monitor: " + m.target + " is " + m.pct + "% full. Run the disk-prune skill: scan " +
         m.target + " for prune and compress candidates, then report ranked suggestions with sizes."
}

// The label on the notification's clickable action.
function notifyAction(alert) {
  return alert.readonly ? "Run move-off report" : "Run cleanup analysis"
}

// The body of the desktop notification. Same honesty rule as the prompt: never
// promise prune candidates on a mount that is mounted read-only.
function notifyBody(alert) {
  if (alert.readonly)
    return alert.target + " is " + alert.pct + "% full — " + alert.avail + " free. It is mounted read-only, so " +
           "nothing can be pruned there. Click for a report of what to move off it."
  return alert.target + " is " + alert.pct + "% full — " + alert.avail + " free. Click to have your agent find prune/compress candidates."
}

// The ring tooltip.
function tooltip(m) {
  return m.target + " — " + m.pct + "% used · " + m.used + " used · " + m.avail + " free · " +
         m.fstype + (m.readonly ? " (read-only)" : "")
}
