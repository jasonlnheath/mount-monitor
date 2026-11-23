// Crash forensics (round 11) and the sustained RAM-pressure code. The captain
// asked the dash to answer "what went wrong" after a hard cycle: the journal
// watcher latches wedge-signature codes with their evidence and the latch
// survives restarts; sustained PSI pressure over the red ceiling is a code of
// its own, cleared by calm, never by a spike or a cache-resident footprint.
import test from "node:test";
import assert from "node:assert/strict";
import { Memory, Quattro, repoFile, same, fixture } from "./load.mjs";

const QML = repoFile("memory-monitor/MemoryMonitor.qml");
const PANEL = repoFile("memory-monitor/QuattroDash.qml");

// ---------------------------------------------------------------------------
// Module shape: plain declarations, the argvs, the constants
// ---------------------------------------------------------------------------

test("quattro.js declares the crash forensics and pressure-code decisions", () => {
  const source = repoFile("memory-monitor/quattro.js");
  for (const fn of [
    "crashWedgeArgs", "crashWedgePrevArgs", "crashLastArgs",
    "classifyCrashLine", "parseLastBoots", "uncleanShutdown",
    "crashSysUpdate", "crashRecordEntry", "crashSysCodes",
    "ackCrashRecord", "codeAckable", "crashSigOf", "crashSubject",
    "normalizeCrashLatched", "crashMergeLatched",
    "psiPressureSysCode", "codeAckToast",
    "crashBarEntry", "barBadgeWithCrash", "codeNotePayload",
  ]) {
    assert.match(source, new RegExp(`\\bfunction\\s+${fn}\\s*\\(`), `quattro.js must declare ${fn}`);
  }
});

test("the crash argvs are fixed programs: journalctl greps and one last read", () => {
  const boot = Quattro.crashWedgeArgs(1795256022.037356);
  assert.equal(boot[0], "journalctl");
  assert.equal(boot.includes("-b"), true, "boot 0 is scanned");
  assert.equal(boot.includes("-k"), true, "kernel messages only, userspace noise stays out");
  assert.equal(boot.includes("--since=@1795256022.037356"), true, "the cursor rides --since=@");
  assert.equal(boot.includes("-n"), true, "output is capped");
  assert.equal(boot.includes(Quattro.CRASH_GREP_PATTERN), true, "the pattern is one fixed alternation");

  const first = Quattro.crashWedgeArgs(null);
  assert.equal(first.includes("--since=@null"), false, "no cursor means no since flag");

  const prev = Quattro.crashWedgePrevArgs();
  assert.equal(prev[0], "journalctl");
  assert.equal(prev.includes("-b"), true);
  assert.equal(prev.includes("-1"), true, "the previous boot is scanned");
  assert.equal(prev.includes("--since=@null"), false, "the prev scan is once per session, no cursor");

  const last = Quattro.crashLastArgs();
  assert.equal(last[0], "last");
  assert.equal(last.includes("-x"), true);
  assert.equal(last.includes("shutdown"), true);
  assert.equal(last.includes("reboot"), true, "both row kinds are asked for");
  for (const argv of [boot, prev, last]) {
    for (const part of argv) {
      assert.equal(typeof part, "string");
      assert.equal(/[;&`$\n]/.test(part), false, `no shell metacharacter beyond the grep alternation: ${part}`);
    }
  }
});

test("the named constants: bounded scans, minute-scale pressure windows", () => {
  assert.equal(typeof Quattro.CRASH_MAX_LINES, "number");
  assert.equal(Quattro.CRASH_MAX_LINES, 80);
  assert.equal(Quattro.PSI_CODE_SUSTAIN_SEC, 180, "the sustain window is on the order of minutes");
  assert.equal(Quattro.PSI_CODE_CLEAR_SEC, 300, "the clearing window too");
  assert.equal(typeof Quattro.PSI_CODE_GAP_MS, "number");
  assert.equal(Quattro.PSI_CODE_GAP_MS >= 60000, true, "a sleep-sized gap restarts the windows");
  same(Quattro.CRASH_SIGS, ["lockup", "rcu", "hung", "watchdog", "nvrm", "oom", "power"]);
  assert.equal(Quattro.CRASH_BANDS.lockup, 2);
  assert.equal(Quattro.CRASH_BANDS.rcu, 2);
  assert.equal(Quattro.CRASH_BANDS.hung, 2);
  assert.equal(Quattro.CRASH_BANDS.watchdog, 2);
  assert.equal(Quattro.CRASH_BANDS.nvrm, 2, "the NVRM wedge family is severe");
  assert.equal(Quattro.CRASH_BANDS.oom, 1, "an oom kill is moderate evidence");
  assert.equal(Quattro.CRASH_BANDS.power, 1, "an unclean boundary is moderate evidence");
  assert.equal(Quattro.SYS_SUBJECTS.crash, "sys|crash");
  assert.equal(Quattro.SYS_SUBJECTS.ram, "sys|ram");
});

// ---------------------------------------------------------------------------
// Journal signature classification, on the rig's own lines
// ---------------------------------------------------------------------------

test("classifyCrashLine: every signature classifies from the real boot -1 lines", () => {
  const lines = Quattro.parseJournalLines(fixture("crash-journal-prev.txt"));
  assert.equal(lines.length, 8, "all eight real lines parse");
  const sigs = lines.map(l => Quattro.classifyCrashLine(l.message));
  same(sigs.slice(0, 3), ["lockup", "rcu", "lockup"]);
  same(sigs.slice(3, 5), ["rcu", "rcu"]);
  same(sigs.slice(5), ["oom", "oom", "oom"]);
});

test("classifyCrashLine: precedence keeps one line one signature", () => {
  assert.equal(
    Quattro.classifyCrashLine("watchdog: BUG: soft lockup - CPU#19 stuck for 49s! [kcompactd0:225]"),
    "lockup",
    "the real wedge line is lockup evidence, not watchdog and lockup",
  );
  assert.equal(Quattro.classifyCrashLine("usb 1-2: new high-speed USB device number 5 using xhci_hcd"), null);
  assert.equal(Quattro.classifyCrashLine(""), null);
});

test("parseJournalLines: separators and no-entry markers never become evidence", () => {
  const lines = Quattro.parseJournalLines(fixture("crash-journal-boot.txt"));
  assert.equal(lines.length, 4, "the boot separator line is skipped");
  assert.equal(lines[0].epoch, 1795280100.1);
  assert.equal(Quattro.parseJournalLines("-- No entries --").length, 0);
});

test("classifyCrashLine: the boot-0 fixture classifies nvrm, hung and watchdog", () => {
  const lines = Quattro.parseJournalLines(fixture("crash-journal-boot.txt"));
  const sigs = lines.map(l => Quattro.classifyCrashLine(l.message));
  same(sigs, ["nvrm", "hung", "watchdog", null]);
});

// ---------------------------------------------------------------------------
// wtmp boundary: the unclean shutdown decision
// ---------------------------------------------------------------------------

test("parseLastBoots: rows are kind, iso and raw, newest first, junk skipped", () => {
  const rows = Quattro.parseLastBoots(fixture("crash-last-unclean.txt"));
  assert.equal(rows.length, 4, "the wtmp begins footer never becomes a row");
  assert.equal(rows[0].kind, "reboot");
  assert.equal(rows[0].iso, "2026-11-21T11:31:13-05:00");
  assert.equal(rows[1].kind, "reboot");
  assert.equal(rows[2].kind, "shutdown");
  assert.equal(rows[2].iso, "2026-11-16T09:52:00-05:00");
  assert.equal(rows[3].kind, "reboot");
  assert.equal(rows[0].raw.indexOf("reboot"), 0, "the raw line is kept as evidence");
});

test("uncleanShutdown: the hard-cycle boundary is unclean, the paired boundary is clean", () => {
  const unclean = Quattro.uncleanShutdown(Quattro.parseLastBoots(fixture("crash-last-unclean.txt")));
  assert.equal(unclean.unclean, true, "reboot follows reboot: the previous boot never ended cleanly");
  assert.equal(unclean.iso, "2026-11-16T09:52:54-05:00", "the iso is the crashed boot's start");

  const clean = Quattro.uncleanShutdown(Quattro.parseLastBoots(fixture("crash-last-clean.txt")));
  assert.equal(clean.unclean, false, "shutdown follows reboot: a clean boundary");

  assert.equal(Quattro.uncleanShutdown([]), null, "no rows answer nothing");
  assert.equal(Quattro.uncleanShutdown([{ kind: "reboot", iso: "x", raw: "r" }]), null, "a single boot answers nothing");
  assert.equal(Quattro.uncleanShutdown(null), null);
});

// ---------------------------------------------------------------------------
// The latch: latching, entries, persistence across a simulated restart
// ---------------------------------------------------------------------------

const prevFixtureUpdate = (latched, cursor) => Quattro.crashSysUpdate(
  { text: fixture("crash-journal-prev.txt"), exit: 0, done: true },
  { text: fixture("crash-last-unclean.txt"), exit: 0, done: true },
  { text: "-- No entries --", exit: 1 },
  cursor === undefined ? null : cursor,
  latched === undefined ? {} : latched,
);

test("crashSysUpdate latches the wedge signatures with evidence and stable ids", () => {
  const result = prevFixtureUpdate();
  assert.equal(result.changed, true, "a fresh latch is a change");
  const latched = result.latched;
  same(Object.keys(latched).sort(), ["lockup", "oom", "power", "rcu"]);

  assert.equal(latched.lockup.count, 2, "the two real soft lockups");
  assert.equal(latched.lockup.boot, -1);
  assert.equal(latched.rcu.count, 3, "the three real RCU stalls");
  assert.equal(latched.oom.count, 3, "the three real oom lines");
  assert.equal(latched.lockup.firstEpoch, 1795255994.037357, "first seen is the older lockup");
  assert.equal(latched.lockup.lastEpoch, 1795256022.037356, "last seen is the newer lockup");
  assert.equal(latched.lockup.lines.length, 2, "the evidence lines ride the latch");
  assert.equal(latched.lockup.lines[1].message.indexOf("watchdog: BUG: soft lockup"), 0, "the exact line is kept");

  assert.equal(latched.power.bootIso, "2026-11-16T09:52:54-05:00", "the power latch carries the crashed boot's start");
  assert.equal(latched.power.count, 1);

  const entries = result.entries;
  const bySig = {};
  for (const e of entries) bySig[Quattro.crashSigOf(e)] = e;
  for (const sig of ["lockup", "rcu", "oom", "power"]) {
    assert.match(bySig[sig].code, /^C\d{4}$/, "a stable code over the stable subject");
    assert.equal(Memory.isMemId(bySig[sig].alert.id), true, "the id is a real mem id");
    assert.equal(bySig[sig].band, Quattro.CRASH_BANDS[sig]);
    assert.equal(bySig[sig].alert.type, "sys", "the crash family rides the sys taxonomy");
    assert.equal(bySig[sig].alert.sys, "crash");
    assert.equal(bySig[sig].alert.key, Quattro.crashSubject(sig));
  }
  assert.match(bySig.lockup.issue, /Soft lockup: 2 hits\. Culprit: kcompactd0\./, "the culprit names the stuck task");
  assert.match(bySig.rcu.issue, /RCU stall: 3 hits\./);
  assert.match(bySig.oom.issue, /OOM kill: 3 hits\. Victim: python3\./);
  assert.match(bySig.power.issue, /did not end cleanly/);
  assert.equal(bySig.lockup.status, Quattro.SYS_STATUS.crashSevere);
  assert.equal(bySig.power.status, Quattro.SYS_STATUS.crashModerate);
});

test("crashSysCodes renders the same entries from a normalized round trip", () => {
  const first = prevFixtureUpdate();
  // A simulated restart: the JSON file round trip, then a fresh update over
  // the same scans. Same lines, epochs already counted, no double count.
  const reloaded = Quattro.normalizeCrashLatched(JSON.parse(JSON.stringify({ codes: first.latched })));
  assert.equal(reloaded.codes.power.bootIso, first.latched.power.bootIso, "the iso survives the file");
  assert.equal(reloaded.codes.lockup.count, 2, "counts survive the file");

  const again = prevFixtureUpdate(reloaded.codes, null);
  assert.equal(again.changed, false, "the same evidence twice is not a change");
  assert.equal(again.latched.lockup.count, 2, "no double count across the restart");

  const before = Quattro.crashSysCodes(first.latched).map(e => e.code).sort();
  const after = Quattro.crashSysCodes(again.latched).map(e => e.code).sort();
  same(after, before, "the same codes show after the restart");
});

test("normalizeCrashLatched drops junk and clamps hostile evidence", () => {
  const norm = Quattro.normalizeCrashLatched({
    codes: {
      lockup: { sig: "lockup", boot: -1, firstEpoch: 1, lastEpoch: 2, count: 3,
        lines: [{ epoch: 2, message: "x".repeat(400) }] },
      evil: { sig: "evil", boot: -1, count: 1 },
      broken: { sig: "rcu", count: "many" },
      "not-an-object": 7,
    },
    junk: true,
  });
  same(Object.keys(norm.codes), ["lockup"], "unknown signatures and junk records drop");
  assert.equal(norm.codes.lockup.count, 3);
  assert.equal(norm.codes.lockup.lines[0].message.length <= 200, true, "evidence lines are sanitized to the record cap");
  assert.equal(Quattro.normalizeCrashLatched(null).codes !== null, true);
  same(Quattro.normalizeCrashLatched("garbage").codes, {});
});

test("crashMergeLatched: the newer record wins, the older map never erases fresh evidence", () => {
  const a = Quattro.normalizeCrashLatched({ codes: {
    lockup: { sig: "lockup", boot: -1, firstEpoch: 1, lastEpoch: 10, count: 2, lines: [] },
  } }).codes;
  const b = Quattro.normalizeCrashLatched({ codes: {
    lockup: { sig: "lockup", boot: 0, firstEpoch: 20, lastEpoch: 30, count: 5, lines: [] },
    oom: { sig: "oom", boot: 0, firstEpoch: 20, lastEpoch: 30, count: 1, lines: [] },
  } }).codes;
  const merged = Quattro.crashMergeLatched(a, b);
  assert.equal(merged.lockup.count, 5, "the newer lastEpoch wins");
  assert.equal(merged.oom.count, 1, "records only in the overlay join");
  const mergedBack = Quattro.crashMergeLatched(b, a);
  assert.equal(mergedBack.lockup.count, 5, "either side: the newer record wins");
});

test("crashSysUpdate: the cursor advances and the boot delta never recounts prev lines", () => {
  const first = prevFixtureUpdate();
  assert.equal(first.cursor, 1795256022.037356, "the cursor is the newest line the watcher consumed");
  assert.equal(first.latched.lockup.count, 2);

  // Next cycle: the boot scan is clean, the cursor holds.
  const second = Quattro.crashSysUpdate(
    { text: "", exit: 1, done: true },
    { text: "", exit: 0, done: true },
    { text: "-- No entries --", exit: 1 },
    first.cursor,
    first.latched,
  );
  assert.equal(second.changed, false);
  assert.equal(second.cursor, first.cursor);
  assert.equal(second.latched.lockup.count, 2, "clean cycles add nothing");
});

test("crashSysUpdate latches new boot-0 signatures and refreshes evidence", () => {
  const base = prevFixtureUpdate();
  const updated = Quattro.crashSysUpdate(
    { text: "", exit: 1, done: true },
    { text: "", exit: 0, done: true },
    { text: fixture("crash-journal-boot.txt"), exit: 0 },
    base.cursor,
    base.latched,
  );
  assert.equal(updated.changed, true);
  const latched = updated.latched;
  assert.equal(latched.nvrm.count, 1, "a new signature latches");
  assert.equal(latched.nvrm.boot, 0, "the record knows which boot carried it");
  assert.equal(latched.hung.count, 1);
  assert.equal(latched.watchdog.count, 1, "the pure watchdog line is watchdog evidence");
  assert.equal(latched.lockup.count, 2, "existing records keep their count");
  const entries = Quattro.crashSysCodes(latched);
  const nvrm = entries.find(e => Quattro.crashSigOf(e) === "nvrm");
  assert.equal(nvrm.band, 2);
  assert.match(nvrm.issue, /NVRM error: 1 hit in the log\./);
  const hung = entries.find(e => Quattro.crashSigOf(e) === "hung");
  assert.match(hung.issue, /Culprit: jbd2\/sda2-8\./, "the hung task names its task");
  assert.match(latched.nvrm.lines[0].message, /^NVRM: Xid/, "the evidence line rides");
  assert.equal(updated.cursor, 1795280400.4);
});

test("crashSysUpdate: unreadable scans render the honest unknown row and latch nothing", () => {
  for (const badExit of [2, 127, -1]) {
    const result = Quattro.crashSysUpdate(
      { text: "", exit: badExit, done: true },
      { text: "", exit: 0, done: true },
      { text: "", exit: 1 },
      null,
      {},
    );
    assert.equal(result.changed, false, "exit " + badExit + " latches nothing");
    same(Object.keys(result.latched), []);
    assert.equal(result.entries.length, 1, "one unknown row");
    assert.equal(result.entries[0].status, Quattro.SYS_STATUS.unknown);
    assert.match(result.entries[0].issue, /unreadable/);
  }

  const recovered = Quattro.crashSysUpdate(
    { text: "-- No entries --", exit: 1, done: true },
    { text: "", exit: 0, done: true },
    { text: "-- No entries --", exit: 1 },
    null,
    {},
  );
  same(recovered.entries, [], "a readable cycle clears the unknown row");

  const inFlight = Quattro.crashSysUpdate(
    { text: "", exit: 0, done: false },
    { text: "", exit: 0, done: false },
    { text: "-- No entries --", exit: 1 },
    null,
    {},
  );
  same(inFlight.entries, [], "a scan that has not answered yet says nothing");
});

test("crashSysUpdate: an unreadable once-per-session answer is unknown now and retried, never latched done", () => {
  // A watchdog kill or a transient journalctl failure answers unreadable and
  // not done: the honest unknown row this cycle, the reader again next cycle,
  // the evidence latching when a scan finally answers readably.
  const poisoned = Quattro.crashSysUpdate(
    { text: "", exit: 15, done: false },
    { text: "", exit: 15, done: false },
    { text: "", exit: 1 },
    null,
    {},
  );
  assert.equal(poisoned.changed, false, "an unreadable answer latches nothing");
  assert.equal(poisoned.entries.length, 1, "the unreadable lanes render one unknown row");
  assert.equal(poisoned.entries[0].status, Quattro.SYS_STATUS.unknown);

  const recovered = Quattro.crashSysUpdate(
    { text: fixture("crash-journal-prev.txt"), exit: 0, done: true },
    { text: fixture("crash-last-unclean.txt"), exit: 0, done: true },
    { text: "-- No entries --", exit: 1 },
    null,
    poisoned.latched,
  );
  same(recovered.entries.filter(e => e.status === Quattro.SYS_STATUS.unknown), [], "a readable retry clears the unknown row");
  assert.equal(recovered.latched.lockup.count, 2, "the retried prev-boot evidence latches");
  assert.equal(recovered.latched.power.bootIso, "2026-11-16T09:52:54-05:00", "the retried wtmp boundary latches");
});

test("crashSysUpdate: an acknowledged signature cannot rebuild from the session's retired scans", () => {
  const first = prevFixtureUpdate();
  const acked = Quattro.ackCrashRecord(first.latched, "lockup");
  // ackCrashCode retires the cached prev-boot and wtmp text with the record,
  // so the next cycle's once-per-session feeds are empty and readable.
  const next = Quattro.crashSysUpdate(
    { text: "", exit: 0, done: true },
    { text: "", exit: 0, done: true },
    { text: "-- No entries --", exit: 1 },
    first.cursor,
    acked,
  );
  assert.equal(next.changed, false, "no crash-codes.json rewrite off retired evidence");
  assert.equal(next.latched.lockup, undefined, "the acknowledge holds to the next cycle");
  assert.equal(next.latched.oom.count, first.latched.oom.count, "the unacked signatures keep their latch");

  const fresh = Quattro.crashSysUpdate(
    { text: "", exit: 0, done: true },
    { text: "", exit: 0, done: true },
    { text: fixture("crash-journal-boot.txt"), exit: 0 },
    next.cursor,
    next.latched,
  );
  assert.equal(fresh.latched.nvrm.count, 1, "genuinely new evidence past the cursor still latches");
});

test("crashSysUpdate: a clean boundary never clears a power latch, a new one refreshes it", () => {
  const first = prevFixtureUpdate();
  const later = Quattro.crashSysUpdate(
    { text: "-- No entries --", exit: 1, done: true },
    { text: fixture("crash-last-clean.txt"), exit: 0, done: true },
    { text: "-- No entries --", exit: 1 },
    first.cursor,
    first.latched,
  );
  assert.equal(later.latched.power.bootIso, first.latched.power.bootIso, "a clean boundary does not clear the latch");
  assert.equal(later.changed, false);

  const wedgedAgain = Quattro.crashSysUpdate(
    { text: "-- No entries --", exit: 1, done: true },
    { text: fixture("crash-last-unclean.txt"), exit: 0, done: true },
    { text: "-- No entries --", exit: 1 },
    later.cursor,
    later.latched,
  );
  assert.equal(wedgedAgain.latched.power.bootIso, "2026-11-16T09:52:54-05:00", "the freshest unclean boundary is the evidence");
});

test("ackCrashRecord removes exactly the acknowledged signature", () => {
  const first = prevFixtureUpdate();
  const latched = first.latched;
  const acked = Quattro.ackCrashRecord(latched, "lockup");
  assert.equal(acked.lockup === undefined, true);
  assert.equal(acked.rcu.count, latched.rcu.count, "the others survive");
  assert.equal(acked.power.bootIso, latched.power.bootIso);
  const absent = Quattro.ackCrashRecord(latched, "nvrm");
  assert.deepEqual(JSON.parse(JSON.stringify(absent)), JSON.parse(JSON.stringify(latched)), "acking an absent signature changes nothing");
});

test("codeAckable accepts every fault code and refuses states, drives and junk", () => {
  const first = prevFixtureUpdate();
  const crashEntry = first.entries.find(e => Quattro.crashSigOf(e) === "lockup");
  assert.equal(Quattro.codeAckable(crashEntry), true);
  const driveEntry = { alert: { type: "hd", key: "x" } };
  assert.equal(Quattro.codeAckable(driveEntry), false);
  // Round 13: the live fault codes are clearable too - the captain's C2192
  // right-click was a silent no-op before this. The honest unknown rows and
  // the dead-shell state stay unclearable: they are sensor states, not
  // occurrences, and hiding a broken sensor would lie.
  const barEntry = Quattro.barSysCode(Quattro.parseBarProbe("196167\n144"), 0);
  assert.equal(Quattro.codeAckable(barEntry), true, "the bar restart code clears by right-click like every fault code");
  const kernelEntry = { alert: { type: "sys", sys: "kernel", key: Quattro.SYS_SUBJECTS.kernel,
    detail: { newLines: 2, culprit: "igc", lines: [], untilEpoch: 1795300100 } } };
  assert.equal(Quattro.codeAckable(kernelEntry), true);
  const unknownEntry = { alert: { type: "sys", sys: "kernel", key: Quattro.SYS_SUBJECTS.kernel } };
  assert.equal(Quattro.codeAckable(unknownEntry), false, "an unknown row is a state, never an occurrence");
  assert.equal(Quattro.codeAckable(null), false);
});

// ---------------------------------------------------------------------------
// The bar emblem tells the truth about the latch (round 12): a latched crash
// code lights the icon at its own band until the acknowledge clears it.
// ---------------------------------------------------------------------------

test("crashBarEntry: the latched codes light the icon at their own bands", () => {
  same(Quattro.crashBarEntry([]), null, "no codes, no light");
  same(Quattro.crashBarEntry(null), null);
  same(Quattro.crashBarEntry([null, 7, "junk"]), null, "junk entries are not latches");

  const first = prevFixtureUpdate();
  const lit = Quattro.crashBarEntry(first.entries);
  assert.notEqual(lit, null, "latched wedge evidence lights the icon");
  assert.equal(lit.band, 2, "lockup and rcu are band 2, the worst latch wins");
  assert.equal(lit.type, "crash");
  assert.equal(lit.latched, true);

  const moderate = first.entries.filter(e => {
    const sig = Quattro.crashSigOf(e);
    return sig === "oom" || sig === "power";
  });
  const amber = Quattro.crashBarEntry(moderate);
  assert.notEqual(amber, null, "oom and power alone still light the icon");
  assert.equal(amber.band, 1, "the moderate latches stay amber");

  const unknown = Quattro.crashSysUpdate(
    { text: "", exit: 2, done: true },
    { text: "", exit: 0, done: true },
    { text: "", exit: 1 },
    null, {});
  same(Quattro.crashBarEntry(unknown.entries), null, "an unreadable scan is not a latch and never lights the icon");

  const kernelEntry = { alert: { type: "sys", sys: "kernel", key: Quattro.SYS_SUBJECTS.kernel } };
  const driveEntry = { alert: { type: "hd", key: "partuuid:aabb" } };
  same(Quattro.crashBarEntry([kernelEntry, driveEntry]), null,
    "live round-9 codes and drive entries are not latches");
});

test("barBadgeWithCrash: live faults keep the badge, the history only raises the band", () => {
  const live1 = { type: "ram", band: 1 };
  assert.equal(Quattro.barBadgeWithCrash(live1, []), live1, "no history, the live entry rides unchanged");
  assert.equal(Quattro.barBadgeWithCrash(live1, [null, "junk"]), live1, "junk history too");

  const liveEntry = { type: "hd", band: 1, pct: 91 };
  const tie = Quattro.barBadgeWithCrash(liveEntry,
    [{ alert: { type: "sys", sys: "crash", key: Quattro.crashSubject("oom") } }]);
  assert.equal(tie, liveEntry, "an equal band keeps the live entry, the icon looks as it always did");

  const raised = Quattro.barBadgeWithCrash(liveEntry,
    [{ alert: { type: "sys", sys: "crash", key: Quattro.crashSubject("lockup") } }]);
  assert.notEqual(raised, liveEntry, "a history that outranks the live fault replaces the entry");
  same(raised, { type: "crash", band: 2, latched: true });

  const liveRed = { type: "ram", band: 2 };
  assert.equal(Quattro.barBadgeWithCrash(liveRed,
    [{ alert: { type: "sys", sys: "crash", key: Quattro.crashSubject("oom") } }]), liveRed,
    "live red plus a latched amber stays live red, never a downgrade");

  assert.equal(Quattro.barBadgeWithCrash(null, []), null, "all clear is white");
  const amberAlone = Quattro.barBadgeWithCrash(null,
    [{ alert: { type: "sys", sys: "crash", key: Quattro.crashSubject("oom") } }]);
  same(amberAlone, { type: "crash", band: 1, latched: true }, "a moderate latch alone lights amber");
  const redAlone = Quattro.barBadgeWithCrash(null,
    [{ alert: { type: "sys", sys: "crash", key: Quattro.crashSubject("nvrm") } }]);
  same(redAlone, { type: "crash", band: 2, latched: true }, "a severe latch alone lights red");
});

test("acknowledged codes stop lighting the icon", () => {
  const first = prevFixtureUpdate();

  const acked = Quattro.ackCrashRecord(first.latched, "lockup");
  const stillUp = Quattro.crashSysUpdate(
    { text: "", exit: 1, done: true },
    { text: "", exit: 0, done: true },
    { text: "-- No entries --", exit: 1 },
    first.cursor, acked);
  assert.equal(Quattro.crashBarEntry(stillUp.entries).band, 2, "rcu keeps the red until its own acknowledge");

  let latched = Quattro.ackCrashRecord(acked, "rcu");
  latched = Quattro.ackCrashRecord(latched, "oom");
  latched = Quattro.ackCrashRecord(latched, "power");
  const cleared = Quattro.crashSysUpdate(
    { text: "", exit: 1, done: true },
    { text: "", exit: 0, done: true },
    { text: "-- No entries --", exit: 1 },
    first.cursor, latched);
  assert.equal(cleared.changed, false, "no scan can rebuild an acknowledged signature");
  same(Quattro.crashBarEntry(cleared.entries), null, "every acknowledged code leaves the icon white");
});

test("the crash Fix line carries the acknowledge instruction plainly", () => {
  const first = prevFixtureUpdate();
  for (const e of first.entries) {
    const sig = Quattro.crashSigOf(e);
    assert.match(e.fix, /right-click/, sig + " names the right-click clear");
    assert.match(e.fix, /until new evidence arrives/, sig + " promises the clear holds until new evidence");
  }
  // Every clearable fault code names the clear the same way: the bar restart
  // code the captain could not dismiss now says how it dismisses. The honest
  // unknown rows keep the shared SYS_FIX words: a right-click on a sensor
  // state does nothing, so they never say it.
  const bar = Quattro.barSysCode(Quattro.parseBarProbe("196167\n144"), 0);
  assert.match(bar.fix, /right-click/);
  const unknown = Quattro.barSysCode(Quattro.parseBarProbe(""), 0);
  assert.equal(unknown.fix, Quattro.SYS_FIX.moderate);
});

test("MemoryMonitor.qml builds the bar badge through quattro's aggregation", () => {
  assert.equal(QML.includes("Quattro.barBadgeWithCrash("), true, "the widget delegates the aggregation");
  assert.equal(QML.includes("Memory.mostSevereForBar("), true, "the live side stays memory.js's decision");
});

// ---------------------------------------------------------------------------
// The sustained RAM-pressure code
// ---------------------------------------------------------------------------

const T = { amber: 15, red: 28 };
const STEP = 2000;

function runPressure(samples, opts) {
  // samples: array of [psi, gapMs] pairs; gapMs between samples.
  const sustain = opts && opts.sustain !== undefined ? opts.sustain : -1;
  const quiet = opts && opts.quiet ? true : false;
  let prev = { aboveSinceMs: null, belowSinceMs: null, latched: false, atMs: null };
  let latchedAt = null;
  let clearedAt = null;
  let nowMs = 1000000;
  for (const s of samples) {
    nowMs += s[1];
    const r = Quattro.psiPressureSysCode(s[0], T, prev, nowMs, sustain, quiet);
    prev = r.next;
    if (r.entry && latchedAt === null) latchedAt = nowMs;
    if (!r.entry && latchedAt !== null && clearedAt === null) clearedAt = nowMs;
  }
  return { prev, latchedAt, clearedAt };
}

test("psiPressureSysCode: a single spike stays gauge-only", () => {
  const run = runPressure([[0, STEP], [30, STEP], [31, STEP], [35, STEP], [0, STEP], [0, STEP], [0, STEP], [0, STEP], [0, STEP], [0, STEP]]);
  assert.equal(run.prev.latched, false, "one spike over red never latches");
});

test("psiPressureSysCode: sustained red pressure latches band 2", () => {
  const samples = [];
  for (let i = 0; i < 95; i++) samples.push([30, STEP]);
  const run = runPressure(samples);
  assert.equal(run.prev.latched, true, "three minutes over the red line latches");
  assert.equal(run.latchedAt, 1000000 + STEP + Quattro.PSI_CODE_SUSTAIN_SEC * 1000, "the latch lands when the window fills");
  assert.equal(run.prev.aboveSinceMs, 1000000 + STEP, "the window start is held");
});

test("psiPressureSysCode: the sustain window honors the override", () => {
  const samples = [];
  for (let i = 0; i < 20; i++) samples.push([30, STEP]);
  const run = runPressure(samples, { sustain: 30 });
  assert.equal(run.prev.latched, true, "a 30 s window latches at 30 s");
  assert.equal(run.latchedAt, 1000000 + STEP + 30 * 1000, "a 30 s window latches at 30 s");
});

test("psiPressureSysCode: a cache-resident machine at PSI 0 never latches", () => {
  // used% is not an input anywhere: 99 percent used with zero stall time is
  // green, forever, whatever the footprint says.
  const samples = [];
  for (let i = 0; i < 200; i++) samples.push([0, STEP]);
  const run = runPressure(samples);
  assert.equal(run.prev.latched, false);
});

test("psiPressureSysCode: pressure falling under amber clears, and mid-clear crossings restart the window", () => {
  const samples = [];
  for (let i = 0; i < 95; i++) samples.push([30, STEP]);
  const latched = runPressure(samples);
  assert.equal(latched.prev.latched, true);

  // Calm under amber: the clearing window is five minutes.
  const samples2 = [];
  for (let i = 0; i < 160; i++) samples2.push([2, STEP]);
  const cleared = runPressure(samples2.map(s => [s[0], s[1]]), {});
  assert.equal(cleared.prev.latched, false, "sustained calm unlatches on its own run");

  // From the latched state: calm for four minutes, one amber sample restarts
  // the clear window, then calm completes.
  let prev = latched.prev;
  let nowMs = 1000000;
  let r;
  for (let i = 0; i < 120; i++) { nowMs += STEP; r = Quattro.psiPressureSysCode(2, T, prev, nowMs, -1, false); prev = r.next; }
  assert.equal(prev.latched, true, "still clearing");
  nowMs += STEP;
  r = Quattro.psiPressureSysCode(20, T, prev, nowMs, -1, false); prev = r.next;
  assert.equal(prev.latched, true, "a mid-clear crossing holds the latch");
  assert.equal(prev.belowSinceMs, null, "the clear window restarts");
  nowMs += STEP;
  r = Quattro.psiPressureSysCode(2, T, prev, nowMs, -1, false); prev = r.next;
  assert.equal(prev.belowSinceMs, nowMs, "the window restarted at the calm sample");
  let clearedAt = null;
  for (let i = 0; i < 150; i++) {
    nowMs += STEP;
    r = Quattro.psiPressureSysCode(2, T, prev, nowMs, -1, false);
    prev = r.next;
    if (!prev.latched && clearedAt === null) clearedAt = nowMs;
  }
  assert.equal(prev.latched, false, "the completed clear window unlatches");
});

test("psiPressureSysCode: a lost reading keeps state and a latched code shows", () => {
  const run = runPressure([[0, STEP]]);
  const r = Quattro.psiPressureSysCode(null, T, run.prev, 999999999, -1, false);
  same(r.next, run.prev, "no reading, no state change");
  assert.equal(r.entry, null);

  const samples = [];
  for (let i = 0; i < 95; i++) samples.push([30, STEP]);
  const latched = runPressure(samples);
  assert.equal(latched.prev.latched, true);
  const lost = Quattro.psiPressureSysCode(null, T, latched.prev, latched.prev.atMs + STEP, -1, false);
  assert.equal(lost.entry !== null, true, "a latched pressure code stays visible while the reading is out");
});

test("psiPressureSysCode: a sleep-sized gap restarts the windows, not the latch", () => {
  const start = runPressure([[30, STEP], [30, STEP]]);
  assert.equal(start.prev.aboveSinceMs, 1000000 + STEP);
  const afterSleep = Quattro.psiPressureSysCode(30, T, start.prev, start.prev.atMs + 3600000, -1, false);
  assert.equal(afterSleep.next.latched, false, "no latch across the jump");
  assert.equal(afterSleep.next.aboveSinceMs, start.prev.atMs + 3600000, "the window restarts now");
});

test("psiPressureSysCode: quiet neither latches nor accumulates", () => {
  const before = runPressure([[30, STEP], [30, STEP]]);
  let prev = before.prev;
  let nowMs = before.prev.atMs;
  let r;
  for (let i = 0; i < 200; i++) {
    nowMs += STEP;
    r = Quattro.psiPressureSysCode(33, T, prev, nowMs, -1, true);
    prev = r.next;
  }
  same(prev, before.prev, "a calibration run freezes the pressure state");
  assert.equal(r.entry, null, "and shows nothing while it holds");
});

test("psiPressureSysCode: the entry copy is pressure words over the ram subject", () => {
  const samples = [];
  for (let i = 0; i < 95; i++) samples.push([30, STEP]);
  const run = runPressure(samples);
  assert.equal(run.prev.latched, true);
  const r = Quattro.psiPressureSysCode(31.4, T, run.prev, run.prev.atMs + STEP, -1, false);
  assert.equal(r.entry.band, 2);
  assert.equal(r.entry.alert.type, "sys", "it rides the sys taxonomy");
  assert.equal(r.entry.alert.sys, "ram");
  assert.equal(r.entry.alert.key, Quattro.SYS_SUBJECTS.ram);
  assert.equal(Memory.isMemId(r.entry.alert.id), true);
  assert.match(r.entry.issue, /RAM pressure sustained: 31\.4 PSI held \d+ minutes?\./);
  assert.equal(r.entry.status, Quattro.SYS_STATUS.severe, "the locked severe status line");
  assert.match(r.entry.fix, /right-click/, "the pressure code is clearable like every fault code");
});

// ---------------------------------------------------------------------------
// Wiring pins: the widget runs the scans, the dash asks before it clears
// ---------------------------------------------------------------------------

test("MemoryMonitor.qml runs the three crash readers through quattro argvs", () => {
  assert.equal(QML.includes("Quattro.crashWedgeArgs("), true);
  assert.equal(QML.includes("Quattro.crashWedgePrevArgs()"), true);
  assert.equal(QML.includes("Quattro.crashLastArgs()"), true);
  assert.equal(QML.includes('"crashboot", "crashprev", "crashlast"'), true, "the cycle waits for the crash reads");
  assert.equal(QML.includes("Quattro.crashSysUpdate("), true);
  assert.equal(QML.includes("Quattro.psiPressureSysCode("), true);
  assert.equal(QML.includes("Memory.crashPath("), true, "the latch path comes from memory.js");
  assert.equal(QML.includes("Quattro.normalizeCrashLatched("), true);
  assert.equal(QML.includes("Quattro.crashMergeLatched("), true);
  assert.equal(QML.includes('crashPrevText = ""'), true, "the acknowledge retires the cached prev-boot scan");
  assert.equal(QML.includes('crashLastText = ""'), true, "and the cached wtmp read, so neither can rebuild a cleared record");
  assert.equal(QML.includes("crashPrevDone = exitCode === 0 || exitCode === 1"), true, "the prev lane satisfies only on a readable exit");
  assert.equal(QML.includes("crashLastDone = exitCode === 0 || exitCode === 1"), true, "so does the wtmp lane");
});

test("QuattroDash.qml acknowledges through the monitor, never the latch map", () => {
  assert.equal(PANEL.includes('callMonitor("ackCode"'), true, "the clear rides the monitor");
  assert.equal(PANEL.includes("Quattro.codeAckToast("), true);
  assert.equal(PANEL.includes("crashLatched"), false, "the dash never touches the latch map");
});

test("memory.js owns the crash state path", () => {
  assert.equal(Memory.crashPath("/home/j"), "/home/j/.local/state/memory-monitor/crash-codes.json");
  assert.equal(Memory.crashPath(""), "/.local/state/memory-monitor/crash-codes.json");
});
