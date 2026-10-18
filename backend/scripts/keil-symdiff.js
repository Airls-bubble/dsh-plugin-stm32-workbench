'use strict';
/**
 * keil-symdiff.js —— 用 fromelf 提取两份 axf 的符号表，逐函数对比大小，
 * 精确定位 Code 段 48 字节差异出在哪个函数。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ctx = require('./_ctx');

/* 工具链路径来自 toolchain.detectEnv()，两份 axf 都从本机解析 */
const T = ctx.keilTools();
const FROMELF = T.fromelf;
if (!FROMELF || !fs.existsSync(FROMELF)) {
  console.error('\n[中止] 找不到 fromelf（Keil MDK AC5 的一部分）。\n');
  process.exit(3);
}
const REF_DIR = ctx.uv4RefDir();
const MY_DIR = ctx.latestBuildDir();
const REF_AXF = path.join(REF_DIR, 'Project.axf');
const MY_AXF = path.join(MY_DIR, 'Project.axf');
for (const [what, p] of [['UV4 参照 axf', REF_AXF], ['本插件 axf', MY_AXF]]) {
  if (!fs.existsSync(p)) {
    console.error('\n[中止] 找不到' + what + '：' + p +
      '\n  · 参照产物由 backend/scripts/keil-uv4-ref.js 生成；本插件产物由一次构建生成。\n');
    process.exit(3);
  }
}
const stale = ctx.staleness(MY_DIR, ctx.projectDir());
if (stale && !ctx.arg('--allow-stale')) {
  console.error('\n[中止] ' + stale + '\n  （确实要用陈旧产物就加 --allow-stale）\n');
  process.exit(3);
}
console.log('参照 axf：' + REF_AXF);
console.log('本插件 axf：' + MY_AXF);

function symbols(axf) {
  const r = spawnSync(FROMELF, ['--text', '-s', axf], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const out = (r.stdout || '') + (r.stderr || '');
  // 表头：      #  Symbol Name                Value      Bind  Sec  Type  Vis  Size
  // 数据：   1352  main                       0x08006b3d   Gb    1  Code  Hi   0x262
  const re = /^\s*(\d+)\s+(\S+)\s+0x([0-9a-fA-F]+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+(0x[0-9a-fA-F]+))?\s*$/;
  const map = new Map();
  for (const line of out.split(/\r?\n/)) {
    const m = re.exec(line);
    if (!m) continue;
    const name = m[2];
    const sizeHex = m[8];
    if (!sizeHex) continue;                 // 没有大小的符号（如地址标签）跳过
    const size = parseInt(sizeHex, 16);
    if (!isFinite(size) || size === 0) continue;
    const prev = map.get(name);
    if (prev) prev.size += size;            // 同名符号（内联副本等）累加
    else map.set(name, { size, value: m[3] });
  }
  return map;
}

console.log('提取符号表…');
const R = symbols(REF_AXF);
const M = symbols(MY_AXF);
console.log('  UV4 符号 ' + R.size + ' 个，插件符号 ' + M.size + ' 个');

const rows = [];
for (const [name, r] of R) {
  const m = M.get(name);
  if (!m) { rows.push({ name, r: r.size, m: null, d: null, obj: r.obj }); continue; }
  rows.push({ name, r: r.size, m: m.size, d: m.size - r.size, obj: r.obj });
}
for (const [name, m] of M) if (!R.has(name)) rows.push({ name, r: null, m: m.size, d: null, obj: m.obj });

const onlyR = rows.filter((x) => x.m === null);
const onlyM = rows.filter((x) => x.r === null);
const sizeDiff = rows.filter((x) => x.d !== null && x.d !== 0);

console.log('');
console.log('══ 符号存在性 ════════════════════════════════════════');
console.log('  仅 UV4 有 : ' + onlyR.length + (onlyR.length ? '  ' + onlyR.slice(0, 8).map((x) => x.name).join(', ') : ''));
console.log('  仅插件有  : ' + onlyM.length + (onlyM.length ? '  ' + onlyM.slice(0, 8).map((x) => x.name).join(', ') : ''));

console.log('');
console.log('══ 大小不同的符号（' + sizeDiff.length + ' 个）═════════════════════');
if (!sizeDiff.length) {
  console.log('  （无 —— 所有同名函数大小完全一致）');
} else {
  sizeDiff.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  console.log('  ' + '函数'.padEnd(34) + 'UV4'.padStart(7) + '插件'.padStart(7) + '  差');
  sizeDiff.slice(0, 40).forEach((x) => {
    console.log('  ' + x.name.slice(0, 33).padEnd(34) + String(x.r).padStart(7) + String(x.m).padStart(7) +
      '  ' + String(x.d > 0 ? '+' + x.d : x.d).padStart(5) +
      (x.m === 0 ? '   ← 插件里是空壳（函数被优化掉）' : ''));
  });
  const total = sizeDiff.reduce((a, x) => a + x.d, 0);
  console.log('  ────────────────────────────────────────────────────────');
  console.log('  净差 ' + (total > 0 ? '+' : '') + total + ' B');
}
