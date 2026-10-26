// Mount Monitor shared logic.
//
// Imported by MountMonitor.qml (import "mounts.js" as Mounts) and loaded by
// tests/mounts.test.mjs and tests/onboarding.test.mjs, so the mount filter, the
// alert bands, the alert text, the partition scan, and the once-only onboarding
// memory are testable without a running shell. Pure functions only: no QML
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

// --- partition onboarding --------------------------------------------------

// The lsblk arguments the candidate scan runs. Pairs output, not raw: lsblk
// prints empty FSTYPE/MOUNTPOINT columns for unformatted slices, and raw columns
// collapse those gaps so every later field shifts by one. Pairs output quotes
// each value, which also keeps a mountpoint or partition label containing a
// space intact. -n cannot be combined with -P, and pairs output has no header.
function lsblkArgs() {
  return ["-P", "-o", "NAME,PATH,TYPE,FSTYPE,MOUNTPOINT,SIZE,LABEL,PARTLABEL,PARTUUID,UUID,RM"]
}

// One lsblk pair row, lowercased keys, lsblk's backslash escapes undone. Rows
// without a device path are not disk rows and are dropped.
function parseLsblkPairs(text) {
  var rows = []
  var lines = String(text === undefined || text === null ? "" : text).split("\n")
  for (var i = 0; i < lines.length; i++) {
    if (lines[i].indexOf("=") < 0) continue
    var row = ({})
    var pair = /([A-Z_]+)="((?:[^"\\]|\\.)*)"/g
    var match
    while ((match = pair.exec(lines[i])) !== null)
      row[match[1].toLowerCase()] = match[2].replace(/\\(.)/g, function (all, ch) { return ch })
    if (!row.path) continue
    rows.push(row)
  }
  return rows
}

// Which partitions are worth offering as a monitor. A candidate is a real disk
// filesystem that is mounted somewhere:
//   - TYPE part or disk: drops the optical drive (rom), snap's squashfs images
//     (loop), and a parent disk that carries no filesystem of its own. A whole
//     USB stick formatted without a partition table is a disk with a mountpoint,
//     so it stays.
//   - FSTYPE present and not swap: drops unformatted slices and zram.
//   - MOUNTPOINT present: a partition with no mount cannot draw a ring, so it is
//     not offered. That is also what keeps the unmounted Windows recovery slices
//     on a second drive from nagging.
// tmpfs, proc, sysfs, cgroup2, overlay and nsfs need no deny-list: they are not
// block devices, so lsblk never lists them.
function isCandidate(row) {
  if (row.type !== "part" && row.type !== "disk") return false
  if (!row.fstype || row.fstype === "swap") return false
  if (!row.mountpoint) return false
  return String(row.path).indexOf("/dev/") === 0
}

// A partition's identity. Device names move between plugs (/dev/sdb becomes
// /dev/sdc), mountpoints move when two drives share a label, PARTUUID and the
// filesystem UUID do not. That identity is what "we already asked about this
// one" is keyed by.
function candidateKey(row) {
  return String(row.partuuid || row.uuid || row.path)
}

// The candidate list for one scan, in lsblk's order, one entry per partition.
// Several subvolume mounts of one partition are one candidate.
function candidatePartitions(text) {
  var rows = parseLsblkPairs(text)
  var list = []
  var seen = ({})
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i]
    if (!isCandidate(row)) continue
    var key = candidateKey(row)
    if (seen[key]) continue
    seen[key] = true
    list.push({
      key: key,
      target: row.mountpoint,
      path: row.path,
      fstype: row.fstype,
      size: row.size || "",
      label: row.label || row.partlabel || "",
      removable: row.rm === "1"
    })
  }
  return list
}

// The device behind a findmnt SOURCE, without its btrfs subvolume suffix:
// "/dev/nvme1n1p5[/@]" is the partition /dev/nvme1n1p5.
function deviceOf(source) {
  var s = String(source === undefined || source === null ? "" : source)
  var bracket = s.indexOf("[")
  if (bracket >= 0) s = s.substring(0, bracket)
  return s
}

// Devices the bar already draws a ring for. Offering a second mount of one of
// these would draw a second identical ring for a drive already watched, the
// duplicate the configured-mounts rule exists to prevent.
function monitoredDevices(mounts) {
  var devices = []
  var seen = ({})
  var list = mounts || []
  for (var i = 0; i < list.length; i++) {
    var device = deviceOf(list[i] ? list[i].source : "")
    if (device.indexOf("/dev/") !== 0 || seen[device]) continue
    seen[device] = true
    devices.push(device)
  }
  return devices
}

// Candidates worth notifying about: not configured, not the device behind a
// configured ring, and never offered or declined before.
function newCandidates(candidates, state, wanted, devices) {
  var decisions = state && state.decisions ? state.decisions : {}
  var configured = ({})
  var wantedList = wanted || []
  for (var i = 0; i < wantedList.length; i++) configured[wantedList[i]] = true
  var watched = ({})
  var deviceList = devices || []
  for (var j = 0; j < deviceList.length; j++) watched[deviceList[j]] = true

  var out = []
  var list = candidates || []
  for (var k = 0; k < list.length; k++) {
    var c = list[k]
    if (!c || !c.key) continue
    if (configured[c.target]) continue
    if (watched[c.path]) continue
    if (decisions[c.key] !== undefined) continue
    out.push(c)
  }
  return out
}

// Whether a queued notice still describes a partition that is there. A drive
// ejected while its notice waited behind another popup must not fire.
function candidateAlive(candidates, key) {
  var list = candidates || []
  for (var i = 0; i < list.length; i++)
    if (list[i] && list[i].key === key) return true
  return false
}

// The onboarding state file: where offered, declined, and accepted partitions
// are recorded so the plugin never nags about the same partition twice. Under
// the XDG state directory, outside the plugin's git clone, so a plugin update or
// a `git clean` cannot wipe the user's choices.
function stateDir(home) {
  return String(home || "") + "/.local/state/mount-monitor"
}

function statePath(home) {
  return stateDir(home) + "/onboarding.json"
}

// Read the state file. Anything unreadable - absent, empty, half-written, or
// not JSON at all - reads as a fresh install, which is the safe direction: the
// worst case is one onboarding notification, never a silent plugin.
function parseState(text) {
  var fresh = { version: 1, onboarded: false, updatedAt: "", decisions: ({}), candidates: [] }
  var raw = String(text === undefined || text === null ? "" : text).trim()
  if (raw === "") return fresh

  var parsed = null
  try { parsed = JSON.parse(raw) } catch (e) { return fresh }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fresh

  var decisions = ({})
  var stored = parsed.decisions
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (var key in stored) {
      var status = String(stored[key] === undefined || stored[key] === null ? "" : stored[key]).trim()
      if (status !== "") decisions[key] = status
    }
  }

  var candidates = []
  var list = parsed.candidates
  if (Array.isArray(list)) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i]
      if (!c || typeof c !== "object" || !c.key) continue
      candidates.push({
        key: String(c.key),
        target: String(c.target || ""),
        path: String(c.path || ""),
        fstype: String(c.fstype || ""),
        size: String(c.size || ""),
        label: String(c.label || ""),
        removable: c.removable === true,
        monitored: c.monitored === true
      })
    }
  }

  return {
    version: 1,
    onboarded: parsed.onboarded === true,
    updatedAt: String(parsed.updatedAt === undefined || parsed.updatedAt === null ? "" : parsed.updatedAt),
    decisions: decisions,
    candidates: candidates
  }
}

// The state as it goes to disk. `updatedAt` is passed in so the writing stays
// deterministic (and testable); the widget supplies the clock.
function serializeState(state, updatedAt) {
  var s = state || {}
  return JSON.stringify({
    version: 1,
    updatedAt: String(updatedAt || ""),
    onboarded: s.onboarded === true,
    decisions: s.decisions || {},
    candidates: s.candidates || []
  }, null, 2) + "\n"
}

// Record what has been asked about, without touching the state handed in. The
// widget re-reads the file whenever it changes, so a decline the agent wrote in
// the meantime lands in the next copy instead of being overwritten by the scan.
function markOffered(state, list, status) {
  var decisions = ({})
  var stored = state && state.decisions ? state.decisions : {}
  for (var key in stored) decisions[key] = stored[key]

  var notices = list || []
  for (var i = 0; i < notices.length; i++)
    if (notices[i] && notices[i].key) decisions[notices[i].key] = status

  return {
    version: 1,
    onboarded: true,
    updatedAt: state ? state.updatedAt : "",
    decisions: decisions,
    candidates: state && state.candidates ? state.candidates.slice(0) : []
  }
}

// The first-run notification: how many partitions the scan found, and the ask.
function onboardingBody(candidates) {
  var n = (candidates || []).length
  return n + " disk partition" + (n === 1 ? "" : "s") + " found. Click to choose which to monitor."
}

function onboardingAction() {
  return "Choose partitions to monitor"
}

function onboardingPrompt(candidates) {
  var list = candidates || []
  var n = list.length
  var names = []
  for (var i = 0; i < list.length; i++)
    names.push(list[i].target + " (" + list[i].fstype + ", " + list[i].size +
               (list[i].removable ? ", removable" : "") + ")")
  return "Mount Monitor: " + n + " disk partition" + (n === 1 ? "" : "s") + " on this machine " +
         (n === 1 ? "has" : "have") + " no ring yet - " + names.join(", ") + ". Run the partition-onboarding " +
         "skill: report each one with size, filesystem, and whether it is removable, ask which to monitor, " +
         "then wire the picks into the mount-monitor mounts setting in ~/.config/omarchy/shell.json."
}

// The one notice for a drive that appeared after onboarding. The copy is the
// captain's, fixed: one dismissable notice per new drive, no removable-vs-
// permanent question in it, and no pooling suggestion from the plugin. Whether
// to monitor it, pool it, or leave a stick alone is decided after the click, and
// the click's prompt carries every specific the popup leaves out.
function newPartitionBody(candidate) {
  return "Detected new drive. Click now to set up disk monitoring."
}

function newPartitionAction() {
  return "Set up disk monitoring"
}

function newPartitionPrompt(candidate) {
  var c = candidate || {}
  return "Mount Monitor: new " + (c.removable ? "removable " : "") + "partition " + c.target + " on " +
         c.path + " (" + c.fstype + ", " + c.size + ") just appeared and has no ring. Run the " +
         "partition-onboarding skill for this partition: report what it is and ask whether to monitor it, " +
         "then wire it into the mount-monitor mounts setting in ~/.config/omarchy/shell.json if accepted."
}

// The prompt a clicked notification sends to the agent. Every notification kind
// rides the same notify-send and agent plumbing, so the kind decides the ask:
// a band alert asks for disk-prune, an onboarding notice asks for
// partition-onboarding. An alert with no kind is a band alert, the only kind
// there was before onboarding existed.
function promptFor(alert) {
  if (!alert) return ""
  if (alert.kind === "onboarding") return onboardingPrompt(alert.candidates)
  if (alert.kind === "new-partition") return newPartitionPrompt(alert.candidate)
  return agentPrompt(alert)
}

// The popup's headline, action label, body, urgency, and how long it stays up -
// all dispatched on the same kind. A full drive is critical and never expires; an
// onboarding ask is normal and lingers long enough to be read and clicked.
function titleFor(alert) {
  if (!alert) return "Mount Monitor"
  if (alert.kind === "onboarding") return "Mount Monitor — partitions found"
  if (alert.kind === "new-partition") return "Mount Monitor — new partition"
  return "Mount Monitor — " + (alert.band === 3 ? "CRITICAL" : "warning")
}

function actionFor(alert) {
  if (!alert) return "Run cleanup analysis"
  if (alert.kind === "onboarding") return onboardingAction()
  if (alert.kind === "new-partition") return newPartitionAction()
  return notifyAction(alert)
}

function bodyFor(alert) {
  if (!alert) return ""
  if (alert.kind === "onboarding") return onboardingBody(alert.candidates)
  if (alert.kind === "new-partition") return newPartitionBody(alert.candidate)
  return notifyBody(alert)
}

function urgencyFor(alert) {
  return alert && alert.band === 3 ? "critical" : "normal"
}

function timeoutFor(alert) {
  if (!alert) return "6000"
  if (alert.band === 3) return "0"
  if (alert.kind === "onboarding" || alert.kind === "new-partition") return "12000"
  return "6000"
}
