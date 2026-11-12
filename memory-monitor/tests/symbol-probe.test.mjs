import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(HERE, "..");

// ---------------------------------------------------------------------------
// The round-7 item 13 probe: QuattroSymbol renders the check-engine emblem
// (quattro.js's own mil artwork) at the sizes the plugin actually draws it at,
// in a real Qt runtime, offscreen. The bug this pins: at 17px the emblem's
// bottom bar - a fill-only path with a ~1 unit tall colored region - rendered
// empty, so the bar logo lost its bottom line. The fix strokes every fill-only
// path with a hairline of its own color, so a thin fill can never drop out.
// The probe decodes the grabbed PNG with node:zlib (no dependencies) and
// requires colored pixels spanning the emblem's bottom quarter at the size
// that used to fail.
// ---------------------------------------------------------------------------

import { decodePng, countColored, coloredBounds } from "./png.mjs";


function probeGrab(size) {
  const dir = mkdtempSync(path.join(tmpdir(), "mil-probe-"));
  try {
    // The symbol and its data file sit beside the probe, the same
    // same-directory import the plugin's own directory import uses.
    writeFileSync(path.join(dir, "QuattroSymbol.qml"), readFileSync(path.join(PLUGIN, "QuattroSymbol.qml"), "utf8"));
    writeFileSync(path.join(dir, "quattro.js"), readFileSync(path.join(PLUGIN, "quattro.js"), "utf8"));
    const probe = path.join(dir, "probe.qml");
    writeFileSync(probe, [
      "import QtQuick",
      "Item {",
      "  id: root",
      `  width: ${size}; height: ${size}`,
      "  visible: true",
      "  QuattroSymbol {",
      "    anchors.fill: parent",
      '    symbol: "mil"',
      '    color: "#e3b341"',
      "  }",
      "  // The grab has to wait for the first rendered frame: a grab scheduled",
      "  // from Component.onCompleted races the scene graph and never fires.",
      "  Timer {",
      "    interval: 600; running: true",
      "    onTriggered: root.grabToImage(function(result) {",
      `      if (!result.saveToFile("${dir.replace(/\\/g, "/")}/grab.png")) Qt.exit(10)`,
      "      Qt.quit()",
      "    });",
      "  }",
      "}",
      "",
    ].join("\n"));
    const run = spawnSync("qml6", ["-platform", "offscreen", probe], {
      encoding: "utf8",
      timeout: 90000,
      maxBuffer: 8 * 1024 * 1024,
      env: Object.assign({}, process.env, { QT_QPA_PLATFORM: "offscreen", QT_QUICK_BACKEND: "software" }),
    });
    if (run.error) throw new Error(`offscreen probe failed: ${run.error}`);
    if (run.status !== 0) {
      const why = run.status === null ? "the probe timed out" : `the probe exited ${run.status}`;
      throw new Error(`offscreen probe failed: ${why}\nstdout: ${run.stdout}\nstderr: ${run.stderr}`);
    }
    return decodePng(readFileSync(path.join(dir, "grab.png")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const sizes = [17, 44];

for (const size of sizes) {
  test(`the check-engine emblem paints completely at ${size}px`, { skip: spawnSync("sh", ["-c", "command -v qml6"]).status !== 0 ? "qml6 is not on the box" : false }, () => {
    const image = probeGrab(size);
    const total = countColored(image);
    assert.ok(total > image.width * image.height * 0.04, `the emblem drew almost nothing at ${size}px (${total} colored pixels)`);
    // The bug: the bottom bar - the emblem's lowest stroked line - dropped out
    // at this size, leaving the bottom quarter of the artwork empty. Require
    // colored pixels across the bottom quarter of the emblem's own bounds.
    const bounds = coloredBounds(image);
    assert.ok(bounds !== null);
    const bottomStart = bounds.minY + Math.floor((bounds.maxY - bounds.minY + 1) * 0.75);
    let bottom = 0;
    for (let y = bottomStart; y <= bounds.maxY; y++) {
      for (let x = bounds.minX; x <= bounds.maxX; x++) {
        if (image.pixels[(y * image.width + x) * 4 + 3] > 40) bottom += 1;
      }
    }
    const quarterArea = (bounds.maxY - bottomStart + 1) * (bounds.maxX - bounds.minX + 1);
    assert.ok(bottom > quarterArea * 0.02, `the emblem's bottom quarter is empty at ${size}px (${bottom} of ${quarterArea}) - the round-7 item 13 bug`);
  });
}
