// Street View wallpaper tests: the free-tier quota guard, the two meters,
// the settings recovery, and the fixed copy.
//
// Run: bash tests/run.sh   (or: node --test tests/)
//
// The guard this file exists for: the wallpaper NEVER sends a billable Static
// Street View request unless the month's meter says there is free headroom,
// and when the cap is hit the plan carries no argv at all — the fetch is not
// built and cannot be sent. The metadata endpoint (free, unlimited) gates
// every billable load behind a coverage answer. All of it lives in
// streetview.js, a plain top-level-function module loaded here through
// node:vm exactly like mounts.js, so the decisions are testable without a
// running shell and the QML files hold wiring only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.dirname(here);

// Both decision modules are Qt-importable JavaScript (plain top-level
// functions), so they are loaded into VM contexts instead of imported as ES
// modules. Date and encodeURIComponent are in the context because the meter
// rolls on the calendar and the URLs are built with the standard escaper,
// exactly as they are inside QML's own engine.
function loadModule(name) {
  const src = readFileSync(path.join(repo, name), "utf8");
  const ctx = { Math, Number, parseInt, isFinite, String, Array, RegExp, JSON, Object, console, Date, encodeURIComponent };
  vm.runInNewContext(src, ctx);
  return ctx;
}

const StreetView = loadModule("streetview.js");
const Mounts = loadModule("mounts.js");

// The shape the plugin hand-off delivers: a list wrapper that is not a
// JavaScript Array, but whose JSON serialization is the array — the
// round-trip that recovers it (see settings.test.mjs for the original bug).
function stringifiedListLike(items) {
  return { toJSON: () => items };
}

// A usable config: feature on, a key, both caps at their paranoid defaults.
function cfg(overrides) {
  return Object.assign({
    enabled: true,
    key: "AIza-test-key",
    capPerDay: 100,
    monthlyCap: 10000,
    intervalMinutes: 30,
    size: "1920x1080",
    locations: ["Eiffel Tower, Paris", "Golden Gate Bridge, San Francisco"]
  }, overrides || {});
}

// A meter partway through a month: 3,214 loads used this month, 12 today.
function meter(overrides) {
  return Object.assign({
    version: 1,
    month: "2026-10",
    monthlyUsed: 3214,
    day: "2026-10-27",
    dailyUsed: 12,
    cycle: 17,
    updatedAt: "2026-10-27T10:00:00.000Z"
  }, overrides || {});
}

const NOW = "2026-10-27T18:04:00.000Z"; // 18:04 UTC; local date depends on TZ but is well-formed

// --- settings: the paranoid defaults ----------------------------------------

test("an empty settings object reads as the paranoid default posture", () => {
  const c = StreetView.configFromSettings({});
  assert.equal(c.enabled, true);
  assert.equal(c.key, "");
  assert.equal(c.capPerDay, 100, "cap ON by default at the captain's conservative value");
  assert.equal(c.monthlyCap, 10000, "the free ceiling, hard");
  assert.equal(c.intervalMinutes, 30);
  assert.equal(c.size, "1920x1080");
  assert.equal(Array.from(c.locations).join("|"), Array.from(StreetView.DEFAULT_LOCATIONS).join("|"),
    "the built-in rotation is the default list");
  assert.ok(StreetView.DEFAULT_LOCATIONS.length >= 3, "a real rotation to fall back to");
});

test("a fully configured settings object passes through", () => {
  const c = StreetView.configFromSettings({
    streetview: false,
    streetviewKey: " AIza-real-key ",
    streetviewCapPerDay: 20,
    streetviewMonthlyCap: 50000,
    streetviewIntervalMinutes: 90,
    streetviewSize: "3840x2160",
    streetviewLocations: ["/gnu/ images ", "48.85,2.29"]
  });
  assert.equal(c.enabled, false);
  assert.equal(c.key, "AIza-real-key");
  assert.equal(c.capPerDay, 20);
  assert.equal(c.monthlyCap, 50000, "above 10000 is the explicit paid unlock");
  assert.equal(c.intervalMinutes, 90);
  assert.equal(c.size, "3840x2160");
  assert.deepEqual(Array.from(c.locations), ["/gnu/ images", "48.85,2.29"]);
});

test("streetviewCapPerDay: 0 pauses hard, -1 removes the daily limit, everything else falls back", () => {
  assert.equal(StreetView.normalizeCapPerDay(0), 0, "an explicit 0 is a hard pause, not garbage");
  assert.equal(StreetView.normalizeCapPerDay(-1), -1, "-1 is the documented no-daily-cap unlock");
  assert.equal(StreetView.normalizeCapPerDay("50"), 50);
  assert.equal(StreetView.normalizeCapPerDay(12.9), 12);
  for (const raw of [undefined, null, "", "soon", -5, -2, {}, [100]]) {
    assert.equal(StreetView.normalizeCapPerDay(raw), 100,
      `${JSON.stringify(raw)} must fall back to the paranoid default, never to unlimited`);
  }
});

test("streetviewMonthlyCap: above 10000 unlocks paid overage; zero or garbage falls back to the free ceiling", () => {
  assert.equal(StreetView.normalizeMonthlyCap(20000), 20000);
  assert.equal(StreetView.normalizeMonthlyCap("15000"), 15000);
  assert.equal(StreetView.normalizeMonthlyCap(10000.9), 10000);
  for (const raw of [undefined, null, "", "all of it", 0, -1, -100, {}]) {
    assert.equal(StreetView.normalizeMonthlyCap(raw), 10000,
      `${JSON.stringify(raw)} must fall back to the free ceiling — a typo must not become a bill`);
  }
});

test("streetviewIntervalMinutes floors at 5 and falls back to 30", () => {
  assert.equal(StreetView.normalizeIntervalMinutes(1), 5);
  assert.equal(StreetView.normalizeIntervalMinutes(0), 5);
  assert.equal(StreetView.normalizeIntervalMinutes(90.7), 90);
  for (const raw of [undefined, null, "", "often", {}]) {
    assert.equal(StreetView.normalizeIntervalMinutes(raw), 30);
  }
});

test("streetviewSize is regex-validated and falls back to the default", () => {
  assert.equal(StreetView.normalizeSize("640x480"), "640x480");
  assert.equal(StreetView.normalizeSize("3840x2160"), "3840x2160");
  for (const raw of [undefined, null, "", "big", "100", "-100x100", 640, "1920x"]) {
    assert.equal(StreetView.normalizeSize(raw), "1920x1080");
  }
});

test("streetview off switch reads through the bool recovery", () => {
  assert.equal(StreetView.normalizeStreetViewEnabled(false), false);
  assert.equal(StreetView.normalizeStreetViewEnabled("false"), false);
  assert.equal(StreetView.normalizeStreetViewEnabled(undefined), true);
  assert.equal(StreetView.normalizeStreetViewEnabled("garbage"), true);
});

test("streetviewLocations recovers a Qt list wrapper and falls back to the rotation", () => {
  const raw = stringifiedListLike(["Taj Mahal, Agra", ""]);
  const out = StreetView.normalizeLocations(raw);
  assert.ok(!Array.isArray(raw));
  assert.deepEqual(Array.from(out), ["Taj Mahal, Agra"]);
  for (const bad of [undefined, null, "", "Paris", 42, {}, []]) {
    assert.equal(Array.from(StreetView.normalizeLocations(bad)).join("|"),
      Array.from(StreetView.DEFAULT_LOCATIONS).join("|"),
      `${JSON.stringify(bad)} must fall back to the built-in rotation`);
  }
});

// --- extractConfig: the service reads the widget's bar entry -----------------

const SHELL_JSON = JSON.stringify({
  bar: {
    layout: {
      left: [{ id: "omarchy.workspaces" }],
      middle: [],
      right: [
        { id: "omarchy.clock" },
        { id: "io.github.jasonlnheath.mount-monitor", mounts: ["/"],
          streetview: true, streetviewKey: "AIza-bar-key", streetviewCapPerDay: 25 }
      ]
    }
  },
  plugins: [{ id: "io.github.jasonlnheath.mount-monitor" }]
});

test("extractConfig finds the widget's bar entry and reads its streetview settings", () => {
  const c = StreetView.extractConfig(SHELL_JSON, "io.github.jasonlnheath.mount-monitor");
  assert.equal(c.enabled, true);
  assert.equal(c.key, "AIza-bar-key");
  assert.equal(c.capPerDay, 25);
  assert.equal(c.monthlyCap, 10000, "unset caps stay at the free ceiling");
});

test("extractConfig searches every bar section", () => {
  const withLeft = JSON.stringify({
    bar: { layout: { left: [{ id: "io.github.jasonlnheath.mount-monitor", streetviewKey: "AIza-left" }], middle: [], right: [] } }
  });
  assert.equal(StreetView.extractConfig(withLeft, "io.github.jasonlnheath.mount-monitor").key, "AIza-left");
  const withMiddle = JSON.stringify({
    bar: { layout: { left: [], middle: [{ id: "io.github.jasonlnheath.mount-monitor", streetviewKey: "AIza-mid" }], right: [] } }
  });
  assert.equal(StreetView.extractConfig(withMiddle, "io.github.jasonlnheath.mount-monitor").key, "AIza-mid");
});

test("extractConfig: no bar entry, a bare id entry, or garbage JSON all read as defaults", () => {
  const id = "io.github.jasonlnheath.mount-monitor";
  for (const text of ["", "not json", "{}",
    JSON.stringify({ bar: { layout: { left: [], middle: [], right: [] } } }),
    JSON.stringify({ bar: { layout: { left: [], middle: [], right: [id] } } }),
    JSON.stringify({ plugins: [{ id, streetviewKey: "ignored" }] })]) {
    const c = StreetView.extractConfig(text, id);
    assert.equal(c.key, "", `${text} must read as defaults (no key)`);
    assert.equal(c.capPerDay, 100);
  }
});

// --- meter: calendar rollover ------------------------------------------------

test("parseMeter: garbage, empty, and half-written files read as an empty meter", () => {
  for (const text of ["", "   ", "{", "not json", "null", "[1,2]", "42"]) {
    const m = StreetView.parseMeter(text);
    assert.equal(m.monthlyUsed, 0);
    assert.equal(m.dailyUsed, 0);
    assert.equal(m.month, "");
    assert.equal(m.day, "");
  }
});

test("parseMeter keeps usable counters and drops unusable ones", () => {
  const m = StreetView.parseMeter(JSON.stringify({
    version: 1, month: "2026-10", monthlyUsed: 214, day: "2026-10-27", dailyUsed: 3,
    cycle: 9, updatedAt: "x"
  }));
  assert.equal(m.monthlyUsed, 214);
  assert.equal(m.dailyUsed, 3);
  assert.equal(m.cycle, 9);
  const negative = StreetView.parseMeter(JSON.stringify({ month: "2026-10", monthlyUsed: -5 }));
  assert.equal(negative.monthlyUsed, 0, "a negative counter reads as zero, never as credit");
});

test("serializeMeter round-trips through parseMeter", () => {
  const text = StreetView.serializeMeter(meter(), "2026-10-27T18:00:00.000Z");
  const back = StreetView.parseMeter(text);
  assert.equal(back.monthlyUsed, 3214);
  assert.equal(back.dailyUsed, 12);
  assert.equal(back.cycle, 17);
  assert.equal(back.updatedAt, "2026-10-27T18:00:00.000Z");
  assert.equal(back.capNotified, undefined, "the meter file carries no widget bookkeeping");
});

test("cap state: the widget's own bookkeeping file round-trips and reads garbage as fresh", () => {
  assert.deepEqual(StreetView.parseCapState("").episode, "");
  for (const text of ["{", "null", "[1]", "42", "nope"]) {
    assert.equal(StreetView.parseCapState(text).episode, "");
  }
  const text = StreetView.serializeCapState({ episode: "d:2026-10-27" });
  assert.equal(StreetView.parseCapState(text).episode, "d:2026-10-27");
  assert.equal(StreetView.capStatePath("/home/u"),
    "/home/u/.local/state/mount-monitor/streetview-cap.json");
});

test("capReason names the spent cap for the copy, and stays silent for a broken clock", () => {
  assert.equal(StreetView.capReason(meter({ dailyUsed: 100 }), cfg(), NOW), "daily");
  assert.equal(StreetView.capReason(meter({ monthlyUsed: 10000 }), cfg(), NOW), "monthly");
  assert.equal(StreetView.capReason(meter(), cfg(), NOW), "");
  assert.equal(StreetView.capReason(meter(), cfg(), "garbage"), "");
});

test("statusArgs is the whole popup argv, built in the module", () => {
  const argv = StreetView.statusArgs(meter(), cfg(), NOW);
  assert.equal(argv[0], "notify-send");
  assert.equal(argv[2], "normal");
  assert.deepEqual(Array.from(argv.slice(-2)),
    [StreetView.statusTitle(), StreetView.statusBody(meter(), cfg(), NOW)]);
});

test("monthKeyOf and dayKeyOf format the local calendar; an unusable clock is empty", () => {
  assert.match(StreetView.monthKeyOf(NOW), /^2026-10$/);
  assert.match(StreetView.dayKeyOf(NOW), /^2026-10-2[678]$/);
  for (const bad of ["", "not a date", "2026-13-99"]) {
    assert.equal(StreetView.monthKeyOf(bad), "");
    assert.equal(StreetView.dayKeyOf(bad), "");
  }
});

test("meterForNow rolls the month and resets the monthly counter, keeping the cycle", () => {
  // Mid-month, mid-day stamps: the local calendar is what rolls, and these
  // land on the same local date in every timezone on Earth.
  const rolled = StreetView.meterForNow(meter(), "2026-11-15T12:00:00.000Z");
  assert.equal(rolled.month, "2026-11");
  assert.equal(rolled.monthlyUsed, 0, "a new month is fresh free headroom");
  assert.equal(rolled.dailyUsed, 0);
  assert.equal(rolled.cycle, 17, "the rotation is not reset by the calendar");
  const nextDay = StreetView.meterForNow(meter(), "2026-10-28T12:00:00.000Z");
  assert.equal(nextDay.monthlyUsed, 3214, "within the month the counters stay");
  assert.equal(nextDay.dailyUsed, 0, "a new day is fresh daily headroom");
  const sameInstant = StreetView.meterForNow(meter(), NOW);
  assert.equal(sameInstant.monthlyUsed, 3214, "the same day rolls nothing");
  assert.equal(sameInstant.dailyUsed, 12);
});

test("recordLoad counts the load before any request is built", () => {
  const next = StreetView.recordLoad(meter(), NOW);
  assert.equal(next.monthlyUsed, 3215);
  assert.equal(next.dailyUsed, 13);
  assert.equal(next.cycle, 18);
  assert.ok(next.updatedAt);
});

test("formatInt groups thousands the way the captain's example reads", () => {
  assert.equal(StreetView.formatInt(0), "0");
  assert.equal(StreetView.formatInt(999), "999");
  assert.equal(StreetView.formatInt(3214), "3,214");
  assert.equal(StreetView.formatInt(10000), "10,000");
});

// --- the gate ----------------------------------------------------------------

test("hasHeadroom: ok with room in both meters", () => {
  const h = StreetView.hasHeadroom(meter(), cfg(), NOW);
  assert.equal(h.ok, true);
  assert.equal(h.reason, "ok");
});

test("hasHeadroom: off and nokey stop everything before any cap is read", () => {
  assert.equal(StreetView.hasHeadroom(meter(), cfg({ enabled: false }), NOW).reason, "off");
  assert.equal(StreetView.hasHeadroom(meter(), cfg({ key: "" }), NOW).reason, "nokey");
});

test("hasHeadroom: a full month caps even with daily room", () => {
  const h = StreetView.hasHeadroom(meter({ monthlyUsed: 10000 }), cfg(), NOW);
  assert.equal(h.ok, false);
  assert.equal(h.reason, "monthly");
  assert.equal(StreetView.hasHeadroom(meter({ monthlyUsed: 10001 }), cfg(), NOW).ok, false);
});

test("hasHeadroom: a full day caps even with monthly room", () => {
  const h = StreetView.hasHeadroom(meter({ dailyUsed: 100 }), cfg(), NOW);
  assert.equal(h.ok, false);
  assert.equal(h.reason, "daily");
});

test("hasHeadroom: a raised monthly cap is honored — the unlock is real", () => {
  const h = StreetView.hasHeadroom(meter({ monthlyUsed: 12000 }), cfg({ monthlyCap: 50000, capPerDay: -1 }), NOW);
  assert.equal(h.ok, true, "the user's explicit unlock must not be second-guessed");
});

test("hasHeadroom: capPerDay -1 never caps on the daily meter", () => {
  assert.equal(StreetView.hasHeadroom(meter({ dailyUsed: 99999 }), cfg({ capPerDay: -1 }), NOW).ok, true);
});

test("hasHeadroom: an unusable clock reads as capped, never as free", () => {
  const h = StreetView.hasHeadroom(meter(), cfg(), "garbage");
  assert.equal(h.ok, false);
  assert.equal(h.reason, "clock");
});

test("capEpisode names the episode the warning fires once for", () => {
  const daily = StreetView.capEpisode(meter({ dailyUsed: 100 }), cfg(), NOW);
  assert.match(daily, /^d:2026-/);
  const monthly = StreetView.capEpisode(meter({ monthlyUsed: 10000 }), cfg(), NOW);
  assert.match(monthly, /^m:2026-10$/, "monthly takes precedence when both caps are gone");
  assert.equal(StreetView.capEpisode(meter(), cfg(), NOW), "", "room in both caps is no episode");
  assert.equal(StreetView.capEpisode(meter(), cfg(), "garbage"), "");
});

test("usageLine is the captain's example, word for word in shape", () => {
  assert.equal(StreetView.usageLine(meter(), cfg(), NOW), "3,214 / 10,000 free loads (32% this month)");
  const fresh = StreetView.usageLine(meter({ monthlyUsed: 0, month: "2026-11" }), cfg(), "2026-11-02T10:00:00.000Z");
  assert.equal(fresh, "0 / 10,000 free loads (0% this month)");
  const unlocked = StreetView.usageLine(meter({ monthlyUsed: 12000 }), cfg({ monthlyCap: 50000 }), NOW);
  assert.equal(unlocked, "12,000 / 50,000 free loads (24% this month)");
});

test("todayLine reports the daily meter honestly, including 'no daily cap'", () => {
  assert.equal(StreetView.todayLine(meter(), cfg(), NOW), "12/100 today");
  assert.equal(StreetView.todayLine(meter({ dailyUsed: 100 }), cfg(), NOW), "100/100 today");
  assert.equal(StreetView.todayLine(meter({ dailyUsed: 7 }), cfg({ capPerDay: -1 }), NOW), "7 today, no daily cap");
});

// --- the plans: the quota guard itself ---------------------------------------

test("plan: feature off or no key builds nothing at all", () => {
  for (const c of [cfg({ enabled: false }), cfg({ key: "" })]) {
    const p = StreetView.plan(meter(), c, NOW);
    assert.equal(p.action, "off");
    assert.equal(p.argv, undefined, "no argv field exists on an off plan");
    assert.equal(p.location, undefined);
  }
});

test("plan: a capped month returns a plan with NO argv and NO location — the fetch is never built", () => {
  const p = StreetView.plan(meter({ monthlyUsed: 10000 }), cfg(), NOW);
  assert.equal(p.action, "capped");
  assert.equal(p.reason, "monthly");
  assert.equal(p.argv, undefined);
  assert.equal(p.location, undefined);
  assert.ok(p.usageLine, "the capped plan carries the usage line for the warning");
});

test("plan: a capped day returns a plan with NO argv", () => {
  const p = StreetView.plan(meter({ dailyUsed: 100 }), cfg(), NOW);
  assert.equal(p.action, "capped");
  assert.equal(p.reason, "daily");
  assert.equal(p.argv, undefined);
  assert.equal(p.location, undefined);
});

test("plan: a garbage clock returns capped, not a request", () => {
  const p = StreetView.plan(meter(), cfg(), "not a time");
  assert.equal(p.action, "capped");
  assert.equal(p.reason, "clock");
  assert.equal(p.argv, undefined);
});

test("plan: with headroom the only request is the FREE metadata call", () => {
  const p = StreetView.plan(meter({ cycle: 0 }), cfg(), NOW);
  assert.equal(p.action, "metadata");
  assert.equal(p.location, "Eiffel Tower, Paris", "rotation starts at the first location");
  assert.equal(p.index, 0);
  assert.ok(Array.isArray(p.argv));
  assert.equal(p.argv[0], "curl");
  const url = p.argv[p.argv.length - 1];
  assert.ok(url.indexOf("https://maps.googleapis.com/maps/api/streetview/metadata?") === 0,
    "the metadata endpoint is the free one");
  assert.ok(url.indexOf("streetview?") < 0, "the metadata plan never names the billable endpoint");
  assert.ok(url.indexOf("key=AIza-test-key") > 0);
});

test("plan: the location rotates deterministically with the meter's cycle", () => {
  const locations = ["A", "B", "C"];
  for (let cycle = 0; cycle < 7; cycle++) {
    const p = StreetView.plan(meter({ cycle }), cfg({ locations }), NOW);
    assert.equal(p.location, locations[cycle % 3], `cycle ${cycle}`);
  }
});

test("coveredFromMetadata: only an OK answer covers; garbage and ZERO_RESULTS do not", () => {
  assert.equal(StreetView.coveredFromMetadata('{"status":"OK","copyright":"x"}').covered, true);
  assert.equal(StreetView.coveredFromMetadata('{"status":"ZERO_RESULTS"}').covered, false);
  assert.equal(StreetView.coveredFromMetadata('{"status":"REQUEST_DENIED"}').covered, false);
  assert.equal(StreetView.coveredFromMetadata("not json").covered, false);
  assert.equal(StreetView.coveredFromMetadata("").covered, false);
  assert.equal(StreetView.coveredFromMetadata('{"status":"OK"}').status, "OK");
});

test("imagePlan: the billable argv carries the already-incremented meter — count before send", () => {
  const m = meter();
  const p = StreetView.imagePlan("Eiffel Tower, Paris", m, cfg(), NOW, "/home/u");
  assert.equal(p.action, "image");
  assert.equal(p.argv[0], "curl");
  const url = p.argv[p.argv.length - 1];
  assert.ok(url.indexOf("https://maps.googleapis.com/maps/api/streetview?") === 0,
    "the image plan names the billable endpoint");
  assert.ok(url.indexOf("metadata") < 0);
  assert.ok(url.indexOf("key=AIza-test-key") > 0);
  assert.ok(url.indexOf("location=Eiffel%20Tower%2C%20Paris") > 0);
  assert.equal(p.meter.monthlyUsed, 3215, "the meter is incremented in the plan");
  assert.equal(p.meter.dailyUsed, 13);
  assert.deepEqual(Array.from(p.moveArgs), ["mv", "-f", "/home/u/.local/state/mount-monitor/streetview/current.jpg.tmp",
    "/home/u/.local/state/mount-monitor/streetview/current.jpg"]);
  assert.deepEqual(Array.from(p.wallpaperArgs), ["omarchy-theme-bg-set",
    "/home/u/.local/state/mount-monitor/streetview/current.jpg"]);
});

test("imagePlan: a capped meter never gets an image argv, even after a coverage answer", () => {
  const p = StreetView.imagePlan("Eiffel Tower, Paris", meter({ dailyUsed: 100 }), cfg(), NOW, "/home/u");
  assert.equal(p.action, "capped");
  assert.equal(p.argv, undefined, "the second gate holds even when the metadata said covered");
});

test("imagePlan: the heading varies with the cycle so one location is not one photo forever", () => {
  const urls = [];
  for (const cycle of [0, 1, 2, 4]) {
    const p = StreetView.imagePlan("Eiffel Tower, Paris", meter({ cycle }), cfg(), NOW, "/home/u");
    urls.push(p.argv[p.argv.length - 1].match(/heading=(\d+)/)[1]);
  }
  assert.deepEqual(urls, ["0", "90", "180", "0"], "heading = (cycle % 4) * 90");
});

test("advanceCycle turns the rotation without counting a load", () => {
  const next = StreetView.advanceCycle(meter({ cycle: 16 }), NOW);
  assert.equal(next.cycle, 17);
  assert.equal(next.monthlyUsed, 3214, "no coverage costs nothing");
  assert.equal(next.dailyUsed, 12);
  const p = StreetView.plan(next, cfg(), NOW);
  assert.equal(p.location, "Golden Gate Bridge, San Francisco", "17 % 2 = 1: the next location");
});

test("paths and commands are typed argv, built only in the module", () => {
  assert.equal(StreetView.meterPath("/home/u"), "/home/u/.local/state/mount-monitor/streetview-meter.json");
  assert.equal(StreetView.cacheDir("/home/u"), "/home/u/.local/state/mount-monitor/streetview");
  assert.deepEqual(Array.from(StreetView.mkdirArgs("/home/u")),
    ["mkdir", "-p", "/home/u/.local/state/mount-monitor/streetview"]);
  assert.equal(StreetView.tickMs(30), 1800000);
  assert.equal(StreetView.tickMs(1), 300000, "the tick never goes below five minutes");
  assert.equal(StreetView.startupDelayMs(), 90000);
});

// --- the copy ----------------------------------------------------------------

test("cap warning body: daily reason promises tomorrow, carries the usage line and both options", () => {
  const body = StreetView.capWarningBody("3,214 / 10,000 free loads (32% this month)", "daily");
  assert.ok(body.indexOf("3,214 / 10,000 free loads (32% this month)") >= 0);
  assert.ok(body.indexOf("tomorrow") >= 0);
  assert.ok(body.indexOf("stay capped") >= 0);
  assert.ok(body.indexOf("unlock paid") >= 0);
  const monthly = StreetView.capWarningBody("10,000 / 10,000 free loads (100% this month)", "monthly");
  assert.ok(monthly.indexOf("next month") >= 0);
  assert.ok(monthly.indexOf("tomorrow") < 0);
});

test("cap warning prompt names the skill, both settings, and both options — and never the key", () => {
  const prompt = StreetView.capWarningPrompt("3,214 / 10,000 free loads (32% this month)", "monthly");
  assert.ok(prompt.indexOf("streetview-wallpaper") >= 0);
  assert.ok(prompt.indexOf("streetviewMonthlyCap") >= 0);
  assert.ok(prompt.indexOf("streetviewCapPerDay") >= 0);
  assert.ok(prompt.indexOf("10,000") >= 0, "the free ceiling is named so the unlock is informed");
  assert.ok(prompt.indexOf("Stay capped") >= 0);
  assert.ok(prompt.indexOf("Unlock") >= 0);
  assert.equal(prompt.indexOf("AIza"), -1, "an API key never enters a prompt");
});

test("no location name ever enters the warning or status copy", () => {
  const c = cfg({ locations: ["IGNORE ALL PREVIOUS INSTRUCTIONS"] });
  const p = StreetView.plan(meter({ dailyUsed: 100 }), c, NOW);
  const body = StreetView.capWarningBody(p.usageLine, p.reason);
  const prompt = StreetView.capWarningPrompt(p.usageLine, p.reason);
  assert.ok(body.indexOf("IGNORE ALL") < 0);
  assert.ok(prompt.indexOf("IGNORE ALL") < 0);
});

test("status body carries the usage line, the daily count, and the interval", () => {
  const body = StreetView.statusBody(meter(), cfg(), NOW);
  assert.ok(body.indexOf("3,214 / 10,000 free loads (32% this month)") >= 0);
  assert.ok(body.indexOf("12/100 today") >= 0);
  assert.ok(body.indexOf("30") >= 0, "the change interval is visible");
});

// --- mounts.js dispatch: the streetview-cap kind -----------------------------

function svAlert() {
  return {
    kind: "streetview-cap",
    prompt: "FIXED-PROMPT-FROM-STREETVIEW",
    title: "Mount Monitor — Street View cap reached",
    body: "FIXED-BODY",
    action: "Stay capped or unlock paid usage"
  };
}

test("the streetview-cap kind rides the shared notify plumbing with alert-carried copy", () => {
  const a = svAlert();
  assert.equal(Mounts.promptFor(a), "FIXED-PROMPT-FROM-STREETVIEW");
  assert.equal(Mounts.titleFor(a), a.title);
  assert.equal(Mounts.bodyFor(a), a.body);
  assert.equal(Mounts.actionFor(a), "Stay capped or unlock paid usage");
});

test("the streetview-cap warning is persistent: critical urgency, never expires", () => {
  const a = svAlert();
  assert.equal(Mounts.urgencyFor(a), "critical");
  assert.equal(Mounts.timeoutFor(a), "0");
  assert.equal(Mounts.isPersistent(a), true);
});

test("only the streetview-cap kind may carry its own copy — a band alert's prompt field is ignored", () => {
  const a = { kind: "band", band: 3, target: "/", id: "mm-00000000-00000000", prompt: "INJECTED", title: "INJECTED" };
  assert.ok(Mounts.promptFor(a).indexOf("INJECTED") < 0, "promptFor dispatches on kind first");
  assert.ok(Mounts.titleFor(a).indexOf("INJECTED") < 0);
  const noKind = { prompt: "INJECTED", target: "/" };
  assert.ok(Mounts.promptFor(noKind).indexOf("INJECTED") < 0);
});

// --- QML delegation guards ---------------------------------------------------

test("MountMonitor.qml relays the cap warning through streetview.js and builds no copy of its own", () => {
  const qml = readFileSync(path.join(repo, "MountMonitor.qml"), "utf8");
  assert.ok(qml.indexOf("streetview.js") >= 0, "the widget imports the decisions module");
  assert.ok(qml.indexOf("StreetView.meterPath(") >= 0, "the meter file path comes from the module");
  assert.ok(qml.indexOf("StreetView.parseMeter(") >= 0);
  assert.ok(qml.indexOf("StreetView.capEpisode(") >= 0, "the episode decision comes from the module");
  assert.ok(qml.indexOf("StreetView.parseCapState(") >= 0, "the warned-episode memory comes from the module");
  assert.ok(qml.indexOf("StreetView.capWarningPrompt(") >= 0);
  assert.ok(qml.indexOf("StreetView.capWarningBody(") >= 0);
  assert.ok(qml.indexOf("StreetView.usageLine(") >= 0, "the tooltip usage line comes from the module");
  assert.ok(qml.indexOf("streetview-cap") >= 0);
  assert.ok(qml.indexOf("10,000") < 0, "no hardcoded cap numbers in QML");
  assert.ok(qml.indexOf("maps.googleapis.com") < 0, "no URLs in QML");
});

test("StreetView.qml executes plans and builds no request itself", () => {
  const qml = readFileSync(path.join(repo, "StreetView.qml"), "utf8");
  assert.ok(qml.indexOf('import "streetview.js" as StreetView') >= 0);
  assert.ok(qml.indexOf("StreetView.plan(") >= 0, "every tick goes through the gate");
  assert.ok(qml.indexOf("StreetView.imagePlan(") >= 0);
  assert.ok(qml.indexOf("StreetView.coveredFromMetadata(") >= 0);
  assert.ok(qml.indexOf("StreetView.advanceCycle(") >= 0, "a no-coverage answer turns the rotation through the module");
  assert.ok(qml.indexOf("StreetView.extractConfig(") >= 0, "config comes from the module's parser");
  assert.ok(qml.indexOf("StreetView.shellJsonPath(") >= 0, "the settings path comes from the module too");
  assert.ok(qml.indexOf("root.writeMeter(") >= 0);
  assert.ok(qml.indexOf("monthlyUsed") < 0 && qml.indexOf("dailyUsed") < 0,
    "no counter is ever mutated in QML - the incremented meter arrives inside the plan");
  assert.ok(qml.indexOf("https://") < 0, "no URLs in QML — plans carry them");
  assert.ok(qml.indexOf('"curl"') < 0, "no argv literals in QML");
  assert.ok(qml.indexOf("omarchy-theme-bg-set") < 0, "the setter argv comes from the module");
  assert.ok(qml.indexOf("StreetView.statusArgs(") >= 0, "the status popup argv comes from the module");
});

test("both entry points are declared in the manifest", () => {
  const manifest = JSON.parse(readFileSync(path.join(repo, "manifest.json"), "utf8"));
  assert.ok(manifest.kinds.indexOf("service") >= 0);
  assert.ok(manifest.kinds.indexOf("bar-widget") >= 0, "the bar widget is untouched");
  assert.equal(manifest.entryPoints.service, "StreetView.qml");
  assert.equal(manifest.entryPoints.barWidget, "MountMonitor.qml");
});

test("shellJsonPath is the documented settings surface, built in the module", () => {
  assert.equal(StreetView.shellJsonPath("/home/u"), "/home/u/.config/omarchy/shell.json");
});

test("the two decision modules agree on the state directory", () => {
  assert.equal(StreetView.stateBase("/home/u"), Mounts.stateDir("/home/u"),
    "the widget reads the meter from the same directory the service writes it in");
});

test("plan: a caller that bypasses configFromSettings with an empty rotation falls back, never to NaN", () => {
  const p = StreetView.plan(meter({ cycle: 0 }), { enabled: true, key: "k", monthlyCap: 10000, capPerDay: 100, locations: [] }, NOW);
  assert.equal(p.action, "metadata");
  assert.equal(p.location, Array.from(StreetView.DEFAULT_LOCATIONS)[0]);
});
