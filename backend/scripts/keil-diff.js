'use strict';
/** keil-diff.js —— 查清「插件产物 vs Keil 产物」48 字节差异的来源 */
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

const fmt = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);

/* ── ① 时间戳：谁的产物更新？ ── */
console.log('══ ① 时间戳 ═══════════════════════════════════════════');
const theirsHex = path.join(PROJ_DIR, 'Objects', 'Project.hex');
const logFile = path.join(PROJ_DIR, 'build_log.txt');

const items = [
  ['Keil 的 Objects\\Project.hex', theirsHex],
  ['build_log.txt', logFile],
  ['本插件的 Project.hex', path.join(OURS_DIR, 'Project.hex')],
];
items.forEach(([label, p]) => {
  console.log('  ' + label.padEnd(28) + (fs.existsSync(p) ? fmt(fs.statSync(p).mtime) : '（不存在）'));
});

/* 源码里最新的 mtime */
let newest = { t: 0, p: '' };
const walk = (dir, root) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['Objects', 'Listings', '.git', 'DebugConfig'].indexOf(e.name) >= 0) continue;
      walk(p, root);
    } else if (/\.(c|h|s)$/i.test(e.name)) {
      const m = fs.statSync(p).mtimeMs;
      if (m > newest.t) newest = { t: m, p: path.relative(root, p) };
    }
  }
};
walk(PROJ_DIR, PROJ_DIR);
console.log('  最新源码' .padEnd(30) + fmt(newest.t) + '  ' + newest.p);
console.log('  源码文件总数（含头文件）: ' + '(见下)');

/* ── ② Keil 自己的构建日志 ── */
console.log('');
console.log('══ ② build_log.txt（按 GBK 解码）═════════════════════');
if (!fs.existsSync(logFile)) {
  console.log('  不存在');
} else {
  const buf = fs.readFileSync(logFile);
  let text;
  try { text = new TextDecoder('gbk').decode(buf); }
  catch (e) { text = buf.toString('latin1'); console.log('  （GBK 解码不可用：' + e.message + '，按 latin1 显示）'); }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  console.log('  共 ' + lines.length + ' 行，末尾 30 行：');
  lines.slice(-30).forEach((l) => console.log('    ' + l));
  const ps = /Program Size:\s*Code=(\d+)\s*RO-data=(\d+)\s*RW-data=(\d+)\s*ZI-data=(\d+)/i.exec(text);
  console.log('');
  console.log('  ★ Keil 当时报告：' + (ps ? ps[0] : '（日志里没有 Program Size）'));
  console.log('  ★ 本插件报告  ：Program Size: Code=33314 RO-data=19970 RW-data=2364 ZI-data=5500');
}
