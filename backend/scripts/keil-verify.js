'use strict';
/**
 * keil-verify.js —— 只读校验：
 *   ① 与用户 Keil 自己编出的 Objects\Project.hex 对比
 *   ② 检测工程源码的文本编码（GBK/UTF-8）—— 影响后续能不能安全地读写源码
 */
const fs = require('fs');
const path = require('path');
const ctx = require('./_ctx');

/* 路径全部从「本插件在哪」推出来。以前这里写死过某个构建目录的绝对路径，
   而插件真正在用的是 .dsh 下那份 —— 两份产物目录同名，脚本会拿陈旧产物
   比对出一个「0 差异」的假绿灯。现在缺东西就中止，并且拒绝使用比源码旧的产物。 */
const PROJ_DIR = ctx.projectDir();
const OURS_DIR = ctx.latestBuildDir();
const stale = ctx.staleness(OURS_DIR, PROJ_DIR);
if (stale && !ctx.arg('--allow-stale')) {
  console.error('\n[中止] ' + stale + '\n  （确实要用这份陈旧产物，就加 --allow-stale，但结论要按“过期数据”解读）\n');
  process.exit(3);
}
console.log('工程目录：' + PROJ_DIR);
console.log('产物目录：' + OURS_DIR + '（本插件自己那份）');

function rel(p) { return path.relative(ctx.PLUGIN, p); }

/* ── ① hex 对比 ── */
function readHex(p) {
  if (!fs.existsSync(p)) return null;
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter((l) => l.startsWith(':'));
  const bytes = [];
  for (const l of lines) {
    const len = parseInt(l.substr(1, 2), 16);
    const type = parseInt(l.substr(7, 2), 16);
    if (type === 0x00) {
      for (let i = 0; i < len; i++) bytes.push(parseInt(l.substr(9 + i * 2, 2), 16));
    }
  }
  return { lines: lines.length, data: Buffer.from(bytes) };
}

const theirs = readHex(path.join(PROJ_DIR, 'Objects', 'Project.hex'));
const ours = readHex(path.join(OURS_DIR, 'Project.hex'));

console.log('══ ① hex 对比 ════════════════════════════════════════');
if (!theirs) {
  console.log('  Keil 侧 Objects\\Project.hex 不存在，无法对比');
} else {
  console.log('  Keil 产物 : ' + theirs.lines + ' 行, 数据 ' + theirs.data.length + ' B');
  console.log('  本插件产物: ' + ours.lines + ' 行, 数据 ' + ours.data.length + ' B');
  if (theirs.data.equals(ours.data)) {
    console.log('  ✅ 逐字节完全一致 —— 编译配置与 Keil 完全对齐');
  } else {
    let firstDiff = -1;
    const n = Math.min(theirs.data.length, ours.data.length);
    for (let i = 0; i < n; i++) if (theirs.data[i] !== ours.data[i]) { firstDiff = i; break; }
    console.log('  ⚠️ 有差异：首个不同字节 @0x' + firstDiff.toString(16) + '（长度差 ' + (ours.data.length - theirs.data.length) + ' B）');
    if (firstDiff >= 0) {
      console.log('      Keil  : ' + theirs.data.slice(Math.max(0, firstDiff - 8), firstDiff + 16).toString('hex'));
      console.log('      插件  : ' + ours.data.slice(Math.max(0, firstDiff - 8), firstDiff + 16).toString('hex'));
    }
  }
}

/* ── ② 源码编码检测 ── */
function detectEncoding(buf) {
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return 'utf8-bom';
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return 'utf16-le';
  const round = Buffer.from(buf.toString('utf8'), 'utf8');
  if (round.equals(buf)) return 'utf8';
  return 'gbk';
}

function walk(dir, out, root) {
  const base = root || dir;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (['Objects', 'Listings', '.git', 'DebugConfig', 'node_modules'].indexOf(e.name) >= 0) continue;
      walk(path.join(dir, e.name), out, base);
    } else if (/\.(c|h|s)$/i.test(e.name)) {
      const p = path.join(dir, e.name);
      const buf = fs.readFileSync(p);
      let enc = detectEncoding(buf);
      // 纯 ASCII 的文件两个编码都对，单独标出来
      const hasHigh = buf.some((b) => b > 0x7F);
      if (enc === 'utf8' && !hasHigh) enc = 'ascii';
      // 相对**工程根**（不是当前子目录）：否则只剩文件名，
      // 下面按 User/Hardware/System 分组的那段会永远匹配不上，报告一直显示「（无）」
      out.push({ p: path.relative(base, p), enc, bytes: buf.length });
    }
  }
  return out;
}

const files = walk(PROJ_DIR, []);
const tally = {};
files.forEach((f) => { tally[f.enc] = (tally[f.enc] || 0) + 1; });

console.log('');
console.log('══ ② 源码文本编码 ════════════════════════════════════');
console.log('  统计：' + Object.entries(tally).map(([k, v]) => k + ' × ' + v).join('，'));
const gbk = files.filter((f) => f.enc === 'gbk');
if (gbk.length) {
  console.log('  ⚠️ 这些文件不是 UTF-8（含中文时按 GBK/ANSI 存盘，Keil 里正常显示）：');
  gbk.slice(0, 20).forEach((f) => console.log('      ' + f.p + '  (' + f.bytes + ' B)'));
  if (gbk.length > 20) console.log('      …还有 ' + (gbk.length - 20) + ' 个');
} else {
  console.log('  ✅ 全部文件都能按 UTF-8 安全读写');
}

/* 用户代码（非库）单独看 */
const userFiles = files.filter((f) => /^(User|Hardware|System)\\/.test(f.p));
console.log('');
console.log('  —— 你自己写的代码（User/Hardware/System）——');
const userTally = {};
userFiles.forEach((f) => { userTally[f.enc] = (userTally[f.enc] || 0) + 1; });
console.log('  ' + (Object.entries(userTally).map(([k, v]) => k + ' × ' + v).join('，') || '（无）'));
userFiles.filter((f) => f.enc === 'gbk').forEach((f) => console.log('      [gbk] ' + f.p));
