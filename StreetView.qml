import QtQuick
import Quickshell
import Quickshell.Io
import "streetview.js" as StreetView

// Street View wallpaper service — the fetch half of the plugin's wallpaper
// feature. The bar widget (MountMonitor.qml) is the display half: it reads
// the meter this service writes, shows the usage line on hover, and relays
// the cap warning. This file is wiring only: every decision — the settings
// recovery, the meter math, the cap, the metadata-vs-paid gating, the
// fallback choice, every URL and argv, every sentence — lives in
// streetview.js, where the tests can hold it.
//
// The free-tier guarantee, enforced here by construction: each tick asks
// StreetView.plan() for one action, and a capped plan carries no argv at all
// — the request is not refused, it is never built. The free, unlimited
// metadata endpoint gates every billable load behind a coverage answer, and
// StreetView.imagePlan() re-checks the meter anyway. When the cap is spent
// the desktop simply keeps the wallpaper it already shows: the last cached
// Street View image, or the user's own wallpaper before the first fetch.
//
// Settings ride the widget's entry in ~/.config/omarchy/shell.json (the same
// entry the README documents), read live here because services get no bar
// slot injected: "streetview", "streetviewKey", "streetviewCapPerDay",
// "streetviewMonthlyCap", "streetviewIntervalMinutes", "streetviewSize",
// "streetviewLocations". The meter is
// ~/.local/state/mount-monitor/streetview-meter.json and this service is its
// only writer; the widget's own warned-episode bookkeeping lives in a file
// this service never touches.
Item {
  id: root

  // injected by the shell (shell.qml ensureService)
  property var shell
  property var manifest

  readonly property string home: Quickshell.env("HOME")
  // The plugin's own id, from its own manifest - the IPC target namespace and
  // the key that finds the widget's settings entry in shell.json.
  readonly property string pluginId: manifest && manifest.id ? String(manifest.id) : ""

  property var config: StreetView.extractConfig("", root.pluginId)
  property var meter: StreetView.parseMeter("")
  property string lastMeterWrite: ""
  // The image step between processes: moveArgs and wallpaperArgs travel with
  // the curl that produced them.
  property var pendingImage: null

  // One cycle at a time: a tick that lands while a fetch is in flight is
  // dropped, never queued - the next tick comes in thirty minutes.
  readonly property bool busy: metadataProc.running || imageProc.running
    || moveProc.running || wallpaperProc.running

  onConfigChanged: root.syncTimers()

  Component.onCompleted: {
    mkdirProc.running = true
    shellFile.reload()
    meterFile.reload()
  }

  // --- the tick ------------------------------------------------------------

  function syncTimers(): void {
    startupTimer.restart()
  }

  function tick(): void {
    if (root.busy) return
    var now = new Date().toISOString()
    // THE gate. Everything below exists to execute the plan this returns.
    var p = StreetView.plan(root.meter, root.config, now)
    if (p.action === "off") return
    if (p.action === "capped") return
    if (p.action !== "metadata") return
    metadataProc.location = p.location
    metadataProc.out = ""
    metadataProc.command = p.argv
    metadataProc.didStart = false
    metadataProc.running = true
  }

  function writeMeter(next): void {
    root.meter = next
    var payload = StreetView.serializeMeter(next, "")
    if (payload === root.lastMeterWrite) return
    root.lastMeterWrite = payload
    meterFile.setText(StreetView.serializeMeter(next, new Date().toISOString()))
  }

  // A status popup on demand: the usage line, the daily count, the interval.
  // It reports and asks for nothing, so no action and no agent ride on it.
  function showStatus(): void {
    svStatusProc.command = StreetView.statusArgs(root.meter, root.config, new Date().toISOString())
    svStatusProc.running = true
  }

  IpcHandler {
    target: root.pluginId !== "" ? root.pluginId : "io.github.jasonlnheath.mount-monitor"

    function status(): void {
      root.showStatus()
    }

    function next(): void {
      // The manual fetch goes through the same gate as the timer - a click
      // is not a loophole around the meter.
      root.tick()
    }
  }

  // --- settings ------------------------------------------------------------

  // The settings surface is the widget's bar entry in shell.json; services
  // get no injected settings, so the documented file is read live here. A
  // missing entry, a bare id, or unreadable JSON all read as the defaults,
  // which without a key cost nothing.
  FileView {
    id: shellFile
    path: StreetView.shellJsonPath(root.home)
    watchChanges: true
    printErrors: false
    onLoaded: root.config = StreetView.extractConfig(text(), root.pluginId)
    onFileChanged: reload()
    onLoadFailed: root.config = StreetView.extractConfig("", root.pluginId)
  }

  // --- the meter -----------------------------------------------------------

  FileView {
    id: meterFile
    path: StreetView.meterPath(root.home)
    watchChanges: true
    atomicWrites: true
    printErrors: false
    onLoaded: root.meter = StreetView.parseMeter(text())
    // Only this service writes the meter file; a reload after the write just
    // re-reads what this service put there, and an external edit is honored
    // the same way.
    onFileChanged: reload()
    onLoadFailed: root.meter = StreetView.parseMeter("")
  }

  // --- processes -----------------------------------------------------------

  Process {
    id: mkdirProc
    command: StreetView.mkdirArgs(root.home)
    stderr: StdioCollector {
      onStreamFinished: if (this.text.trim() !== "") console.warn("mount-monitor streetview: mkdir:", this.text.trim())
    }
  }

  Process {
    id: metadataProc
    command: ["true"]
    property string location: ""
    property bool didStart: false
    property string out: ""
    stdout: StdioCollector {
      onStreamFinished: metadataProc.out = this.text
    }
    stderr: StdioCollector {
      onStreamFinished: if (this.text.trim() !== "") console.warn("mount-monitor streetview: metadata:", this.text.trim())
    }
    onStarted: metadataProc.didStart = true
    onExited: function(exitCode) {
      // A network miss (non-zero exit) skips this tick without turning the
      // rotation: the next tick retries the same location. A coverage answer
      // - including "no coverage" - decides whether anything billable may
      // even be considered.
      if (exitCode !== 0) {
        console.warn("mount-monitor streetview: metadata call failed, skipping this tick")
        return
      }
      var covered = StreetView.coveredFromMetadata(metadataProc.out)
      if (!covered.covered) {
        // No coverage costs nothing by design: turn the rotation so the next
        // tick asks a different place, and never touch the billable endpoint.
        root.writeMeter(StreetView.advanceCycle(root.meter, new Date().toISOString()))
        return
      }
      var ip = StreetView.imagePlan(metadataProc.location, root.meter, new Date().toISOString(), root.home)
      if (ip.action !== "image") {
        // The second gate. Reached here it means the meter turned between the
        // two calls; the fallback is the same as any capped tick: nothing.
        console.warn("mount-monitor streetview: meter closed between metadata and image, staying capped")
        return
      }
      root.pendingImage = ip
      // Count before send: the incremented meter is on disk before curl runs.
      root.writeMeter(ip.meter)
      imageProc.didStart = false
      imageProc.command = ip.argv
      imageProc.running = true
    }
  }

  Process {
    id: imageProc
    command: ["true"]
    property bool didStart: false
    stderr: StdioCollector {
      onStreamFinished: if (this.text.trim() !== "") console.warn("mount-monitor streetview: image:", this.text.trim())
    }
    onStarted: imageProc.didStart = true
    onExited: function(exitCode) {
      var ip = root.pendingImage
      if (!ip) return
      if (exitCode !== 0) {
        // The load stays counted: it was sent, and under-counting is the one
        // direction this feature never allows. The wallpaper is untouched.
        root.pendingImage = null
        console.warn("mount-monitor streetview: image fetch failed; the load stays counted, wallpaper unchanged")
        return
      }
      moveProc.command = ip.moveArgs
      moveProc.running = true
    }
  }

  Process {
    id: moveProc
    command: ["true"]
    stderr: StdioCollector {
      onStreamFinished: if (this.text.trim() !== "") console.warn("mount-monitor streetview: mv:", this.text.trim())
    }
    onExited: function(exitCode) {
      var ip = root.pendingImage
      if (!ip) return
      if (exitCode !== 0) {
        root.pendingImage = null
        console.warn("mount-monitor streetview: could not move the image into place, wallpaper unchanged")
        return
      }
      wallpaperProc.command = ip.wallpaperArgs
      wallpaperProc.running = true
    }
  }

  Process {
    id: wallpaperProc
    command: ["true"]
    stderr: StdioCollector {
      onStreamFinished: if (this.text.trim() !== "") console.warn("mount-monitor streetview: wallpaper:", this.text.trim())
    }
    onExited: function(exitCode) {
      root.pendingImage = null
      if (exitCode !== 0)
        console.warn("mount-monitor streetview: the wallpaper setter failed; the image is cached, the wallpaper is unchanged")
    }
  }

  Process {
    id: svStatusProc
    command: ["true"]
    stderr: StdioCollector {
      onStreamFinished: if (this.text.trim() !== "") console.warn("mount-monitor streetview: status:", this.text.trim())
    }
  }

  // --- timers ---------------------------------------------------------------

  // The first fetch waits out the login storm (streetview.js owns the number);
  // then the interval from the settings, floored and defaulted in the module.
  Timer {
    id: startupTimer
    interval: StreetView.startupDelayMs()
    repeat: false
    onTriggered: {
      root.tick()
      tickTimer.restart()
    }
  }

  Timer {
    id: tickTimer
    interval: StreetView.tickMs(root.config.intervalMinutes)
    repeat: true
    running: false
    onTriggered: root.tick()
  }
}
