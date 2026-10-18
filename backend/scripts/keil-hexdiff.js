'use strict';
/**
 * keil-hexdiff.js —— 按地址逐字节比对两份 Intel HEX，判断差异性质
 *   差异若集中在向量表 / 呈整体位移 → 链接布局问题
 *   差异若散布在代码区且内容不同 → 编译参数问题
 */
const fs = require('fs');
const path = require('path');
const ctx = require('./_ctx');

/* 不再写死开发期路径：产物目录按「本插件自己的构建输出」解析，且拒绝比源码旧的产物 */
const PROJ_DIR = ctx.projectDir();
const OURS_DIR = ctx.latestBuildDir();
const stale = ctx.staleness(OURS_DIR, PROJ_DIR);
if (stale && !ctx.arg('--allow-stale')) {
  console.error('\n[中止] ' + stale + '\n  （确实要用陈旧产物就加 --allow-stale）\n');
  process.exit(3);
}
console.log('工程目录：' + PROJ_DIR);
console.log('产物目录：' + OURS_DIR);

function parseHex(p) {
  const map = new Map();
  let base = 0;
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
  for (const l of lines) {
    if (!l.startsWith(':') || l.length < 11) continue;
    const len = parseInt(l.substr(1, 2), 16);
    const addr = parseInt(l.substr(3, 4), 16);
    const type = parseInt(l.substr(7, 2), 16);
    const data = [];
    for (let i = 0; i < len; i++) data.push(parseInt(l.substr(9 + i * 2, 2), 16));
    if (type === 0) {
      for (let i = 0; i < len; i++) map.set(base + addr + i, data[i]);
    } else if (type === 1) {
      break;
    } else if (type === 2) {
      base = ((data[0] << 8) | data[1]) << 4;
    } else if (type === 4) {
      base = (((data[0] << 8) | data[1]) << 16) >>> 0;
    }
  }
  return map;
}

const A = parseHex(path.join(PROJ_DIR, 'Objects', 'Project.hex')); // Keil
const B = parseHex(path.join(OURS_DIR, 'Project.hex'));            // 本插件

const range = (m) => {
  const ks = [...m.keys()];
  return '0x' + Math.min(...ks).toString(16) + ' ~ 0x' + Math.max(...ks).toString(16);
};

console.log('══ 覆盖范围 ══════════════════════════════════════════');
console.log('  Keil  : ' + A.size + ' B  ' + range(A));
console.log('  插件  : ' + B.size + ' B  ' + range(B));

/* 只在两边都有数据的地址上比较 */
const all = new Set([...A.keys(), ...B.keys()]);
const diffs = [];
let onlyA = 0, onlyB = 0;
for (const a of all) {
  const inA = A.has(a), inB = B.has(a);
  if (inA && !inB) { onlyA++; continue; }
  if (!inA && inB) { onlyB++; continue; }
  if (A.get(a) !== B.get(a)) diffs.push(a);
}
console.log('  仅 Keil 有 / 仅插件有 / 公共地址上不同的字节：' + onlyA + ' / ' + onlyB + ' / ' + diffs.length);

/* 把差异地址聚成区间 */
const runs = [];
for (const a of diffs) {
  const last = runs[runs.length - 1];
  if (last && a - last.end <= 16) last.end = a; else runs.push({ start: a, end: a });
}

console.log('');
console.log('══ 差异区间（' + runs.length + ' 段，相邻 16 字节内合并）══════════════');
runs.slice(0, 25).forEach((r) => {
  const n = r.end - r.start + 1;
  const aHex = [], bHex = [];
  for (let a = r.start; a <= r.end && a < r.start + 16; a++) {
    aHex.push(A.has(a) ? A.get(a).toString(16).padStart(2, '0') : '--');
    bHex.push(B.has(a) ? B.get(a).toString(16).padStart(2, '0') : '--');
  }
  console.log('  0x' + r.start.toString(16).padStart(8, '0') + '  ' + String(n).padStart(4) + ' B');
  console.log('        Keil: ' + aHex.join(' '));
  console.log('        插件: ' + bHex.join(' '));
});
if (runs.length > 25) console.log('  …还有 ' + (runs.length - 25) + ' 段');

/* 差异是否集中在向量表？ */
const vectorZone = diffs.filter((a) => a < 0x08000200).length;
console.log('');
console.log('══ 判断 ══════════════════════════════════════════════');
console.log('  落在向量表区（< 0x08000200）的差异字节：' + vectorZone + ' / ' + diffs.length);
if (diffs.length === 0) console.log('  ✅ 内容完全一致');
else if (vectorZone === diffs.length) console.log('  → 差异全部在向量表：代码布局不同，但两份都是完整可用的映像');
else console.log('  → 代码区也有差异：编译或链接参数尚未完全对齐');

/* 向量表前 12 个字 */
console.log('');
console.log('══ 向量表前 12 个字 ══════════════════════════════════');
const word = (m, addr) => {
  let v = 0;
  for (let i = 0; i < 4; i++) v |= (m.get(addr + i) || 0) << (8 * i);
  return '0x' + (v >>> 0).toString(16).padStart(8, '0');
};
const NAMES = ['初始 SP', 'Reset', 'NMI', 'HardFault', 'MemManage', 'BusFault', 'UsageFault', '保留', '保留', '保留', '保留', 'SVC'];
for (let i = 0; i < 12; i++) {
  const addr = 0x08000000 + i * 4;
  const a = word(A, addr), b = word(B, addr);
  console.log('  [' + String(i).padStart(2) + '] ' + NAMES[i].padEnd(10) + ' Keil ' + a + '   插件 ' + b + (a === b ? '  ✓' : '  ✗'));
}
