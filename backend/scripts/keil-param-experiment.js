'use strict';
/**
 * keil-param-experiment.js —— 用单个源文件做参数二分：
 * 找出哪组 armcc 参数能复现 Keil(UV4) 编译出的函数大小。
 *
 * 参照：UV4 编出的 main.o 里 main 函数大小 = 590 B（插件当前 = 610 B）
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ctx = require('./_ctx');

/* 工具链与路径全部解析而来，不再写死 Keil 安装目录与某个固定工作区 */
const T = ctx.keilTools();
const ARMCC = T.armcc;
const FROMELF = T.fromelf;
const PROJ_DIR = ctx.projectDir();
const REF_O = path.join(ctx.uv4RefDir(), 'main.o');
const TMP = path.join(ctx.dataRoot(), 'tmp', 'param-exp');
if (!fs.existsSync(REF_O)) {
  console.error('\n[中止] 找不到 UV4 参照的 main.o：' + REF_O +
    '\n  · 先跑 backend/scripts/keil-uv4-ref.js 造一份参照。\n');
  process.exit(3);
}
console.log('工程目录：' + PROJ_DIR);
console.log('参照 main.o：' + REF_O);
console.log('临时目录：' + TMP);

const SRC = '.\\User\\main.c';
const INCS = ['-I.\\Start', '-I.\\User', '-I.\\Library', '-I.\\System', '-I.\\Hardware'];
const DEFS = ['-DUSE_STDPERIPH_DRIVER', '-DSTM32F10X_MD'];
const BASE = ['--cpu', 'Cortex-M3', '--apcs=interwork'];

function funcSize(oFile, name) {
  const r = spawnSync(FROMELF, ['--text', '-s', oFile], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  const out = (r.stdout || '') + (r.stderr || '');
  const re = /^\s*(\d+)\s+(\S+)\s+0x([0-9a-fA-F]+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\S+)(?:\s+(0x[0-9a-fA-F]+))?\s*$/;
  let total = 0, found = false;
  for (const line of out.split(/\r?\n/)) {
    const m = re.exec(line);
    if (!m || m[2] !== name || !m[8]) continue;
    total += parseInt(m[8], 16);
    found = true;
  }
  return found ? total : null;
}

const VARIANTS = [
  { label: '当前实现', extra: ['--c99', '-g', '--split_sections', '-O3'] },
  { label: '去 --c99', extra: ['-g', '--split_sections', '-O3'] },
  { label: '去 -g', extra: ['--c99', '--split_sections', '-O3'] },
  { label: '去 --split_sections', extra: ['--c99', '-g', '-O3'] },
  { label: '仅 --c99 -O3（极简）', extra: ['--c99', '-O3'] },
  { label: '-O2', extra: ['--c99', '-g', '--split_sections', '-O2'] },
  { label: '-O1', extra: ['--c99', '-g', '--split_sections', '-O1'] },
  { label: '-O0', extra: ['--c99', '-g', '--split_sections', '-O0'] },
  { label: '-O3 -Otime', extra: ['--c99', '-g', '--split_sections', '-O3', '-Otime'] },
  { label: '无 --c99 无 -g -O3', extra: ['-O3'] },
];

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const refMain = fs.existsSync(REF_O) ? funcSize(REF_O, 'main') : null;
console.log('══ 参照 ══════════════════════════════════════════════');
console.log('  UV4 编出的 main 函数大小：' + (refMain === null ? '（读取失败）' : refMain + ' B'));

console.log('');
console.log('══ 参数实验（只编译 User\\main.c）═════════════════════');
console.log('  ' + '参数组合'.padEnd(26) + 'main 大小   与 UV4');

const results = [];
for (const v of VARIANTS) {
  const out = path.join(TMP, 'main_' + results.length + '.o');
  const args = [...v.extra, ...BASE, ...DEFS, ...INCS, '-c', SRC, '-o', out];
  const r = spawnSync(ARMCC, args, { cwd: PROJ_DIR, encoding: 'utf8', timeout: 120000 });
  if (!fs.existsSync(out)) {
    console.log('  ' + v.label.padEnd(26) + '  编译失败  ' + (r.stderr || r.stdout || '').split(/\r?\n/)[0]);
    continue;
  }
  const sz = funcSize(out, 'main');
  const delta = (sz !== null && refMain !== null) ? sz - refMain : null;
  results.push({ label: v.label, sz, delta });
  console.log('  ' + v.label.padEnd(26) + String(sz === null ? '?' : sz).padStart(7) + ' B   ' +
    (delta === null ? '' : (delta === 0 ? '✅ 完全一致' : (delta > 0 ? '+' : '') + delta + ' B')));
}

const hit = results.filter((r) => r.delta === 0);
console.log('');
console.log('══ 结论 ══════════════════════════════════════════════');
if (hit.length) {
  console.log('  ✅ 能复现 UV4 结果的参数组合：');
  hit.forEach((h) => console.log('     · ' + h.label));
} else {
  console.log('  ✗ 没有任何组合能复现 —— 差异不在这些参数里');
  const best = results.slice().sort((a, b) => Math.abs(a.delta) - Math.abs(b.delta))[0];
  if (best) console.log('  最接近的是「' + best.label + '」，差 ' + best.delta + ' B');
}
