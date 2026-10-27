// Mount points containing a space - or any other byte findmnt escapes.
//
// Run: bash tests/run.sh   (or: node --test tests/)
//
// The guard for the bug PR #8 deferred in its own out-of-scope section: findmnt
// hex-escapes every byte outside printable ASCII (and the backslash) in its
// columns, so a mountpoint named "/mnt/my stick" prints as /mnt/my\x20stick,
// while lsblk -P pairs output - and the plugin's `mounts` setting, which
// partition-onboarding wires from lsblk - carry the real space. parseRows kept
// findmnt's escape, so the configured entry never matched its row: no ring, no
// alert, no tooltip, and the device invisible to the onboarding scan.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);

// mounts.js is a Qt-importable JavaScript file (plain top-level functions), so it
// is loaded into a VM context instead of imported as an ES module. JSON and Object
// are in the context because the onboarding state is JSON.
function loadMounts() {
  const src = readFileSync(path.join(repo, "mounts.js"), "utf8");
  const ctx = { Math, Number, parseInt, isFinite, String, Array, RegExp, JSON, Object, console };
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

const FINDMNT = fixture("findmnt-rig.txt");
const LSBLK = fixture("lsblk-rig.txt");

// The exfat stick the lsblk fixture carries: one spelling for the mountpoint as
// lsblk, shell.json, and the captain write it, one for the column findmnt prints.
const STICK = "/run/media/jason/Backup Drive";
const STICK_PRINTED = "/run/media/jason/Backup\\x20Drive";
const STICK_DEVICE = "/dev/sdb";
const MODELS = "/mnt/models";
const SRV = "/srv/models";

function strings(list) {
  // Array.from rather than list.map: the list is built inside mounts.js's VM
  // context, and a cross-realm array is not deep-equal to a local one.
  return Array.from(list, (s) => s);
}

function targets(list) {
  return strings(Array.from(list, (m) => m.target));
}

function rings(wanted) {
  return Array.from(Mounts.selectMounts(FINDMNT, wanted, -1));
}

function row(printedTarget, options) {
  return `/dev/sdb1 ${printedTarget} ext4 10G 5G 66% ${options || "rw,relatime"}`;
}

function oneRow(printedTarget, options) {
  const rows = Array.from(Mounts.parseRows(row(printedTarget, options)));
  assert.equal(rows.length, 1, `one row must parse for ${JSON.stringify(printedTarget)}`);
  return rows[0];
}

function blockRecords(prompt) {
  const start = String(prompt).indexOf("<<<MOUNT MONITOR DEVICE DATA");
  const open = String(prompt).indexOf(">>>", start) + 3;
  const close = String(prompt).indexOf("<<<END DEVICE DATA>>>", open);
  return JSON.parse(String(prompt).slice(open, close).trim());
}

function instructionOf(prompt) {
  return String(prompt).split("<<<")[0];
}

// findmnt's own escaping, as a test-side reference: every byte outside printable
// ASCII, plus the backslash, printed as \xNN. Verified against a live findmnt on a
// mount namespace holding directories named with a space, a tab, a newline, a
// backslash, DEL, NBSP, and non-ASCII names.
function escapeFindmnt(text) {
  return Array.from(Buffer.from(String(text), "utf8"), (b) =>
    b >= 0x21 && b <= 0x7e && b !== 0x5c ? String.fromCharCode(b) : `\\x${b.toString(16).padStart(2, "0")}`
  ).join("");
}

// --- the reading is the real path -------------------------------------------

test("a findmnt target containing a space is read back as the real mountpoint", () => {
  const parsed = oneRow("/mnt/my\\x20stick");
  assert.equal(parsed.target, "/mnt/my stick");
  assert.equal(parsed.source, "/dev/sdb1");
  assert.equal(parsed.fstype, "ext4");
  assert.equal(parsed.pct, 66);
  assert.equal(parsed.readonly, false);
});

test("every byte findmnt escapes comes back as the byte its hex stands for", () => {
  const cases = [
    ["/mnt/my\\x20stick", "/mnt/my stick"],
    ["/mnt/trailing\\x20", "/mnt/trailing "],
    ["/mnt/tab\\x09here", "/mnt/tab\there"],
    ["/mnt/back\\x5cslash", "/mnt/back\\slash"],
    ["/mnt/del\\x7fend", "/mnt/del\u007fend"],
    ["/mnt/nbsp\\xa0here", "/mnt/nbsp\u00a0here"],
    ["/mnt/Donn\\xe9es", "/mnt/Données"],
    ["/mnt/uni-\\xc3\\xa9\\xc3\\xa8", "/mnt/uni-éè"],
    ["/mnt/pup\\xe2\\x80\\x8bdog", "/mnt/pup\u200bdog"],
    ["/mnt/\\xf0\\x9f\\x90\\xa9", "/mnt/🐩"],
  ];
  for (const [printed, real] of cases) {
    const parsed = oneRow(printed);
    assert.equal(parsed.target, real, `${printed} must decode to the path on the disk`);
    // The row is still one row: the escape is what kept the columns separable.
    assert.equal(parsed.source, "/dev/sdb1");
    assert.equal(parsed.pct, 66);
  }
});

test("decoding is a round trip, not a rewrite: a name that really contains \\x20 keeps it", () => {
  // A directory actually named `\x20literal` prints with its backslash escaped, so
  // the four characters \ x 2 0 stay four characters.
  assert.equal(oneRow("/mnt/esc\\x5cx20literal").target, "/mnt/esc\\x20literal");
});

test("the column split still needs no quoting, because findmnt escapes every whitespace byte", () => {
  // A target with a space must not shift the columns after it.
  const parsed = oneRow("/mnt/my\\x20stick", "ro,relatime,uid=1000");
  assert.equal(parsed.fstype, "ext4");
  assert.equal(parsed.used, "10G");
  assert.equal(parsed.avail, "5G");
  assert.equal(parsed.pct, 66);
  assert.equal(parsed.readonly, true);
});

// --- the configured entry matches -------------------------------------------

test("a configured mountpoint with a space gets its ring", () => {
  const list = rings([STICK]);
  assert.deepEqual(targets(list), [STICK],
    `the configured ${STICK} must match the row findmnt prints as ${STICK_PRINTED}`);
  const stick = list[0];
  assert.equal(stick.source, STICK_DEVICE);
  assert.equal(stick.fstype, "exfat");
  assert.equal(stick.pct, 66);
  assert.equal(stick.used, "1.2T");
  assert.equal(stick.avail, "600G");
  assert.equal(stick.readonly, false);
  assert.equal(stick.id, Mounts.mountId(STICK), "the ring's id is minted from the real target");
});

test("a spaced mount sits in the configured order next to the others", () => {
  assert.deepEqual(targets(rings(["/", STICK, SRV, MODELS])), ["/", STICK, SRV, MODELS]);
});

test("an unconfigured spaced mount still draws no ring", () => {
  assert.deepEqual(targets(rings(["/mnt/other stick", "/run/media/jason/Archive"])), []);
});

test("the same spaced target reported twice keeps the first row", () => {
  const dup = `${FINDMNT}\n/dev/sdd ${STICK_PRINTED} exfat 900G 100G 94% rw,relatime\n`;
  const list = Array.from(Mounts.selectMounts(dup, [STICK], -1));
  assert.equal(list.length, 1);
  assert.equal(list[0].pct, 66);
});

test("a read-only spaced mount keeps the move-off copy", () => {
  const rows = Array.from(Mounts.parseRows(
    `/dev/sdd1 ${STICK_PRINTED} ntfs3 1.1T 186.1G 86% ro,relatime,uid=1000`));
  const alert = rows[0];
  assert.equal(alert.readonly, true);
  const body = Mounts.notifyBody({ target: alert.target, pct: alert.pct, avail: alert.avail, readonly: alert.readonly });
  assert.ok(body.startsWith(STICK), body);
  assert.ok(body.includes("read-only"), body);
  assert.ok(!/prune\/?compress candidates/i.test(body), body);
});

// --- the ripples: onboarding matching and the copy the captain reads --------

test("the device behind a spaced ring is watched, so its partition is not offered as unmonitored", () => {
  const wanted = ["/", SRV, MODELS, STICK];
  const watched = strings(Mounts.monitoredDevices(rings(wanted)));
  assert.ok(watched.includes(STICK_DEVICE),
    `the stick behind the ${STICK} ring must be watched: ${watched.join(", ")}`);

  const candidates = Array.from(Mounts.candidatePartitions(LSBLK));
  const annotated = Array.from(Mounts.annotateCandidates(candidates, wanted, watched));
  const stick = annotated.find((c) => c.target === STICK);
  assert.ok(stick, "the stick is a candidate");
  assert.equal(stick.monitored, true, "a partition behind a spaced ring is watched like any other");

  const offered = targets(Mounts.newCandidates(candidates, Mounts.parseState(""), wanted, watched));
  assert.ok(!offered.includes(STICK), `a configured drive must never be offered: ${offered.join(", ")}`);
});

test("without the ring the same partition was offered as unmonitored (the counterexample)", () => {
  // The bar as it was: the stick is configured, draws nothing, and is therefore
  // reported as a partition that needs a decision.
  const wanted = ["/", SRV, MODELS];
  const watched = strings(Mounts.monitoredDevices(rings(wanted)));
  const offered = targets(Mounts.newCandidates(
    Array.from(Mounts.candidatePartitions(LSBLK)), Mounts.parseState(""), wanted, watched));
  assert.ok(offered.includes(STICK), `expected ${STICK} in ${offered.join(", ")}`);
});

test("the popup and the tooltip print the mountpoint with its space", () => {
  const stick = rings([STICK])[0];
  const body = Mounts.notifyBody({ target: stick.target, pct: stick.pct, avail: stick.avail, readonly: stick.readonly });
  assert.ok(body.startsWith(STICK), body);
  assert.ok(!body.includes("\\x20"), `findmnt's escape must not reach the captain: ${body}`);

  const tip = Mounts.tooltip(stick);
  assert.ok(tip.includes(STICK), tip);
  assert.ok(!tip.includes("\\x20"), tip);
  assert.ok(tip.includes("66% used"), tip);
});

test("the agent prompt names the spaced mount by id and carries its real target as data", () => {
  const stick = rings([STICK])[0];
  const prompt = Mounts.agentPrompt(stick);
  assert.match(instructionOf(prompt), /with id mm-[0-9a-f]{8}-[0-9a-f]{8}/, instructionOf(prompt));
  assert.ok(!instructionOf(prompt).includes(STICK), "no mountpoint in the instruction, spaced or not");
  const records = blockRecords(prompt);
  assert.deepEqual(Array.from(records, (r) => r.target), [STICK]);
  assert.equal(records[0].device, STICK_DEVICE);
});

test("a spaced target is one mountId, and the escaped spelling is a different one", () => {
  // The id is minted from the decoded target, so the ring, the alert queue, and the
  // band memory all name the same mount. The escaped spelling is what used to be
  // the only one available, and it must not be what an id is keyed on.
  assert.equal(Mounts.mountId(STICK), Mounts.mountId("/mnt/my stick"));
  assert.notEqual(Mounts.mountId(STICK), Mounts.mountId(STICK_PRINTED));
});

// --- the live reading -------------------------------------------------------

test("a live findmnt reading round-trips: every column decodes back to what findmnt printed", (t) => {
  let out;
  try {
    out = execFileSync("findmnt", Mounts.findmntArgs(), { encoding: "utf8" });
  } catch {
    t.skip("findmnt is not installed here");
    return;
  }

  const parsed = Array.from(Mounts.parseRows(out));
  assert.ok(parsed.length > 0, "the live reading must yield rows");

  const printed = out.split("\n").map((line) => line.trim().split(/\s+/));
  for (const row of parsed) {
    assert.ok(!/\s/.test(row.target), `a parsed target must be one path: ${JSON.stringify(row.target)}`);
    assert.ok(!/\s/.test(row.source), `a parsed source must be one path: ${JSON.stringify(row.source)}`);

    const line = printed.find((cols) => escapeFindmnt(row.target) === cols[1]);
    assert.ok(line, `every parsed target must round-trip to a printed column: ${JSON.stringify(row.target)}`);
    assert.equal(escapeFindmnt(row.source), line[0], "and so must its device");
    assert.equal(escapeFindmnt(row.fstype), line[2]);
  }
});

test("the live rig has no mountpoint with a space, so the fixture carries the one that matters", (t) => {
  // Not a check of the plugin: a note on why the fixture row exists. Where a rig
  // does mount something at a spaced path, the live round-trip above covers it.
  if (!FINDMNT.includes(STICK_PRINTED)) t.skip("the findmnt fixture carries no spaced row");
  assert.ok(FINDMNT.includes(STICK_PRINTED));
  assert.ok(!FINDMNT.includes(STICK), "the fixture keeps findmnt's spelling, not the config's");
});
