'use strict';
/**
 * keil-shift.js —— 判定两份 hex 的差异性质
 *   从 Keil 产物里取若干代码片段，在插件产物里全文搜索：
 *   · 全部命中且偏移一致 → 内容相同、只是布局平移（无害）
 *   · 命中但偏移各异     → 布局不同
 *   · 完全不命中         → 编译结果本身不同（参数未对齐）
 */
const fs = require('fs');
const path = require('path');
const ctx = require('./_ctx');

/* 不再写死开发期路径：产物目录按「本插件自己的构建输出」解析 */
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
  for (const l of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!l.startsWith(':') || l.length < 11) continue;
    const len = parseInt(l.substr(1, 2), 16);
    const addr = parseInt(l.substr(3, 4), 16);
    const type = parseInt(l.substr(7, 2), 16);
    const data = [];
    for (let i = 0; i < len; i++) data.push(parseInt(l.substr(9 + i * 2, 2), 16));
    if (type === 0) for (let i = 0; i < len; i++) map.set(base + addr + i, data[i]);
    else if (type === 1) break;
    else if (type === 2) base = ((data[0] << 8) | data[1]) << 4;
    else if (type === 4) base = (((data[0] << 8) | data[1]) << 16) >>> 0;
  }
  return map;
}

const A = parseHex(path.join(PROJ_DIR, 'Objects', 'Project.hex'));
const B = parseHex(path.join(OURS_DIR, 'Project.hex'));

const bufA = Buffer.alloc(0x10000, 0xff);
const bufB = Buffer.alloc(0x10000, 0xff);
for (const [a, v] of A) if (a >= 0x08000000 && a < 0x08010000) bufA[a - 0x08000000] = v;
for (const [a, v] of B) if (a >= 0x08000000 && a < 0x08010000) bufB[a - 0x08000000] = v;

/** bufB 里搜 needle，返回全部命中偏移（相对 0x08000000） */
function find(hay, needle, limit = 8) {
  const out = [];
  let i = 0;
  while (out.length < limit) {
    const k = hay.indexOf(needle, i);
    if (k < 0) break;
    out.push(k);
    i = k + 1;
  }
  return out;
}

/* 取样点：向量表之后、代码区中段、以及差异区起点 */
const SAMPLES = [
  { at: 0x08001cec, n: 48, note: '最大差异区起点' },
  { at: 0x08001000, n: 48, note: '代码区中段' },
  { at: 0x08000300, n: 48, note: '启动代码区' },
  { at: 0x08006000, n: 48, note: '代码区后段' },
];

console.log('══ 代码片段全文检索 ══════════════════════════════════');
let hitSame = 0, hitDiff = 0, miss = 0;
for (const s of SAMPLES) {
  const off = s.at - 0x08000000;
  const needle = bufA.slice(off, off + s.n);
  const hits = find(bufB, needle);
  const same = hits.includes(off);
  if (!hits.length) { miss++; console.log('  ✗ ' + s.at.toString(16) + '  ' + s.note + '：插件产物中完全找不到这段字节'); }
  else if (same) { hitSame++; console.log('  ✓ ' + s.at.toString(16) + '  ' + s.note + '：同一地址命中'); }
  else { hitDiff++; console.log('  ⇄ ' + s.at.toString(16) + '  ' + s.note + '：命中 ' + hits.length + ' 处，但地址不同 → ' + hits.map((h) => '0x' + (h + 0x08000000).toString(16)).join('、')); }
}

/* 反向：把整个 Keil 代码区切成 32 字节块，统计有多少块能在插件产物里找到 */
let blocks = 0, found = 0, foundSameAddr = 0;
for (let a = 0x08000200; a < 0x0800c000; a += 32) {
  const off = a - 0x08000000;
  const needle = bufA.slice(off, off + 32);
  if (needle.equals(Buffer.alloc(32, 0xff))) continue;  // 跳过错过的空洞
  blocks++;
  const hits = find(bufB, needle, 1);
  if (hits.length) {
    found++;
    if (hits[0] === off) foundSameAddr++;
  }
}
console.log('');
console.log('══ 全代码区块级统计（0x08000200–0x0800c000，每块 32 B）════');
console.log('  非空块          : ' + blocks);
console.log('  能在插件产物中找到 : ' + found + '（' + (found / blocks * 100).toFixed(1) + '%）');
console.log('  其中地址也相同    : ' + foundSameAddr + '（' + (foundSameAddr / blocks * 100).toFixed(1) + '%）');

console.log('');
console.log('══ 结论 ══════════════════════════════════════════════');
if (blocks === 0) console.log('  （无样本）');
else if (found / blocks > 0.9 && foundSameAddr / blocks > 0.9) console.log('  ✅ 绝大部分代码逐字节一致 → 两份产物等价，差异只是少量布局');
else if (found / blocks > 0.9) console.log('  → 代码内容基本一致，但**地址普遍不同**：链接布局有系统性差异');
else if (found / blocks > 0.3) console.log('  → 约 ' + Math.round(found / blocks * 100) + '% 的代码块能找到：编译参数存在实质差异');
else console.log('  → 代码几乎找不到匹配：两份产物由**不同的编译参数**产生（或源码版本不同）');
