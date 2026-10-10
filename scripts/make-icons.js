/*
 * Generates PWA icons (pure Node, no dependencies).
 * Design: dark-purple gradient + white chat bubble with purple "typing" dots.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// --- minimal CRC32 ---
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function encodePNG(size, pixels) {
  const raw = Buffer.alloc(size * (1 + size * 3));
  for (let y = 0; y < size; y++) {
    raw[y * (1 + size * 3)] = 0; // filter: none
    pixels.copy(raw, y * (1 + size * 3) + 1, y * size * 3, (y + 1) * size * 3);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- drawing ---
function drawIcon(size) {
  const px = Buffer.alloc(size * size * 3);
  const set = (x, y, r, g, b) => {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 3;
    px[i] = r; px[i + 1] = g; px[i + 2] = b;
  };
  // background: vertical gradient #2a1350 -> #150b26
  for (let y = 0; y < size; y++) {
    const t = y / (size - 1);
    const r = Math.round(42 + (21 - 42) * t);
    const g = Math.round(19 + (11 - 19) * t);
    const b = Math.round(80 + (38 - 80) * t);
    for (let x = 0; x < size; x++) set(x, y, r, g, b);
  }
  const WHITE = [255, 255, 255], PURPLE = [139, 92, 246];
  // chat bubble: rounded rect
  const bw = size * 0.62, bh = size * 0.46, rad = size * 0.1;
  const bx = (size - bw) / 2, by = (size - bh) / 2 - size * 0.03;
  const inRound = (x, y) => {
    const cx = Math.min(Math.max(x, bx + rad), bx + bw - rad);
    const cy = Math.min(Math.max(y, by + rad), by + bh - rad);
    const dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy <= rad * rad ||
      (x >= bx && x <= bx + bw && y >= by && y <= by + bh);
  };
  for (let y = Math.floor(by); y < by + bh; y++)
    for (let x = Math.floor(bx); x < bx + bw; x++)
      if (inRound(x, y)) set(x, y, ...WHITE);
  // bubble tail (triangle, bottom-left)
  const tx = bx + bw * 0.22, ty = by + bh;
  const tailH = size * 0.12;
  for (let r = 0; r < tailH; r++) {
    const w = (bw * 0.16) * (1 - r / tailH);
    for (let x = Math.floor(tx - w); x < tx; x++) set(x, Math.floor(ty + r), ...WHITE);
  }
  // three typing dots
  const dotR = size * 0.035, cy0 = by + bh / 2;
  [-1, 0, 1].forEach((k) => {
    const cx = size / 2 + k * size * 0.11;
    for (let y = Math.floor(cy0 - dotR); y < cy0 + dotR; y++)
      for (let x = Math.floor(cx - dotR); x < cx + dotR; x++) {
        const dx = x - cx, dy = y - cy0;
        if (dx * dx + dy * dy <= dotR * dotR) set(x, y, ...PURPLE);
      }
  });
  return px;
}

const outDir = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['icon-maskable-512.png', 512]]) {
  fs.writeFileSync(path.join(outDir, name), encodePNG(size, drawIcon(size)));
  console.log('wrote', name);
}
