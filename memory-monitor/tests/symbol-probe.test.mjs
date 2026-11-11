import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";
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

// A small PNG decoder: enough for the RGBA8888 (or RGB888) images
// grabToImage writes - parse chunks, inflate the IDAT stream, undo the per-scanline
// filters, return { width, height, pixels } with pixels as a row-major RGBA
// byte array.
function decodePng(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buffer.subarray(0, 8).equals(signature)) throw new Error("not a PNG");
  let at = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat = [];
  while (at < buffer.length) {
    const length = buffer.readUInt32BE(at);
    const type = buffer.subarray(at + 4, at + 8).toString("ascii");
    const data = buffer.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
      if (colorType !== 6 && colorType !== 2) throw new Error(`unsupported color type ${colorType}`);
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    at += 12 + length;
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? cur[x - channels] : 0;
      const up = previous[x];
      const ul = x >= channels ? previous[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v = (v + left) & 0xff;
      else if (filter === 2) v = (v + up) & 0xff;
      else if (filter === 3) v = (v + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = left + up - ul;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - ul);
        v = (v + (pa <= pb && pa <= pc ? left : (pb <= pc ? up : ul))) & 0xff;
      } else if (filter !== 0) throw new Error(`unsupported filter ${filter}`);
      cur[x] = v;
    }
    for (let x = 0; x < width; x++) {
      out[(y * width + x) * 4] = cur[x * channels];
      out[(y * width + x) * 4 + 1] = cur[x * channels + 1];
      out[(y * width + x) * 4 + 2] = cur[x * channels + 2];
      out[(y * width + x) * 4 + 3] = channels === 4 ? cur[x * channels + 3] : 255;
    }
    previous = cur;
  }
  return { width, height, pixels: out };
}

// The palette's amber (#e3b341) and its reds (#e5484d, #ff3b30) and the white
// ink all differ from the transparent background this probe grabs against.
// Count a pixel colored when it is visibly not the background.
function countColored(image) {
  let n = 0;
  for (let i = 0; i < image.width * image.height; i++) {
    const a = image.pixels[i * 4 + 3];
    if (a > 40) n += 1;
  }
  return n;
}

function coloredBounds(image) {
  let minX = image.width;
  let minY = image.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.pixels[(y * image.width + x) * 4 + 3] > 40) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { minX, minY, maxX, maxY };
}

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
