// Mount Monitor logic tests.
//
// Run: bash tests/run.sh   (or: node --test tests/)
//
// The mount filter, band thresholds, and alert text live in mounts.js so they
// are testable without a running shell. These tests are the guard for the bug
// this change fixes: the read-only NTFS models partition never reached a ring
// because the plugin asked findmnt for btrfs rows only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);

// mounts.js is a Qt-importable JavaScript file (plain top-level functions), so
// it is loaded into a VM context instead of imported as an ES module.
function loadMounts() {
  const src = readFileSync(path.join(repo, "mounts.js"), "utf8");
  const ctx = { Math, Number, parseInt, isFinite, String, Array, RegExp, console };
  vm.runInNewContext(src, ctx);
  return ctx;
}

const Mounts = loadMounts();

// Fixture lines starting with '#' document the fixture and are not findmnt rows.
function fixture(name) {
  return readFileSync(path.join(here, "fixtures", name), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"))
    .join("\n");
}

const RIG = fixture("findmnt-rig.txt");
const BTRFS_ONLY = fixture("findmnt-btrfs-only.txt");
const MODELS = "/mnt/models";
// The captain's bar: root, the btrfs data drive, and the models partition.
const WANTED = ["/", "/srv/models", MODELS];

function targets(list) {
  // Array.from rather than list.map: the list is built inside mounts.js's VM
  // context, and a cross-realm array is not deep-equal to a local one.
  return Array.from(list, (m) => m.target);
}

// --- the reported bug -------------------------------------------------------

test("the models partition is missing from the ring list when findmnt is asked for btrfs only", () => {
  // This is what the plugin used to ask for; the row never exists in the output.
  const list = Mounts.selectMounts(BTRFS_ONLY, WANTED, -1);
  assert.ok(!targets(list).includes(MODELS), "expected the old btrfs-only output to hide the models mount");
});

test("the models partition gets a ring once the reading is not filtered by filesystem type", () => {
  const list = Mounts.selectMounts(RIG, WANTED, -1);
  assert.deepEqual(targets(list), ["/", "/srv/models", MODELS]);
  const models = list.find((m) => m.target === MODELS);
  assert.equal(models.pct, 86);
  assert.equal(models.used, "1.1T");
  assert.equal(models.avail, "186.1G");
});

test("findmnt is asked for every mount, not a single filesystem type", () => {
  const args = Mounts.findmntArgs();
  const joined = args.join(" ");
  assert.ok(!joined.includes("btrfs"), `findmnt args must not filter by filesystem type: ${joined}`);
  assert.ok(!joined.includes("-t "), `findmnt args must not carry a -t type filter: ${joined}`);
  for (const column of ["SOURCE", "TARGET", "USED", "AVAIL", "USE%", "OPTIONS"])
    assert.ok(joined.includes(column), `findmnt args must request ${column}: ${joined}`);
});

// --- live check against this machine's real mount table ---------------------

test("the real findmnt run reports the models mount whenever it is mounted", (t) => {
  let mounted = false;
  try {
    mounted = execFileSync("findmnt", ["-rn", "-o", "TARGET", MODELS], { encoding: "utf8" }).trim() !== "";
  } catch {
    mounted = false;
  }
  if (!mounted) {
    t.skip(`${MODELS} is not mounted here`);
    return;
  }
  const out = execFileSync("findmnt", Mounts.findmntArgs(), { encoding: "utf8" });
  const list = Mounts.selectMounts(out, [MODELS], -1);
  assert.deepEqual(targets(list), [MODELS], "the live findmnt reading must yield a models ring");
  assert.equal(list[0].readonly, true, `${MODELS} is mounted read-only on this rig`);

  // The form this change replaces, kept as the counterexample.
  const old = execFileSync("findmnt", ["-rn", "-t", "btrfs", "-o", "SOURCE,TARGET,USED,AVAIL,USE%"], { encoding: "utf8" });
  assert.equal(targets(Mounts.selectMounts(old, [MODELS], -1)).length, 0);
});

// --- which mounts may draw a ring ------------------------------------------

test("pseudo filesystems never draw a ring, even when configured", () => {
  const list = Mounts.selectMounts(RIG, ["/tmp", "/run/user/1000", "/proc", "/sys", "/sys/fs/cgroup"], -1);
  assert.deepEqual(targets(list), []);
});

test("rows without usable numbers are skipped", () => {
  const list = Mounts.selectMounts(RIG, ["/var/lib/docker/overlayfs/x1y2z3", "/run/docker/netns/x1y2z3"], -1);
  assert.deepEqual(targets(list), []);
});

test("every btrfs subvolume mount on one device still gets its own ring", () => {
  const list = Mounts.selectMounts(RIG, ["/", "/home", "/var/log", "/var/cache/pacman/pkg"], -1);
  assert.deepEqual(targets(list), ["/", "/home", "/var/log", "/var/cache/pacman/pkg"]);
});

test("the same target reported twice keeps the first row", () => {
  const dup = `${RIG}\n/dev/nvme1n1p9 ${MODELS} ntfs3 900G 50G 94% ro,relatime\n`;
  const list = Mounts.selectMounts(dup, [MODELS], -1);
  assert.equal(list.length, 1);
  assert.equal(list[0].pct, 86);
});

// --- alert bands apply to the new ring --------------------------------------

test("band thresholds are 80, 90, and 98", () => {
  assert.equal(Mounts.bandFor(79), 0);
  assert.equal(Mounts.bandFor(80), 1);
  assert.equal(Mounts.bandFor(86), 1);
  assert.equal(Mounts.bandFor(89), 1);
  assert.equal(Mounts.bandFor(90), 2);
  assert.equal(Mounts.bandFor(97), 2);
  assert.equal(Mounts.bandFor(98), 3);
  assert.equal(Mounts.bandFor(100), 3);
});

test("the models mount crosses the 80 band in the reading the alerts use", () => {
  const list = Mounts.selectMounts(RIG, WANTED, -1);
  const models = list.find((m) => m.target === MODELS);
  assert.equal(Mounts.bandFor(models.pct), 1);
});

test("the testPct override feeds the reading the alerts use", () => {
  const list = Mounts.selectMounts(RIG, WANTED, 98);
  for (const m of list) assert.equal(m.pct, 98);
  assert.equal(Mounts.bandFor(list.find((m) => m.target === MODELS).pct), 3);
  // -1 means "no override", the real percentages stand.
  assert.equal(Mounts.selectMounts(RIG, WANTED, -1).find((m) => m.target === MODELS).pct, 86);
});

// --- alert honesty on a mount that can never be pruned ---------------------

test("a read-only mount is reported as read-only in the ring tooltip", () => {
  const list = Mounts.selectMounts(RIG, WANTED, -1);
  const models = list.find((m) => m.target === MODELS);
  const root = list.find((m) => m.target === "/");
  assert.ok(Mounts.tooltip(models).includes("read-only"), Mounts.tooltip(models));
  assert.ok(!Mounts.tooltip(root).includes("read-only"), Mounts.tooltip(root));
  assert.ok(Mounts.tooltip(models).includes("86%"));
});

test("a read-only alert does not promise prune candidates", () => {
  const list = Mounts.selectMounts(RIG, WANTED, -1);
  const models = list.find((m) => m.target === MODELS);
  const body = Mounts.notifyBody({ target: models.target, pct: models.pct, avail: models.avail, readonly: models.readonly, band: 1 });
  assert.ok(body.includes("read-only"), body);
  assert.ok(!/prune\/?compress candidates/i.test(body), body);
  assert.ok(body.includes("move"), body);
});

test("the notification action names what the click actually returns", () => {
  const list = Mounts.selectMounts(RIG, WANTED, -1);
  const models = list.find((m) => m.target === MODELS);
  const root = list.find((m) => m.target === "/");
  assert.equal(Mounts.notifyAction({ target: MODELS, readonly: models.readonly }), "Run move-off report");
  assert.equal(Mounts.notifyAction({ target: "/", readonly: root.readonly }), "Run cleanup analysis");
});

test("the agent prompt for a read-only mount asks for a move-off report, not a prune scan", () => {
  const list = Mounts.selectMounts(RIG, WANTED, -1);
  const models = list.find((m) => m.target === MODELS);
  const prompt = Mounts.agentPrompt(models);
  assert.ok(prompt.includes(MODELS), prompt);
  assert.ok(prompt.includes("read-only"), prompt);
  assert.ok(!/scan .* for prune and compress candidates/.test(prompt), prompt);
  assert.ok(prompt.includes("disk-prune"), prompt);
});

test("a writable mount keeps the prune/compress prompt", () => {
  const list = Mounts.selectMounts(RIG, WANTED, -1);
  const root = list.find((m) => m.target === "/");
  const prompt = Mounts.agentPrompt(root);
  assert.ok(/scan \/ for prune and compress candidates/.test(prompt), prompt);
  assert.ok(!prompt.includes("read-only"), prompt);
  const body = Mounts.notifyBody({ target: root.target, pct: root.pct, avail: root.avail, readonly: root.readonly, band: 0 });
  assert.ok(body.includes("prune/compress candidates"), body);
});

// --- the QML stays wired to the shared logic -------------------------------

test("MountMonitor.qml asks findmnt through the shared module and keeps no type filter", () => {
  const qml = readFileSync(path.join(repo, "MountMonitor.qml"), "utf8");
  assert.ok(qml.includes('import "mounts.js" as Mounts'), "the QML must use the tested module");
  assert.ok(!qml.includes('"-t", "btrfs"'), "the QML must not filter findmnt to btrfs");
  assert.ok(qml.includes("Mounts.findmntArgs()"), "the findmnt arguments must come from the module");
  assert.ok(qml.includes("Mounts.selectMounts("), "the reading must be parsed by the module");
});
