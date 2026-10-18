'use strict';
/**
 * regread-cli.js —— 只读：读芯片寄存器并解码，再与源码静态分析对照
 * 用法：node scripts/regread-cli.js [工程.uvprojx 或目录]
 */
const path = require('path');
const fs = require('fs');
const { readRegisters, findHseValue, comparePinmapWithChip } = require('../server/regread');
const { parseUvprojx } = require('../server/uvprojx');
const { scanProjectPins } = require('../server/pinmap');
const ctx = require('./_ctx');

/* 默认工程来自「当前打开的工程」（或 --project / MCU_PROJECT），不再写死开发机路径 */
const DEFAULT_PROJ = ctx.projectDir();

function resolveProj(a) {
  const p = a ? path.resolve(a) : DEFAULT_PROJ;
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
    const hit = fs.readdirSync(p).filter((f) => /\.uvprojx$/i.test(f))[0];
    return hit ? path.join(p, hit) : p;
  }
  return p;
}

const mhz = (hz) => (hz / 1e6).toFixed(3).replace(/\.?0+$/, '') + ' MHz';

(async () => {
  let model = null;
  try { model = parseUvprojx(resolveProj(process.argv[2])); }
  catch (e) { console.log('（工程没读到：' + e.message + '）'); }

  if (model) console.log('工程：' + model.name + '  ·  ' + model.device);

  const hse = model ? findHseValue(model) : { hz: 8000000, source: '默认估算', confident: false };
  console.log('HSE 晶振：' + mhz(hse.hz) + '    来源：' + hse.source + (hse.confident ? '' : '   ⚠ 不确定'));
  console.log('正在通过 SWD 读取寄存器…');
  console.log('─'.repeat(78));

  const r = await readRegisters({ hseHz: hse.hz });
  if (!r.ok) {
    console.log('✗ 读取失败：' + r.reason);
    if (process.env.SHOW_RAW) console.log(r.raw);
    process.exit(1);
  }

  const c = r.clock;
  console.log('');
  console.log('══ 时钟树（从 RCC_CR / RCC_CFGR 解码）════════════════════');
  console.log('  当前时钟源 : ' + c.source + '（寄存器请求：' + c.swRequested + '）');
  console.log('  SYSCLK     : ' + mhz(c.sysclkHz) + (c.sysclkHz > 72000000 ? '   ⚠ 超过 F103 的 72 MHz 上限' : ''));
  console.log('  HCLK (AHB) : ' + mhz(c.hclkHz) + '   分频 ' + c.prescalers.hpre);
  console.log('  PCLK1(APB1): ' + mhz(c.pclk1Hz) + '   分频 ' + c.prescalers.ppre1 + '   (上限 36 MHz)');
  console.log('  PCLK2(APB2): ' + mhz(c.pclk2Hz) + '   分频 ' + c.prescalers.ppre2 + '   (上限 72 MHz)');
  console.log('  ADCCLK     : ' + mhz(c.adcclkHz) + '   分频 ' + c.prescalers.adcpre);
  console.log('  HSI        : ' + (c.hsi.on ? '开' : '关') + ' / 就绪 ' + (c.hsi.ready ? '是' : '否') + '  (' + mhz(c.hsi.hz) + ')');
  console.log('  HSE        : ' + (c.hse.on ? '开' : '关') + ' / 就绪 ' + (c.hse.ready ? '是' : '否') + '  (' + mhz(c.hse.hz) + ')');
  console.log('  PLL        : ' + (c.pll.on ? '开' : '关') + ' / 就绪 ' + (c.pll.ready ? '是' : '否') +
    '  源 ' + c.pll.src + ' ×' + c.pll.mul + ' → ' + mhz(c.pll.outHz));

  console.log('');
  console.log('══ 外设时钟使能（芯片里真实开着的）══════════════════════');
  console.log('  APB2 : ' + (r.rcc.enabledAPB2.join('  ') || '（无）'));
  console.log('  APB1 : ' + (r.rcc.enabledAPB1.join('  ') || '（无）'));

  console.log('');
  console.log('══ GPIO 实际配置（从 CRL/CRH 解码）═══════════════════════');
  for (const p of ['A', 'B', 'C']) {
    const g = r.gpio[p];
    if (!g) continue;
    console.log('');
    console.log('  GPIO' + p + '   CRL=' + g.crl.toString(16).padStart(8, '0') +
      '  CRH=' + g.crh.toString(16).padStart(8, '0') +
      '  IDR=' + g.idrHex + '  ODR=' + g.odrHex);
    if (!g.used.length) { console.log('    （全部处于复位默认：浮空输入）'); continue; }
    g.used.forEach((pin) => {
      const lvl = pin.isInput ? ('输入电平 ' + pin.inputLevel) : ('输出电平 ' + pin.outputLevel);
      console.log('    ' + pin.name.padEnd(6) + String(pin.text).padEnd(16) +
        String(pin.speed || '—').padEnd(8) + lvl);
    });
  }

  /* ── 对照：源码分析 vs 芯片实际 ── */
  if (model) {
    const pm = scanProjectPins(model);
    const cmp = comparePinmapWithChip(pm, r);
    const TAG = {
      match: '✓ 一致',
      'mode-diff': '≠ 模式不同',
      'code-only': '✗ 代码有·芯片无',
      'chip-only': '✗ 芯片有·代码无',
      'debug-pin': '· 调试口（已排除）',
      indistinguishable: '· 浮空输入（无法区分）',
    };
    const RANK = { 'mode-diff': 0, 'code-only': 0, 'chip-only': 0, match: 1, 'debug-pin': 2, indistinguishable: 2 };
    console.log('');
    console.log('══ 源码分析 vs 芯片实际 ═════════════════════════════════');
    console.log('  ' + cmp.verdict);
    console.log('');
    console.log('  ' + '引脚'.padEnd(7) + '源码分析'.padEnd(20) + '芯片实际'.padEnd(32) + '状态');
    cmp.rows.slice().sort((a, b) => (RANK[a.status] - RANK[b.status]) || a.pin.localeCompare(b.pin)).forEach((row) => {
      console.log('  ' + row.pin.padEnd(7) + String(row.codeMode || '—').padEnd(20) +
        String(row.chipMode || '—').padEnd(32) + (TAG[row.status] || row.status));
    });
    console.log('');
    console.log('  统计：可比对 ' + cmp.comparable + ' 条 → 一致 ' + cmp.matched + ' · 实质差异 ' + cmp.realDiff +
      '（模式不同 ' + cmp.modeDiff + ' / 仅代码有 ' + cmp.codeOnly + ' / 仅芯片有 ' + cmp.chipOnly + '）');
    console.log('        另：调试口 ' + cmp.debugPin + ' 个，浮空输入无法区分 ' + cmp.indistinguishable + ' 个');
  }

  console.log('');
  console.log('══ RCC 寄存器原值 ═══════════════════════════════════════');
  r.rcc.regs.forEach((x) => console.log('  ' + x.name.padEnd(10) + x.value + '   ' + x.addr + '   ' + x.desc));
  console.log('');
})().catch((e) => { console.error('异常：' + (e && e.stack || e)); process.exit(2); });
