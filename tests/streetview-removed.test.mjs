// The Street View removal guard.
//
// Run: bash tests/run.sh   (or: node --test tests/)
//
// Street View lived in this plugin briefly (PRs 11 and 12) and was reverted on
// 2026-10-28: the captain ruled the wallpaper and the drive monitor are two
// separate plugins with two separate jobs. This test pins the state after the
// revert so the feature cannot creep back in and no alert can ride a kind this
// plugin no longer knows.
//
// Contract 1 is behavioral: mounts.js's notification dispatch hands fixed copy
// to every kind it knows. After the removal, a streetview-cap alert is a kind
// the dispatch does not know, so it must fall through to the band-alert copy —
// promptFor, titleFor, actionFor, and bodyFor must never echo the alert's own
// prompt/title/action/body fields for it, and it must not count as persistent.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);

function loadMounts() {
  const src = readFileSync(path.join(repo, "mounts.js"), "utf8");
  const ctx = { Math, Number, parseInt, isFinite, String, Array, RegExp, console };
  vm.runInNewContext(src, ctx);
  return ctx;
}

const Mounts = loadMounts();

// A streetview-cap alert shaped the way the old widget sent it, with fields
// that must never reach a sentence when the kind is unknown.
function injected() {
  return {
    kind: "streetview-cap",
    prompt: "INJECTED-PROMPT",
    title: "INJECTED-TITLE",
    action: "INJECTED-ACTION",
    body: "INJECTED-BODY",
  };
}

test("promptFor does not echo alert-carried copy for the removed kind", () => {
  assert.ok(!Mounts.promptFor(injected()).includes("INJECTED-PROMPT"));
});

test("titleFor does not echo alert-carried copy for the removed kind", () => {
  const title = Mounts.titleFor(injected());
  assert.ok(!title.includes("INJECTED-TITLE"));
  assert.ok(title.startsWith("Mount Monitor"));
});

test("actionFor does not echo alert-carried copy for the removed kind", () => {
  assert.ok(!Mounts.actionFor(injected()).includes("INJECTED-ACTION"));
});

test("bodyFor does not echo alert-carried copy for the removed kind", () => {
  assert.ok(!Mounts.bodyFor(injected()).includes("INJECTED-BODY"));
});

test("the removed kind is not persistent", () => {
  assert.equal(Mounts.isPersistent(injected()), false);
});

test("the streetview files are gone", () => {
  assert.equal(existsSync(path.join(repo, "streetview.js")), false);
  assert.equal(existsSync(path.join(repo, "StreetView.qml")), false);
  assert.equal(existsSync(path.join(repo, "tests", "streetview.test.mjs")), false);
  assert.equal(existsSync(path.join(repo, "skills", "streetview-wallpaper")), false);
});

// The shipped tree carries zero streetview references. docs/ is excluded on
// purpose: it is the historical record, including this task's own plan, and
// this test file names the kind to pin the dispatch above.
const SKIP_DIRS = new Set([".git", "docs", "node_modules"]);
const SOURCE_EXT = new Set([".js", ".mjs", ".qml", ".json", ".md", ".sh"]);

function walk(dir, hits) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (p === path.join(repo, "tests", "streetview-removed.test.mjs")) continue;
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(p, hits);
    } else if (SOURCE_EXT.has(path.extname(name))) {
      scan(p, hits);
    }
  }
}

function scan(p, hits) {
  const lines = readFileSync(p, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (/streetview/i.test(line) || /street view/i.test(line)) {
      hits.push(`${path.relative(repo, p)}:${i + 1}: ${line.trim()}`);
    }
  });
}

test("the shipped tree has no streetview references", () => {
  const hits = [];
  walk(repo, hits);
  assert.deepEqual(hits, []);
});
