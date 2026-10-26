// Plugin settings tests.
//
// Run: bash tests/run.sh   (or: node --test tests/)
//
// The guard for the bug this change fixes: shell.json carries "mounts" and
// "agentCommand" as JSON arrays, but the value Omarchy hands QML is a Qt list
// wrapper, not a JavaScript Array, so `Array.isArray(setting("mounts", ...))`
// rejected it and the bar fell back to one root ring - while the onboarding scan
// reported the mounts that were configured all along as unmonitored. The
// recovery lives in mounts.js so it is tested without a running shell;
// MountMonitor.qml only hands the setting over.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);

// mounts.js is a Qt-importable JavaScript file (plain top-level functions), so
// it is loaded into a VM context instead of imported as an ES module. JSON and
// Object are in the context because the settings recovery round-trips through
// JSON, exactly as it does inside QML's own engine.
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
const EFI = "/efi";
const SRV = "/srv/models";
const USB = "/run/media/jason/Backup Drive";
const USB_PART = "/run/media/jason/Archive";
// The captain's bar, exactly as his shell.json layout entry carries it.
const WANTED = ["/", MODELS, SRV];
const AGENT = ["/home/jason/Work/firstmate/bin/fm-inbox.sh", "note"];

function strings(list) {
  // Array.from rather than list.map: the list is built inside mounts.js's VM
  // context, and a cross-realm array is not deep-equal to a local one.
  return Array.from(list, (s) => s);
}

// The shapes a plugin setting can actually arrive in. A Qt list wrapper is not
// a JavaScript Array: it enumerates its elements as index-named properties and
// survives JSON.stringify, which is the round-trip that recovers it on the bar.
function qtListLike(items) {
  const wrapper = {};
  for (let i = 0; i < items.length; i++) wrapper[String(i)] = items[i];
  return wrapper;
}

function qtListLikeWithLength(items) {
  const wrapper = qtListLike(items);
  wrapper.length = items.length;
  return wrapper;
}

function stringifiedListLike(items) {
  // A wrapper whose serialization is the array itself.
  return { toJSON: () => items };
}

// --- mounts: the configured ring list ---------------------------------------

test("a real array of mounts reaches the bar unchanged", () => {
  assert.deepEqual(strings(Mounts.normalizeMounts(WANTED)), WANTED);
  assert.deepEqual(strings(Mounts.normalizeMounts(["/"])), ["/"]);
});

test("a Qt list wrapper is recovered into the configured mount list", () => {
  for (const raw of [qtListLike(WANTED), qtListLikeWithLength(WANTED), stringifiedListLike(WANTED)]) {
    assert.ok(!Array.isArray(raw), `${JSON.stringify(raw)} must not already be an Array`);
    assert.deepEqual(strings(Mounts.normalizeMounts(raw)), WANTED,
      "the JSON round-trip must recover every configured mount, in order");
  }
});

test("a JSON string carrying the array is recovered", () => {
  assert.deepEqual(strings(Mounts.normalizeMounts(JSON.stringify(WANTED))), WANTED);
  assert.deepEqual(strings(Mounts.normalizeMounts(' ["/", "/srv/models"] ')), ["/", "/srv/models"]);
});

test("a mount list that is not a list at all falls back to root only", () => {
  for (const raw of [undefined, null, "", "   ", "not a list", 42, true, {}, { fstype: "btrfs" }, "[1,2]", ["", "  "]]) {
    assert.deepEqual(strings(Mounts.normalizeMounts(raw)), ["/"],
      `${JSON.stringify(raw)} must fall back to the documented default, not an empty bar`);
  }
});

test("an explicitly empty mount list means no rings, which is not the same as garbage", () => {
  assert.deepEqual(strings(Mounts.normalizeMounts([])), []);
  assert.deepEqual(strings(Mounts.normalizeMounts("[]")), []);
});

test("mount entries are trimmed and unusable entries are dropped, order preserved", () => {
  assert.deepEqual(strings(Mounts.normalizeMounts([" / ", "/srv/models", "", null])), ["/", "/srv/models"]);
  assert.deepEqual(strings(Mounts.normalizeMounts(qtListLike(["/", "", SRV]))), ["/", SRV]);
});

// --- agentCommand: the argv override ----------------------------------------

test("a real agentCommand argv reaches the agent unchanged", () => {
  assert.deepEqual(strings(Mounts.normalizeAgentCommand(AGENT)), AGENT);
});

test("a Qt list wrapper agentCommand is recovered instead of rejected", () => {
  // The live failure: "agentCommand must be an argument list" while the config
  // carried a perfectly good two-argument list.
  for (const raw of [qtListLike(AGENT), qtListLikeWithLength(AGENT), stringifiedListLike(AGENT)]) {
    assert.ok(!Array.isArray(raw));
    assert.deepEqual(strings(Mounts.normalizeAgentCommand(raw)), AGENT);
  }
});

test("a JSON string agentCommand is recovered", () => {
  assert.deepEqual(strings(Mounts.normalizeAgentCommand(JSON.stringify(AGENT))), AGENT);
});

test("an agentCommand that is not an argument list means the default agent", () => {
  for (const raw of [undefined, null, "", "omarchy agent prompt", 7, true, {}, { cmd: "omarchy" }]) {
    assert.equal(Mounts.normalizeAgentCommand(raw), null,
      `${JSON.stringify(raw)} must read as "no override", never as a half-built command`);
  }
  assert.equal(Mounts.normalizeAgentCommand([]), null, "an empty argv cannot run anything");
  assert.equal(Mounts.normalizeAgentCommand(["", "  "]), null, "an argv of blanks cannot run anything");
});

test("an agentCommand keeps its arguments exactly as written", () => {
  const withSpaces = ["bash", "-c", "echo hello world"];
  assert.deepEqual(strings(Mounts.normalizeAgentCommand(withSpaces)), withSpaces);
  assert.deepEqual(strings(Mounts.normalizeAgentCommand(stringifiedListLike(withSpaces))), withSpaces);
});

// --- the scalar settings, same robustness -----------------------------------

test("the onboarding flag survives a string-shaped or wrapper-shaped boolean", () => {
  assert.equal(Mounts.normalizeBool(true, true), true);
  assert.equal(Mounts.normalizeBool(false, true), false);
  assert.equal(Mounts.normalizeBool("false", true), false);
  assert.equal(Mounts.normalizeBool("true", true), true);
  assert.equal(Mounts.normalizeBool(0, true), false);
  assert.equal(Mounts.normalizeBool(1, false), true);
  assert.equal(Mounts.normalizeBool(undefined, true), true, "unset means the documented default");
  assert.equal(Mounts.normalizeBool(null, true), true);
  assert.equal(Mounts.normalizeBool("maybe", true), true, "garbage must not silently disable onboarding");
  assert.equal(Mounts.normalizeBool({ toJSON: () => false }, true), false);
});

test("the testPct override survives a string-shaped or wrapper-shaped number", () => {
  assert.equal(Mounts.normalizeNumber(98, -1), 98);
  assert.equal(Mounts.normalizeNumber("98", -1), 98);
  assert.equal(Mounts.normalizeNumber(" 98 ", -1), 98);
  assert.equal(Mounts.normalizeNumber(-1, -1), -1);
  assert.equal(Mounts.normalizeNumber(undefined, -1), -1);
  assert.equal(Mounts.normalizeNumber("", -1), -1);
  assert.equal(Mounts.normalizeNumber("high", -1), -1, "an unusable override means no override");
  assert.equal(Mounts.normalizeNumber(NaN, -1), -1);
  assert.equal(Mounts.normalizeNumber({ toJSON: () => 90 }, -1), 90);
});

// --- the bug's downstream effect --------------------------------------------

test("a recovered mount list is what keeps configured mounts out of the candidate scan", () => {
  const wanted = Mounts.normalizeMounts(qtListLike(WANTED));
  const rings = Array.from(Mounts.selectMounts(FINDMNT, wanted, -1));
  const offered = Mounts.newCandidates(
    Mounts.candidatePartitions(LSBLK), Mounts.parseState(""), wanted, Mounts.monitoredDevices(rings));

  assert.deepEqual(strings(Array.from(rings, (m) => m.target)), WANTED,
    "the recovered list must draw all three rings");
  for (const target of [MODELS, SRV])
    assert.ok(!Array.from(offered, (c) => c.target).includes(target),
      `${target} is behind a ring and must never be offered as unmonitored`);
});

test("the fallback mount list is what made the bar draw one ring and offer the rest", () => {
  // The counterexample, kept so the fix stays honest about what it changed.
  const wanted = Mounts.normalizeMounts(qtListLike(WANTED));
  const fallback = ["/"];
  assert.ok(Array.from(Mounts.selectMounts(FINDMNT, fallback, -1)).length === 1);
  const offered = Array.from(Mounts.newCandidates(
    Mounts.candidatePartitions(LSBLK), Mounts.parseState(""), fallback,
    Mounts.monitoredDevices(Array.from(Mounts.selectMounts(FINDMNT, fallback, -1)))), (c) => c.target);
  assert.ok(offered.includes(MODELS) && offered.includes(SRV),
    "with the fallback list the monitored mounts were reported as new");
});

// --- the QML stays wired to the shared logic --------------------------------

test("mounts.js stays a plain script both consumers can load", () => {
  const src = readFileSync(path.join(repo, "mounts.js"), "utf8");
  assert.ok(!/^\s*(export|import)\b/m.test(src), "no export statement, no import statement");
  assert.ok(!src.includes(".pragma library"), "no .pragma library");
  assert.match(src, /^function [A-Za-z]+\(/m, "plain top-level function declarations");
});
