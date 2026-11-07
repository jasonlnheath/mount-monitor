// Thresholds are ceilings the user sets, not presets the plugin hands out.
// Amber and red ship as defaults; critical ships UNSET, and until the user sets
// it there is no critical band and no critical alert can fire.
import test from "node:test";
import assert from "node:assert/strict";
import { Memory, qtList, same } from "./load.mjs";

test("amber and red ship as defaults, critical ships unset", () => {
  const t = Memory.normalizeThresholds(undefined);
  for (const kind of ["hd", "vram", "ram"]) {
    assert.equal(t[kind].amber, 80, `${kind} amber default`);
    assert.equal(t[kind].red, 90, `${kind} red default`);
    assert.equal(t[kind].critical, null, `${kind} critical ships unset`);
    assert.equal(t[kind].criticalSetBy, null);
  }
});

test("a default is recorded as a default, a typed value as the user's", () => {
  const t = Memory.normalizeThresholds({ ram: { amber: 70, critical: 97 } });
  assert.equal(t.ram.amber, 70);
  assert.equal(t.ram.amberSetBy, "user");
  assert.equal(t.ram.red, 90, "untouched red keeps the documented default");
  assert.equal(t.ram.redSetBy, null, "and is labelled as a default, not as his");
  assert.equal(t.ram.critical, 97);
  assert.equal(t.ram.criticalSetBy, "user");
});

test("no critical band exists until the user sets one", () => {
  const unset = Memory.normalizeThresholds(undefined);
  assert.equal(Memory.bandForPct(99.9, unset.ram), 2, "99.9% is still red with no ceiling set");
  assert.equal(Memory.criticalIsSet({ thresholds: unset }, "ram"), false);

  const set = Memory.normalizeThresholds({ ram: { critical: 98 } });
  assert.equal(Memory.bandForPct(98, set.ram), 3);
  assert.equal(Memory.criticalIsSet({ thresholds: set }, "ram"), true);
});

test("a critical at or below red is a rejected edit, never a silent reordering", () => {
  const bad = Memory.validateThresholds({ amber: 80, red: 90, critical: 85 });
  assert.equal(bad.ok, false);
  assert.match(bad.errors.join("\n"), /critical must sit above red/);

  const good = Memory.validateThresholds({ amber: 80, red: 90, critical: 97 });
  assert.equal(good.ok, true);
  same(good.thresholds, { amber: 80, red: 90, critical: 97 });
});

test("an unset critical validates; a garbage one does not", () => {
  assert.equal(Memory.validateThresholds({ amber: 80, red: 90, critical: null }).ok, true);
  assert.equal(Memory.validateThresholds({ amber: 80, red: 90, critical: 0 }).ok, false);
  assert.equal(Memory.validateThresholds({ amber: 80, red: 90, critical: 100 }).ok, false);
  assert.equal(Memory.validateThresholds({ amber: 95, red: 90 }).ok, false, "red must sit above amber");
});

test("setCeiling writes only the field the user touched", () => {
  const start = { thresholds: Memory.normalizeThresholds(undefined) };
  const after = Memory.setCeiling(start, "vram", "critical", 96);
  assert.equal(after.ok, true);
  assert.equal(after.thresholds.vram.critical, 96);
  assert.equal(after.thresholds.vram.criticalSetBy, "user");
  assert.equal(after.thresholds.vram.amber, 80);
  assert.equal(after.thresholds.vram.amberSetBy, null);
  assert.equal(after.thresholds.ram.critical, null, "the other types are untouched");
});

test("a rejected ceiling leaves the settings alone and reports the error", () => {
  const start = { thresholds: Memory.normalizeThresholds({ ram: { critical: 97 } }) };
  const after = Memory.setCeiling(start, "ram", "critical", 85);
  assert.equal(after.ok, false);
  assert.equal(after.thresholds, null);
  assert.equal(start.thresholds.ram.critical, 97, "the old ceiling is still there");
});

test("a ceiling the user set is never relabelled as a default", () => {
  const set = Memory.setCeiling({ thresholds: Memory.normalizeThresholds(undefined) }, "ram", "red", 88);
  assert.equal(set.ok, true);
  assert.equal(set.thresholds.ram.redSetBy, "user");
  assert.equal(Memory.ceilingText("ram", set).includes("(you set it)"), true);
  assert.equal(Memory.ceilingText("ram", set).includes("amber 80% (default)"), true);
});

test("the unset critical reads out loud in the detail window", () => {
  const text = Memory.ceilingText("ram", { thresholds: Memory.normalizeThresholds(undefined) });
  assert.match(text, /critical: critical not set - you have no ceiling/);
});

test("every setting is read through a normalize* helper, never a bare array check", () => {
  // QuickShell hands a setting() value over as a Qt list, not a JS Array.
  const mounts = Memory.normalizeMounts(qtList(["/", "/srv/models", "/home"]));
  same(mounts, ["/", "/srv/models", "/home"]);

  const argv = Memory.normalizeAgentCommand(qtList(["omarchy", "agent", "prompt"]));
  same(argv, ["omarchy", "agent", "prompt"]);

  assert.equal(Memory.normalizeBool(qtList([]), null), null, "a list is not a boolean; the fallback stands");
  assert.equal(Memory.normalizeNumber("75", 80), 75);
});

test("a value that is not a list at all falls back to the documented default", () => {
  same(Memory.normalizeMounts("garbage"), ["/"]);
  same(Memory.normalizeMounts(undefined), ["/"]);
  assert.equal(Memory.normalizeAgentCommand("omarchy agent prompt"), null);
  assert.equal(Memory.normalizeAgentCommand([]), null);
});

test("an explicitly empty mounts list means no HD rows, not garbage", () => {
  same(Memory.normalizeMounts([]), []);
  same(Memory.normalizeMounts(qtList([])), []);
  same(Memory.hdWatchList([], []), []);
});

test("the HD watch list reuses Mount Monitor's mounts setting when present", () => {
  same(Memory.hdWatchList(["/home", "/srv/models"], ["/"]), ["/home", "/srv/models"]);
  same(Memory.hdWatchList(null, ["/data"]), ["/data"], "own list is the named fallback");
  same(Memory.hdWatchList(qtList(["/srv/models"]), ["/"]), ["/srv/models"]);
});

test("Memory Monitor suppresses an HD alert Mount Monitor already sends for the same mount", () => {
  assert.equal(Memory.hdAlertSuppressed("/srv/models", ["/srv/models"]), true);
  assert.equal(Memory.hdAlertSuppressed("/home", ["/srv/models"]), false);
});

test("the sibling plugin id is the real one", () => {
  assert.equal(Memory.mountMonitorPluginId(), "io.github.jasonlnheath.mount-monitor");
});

// ---------------------------------------------------------------------------
// The band step function and its hysteresis.
// ---------------------------------------------------------------------------

test("bandForPct steps at the ceiling, not above it", () => {
  const t = { amber: 80, red: 90, critical: 98 };
  same(
    [79, 79.9, 80, 89.9, 90, 97.9, 98, 99.5].map(pct => Memory.bandForPct(pct, t)),
    [0, 0, 1, 1, 2, 2, 3, 3],
  );
});

test("hysteresis holds a band until the reading clears it by the named margin", () => {
  const t = { amber: 80, red: 90, critical: 98 };
  const held = Memory.resolveBand(89.5, t, 2, "ram");
  assert.equal(held.band, 2);
  assert.equal(held.latched, true);
  assert.equal(held.changed, false);

  const released = Memory.resolveBand(85.9, t, 2, "ram");
  assert.equal(released.band, 1);
  assert.equal(released.latched, false);
  assert.equal(released.changed, true);
});

test("RAM holds wider than HD and VRAM, because RAM moves fastest", () => {
  assert.equal(Memory.hysteresisPp("ram"), 4);
  assert.equal(Memory.hysteresisPp("hd"), 2);
  assert.equal(Memory.hysteresisPp("vram"), 2);
});

test("an ascent is immediate; only a descent is held", () => {
  const t = { amber: 80, red: 90, critical: 98 };
  const up = Memory.resolveBand(91, t, 1, "ram");
  assert.equal(up.band, 2);
  assert.equal(up.latched, false);
  assert.equal(up.changed, true);
});

test("a band that cannot release at its margin says so in MemAvailable terms", () => {
  const t = { amber: 80, red: 90, critical: 98 };
  // 62.5 GiB total; band 2 releases below 86%, which needs 8.75 GiB free.
  const reachable = Memory.descentReachable(2, t, "ram", 10_000_000, 65_588_588);
  assert.equal(reachable.reachable, true);
  assert.equal(reachable.releasePct, 86, "the release point is the ceiling minus the hysteresis");
  const unreachable = Memory.descentReachable(2, t, "ram", 4_482_240, 65_588_588);
  assert.equal(unreachable.reachable, false);

  const note = Memory.unreachableBandNote(2, t, "ram", 4_482_240, 65_588_588);
  assert.match(note, /this band cannot clear at its current margin/);
  assert.match(note, /releases only below 86%/);
  assert.match(note, /GiB/, "the reason is absolute, because a percent hides how far it is");
  assert.match(Memory.unreachableBandNote(2, t, "ram", 10_000_000, 65_588_588), /releases below 86%/);
});

test("an HD band is always reachable - free space is reclaimable", () => {
  const hd = Memory.descentReachable(2, { amber: 80, red: 90, critical: 98 }, "hd");
  assert.equal(hd.reachable, true);
  assert.equal(hd.needKb, null, "no absolute need is invented for a drive");
});

test("a band with no ceiling set has no release point to be unreachable about", () => {
  const none = Memory.descentReachable(0, { amber: 80, red: 90, critical: null }, "ram", 1, 1);
  assert.equal(none.reachable, true);
  assert.equal(Memory.unreachableBandNote(0, { amber: 80, red: 90, critical: null }, "ram", 1, 1), "");
});

// ---------------------------------------------------------------------------
// One badge, one alert: the most severe resource wins, and a removed drive
// drops its alert instead of lingering.
// ---------------------------------------------------------------------------

test("the bar shows only the most severe resource", () => {
  const entries = [
    { type: "hd", band: 1, pct: 84 },
    { type: "ram", band: 2, pct: 93 },
    { type: "vram", band: 1, pct: 82 },
  ];
  const top = Memory.mostSevere(entries);
  assert.equal(top.type, "ram");
  assert.equal(Memory.mostSevereForBar(entries).type, "ram");
});

test("a tie is broken by type order RAM, VRAM, HD, so the badge never flickers", () => {
  const entries = [
    { type: "hd", band: 2, pct: 91 },
    { type: "vram", band: 2, pct: 91 },
    { type: "ram", band: 2, pct: 91 },
  ];
  assert.equal(Memory.mostSevereForBar(entries).type, "ram");
  assert.equal(Memory.mostSevereForBar([entries[2], entries[1], entries[0]]).type, "ram");
  assert.equal(Memory.mostSevereForBar([entries[1], entries[0]]).type, "vram", "with no RAM in the list, VRAM wins HD");
});

test("nothing watched and nothing held means no badge at all", () => {
  assert.equal(Memory.mostSevereForBar([]), null);
  assert.equal(Memory.mostSevereForBar([{ type: "ram", band: 0, pct: 12 }]), null);
  assert.equal(Memory.mostSevereForBar([{ type: "hd", band: 2, pct: 91, absent: true }]), null);
});

test("a held band says it is held in the detail window only; the bar popup drops the held column, for every resource", () => {
  const held = { type: "ram", band: 2, pct: 93, latched: true, memAvailableKb: 1, memTotalKb: 2, swapPct: null };
  assert.match(Memory.tooltipText(held), /held: this band has not released yet/);
  const released = { type: "ram", band: 2, pct: 93, latched: false, memAvailableKb: 1, memTotalKb: 2, swapPct: null };
  assert.equal(Memory.tooltipText(released).includes("held"), false);
  assert.match(Memory.tooltipText({ type: "vram", band: 1, pct: 82, latched: true, vramUsedMib: 1, vramTotalMib: 2, vramFreeMib: 1 }), /held: this band has not released yet/);
  assert.match(Memory.tooltipText({ type: "hd", band: 1, pct: 84, latched: true, target: "/data", usedKb: 1, sizeKb: 2, availKb: 1 }), /held: this band has not released yet/);
  assert.equal(Memory.latchedText(true), "held: this band has not released yet");
  assert.equal(Memory.latchedText(false), "");
  assert.equal(Memory.latchedText(undefined), "", "a group that carries no latch flag is not called held");
  // Round 2, the captain's edits: the bar popup's status column is a color
  // dot ONLY - no percent, no band word, no held. A held band says it is
  // held in the detail window (above); the bar popup cannot say it anymore.
  assert.equal(Memory.barTooltip([{ type: "ram", band: 2, pct: 93, latched: true }]).includes("held"), false,
    "the held column is gone from the bar popup");
  assert.equal(Memory.barTooltip([{ type: "ram", band: 2, pct: 93, latched: true }]).includes("93%"), false,
    "no reading rides the bar popup either");
});

test("bandDot: white none, orange amber, red red and critical", () => {
  assert.equal(Memory.bandDot(0), "\u26AA");
  assert.equal(Memory.bandDot(1), "\uD83D\uDFE0");
  assert.equal(Memory.bandDot(2), "\uD83D\uDD34");
  assert.equal(Memory.bandDot(3), "\uD83D\uDD34");
  assert.equal(Memory.bandDot(null), "\u26AA");
  assert.equal(Memory.bandDot(undefined), "\u26AA");
});

test("the bar popup is a name column and a color-dot column under a centered title", () => {
  // Round 2, the captain's edits on the preview board: the real name up top,
  // no column headers, no Free column, status = color dot only, and the RAM
  // / VRAM / Drive labels line up. The bar's tooltip is one centered Text
  // sized to its widest line, so every row still spans the same total width
  // and the two columns hold; the title line stays short and centers.
  const tip = Memory.barTooltip([
    { type: "ram", band: 0, pct: 42 },
    { type: "vram", band: 1, pct: 63 },
    { type: "hd", band: 2, pct: 97, latched: true },
  ]);
  assert.deepEqual(tip.split("\n"), [
    "Quattro Dash",
    "RAM    \u26AA ",
    "VRAM   \uD83D\uDFE0",
    "Drive  \uD83D\uDD34",
  ]);
  // Every dot starts on the same column: two spaces past the longest name.
  for (const line of tip.split("\n").slice(1)) {
    assert.equal(/\S/.test(line.slice(0, 7)), true, "the name occupies the left column");
    assert.equal(/\S/.test(line.slice(7)), true, "the dot occupies the right column");
  }
  // The shell centers each line inside the widest one, so equal total widths
  // are what keep the two columns aligned.
  const widths = tip.split("\n").slice(1).map((line) => line.length);
  for (const w of widths) {
    assert.equal(w, widths[0], "every row spans the same total width");
  }
});

test("a drive that is away keeps its row, with the white dot in the status column", () => {
  const tip = Memory.barTooltip([
    { type: "ram", band: 0, pct: 42 },
    { type: "hd", absent: true, band: 0 },
  ]);
  assert.deepEqual(tip.split("\n"), [
    "Quattro Dash",
    "RAM    \u26AA",
    "Drive  \u26AA",
  ]);
});

test("an empty watch list is the title alone", () => {
  assert.equal(Memory.barTooltip([]), "Quattro Dash");
  assert.equal(Memory.barTooltip(null), "Quattro Dash");
});

test("a drive that went away drops its alert", () => {
  const alerts = [
    { key: "partuuid:a", type: "hd", band: 2 },
    { key: "partuuid:b", type: "hd", band: 1 },
  ];
  const kept = Memory.dropGoneAlerts(alerts, ["partuuid:a"]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].key, "partuuid:a");
});

test("a question is never evicted by the gone-device sweep, because no live device key names a question", () => {
  const notices = [
    { kind: "ceilings", key: "ceilings", band: 3 },
    { kind: "guard-ask", key: "guard-ask", band: 3 },
  ];
  same(Memory.dropGoneAlerts(notices, []), notices, "an unanswered question is not a device that went away");
  same(Memory.dropGoneAlerts(notices.concat([{ key: "partuuid:c", type: "hd", band: 2 }]), ["partuuid:a"]), [
    notices[0],
    notices[1],
  ], "the drive's alert drops, the questions stay");
});

test("an alert fires on an event, not on a state, and only after the first reading", () => {
  // A shell restart must not re-toast a band the machine was already sitting in.
  assert.equal(Memory.shouldFireAlert({ band: 2, previousBand: 0, firstSample: true, wasHeld: false }), true);
  assert.equal(Memory.shouldFireAlert({ band: 2, previousBand: 2, firstSample: false, wasHeld: true }), false);
  assert.equal(Memory.shouldFireAlert({ band: 2, previousBand: 2, latched: true }), false);
  assert.equal(Memory.shouldFireAlert({ band: 2, previousBand: 2, latched: true, psiCrossing: true }), true);
  assert.equal(Memory.shouldFireAlert({ band: 2, previousBand: 2, latched: true, swapCrossing: true }), true);
  assert.equal(
    Memory.shouldFireAlert({ band: 2, previousBand: 2, latched: true, psiCrossing: false, swapCrossing: false }),
    false,
    "a standing stall is a state: only the crossing re-fires, or a stalling machine toasts every escalated poll",
  );
  assert.equal(
    Memory.shouldFireAlert({ band: 2, previousBand: 2, latched: true, swapEscalated: true, psiStalling: true }),
    false,
    "the caller passes the crossing; a level-shaped option decides nothing",
  );
  assert.equal(Memory.shouldFireAlert({ band: 1, previousBand: 2 }), false, "a descent is not an alert");
  assert.equal(Memory.shouldFireAlert({ band: 0, previousBand: 0, psiCrossing: true }), false, "band 0 never alerts");
});

// ---------------------------------------------------------------------------
// Adaptive polling. A red resource is watched harder; a resource with no
// reading is not polled faster, because there is nothing to watch.
// ---------------------------------------------------------------------------

test("poll intervals escalate on red and critical only", () => {
  assert.equal(Memory.pollIntervalMs("ram", 0), 30000);
  assert.equal(Memory.pollIntervalMs("ram", 1), 30000, "amber does not hammer the machine");
  assert.equal(Memory.pollIntervalMs("ram", 2), 10000);
  assert.equal(Memory.pollIntervalMs("ram", 3), 10000);
  assert.equal(Memory.pollIntervalMs("hd", 0), 60000);
  assert.equal(Memory.pollIntervalMs("hd", 2), 20000);
  assert.equal(Memory.pollIntervalMs("vram", 2), 20000);
});

test("PSI stalling is a further escalation on top of a band, never a substitute for one", () => {
  const stall = { psi: { some_avg10: 42.1 }, psiFloor: Memory.PSI_STALL_FLOOR };
  assert.equal(Memory.pollIntervalMs("ram", 2, stall), 5000);
  assert.equal(Memory.pollIntervalMs("ram", 3, stall), 5000);
  assert.equal(Memory.pollIntervalMs("ram", 1, stall), 30000, "no band held, no escalation");
  assert.equal(Memory.pollIntervalMs("hd", 2, stall), 20000, "PSI is a memory signal, not a drive signal");
});

test("an absent resource keeps its nominal interval", () => {
  assert.equal(Memory.pollIntervalMs("hd", 2, { absent: true }), 60000);
  assert.equal(Memory.pollIntervalMs("vram", 3, { absent: true }), 60000);
});

test("the poll interval is never zero and never absurd", () => {
  for (const type of ["hd", "vram", "ram"]) {
    for (const band of [0, 1, 2, 3]) {
      const ms = Memory.pollIntervalMs(type, band);
      assert.ok(ms >= 5000 && ms <= 60000, `${type} band ${band} -> ${ms}`);
    }
  }
});

test("the constants QML reaches for actually cross the module boundary", () => {
  // A top-level `const` in a classic script never becomes a property of the
  // global object, so `Memory.PSI_STALL_FLOOR` in QML would be undefined.
  for (const name of [
    "PSI_STALL_FLOOR",
    "DEFAULT_AMBER",
    "DEFAULT_RED",
    "DEFAULT_CRITICAL",
    "HYSTERESIS_PP",
    "URGENCE",
    "TIMEOUT_MS",
    "GUARD_ARM_COST_KB",
    "GUARD_ARM_TIMEOUT_MS",
    "IPC_TARGET",
    "LOG_MAX_BYTES",
    "LOG_MAX_LINES",
    "DEGRADATIONS",
  ]) {
    assert.notEqual(Memory[name], undefined, `${name} is invisible to QML`);
  }
  assert.equal(Memory.DEFAULT_CRITICAL, null, "critical ships unset");
});

// ---------------------------------------------------------------------------
// VRAM COOLANT floor (the dash's fourth instrument). The PR-18 semantics: the
// fill is free VRAM above the floor, and the floor is the plugin's own
// vramFloorMib setting, 500 MiB when unset (the captain's 2026-11-06
// defaults steer, red=500 amber=1500; Mount Monitor's telltale keeps 3400).
// ---------------------------------------------------------------------------

test("the coolant floor is the vramFloorMib setting, 500 MiB unset, never negative", () => {
  assert.equal(Memory.vramFloorMib(null), 500);
  assert.equal(Memory.vramFloorMib(undefined), 500);
  assert.equal(Memory.vramFloorMib(""), 500);
  assert.equal(Memory.vramFloorMib("garbage"), 500);
  assert.equal(Memory.vramFloorMib(-5), 500);
  assert.equal(Memory.vramFloorMib(0), 0, "a floor at zero is a real answer and is honored");
  assert.equal(Memory.vramFloorMib(4096), 4096);
  assert.equal(Memory.vramFloorMib("5120"), 5120, "a string setting is a number the same way normalizeNumber reads one");
  assert.equal(Memory.vramFloorMib(500.7), 501, "the floor is a whole-MiB line");
});
