// Object-name resolution guard. Every Timer, Process, FileView and visual child
// the widget *talks to* has to be declared in the same file: QML resolves a bare
// `id` at runtime, so a reference to a timer that was renamed or never declared
// is not a lint problem and not a crash at startup — it is a ReferenceError
// printed once per poll while the loop it names silently stops sampling. That is
// how the VRAM and drive poll timers died on the rig while the bar still drew.
//
// The guard is deliberately narrow: it only checks names used as the receiver of
// a member that only a declared QML object in this file can carry (timer and
// process control, FileView IO, item lifecycle). A typo in a plain data property
// is a different bug and shows up in the memory.js suite instead.
import test from "node:test";
import assert from "node:assert/strict";
import { Memory, repoFile } from "./load.mjs";

const FILES = [
  "memory-monitor/MemoryMonitor.qml",
  "memory-monitor/MemoryPanel.qml",
  "memory-monitor/QuattroDash.qml",
];

// Members that only a QML object declared in this file owns. A JavaScript value
// in this codebase never has any of them.
const OBJECT_MEMBERS = [
  "interval", "running", "restart", "start", "stop", "triggeredOnStart", "repeat",
  "command", "output", "input", "procId", "terminated", "expired", "exited",
  "read", "append", "commit", "source", "mode", "position",
  "visible", "active", "enabled", "model", "delegate", "sourceComponent",
  "activeFocus", "hoverEnabled", "pressed", "containsMouse", "text", "placeholderText",
  "onTriggered", "onOutputChanged", "onExited", "onCompleted", "onCommitChanged",
];

function declaredIds(source) {
  const ids = new Set();
  for (const m of source.matchAll(/\bid:\s*([A-Za-z_][A-Za-z0-9_]*)/g)) ids.add(m[1]);
  for (const m of source.matchAll(/\bproperty\s+(?:readonly\s+)?[A-Za-z<>*\[\]]+\s+([A-Za-z_][A-Za-z0-9_]*)/g)) ids.add(m[1]);
  for (const m of source.matchAll(/\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) ids.add(m[1]);
  for (const m of source.matchAll(/\bvar\s+([A-Za-z_][A-Za-z0-9_]*)\s*=/g)) ids.add(m[1]);
  for (const m of source.matchAll(/import\s+"[^"]+"\s+as\s+([A-Za-z_][A-Za-z0-9_]*)/g)) ids.add(m[1]);
  for (const m of source.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*),?\s*$/gm)) { /* component property lists */ }
  return ids;
}

// Names that QML itself resolves: the root object of a type block, singletons,
// and the members of an inline component's own scope.
const QML_BUILTINS = new Set([
  "Qt", "console", "root", "parent", "index", "model", "delegate", "component", "this",
  "Math", "JSON", "String", "Number", "Array", "Object", "Date", "RegExp", "Boolean",
]);

function receivers(source) {
  const member = OBJECT_MEMBERS.join("|");
  const re = new RegExp(`(^|[^A-Za-z0-9_.])\\b([a-z][A-Za-z0-9_]*)\\.(${member})\\b`, "g");
  const found = new Map();
  for (const m of source.matchAll(re)) {
    const name = m[2];
    if (!found.has(name)) found.set(name, m[3]);
  }
  return found;
}

for (const file of FILES) {
  const source = repoFile(file);
  const declared = declaredIds(source);

  test(`${file}: every timer, process and FileView the widget names is declared in it`, () => {
    const unresolved = [];
    for (const [name, member] of receivers(source)) {
      if (declared.has(name) || QML_BUILTINS.has(name)) continue;
      unresolved.push(`${name}.${member}`);
    }
    assert.deepEqual(unresolved, [], `${file} references QML objects that are never declared: ${unresolved.join(", ")}`);
  });

  test(`${file}: every declared Timer and Process is either triggered or self-driving`, () => {
    // A declared-but-never-run timer is the same defect seen from the other side:
    // the loop exists on paper and never samples. A timer that arms itself
    // (`running: true` in its own block) is fine; one that nothing starts and
    // nothing arms is not.
    const lines = source.split("\n");
    const unused = [];
    for (const m of source.matchAll(/\bid:\s*([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
      const name = m[1];
      if (!/Timer$|Proc$|Watchdog$|File$|Loader$|Component$/.test(name)) continue;
      const declaredAt = source.slice(0, m.index).split("\n").length - 1;
      const external = (source.match(new RegExp(`\\b${name}\\b`, "g")) || []).length - 1;
      if (external > 0) continue;
      const block = lines.slice(declaredAt, declaredAt + 10).join("\n");
      if (/running:\s*true/.test(block)) continue;
      unused.push(name);
    }
    assert.deepEqual(unused, [], `${file} declares objects nothing ever starts or triggers: ${unused.join(", ")}`);
  });
}

// The adaptive-poll design is one timer per resource, each rescheduled from what
// that resource was last seen doing. A missing one is not a cosmetic gap: the
// resource it names stops being sampled, and its ring renders a stale number.
test("the bar widget declares one poll timer per monitored resource, and each triggers a sample", () => {
  const qml = repoFile("memory-monitor/MemoryMonitor.qml");
  const timers = new Map();
  for (const m of qml.matchAll(/Timer\s*\{([^]*?)\n  \}/g)) {
    const id = (m[1].match(/\bid:\s*([A-Za-z_][A-Za-z0-9_]*)/) || [])[1];
    if (id) timers.set(id, m[1]);
  }
  for (const id of ["ramTimer", "vramTimer", "hdTimer"]) {
    assert.equal(timers.has(id), true, `${id} must exist: the poll loop that names it would otherwise throw every cycle`);
    const body = timers.get(id);
    assert.equal(/startSample\(\)/.test(body), true, `${id} must start a sample`);
    assert.equal(/repeat:\s*true/.test(body), true, `${id} must repeat`);
    assert.equal(/running:\s*true/.test(body), true, `${id} must be running`);
  }
  // schedulePolls sets an interval on each of them, through Memory.pollIntervalMs.
  const schedule = (qml.match(/function schedulePolls\(\)[^{]*\{([^]*?)\n  \}/) || [])[1] || "";
  for (const id of ["ramTimer", "vramTimer", "hdTimer"]) {
    assert.equal(new RegExp(`${id}\\.interval\\s*=`).test(schedule), true, `schedulePolls must reschedule ${id}`);
  }
  assert.equal(/pollMs\(/.test(schedule), true, "the intervals come from the poll escalator, not timer folklore");
  // The starting interval is the escalator's nominal for that resource, so a
  // resource never polls faster or slower than memory.js says before the first
  // sample has been seen.
  const typeOf = { ramTimer: "ram", vramTimer: "vram", hdTimer: "hd" };
  for (const id of ["ramTimer", "vramTimer", "hdTimer"]) {
    const initial = Number((timers.get(id).match(/interval:\s*(\d+)/) || [])[1]);
    assert.equal(initial, Memory.POLL_NOMINAL_MS[typeOf[id]], `${id} starts at memory.js's nominal for ${typeOf[id]}`);
  }
});

// Offscreen proof that the poll loop actually runs. QML's Timer cannot be
// instantiated in a node test, so the declared timer blocks are read out of the
// widget and driven by a virtual clock: every running timer fires on its
// interval, the sample it starts re-arms all three through the same escalator the
// widget calls, and the fire counts are checked against what the plan says the
// loop must do. A timer the widget never declared never fires here either, which
// is exactly the rig failure this test was written after.
function readTimerBlocks(source) {
  const out = [];
  for (const m of source.matchAll(/\bTimer\s*\{/g)) {
    let depth = 0;
    const start = m.index + m[0].length - 1;
    let end = -1;
    for (let p = start; p < source.length; p++) {
      if (source[p] === "{") depth++;
      else if (source[p] === "}") { depth--; if (depth === 0) { end = p; break; } }
    }
    if (end < 0) continue;
    const body = source.slice(start + 1, end);
    const id = (body.match(/\bid:\s*([A-Za-z_][A-Za-z0-9_]*)/) || [])[1];
    if (!id) continue;
    out.push({
      id,
      interval: Number((body.match(/interval:\s*(\d+)/) || [])[1]),
      repeat: /repeat:\s*true/.test(body),
      running: /running:\s*true/.test(body),
      triggeredOnStart: /triggeredOnStart:\s*true/.test(body),
      startsSample: /startSample\(\)/.test(body),
    });
  }
  return out;
}

const TYPE_OF_TIMER = { ramTimer: "ram", vramTimer: "vram", hdTimer: "hd" };

function runPollLoop(bands, horizonMs) {
  const qml = repoFile("memory-monitor/MemoryMonitor.qml");
  const live = readTimerBlocks(qml)
    .filter(t => TYPE_OF_TIMER[t.id] && t.startsSample && t.running && t.repeat && t.interval > 0);
  assert.equal(live.length, 3, "the widget must declare a running, repeating, sampling timer for each resource");

  const fires = {};
  const next = {};
  for (const t of live) {
    fires[t.id] = 0;
    next[t.id] = t.triggeredOnStart ? 0 : t.interval;
  }

  let samples = 0;
  while (true) {
    let soonest = null;
    for (const t of live) if (soonest === null || next[t.id] < next[soonest.id]) soonest = t;
    if (soonest === null || next[soonest.id] >= horizonMs) break;
    const clock = next[soonest.id];
    fires[soonest.id]++;
    samples++;
    // The sample re-arms every resource from what that resource was last seen
    // doing: the widget's schedulePolls, call for call. Setting a running QML
    // Timer's interval restarts its countdown, so after every sample all three
    // deadlines restart together and the shortest one drives the next sample.
    // That is the plan's rule read the other way round: the resource that earned
    // the short interval sets the period, and every sample reads every resource
    // (startSample starts all six readers), so a resource whose timer is not the
    // fastest is still sampled on every cycle.
    for (const t of live) {
      const type = TYPE_OF_TIMER[t.id];
      const band = bands[type] === undefined ? 0 : bands[type];
      t.interval = Memory.pollIntervalMs(type, band, {
        absent: band === null,
        psi: bands.psi === undefined ? {} : { some_avg10: bands.psi },
        psiFloor: Memory.PSI_STALL_FLOOR,
      });
      next[t.id] = clock + t.interval;
    }
  }
  return fires;
}

function samplePeriod(bands) {
  const fires = runPollLoop(bands, 180000);
  const total = Object.values(fires).reduce((a, b) => a + b, 0);
  return 180000 / total;
}

test("offscreen: the poll loop runs, every resource's timer can drive it, and a red resource shortens the period", () => {
  const healthy = runPollLoop({ ram: 0, vram: 0, hd: 0 }, 180000);
  const healthyTotal = Object.values(healthy).reduce((a, b) => a + b, 0);
  assert.equal(healthyTotal >= 4, true, `the loop ran ${healthyTotal} times in 3 minutes of virtual clock; the poll is dead`);
  assert.equal(healthy.ramTimer >= 1, true, "a healthy machine polls on RAM's nominal interval");
  assert.equal(samplePeriod({ ram: 0, vram: 0, hd: 0 }), Memory.POLL_NOMINAL_MS.ram, "the healthy period is the shortest nominal");

  // Each resource's own timer has to be able to drive the loop when that resource
  // is the one that earned the escalation, or the plan's "more often on the
  // resource that triggers a red alert" would be unreachable for VRAM and drives.
  for (const [id, type] of Object.entries(TYPE_OF_TIMER)) {
    const bands = { ram: 0, vram: 0, hd: 0 };
    bands[type] = 2;
    const red = runPollLoop(bands, 180000);
    assert.equal(red[id] >= 2, true, `${id} must fire when ${type} is at red, not just exist`);
    assert.equal(samplePeriod(bands), Memory.POLL_ESCALATED_MS[type], `a red ${type} shortens the period to its escalated interval`);
  }

  const stallBands = { ram: 2, vram: 0, hd: 0, psi: Memory.PSI_STALL_FLOOR + 5 };
  const stalling = runPollLoop(stallBands, 180000);
  assert.equal(stalling.ramTimer >= 2, true, "a stalling machine keeps its RAM loop alive");
  assert.equal(samplePeriod(stallBands), Memory.POLL_PSI_MS, "PSI above the stall floor escalates RAM past its red interval");
  assert.equal(samplePeriod(stallBands) < samplePeriod({ ram: 0, vram: 0, hd: 0 }), true, "a stalling machine polls more often than a healthy one");
});


