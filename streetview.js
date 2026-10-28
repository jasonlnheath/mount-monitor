// Street View wallpaper shared logic: the free-tier quota guard, the two
// meters, the settings recovery, and the fixed copy.
//
// Imported by StreetView.qml and MountMonitor.qml (import "streetview.js" as
// StreetView) and loaded by tests/streetview.test.mjs through node:vm, so the
// meter math, the cap logic, the metadata-vs-paid gating, the fallback
// choice, and the copy are testable without a running shell. Same contract as
// mounts.js: plain top-level function declarations only - no export, no
// import, no .pragma library - or one of the two consumers breaks.
//
// The billing facts this is built around (captain's ruling, 2026-10-27): the
// SKU is Static Street View (Essentials) - 10,000 free panorama loads per
// month, then $7 per 1,000 - and the metadata endpoint is always free and
// unlimited. The credit-card-on-file requirement is exactly why this module
// exists: the app must GUARANTEE a genuinely free tier, so the wallpaper
// never sends a billable request unless the month's meter says there is
// headroom, and a user-supplied key is guarded by the same meter as any
// other.

// --- the caps ---------------------------------------------------------------
//
// Two meters, each guarding its own cap, and a fetch needs headroom in BOTH:
//   - monthly, because the free tier resets monthly; only a monthly meter can
//     see a month's total, so only a monthly meter can guarantee the ceiling.
//   - daily, because "100 a day" is what a person can reason about and what
//     bounds a runaway interval setting. ON by default at a conservative
//     value - the paranoid default.
var SV_FREE_MONTHLY = 10000
var SV_DEFAULT_DAILY_CAP = 100
var SV_DEFAULT_INTERVAL_MIN = 30
var SV_MIN_INTERVAL_MIN = 5
var SV_DEFAULT_SIZE = "1920x1080"
var SV_OVERAGE_NOTE = "beyond that Google bills $7 per 1,000 loads"

// A small built-in rotation, fixed copy: famous, outdoor, very likely to have
// Street View coverage. A user's own list replaces it whole.
var DEFAULT_LOCATIONS = [
  "Eiffel Tower, Paris",
  "Golden Gate Bridge, San Francisco",
  "Taj Mahal, Agra",
  "Colosseum, Rome",
  "Sydney Opera House",
  "Mount Fuji, Japan"
]

// --- settings ---------------------------------------------------------------
//
// Every setting is read through a normalize* helper with a documented
// fallback, the same lesson as mounts.js: the hand-off delivers Qt lists, not
// JavaScript Arrays, and a mangled value must never silently widen what the
// plugin may spend. Absent always reads as the paranoid default - never as
// "unlimited", because a typo must not become a bill.

function svNumberish(value) {
  if (typeof value === "number") return isFinite(value) ? value : null
  if (typeof value === "string") {
    var text = value.trim()
    if (text === "") return null
    var n = Number(text)
    return isFinite(n) ? n : null
  }
  return null
}

function svBoolish(value) {
  if (typeof value === "boolean") return value
  if (typeof value === "number") return isFinite(value) ? (value !== 0) : null
  if (typeof value === "string") {
    var text = value.trim().toLowerCase()
    if (text === "true" || text === "1" || text === "yes" || text === "on") return true
    if (text === "false" || text === "0" || text === "no" || text === "off") return false
    return null
  }
  return null
}

function svRecoverList(raw) {
  var items = null
  if (Array.isArray(raw)) {
    items = raw
  } else {
    try {
      var round = JSON.parse(JSON.stringify(raw))
      if (Array.isArray(round)) items = round
    } catch (e) { items = null }
  }
  if (items === null) return null
  var out = []
  for (var i = 0; i < items.length; i++) {
    if (typeof items[i] !== "string") continue
    var entry = items[i].trim()
    if (entry === "") continue
    out.push(entry.length > 200 ? entry.substring(0, 200) : entry)
  }
  return out.length > 0 ? out : null
}

function normalizeStreetViewEnabled(raw) {
  var value = svBoolish(raw)
  return value === null ? true : value
}

// The user's own API key. It lives in shell.json, is never committed, and
// never reaches a prompt, a notification body, a log line, or the state file;
// the URLs carry it because that is how the API authenticates, and the URLs
// are argv elements only.
function normalizeKey(raw) {
  if (typeof raw !== "string") return ""
  var key = raw.trim()
  if (key === "") return ""
  return key.length > 200 ? key.substring(0, 200) : key
}

// The daily cap. Absent or unusable reads as the paranoid default (100), an
// explicit 0 is a hard pause, and only an explicit -1 removes the daily
// limit - the documented unlock, which the monthly cap still guards.
function normalizeCapPerDay(raw) {
  var n = svNumberish(raw)
  if (n === null) return SV_DEFAULT_DAILY_CAP
  if (n === -1) return -1
  if (n < 0) return SV_DEFAULT_DAILY_CAP
  return Math.floor(n)
}

// The monthly cap. Anything unusable or non-positive reads as the free
// ceiling; a value above 10000 is the user's explicit acceptance of paid
// overage, and is honored as stated - the warning already told them the
// price, and second-guessing it would break the unlock.
function normalizeMonthlyCap(raw) {
  var n = svNumberish(raw)
  if (n === null || n <= 0) return SV_FREE_MONTHLY
  return Math.floor(n)
}

function normalizeIntervalMinutes(raw) {
  var n = svNumberish(raw)
  if (n === null) return SV_DEFAULT_INTERVAL_MIN
  if (n < SV_MIN_INTERVAL_MIN) return SV_MIN_INTERVAL_MIN
  return Math.floor(n)
}

function normalizeSize(raw) {
  if (typeof raw !== "string") return SV_DEFAULT_SIZE
  var size = raw.trim()
  return /^[0-9]{1,5}x[0-9]{1,5}$/.test(size) ? size : SV_DEFAULT_SIZE
}

function normalizeLocations(raw) {
  var list = svRecoverList(raw)
  if (list === null) return DEFAULT_LOCATIONS.slice(0)
  return list
}

// The config object the gate reads, from any settings carrier (the widget's
// injected entry settings, or one entry found by extractConfig).
function configFromSettings(raw) {
  var s = raw && typeof raw === "object" ? raw : {}
  return {
    enabled: normalizeStreetViewEnabled(s.streetview),
    key: normalizeKey(s.streetviewKey),
    capPerDay: normalizeCapPerDay(s.streetviewCapPerDay),
    monthlyCap: normalizeMonthlyCap(s.streetviewMonthlyCap),
    intervalMinutes: normalizeIntervalMinutes(s.streetviewIntervalMinutes),
    size: normalizeSize(s.streetviewSize),
    locations: normalizeLocations(s.streetviewLocations)
  }
}

// The service has no settings injected - services get no bar slot - so it
// reads the same file the README documents as the settings surface, live, and
// finds the widget's entry by id. A missing entry, a bare id, or unreadable
// JSON all read as the defaults, which without a key cost nothing.
function extractConfig(shellJsonText, pluginId) {
  var parsed = null
  try { parsed = JSON.parse(String(shellJsonText === undefined || shellJsonText === null ? "" : shellJsonText)) }
  catch (e) { return configFromSettings({}) }
  if (!parsed || typeof parsed !== "object") return configFromSettings({})
  var bar = parsed.bar
  var layout = bar && typeof bar === "object" ? bar.layout : null
  if (!layout || typeof layout !== "object") return configFromSettings({})
  var id = String(pluginId === undefined || pluginId === null ? "" : pluginId)
  for (var section in layout) {
    var entries = layout[section]
    if (!Array.isArray(entries)) continue
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i]
      if (entry && typeof entry === "object" && String(entry.id) === id)
        return configFromSettings(entry)
    }
  }
  return configFromSettings({})
}

// --- the meter --------------------------------------------------------------

function stateBase(home) {
  return String(home || "") + "/.local/state/mount-monitor"
}

// The documented settings surface, read live: the same file the README names
// for every setting, because services get no injected settings slot.
function shellJsonPath(home) {
  return String(home || "") + "/.config/omarchy/shell.json"
}

function meterPath(home) {
  return stateBase(home) + "/streetview-meter.json"
}

function cacheDir(home) {
  return stateBase(home) + "/streetview"
}

function currentImagePath(home) {
  return cacheDir(home) + "/current.jpg"
}

function tmpImagePath(home) {
  return cacheDir(home) + "/current.jpg.tmp"
}

function emptyMeter() {
  return {
    version: 1,
    month: "",
    monthlyUsed: 0,
    day: "",
    dailyUsed: 0,
    cycle: 0,
    updatedAt: ""
  }
}

function svCount(value) {
  var n = svNumberish(value)
  if (n === null || n < 0) return 0
  return Math.floor(n)
}

// Read the meter file. Anything unreadable reads as an empty meter: the safe
// direction is always toward fewer billable calls. The meter file has one
// writer - the service, which counts loads; the widget only reads it. The
// widget's own bookkeeping (which cap warning has fired) lives in its own
// file below, so no file ever has two writers.
function parseMeter(text) {
  var fresh = emptyMeter()
  var raw = String(text === undefined || text === null ? "" : text).trim()
  if (raw === "") return fresh
  var parsed = null
  try { parsed = JSON.parse(raw) } catch (e) { return fresh }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fresh
  return {
    version: 1,
    month: typeof parsed.month === "string" ? parsed.month : "",
    monthlyUsed: svCount(parsed.monthlyUsed),
    day: typeof parsed.day === "string" ? parsed.day : "",
    dailyUsed: svCount(parsed.dailyUsed),
    cycle: svCount(parsed.cycle),
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : ""
  }
}

function serializeMeter(m, updatedAt) {
  var s = m || {}
  return JSON.stringify({
    version: 1,
    month: typeof s.month === "string" ? s.month : "",
    monthlyUsed: svCount(s.monthlyUsed),
    day: typeof s.day === "string" ? s.day : "",
    dailyUsed: svCount(s.dailyUsed),
    cycle: svCount(s.cycle),
    updatedAt: String(updatedAt || "")
  }, null, 2) + "\n"
}

// The local calendar keys, from an ISO stamp. An unusable clock yields "" -
// and the gate treats "" as "cannot verify the budget", which caps. A clock
// that cannot be read must never read as free headroom.
function svDateOf(iso) {
  var d = new Date(String(iso === undefined || iso === null ? "" : iso))
  return isNaN(d.getTime()) ? null : d
}

function svPad(n) {
  return n < 10 ? "0" + n : "" + n
}

function monthKeyOf(iso) {
  var d = svDateOf(iso)
  if (d === null) return ""
  return d.getFullYear() + "-" + svPad(d.getMonth() + 1)
}

function dayKeyOf(iso) {
  var d = svDateOf(iso)
  if (d === null) return ""
  return d.getFullYear() + "-" + svPad(d.getMonth() + 1) + "-" + svPad(d.getDate())
}

// The meter as it stands now: a stored key that differs from today's rolls
// that counter. Evaluated at every read, so a suspend across midnight or
// month's end cannot leak last period's budget, and the widget's read sees
// the same roll the service's write would.
function meterForNow(m, iso) {
  var s = m || emptyMeter()
  var month = monthKeyOf(iso)
  var day = dayKeyOf(iso)
  var out = {
    version: 1,
    month: typeof s.month === "string" ? s.month : "",
    monthlyUsed: svCount(s.monthlyUsed),
    day: typeof s.day === "string" ? s.day : "",
    dailyUsed: svCount(s.dailyUsed),
    cycle: svCount(s.cycle),
    updatedAt: typeof s.updatedAt === "string" ? s.updatedAt : ""
  }
  if (month !== "" && out.month !== month) {
    out.month = month
    out.monthlyUsed = 0
  }
  if (day !== "" && out.day !== day) {
    out.day = day
    out.dailyUsed = 0
  }
  return out
}

// Count the load. Called BEFORE the billable request is built: a fetch is
// never sent without its increment already in the meter, and a failed
// download is not refunded - under-counting risks a real bill, over-counting
// costs only free headroom.
function recordLoad(m, iso) {
  var out = meterForNow(m, iso)
  out.monthlyUsed += 1
  out.dailyUsed += 1
  out.cycle += 1
  out.updatedAt = String(iso || "")
  return out
}

// Advance the rotation without counting a load: the metadata answer said no
// coverage, so the next tick should try the next location instead of asking
// the same uncovered place again. A load costs nothing here - that is the
// point of the free endpoint.
function advanceCycle(m, iso) {
  var out = meterForNow(m, iso)
  out.cycle += 1
  out.updatedAt = String(iso || "")
  return out
}

function formatInt(n) {
  var v = Math.floor(Number(n))
  if (!isFinite(v) || v < 0) return "0"
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

// --- the gate ---------------------------------------------------------------

// Whether a fetch may go out at all. Every reason is a refusal except "ok";
// "clock" caps because an unreadable calendar must never read as free.
function hasHeadroom(m, config, iso) {
  var c = config || {}
  if (c.enabled !== true) return { ok: false, reason: "off" }
  if (!c.key) return { ok: false, reason: "nokey" }
  var month = monthKeyOf(iso)
  var day = dayKeyOf(iso)
  if (month === "" || day === "") return { ok: false, reason: "clock" }
  var s = meterForNow(m, iso)
  if (s.monthlyUsed >= (c.monthlyCap || SV_FREE_MONTHLY)) return { ok: false, reason: "monthly" }
  if (c.capPerDay !== -1 && s.dailyUsed >= c.capPerDay) return { ok: false, reason: "daily" }
  return { ok: true, reason: "ok" }
}

// The episode a cap warning fires once for: the daily cap names its day, the
// monthly cap its month, and monthly wins when both are gone (it is the
// bigger fact, and it outlasts the day). "" when there is room.
function capEpisode(m, config, iso) {
  var h = hasHeadroom(m, config, iso)
  if (h.ok) return ""
  if (h.reason === "monthly") return "m:" + monthKeyOf(iso)
  if (h.reason === "daily") return "d:" + dayKeyOf(iso)
  return ""
}

function usageLine(m, config, iso) {
  var c = config || {}
  var s = meterForNow(m, iso)
  var cap = c.monthlyCap || SV_FREE_MONTHLY
  var pct = Math.round((s.monthlyUsed / cap) * 100)
  return formatInt(s.monthlyUsed) + " / " + formatInt(cap) + " free loads (" + pct + "% this month)"
}

function todayLine(m, config, iso) {
  var c = config || {}
  var s = meterForNow(m, iso)
  if (c.capPerDay === -1) return formatInt(s.dailyUsed) + " today, no daily cap"
  return formatInt(s.dailyUsed) + "/" + formatInt(c.capPerDay) + " today"
}

// --- the plans: the quota guard itself ---------------------------------------
//
// plan() and imagePlan() are the ONLY place a request is built, and QML
// executes what they return. When the meter says capped, the plan carries no
// argv field at all - the fetch is not merely refused, it is never built. The
// metadata endpoint (free, unlimited) gates every billable load behind a
// coverage answer, and it only runs inside the headroom check: a capped month
// makes zero requests, free ones included, because there is nothing a
// metadata answer could be used for.

function metadataUrl(location, key, size) {
  return "https://maps.googleapis.com/maps/api/streetview/metadata?location=" +
    encodeURIComponent(location) + "&size=" + encodeURIComponent(size) +
    "&source=outdoor&key=" + encodeURIComponent(key)
}

function imageUrl(location, key, size, heading) {
  return "https://maps.googleapis.com/maps/api/streetview?location=" +
    encodeURIComponent(location) + "&size=" + encodeURIComponent(size) +
    "&source=outdoor&fov=90&heading=" + encodeURIComponent(String(heading)) +
    "&key=" + encodeURIComponent(key)
}

function metadataArgs(url) {
  return ["curl", "-fsS", "--max-time", "15", String(url)]
}

function imageArgs(url, path) {
  return ["curl", "-fsS", "--max-time", "60", "-o", String(path), String(url)]
}

// Four headings per location, from the cycle counter: one place is not one
// photo forever, and a second view costs one load only when it is fetched.
function headingFor(cycle) {
  var c = svCount(cycle) % 4
  return String(c * 90)
}

// One tick's decision. Exactly one action comes back:
//   off     - feature disabled or no key: nothing exists to send.
//   capped  - a meter is spent (or the clock unreadable): NO argv field.
//   metadata- the free coverage check, headroom having been verified first.
function plan(m, config, iso) {
  var h = hasHeadroom(m, config, iso)
  if (h.reason === "off") return { action: "off" }
  if (h.reason === "nokey") return { action: "off" }
  if (!h.ok) {
    return {
      action: "capped",
      reason: h.reason,
      usageLine: usageLine(m, config, iso),
      episode: capEpisode(m, config, iso)
    }
  }
  var s = meterForNow(m, iso)
  var c = config
  // A caller that bypassed configFromSettings could hand an empty rotation;
  // an empty rotation must fall back to the built-in list, never to NaN.
  var locations = c.locations && c.locations.length > 0 ? c.locations : DEFAULT_LOCATIONS.slice(0)
  var index = s.cycle % locations.length
  return {
    action: "metadata",
    argv: metadataArgs(metadataUrl(locations[index], c.key, c.size)),
    location: locations[index],
    index: index
  }
}

// The metadata answer as a decision. Only status OK covers; ZERO_RESULTS,
// REQUEST_DENIED, a network miss, and garbage all leave the billable endpoint
// untouched.
function coveredFromMetadata(text) {
  var parsed = null
  try { parsed = JSON.parse(String(text === undefined || text === null ? "" : text)) }
  catch (e) { return { covered: false, status: "" } }
  if (!parsed || typeof parsed !== "object") return { covered: false, status: "" }
  var status = typeof parsed.status === "string" ? parsed.status : ""
  return { covered: status === "OK", status: status }
}

// The billable step, reached only after the metadata said covered - and it
// re-checks the meter anyway, because the second gate must hold even if a
// caller skips the first. The returned meter is the already-incremented one
// to persist BEFORE the request goes out.
function imagePlan(location, m, config, iso, home) {
  var h = hasHeadroom(m, config, iso)
  if (!h.ok) {
    return {
      action: "capped",
      reason: h.reason,
      usageLine: usageLine(m, config, iso),
      episode: capEpisode(m, config, iso)
    }
  }
  var s = meterForNow(m, iso)
  var c = config
  var tmp = tmpImagePath(home)
  return {
    action: "image",
    argv: imageArgs(imageUrl(location, c.key, c.size, headingFor(s.cycle)), tmp),
    path: tmp,
    meter: recordLoad(s, iso),
    moveArgs: ["mv", "-f", tmp, currentImagePath(home)],
    wallpaperArgs: ["omarchy-theme-bg-set", currentImagePath(home)]
  }
}

// --- wiring constants ---------------------------------------------------------

function mkdirArgs(home) {
  return ["mkdir", "-p", cacheDir(home)]
}

function tickMs(minutes) {
  var n = svNumberish(minutes)
  if (n === null || n < SV_MIN_INTERVAL_MIN) n = SV_MIN_INTERVAL_MIN
  return Math.floor(n) * 60 * 1000
}

// The first fetch waits out the login storm: the desktop should not spend the
// meter's headroom on a boot-time race with the network.
function startupDelayMs() {
  return 90000
}

// --- the copy -----------------------------------------------------------------
//
// Fixed sentences, the same rule as every other notification kind: a
// location name never enters one (the plan carries it, the URL carries it,
// and neither is copy), the key never enters one, and the numbers ride in as
// arguments this module itself formatted.

function capWarningTitle() {
  return "Mount Monitor — Street View cap reached"
}

function capWarningAction() {
  return "Stay capped or unlock paid usage"
}

// The captain's requirement 4, verbatim in substance: two options - stay
// capped (the wallpaper keeps the last cached image) or unlock paid usage
// (their billing, their risk).
function capWarningBody(usageLine, reason) {
  var until = reason === "monthly"
    ? "until next month"
    : "until tomorrow"
  return "Street View wallpaper: " + String(usageLine || "") + " — the cap is reached, so the wallpaper " +
         "keeps your last Street View image " + until + ". Click to stay capped or unlock paid usage " +
         "(your billing, your risk)."
}

function capWarningPrompt(usageLine, reason) {
  var window = reason === "monthly" ? "next month" : "tomorrow"
  return "Mount Monitor: the Street View wallpaper hit its usage cap (" + String(usageLine || "") +
    ", reached " + (reason === "monthly" ? "for this month" : "for today") + "). Run the streetview-wallpaper " +
    "skill: report the usage, then present the captain two options and apply only the one they pick. " +
    "Stay capped: change nothing - the wallpaper keeps the last cached image until " + window + ". " +
    "Unlock paid usage: edit the widget's entry in ~/.config/omarchy/shell.json at the captain's word - " +
    "raise streetviewMonthlyCap above 10,000 (Google's free ceiling; beyond that it is $7 per 1,000 loads) " +
    "or set streetviewCapPerDay to -1 to drop the daily limit. Their billing, their risk."
}

function statusTitle() {
  return "Mount Monitor — Street View wallpaper"
}

function statusBody(m, config, iso) {
  var c = config || {}
  return "Street View wallpaper: " + usageLine(m, c, iso) + " · " + todayLine(m, c, iso) +
    " · changes every " + c.intervalMinutes + " minutes. " + SV_OVERAGE_NOTE + "."
}

// The whole status popup, normal urgency, no action to answer - it reports,
// it does not ask. Built here so QML carries no copy and no argv literal.
function statusArgs(m, config, iso) {
  return ["notify-send", "-u", "normal", "-t", "8000", statusTitle(), statusBody(m, config, iso)]
}

// Which cap is spent, for the copy: "daily", "monthly", or "" (including
// when the clock is unreadable - a broken clock must not nag, it must only
// refuse to spend).
function capReason(m, config, iso) {
  var h = hasHeadroom(m, config, iso)
  if (h.reason === "monthly" || h.reason === "daily") return h.reason
  return ""
}

// The widget's own bookkeeping file: which cap-warning episode has already
// fired. One writer (the widget), read on load, so a warning fires once per
// episode across shell restarts, not once per tick.
function capStatePath(home) {
  return stateBase(home) + "/streetview-cap.json"
}

function parseCapState(text) {
  var fresh = { episode: "" }
  var raw = String(text === undefined || text === null ? "" : text).trim()
  if (raw === "") return fresh
  var parsed = null
  try { parsed = JSON.parse(raw) } catch (e) { return fresh }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fresh
  return { episode: typeof parsed.episode === "string" ? parsed.episode : "" }
}

function serializeCapState(state) {
  var s = state || {}
  return JSON.stringify({ version: 1, episode: typeof s.episode === "string" ? s.episode : "" }, null, 2) + "\n"
}
