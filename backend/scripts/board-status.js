'use strict';
/**
 * board-status.js —— 快速看板子此刻的状态：时钟 / 外设使能 / GPIO / 程序计数器
 * 用于确认「刚烧进去的固件是不是真的在跑」。
 * 用法：node scripts/board-status.js [HSE_MHz]
 */
const { readRegisters } = require('../server/regread');

const hseHz = Math.round(parseFloat(process.argv[2] || '8') * 1e6);

(async () => {
  const r = await readRegisters({ hseHz });
  if (!r.ok) {
    console.log('✗ 读不到：' + r.reason);
    console.log('  检查 ST-Link 是否插好、SWD 四根线是否接对、板子是否上电。');
    process.exit(1);
  }
  const c = r.clock;
  console.log('时钟      ：' + c.source + '　SYSCLK ' + (c.sysclkHz / 1e6).toFixed(1) + ' MHz' +
    '　PCLK1 ' + (c.pclk1Hz / 1e6).toFixed(1) + ' MHz　PCLK2 ' + (c.pclk2Hz / 1e6).toFixed(1) + ' MHz');
  console.log('HSE       ：' + (c.hse.on ? '开' : '关') + ' / 就绪 ' + (c.hse.ready ? '是' : '否'));
  console.log('APB2 使能 ：' + (r.rcc.enabledAPB2.join('  ') || '（无）'));
  console.log('APB1 使能 ：' + (r.rcc.enabledAPB1.join('  ') || '（无）'));
  console.log('AHBENR    ：0x' + r.rcc.ahbenr.toString(16).padStart(8, '0'));
  for (const p of ['A', 'B', 'C']) {
    const g = r.gpio[p];
    if (!g) continue;
    console.log('GPIO' + p + '     ：' +
      (g.used.map((x) => x.name + '（' + x.text + '）').join('　') || '（全部复位默认）'));
  }

  const pc = r.core.pc, sp = r.core.msp || r.core.sp, psr = r.core.xpsr;
  const pcs = pc ? pc.value : '?';
  console.log('内核      ：PC ' + pcs + '　SP ' + (sp ? sp.value : '?') + '　xPSR ' + (psr ? psr.value : '?'));
  if (pc) {
    const v = parseInt(pc.value, 16);
    if (v >= 0x08000000 && v < 0x08010000) {
      console.log('           → PC 落在 Flash 代码区，程序正在运行 ✓');
    } else if (v >= 0x20000000 && v < 0x20005000) {
      console.log('           → PC 落在 SRAM，程序可能跑飞了或在 RAM 里执行');
    } else {
      console.log('           → PC 不在常规范围，可能停在异常向量或处于调试态');
    }
  }
})().catch((e) => { console.error('异常：' + (e && e.stack || e)); process.exit(2); });
