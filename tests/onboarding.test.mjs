// Partition onboarding tests.
//
// Run: bash tests/run.sh   (or: node --test tests/)
//
// The guard for the onboarding feature: what counts as a partition worth
// offering, the once-only memory that stops the plugin nagging about the same
// partition twice, and the wiring that carries a clicked notification into the
// right skill. All of it lives in mounts.js as pure functions so it is testable
// without a running shell; MountMonitor.qml only decides when to call it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);

// mounts.js is a Qt-importable JavaScript file (plain top-level functions), so
// it is loaded into a VM context instead of imported as an ES module. JSON and
// Object are in the context because the onboarding state is JSON.
function loadMounts() {
  const src = readFileSync(path.join(repo, "mounts.js"), "utf8");
  const ctx = { Math, Number, parseInt, isFinite, String, Array, RegExp, JSON, Object, console };
  vm.runInNewContext(src, ctx);
  return ctx;
}

const Mounts = loadMounts();

// Fixture lines starting with '#' document the fixture and are not lsblk rows.
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
// The btrfs system partition: monitored at /, reported by lsblk at /var/log.
const SYSTEM_PART = "/dev/nvme1n1p5";
const SYSTEM_KEY = "72e5618c-cab5-4e49-95db-bf73eebeb698";
const USB_KEY = "4B4D-1A2B";
const USB_PART_KEY = "9a7b6c5d-1111-2222-3333-444455556666";
// The captain's bar: root, the btrfs data drive, and the models partition.
const WANTED = ["/", SRV, MODELS];

// A state file as the widget would have written it after one onboarding pass on
// this fixture: the system partition accepted, the USB stick declined, the EFI
// partition offered and never answered.
const SCANNED_STATE = JSON.stringify({
  version: 1,
  onboarded: true,
  updatedAt: "2026-10-25T20:00:00Z",
  decisions: {
    [SYSTEM_KEY]: "monitored",
    [USB_KEY]: "declined",
    "e248549d-fa4f-4730-a156-5e5892fd4014": "offered",
  },
  candidates: [],
});

function targets(list) {
  // Array.from rather than list.map: the list is built inside mounts.js's VM
  // context, and a cross-realm array is not deep-equal to a local one.
  return Array.from(list, (c) => c.target);
}

function keys(list) {
  return Array.from(list, (c) => c.key);
}

function find(list, target) {
  return Array.from(list).find((c) => c.target === target);
}

// The ring list the widget already has, straight off the findmnt fixture.
function rings(wanted) {
  return Array.from(Mounts.selectMounts(FINDMNT, wanted, -1));
}

// --- what the scan asks for -------------------------------------------------

test("the scan is a lsblk run that asks for the columns the filter needs", () => {
  const args = Mounts.lsblkArgs();
  const joined = args.join(" ");
  assert.ok(!/^lsblk$/.test(joined), "lsblkArgs returns arguments, not the command");
  for (const column of ["PATH", "TYPE", "FSTYPE", "MOUNTPOINT", "SIZE", "PARTUUID", "RM"])
    assert.ok(joined.includes(column), `lsblk args must request ${column}: ${joined}`);
  assert.ok(!joined.includes("-t "), `lsblk args must not filter by filesystem type: ${joined}`);
});

test("the scan uses pairs output so a mountpoint or label with a space survives", () => {
  // -n cannot be combined with -P, and whitespace-separated columns misalign on
  // the empty FSTYPE/MOUNTPOINT columns lsblk prints for unformatted slices.
  const joined = Mounts.lsblkArgs().join(" ");
  assert.ok(/(?:^|\s)-P(?:\s|$)/.test(joined) || joined.includes("--pairs"),
    `lsblk args must use pairs output: ${joined}`);
  assert.ok(!/(?:^|\s)-n(?:\s|$)/.test(joined) && !joined.includes("--noheadings"),
    `lsblk args must not combine pairs with raw output: ${joined}`);

  const rows = Mounts.parseLsblkPairs(LSBLK);
  const usb = rows.find((r) => r.path === "/dev/sdb");
  assert.equal(usb.mountpoint, USB, "a mountpoint containing a space must survive parsing");
  const label = rows.find((r) => r.path === "/dev/nvme1n1p1");
  assert.equal(label.partlabel, "Microsoft reserved partition", "a label with a space must survive");
  assert.equal(label.fstype, "", "an empty column must stay empty, not shift the next one");
});

// --- which partitions are worth offering ------------------------------------

test("the scan offers the mounted disk filesystems and nothing else", () => {
  const list = Mounts.candidatePartitions(LSBLK);
  assert.deepEqual(targets(list).sort(), [EFI, MODELS, SRV, USB, USB_PART, "/var/log"].sort());
});

test("pseudo, virtual, and non-disk rows are never candidates", () => {
  const list = Mounts.candidatePartitions(LSBLK);
  const paths = Array.from(list, (c) => c.path);
  // swap on zram, the optical drive, snap's squashfs images.
  for (const never of ["/dev/zram0", "/dev/sr0", "/dev/loop0"])
    assert.ok(!paths.includes(never), `${never} must never be offered`);
  // A partition with no filesystem (Microsoft reserved) and a parent disk that
  // carries no filesystem of its own.
  for (const never of ["/dev/nvme1n1p1", "/dev/nvme1n1", "/dev/nvme0n1"])
    assert.ok(!paths.includes(never), `${never} must never be offered`);
  // tmpfs, proc, sysfs, cgroup2, overlay and nsfs are not block devices at all:
  // the scan never sees them, so no deny-list is needed to keep them out.
  assert.ok(!targets(list).some((t) => t.startsWith("/tmp") || t.startsWith("/proc") || t.startsWith("/sys")));
});

test("an unmounted partition is not offered, because it cannot have a ring", () => {
  const list = Mounts.candidatePartitions(LSBLK);
  const paths = Array.from(list, (c) => c.path);
  // The Windows slices on the second drive and the unmounted EFI slice.
  for (const never of ["/dev/nvme0n1p1", "/dev/nvme0n1p3", "/dev/nvme0n1p4", "/dev/nvme1n1p3"])
    assert.ok(!paths.includes(never), `${never} is not mounted and must not be offered`);
});

test("one partition is one candidate even when it is mounted several times", () => {
  const list = Mounts.candidatePartitions(LSBLK);
  const system = Array.from(list).filter((c) => c.path === SYSTEM_PART);
  assert.equal(system.length, 1, "the btrfs system partition must appear exactly once");
  assert.equal(system[0].key, SYSTEM_KEY, "a candidate is identified by the partition, not the mountpoint");
});

test("removable drives are candidates and say so", () => {
  const list = Mounts.candidatePartitions(LSBLK);
  const stick = find(list, USB);
  const part = find(list, USB_PART);
  assert.ok(stick, "a whole USB stick formatted without a partition table is a candidate");
  assert.equal(stick.removable, true);
  assert.equal(stick.size, "1.8T");
  assert.equal(stick.fstype, "exfat");
  assert.equal(stick.label, "Backup Drive");
  assert.equal(part.removable, true);
  const fixed = find(list, MODELS);
  assert.equal(fixed.removable, false, "a fixed partition must not be reported as removable");
});

test("a candidate is identified by partition identity, not by device name", () => {
  // USB device names move between plugs (/dev/sdb becomes /dev/sdc); the
  // partition identity does not.
  const renamed = LSBLK.replace(/NAME="sdb" PATH="\/dev\/sdb"/, 'NAME="sdd" PATH="/dev/sdd"');
  const before = find(Mounts.candidatePartitions(LSBLK), USB);
  const after = find(Mounts.candidatePartitions(renamed), USB);
  assert.equal(before.key, USB_KEY);
  assert.equal(after.key, before.key, "the same partition must keep the same identity when its device name changes");
  assert.equal(after.path, "/dev/sdd");

  // A partition with no PARTUUID falls back to its filesystem UUID.
  assert.equal(before.key, "4B4D-1A2B");
});

test("an encrypted install offers the mounted decrypted volume, never the LUKS container", () => {
  const list = Mounts.candidatePartitions(fixture("lsblk-luks.txt"));
  // The crypt child is the candidate, exactly once; the container partition
  // carries no mountpoint and must never be offered.
  assert.deepEqual(targets(list), ["/"]);
  const child = find(list, "/");
  assert.equal(child.path, "/dev/mapper/luks-d1a2b3c4-0000-1111-2222-333344445555");
  assert.equal(child.fstype, "btrfs");
  assert.equal(child.removable, false);
  assert.ok(!Array.from(list, (c) => c.path).includes("/dev/nvme0n1p2"),
    "the crypto_LUKS container must never be offered");
});

test("a decrypted volume's identity is the filesystem UUID, stable across reboots", () => {
  const child = find(Mounts.candidatePartitions(fixture("lsblk-luks.txt")), "/");
  // A mapper device has no PARTUUID, so the identity falls to the filesystem's
  // UUID - not to the mapper name, which lsblk derives from the container UUID.
  assert.equal(child.key, "5999cbd8-c212-4f4c-835b-e7ae23760525");
});

test("a monitored LUKS root suppresses its candidate through the device behind the ring", () => {
  const findmnt =
    "/dev/mapper/luks-d1a2b3c4-0000-1111-2222-333344445555[/@] / btrfs 140.4G 105.2G 57% rw,subvol=/@\n";
  const watched = Mounts.monitoredDevices(Array.from(Mounts.selectMounts(findmnt, ["/"], -1)));
  const offered = Mounts.newCandidates(Mounts.candidatePartitions(fixture("lsblk-luks.txt")),
    Mounts.parseState(""), ["/"], watched);
  assert.deepEqual(Array.from(offered), [],
    "the crypt candidate sits behind the / ring and must not be offered");
});

// --- once-only memory -------------------------------------------------------

test("the state file lives under the XDG state directory", () => {
  assert.equal(Mounts.stateDir("/home/jason"), "/home/jason/.local/state/mount-monitor");
  assert.equal(Mounts.statePath("/home/jason"), "/home/jason/.local/state/mount-monitor/onboarding.json");
});

test("a missing or broken state file reads as a fresh install, not as an error", () => {
  for (const raw of ["", undefined, null, "not json at all", "{", "[]"]) {
    const state = Mounts.parseState(raw);
    assert.equal(state.onboarded, false, `raw ${JSON.stringify(raw)} must read as first run`);
    assert.deepEqual(Object.keys(state.decisions), []);
    assert.deepEqual(Array.from(state.candidates), []);
  }
  const state = Mounts.parseState("");
  assert.equal(state.version, 1);
});

test("a state file round-trips the decisions that stop the nagging", () => {
  const state = Mounts.parseState(SCANNED_STATE);
  assert.equal(state.onboarded, true);
  assert.equal(state.decisions[SYSTEM_KEY], "monitored");
  assert.equal(state.decisions[USB_KEY], "declined");
  const text = Mounts.serializeState(state, "2026-10-25T20:10:00Z");
  const again = Mounts.parseState(text);
  assert.equal(again.onboarded, true);
  assert.equal(again.decisions[USB_KEY], "declined");
  assert.equal(again.decisions[SYSTEM_KEY], "monitored");
  assert.equal(again.updatedAt, "2026-10-25T20:10:00Z");
});

test("first run offers every partition that is not already monitored", () => {
  const candidates = Mounts.candidatePartitions(LSBLK);
  const fresh = Mounts.parseState("");
  const offered = Mounts.newCandidates(candidates, fresh, WANTED, Mounts.monitoredDevices(rings(WANTED)));
  // / is monitored from the btrfs system partition, so that partition is not a
  // candidate even though lsblk reports it mounted at /var/log.
  assert.deepEqual(targets(offered).sort(), [EFI, USB, USB_PART].sort());
  assert.ok(!targets(offered).includes("/var/log"),
    "offering the subvolume of an already-monitored device would draw a second identical ring");
});

test("already-monitored partitions are never offered again", () => {
  const candidates = Mounts.candidatePartitions(LSBLK);
  const state = Mounts.parseState(SCANNED_STATE);
  const offered = Mounts.newCandidates(candidates, state, WANTED, Mounts.monitoredDevices(rings(WANTED)));
  assert.deepEqual(targets(offered), [USB_PART], "only the never-offered partition stays new");
});

test("an offered partition never nags again, and neither does a declined one", () => {
  const candidates = Mounts.candidatePartitions(LSBLK);
  const state = Mounts.parseState("");
  const first = Mounts.newCandidates(candidates, state, WANTED, []);
  assert.ok(first.length > 0);

  const afterOffer = Mounts.markOffered(state, first, "offered");
  const second = Mounts.newCandidates(candidates, afterOffer, WANTED, []);
  assert.deepEqual(Array.from(second), [], "the same partitions must not be offered twice");

  const declined = Mounts.markOffered(afterOffer, [find(candidates, USB)], "declined");
  const third = Mounts.newCandidates(candidates, declined, WANTED, []);
  assert.deepEqual(Array.from(third), [], "a declined partition must stay declined");
  assert.equal(declined.decisions[USB_KEY], "declined", "a decline overwrites the offer it replaced");
  assert.equal(state.decisions[USB_KEY], undefined, "marking a decision must not mutate the state it was given");
});

test("a replugged drive at a new mountpoint is still the same partition", () => {
  const state = Mounts.parseState(SCANNED_STATE); // USB_KEY declined
  // udisks2 appends a number when two drives share a label.
  const replugged = LSBLK.replace(/\/run\/media\/jason\/Backup Drive/g, "/run/media/jason/Backup Drive1")
    .replace(/NAME="sdb" PATH="\/dev\/sdb"/, 'NAME="sdd" PATH="/dev/sdd"');
  const candidates = Mounts.candidatePartitions(replugged);
  const offered = Mounts.newCandidates(candidates, state, [], []);
  assert.ok(!keys(offered).includes(USB_KEY),
    "the declined stick came back under a new mountpoint and must not be re-offered");
});

test("a brand new partition is new even though everything else is known", () => {
  const state = Mounts.parseState(SCANNED_STATE);
  const withNew = `${LSBLK}\nNAME="sde1" PATH="/dev/sde1" TYPE="part" FSTYPE="btrfs" MOUNTPOINT="/mnt/backup" SIZE="8.0T" LABEL="Backup" PARTLABEL="Backup" PARTUUID="11111111-2222-3333-4444-555555555555" UUID="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" RM="1"\n`;
  const candidates = Mounts.candidatePartitions(withNew);
  const offered = Mounts.newCandidates(candidates, state, WANTED, Mounts.monitoredDevices(rings(WANTED)));
  assert.deepEqual(Array.from(offered, (c) => c.target), [USB_PART, "/mnt/backup"]);
});

test("a queued notice is dropped when its partition is already gone", () => {
  const candidates = Mounts.candidatePartitions(LSBLK);
  assert.equal(Mounts.candidateAlive(candidates, USB_PART_KEY), true);
  assert.equal(Mounts.candidateAlive(candidates, "no-such-partition"), false);
  const ejected = Array.from(candidates).filter((c) => c.path !== "/dev/sdc1");
  assert.equal(Mounts.candidateAlive(ejected, USB_PART_KEY), false,
    "an ejected drive must not still fire its notification");
});

// --- the two new notifications ----------------------------------------------

test("the first-run notification counts the partitions and asks the user to pick", () => {
  const candidates = Array.from(Mounts.candidatePartitions(LSBLK));
  const body = Mounts.onboardingBody(candidates);
  assert.ok(body.startsWith(String(candidates.length)), `body must lead with the count: ${body}`);
  assert.ok(/partition/.test(body), body);
  assert.ok(/click/i.test(body), body);
  assert.equal(Mounts.onboardingAction(), "Choose partitions to monitor");

  const one = Mounts.onboardingBody([candidates[0]]);
  assert.ok(one.startsWith("1"), one);
  assert.ok(!one.includes("1 disk partitions"), `one partition must read as singular: ${one}`);
});

test("the first-run prompt hands the list to the partition-onboarding skill", () => {
  const candidates = Array.from(Mounts.candidatePartitions(LSBLK));
  const prompt = Mounts.onboardingPrompt(candidates);
  assert.ok(prompt.includes("partition-onboarding"), prompt);
  assert.ok(prompt.includes(MODELS) && prompt.includes(USB), prompt);
  assert.ok(/ask/i.test(prompt) && /monitor/i.test(prompt), prompt);
  assert.ok(!/disk-prune/.test(prompt), "onboarding must not ask for a prune scan");
});

test("a new drive notifies once with the captain's exact copy", () => {
  const stick = find(Mounts.candidatePartitions(LSBLK), USB_PART);
  const fixed = find(Mounts.candidatePartitions(LSBLK), EFI);

  // Captain's final copy: one dismissable notice per new drive, this exact text,
  // removable or not. What to do about it is decided after the click, not by the popup.
  const EXACT = "Detected new drive. Click now to set up disk monitoring.";
  assert.equal(Mounts.newPartitionBody(stick), EXACT);
  assert.equal(Mounts.newPartitionBody(fixed), EXACT);
  assert.ok(!/removable/i.test(Mounts.newPartitionBody(stick)),
    `the notice must not pre-question removable vs permanent: ${Mounts.newPartitionBody(stick)}`);
  assert.equal(Mounts.newPartitionAction(), "Set up disk monitoring");

  // The click still hands the agent every specific the popup left out.
  const prompt = Mounts.newPartitionPrompt(stick);
  assert.ok(prompt.includes("partition-onboarding"), prompt);
  assert.ok(prompt.includes(USB_PART), prompt);
  assert.ok(prompt.includes("/dev/sdc1"), prompt);
  assert.ok(/removable/i.test(prompt), prompt);
  assert.ok(!/disk-prune/.test(prompt), prompt);
});

test("a clicked notification dispatches to the prompt for its own kind", () => {
  const stick = find(Mounts.candidatePartitions(LSBLK), USB_PART);
  const models = rings(WANTED).find((m) => m.target === MODELS);

  const band = Mounts.promptFor({ kind: "band", target: MODELS, pct: models.pct, avail: models.avail, readonly: models.readonly });
  assert.equal(band, Mounts.agentPrompt(models), "a band alert keeps the cleanup prompt it has always had");

  const candidates = Array.from(Mounts.candidatePartitions(LSBLK));
  const onboarding = Mounts.promptFor({ kind: "onboarding", candidates });
  assert.equal(onboarding, Mounts.onboardingPrompt(candidates));
  assert.ok(onboarding.includes("partition-onboarding"), onboarding);

  const fresh = Mounts.promptFor({ kind: "new-partition", candidate: stick });
  assert.equal(fresh, Mounts.newPartitionPrompt(stick));

  // A band alert written before kinds existed must still get the cleanup prompt.
  assert.equal(Mounts.promptFor({ target: "/", pct: 57, avail: "105.2G", readonly: false }), Mounts.agentPrompt(rings(WANTED)[0]));
});

// --- the skills and their wiring --------------------------------------------

test("a popup for a partition is titled, worded, and timed as a question, not an alarm", () => {
  const stick = find(Mounts.candidatePartitions(LSBLK), USB_PART);
  assert.equal(Mounts.titleFor({ kind: "onboarding", candidates: [stick] }), "Mount Monitor — partitions found");
  assert.equal(Mounts.titleFor({ kind: "new-partition", candidate: stick }), "Mount Monitor — new partition");
  assert.equal(Mounts.titleFor({ kind: "band", band: 3 }), "Mount Monitor — CRITICAL");
  assert.equal(Mounts.titleFor({ kind: "band", band: 1 }), "Mount Monitor — warning");

  assert.equal(Mounts.actionFor({ kind: "onboarding", candidates: [stick] }), "Choose partitions to monitor");
  assert.equal(Mounts.actionFor({ kind: "new-partition", candidate: stick }), "Set up disk monitoring");
  assert.equal(Mounts.bodyFor({ kind: "onboarding", candidates: [stick] }), Mounts.onboardingBody([stick]));
  assert.equal(Mounts.bodyFor({ kind: "new-partition", candidate: stick }), Mounts.newPartitionBody(stick));

  // A full drive stays critical and never expires; an ask lingers to be clicked.
  assert.equal(Mounts.urgencyFor({ kind: "band", band: 3 }), "critical");
  assert.equal(Mounts.urgencyFor({ kind: "onboarding", candidates: [] }), "normal");
  assert.equal(Mounts.timeoutFor({ kind: "band", band: 3 }), "0");
  assert.equal(Mounts.timeoutFor({ kind: "band", band: 1 }), "6000");
  assert.equal(Mounts.timeoutFor({ kind: "onboarding", candidates: [] }), "12000");
  assert.equal(Mounts.timeoutFor({ kind: "new-partition", candidate: stick }), "12000");
});

// The frontmatter block is what the agent's skill loader consumes, and the
// state path inside a skill is the handshake with the widget: the skills must
// name the exact file Mounts.statePath writes or their decisions never land.
function readSkill(skill) {
  const text = readFileSync(path.join(repo, "skills", skill, "SKILL.md"), "utf8");
  const block = text.match(/^---\n([\s\S]*?)\n---/);
  const frontmatter = {};
  if (block)
    for (const line of block[1].split("\n")) {
      const sep = line.indexOf(":");
      if (sep > 0) frontmatter[line.slice(0, sep).trim()] = line.slice(sep + 1).trim();
    }
  return { text, frontmatter };
}

test("both onboarding skills ship loader-valid frontmatter and the widget's state path", () => {
  for (const skill of ["partition-onboarding", "partition-remove"]) {
    const { text, frontmatter } = readSkill(skill);
    assert.equal(frontmatter.name, skill, `${skill}'s frontmatter name must match its directory`);
    assert.ok(frontmatter.description && frontmatter.description.trim() !== "",
      `${skill} must carry a frontmatter description`);
    assert.ok(text.includes(Mounts.statePath("~")),
      `${skill} must read/write ${Mounts.statePath("~")}, the file the widget writes`);
  }
});

test("install.sh installs every skill the repo ships, replacing what was there", () => {
  // The real installer, run for real: the repo staged at the omarchy plugin
  // path install.sh insists on, with a throwaway HOME to install into.
  const stage = mkdtempSync(path.join(tmpdir(), "mount-monitor-install-"));
  try {
    const pluginDir = path.join(stage, "omarchy", "plugins", "io.github.jasonlnheath.mount-monitor");
    const home = path.join(stage, "home");
    cpSync(repo, pluginDir, { recursive: true, filter: (src) => path.basename(src) !== ".git" });

    // A leftover from an older install proves skills are replaced, not merged.
    const skillsDir = path.join(home, ".agents", "skills");
    mkdirSync(path.join(skillsDir, "disk-prune"), { recursive: true });
    writeFileSync(path.join(skillsDir, "disk-prune", "stale-from-old-install.txt"), "old");

    execFileSync("bash", [path.join(pluginDir, "install.sh")], {
      env: { ...process.env, HOME: home },
      encoding: "utf8",
    });

    const shipped = readdirSync(path.join(repo, "skills")).sort();
    assert.deepEqual(readdirSync(skillsDir).sort(), shipped,
      "exactly the shipped skills are installed, none skipped, none invented");
    for (const skill of shipped)
      assert.ok(existsSync(path.join(skillsDir, skill, "SKILL.md")), `skills/${skill}/SKILL.md is installed`);
    assert.ok(!existsSync(path.join(skillsDir, "disk-prune", "stale-from-old-install.txt")),
      "an installed skill directory is replaced wholesale, not merged");
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
});

// --- live check against this machine's real disk table ----------------------

test("the real lsblk run reports only mounted disk filesystems on this machine", (t) => {
  let out;
  try {
    out = execFileSync("lsblk", Mounts.lsblkArgs(), { encoding: "utf8" });
  } catch {
    t.skip("lsblk is not available here");
    return;
  }
  const list = Array.from(Mounts.candidatePartitions(out));
  if (list.length === 0) {
    t.skip("no mounted disk filesystems on this machine");
    return;
  }
  for (const c of list) {
    assert.ok(c.path.startsWith("/dev/"), `${c.path} is not a device`);
    assert.ok(c.target.startsWith("/"), `${c.target} is not a mountpoint`);
    assert.ok(c.fstype !== "swap", "swap must never be a candidate");
    assert.ok(c.key, `${c.path} has no partition identity`);
  }
  // The models partition is a candidate on this rig; elsewhere it is simply
  // not mounted and the check does not apply.
  let modelsHere = false;
  try {
    modelsHere = execFileSync("findmnt", ["-rn", "-o", "TARGET", MODELS], { encoding: "utf8" }).trim() !== "";
  } catch {
    modelsHere = false;
  }
  if (!modelsHere) {
    t.skip(`${MODELS} is not mounted here`);
    return;
  }
  assert.ok(targets(list).includes(MODELS),
    `${MODELS} is mounted here and must be a candidate: ${targets(list).join(", ")}`);
});
