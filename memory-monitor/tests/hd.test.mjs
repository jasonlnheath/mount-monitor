// Hard drives: the watch list is configured, never discovered; five subvolume
// mounts of one partition are five rows and one alert; findmnt escapes and the
// reader undoes it.
import test from "node:test";
import assert from "node:assert/strict";
import { Memory, fixture, qtList, same } from "./load.mjs";

const SUBS = fixture("findmnt-subvolumes.txt");
const RIG = fixture("findmnt-rig.txt");

test("the findmnt argv is fixed and carries no configured mount path", () => {
  same(Memory.findmntArgs(), [
    "-rn",
    "-b",
    "--raw",
    "-o",
    "SOURCE,TARGET,FSTYPE,USED,AVAIL,USE%,OPTIONS,PARTUUID,UUID,LABEL,PARTLABEL",
  ]);
  // A user-set path like `/mnt/my stick` must never become an argument: the
  // watch list filters rows in JS.
  const argv = Memory.findmntArgs().join(" ");
  assert.equal(argv.includes("/mnt"), false);
  assert.equal(argv.includes("stick"), false);
});

test("--raw keeps an empty identity column in its own position", () => {
  const rows = Memory.parseRows(SUBS);
  const win = rows.find(row => row.TARGET === "/mnt/data");
  assert.equal(win.UUID, "326CF5A86CF5674F");
  assert.equal(win.LABEL, "", "the empty LABEL is an empty field, not a missing one");
  assert.equal(win.PARTLABEL, "Basic data partition", "and the column after it did not slide left");
});

test("a spaced mountpoint is one entry, one id, one key", () => {
  const candidates = Memory.hdCandidates(SUBS, ["/mnt/my stick"]);
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.equal(c.target, "/mnt/my stick", "the escape is undone, so it matches the mounts entry");
  assert.equal(c.label, "My Stick");
  assert.equal(c.partlabel, "Basic data partition");
  assert.equal(c.id, Memory.memId(c.key, "/mnt/my stick"));
  assert.equal(Memory.isMemId(c.id), true);
});

test("a configured target with a space round-trips through the watch list", () => {
  same(Memory.normalizeMounts(qtList(["/mnt/my stick", "/"])), ["/mnt/my stick", "/"]);
  const candidates = Memory.hdCandidates(SUBS, qtList(["/mnt/my stick"]));
  assert.equal(candidates.length, 1);
});

test("no device behind a mount means no ring", () => {
  const candidates = Memory.hdCandidates(SUBS, ["/run/user/1000", "/var/lib/docker/overlay2/a1/merged"]);
  same(candidates, []);
  const rows = Memory.parseRows(SUBS);
  assert.equal(rows.find(r => r.TARGET === "/run/user/1000") !== undefined, true, "the row is read");
  assert.equal(Memory.isRealDevice("tmpfs"), false);
  assert.equal(Memory.isRealDevice("overlay"), false);
  assert.equal(Memory.isRealDevice("proc"), false);
  assert.equal(Memory.isRealDevice("/dev/nvme1n1p2[/@]"), true);
});

test("a mount with no USE% is not a usage row", () => {
  const rows = Memory.parseRows(RIG);
  for (const row of rows) {
    assert.match(row["USE%"], /^[0-9]+%$/);
    assert.equal(row.TARGET.length > 0, true);
  }
  assert.equal(rows.find(r => r.TARGET === "/proc"), undefined);
  assert.equal(rows.find(r => r.TARGET === "/dev/pts"), undefined);
});

test("five btrfs subvolumes of one partition are five rows and one device", () => {
  const targets = ["/", "/home", "/srv/models", "/var/log", "/var/cache/pacman/pkg"];
  const candidates = Memory.hdCandidates(SUBS, targets);
  assert.equal(candidates.length, 5);
  const groups = Memory.groupHdByDevice(candidates);
  assert.equal(groups.length, 1, "one alert, not five");
  same(groups[0].targets, targets);
  assert.equal(groups[0].key, "partuuid:a02330f1-304d-459b-8274-e52ab1cf11ba");
  assert.equal(groups[0].device, "/dev/nvme1n1p2", "the [/subvol] suffix is stripped off the device");
  assert.equal(Memory.isMemId(groups[0].id), true);
});

test("the device group carries the fullest mount on it, because that is the row the alert is about", () => {
  const rows = Memory.parseRows(RIG);
  const candidates = [];
  for (const target of ["/", "/home", "/srv/models", "/var/log", "/var/cache/pacman/pkg", "/mnt/models", "/run/media/jason/OMARCHY"]) {
    const c = Memory.hdCandidate(rows.find(r => r.TARGET === target), [target]);
    if (c !== null) candidates.push(c);
  }
  const groups = Memory.groupHdByDevice(candidates);
  const daw = groups.find(g => g.key === "partuuid:724dba15-7bef-4968-8bc7-285f54e1f3ac");
  assert.equal(daw.pct, 86);
  assert.equal(daw.ro, true, "ntfs3 mounted ro is reported as read-only");
  assert.equal(daw.label, "DAW");
});

test("the device group carries the device's latch flag, so a held drive can present held at all", () => {
  const targets = ["/", "/home", "/srv/models", "/var/log", "/var/cache/pacman/pkg"];
  const candidates = Memory.hdCandidates(SUBS, targets);
  const key = "partuuid:a02330f1-304d-459b-8274-e52ab1cf11ba";
  assert.equal(Memory.groupHdByDevice(candidates, { [key]: true })[0].latched, true);
  assert.equal(Memory.groupHdByDevice(candidates, { [key]: false })[0].latched, false);
  assert.equal(Memory.groupHdByDevice(candidates)[0].latched, false, "no latch map is the default, not an invented held");
  assert.equal(Memory.groupHdByDevice(candidates, "not a map")[0].latched, false);
});

test("the device group carries the singular target the alert is about", () => {
  const rows = Memory.parseRows(RIG);
  const candidates = [];
  for (const target of ["/", "/home", "/srv/models", "/var/log", "/var/cache/pacman/pkg", "/mnt/models", "/run/media/jason/OMARCHY"]) {
    const c = Memory.hdCandidate(rows.find(r => r.TARGET === target), [target]);
    if (c !== null) candidates.push(c);
  }
  const groups = Memory.groupHdByDevice(candidates);
  const daw = groups.find(g => g.key === "partuuid:724dba15-7bef-4968-8bc7-285f54e1f3ac");
  assert.equal(daw.target, "/mnt/models", "the alert names the mount, not just the device");
  const usb = groups.find(g => g.key === "partuuid:72e5618c-cab5-4e49-95db-bf73eebeb698");
  assert.equal(usb.target, "/run/media/jason/OMARCHY");
  assert.equal(usb.pct, 93);

  const subs = Memory.hdCandidates(SUBS, ["/", "/home", "/srv/models", "/var/log", "/var/cache/pacman/pkg"]);
  const one = Memory.groupHdByDevice(subs)[0];
  assert.equal(one.targets.indexOf(one.target) >= 0, true, "the singular target is one of the group's mounts");
});

test("a watched drive Mount Monitor also watches is suppressed through the group's own target", () => {
  const candidates = Memory.hdCandidates(SUBS, ["/mnt/models"]);
  const group = Memory.groupHdByDevice(candidates)[0];
  assert.equal(group.target, "/mnt/models");
  assert.equal(group.pct, 90);
  assert.equal(Memory.hdAlertSuppressed(group.target, qtList(["/", "/mnt/models"])), true);
  assert.equal(Memory.hdAlertSuppressed(group.target, qtList(["/"])), false);
  assert.equal(Memory.hdAlertSuppressed(undefined, qtList(["/"])), false, "a group with no target is never suppressed");
});

test("the reading a prompt carries is the row of the event being fired", () => {
  const rows = Memory.hdCandidates(SUBS, ["/", "/home", "/mnt/models"]);
  const root = rows.find(row => row.key === "partuuid:a02330f1-304d-459b-8274-e52ab1cf11ba");
  const stick = rows.find(row => row.target === "/mnt/models");

  assert.equal(Memory.hdRowFor(rows, root.key), root, "the alert's key picks its own row");
  assert.equal(Memory.hdRowFor(rows, stick.key), stick);
  assert.equal(Memory.hdRowFor(rows, "partuuid:gone"), rows[0], "an unknown key falls back to the first row, never to a guessed device");
  assert.equal(Memory.hdRowFor([], "partuuid:x"), null, "no rows is no reading at all");
  assert.equal(Memory.hdRowFor(null, "partuuid:x"), null);
});

test("partition identity is PARTUUID, else UUID, else the device path", () => {
  assert.equal(
    Memory.hdDeviceKey({ PARTUUID: "abc", UUID: "def", SOURCE: "/dev/sda1" }),
    "partuuid:abc",
  );
  assert.equal(Memory.hdDeviceKey({ PARTUUID: "", UUID: "def", SOURCE: "/dev/sda1" }), "uuid:def");
  assert.equal(Memory.hdDeviceKey({ PARTUUID: "", UUID: "", SOURCE: "/dev/sda1" }), "device:/dev/sda1");
  assert.equal(Memory.hdDeviceKey({ PARTUUID: "-", UUID: "-", SOURCE: "/dev/sda1" }), "device:/dev/sda1");
  assert.equal(Memory.hdDeviceKey({ PARTUUID: "", UUID: "", SOURCE: "tmpfs" }), "");
});

test("the watch list is Mount Monitor's mounts when it has them, and never a discovery", () => {
  same(Memory.hdWatchList(qtList(["/data", "/home"]), qtList(["/ignored"])), ["/data", "/home"]);
  same(Memory.hdWatchList(null, qtList(["/own"])), ["/own"]);
  same(Memory.hdWatchList(qtList([]), qtList(["/own"])), [], "an explicit empty list means no rings, not inherit");
  same(Memory.hdWatchList(null, null), ["/"], "no setting at all falls back to root only");
  same(Memory.hdWatchList("not a list", qtList(["/own"])), ["/own"], "a value that is not a list at all");
});

test("a drive Mount Monitor already toasts is not toasted twice", () => {
  assert.equal(Memory.hdAlertSuppressed("/data", qtList(["/data", "/home"])), true);
  assert.equal(Memory.hdAlertSuppressed("/other", qtList(["/data", "/home"])), false);
  assert.equal(Memory.hdAlertSuppressed("/data", null), false, "no Mount Monitor in this bar: Memory Monitor toasts");
  assert.equal(Memory.hdAlertSuppressed("/data", qtList([])), false);
});

test("findmnt -b sizes are bytes, and the reader keeps them exact", () => {
  const candidates = Memory.hdCandidates(SUBS, ["/mnt/models"]);
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.equal(c.usedKb, Math.round(96636764160 / 1024));
  assert.equal(c.availKb, Math.round(10737418240 / 1024));
  assert.equal(c.sizeKb, c.usedKb + c.availKb);
  assert.equal(c.pct, 90, "the band reads findmnt's own USE%, not a recomputed ratio");
  assert.equal(c.ro, true);
});

test("a read-only mount gets a move-off prompt, never a prune prompt", () => {
  const alert = { type: "hd", id: Memory.memId("partuuid:x", "/mnt/models"), target: "/mnt/models", device: "/dev/sdc1", ro: true, pct: 90, band: 1 };
  const prompt = Memory.agentPrompt(alert, null, null, "/log");
  assert.equal(prompt.includes("prune"), false, "nothing can be pruned on a read-only mount");
  assert.equal(prompt.includes("compressed"), false);
  assert.match(prompt, /read-only: suggest only what can be moved off it/);
});

test("the toast copy stays the spec's copy for a read-only drive too", () => {
  const alert = { type: "hd", target: "/mnt/models", device: "/dev/sdc1", ro: true, pct: 90, band: 2 };
  assert.equal(Memory.bodyFor(alert), [
    "WARNING: RED ALERT",
    "Device (Hard drive) has reached 90% usage.",
    "Click to open an agent to actively monitor/guard against OOM, otherwise ignore.",
  ].join("\n"));
});

test("a writable drive keeps the prune wording", () => {
  const alert = { type: "hd", target: "/data", device: "/dev/sda1", ro: false, pct: 91, band: 2 };
  assert.equal(Memory.agentPrompt(alert).includes("prune"), true);
});

test("a mount target deduplicates on target, not device", () => {
  same(Memory.normalizeMounts(qtList(["/", "/home", "/"])), ["/", "/home"]);
});

test("the live findmnt reading produces the same device keys as the fixture", async () => {
  const { execFileSync } = await import("node:child_process");
  let text;
  try {
    text = execFileSync("findmnt", Memory.findmntArgs(), { encoding: "utf8" });
  } catch (err) {
    if (err.code === "ENOENT") return; // no findmnt on this host: the live check skips
    throw err;
  }
  const rows = Memory.parseRows(text);
  assert.ok(rows.length > 0, "findmnt produced rows");
  const root = rows.find(r => r.TARGET === "/");
  if (root === undefined) return;
  const key = Memory.hdDeviceKey(root);
  assert.match(key, /^partuuid:/, "this rig's root is keyed by PARTUUID");
  const home = rows.find(r => r.TARGET === "/home");
  if (home !== undefined) {
    assert.equal(Memory.hdDeviceKey(home), key, "/ and /home are one device on a btrfs subvolume install");
  }
  // A live round-trip against findmnt's own escaping rule.
  for (const row of rows) {
    assert.equal(row.TARGET.includes("\\"), false, "no escape survives into a value");
    assert.equal(row.TARGET.includes("\x20"), false);
  }
});
