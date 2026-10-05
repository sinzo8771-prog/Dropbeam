#!/usr/bin/env node
/**
 * Renders the PWA icons (PRD FR-50) to `public/icons/`.
 *
 * There is no image toolchain in this project and adding one for four squares
 * would be silly, so the icons are rasterised here: a tiny hand-written PNG
 * encoder over Node's built-in zlib. Output is deterministic — same bytes every
 * run — so re-running this never churns the repo or invalidates the precache.
 *
 *   node scripts/generate-icons.mjs
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "icons");

/** CRC-32 (PNG chunk checksum), table built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBytes, data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
}

/** Encode RGBA bytes (width*height*4) as a PNG buffer. */
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  // One filter byte (0 = None) per scanline.
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const at = y * (width * 4 + 1);
    raw[at] = 0;
    rgba.copy(raw, at + 1, y * width * 4, (y + 1) * width * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const PAPER = [246, 242, 234];
const INK = [27, 26, 23];
const ACCENT = [200, 56, 26];

/**
 * The mark: a beam of light crossing a beam of dark — the same idea as the
 * on-screen Beam component, reduced to two strokes.
 *
 * `padding` is the safe-area fraction a maskable icon needs so Android's
 * circular mask never clips the mark.
 */
function drawIcon(size, { padding = 0.18, background = PAPER } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  const inset = Math.round(size * padding);
  const span = size - inset * 2;
  const radius = Math.round(span * 0.22);
  const mid = Math.round(size / 2);

  const set = (x, y, [r, g, b], a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const at = (y * size + x) * 4;
    rgba[at] = r;
    rgba[at + 1] = g;
    rgba[at + 2] = b;
    rgba[at + 3] = a;
  };

  // Rounded background plate.
  for (let y = inset; y < size - inset; y++) {
    for (let x = inset; x < size - inset; x++) {
      const dx = Math.max(inset + radius - x - 1, x - (size - inset - radius - 1), 0);
      const dy = Math.max(inset + radius - y - 1, y - (size - inset - radius - 1), 0);
      if (dx === 0 || dy === 0 || dx * dx + dy * dy <= radius * radius) set(x, y, background);
    }
  }

  // Horizontal ink stroke across the middle: the "beam" being sent.
  const stroke = Math.max(2, Math.round(span * 0.1));
  for (let y = mid - Math.round(stroke / 2); y <= mid + Math.round(stroke / 2); y++) {
    for (let x = inset + Math.round(span * 0.12); x < size - inset - Math.round(span * 0.12); x++) {
      set(x, y, INK);
    }
  }

  // Accent dot on the right: the receiving device.
  const dotR = Math.round(span * 0.16);
  const dotX = Math.round(size - inset - span * 0.2);
  const dotY = mid;
  for (let y = dotY - dotR; y <= dotY + dotR; y++) {
    for (let x = dotX - dotR; x <= dotX + dotR; x++) {
      const d = (x - dotX) ** 2 + (y - dotY) ** 2;
      // One-pixel antialias on the rim keeps the circle from looking jagged.
      if (d <= dotR * dotR) set(x, y, ACCENT);
      else if (d <= (dotR + 1) * (dotR + 1) && background === PAPER) {
        const at = (y * size + x) * 4;
        if (rgba[at + 3] > 0) set(x, y, ACCENT, 200);
      }
    }
  }

  return encodePng(size, size, rgba);
}

const targets = [
  // Maskable icons need a generous safe area: Android crops to a circle.
  { name: "icon-192.png", size: 192 },
  { name: "icon-512.png", size: 512 },
  { name: "icon-maskable-512.png", size: 512, padding: 0.28 },
];

mkdirSync(OUT, { recursive: true });
for (const { name, size, padding } of targets) {
  const png = drawIcon(size, { padding: padding ?? 0.18 });
  writeFileSync(join(OUT, name), png);
  console.log(`${name}  ${size}x${size}  ${png.length} B`);
}