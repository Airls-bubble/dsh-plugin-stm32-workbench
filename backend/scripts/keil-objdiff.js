'use strict';
/**
 * keil-objdiff.js —— 逐个目标文件对比 Keil(UV4) 与插件的编译结果，定位差异出在哪个源文件
 */
const fs = require('fs');
const path = require('path');
const ctx = require('./_ctx');

/* 参照产物（UV4 造的）与本插件产物都从本机解析，不写死开发期路径 */
const REF = ctx.uv4RefDir();
const MINE = ctx.latestBuildDir();
if (!fs.existsSync(REF)) {
  console.error('\n[中止] 还没有 UV4 参照产物：' + REF +
    '\n  · 先跑 backend/scripts/keil-uv4-ref.js 造一份参照。\n');
  process.exit(3);
}
const stale = ctx.staleness(MINE, ctx.projectDir());
if (stale && !ctx.arg('--allow-stale')) {
  console.error('\n[中止] ' + stale + '\n  （确实要用陈旧产物就加 --allow-stale）\n');
  process.exit(3);
}
console.log('参照产物：' + REF);
console.log('本插件产物：' + MINE);
const PREFIXES = ['Start_', 'Library_', 'System_', 'Hardware_', 'User_'];

const keyOfRef = (n) => path.basename(n, '.o').toLowerCase();
function keyOfMine(n) {
  let b = path.basename(n, '.o');
  for (const p of PREFIXES) if (b.startsWith(p)) { b = b.slice(p.length); break; }
  return b.toLowerCase();
}

const refs = new Map();
for (const f of fs.readdirSync(REF)) {
  if (/\.o$/i.test(f)) refs.set(keyOfRef(f), { f, size: fs.statSync(path.join(REF, f)).size });
}
const mines = new Map();
for (const f of fs.readdirSync(MINE)) {
  if (/\.o$/i.test(f)) mines.set(keyOfMine(f), { f, size: fs.statSync(path.join(MINE, f)).size });
}

console.log('══ 目标文件对比（' + refs.size + ' vs ' + mines.size + '）══════════════════');
console.log('  ' + '源文件'.padEnd(24) + 'UV4'.padStart(10) + '插件'.padStart(10) + '  差');
console.log('  ' + '─'.repeat(56));

const rows = [];
for (const [k, r] of refs) {
  const m = mines.get(k);
  if (!m) { rows.push({ k, r: r.size, m: null, d: null }); continue; }
  rows.push({ k, r: r.size, m: m.size, d: m.size - r.size });
}
for (const [k, m] of mines) if (!refs.has(k)) rows.push({ k, r: null, m: m.size, d: null });

rows.sort((a, b) => Math.abs((b.d === null ? 0 : b.d)) - Math.abs((a.d === null ? 0 : a.d)));

let same = 0, diff = 0, totalDelta = 0;
for (const row of rows) {
  const flag = row.d === null ? '  ← 只一方有' : (row.d === 0 ? '' : '  ← 差 ' + (row.d > 0 ? '+' : '') + row.d);
  if (row.d === 0) same++; else if (row.d !== null) { diff++; totalDelta += row.d; }
  if (row.d !== 0 || Math.abs(row.d) > 64) {
    console.log('  ' + row.k.padEnd(24) +
      String(row.r === null ? '—' : row.r).padStart(10) +
      String(row.m === null ? '—' : row.m).padStart(10) + flag);
  }
}
console.log('  ' + '─'.repeat(56));
console.log('  完全相同 ' + same + ' 个，大小不同 ' + diff + ' 个，总差 ' + totalDelta + ' B');

/* 只看用户代码 */
console.log('');
console.log('══ 用户代码部分（User / Hardware / System）═══════════');
rows.filter((r) => /^(main|stm32f10x_it|led|key|oled|oled_driver|oled_fonts|oled_ui|oled_ui_driver|oled_ui_menudata|hc-sr04|irsensor|esp8266|usart|delay)$/.test(r.k))
  .forEach((r) => {
    console.log('  ' + r.k.padEnd(24) +
      String(r.r === null ? '—' : r.r).padStart(10) +
      String(r.m === null ? '—' : r.m).padStart(10) +
      (r.d === 0 ? '  ✓ 一致' : '  ← 差 ' + r.d + ' B'));
  });
