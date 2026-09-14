#!/usr/bin/env node
/**
 * 生成 `assets/og-image.png`（240×240 分享缩略图）。
 *
 * 用途：报告 `<head>` 的 `og:image` 指向 `${REPORT_BASE_URL}/og-image.png`，
 * 该文件由 CI 在发布前从本目录拷贝到站点根（daily.yml「站点根静态资源」步），
 * `scripts/build-site.mjs` 亦会拷贝。
 *
 * 为什么用脚本生成而不是放一张随意来源的图：仓库内的二进制资源必须有可复现来源，
 * 否则日后无人知道它是怎么来的、要不要更新。纯 Node stdlib（zlib 手写 PNG 编码），
 * 不引入任何图形依赖；4 倍超采样后盒式降采样做抗锯齿。
 *
 * Usage: node scripts/make-og-image.mjs
 */
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

const SIZE = 240;
const SS = 4; // 超采样倍数

const BG = [246, 245, 243]; // 浅底（与报告页 --bg 同族）
const CARD = [26, 26, 31]; // 深色卡片（与报告页 --fg 同族）
const BAR = [246, 245, 243];
const ACCENT = [217, 43, 43];

const W = SIZE * SS;
const buf = new Uint8Array(W * W * 3);
for (let i = 0; i < W * W; i++) {
  buf[i * 3] = BG[0];
  buf[i * 3 + 1] = BG[1];
  buf[i * 3 + 2] = BG[2];
}

function px(x, y, c) {
  if (x < 0 || y < 0 || x >= W || y >= W) return;
  const i = (y * W + x) * 3;
  buf[i] = c[0];
  buf[i + 1] = c[1];
  buf[i + 2] = c[2];
}

/** 圆角矩形：取到内矩形最近点，距离 ≤ r 即落在内部（标准做法，四点对称）。 */
function roundRect(x0, y0, w, h, r, c) {
  const x1 = x0 + w - 1;
  const y1 = y0 + h - 1;
  for (let y = y0 - r; y <= y1 + r; y++) {
    for (let x = x0 - r; x <= x1 + r; x++) {
      const cx = Math.min(Math.max(x, x0 + r), x1 - r);
      const cy = Math.min(Math.max(y, y0 + r), y1 - r);
      if (Math.hypot(x - cx, y - cy) <= r + 0.5) px(x, y, c);
    }
  }
}

roundRect(36 * SS, 36 * SS, 168 * SS, 168 * SS, 30 * SS, CARD); // 卡片
roundRect(64 * SS, 74 * SS, 54 * SS, 13 * SS, 6 * SS, ACCENT); // 强调条
roundRect(64 * SS, 104 * SS, 112 * SS, 12 * SS, 6 * SS, BAR); // 正文条 ×3
roundRect(64 * SS, 128 * SS, 112 * SS, 12 * SS, 6 * SS, BAR);
roundRect(64 * SS, 152 * SS, 74 * SS, 12 * SS, 6 * SS, BAR);

// 降采样（盒式平均）
const out = Buffer.alloc(SIZE * SIZE * 3);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * W + (x * SS + sx)) * 3;
        r += buf[i];
        g += buf[i + 1];
        b += buf[i + 2];
      }
    }
    const n = SS * SS;
    const o = (y * SIZE + x) * 3;
    out[o] = Math.round(r / n);
    out[o + 1] = Math.round(g / n);
    out[o + 2] = Math.round(b / n);
  }
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(b) {
  let c = -1;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // truecolor
const raw = Buffer.alloc(SIZE * (SIZE * 3 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 3 + 1)] = 0; // filter: none
  out.copy(raw, y * (SIZE * 3 + 1) + 1, y * SIZE * 3, (y + 1) * SIZE * 3);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

mkdirSync("assets", { recursive: true });
writeFileSync("assets/og-image.png", png);
console.log(`✅ assets/og-image.png（${SIZE}×${SIZE}, ${png.length} bytes）`);
