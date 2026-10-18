'use strict';
/**
 * keil-probe.js —— 只读侦察一个 Keil 工程：解析 .uvprojx 并打印工程模型
 *
 * 用法：node scripts/keil-probe.js [工程.uvprojx 或所在目录]
 * 不写任何文件，不调用编译器。
 */
const fs = require('fs');
const path = require('path');
const { parseUvprojx, summarise } = require('../server/uvprojx');
const ctx = require('./_ctx');

/* 默认工程来自「当前打开的工程」（或 --project / MCU_PROJECT），不再写死开发机路径 */
const DEFAULT_PROJ = ctx.projectFile();

function resolveArg(a) {
  if (!a) return DEFAULT_PROJ;
  const p = path.resolve(a);
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
    const hits = fs.readdirSync(p).filter((f) => /\.uvprojx$/i.test(f));
    if (!hits.length) throw new Error('目录里没有 .uvprojx：' + p);
    return path.join(p, hits[0]);
  }
  return p;
}

const line = (s) => console.log(s);
const kv = (k, v) => console.log('  ' + k.padEnd(14, ' ') + ' : ' + v);

const model = parseUvprojx(resolveArg(process.argv[2]));

line('');
line('══ 工程 ═══════════════════════════════════════════════');
kv('文件', path.basename(model.file));
kv('目录', model.dir);
kv('工程名', model.projectName);
kv('Target', model.targetName + '（共 ' + model.targetCount + ' 个）');

line('');
line('══ 器件与工具 ═════════════════════════════════════════');
kv('芯片', model.device + ' / ' + model.vendor);
kv('Pack', model.packId);
kv('内核', model.cpu.core + ' @ ' + (model.cpu.clockHz ? (model.cpu.clockHz / 1e6) + ' MHz' : '?'));
kv('Flash', model.cpu.irom ? '0x' + model.cpu.irom.base.toString(16) + '  ' + (model.cpu.irom.size / 1024) + ' KB' : '?');
kv('SRAM', model.cpu.iram ? '0x' + model.cpu.iram.base.toString(16) + '  ' + (model.cpu.iram.size / 1024) + ' KB' : '?');
kv('编译器', model.useAC6 ? 'ARM Compiler 6 (armclang)' : 'ARM Compiler 5 (armcc)');
kv('优化', 'Keil Optim=' + model.optim + ' → ' + model.optimFlag);
kv('HEX', model.createHex ? '生成' : '不生成');
kv('分散加载', model.scatterFile || '（空：用器件默认内存布局）');
kv('Misc', model.miscControls || '（空）');

line('');
line('══ 宏定义（' + model.defines.length + '）═════════════════════════════════');
model.defines.forEach((d) => line('  - ' + d + (model.autoDefines.indexOf(d) >= 0 ? '   ← 由器件自动补' : '')));

line('');
line('══ 头文件路径（' + model.includes.length + '）═══════════════════════════════');
model.includes.forEach((i) => line('  - ' + i.raw + (fs.existsSync(i.abs) ? '' : '   ← 不存在！')));

line('');
line('══ 输出设置 ═══════════════════════════════════════════');
kv('输出目录', model.outputDirectory + (fs.existsSync(model.outputDirectoryAbs) ? '（已存在）' : '（不存在，构建时创建）'));
kv('输出名', model.outputName);
kv('列表目录', model.listingPath);

line('');
line('══ 分组与文件 ═════════════════════════════════════════');
model.groups.forEach((g) => {
  const c = g.files.filter((f) => f.kind === 'c').length;
  const s = g.files.filter((f) => f.kind === 'asm').length;
  const h = g.files.filter((f) => f.kind === 'header').length;
  const other = g.files.length - c - s - h;
  line('  [' + g.name + ']  共 ' + g.files.length + ' 项  = C:' + c + ' 汇编:' + s + ' 头:' + h + (other ? ' 其它:' + other : ''));
});
kv('参与编译', model.sourceCount + ' 个（C ' + model.sources.filter((f) => f.kind === 'c').length +
  ' + 汇编 ' + model.sources.filter((f) => f.kind === 'asm').length + '）');

line('');
line('══ 编译清单 ═══════════════════════════════════════════');
model.sources.forEach((f) => line('  ' + (f.kind === 'asm' ? '[asm] ' : '[c]   ') + f.raw + (fs.existsSync(f.abs) ? '' : '   ← 文件不存在！')));

const excluded = model.groups.reduce((a, g) => a.concat(g.files), []).filter((f) => !f.inBuild);
if (excluded.length) {
  line('');
  line('══ 被排除、不参与编译 ════════════════════════════════');
  excluded.forEach((f) => line('  ' + f.raw));
}

line('');
line('══ 诊断（' + model.diagnostics.length + '）═════════════════════════════════');
if (!model.diagnostics.length) line('  （无异常）');
model.diagnostics.forEach((d) => line('  [' + d.level.toUpperCase() + '] ' + d.code + ' — ' + d.message));

line('');
line('══ 摘要 ═══════════════════════════════════════════════');
line('  ' + summarise(model));
line('');
