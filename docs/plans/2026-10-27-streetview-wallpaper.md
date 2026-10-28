# Plan: a Street View wallpaper the free tier can never bill

Captain's ruling (Telegram lane): the credit-card-on-file requirement will kill
adoption, so the feature must GUARANTEE a genuinely free tier and make cost
control visible in the UI. The SKU is Static Street View (Essentials): 10,000
free panorama loads per month, then $7 per 1,000. The metadata endpoint is
always free and unlimited — it is the gate that keeps billable loads off
locations with no coverage.

## The shape, in this plugin

A wallpaper is not a bar widget, and Omarchy plugins can carry more than one
kind (`omarchy.media` is `service` + `bar-widget`). Mount Monitor gains a
`service` entry point — `StreetView.qml` — beside its bar widget. The service
periodically fetches a Street View panorama through the metered gate and hands
it to the desktop with `omarchy-theme-bg-set`, the official Omarchy wallpaper
setter (it updates the `~/.local/state/omarchy/current/background` symlink and
IPC-pushes the live shell). Capped or uncovered, nothing is sent and the
desktop keeps whatever it already shows.

All decisions live in a new plain top-level-function `streetview.js`
(`import "streetview.js" as StreetView` in QML, `node:vm` in tests — same
contract as `mounts.js`: no `export`, no `import`, no `.pragma library`). QML
holds wiring only.

## The builder calls (mine to make, stated)

1. **Two meters, one file, each guarding its own cap.** The free tier resets
   monthly, so the authoritative free-cap meter MUST be monthly — a daily
   meter alone cannot see a month's total. The daily meter exists because
   "100 a day" is what a person can reason about and what bounds a runaway
   interval setting. A fetch needs headroom in **both**. Rollover is by the
   machine's local calendar (`YYYY-MM` / `YYYY-MM-DD` keys in the meter
   file), evaluated at every read so a suspend across midnight or month's end
   cannot leak last month's budget.
2. **The paranoid default, out of the box:** daily cap **ON at 100/day** (the
   captain's own example), monthly cap **10000** (the free ceiling, hard),
   change interval **30 minutes** (≈48/day, headroom under the cap for manual
   "next now" IPC calls). No API key ships in the repo; without the user's
   own `streetviewKey` the service never sends anything at all, so the
   default posture costs nothing even before the caps are read.
3. **The unlock is a setting, and the warning says which one.** Raising
   `streetviewMonthlyCap` above 10000 — or setting `streetviewCapPerDay` to
   -1 — is the explicit "I accept overage at $7/1k" act, applied by the
   user (or the agent, at the user's word) in `~/.config/omarchy/shell.json`.
   The plugin never raises a cap itself, and never treats a missing cap as an
   unlock: absent reads as the paranoid default, because a typo must not
   turn into a bill. `streetviewCapPerDay: 0` stays a hard pause (zero
   fetches, zero requests of any kind).
4. **The "placeholder" is the wallpaper already on screen.** The service only
   ever sets the wallpaper after a gated fetch succeeds, so "last cached
   image" and "what is displayed" are the same thing by construction, and a
   capped month is a no-op. The plugin never draws its own art over the
   user's desktop, and before the first successful fetch the user's own
   wallpaper simply stays.
5. **Count before send.** The meter records the load, the incremented meter
   is persisted, and only then does the image request go out. A failed
   download is not refunded: under-counting risks a real bill, over-counting
   costs only free headroom. The guarantee is one-directional on purpose.

## The quota guard (the heart)

`StreetView.plan(meter, config, nowIso, ...)` is the single choke point
between the meter and the network. Per tick it returns exactly one of:

- `{ action: "off" }` — feature off or no key: nothing is built, nothing is sent.
- `{ action: "capped", reason, usageLine }` — monthly or daily budget spent:
  **no argv fields exist on this object at all.** The warning notice rides it.
- `{ action: "metadata", argv, location }` — the free metadata call; only
  reachable with headroom.
- `{ action: "skip", reason }` — metadata answered no-coverage or a network
  miss: no billable call, rotation advances.
- `{ action: "image", argv, path, meter }` — the billable call, carrying the
  already-incremented meter to persist first; only reachable after the
  metadata gate said covered, and never without headroom.

Enforcement is by test: for every capped meter shape the plan action is
`"capped"` with no argv; the metadata argv never names the image endpoint and
the image argv never names the metadata endpoint; an image plan always
carries a meter with the increment already in it; the key appears in exactly
one argv element (its URL) and in no other field. QML never builds a URL or
an argv — it executes what `plan()` returned.

The metadata gate exists to save billable loads, so it runs *inside* the
headroom check, not instead of it: a capped month makes zero requests, free
ones included — there is nothing a metadata answer could be used for.

## Settings (the existing surface, extended)

All on the widget's entry in `~/.config/omarchy/shell.json`, as the README
already documents for `mounts` — the service reads the same file live
(`FileView`, `watchChanges`, parse via `StreetView.extractConfig`, so an
unlock lands on the next tick without a shell restart):

- `streetview` — `true` unless set `false`; the off switch.
- `streetviewKey` — the user's own API key. Never committed, never echoed
  into a prompt, a notification, a log line, or the state file; the free-tier
  guarantee holds for user keys because the gate consults only the meter.
- `streetviewCapPerDay` — default `100`; `0` pauses hard; `-1` removes the
  daily limit (an unlock; the monthly cap still applies).
- `streetviewMonthlyCap` — default `10000`; above 10000 is the paid unlock;
  `0`, negative (except by the `-1`-means-unlimited rule above? no — monthly
  keeps it simple: anything ≤ 0 or unusable falls back to 10000), or garbage
  falls back to the free ceiling.
- `streetviewIntervalMinutes` — default `30`, floored at 5.
- `streetviewSize` — requested image size, `"<w>x<h>"` and regex-validated;
  default `"1920x1080"` (a size the API refuses fails the fetch and costs
  nothing, but the default is one it accepts).
- `streetviewLocations` — list of locations (addresses or `lat,lng`),
  defaulting to a small built-in rotation of fixed copy; read through the
  same `recoverList` lesson as `mounts` (Qt list wrappers).

Every one through a `normalize*` helper in `streetview.js` with the documented
fallback, so the Qt-list bug's lesson applies here from birth.

## Meter state

`~/.local/state/mount-monitor/streetview-meter.json` (`Mounts.stateDir` +
`/streetview-meter.json`), written by the service only, read by the widget:

```json
{ "version": 1, "month": "2026-10", "monthlyUsed": 214,
  "day": "2026-10-27", "dailyUsed": 3, "cycle": 17,
  "updatedAt": "..." }
```

One writer per file, decided during the build: the original sketch carried the
warning bookkeeping inside the meter, but the widget relays the warning while
the service counts the loads — a two-writer file invites lost updates in
exactly the direction that risks a bill. So the meter has one writer (the
service), and the widget's "which cap warnings have fired" memory lives in its
own `streetview-cap.json` (`{ episode: "d:2026-10-27" }`), which the service
never touches. Garbage or an unreadable file reads as an empty meter — the
safe direction is always toward fewer billable calls.

Images cache at `~/.local/state/mount-monitor/streetview/current.jpg`,
written to a temp name and moved atomically (the background renderer follows
the symlink, not the file's contents, so a stable name never tears).

## Usage display and the cap warning (requirements 2–4)

- `StreetView.usageLine(meter, config)` →
  `"3,214 / 10,000 free loads (32% this month)"` — thousands separators,
  percent of the effective monthly cap.
- **Bar**: an indicator button beside the rings, present only while the
  feature is enabled with a key; tooltip = usage line + today's count
  against the daily cap. The plugin's own visual language (rings + tooltips),
  and no clutter for anyone not using the feature.
- **Notification**: `omarchy-shell io.github.jasonlnheath.mount-monitor
  streetview status` sends the usage popup on demand; the cap warning carries
  the same line when it fires.
- **Cap warning** (requirement 4): a persistent, critical, never-expiring
  notice on the widget's existing `noticeProc` lane — a question nobody
  answered must not expire unseen, and must not hold band alerts, exactly
  like onboarding. Click → the agent, prompt fixed copy in `mounts.js`
  (kind `"streetview-cap"` joins the existing `promptFor`/`titleFor`/
  `bodyFor`/`actionFor`/`urgencyFor`/`timeoutFor` dispatch; every other kind
  already rides the same plumbing). The prompt presents the captain's two
  options verbatim in substance: stay capped (the wallpaper keeps the last
  cached image until the budget resets) or unlock paid usage (raise
  `streetviewMonthlyCap` above 10000 or set `streetviewCapPerDay` to -1 —
  their billing, their risk). It never contains the key, and a location name
  never enters a sentence.
- **Skill**: `skills/streetview-wallpaper/SKILL.md` — report usage from the
  meter file, apply cap changes the captain asks for, present the two options
  on a cap-warning click. Its wording and the prompt's agree, as the
  onboarding skills' do with theirs. It edits shell.json settings only; it
  never touches the key's secrecy, the meter file's counters, or the
  partition features.

## TDD order

1. `tests/streetview.test.mjs` first, red: the guard (capped ⇒ no argv, both
   directions of endpoint gating, count-before-send), meter rollover math,
   `usageLine` formatting, `extractConfig` incl. the Qt-list recovery and the
   paranoid fallbacks, metadata parsing (`OK` / `ZERO_RESULTS` / garbage),
   rotation, and the fixed copy (cap warning + status + skill agreement).
2. Then `streetview.js` green, then `mounts.js`'s `streetview-cap` dispatch
   (tests in the same file, loading both modules), then the QML wiring with
   delegation guards in the existing style: the widget queues the notice with
   the usage line `StreetView` computed and never invents one; the service
   executes plans and never builds a request itself; the meter is written
   only through `recordLoad` / `markCapNotified`.

## Ripples, named

- **tests**: new `tests/streetview.test.mjs` (seven settings, six in the
  original plan plus `streetviewSize`); delegation guards extended in
  it; `tests/run.sh` needs no change (it globs the directory and walks
  `skills/`, so the new skill and test file are picked up automatically).
- **install.sh**: no change — it walks `skills/*/`; verified, not edited.
- **mounts.js**: one new notification kind in the existing dispatch; the
  band-alert, onboarding, and device-text contracts untouched
  (`label-injection` and `spaced-mountpoint` stay green).
- **MountMonitor.qml**: meter `FileView`, indicator button, cap-warning
  relay; rings, bands, alert queue, watchdog, udev monitor untouched.
- **manifest.json**: `kinds` gains `"service"`, `entryPoints` gains
  `"service": "StreetView.qml"`, description gains one honest sentence about
  the wallpaper. **Version not bumped** (the captain's explicit word is
  required for that).
- **README.md**: the feature, the seven settings, the IPC calls, the meter
  file, the skill, and the remove-list line gaining the new skill.
- **AGENTS.md**: the new module's contract — the guard, the two meters, the
  paranoid defaults, count-before-send, the key's secrecy.
- **Marketplace listing**: no further update beyond the manifest sentence;
  out of scope beyond that per the brief.
- **State**: `streetview-meter.json` and the cache dir live under the
  existing `Mounts.stateDir`; the remove instructions gain them.

## Out of scope

Storage-pool rings (held task); any pricing logic beyond the two caps and
the $7/1k sentence in the copy (the plugin never computes a bill, only
refuses to spend); real-network tests (the metadata fixture is recorded
JSON; no key ships or runs in CI); a settingsForm QML (the Omarchy loader
for plugin settings forms is not verifiable from here — shell.json plus the
skill is the settings UI this repo already trusts); placeholder artwork.
