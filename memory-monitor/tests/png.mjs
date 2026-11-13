// A tiny PNG reader shared by the tests that look at pixels: the offscreen Qt
// probe's grabbed emblem (tests/symbol-probe.test.mjs) and the toast logo
// assets the plugin ships in icons/ (tests/round8.test.mjs, ruling 6). Both
// need the same thing - decode an RGBA8888/RGB888 PNG with node:zlib, no
// dependencies, and say where the ink actually is.
import { inflateSync } from "node:zlib";

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

export { decodePng, countColored, coloredBounds };
