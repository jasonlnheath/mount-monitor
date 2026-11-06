import QtQuick

// The VRAM headroom telltale: a compact coolant-reservoir symbol whose filled
// level is the headroom the monitor computed - free VRAM above the user's
// floor, as a fraction of everything above the floor. One renderer for both
// the bar telltale and the popup's large instrument, so the picture has
// exactly one source. Everything it draws is handed to it: the fill fraction
// and the tint are Mounts decisions (vramHeadroomFrac, vramTokenFor), the way
// the ring's Canvas only draws the percentage the widget already resolved.
// The reservoir outline is stroked dimmer than the liquid, so the level reads
// before the tank does; the liquid's top edge carries a shallow fixed wave,
// the coolant-reservoir cue, drawn once - nothing animates, because a
// telltale that moves on its own is a telltale that lies.
Item {
  id: root

  // 0 = at the floor (empty), 1 = at capacity (full). Values outside are
  // already clamped by Mounts.vramHeadroomFrac; the drawing clamps again so a
  // misconfigured caller can never paint outside the tank.
  property real fill: 1
  property color tint: "#ffffff"

  Canvas {
    id: tank
    anchors.fill: parent
    onPaint: {
      var ctx = getContext("2d")
      ctx.reset()
      var w = width
      var h = height
      if (w < 2 || h < 2) return
      var lw = Math.max(1, Math.min(w, h) * 0.09)
      var m = lw * 1.1
      var x = m
      var y = m
      var iw = w - m * 2
      var ih = h - m * 2
      var r = Math.min(iw, ih) * 0.14

      var frac = root.fill
      if (!isFinite(frac)) frac = 0
      if (frac < 0) frac = 0
      if (frac > 1) frac = 1

      // tank outline
      ctx.beginPath()
      roundedRect(ctx, x, y, iw, ih, r)
      ctx.lineWidth = lw
      ctx.strokeStyle = root.tint
      ctx.globalAlpha = 0.45
      ctx.stroke()

      if (frac <= 0) return

      // liquid, from the inner bottom up to the fill level, kept inside the
      // stroke. A very low level draws a thin strip without a wave, because
      // the wave needs room the strip does not have.
      var level = y + ih * (1 - frac)
      var minLevel = y + ih - Math.max(lw * 0.75, ih * 0.06)
      var waveTop = Math.max(level, y + lw)
      var surface = Math.min(waveTop, minLevel)
      var amp = surface > minLevel - ih * 0.05 ? 0 : ih * 0.045

      ctx.beginPath()
      ctx.moveTo(x + lw / 2, y + ih - lw / 2)
      ctx.lineTo(x + lw / 2, surface + amp)
      if (amp > 0) {
        ctx.quadraticCurveTo(x + iw * 0.25, surface - amp, x + iw * 0.5, surface)
        ctx.quadraticCurveTo(x + iw * 0.75, surface + amp, x + iw - lw / 2, surface + amp)
      }
      ctx.lineTo(x + iw - lw / 2, y + ih - lw / 2)
      ctx.closePath()
      ctx.fillStyle = root.tint
      ctx.globalAlpha = 1.0
      ctx.fill()
    }

    function roundedRect(ctx, x, y, w, h, r) {
      ctx.moveTo(x + r, y)
      ctx.lineTo(x + w - r, y)
      ctx.arcTo(x + w, y, x + w, y + r, r)
      ctx.lineTo(x + w, y + h - r)
      ctx.arcTo(x + w, y + h, x + w - r, y + h, r)
      ctx.lineTo(x + r, y + h)
      ctx.arcTo(x, y + h, x, y + h - r, r)
      ctx.lineTo(x, y + r)
      ctx.arcTo(x, y, x + r, y, r)
    }

    Connections {
      target: root
      function onFillChanged() { tank.requestPaint() }
      function onTintChanged() { tank.requestPaint() }
    }
    Component.onCompleted: tank.requestPaint()
  }
}
