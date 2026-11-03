// memory.js and ringkit.js are QML JavaScript modules: plain top-level
// `function` declarations, no `export`, no `import`, no `.pragma library`. The
// tests load them the way QML does — as a script evaluated in a fresh context —
// so a future "just add an export" change fails here instead of in the shell.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import vm from "node:vm";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");

function loadScript(file) {
  const source = readFileSync(path.join(ROOT, file), "utf8");
  const context = {
    Math,
    Number,
    parseInt,
    parseFloat,
    isFinite,
    String,
    Array,
    Object,
    JSON,
    Date,
    RegExp,
    Boolean,
    console,
  };
  vm.runInNewContext(source, context, { filename: file });
  return context;
}

export const Memory = loadScript("memory-monitor/memory.js");
export const RingKit = loadScript("ringkit.js");
export const Mounts = loadScript("mounts.js");

export const FIXTURES = path.join(import.meta.dirname, "fixtures");

export function fixture(name) {
  return readFileSync(path.join(FIXTURES, name), "utf8");
}

export function repoFile(name) {
  return readFileSync(path.join(ROOT, name), "utf8");
}

// Objects built inside the vm context have that context's prototypes, so
// assert.deepStrictEqual rejects a perfectly correct array that memory.js built.
// Compare through JSON, which is also the shape the state file and the log use.
export function same(actual, expected, message) {
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), message);
}

// The shape QuickShell hands a `setting()` value: array-like, indexable, with a
// numeric length, and NOT a JavaScript Array. `Array.isArray` on it rejects a
// correctly configured list, which is the bug Mount Monitor already learned
// once. Every setting read in this plugin goes through a normalize* helper for
// exactly this reason.
export function qtList(values) {
  const list = {};
  values.forEach((value, index) => {
    list[index] = value;
  });
  list.length = values.length;
  return list;
}
