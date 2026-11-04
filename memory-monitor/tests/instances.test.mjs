// One bar widget is instantiated once per monitor.
//
// Run: bash memory-monitor/tests/run.sh   (or: node --test memory-monitor/tests/)
//
// Bar.qml instantiates a bar widget once per screen, so a widget that appears
// once in the layout is live N times on a multi-monitor bar. This rig has one
// monitor, which is exactly why the finding belongs in a test and not in a bug
// report: an alert queue, a notice lane, a baseline log append and an agent arm
// that each instance runs for itself produces N toasts for one crossing, N log
// rows for one sample, and N agents for one emergency.
//
// The rule: the instance whose election key is lowest owns the shared side
// effects for a sample, and every instance reads the same state file. This file
// runs the whole scenario - a crossing, a sample, a critical - against one, two
// and four live instances and counts what the machine actually gets.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Memory } from "./load.mjs";

const QML = readFileSync(path.join(import.meta.dirname, "..", "MemoryMonitor.qml"), "utf8");

const SAMPLE = {
  at: "2026-11-03T12:00:00.000Z",
  hd: [{ key: "partuuid:1", target: "/data", device: "/dev/sda1", fstype: "btrfs", usedKb: 900000, availKb: 100000, sizeKb: 1000000, pct: 90, band: 2 }],
  ram: { memTotalKb: 1000000, memAvailableKb: 90000, pct: 91, band: 2, psiSomeAvg10: 0.4, swapPct: 20 },
  vram: { vramTotalMib: 8192, vramUsedMib: 4096, vramFreeMib: 4096, pct: 50, band: 0 },
};

function instances(count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({ index: i, writer: Memory.logWriterElection(i, count) });
  }
  return out;
}

test("exactly one instance owns the shared side effects for a sample, whatever the screen count", () => {
  for (const count of [1, 2, 4]) {
    const live = instances(count);
    assert.equal(live.filter(i => i.writer).length, 1, `${count} instance(s): exactly one writer`);
    assert.equal(live[0].writer, true, "the election is deterministic: the lowest index wins, so a redraw cannot move the owner");
  }
  // An instance that cannot say which one it is does not write: a widget that
  // guesses would be a second writer, and two writers is two copies of one row.
  assert.equal(Memory.logWriterElection(null, 2), false);
  assert.equal(Memory.logWriterElection(-1, 2), false);
});

test("two live instances produce one alert event for one crossing", () => {
  const fired = instances(2).filter(entry =>
    entry.writer && Memory.shouldFireAlert({ band: 2, previousBand: 1, psiCrossing: false, swapCrossing: false }));
  assert.equal(fired.length, 1, "one crossing is one alert event, not one per monitor");
  assert.equal(fired[0].index, 0);

  // The same crossing seen by four instances is still one event.
  assert.equal(instances(4).filter(entry =>
    entry.writer && Memory.shouldFireAlert({ band: 3, previousBand: 2 })).length, 1);
});

test("two live instances produce one log row for one sample", () => {
  for (const count of [1, 2, 4]) {
    let log = "";
    for (const entry of instances(count)) {
      if (!entry.writer) continue;
      log = log + (log.length > 0 ? "\n" : "") + Memory.logLine(Memory.logRecord(SAMPLE));
    }
    const rows = Memory.parseBaseline(log);
    assert.equal(rows.length, 1, `${count} instance(s): one sample is one log row`);
    assert.equal(rows[0].ram.pct, 91, "and the row carries the reading, absolute numbers included");
    assert.equal(rows[0].hd[0].usedKb, 900000);
  }
});

test("two live instances produce one arm for one critical", () => {
  for (const count of [1, 2, 4]) {
    const started = instances(count).filter(entry =>
      Memory.shouldStartArm({ band: 3, guard: true, budgetOk: true, armLive: false, writer: entry.writer }).start);
    assert.equal(started.length, 1, `${count} instance(s): one emergency arms one agent`);
    assert.equal(started[0].index, 0);
  }

  // The reason a non-writer instance is refused names the rule, so the log says
  // why nothing was armed rather than saying nothing.
  const refused = Memory.shouldStartArm({ band: 3, guard: true, budgetOk: true, writer: false });
  assert.equal(refused.start, false);
  assert.match(refused.reason, /another instance owns the arm/);

  // Single-flight is per machine, not per instance: a second critical while an
  // arm is live does not start a second agent even for the owning instance.
  const second = Memory.shouldStartArm({ band: 3, guard: true, budgetOk: true, writer: true, armLive: true });
  assert.equal(second.start, false);
  assert.match(second.reason, /already live/);
});

test("the arm event identity is the event, so one crossing cannot arm twice", () => {
  const key = Memory.armEventKey({ type: "ram", band: 3, key: "ram", epoch: 7 });
  assert.equal(Memory.armEventKey({ type: "ram", band: 3, key: "ram", epoch: 7 }), key);
  assert.notEqual(Memory.armEventKey({ type: "ram", band: 3, key: "ram", epoch: 8 }), key,
    "a later sample is a different event, so a genuinely worse excursion can arm again");
  assert.notEqual(Memory.armEventKey({ type: "vram", band: 3, key: "ram", epoch: 7 }), key,
    "a different resource is a different event");
});

test("the widget gates every shared side effect on the election rather than on itself", () => {
  // The delegation half of the gate: the log append, the alert queue, the notice
  // lane, the onboarding asks, the delivery record and the arm all sit behind
  // `isWriter`, and `isWriter` comes from memory.js's election rather than from a
  // widget-local guess about which instance it is.
  assert.equal(QML.includes("Memory.logWriterElection(instanceIndex, instanceCount)"), true);
  assert.equal(QML.includes("if (isWriter) appendLog();"), true);
  assert.equal(QML.includes("writer: isWriter,"), true, "the arm is gated on the same election");
  assert.equal(QML.includes("siblingInstances"), true, "the widget counts its own instances instead of assuming one");
  for (const fn of ["queueAlert", "fireNextAlert", "fireNextNotice", "recordNoticeDelivered", "askCeilings", "askGuard", "startArm", "reconcilePersistedArms"]) {
    const body = (QML.match(new RegExp("function " + fn + "\\([^)]*\\)[^{]*\\{([^]*?)\\n  \\}")) || [])[1] || "";
    assert.match(body, /if \(!isWriter\) return;/, `${fn} runs on the writer instance only: one toast, one write, one arm`);
  }
});
