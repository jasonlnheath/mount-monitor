// Notification click tests.
//
// Run: bash tests/run.sh   (or: node --test tests/)
//
// The guard for the reported bug: a notice that stayed on screen was clicked and
// nothing happened. The plugin's only click route was the libnotify action
// (`-A default=…`), and Omarchy's notification service can invoke that action
// only while the sending notify-send process is still alive — see
// /usr/share/omarchy/shell/plugins/notifications/Service.qml invokePopupDefault,
// which prefers an exec argv vector, falls back to a live default action, and
// finds no live action at all in a row restored after a shell restart. So every
// outstanding notice became an unclickable row.
//
// The fix: every notification also carries the omarchy-native exec hint
// (`-h STRING:omarchy-exec-argv:<json argv>`), which the daemon runs itself with
// no shell interpretation and which the persisted history row keeps. These tests
// hold the argv the click must run, for every notification kind, and hold the
// notify-send arguments the queue and the persistence depend on.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);

// mounts.js is a Qt-importable JavaScript file (plain top-level functions), so
// it is loaded into a VM context instead of imported as an ES module.
function loadMounts() {
  const src = readFileSync(path.join(repo, "mounts.js"), "utf8");
  const ctx = { Math, Number, parseInt, isFinite, String, Array, RegExp, JSON, Object, console };
  vm.runInNewContext(src, ctx);
  return ctx;
}

const Mounts = loadMounts();

function fixture(name) {
  return readFileSync(path.join(here, "fixtures", name), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"))
    .join("\n");
}

const LSBLK = fixture("lsblk-rig.txt");
const FINDMNT = fixture("findmnt-rig.txt");

const MODELS = "/mnt/models";
const USB = "/run/media/jason/Backup Drive";
const USB_PART = "/run/media/jason/Archive";
const WANTED = ["/", MODELS];
// The captain's own agent override, as shell.json carries it.
const AGENT = ["/home/jason/Work/firstmate/bin/fm-inbox.sh", "note"];

const HINT_KEY = "omarchy-exec-argv";
const HINT_FORM = `STRING:${HINT_KEY}:`;

function strings(list) {
  // Array.from rather than list.map: the list is built inside mounts.js's VM
  // context, and a cross-realm array is not deep-equal to a local one.
  return Array.from(list, (s) => s);
}

function find(list, target) {
  return Array.from(list).find((c) => c.target === target);
}

function rings(wanted) {
  return Array.from(Mounts.selectMounts(FINDMNT, wanted, -1));
}

// The daemon's own validator, copied from NotificationLogic.js parseExecArgv:
// non-empty array, every entry a string, a program that is present and has no
// leading dash. Kept as a copy so the check runs without the shell installed;
// the live test below runs the real one when it is.
function parseExecArgv(value) {
  const text = String(value || "");
  if (!text) return null
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { return null }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  for (const entry of parsed) if (typeof entry !== "string") return null;
  if (!parsed[0] || parsed[0].charAt(0) === "-") return null;
  return parsed;
}

// The value part of the exec-hint argument, or null when the command carries
// none. The whole `-h` argument must be `STRING:omarchy-exec-argv:<json>`: a
// hint sent under another type or another name is a hint the daemon never reads.
function hintValue(args) {
  const list = strings(args);
  for (let i = 0; i < list.length; i++) {
    if (list[i] !== "-h") continue;
    const arg = list[i + 1];
    if (typeof arg !== "string" || !arg.startsWith(HINT_FORM)) continue;
    return arg.slice(HINT_FORM.length);
  }
  return null;
}

// One of everything the bar can send: a writable band alert, a read-only one, a
// critical one, the first-run notice, and a new-drive notice.
function everyAlert() {
  const models = rings(WANTED).find((m) => m.target === MODELS);
  const root = rings(WANTED).find((m) => m.target === "/");
  const candidates = Array.from(Mounts.candidatePartitions(LSBLK));
  return [
    { name: "band alert", alert: { kind: "band", target: MODELS, pct: models.pct, avail: models.avail, readonly: models.readonly, band: 1 } },
    { name: "read-only band alert", alert: { kind: "band", target: USB, pct: 91, avail: "12.0G", readonly: true, band: 2 } },
    { name: "critical band alert", alert: { kind: "band", target: "/", pct: 99, avail: "1.1G", readonly: false, band: 3 } },
    { name: "onboarding notice", alert: { kind: "onboarding", candidates } },
    { name: "new-partition notice", alert: { kind: "new-partition", candidate: find(candidates, USB_PART) } },
  ];
}

// --- the hint every notification carries ------------------------------------

test("every notification kind carries the agent command as an omarchy exec hint", () => {
  for (const { name, alert } of everyAlert()) {
    const hint = hintValue(Mounts.notifyArgs(alert, null));
    assert.ok(hint, `${name} must attach -h ${HINT_FORM}<json>, the only click route that survives a shell restart`);
    const argv = parseExecArgv(hint);
    assert.ok(argv, `${name} sent a hint the daemon's own validator would refuse: ${hint}`);
    assert.deepEqual(argv, ["omarchy", "agent", "prompt", Mounts.promptFor(alert)],
      `${name}'s hint must run the same agent command a live click runs`);
  }
});

test("the hint is dispatched on kind, so a clicked notice asks its own question", () => {
  const candidates = Array.from(Mounts.candidatePartitions(LSBLK));
  const models = rings(WANTED).find((m) => m.target === MODELS);

  const band = parseExecArgv(hintValue(Mounts.notifyArgs(
    { kind: "band", target: MODELS, pct: models.pct, avail: models.avail, readonly: models.readonly, band: 2 }, null)));
  assert.ok(band[3].includes("disk-prune") && band[3].includes(MODELS), band[3]);

  const onboarding = parseExecArgv(hintValue(Mounts.notifyArgs({ kind: "onboarding", candidates }, null)));
  assert.ok(onboarding[3].includes("partition-onboarding"), onboarding[3]);
  for (const candidate of candidates)
    assert.ok(onboarding[3].includes(candidate.target), `the notice's hint must carry ${candidate.target}`);

  const fresh = parseExecArgv(hintValue(Mounts.notifyArgs({ kind: "new-partition", candidate: find(candidates, USB_PART) }, null)));
  assert.ok(fresh[3].includes("partition-onboarding") && fresh[3].includes(USB_PART), fresh[3]);
});

test("a configured agentCommand is the program the hint runs", () => {
  const models = rings(WANTED).find((m) => m.target === MODELS);
  const alert = { kind: "band", target: MODELS, pct: models.pct, avail: models.avail, readonly: models.readonly, band: 3 };

  assert.deepEqual(parseExecArgv(hintValue(Mounts.notifyArgs(alert, AGENT))),
    [AGENT[0], AGENT[1], Mounts.promptFor(alert)],
    "the override rides in the hint exactly as written, with the prompt appended as one argument");

  // The Qt list wrapper the plugin hand-off actually delivers, recovered the
  // same way the live agent command is: a hint built from an unrecovered
  // setting is a hint the daemon refuses.
  const wrapped = { toJSON: () => AGENT };
  assert.deepEqual(parseExecArgv(hintValue(Mounts.notifyArgs(alert, wrapped))),
    [AGENT[0], AGENT[1], Mounts.promptFor(alert)]);

  // An override the normalizer refuses means the default agent, not half a list.
  const broken = [AGENT[0], 7, ""];
  assert.deepEqual(parseExecArgv(hintValue(Mounts.notifyArgs(alert, broken))),
    ["omarchy", "agent", "prompt", Mounts.promptFor(alert)]);
});

test("the agent argv and the hint argv are the same argv", () => {
  for (const { name, alert } of everyAlert()) {
    for (const agent of [null, AGENT]) {
      assert.deepEqual(parseExecArgv(hintValue(Mounts.notifyArgs(alert, agent))), strings(Mounts.agentArgv(alert, agent)),
        `${name}: the daemon's click and the widget's own click must not disagree`);
    }
  }
});

// --- no shell anywhere in the hand-off --------------------------------------

test("the prompt rides as one argument, never as a shell string", () => {
  // A mount target with a space in it is the case a shell string breaks on.
  const stick = find(Array.from(Mounts.candidatePartitions(LSBLK)), USB);
  const alert = { kind: "new-partition", candidate: stick };
  const argv = parseExecArgv(hintValue(Mounts.notifyArgs(alert, null)));

  assert.equal(argv.length, 4, "program, subcommand, subcommand, prompt: nothing to re-split");
  assert.equal(argv[3], Mounts.promptFor(alert));
  assert.ok(argv[3].includes(USB), `the target with its space stays inside one argument: ${argv[3]}`);
  for (const entry of argv) assert.notEqual(entry.trim(), "", "an empty argument is a hole in the argv");
});

test("the hint is one single-line JSON array, quotes and newlines escaped", () => {
  for (const { name, alert } of everyAlert()) {
    const hint = hintValue(Mounts.notifyArgs(alert, AGENT));
    assert.ok(!hint.includes("\n") && !hint.includes("\r"), `${name}'s hint must stay one argument on one line`);
    assert.deepEqual(strings(JSON.parse(hint)), strings(Mounts.agentArgv(alert, AGENT)), `${name}'s hint must round-trip`);
  }

  // A partition label carrying a double quote and a newline is what a raw,
  // unescaped hint value would break on: one argument that splits into two, or
  // a JSON array that no longer parses.
  const odd = {
    key: "deadbeef-0000", target: '/run/media/jason/Weird "Label"', path: "/dev/sdz1",
    fstype: "ext4", size: "1T", label: 'Weird "\nLabel"', removable: true,
  };
  const alert = { kind: "new-partition", candidate: odd };
  const hint = hintValue(Mounts.notifyArgs(alert, AGENT));
  assert.ok(!hint.includes("\n"), "a newline in the prompt must ride escaped, not as a line break");
  const argv = parseExecArgv(hint);
  assert.ok(argv, `a label with quotes must still produce a runnable argv: ${hint}`);
  assert.equal(argv[2], Mounts.promptFor(alert), "the prompt comes back byte-for-byte");
});

test("a hint the daemon would refuse is not attached at all", () => {
  // parseExecArgv fails closed on a program with a leading dash. Attaching such
  // a hint changes nothing, so leave it off and keep the live action instead.
  const models = rings(WANTED).find((m) => m.target === MODELS);
  const alert = { kind: "band", target: MODELS, pct: models.pct, avail: models.avail, readonly: models.readonly, band: 2 };

  // No alert, nothing to ask: an empty prompt is a hole in the argv, not a
  // question for the agent.
  assert.equal(hintValue(Mounts.notifyArgs(null, null)), null,
    "an alert with no prompt gets no hint");

  for (const agent of [["--exec", "thing"], ["-x"], ["--", "thing"]]) {
    const args = strings(Mounts.notifyArgs(alert, agent));
    assert.equal(hintValue(args), null, `a program like ${JSON.stringify(agent[0])} is not a program`);
    assert.deepEqual(args, [
      "notify-send",
      "-A", `default=${Mounts.actionFor(alert)}`,
      "-u", Mounts.urgencyFor(alert),
      "-t", Mounts.timeoutFor(alert),
      Mounts.titleFor(alert),
      Mounts.bodyFor(alert),
    ], "the rest of the notify-send command is unchanged when there is no usable hint");
  }
});

// --- what the queue and the persistence depend on ---------------------------

test("notify-send keeps its action, urgency, and timeout arguments", () => {
  const models = rings(WANTED).find((m) => m.target === MODELS);
  const stick = find(Array.from(Mounts.candidatePartitions(LSBLK)), USB_PART);

  const cases = [
    { alert: { kind: "band", target: MODELS, pct: models.pct, avail: models.avail, readonly: models.readonly, band: 1 }, urgency: "normal", timeout: "6000" },
    { alert: { kind: "band", target: MODELS, pct: models.pct, avail: models.avail, readonly: models.readonly, band: 2 }, urgency: "normal", timeout: "6000" },
    { alert: { kind: "band", target: MODELS, pct: models.pct, avail: models.avail, readonly: models.readonly, band: 3 }, urgency: "critical", timeout: "0" },
    { alert: { kind: "onboarding", candidates: [stick] }, urgency: "critical", timeout: "0" },
    { alert: { kind: "new-partition", candidate: stick }, urgency: "critical", timeout: "0" },
  ];

  for (const { alert, urgency, timeout } of cases) {
    const args = strings(Mounts.notifyArgs(alert, null));
    assert.equal(args[0], "notify-send");
    assert.equal(args[1], "-A", "the libnotify action stays registered: it is what keeps notify-send blocking while the popup is clickable");
    assert.equal(args[2], `default=${Mounts.actionFor(alert)}`);
    assert.deepEqual(pair(args, "-u"), urgency);
    assert.deepEqual(pair(args, "-t"), timeout);
    assert.deepEqual(args.slice(-2), [Mounts.titleFor(alert), Mounts.bodyFor(alert)],
      "summary and body stay the last two arguments, so they can never be read as options");
  }
});

function pair(args, flag) {
  const i = args.indexOf(flag);
  assert.ok(i >= 0, `notify-send must pass ${flag}`);
  return args[i + 1];
}

test("the hint is sent as one argument under the name the daemon reads", () => {
  const stick = find(Array.from(Mounts.candidatePartitions(LSBLK)), USB_PART);
  const args = strings(Mounts.notifyArgs({ kind: "new-partition", candidate: stick }, null));
  const i = args.indexOf("-h");
  assert.ok(i >= 0, "notify-send must pass the exec hint");
  assert.ok(args[i + 1].startsWith(HINT_FORM), `the hint must be typed STRING and named ${HINT_KEY}: ${args[i + 1]}`);
  assert.equal(args.filter((a) => a === "-h").length, 1, "one hint argument");
});

// --- the QML stays wired to the shared logic --------------------------------

test("MountMonitor.qml builds its notify-send command and its agent command in the shared module", () => {
  const qml = readFileSync(path.join(repo, "MountMonitor.qml"), "utf8");
  assert.match(qml, /Mounts\.notifyArgs\(/, "the popup argv must come from Mounts.notifyArgs");
  assert.match(qml, /Mounts\.agentArgv\(/, "the agent argv must come from Mounts.agentArgv");
  assert.ok(!/"notify-send"/.test(qml), "no hand-built notify-send command left in the widget");
  assert.ok(!/"-A"/.test(qml), "no hand-built action argument left in the widget");
  assert.ok(!/"omarchy-exec-argv"/.test(qml), "the hint name lives in mounts.js, not in the widget");
});

// --- live check against the real daemon's validator -------------------------

test("the hint passes the installed notification service's own validator", (t) => {
  const file = "/usr/share/omarchy/shell/plugins/notifications/NotificationLogic.js";
  if (!existsSync(file)) {
    t.skip("the omarchy notification service is not installed on this machine");
    return;
  }
  const ctx = {
    Math, Number, String, Array, Object, JSON, RegExp, Boolean, Date, Error,
    parseInt, parseFloat, isFinite, isNaN, encodeURIComponent, decodeURIComponent, undefined,
  };
  vm.runInNewContext(readFileSync(file, "utf8"), ctx);
  assert.equal(typeof ctx.parseExecArgv, "function", "NotificationLogic.js must export parseExecArgv");

  for (const { name, alert } of everyAlert()) {
    const hint = hintValue(Mounts.notifyArgs(alert, AGENT));
    const argv = ctx.parseExecArgv(hint);
    assert.ok(argv, `${name}: the daemon rejected its hint: ${hint}`);
    assert.deepEqual(strings(argv), [AGENT[0], AGENT[1], Mounts.promptFor(alert)]);
  }
});
