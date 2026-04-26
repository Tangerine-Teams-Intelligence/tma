#!/usr/bin/env node
/**
 * Generate placeholder PNG icons (16/32/48/128) — orange filled circle with a
 * tiny white wedge cutout to suggest a tangerine. Pure Node, zero deps:
 * we hand-roll a minimal PNG encoder so we don't need `canvas` or `sharp`
 * (which require native builds and slow CI).
 */

import { createHash } from 'node:crypto';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ICON_DIR = join(__dirname, '..', 'icons');

const ORANGE = [204, 85, 0]; // #CC5500
const WHITE = [255, 255, 255];
const TRANSPARENT = [0, 0, 0, 0];

function makePng(size) {
  // RGBA pixel buffer.
  const px = new Uint8Array(size * size * 4);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const r = size / 2 - 1;
  const wedgeR = r * 0.35;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const dx = x - cx;
      const dy = y - cy;
      const d2 = dx * dx + dy * dy;
      // A small white circle inset from the top to suggest a stem highlight.
      const stemDx = dx;
      const stemDy = dy + r * 0.55;
      const stemD2 = stemDx * stemDx + stemDy * stemDy;
      if (d2 <= r * r) {
        if (stemD2 <= wedgeR * wedgeR * 0.25) {
          px[i] = WHITE[0]; px[i + 1] = WHITE[1]; px[i + 2] = WHITE[2]; px[i + 3] = 255;
        } else {
          px[i] = ORANGE[0]; px[i + 1] = ORANGE[1]; px[i + 2] = ORANGE[2]; px[i + 3] = 255;
        }
      } else {
        px[i] = TRANSPARENT[0]; px[i + 1] = TRANSPARENT[1]; px[i + 2] = TRANSPARENT[2]; px[i + 3] = 0;
      }
    }
  }
  return encodePng(size, size, px);
}

function encodePng(width, height, rgba) {
  // PNG signature.
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  // IHDR.
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  // IDAT: each scanline prefixed with filter byte 0.
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });

  // IEND.
  const iend = Buffer.alloc(0);

  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', iend)]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = crc32(Buffer.concat([typeBuf, data]));
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

if (!existsSync(ICON_DIR)) mkdirSync(ICON_DIR, { recursive: true });

for (const size of [16, 32, 48, 128]) {
  const png = makePng(size);
  const out = join(ICON_DIR, `${size}.png`);
  writeFileSync(out, png);
  console.log(`wrote ${out} (${png.length} bytes, sha=${createHash('sha1').update(png).digest('hex').slice(0, 8)})`);
}
