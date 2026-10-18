'use strict';
/**
 * pinmap-cli.js —— 只读：解析工程的引脚配置并打印
 * 用法：node scripts/pinmap-cli.js [工程.uvprojx 或目录]
 */
const path = require('path');
const fs = require('fs');
const { parseUvprojx } = require('../server/uvprojx');
const { scanProjectPins } = require('../server/pinmap');
const ctx = require('./_ctx');

/* 默认工程来自「当前打开的工程」（或 --project / MCU_PROJECT），不再写死开发机路径 */
const DEFAULT_PROJ = ctx.projectDir();

function resolveArg(a) {
  const p = a ? path.resolve(a) : DEFAULT_PROJ;
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
    const hit = fs.readdirSync(p).filter((f) => /\.uvprojx$/i.test(f))[0];
    if (!hit) throw new Error('目录里没有 .uvprojx：' + p);
    return path.join(p, hit);
  }
  return p;
}

const model = parseUvprojx(resolveArg(process.argv[2]));
const r = scanProjectPins(model);

console.log('');
console.log('══ 工程 ══════════════════════════════════════════════');
console.log('  ' + model.name + '  ·  ' + model.device + '  ·  参与编译的 C 文件 ' + model.sources.filter((s) => s.kind === 'c').length + ' 个');

console.log('');
console.log('══ 用到的引脚（' + r.usedPins + ' 个）══════════════════════════════');
console.log('  ' + '引脚'.padEnd(8) + '物理脚'.padStart(6) + '  ' + '模式'.padEnd(12) + '速度'.padEnd(9) + '来源');
console.log('  ' + '─'.repeat(74));
for (const p of r.pins) {
  const cs = p.configs;
  const first = cs[0];
  const extra = cs.length > 1 ? '  (+' + (cs.length - 1) + ' 次重配)' : '';
  console.log('  ' + p.name.padEnd(8) +
    String(p.physicalPin == null ? '—' : p.physicalPin).padStart(6) + '  ' +
    String(first.modeZh).padEnd(12) + String(first.speedZh || '—').padEnd(9) +
    first.file + ':' + first.line + extra);
  if (cs.length > 1) {
    cs.slice(1).forEach((c) => {
      console.log('  ' + ''.padEnd(8) + ''.padStart(6) + '  ↳ 改为 ' + String(c.modeZh).padEnd(9) + String(c.speedZh || '—').padEnd(9) + c.file + ':' + c.line);
    });
  }
}

console.log('');
console.log('══ 外部中断 EXTI（' + r.exti.length + ' 条）═══════════════════════════');
if (!r.exti.length) console.log('  （无）');
r.exti.forEach((e) => {
  console.log('  EXTI_Line' + e.line + '  ' +
    (e.port ? 'P' + e.port + e.line : '(未关联到端口)') + '  ' +
    String(e.triggerZh).padEnd(10) + (e.lineCmd === 'DISABLE' ? '[已禁用] ' : '') + e.file + ':' + e.srcLine);
});

console.log('');
console.log('══ 使能的外设时钟（' + r.clocks.length + ' 个）═══════════════════════');
console.log('  ' + r.clocks.map((c) => c.periph).join('  '));

console.log('');
const SEV = { danger: '严重', warn: '注意', info: '提示' };
console.log('══ ⚠ 真问题（' + r.conflicts.length + ' 条）════════════════════════════');
if (!r.conflicts.length) console.log('  （无）');
r.conflicts.forEach((c, i) => {
  console.log('  ' + (i + 1) + '. [' + (SEV[c.severity] || c.severity || '?') + '] ' + c.pin +
    (c.physicalPin ? '（物理脚 ' + c.physicalPin + '）' : ''));
  console.log('     ' + c.detail);
  if (c.effective) console.log('     最终生效：' + c.effective + '（' + c.effectiveAt + '）');
});

console.log('');
console.log('══ 初始化重配（' + ((r.reconfigs || []).length) + ' 条 · 最终态明确，通常无需处理）══');
if (!(r.reconfigs || []).length) console.log('  （无）');
(r.reconfigs || []).forEach((c, i) => {
  console.log('  ' + (i + 1) + '. ' + c.pin + '：' + c.detail);
  console.log('     最终生效：' + c.effective + '（' + c.effectiveAt + '）');
});

if (r.orderSource) {
  console.log('');
  console.log('══ 「最终生效」的推断依据 ═══════════════════════════════');
  console.log('  方法：' + r.orderSource.method + '　可信度：' + r.orderSource.confidence);
  console.log('  入口：' + (r.orderSource.entry || '—'));
  (r.orderSource.sequence || []).forEach((s, i) =>
    console.log('    ' + String(i + 1).padStart(2) + '. ' + s.fn + '  →  ' + s.file));
  if ((r.orderSource.unmapped || []).length) {
    console.log('  未被 main 直接调到的文件（按工程清单顺序排在最后）：');
    (r.orderSource.unmapped || []).slice(0, 12).forEach((f) => console.log('    · ' + f));
  }
}

if (r.notes.length) {
  console.log('');
  console.log('══ 其它提示（' + r.notes.length + ' 条）═══════════════════════════════');
  r.notes.forEach((n) => console.log('  [' + n.level + '] ' + n.message));
}

console.log('');
console.log('══ 未使用的可用 IO ═══════════════════════════════════');
const used = new Set(r.pins.map((p) => p.name.toUpperCase()));
const PINS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'pins.json'), 'utf8'));
const list = Array.isArray(PINS) ? PINS : (PINS.pins || []);
const free = list
  .filter((e) => e.io && e.port && !used.has(String(e.port).toUpperCase()))
  .map((e) => {
    const blob = String(e.name || '') + String(e.note || '');
    let tag = '';
    if (/SWD|SWCLK|SWDIO|JTAG|调试/.test(blob)) tag = '(调试口*)';
    else if (/OSC|晶振/.test(blob)) tag = '(晶振)';
    return (e.physicalPin != null ? '' : '') + e.port + tag;
  });
console.log('  ' + (free.join('  ') || '（无）'));
console.log('');
console.log('  注：带 * 的是 SWD/JTAG 调试口，占用后将无法再用 ST-Link 下载调试。');
console.log('');
