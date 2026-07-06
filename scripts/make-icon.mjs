// Generates the app icon (buildResources/icon.ico + icon.png) with zero
// image dependencies: pixels are drawn in a buffer, encoded as PNG using
// node:zlib, and wrapped in an ICO container (PNG-in-ICO, Vista+).
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'buildResources');
fs.mkdirSync(outDir, { recursive: true });

const S = 256;
const img = Buffer.alloc(S * S * 4); // RGBA

function blend(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= S || y >= S || a <= 0) return;
  const i = (y * S + x) * 4;
  const na = a / 255;
  img[i] = Math.round(r * na + img[i] * (1 - na));
  img[i + 1] = Math.round(g * na + img[i + 1] * (1 - na));
  img[i + 2] = Math.round(b * na + img[i + 2] * (1 - na));
  img[i + 3] = Math.min(255, Math.round(a + img[i + 3] * (1 - na)));
}

// Coverage (0..1) of a pixel inside a rounded rectangle, with ~1px AA edge.
function roundedRectCoverage(px, py, x0, y0, w, h, radius) {
  const x1 = x0 + w;
  const y1 = y0 + h;
  const cx = Math.max(x0 + radius, Math.min(px + 0.5, x1 - radius));
  const cy = Math.max(y0 + radius, Math.min(py + 0.5, y1 - radius));
  const dx = px + 0.5 - cx;
  const dy = py + 0.5 - cy;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (px + 0.5 < x0 || px + 0.5 > x1 || py + 0.5 < y0 || py + 0.5 > y1) return 0;
  return Math.max(0, Math.min(1, radius - dist + 0.5));
}

function fillRoundedRect(x0, y0, w, h, radius, colorAt) {
  for (let y = Math.floor(y0) - 1; y <= Math.ceil(y0 + h) + 1; y++) {
    for (let x = Math.floor(x0) - 1; x <= Math.ceil(x0 + w) + 1; x++) {
      const cov = roundedRectCoverage(x, y, x0, y0, w, h, radius);
      if (cov > 0) {
        const [r, g, b, a] = colorAt(x, y);
        blend(x, y, r, g, b, a * cov);
      }
    }
  }
}

// Background: rounded square with a vertical emerald gradient.
const M = 10;
fillRoundedRect(M, M, S - 2 * M, S - 2 * M, 54, (_x, y) => {
  const t = Math.max(0, Math.min(1, (y - M) / (S - 2 * M)));
  const r = Math.round(52 + (4 - 52) * t);
  const g = Math.round(211 + (120 - 211) * t);
  const b = Math.round(153 + (87 - 153) * t);
  return [r, g, b, 255];
});

// Three ascending bars (white, slightly translucent to full).
const baseline = 204;
const barW = 34;
const bars = [
  { x: 60, h: 66, a: 225 },
  { x: 111, h: 106, a: 240 },
  { x: 162, h: 148, a: 255 },
];
for (const bar of bars) {
  fillRoundedRect(bar.x, baseline - bar.h, barW, bar.h, 8, () => [255, 255, 255, bar.a]);
}

// ---------- PNG encoding ----------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
// bytes 10-12: compression/filter/interlace = 0

const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0; // filter: none
  img.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

// ---------- ICO container (single 256x256 PNG entry) ----------

const icoHeader = Buffer.from([0, 0, 1, 0, 1, 0]);
const entry = Buffer.alloc(16);
entry[0] = 0; // width 256
entry[1] = 0; // height 256
entry[4] = 1; // planes
entry[6] = 32; // bpp
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(22, 12); // offset: 6 header + 16 entry

fs.writeFileSync(path.join(outDir, 'icon.ico'), Buffer.concat([icoHeader, entry, png]));
fs.writeFileSync(path.join(outDir, 'icon.png'), png);
console.log('Wrote buildResources/icon.ico and icon.png');
