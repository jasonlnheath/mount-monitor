// The install layout is a PR 1 fact, not a PR 4 discovery.
//
// Run: bash memory-monitor/tests/run.sh   (or: node --test memory-monitor/tests/)
//
// PluginRegistry.qml's scan_thirdparty reads exactly one level:
// ~/.config/omarchy/plugins/*/manifest.json, no deeper. So a manifest sitting at
// memory-monitor/manifest.json inside this checkout is invisible to the shell, and
// a clone-in-place of this repository cannot serve both plugins - the repo root's
// manifest is Mount Monitor's, and one directory yields exactly one registration.
//
// install.sh's answer is to copy the plugin out of the checkout into its own
// top-level plugin directory. This test runs that copy for real, against a throwaway
// HOME, so the layout is proven without touching the live bar: what the shell scans
// is a self-contained plugin, registered exactly once, carrying the repo-root module
// its widget imports.
//
// It also proves the two things the captain's live surface depends on: the installer
// replaces rather than merges (a file deleted in the repo stays deleted on the bar),
// and it never writes shell.json - adding the layout entry is the captain's edit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const here = import.meta.dirname;
const plugin = path.dirname(here);
const repo = path.dirname(plugin);
const PLUGIN_ID = "io.github.jasonlnheath.memory-monitor";

function fakeHome() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mm-install-"));
  return dir;
}

function runInstaller(home) {
  return spawnSync("bash", [path.join(plugin, "install.sh")], {
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
}

function installedDir(home) {
  return path.join(home, ".config", "omarchy", "plugins", PLUGIN_ID);
}

// Every manifest.json under a directory, with its depth from that directory.
function manifests(root, depth = 0, out = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) manifests(full, depth + 1, out);
    else if (entry.name === "manifest.json") out.push({ depth, full });
  }
  return out;
}

test("install.sh installs a self-contained plugin at the one level the shell scans", () => {
  const home = fakeHome();
  try {
    const run = runInstaller(home);
    assert.equal(run.status, 0, `install.sh failed: ${run.stderr}`);

    const dir = installedDir(home);
    assert.equal(existsSync(dir), true, "the plugin installs as its own top-level directory, not inside the checkout");
    assert.equal(existsSync(path.join(dir, "manifest.json")), true, "manifest.json sits at that directory's root, which is what scan_thirdparty reads");

    // The widget imports memory.js and ringkit.js. A QML JS module cannot import
    // another JS module, so ringkit.js has to be copied beside its consumer or
    // the plugin loads as a bar widget that throws on its first decision.
    for (const file of ["manifest.json", "MemoryMonitor.qml", "MemoryPanel.qml", "QuattroDash.qml", "QuattroSymbol.qml", "CardBar.qml", "memory.js", "quattro.js", "ringkit.js", "README.md"]) {
      assert.equal(existsSync(path.join(dir, file)), true, `${file} is missing from the installed plugin`);
    }

    const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
    assert.equal(manifest.id, PLUGIN_ID);
    assert.equal(manifest.entryPoints.barWidget, "MemoryMonitor.qml");
    assert.equal(manifest.kinds.includes("bar-widget"), true);

    // One level only: a manifest buried deeper is invisible to the registry, so
    // the installed plugin must not carry a nested one.
    const found = manifests(dir);
    assert.deepEqual(found.map(m => m.depth), [0], "the installed plugin carries exactly one manifest, at its root");

    // The checkout is source layout: its own manifest is Mount Monitor's, and
    // installing the sibling must not touch it.
    const repoManifest = JSON.parse(readFileSync(path.join(repo, "manifest.json"), "utf8"));
    assert.notEqual(repoManifest.id, PLUGIN_ID, "the repo root registers Mount Monitor; the sibling installs beside it");
    assert.equal(existsSync(path.join(repo, "memory-monitor", "manifest.json")), true, "the source layout keeps its manifest for the installer to copy");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the installer replaces the plugin directory rather than merging into it", () => {
  const home = fakeHome();
  try {
    assert.equal(runInstaller(home).status, 0);
    const dir = installedDir(home);
    // Something an older version of the plugin shipped and this one does not.
    writeFileSync(path.join(dir, "stale-from-an-older-install.js"), "old decision, no owner\n");
    assert.equal(runInstaller(home).status, 0);
    assert.equal(existsSync(path.join(dir, "stale-from-an-older-install.js")), false, "a plain copy leaves old decisions behind, and two copies of one decision drift");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the installer copies its skills wholesale and refuses to install from the installed directory", () => {
  const home = fakeHome();
  try {
    assert.equal(runInstaller(home).status, 0);
    const skill = path.join(home, ".agents", "skills", "memory-health", "SKILL.md");
    assert.equal(existsSync(skill), true, "memory-health ships with the plugin");
    // Skill-name ownership is named in the plan: memory-health is Memory
    // Monitor's, and the three Mount Monitor skills are not copied here.
    for (const other of ["disk-prune", "partition-onboarding", "partition-remove"]) {
      assert.equal(existsSync(path.join(home, ".agents", "skills", other)), false, `${other} belongs to Mount Monitor`);
    }

    // The guard against copying a plugin into itself: run the installer from
    // inside an installed plugin directory and it refuses rather than replacing
    // the directory it is standing in.
    const installedCopy = path.join(installedDir(home), "install.sh");
    writeFileSync(installedCopy, readFileSync(path.join(plugin, "install.sh"), "utf8"));
    const fromInstalled = spawnSync("bash", [installedCopy], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    });
    assert.notEqual(fromInstalled.status, 0, "running the installer from inside the installed plugin would copy a plugin into itself");
    assert.match(fromInstalled.stderr, /Refusing to install from inside/);
    assert.equal(existsSync(path.join(installedDir(home), "memory.js")), true, "and refusing means refusing: the installed plugin is still there");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("the installer never writes shell.json - the layout entry is the captain's own edit", () => {
  const home = fakeHome();
  try {
    mkdirSync(path.join(home, ".config", "omarchy"), { recursive: true });
    const shellJson = path.join(home, ".config", "omarchy", "shell.json");
    writeFileSync(shellJson, '{"widgets":{"right":[{"id":"io.github.jasonlnheath.mount-monitor"}]}}\n');
    const before = readFileSync(shellJson, "utf8");

    const run = runInstaller(home);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(readFileSync(shellJson, "utf8"), before, "install.sh must not add or remove a layout entry; a vanished shell.json entry has bitten this bar twice in one day");
    assert.match(run.stdout, /shell\.json/, "and it says so, in words, rather than doing it");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
