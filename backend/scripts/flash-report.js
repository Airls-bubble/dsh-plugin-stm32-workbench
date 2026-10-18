'use strict';
/**
 * flash-report.js —— 「谁吃了 Flash」：编译 + 解析 map，按对象和函数列出真实占用
 * 用法：node scripts/flash-report.js [工程.uvprojx 或目录] [TopN]
 */
const path = require('path');
const fs = require('fs');
const { buildKeil } = require('../server/keil-build');
const ctx = require('./_ctx');

/* 默认工程来自「当前打开的工程」（或 --project），不再写死开发机路径 */
const DEFAULT_PROJ = ctx.projectDir();
const TOP = parseInt(process.argv[3] || '18', 10);

const kb = (b) => (b / 1024).toFixed(2) + ' KB';
const pct = (a, b) => b ? (a / b * 100).toFixed(1) + '%' : '—';

(async () => {
  const proj = process.argv[2] || DEFAULT_PROJ;
  console.log('工程：' + proj);
  console.log('编译中…（用 armlink --map 拿真实账本）');
  console.log('─'.repeat(84));

  const r = await buildKeil({ projectFile: proj, onLine: () => {} });
  if (!r.ok) { console.error('✗ 构建失败：' + r.stage); process.exit(1); }
  const m = r.map;
  if (!m || !m.objects.length) { console.error('✗ 没解析到 map 数据'); process.exit(2); }

  const cap = { flash: (r.programSize.flashKB || 64) * 1024, ram: (r.programSize.ramKB || 20) * 1024 };
  const ps = r.programSize;

  console.log('');
  console.log('══ 总账（链接后，未调用的函数已被链接器删掉）════════════');
  console.log('  Code ' + ps.code + ' · RO-data ' + ps.rodata + ' · RW-data ' + ps.rwdata + ' · ZI-data ' + ps.zidata);
  console.log('  Flash  ' + ps.flashBytes + ' / ' + cap.flash + ' B　' + pct(ps.flashBytes, cap.flash) +
    '　剩余 ' + (cap.flash - ps.flashBytes) + ' B');
  console.log('  SRAM   ' + ps.ramBytes + ' / ' + cap.ram + ' B　' + pct(ps.ramBytes, cap.ram) +
    '　剩余 ' + (cap.ram - ps.ramBytes) + ' B');
  console.log('');
  console.log('  其中你自己的代码：Flash ' + m.user.flash + ' B（' + pct(m.user.flash, ps.flashBytes) +
    '）　C 库/启动代码：' + m.library.flash + ' B（' + pct(m.library.flash, ps.flashBytes) + '）');

  console.log('');
  console.log('══ 你的文件按 Flash 占用排（Top ' + TOP + '）═══════════════════');
  console.log('  ' + '文件'.padEnd(34) + 'Code'.padStart(8) + 'RO'.padStart(8) + 'RW'.padStart(7) +
    'Flash'.padStart(9) + '  占全片');
  m.userObjects.filter((o) => o.flash > 0).slice(0, TOP).forEach((o) => {
    console.log('  ' + String(o.source || o.name).slice(0, 33).padEnd(34) +
      String(o.code).padStart(8) + String(o.roData).padStart(8) + String(o.rwData).padStart(7) +
      String(o.flash).padStart(9) + '  ' + pct(o.flash, cap.flash));
  });

  console.log('');
  console.log('══ 单个函数按大小排（Top ' + TOP + '）—— 想省 Flash 就从这里下手 ═══');
  console.log('  ' + '函数'.padEnd(34) + '大小'.padStart(8) + '  占全片'.padStart(9) + '  所在文件');
  m.functions.slice(0, TOP).forEach((f) => {
    console.log('  ' + f.name.slice(0, 33).padEnd(34) + String(f.size).padStart(8) +
      '  ' + pct(f.size, cap.flash).padStart(8) + '  ' + (f.source || f.object));
  });

  console.log('');
  console.log('══ C 库与启动代码（你改不了，但要知道它占了多少）══════');
  m.libObjects.filter((o) => o.flash > 0).slice(0, 10).forEach((o) => {
    console.log('  ' + o.name.slice(0, 44).padEnd(46) + String(o.flash).padStart(8) + ' B');
  });

  console.log('');
  console.log('══ 内存区域 ═══════════════════════════════════════════');
  m.regions.forEach((g) => {
    console.log('  ' + (g.load ? '装载域 ' : '执行域 ') + g.name.padEnd(12) +
      '0x' + g.base.toString(16).padStart(8, '0') +
      '  用 ' + String(g.size).padStart(6) + ' / ' + String(g.max).padStart(6) + ' B　' + pct(g.size, g.max));
  });
  console.log('');
  console.log('  段数（函数/数据条目）：' + m.sectionCount);
})().catch((e) => { console.error('异常：' + (e && e.stack || e)); process.exit(9); });
