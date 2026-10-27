# Plan: a plugged drive gets its notice in seconds, not on the next sweep

Captain's report (USB test 2026-10-26): a newly plugged drive took 30-60 seconds
to get its notice. Detection only lands on the 60-second polling tick, because
the widget asks `lsblk` on a timer and nothing else ever asks.

## Measured on this rig before touching anything

Ran `udevadm monitor --kernel --subsystem-match=block` as the ordinary user (no
root, no polkit), and generated real block events with `udisksctl loop-setup` on
a raw image in `/tmp` (unmounted, filesystem-less, deleted afterwards):

```
KERNEL[204133.541265] change   /devices/virtual/block/loop0 (block)
KERNEL[204133.554137] change   /devices/virtual/block/loop0 (block)
KERNEL[204133.554193] add      /devices/virtual/block/loop0/loop0p1 (block)
KERNEL[204133.554347] change   /devices/virtual/block/loop0 (block)
```

- The kernel's own block uevents arrive **unprivileged**, and one plug is a
  **burst**: four lines inside 13 ms. A naive "rescan on every line" is four
  scans for one drive.
- Delivered through Quickshell: `Process` + `SplitParser { splitMarker: "\n" }`
  handed each line to QML **~10 ms** after `udisksctl loop-setup` returned
  (measured with wall-clock stamps on both sides). The first chunk arrived as
  `"\nKERNEL[…]"` — the blank line after udevadm's banner glued to the first
  event — so the parser has to trim, not assume a clean line.
- `udisks2` mounted a vfat loop **~70 ms** after the last kernel uevent
  (`lsblk` polled at 100 ms). So the mount that makes a plugged drive a
  *candidate* is not itself a block event: nothing in the uevent stream says
  "now it is mounted". A rescan fired the instant the burst goes quiet can
  still land before the mount exists, find no `MOUNTPOINT`, and report nothing.
- Mounting a filesystem emits **no** block uevent on this kernel (verified: a
  mounted vfat loop produced only the `change` lines from the setup itself). So
  there is no event to wait for; the only honest answer is a second rescan.

## Fix

`mounts.js` owns the new decisions, `MountMonitor.qml` keeps the state and the
processes, as always.

1. **`udevArgs()`** — `["udevadm", "monitor", "--kernel", "--subsystem-match=block"]`:
   the kernel source (earliest signal, no root needed), filtered to the block
   subsystem so a USB stick's `usb`/`scsi`/`mmc` lines do not wake the widget.
2. **`parseUdevEvent(line)` / `isBlockEvent(line)`** — one udevadm line in, an
   `{ source, action, devpath, subsystem }` or `null`. udevadm's own banner
   (`monitor will print the received events for:`, `KERNEL - the kernel uevent`),
   blank lines, and the leading-newline chunk Quickshell actually delivers all
   read as `null`. Any action on the block subsystem counts — `add`, `change`,
   `remove`, `bind`, `unbind` — because a replug of a device the kernel already
   knows emits only `change` (measured above: the second `loop-setup` of the same
   loop device produced no `add`), and an unplug is a `remove` the widget wants
   too.
3. **`rescanDelayMs(now, first, last)`** — the burst rule: fire once the burst
   has been quiet for `UDEV_QUIET_MS`, but never hold a rescan past
   `UDEV_MAX_WAIT_MS` from the burst's first event. A burst that never stops
   still rescans; a burst of four lines in 13 ms is one rescan.
4. **`udevSettleMs()`** — one more rescan after the first, because of the
   measured 70 ms-to-mount gap: the first rescan catches the device, the settle
   rescan catches the automount.
5. **`udevRestartDelayMs(attempt)` / `udevRestartTries()` / `udevStableMs()`** —
   the monitor is long-running, so a `udevadm` that dies is restarted with a
   widening delay and given up on after a bounded number of tries. Giving up is
   not a loss of detection: the 60-second sweep never stopped running. A monitor
   that stayed up at least `udevStableMs()` resets the counter, so a healthy
   month does not spend the retries of a later one-off death.
6. **`normalizeBool`-read `detectEvents` setting** (default true) — the plugin now
   starts a long-running child process; the user gets an off switch.

`MountMonitor.qml`: a `Process` running `Mounts.udevArgs()` with a `SplitParser`
whose `onRead` calls `root.noteBlockEvent(line)`; a single-shot debounce `Timer`
whose interval is `Mounts.rescanDelayMs(...)`; a settle `Timer`; a restart
`Timer` driven by `Mounts.udevRestartDelayMs`; the existing 60-second `Timer`
untouched as the fallback sweep.

## Ripples, named and checked

- **Band alerts**: the same `root.refresh()` path (`dfProc` → `parseDf` →
  `checkBands`), so a configured mount that appears mid-session gets its ring
  and its 80/90/98 alert in seconds too. No change to thresholds, bands, the
  alert queue, or the watchdog.
- **Onboarding notices**: unchanged decisions — `newCandidates`, `annotateCandidates`,
  `recordDelivered`, the both-counts copy. What changes is only *when* the scan
  runs. A drive that goes away while its notice waits is still dropped by
  `candidateAlive`, and a `remove` event now makes that happen promptly instead
  of on the next sweep.
- **Click flow**: untouched. `notifyArgs`, the exec hint, `agentArgv`, both
  process lanes, the 120 s alert watchdog.
- **Read-only mounts**: untouched. A read-only mount that appears mid-session now
  alerts through the same path as any other.
- **State file**: `writeState` still writes only when the payload changed, so an
  event-driven rescan of an unchanged disk does not touch the file, and the
  FileView reload race guard (`reloadPending`) still applies.
- **Skills**: no installed-behaviour change. `partition-onboarding` still reports
  what the prompt brought and takes exactly one verification read; the prompt it
  receives is the same fixed copy.
- **Device-text contract**: no device string enters an instruction. A udev line's
  `devpath` and `subsystem` are used only to decide *whether to rescan* — they
  never reach a prompt, a body, an id, or the state file. `sanitizeText`,
  `mountId`, `isMountId`, `dataOpen`/`dataClose` are untouched, and
  `tests/label-injection.test.mjs` stays green.
- **findmnt unescape contract**: untouched; `parseRows` still decodes, and
  `tests/spaced-mountpoint.test.mjs` stays green. A spaced mountpoint on a
  replugged drive now draws its ring in seconds.

## Out of scope

Marketplace posting, thresholds, ring rendering, redesigning the onboarding flow,
changing the captain's notification copy, and the skills' installed behaviour
beyond what detection requires. Streamline observations from the click flow are
reported in the PR body, not implemented.
