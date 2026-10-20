'use strict';
/**
 * gfx.js —— 把 SSD1306 显存（1024 B）解码成 ASCII 图 / PBM 图片（用户问题记录第 13 条）
 *
 * 为什么需要它：SSD1306 的 I2C 接口读不可靠，以前想确认「屏幕上到底画了什么」，
 * 只能自己写脚本读 1024 B 显存、再用工程字模逐格反推文字。这一步现在由工具做完：
 *   · readmem 已经能直读显存（不 halt）；
 *   · 这里把显存按 SSD1306 的页格式解成 128×64 的点阵，给 ASCII 图 + 标准 PBM（P4）文件。
 *
 * SSD1306 的显存布局（本工程用的就是它）：
 *   byte[page*128 + x] 的 bit0..bit7 = 第 page 页（8 行）里第 x 列的 8 个纵向像素，
 *   bit0 是最上面那一行。第 y 行属于 page = y >> 3，位 = y & 7。
 * 注意 bit=1 是「点亮」还是「熄灭」取决于面板的 COM 扫描/反色设置，所以 invert 可配。
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_WIDTH = 128;
const DEFAULT_HEIGHT = 64;

/** 显存 byte -> 位图：返回 { width, height, bits: Uint8Array(width*height) }，bits=1 表示该像素为 1 */
function decodeSsd1306(bytes, width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT) {
  const w = Number(width) || DEFAULT_WIDTH;
  const h = Number(height) || DEFAULT_HEIGHT;
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  const pages = Math.ceil(h / 8);
  const need = w * pages;
  const bits = new Uint8Array(w * h);
  if (buf.length < need) {
    throw new Error('显存数据不够：' + w + '×' + h + ' 需要 ' + need + ' B，只拿到 ' + buf.length + ' B');
  }
  for (let y = 0; y < h; y++) {
    const page = y >> 3;
    const bit = y & 7;
    for (let x = 0; x < w; x++) {
      const v = buf[page * w + x];
      bits[y * w + x] = (v >>> bit) & 1;
    }
  }
  return { width: w, height: h, bits };
}

/**
 * 转成 ASCII 图。默认一个像素一个字符（'#' 点亮 / '.' 熄灭），invert 取反。
 * 128 列宽在终端/工具结果里仍可读；不要缩放开字，否则画不出 1 像素宽的字。
 */
function toAscii(bitmap, opts = {}) {
  const { width, height, bits } = bitmap;
  const invert = !!opts.invert;
  const on = opts.onChar || '#';
  const off = opts.offChar || '.';
  const lines = [];
  for (let y = 0; y < height; y++) {
    let line = '';
    for (let x = 0; x < width; x++) {
      const bit = bits[y * width + x] ? 1 : 0;
      line += (invert ? 1 - bit : bit) ? on : off;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** 转标准 PBM（P4 位图，1 = 黑点）。PBM 的 bit1 是黑，所以 invert 决定高低电平方向。 */
function toPbm(bitmap, opts = {}) {
  const { width, height, bits } = bitmap;
  const invert = !!opts.invert;
  const rowBytes = Math.ceil(width / 8);
  const body = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bit = bits[y * width + x] ? 1 : 0;
      const dark = invert ? 1 - bit : bit;
      if (dark) body[y * rowBytes + (x >> 3)] |= 0x80 >>> (x & 7);
    }
  }
  return Buffer.concat([Buffer.from('P4\n' + width + ' ' + height + '\n', 'ascii'), body]);
}

/** 写 PBM 文件（落在工程的 .dsh-mcu/tmp 下；返回绝对路径） */
function writePbm(bitmap, outDir, opts = {}) {
  const dir = outDir || process.cwd();
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); // yyyymmddHHMMSS
  const file = path.join(dir, 'screen-' + stamp + '.pbm');
  fs.writeFileSync(file, toPbm(bitmap, opts));
  return file;
}

/** 显存是不是全 0（全灭）；全灭时提示「可能没在跑/没接屏」，但**不假装是图** */
function isBlank(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  for (let i = 0; i < buf.length; i++) if (buf[i] !== 0) return false;
  return true;
}

/**
 * 显存内容指纹（sha1 前 12 位）。
 *
 * 为什么需要：模型每次看屏幕要 64 行 × 128 字符的 ASCII（约 8 KB、近 2K token），
 * 而绝大多数检查只是「屏幕变没变 / 和刚才一样吗」。指纹 + 差异包围盒把这类检查
 * 压到一行输出；只有真要读文字时才拉 ASCII。
 */
function hashBytes(bytes) {
  const crypto = require('node:crypto');
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  return crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
}

/** 只渲染点阵的一个矩形区域（x0,y0,x1,y1，含端点）；用于「只看第一行文字」这类需求 */
function cropAscii(bitmap, region, opts = {}) {
  const { width, height, bits } = bitmap;
  let x0 = 0; let y0 = 0; let x1 = width - 1; let y1 = height - 1;
  if (Array.isArray(region) && region.length === 4) {
    x0 = Math.max(0, Math.min(width - 1, Number(region[0]) || 0));
    y0 = Math.max(0, Math.min(height - 1, Number(region[1]) || 0));
    x1 = Math.max(x0, Math.min(width - 1, Number(region[2]) || width - 1));
    y1 = Math.max(y0, Math.min(height - 1, Number(region[3]) || height - 1));
  }
  const invert = !!opts.invert;
  const on = opts.onChar || '#';
  const off = opts.offChar || '.';
  const lines = [];
  for (let y = y0; y <= y1; y++) {
    let line = '';
    for (let x = x0; x <= x1; x++) {
      const bit = bits[y * width + x] ? 1 : 0;
      line += (invert ? 1 - bit : bit) ? on : off;
    }
    lines.push(line);
  }
  return { text: lines.join('\n'), x0, y0, x1, y1, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** 两帧点阵差异：变化像素数 + 变化区域包围盒（无变化返回 null 盒） */
function diffBitmaps(a, b) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) {
    throw new Error('两帧尺寸不一致，不能比较：' +
      (a && b ? a.width + '×' + a.height + ' vs ' + b.width + '×' + b.height : '缺少一帧'));
  }
  let changed = 0;
  let x0 = Infinity; let y0 = Infinity; let x1 = -1; let y1 = -1;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const i = y * a.width + x;
      if (a.bits[i] !== b.bits[i]) {
        changed += 1;
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
  }
  return {
    changedPixels: changed,
    bbox: changed ? { x0, y0, x1, y1, width: x1 - x0 + 1, height: y1 - y0 + 1 } : null,
  };
}

module.exports = {
  decodeSsd1306, toAscii, toPbm, writePbm, isBlank,
  hashBytes, cropAscii, diffBitmaps,
  DEFAULT_WIDTH, DEFAULT_HEIGHT,
};
