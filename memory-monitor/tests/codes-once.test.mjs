// Round 13: once per engine-code occurrence. The captain's 2026-11-23 ruling:
// "it keeps throwing the same engine codes even though I've already seen them.
// I'll click them and they will come to you. we need to make sure that the user
// is only notified once per engine code." and "i was able to clear all codes
// except for c2192. when i right click it will not clear for some reason."
//
// The evidence: after every bar restart the once-per-session boot -1 scan
// re-latched the same crash codes (the acknowledge left no durable record), and
// C2192 - the live bar-restart code - was never clearable at all, because
// codeAckable accepted crash entries only and its issue text carries a changing
// age, so a dismiss keyed on anything the row prints could never match twice.
//
// The rule this file pins: an engine-code occurrence is identified by a stable
// signature (the restart event, the evidence epochs, the counter - never the
// human text or the age), the seen ledger persists beside the latch, a seen
// occurrence is neither surfaced nor sent again, and only genuinely new
// evidence (a later epoch, a higher count, a new unclean boot) re-raises it.
import test from "node:test";
import assert from "node:assert/strict";
import { Quattro, repoFile, same, fixture } from "./load.mjs";

const QML = repoFile("memory-monitor/MemoryMonitor.qml");
const PANEL = repoFile("memory-monitor/QuattroDash.qml");

// ---------------------------------------------------------------------------
// Module shape: the once-per-occurrence decisions are quattro.js's
// ---------------------------------------------------------------------------

test("quattro.js declares the once-per-occurrence decisions", () => {
  const source = repoFile("memory-monitor/quattro.js");
  for (const fn of [
    "codeOccurrenceOf", "seenSuppressed", "seenFilter", "seenMerge",
    "seenMergeMap", "normalizeSeenCodes", "codeAckToast",
  ]) {
    assert.match(source, new RegExp(`\\bfunction\\s+${fn}\\s*\\(`), `quattro.js must declare ${fn}`);
  }
});

// ---------------------------------------------------------------------------
// The C2192 repro: the bar-restart code must be clearable and its identity
// must be the restart event, never the age the row prints
// ---------------------------------------------------------------------------

// The captain's own numbers: one restart event, probed 34 s apart.
const barEntry = (ageSec, uptimeSec) => Quattro.barSysCode(
  Quattro.parseBarProbe(String(uptimeSec) + "\n" + String(ageSec)), 0);

test("the C2192 repro: right-click clear works on the bar-restart code", () => {
  const first = barEntry(144, 196167);
  assert.notEqual(first, null, "a young restarted bar lights the code");
  assert.match(first.issue, /Bar shell restarted 2 minutes ago\./);
  // This is the exact assertion that failed before round 13: the live round-9
  // codes were exempt from the dismiss path, so the right-click returned
  // silently and the code came back on the next poll.
  assert.equal(Quattro.codeAckable(first), true, "every fault code is acknowledgeable, C2192 included");
});

test("the bar code's identity is the restart event, not the age text", () => {
  const first = barEntry(144, 196167);
  const later = barEntry(178, 196202);
  assert.notEqual(first.issue, later.issue, "the human text changes every minute");
  const seen = Quattro.codeOccurrenceOf(first);
  assert.notEqual(seen, null);
  assert.equal(seen.key, Quattro.SYS_SUBJECTS.bar);
  assert.equal(Quattro.seenSuppressed(Quattro.codeOccurrenceOf(later), seen), true,
    "the same restart event probed 34 s later is the same occurrence");
  const jitter = Quattro.codeOccurrenceOf(barEntry(146, 196169));
  assert.equal(Quattro.seenSuppressed(jitter, seen), true,
    "a couple of seconds of probe jitter never mints a new occurrence");

  const fresh = Quattro.codeOccurrenceOf(barEntry(30, 400000));
  assert.equal(Quattro.seenSuppressed(fresh, seen), false,
    "a genuinely new restart is new evidence and re-raises the code");
});

test("the bar code's states are not occurrences: dead and unknown rows stay unclearable", () => {
  const dead = Quattro.barSysCode(Quattro.parseBarProbe("5000.9\n"), 1);
  assert.match(dead.issue, /not running/);
  assert.equal(Quattro.codeOccurrenceOf(dead), null, "a dead shell is a live state, not an event to dismiss");
  const unknown = Quattro.barSysCode(Quattro.parseBarProbe(""), 0);
  assert.equal(Quattro.codeOccurrenceOf(unknown), null, "an unreadable probe is not an occurrence either");
});

// ---------------------------------------------------------------------------
// The crash family: the seen ledger survives the restart that re-latches
// ---------------------------------------------------------------------------

// A fresh session's once-per-session scans over the rig's own boot -1 lines:
// this is exactly what runs after every bar restart, and what re-raised the
// captain's already-seen codes before round 13.
const prevRelatch = (latched) => Quattro.crashSysUpdate(
  { text: fixture("crash-journal-prev.txt"), exit: 0, done: true },
  { text: fixture("crash-last-unclean.txt"), exit: 0, done: true },
  { text: "-- No entries --", exit: 1 },
  null, latched === undefined ? {} : latched,
);

test("the same crash codes latched N times surface and send exactly once", () => {
  let seen = {};
  let notes = 0;
  let surfaced = 0;
  for (let cycle = 0; cycle < 5; cycle += 1) {
    const relatch = prevRelatch();
    const filter = Quattro.seenFilter(relatch.entries, seen);
    for (const entry of filter.kept) {
      const occ = Quattro.codeOccurrenceOf(entry);
      if (occ === null) continue;
      // The click: one note per occurrence, the guard the captain asked for.
      if (!Quattro.seenSuppressed(occ, seen[occ.key])) {
        notes += 1;
        seen = Quattro.seenMerge(seen, occ);
      }
    }
    surfaced += filter.kept.filter(e => Quattro.crashSigOf(e) !== null).length;
  }
  assert.equal(notes, 4, "one note per distinct code: lockup, rcu, oom, power");
  assert.equal(surfaced, 4, "the first cycle surfaces them, no later cycle re-surfaces any");
});

test("the seen ledger survives a simulated bar restart through the state file", () => {
  const first = prevRelatch();
  let seen = {};
  for (const entry of first.entries) {
    const occ = Quattro.codeOccurrenceOf(entry);
    if (occ !== null) seen = Quattro.seenMerge(seen, occ);
  }
  // The crash-codes.json round trip, seen map included.
  const file = JSON.parse(JSON.stringify({ codes: first.latched, seen: seen }));
  const reloaded = Quattro.normalizeSeenCodes(file.seen);
  const restart = prevRelatch();
  const filter = Quattro.seenFilter(restart.entries, reloaded);
  assert.equal(filter.kept.filter(e => Quattro.crashSigOf(e) !== null).length, 0,
    "the boot -1 codes the captain already saw do not come back after the restart");
  same(filter.suppressed.map(e => Quattro.crashSigOf(e)).sort(), ["lockup", "oom", "power", "rcu"],
    "every one of them is held back by name, so the suppression is visible");
});

test("genuinely new evidence re-raises a seen code", () => {
  const base = prevRelatch();
  let seen = {};
  for (const entry of base.entries) {
    const occ = Quattro.codeOccurrenceOf(entry);
    if (occ !== null) seen = Quattro.seenMerge(seen, occ);
  }
  // One more lockup line lands past the cursor: a higher count after the clear.
  const withNew = Quattro.crashSysUpdate(
    { text: "", exit: 1, done: true },
    { text: "", exit: 0, done: true },
    { text: "1795300000.0 rig kernel: watchdog: BUG: soft lockup - CPU#3 stuck for 29s! [rcu_preempt:11]", exit: 0 },
    base.cursor, base.latched,
  );
  const filter = Quattro.seenFilter(withNew.entries, seen);
  same(filter.kept.map(e => Quattro.crashSigOf(e)), ["lockup"],
    "only the signature with new evidence re-raises, the rest stay cleared");

  // A second unclean boot is a new boundary: the power code re-raises.
  const secondBoundary = [
    "reboot   system boot 6.11.5 2026-11-23T10:00:00-05:00   still running",
    "reboot   system boot 6.11.5 2026-11-22T09:00:00-05:00   - 09:00:00 (1+00:00)",
  ].join("\n");
  const again = Quattro.crashSysUpdate(
    { text: "", exit: 1, done: true },
    { text: secondBoundary, exit: 0, done: true },
    { text: "-- No entries --", exit: 1 },
    withNew.cursor, withNew.latched,
  );
  const filter2 = Quattro.seenFilter(again.entries, seen);
  assert.equal(filter2.kept.map(e => Quattro.crashSigOf(e)).includes("power"), true,
    "a new unclean boot is a new occurrence of the power code");
});

// ---------------------------------------------------------------------------
// The live families: each one's own stable marker is its identity
// ---------------------------------------------------------------------------

test("the layer code's identity is systemd's own restart counter", () => {
  const layerAt = (restarts) => Quattro.sysCode("layer", Quattro.layerSubject("owed.service"), 1,
    "i", "s", "f", { unit: "owed.service", restarts: restarts, climbedBy: 2 });
  const seen = Quattro.seenMerge({}, Quattro.codeOccurrenceOf(layerAt(5)));
  const record = seen["sys|layer:owed.service"];
  assert.equal(Quattro.seenSuppressed(Quattro.codeOccurrenceOf(layerAt(5)), record), true,
    "the same counter reading is the same occurrence");
  assert.equal(Quattro.seenSuppressed(Quattro.codeOccurrenceOf(layerAt(7)), record), false,
    "a higher count after the clear is new evidence");
  assert.equal(Quattro.seenSuppressed(Quattro.codeOccurrenceOf(layerAt(1)), record), false,
    "a counter that reset and is climbing again is new evidence, not the seen occurrence");
});

test("the kernel and gpu codes carry their batch's newest epoch as identity", () => {
  const kernel = Quattro.kernelSysCode(
    Quattro.parseJournalLines("1795300100.0 rig kernel: igc 0000:05:00.0 enp5s0: link down"),
    true, 1795300000);
  assert.equal(kernel.entry.alert.detail.untilEpoch, 1795300100, "the kernel detail carries the batch epoch");
  const later = Quattro.kernelSysCode(
    Quattro.parseJournalLines("1795300500.0 rig kernel: igc 0000:05:00.0 enp5s0: link down"),
    true, 1795300100);
  const seen = Quattro.seenMerge({}, Quattro.codeOccurrenceOf(kernel.entry));
  assert.equal(Quattro.seenSuppressed(Quattro.codeOccurrenceOf(later.entry), seen[Quattro.SYS_SUBJECTS.kernel]), false,
    "a later fault epoch is new evidence");

  const gpu = Quattro.gpuSysCode("1795280500.0 rig kernel: NVRM: GspRmAlloc failed on GPU0", 0);
  assert.notEqual(gpu, null);
  assert.equal(gpu.alert.detail.untilEpoch, 1795280500, "the gpu detail carries the newest wedge epoch");
  const seenGpu = Quattro.seenMerge({}, Quattro.codeOccurrenceOf(gpu));
  const rederived = Quattro.gpuSysCode("1795280500.0 rig kernel: NVRM: GspRmAlloc failed on GPU0", 0);
  assert.equal(Quattro.seenSuppressed(Quattro.codeOccurrenceOf(rederived), seenGpu[Quattro.SYS_SUBJECTS.gpu]), true,
    "a restart's re-derivation of the same wedge lines is the same occurrence");
});

test("the sustained families key on the condition's own start, not on now", () => {
  const ramAt = (aboveSinceMs) => Quattro.sysCode("ram", Quattro.SYS_SUBJECTS.ram, 2,
    "i", "s", "f", { psiSomeAvg10: 30, aboveSinceMs: aboveSinceMs, atMs: aboveSinceMs + 180000 });
  const seen = Quattro.seenMerge({}, Quattro.codeOccurrenceOf(ramAt(1000000)));
  const record = seen[Quattro.SYS_SUBJECTS.ram];
  assert.equal(Quattro.seenSuppressed(Quattro.codeOccurrenceOf(ramAt(1002000)), record), true,
    "window-start jitter of seconds is the same occurrence");
  assert.equal(Quattro.seenSuppressed(Quattro.codeOccurrenceOf(ramAt(1300000)), record), false,
    "pressure that released and re-crossed is a new occurrence");

  const disk = Quattro.diskSysCode({ readable: true, someAvg60: 30 }, true, { amberRuns: 0 }, 5000);
  assert.notEqual(disk.entry, null);
  assert.equal(disk.entry.alert.detail.runStartMs, 5000, "the disk detail carries the run's start");
  const sameRun = Quattro.diskSysCode({ readable: true, someAvg60: 31 }, true, disk.next, 7000);
  assert.equal(sameRun.entry.alert.detail.runStartMs, 5000, "the run start holds while the stall holds");
  const seenDisk = Quattro.seenMerge({}, Quattro.codeOccurrenceOf(sameRun.entry));
  assert.equal(Quattro.seenSuppressed(Quattro.codeOccurrenceOf(sameRun.entry), seenDisk[Quattro.SYS_SUBJECTS.disk]), true,
    "the same sustained run is the same occurrence");
  const calm = Quattro.diskSysCode({ readable: true, someAvg60: 0.1 }, true, sameRun.next, 9000);
  assert.equal(calm.entry, null, "calm releases the code");
  // A re-sustained run inside the tolerance is the same avg60 window - the
  // same stall. A genuinely later one is a new occurrence.
  const soon = Quattro.diskSysCode({ readable: true, someAvg60: 30 }, true, calm.next, 30000);
  assert.equal(Quattro.seenSuppressed(Quattro.codeOccurrenceOf(soon.entry), seenDisk[Quattro.SYS_SUBJECTS.disk]), true,
    "a run re-sustaining inside the 60 s window is the same stall");
  const resustainedCalm = Quattro.diskSysCode({ readable: true, someAvg60: 0.1 }, true, soon.next, 40000);
  const resustained = Quattro.diskSysCode({ readable: true, someAvg60: 30 }, true, resustainedCalm.next, 70000);
  assert.equal(resustained.entry.alert.detail.runStartMs, 70000, "a new run starts a new occurrence");
  assert.equal(Quattro.seenSuppressed(Quattro.codeOccurrenceOf(resustained.entry), seenDisk[Quattro.SYS_SUBJECTS.disk]), false,
    "and it re-raises after the captain cleared the first");
});

test("drive codes, junk and null carry no occurrence and never suppress", () => {
  assert.equal(Quattro.codeOccurrenceOf({ alert: { type: "hd", key: "partuuid:aabb" } }), null);
  assert.equal(Quattro.codeOccurrenceOf(null), null);
  assert.equal(Quattro.codeOccurrenceOf({ alert: { type: "sys", sys: "kernel", key: Quattro.SYS_SUBJECTS.kernel } }), null,
    "an entry with no detail mints nothing, it just never suppresses");
  const kept = Quattro.seenFilter([{ code: "C1234", alert: { type: "hd", key: "x" } }, null], { "sys|bar": { key: "sys|bar", epoch: 1 } });
  same(kept.kept.map(e => e && e.code), ["C1234", null], "unidentified entries always ride through");
  same(kept.suppressed, []);
});

// ---------------------------------------------------------------------------
// The ledger's own shape: sanitize, merge, round trip
// ---------------------------------------------------------------------------

test("normalizeSeenCodes sanitizes hostile state and treats an old file as empty", () => {
  const norm = Quattro.normalizeSeenCodes({
    "sys|bar": { key: "sys|bar", epoch: 196023, count: "many", lastEpoch: null, bootIso: "<evil>" },
    "sys|crash:lockup": { key: "sys|crash:lockup", epoch: 1, lastEpoch: 2, count: 3 },
    junk: 7,
    "not-an-object": "x",
  });
  same(Object.keys(norm).sort(), ["sys|bar", "sys|crash:lockup"]);
  assert.equal(norm["sys|bar"].count, null, "a junk count reads as none");
  assert.equal(norm["sys|bar"].bootIso, "evil", "an iso is sanitized like every visible word");
  assert.equal(norm["sys|crash:lockup"].count, 3);
  same(Quattro.normalizeSeenCodes(undefined), {}, "an old crash-codes.json with no seen map reads as empty");
  same(Quattro.normalizeSeenCodes("garbage"), {});
  same(Quattro.normalizeSeenCodes(null), {});
});

test("seenMerge replaces per key and seenMergeMap overlays a whole map", () => {
  const bar = Quattro.codeOccurrenceOf(barEntry(144, 196167));
  const next = Quattro.codeOccurrenceOf(barEntry(30, 400000));
  let seen = Quattro.seenMerge({}, bar);
  seen = Quattro.seenMerge(seen, next);
  assert.equal(seen[Quattro.SYS_SUBJECTS.bar].epoch, next.epoch,
    "recording a newer occurrence replaces the older one, so the ledger names what was last seen");
  const file = Quattro.normalizeSeenCodes({ "sys|bar": { key: "sys|bar", epoch: 1 } });
  const merged = Quattro.seenMergeMap(file, seen);
  assert.equal(merged[Quattro.SYS_SUBJECTS.bar].epoch, next.epoch, "the session's fresher record wins over the file");
  assert.equal(Object.keys(merged).length, 1);
});

// ---------------------------------------------------------------------------
// Copy: the acknowledge promise and the already-sent refusal, in plain words
// ---------------------------------------------------------------------------

test("the acknowledge and refusal copy says the durable rule", () => {
  assert.match(Quattro.codeAckToast({ code: "C2192" }), /^cleared C2192\. it stays cleared until new evidence arrives\.$/);
  assert.match(Quattro.dispatchRefused("C2192", "already-seen").text, /already sent/,
    "a second click on a sent code refuses in words");
  for (const entry of prevRelatch().entries) {
    assert.match(entry.fix, /until new evidence arrives/, "no code promises a this-boot clear anymore");
  }
  const bar = barEntry(144, 196167);
  assert.match(bar.fix, /right-click/, "the bar code's own fix line names the clear");
});

// ---------------------------------------------------------------------------
// Wiring pins: the guard runs in the widget, the dash asks before it sends
// ---------------------------------------------------------------------------

test("MemoryMonitor.qml runs the dedupe guard and logs what it suppresses", () => {
  assert.equal(QML.includes("Quattro.seenFilter("), true, "the decode filters through the ledger");
  assert.equal(QML.includes("Quattro.codeOccurrenceOf("), true, "the occurrence derivation is quattro's");
  assert.equal(QML.includes("Quattro.seenMerge("), true, "the ack and the send record through quattro's merge");
  assert.equal(QML.includes("Quattro.normalizeSeenCodes("), true, "the load recovers the ledger from the file");
  assert.match(QML, /console\.log\("memory-monitor: engine code/,
    "a suppressed duplicate leaves a log line, so a regression is visible");
  assert.equal(QML.includes("seen: root.codeSeen"), true, "the crash state file carries the ledger beside the latch");
});

test("QuattroDash.qml clears and sends through the monitor's once guard", () => {
  assert.equal(PANEL.includes('callMonitor("ackCode"'), true, "the right-click clear rides the monitor");
  assert.equal(PANEL.includes('callMonitor("codeSendOnce"'), true, "the note click asks the once guard first");
  assert.equal(PANEL.includes("Quattro.codeAckToast("), true);
  assert.equal(PANEL.includes("Quattro.crashAckToast("), false, "the crash-only toast name is gone");
  assert.equal(PANEL.includes("crashLatched"), false, "the dash never touches the latch map");
  assert.equal(PANEL.includes("codeSeen"), false, "nor the ledger: both are the monitor's");
});
