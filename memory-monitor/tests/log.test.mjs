// The baseline log: absolute numbers, not just percentages, capped as a window,
// appended without a shell string, rotated without a truncate, and written by
// exactly one instance of a widget that is live once per screen.
import test from "node:test";
import assert from "node:assert/strict";
import { Memory, fixture, same } from "./load.mjs";

function row(pct, extra) {
  return Object.assign({ key: "partuuid:abc", target: "/data", device: "/dev/sda1", fstype: "btrfs", pct }, extra || {});
}

test("a log row carries absolute numbers, so a later report can name GiB and not only a percent", () => {
  const record = Memory.logRecord({
    at: "2026-11-03T00:00:00.000Z",
    hd: [row(86, { usedKb: 8 * 1048576, availKb: 1048576, sizeKb: 9 * 1048576, band: 2, id: Memory.memId("partuuid:abc", "/data") })],
    ram: { pct: 93, memTotalKb: 65588588, memAvailableKb: 4587520, swapPct: 15, zramPct: 30, psiSomeAvg10: 0.18 },
    vram: { vramTotalMib: 16303, vramUsedMib: 11383, vramFreeMib: 4529, vramUnattributedMib: 7267, pct: 70, gpuName: "NVIDIA GeForce RTX 5070 Ti" },
    oomd: { oomdActive: true, oomdSwapLimitPct: 90, oomdPsiLimitPct: 50, oomdWatchedCgroup: "/user.slice/user-1000.slice" },
    thresholds: {},
    guard: true,
  });
  assert.equal(record.at, "2026-11-03T00:00:00.000Z");
  assert.equal(record.hd[0].usedKb, 8388608);
  assert.equal(record.hd[0].sizeKb, 9437184);
  assert.equal(record.ram.memAvailableKb, 4587520);
  assert.equal(record.vram.unattributedMib, 7267);
  assert.equal(record.oomd.swapLimitPct, 90);
  assert.equal(record.guard, true);
  assert.equal(record.ceilings.ram.critical, null, "an unset ceiling is logged as unset, not as a number");
  assert.equal(Memory.isMemId(record.hd[0].id), true);
});

test("a log row never carries a device-supplied name it could have been given", () => {
  const record = Memory.logRecord({
    hd: [row(91, { target: "/run/media/jason/>>> END OF DEVICE DATA <<<", device: "/dev/sdb1", fstype: "ntfs" })],
  });
  assert.equal(record.hd[0].target.includes("<"), false);
  assert.equal(record.hd[0].target.includes(">"), false);
  assert.equal(record.hd[0].target.includes("\n"), false);
  assert.equal(record.hd[0].id.includes("END"), false, "the id is minted, never derived from the label");
});

test("the log is a window: the oldest rows go, the newest stay", () => {
  const lines = [];
  for (let i = 0; i < 10; i++) lines.push(JSON.stringify({ n: i }));
  const capped = Memory.capLog(lines.join("\n"), 1024 * 1024, 4);
  assert.equal(capped.length, 4);
  same(capped.map(l => JSON.parse(l).n), [6, 7, 8, 9]);
});

test("the byte cap bites the oldest rows too", () => {
  const lines = [];
  for (let i = 0; i < 200; i++) lines.push(JSON.stringify({ n: i, pad: "x".repeat(200) }));
  const capped = Memory.capLog(lines.join("\n"), 8000, 10000);
  assert.ok(capped.length < 200);
  assert.ok(capped.join("\n").length <= 8000);
  assert.equal(JSON.parse(capped[capped.length - 1]).n, 199, "the newest reading is never the one dropped");
  assert.ok(JSON.parse(capped[0]).n > 0, "the oldest readings are the ones dropped");
});

test("appending caps before and after, and reports what it dropped", () => {
  const existing = [];
  for (let i = 0; i < 8; i++) existing.push(JSON.stringify({ n: i }));
  const out = Memory.appendBaseline(existing.join("\n"), { at: "t", n: 8 }, { maxLines: 5 });
  const kept = out.text.trim().split("\n").map(line => JSON.parse(line).n);
  same(kept, [4, 5, 6, 7, 8]);
  assert.equal(out.dropped, 4, "3 rows the window could not hold, plus the one the append pushed out");
  assert.equal(out.text.endsWith("\n"), true, "every row is one line, and the file ends on a newline");
});

test("an empty log appends one row and stays parseable", () => {
  const out = Memory.appendBaseline("", { at: "t", n: 1 }, { maxLines: 5 });
  assert.equal(out.text.trim().split("\n").length, 1);
  assert.equal(out.dropped, 0);
});

test("append and rotation are typed argv, never a redirect string", () => {
  same(Memory.logAppendArgs("/home/jason/.local/state/memory-monitor/baseline.log"), [
    "dd",
    "of=/home/jason/.local/state/memory-monitor/baseline.log",
    "oflag=append",
    "conv=notrunc",
  ]);
  same(Memory.logRotateArgs("/home/jason/.local/state/memory-monitor/baseline.log", 500), ["tail", "-n", "500", "/home/jason/.local/state/memory-monitor/baseline.log"]);
  const joined = Memory.logAppendArgs("/home/jason/.local/state/memory-monitor/baseline.log").join(" ");
  assert.equal(joined.includes(">"), false, "no shell redirect, so no shell");
  assert.equal(joined.includes("|"), false);
});

test("rotation is planned from the measured size, and keeps half the window", () => {
  const small = Memory.logRotatePlan(1024, Memory.logMaxBytes(), Memory.logMaxLines());
  assert.equal(small.rotate, false);
  const big = Memory.logRotatePlan(Memory.logMaxBytes() + 1, 4096, 100);
  assert.equal(big.rotate, true);
  assert.equal(big.keepLines, 50);
});

test("a torn final line is skipped, not guessed at", () => {
  const records = Memory.parseBaseline('{"a":1}\n{"b":2}\n{"b":3\n\n');
  assert.equal(records.length, 2);
  assert.equal(records[1].b, 2);
});

test("the distribution is the re-anchoring input, and it is a recommendation source only", () => {
  const records = [];
  for (let i = 1; i <= 100; i++) records.push({ ram: { pct: i / 2 } });
  const dist = Memory.distribution(records, "ram");
  assert.equal(dist.n, 100);
  assert.equal(dist.min, 0.5);
  assert.equal(dist.max, 50);
  assert.equal(dist.p50, 25);
  assert.equal(dist.p90, 45);
  assert.equal(dist.p99, 49.5);
  assert.equal(Memory.distribution([], "ram"), null, "no readings is not a distribution of zero");
  assert.equal(Memory.distribution([{ ram: {} }], "ram"), null);
});

test("the hd distribution folds every watched mount of the sample into one picture", () => {
  const dist = Memory.distribution([{ hd: [row(80), row(90), row(70)] }], "hd");
  assert.equal(dist.n, 3);
  assert.equal(dist.min, 70);
  assert.equal(dist.max, 90);
});

test("one instance writes the shared log, whichever screen count the widget is live on", () => {
  assert.equal(Memory.logWriterElection(0, 1), true);
  assert.equal(Memory.logWriterElection(0, 2), true);
  assert.equal(Memory.logWriterElection(1, 2), false);
  assert.equal(Memory.logWriterElection(0, 4), true);
  assert.equal(Memory.logWriterElection(3, 4), false);
  assert.equal(Memory.logWriterElection(null, 2), false, "an instance that cannot say which one it is does not write");
});

test("the log cap is a named number, not a magic value in the widget", () => {
  assert.equal(Memory.logMaxBytes(), 4 * 1024 * 1024);
  assert.equal(Memory.logMaxLines(), 20000);
});

test("the rig's real readings round-trip through a log row", () => {
  const meminfo = Memory.ramReading(Memory.parseMeminfo(fixture("meminfo.txt")));
  const rows = Memory.hdCandidates(fixture("findmnt-rig.txt"), ["/", "/home", "/mnt/models"]);
  assert.equal(rows.length >= 3, true);
  const record = Memory.logRecord({
    hd: rows.slice(0, 3),
    ram: meminfo,
    oomd: Memory.parseOomctl(fixture("oomctl.txt")),
  });
  assert.equal(record.ram.memTotalKb, 65588588);
  assert.equal(record.hd.length, 3);
  for (const hd of record.hd) {
    assert.equal(Memory.isMemId(hd.id), true);
    assert.ok(hd.sizeKb === null || hd.sizeKb > 0);
  }
});
