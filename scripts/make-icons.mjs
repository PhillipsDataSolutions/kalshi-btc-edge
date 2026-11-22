// Generates the PWA icons (no dependencies): dark tile, green ▲ and red ▼.
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4);
  c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
};

function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      // 4x supersampling
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < 2; sy++)
        for (let sx = 0; sx < 2; sx++) {
          const p = pixel((x + (sx + 0.5) / 2) / size, (y + (sy + 0.5) / 2) / size);
          r += p[0]; g += p[1]; b += p[2]; a += p[3];
        }
      const o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = r / 4; raw[o + 1] = g / 4; raw[o + 2] = b / 4; raw[o + 3] = a / 4;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const BG = [11, 13, 16, 255];
const UP = [34, 197, 94, 255];
const DOWN = [244, 63, 94, 255];
const LINE = [107, 115, 128, 255];

// Triangle test
const inTri = (x, y, ax, ay, bx, by, cx, cy) => {
  const d = (px, py, qx, qy, rx, ry) => (px - rx) * (qy - ry) - (qx - rx) * (py - ry);
  const d1 = d(x, y, ax, ay, bx, by), d2 = d(x, y, bx, by, cx, cy), d3 = d(x, y, cx, cy, ax, ay);
  const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
};

function art(scale) {
  // scale < 1 shrinks artwork toward centre (maskable safe zone)
  return (u, v) => {
    const x = (u - 0.5) / scale + 0.5;
    const y = (v - 0.5) / scale + 0.5;
    if (inTri(x, y, 0.5, 0.16, 0.25, 0.44, 0.75, 0.44)) return UP;
    if (inTri(x, y, 0.5, 0.84, 0.25, 0.56, 0.75, 0.56)) return DOWN;
    if (y > 0.488 && y < 0.512 && x > 0.18 && x < 0.82) return LINE;
    return BG;
  };
}

mkdirSync("public/icons", { recursive: true });
writeFileSync("public/icons/icon-192.png", png(192, art(1)));
writeFileSync("public/icons/icon-512.png", png(512, art(1)));
writeFileSync("public/icons/icon-maskable-512.png", png(512, art(0.78)));
writeFileSync("public/icons/apple-touch-icon.png", png(180, art(0.9)));
console.log("icons written");
