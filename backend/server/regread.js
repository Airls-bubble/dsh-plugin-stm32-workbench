'use strict';
/**
 * regread.js —— 通过 SWD 直读芯片寄存器，并把它翻译成人能看懂的状态
 *
 * 读法：OpenOCD 的 mdw（memory display word）。halt → 读 → resume，程序只停极短时间。
 * 有意义的地方不是「读到 0x00000083」，而是：
 *   · RCC → 真实的 SYSCLK/HCLK/PCLK1/PCLK2 与时钟源（HSI 还是 HSE+PLL）
 *   · 哪些外设时钟真的开着（代码里写了 ENABLE 不等于芯片里真开着）
 *   · GPIOx_CRL/CRH → 每个引脚此刻在芯片里的真实模式（可与源码静态分析对照）
 *   · GPIOx_IDR/ODR → 引脚此刻的电平
 */
const { runOCD } = require('./openocd');
const { readText } = require('./srcfile');

/**
 * 找出真实的 HSE 晶振频率。
 *
 * ⚠️ 不能信 .uvprojx 里的 <Cpu>CLOCK(...)：那只是 Keil IDE 的显示值。
 * 用户的工程里写着 CLOCK(12000000)，但 stm32f10x.h 里 HSE_VALUE 是 8000000
 * （STM32F10X_CL 分支不生效，因为工程定义的是 STM32F10X_MD），
 * system_stm32f10x.c 又是 PLLMULL9 —— 实际 SYSCLK = 8MHz × 9 = 72 MHz。
 * 按 12 MHz 算会得出 108 MHz 的错误结论（看起来像严重超频）。
 *
 * 优先级：编译器宏 > stm32f10x.h 的 #define（区分 CL/非 CL 分支）> Keil CLOCK() 兜底
 */
function findHseValue(model) {
  // ① 编译器命令行里定义（#if !defined HSE_VALUE 会尊重它）
  const d = (model && model.defines || []).find((x) => /^HSE_VALUE\s*=/.test(x));
  if (d) {
    const v = parseInt(d.split('=')[1], 10);
    if (v > 0) return { hz: v, source: '.uvprojx 的编译器宏 ' + d, confident: true };
  }

  // ② 源码里的 #define
  const files = [].concat((model && model.headers) || [], (model && model.sources) || []);
  const isCL = !!((model && model.defines) || []).some((x) => x === 'STM32F10X_CL');
  for (const f of files) {
    if (!/stm32f10x\.h$/i.test(f.abs || '')) continue;
    let text;
    try { ({ text } = readText(f.abs)); } catch (_) { continue; }
    // 形如： #ifdef STM32F10X_CL \n #define HSE_VALUE ((uint32_t)25000000) ... #else \n #define HSE_VALUE ((uint32_t)8000000)
    const branch = /#ifdef\s+STM32F10X_CL\s*[\r\n]+\s*#define\s+HSE_VALUE\s+\(\(uint32_t\)(\d+)\)[\s\S]*?#else\s*[\r\n]+\s*#define\s+HSE_VALUE\s+\(\(uint32_t\)(\d+)\)/.exec(text);
    if (branch) {
      const hz = isCL ? parseInt(branch[1], 10) : parseInt(branch[2], 10);
      return {
        hz, source: f.raw + ' HSE_VALUE（' + (isCL ? 'STM32F10X_CL 分支' : '非 CL 分支') + '）',
        confident: true,
      };
    }
    const plain = /#define\s+HSE_VALUE\s+\(\(uint32_t\)(\d+)\)/.exec(text);
    if (plain) {
      return { hz: parseInt(plain[1], 10), source: f.raw + ' HSE_VALUE', confident: true };
    }
  }

  // ③ 兜底：Keil 里填的值（不可靠，标注出来）
  if (model && model.cpu && model.cpu.clockHz) {
    return {
      hz: model.cpu.clockHz,
      source: '.uvprojx 的 CLOCK()（Keil IDE 显示值，可能不准）',
      confident: false,
    };
  }
  return { hz: 8000000, source: '未知，按 STM32F103 最常见的 8 MHz 估算', confident: false };
}

/* ── 寄存器地址 ── */
const RCC_BASE = 0x40021000;
const GPIO_BASE = { A: 0x40010800, B: 0x40010C00, C: 0x40011000, D: 0x40011400, E: 0x40011800 };

const RCC_REGS = [
  ['CR', 0x00, '时钟控制'],
  ['CFGR', 0x04, '时钟配置'],
  ['CIR', 0x08, '时钟中断'],
  ['APB2RSTR', 0x0C, 'APB2 复位'],
  ['APB1RSTR', 0x10, 'APB1 复位'],
  ['AHBENR', 0x14, 'AHB 时钟使能'],
  ['APB2ENR', 0x18, 'APB2 时钟使能'],
  ['APB1ENR', 0x1C, 'APB1 时钟使能'],
  ['BDCR', 0x20, '备份域控制'],
  ['CSR', 0x24, '控制状态'],
];

const APB2_BITS = {
  0: 'AFIO', 2: 'GPIOA', 3: 'GPIOB', 4: 'GPIOC', 5: 'GPIOD', 6: 'GPIOE', 7: 'GPIOF', 8: 'GPIOG',
  9: 'ADC1', 10: 'ADC2', 11: 'TIM1', 12: 'SPI1', 13: 'TIM8', 14: 'USART1', 15: 'ADC3',
  16: 'TIM9', 17: 'TIM10', 18: 'TIM11',
};
const APB1_BITS = {
  0: 'TIM2', 1: 'TIM3', 2: 'TIM4', 3: 'TIM5', 4: 'TIM6', 5: 'TIM7', 6: 'TIM12', 7: 'TIM13', 8: 'TIM14',
  11: 'WWDG', 14: 'SPI2', 15: 'SPI3', 17: 'USART2', 18: 'USART3', 19: 'UART4', 20: 'UART5',
  21: 'I2C1', 22: 'I2C2', 23: 'USB', 25: 'CAN', 27: 'BKP', 28: 'PWR', 29: 'DAC',
};

/* ── 解析 OpenOCD 的 mdw 输出 ── */
function parseMdw(text) {
  const map = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^(0x[0-9a-fA-F]+):\s*((?:[0-9a-fA-F]{8}\s*)+)/.exec(line.trim());
    if (!m) continue;
    const base = parseInt(m[1], 16);
    m[2].trim().split(/\s+/).forEach((w, i) => map.set(base + i * 4, parseInt(w, 16) >>> 0));
  }
  return map;
}

/* ── 时钟树解码 ── */
const PLL_SRC = { 0: 'HSI/2', 1: 'HSE' };
const SW_SRC = { 0: 'HSI', 1: 'HSE', 2: 'PLL', 3: '（保留）' };

function hpreDiv(v) {
  if (v < 0x8) return 1;
  return [2, 4, 8, 16, 64, 128, 256, 512][v - 0x8];
}
function ppreDiv(v) {
  if (v < 0x4) return 1;
  return [2, 4, 8, 16][v - 0x4];
}
function pllMul(v) { return v < 14 ? v + 2 : 16; }

/**
 * @param {Map<number,number>} regs
 * @param {number} hseHz 板上晶振频率（来自 .uvprojx 的 CLOCK(...)，读不到时按 8 MHz）
 */
function decodeClock(regs, hseHz) {
  const cr = regs.get(RCC_BASE + 0x00) || 0;
  const cfgr = regs.get(RCC_BASE + 0x04) || 0;

  const hsiOn = !!(cr & (1 << 0));
  const hsiReady = !!(cr & (1 << 1));
  const hseOn = !!(cr & (1 << 16));
  const hseReady = !!(cr & (1 << 17));
  const pllOn = !!(cr & (1 << 24));
  const pllReady = !!(cr & (1 << 25));

  const sw = cfgr & 0x3;
  const sws = (cfgr >> 2) & 0x3;
  const hpre = hpreDiv((cfgr >> 4) & 0xF);
  const ppre1 = ppreDiv((cfgr >> 8) & 0x7);
  const ppre2 = ppreDiv((cfgr >> 11) & 0x7);
  const adcpre = [2, 4, 6, 8][(cfgr >> 14) & 0x3];
  const pllsrc = (cfgr >> 16) & 0x1;
  const pllxtpre = (cfgr >> 17) & 0x1;
  const mul = pllMul((cfgr >> 18) & 0xF);

  const HSI = 8000000;
  const HSE = hseHz || 8000000;
  const pllInput = pllsrc === 0 ? HSI / 2 : (pllxtpre ? HSE / 2 : HSE);
  const pllOut = pllInput * mul;

  const sourceHz = { 0: HSI, 1: HSE, 2: pllOut }[sws] || HSI;
  const sysclk = sourceHz;
  const hclk = sysclk / hpre;
  const pclk1 = hclk / ppre1;
  const pclk2 = hclk / ppre2;

  return {
    source: SW_SRC[sws] || '?',
    swRequested: SW_SRC[sw] || '?',
    hsi: { on: hsiOn, ready: hsiReady, hz: HSI },
    hse: { on: hseOn, ready: hseReady, hz: HSE, source: hseHz ? '来自 .uvprojx 的 CLOCK()' : '未知，按 8 MHz 估算' },
    pll: { on: pllOn, ready: pllReady, src: PLL_SRC[pllsrc], inputHz: pllInput, mul, outHz: pllOut },
    sysclkHz: sysclk,
    hclkHz: hclk,
    pclk1Hz: pclk1,
    pclk2Hz: pclk2,
    adcclkHz: pclk2 / adcpre,
    prescalers: { hpre, ppre1, ppre2, adcpre },
    /** 与 72 MHz 上限的对照，方便一眼看出超频/降频 */
    targets: { maxSysclk: 72000000, maxPclk1: 36000000, maxPclk2: 72000000 },
  };
}

/* ── GPIO 引脚模式解码 ── */
function decodeGpioPin(crWord, bitInWord, odrBit) {
  const shift = (bitInWord % 8) * 4;
  const mode = (crWord >> shift) & 0x3;
  const cnf = (crWord >> (shift + 2)) & 0x3;
  const speed = mode === 0 ? null : { 1: '10 MHz', 2: '2 MHz', 3: '50 MHz' }[mode];
  let text;
  if (mode === 0) {
    text = ['模拟输入', '浮空输入', odrBit ? '上拉输入' : '下拉输入', '保留'][cnf];
  } else {
    text = ['通用推挽输出', '通用开漏输出', '复用推挽输出', '复用开漏输出'][cnf];
  }
  return { mode, cnf, speed, text, isInput: mode === 0 };
}

/**
 * 读寄存器。
 * @param {object} opts { hseHz, onLine }
 */
async function readRegisters(opts = {}) {
  const { hseHz, onLine = () => {} } = opts;

  const fs = require('fs');
  const path = require('path');
  // 临时 cfg 放系统临时目录，不写进插件本体（插件目录要能随时整包拷走）
  const cfgDir = require('./paths').transientDir();
  const cfgFile = path.join(cfgDir, '_regread.cfg');
  fs.writeFileSync(cfgFile, ['adapter speed 1000', 'transport select swd'].join('\n') + '\n', 'utf8');

  const cmds = ['init', 'halt'];
  // RCC 0x00–0x24 共 10 个
  cmds.push('mdw 0x' + RCC_BASE.toString(16) + ' 10');
  for (const p of ['A', 'B', 'C']) {
    cmds.push('mdw 0x' + GPIO_BASE[p].toString(16) + ' 7'); // CRL CRH IDR ODR BSRR BRR LCKR
  }
  cmds.push('reg');
  cmds.push('resume');
  cmds.push('exit');

  const r = await runOCD(cfgFile, cmds, onLine);
  if (!r.ok) {
    return { ok: false, connected: false, reason: 'OpenOCD 执行失败：' + (r.errors && r.errors[0] || '未知原因'), raw: r.text };
  }

  const regs = parseMdw(r.text);
  if (!regs.size) {
    return { ok: false, connected: false, reason: '没读到任何寄存器 —— ST-Link 未连接或目标未上电', raw: r.text };
  }

  const clock = decodeClock(regs, hseHz);

  /* 外设时钟使能位 → 可读清单 */
  const apb2enr = regs.get(RCC_BASE + 0x18) || 0;
  const apb1enr = regs.get(RCC_BASE + 0x1C) || 0;
  const ahbenr = regs.get(RCC_BASE + 0x14) || 0;
  const enabledA = Object.keys(APB2_BITS).filter((b) => apb2enr & (1 << +b)).map((b) => APB2_BITS[b]);
  const enabledB = Object.keys(APB1_BITS).filter((b) => apb1enr & (1 << +b)).map((b) => APB1_BITS[b]);

  /* GPIO 解码 */
  const gpio = {};
  for (const p of ['A', 'B', 'C']) {
    const base = GPIO_BASE[p];
    if (!regs.has(base)) continue;
    const crl = regs.get(base + 0x00) || 0;
    const crh = regs.get(base + 0x04) || 0;
    const idr = regs.get(base + 0x08) || 0;
    const odr = regs.get(base + 0x0C) || 0;
    const pins = [];
    for (let bit = 0; bit < 16; bit++) {
      const decoded = decodeGpioPin(bit < 8 ? crl : crh, bit, (odr >> bit) & 1);
      // 复位默认值：输入浮空 + 0 → 视为「未配置」
      const unconfigured = decoded.mode === 0 && decoded.cnf === 1;
      pins.push({
        name: 'P' + p + bit, bit,
        ...decoded,
        configured: !unconfigured,
        inputLevel: (idr >> bit) & 1,
        outputLevel: (odr >> bit) & 1,
      });
    }
    gpio[p] = {
      base: '0x' + base.toString(16), crl, crh, idr, odr,
      idrHex: '0x' + idr.toString(16).padStart(8, '0'),
      odrHex: '0x' + odr.toString(16).padStart(8, '0'),
      pins,
      used: pins.filter((x) => x.configured),
    };
  }

  /* 内核寄存器（OpenOCD 的 reg 输出形如：(15) pc (/32): 0x08000276） */
  const core = {};
  for (const line of r.text.split(/\r?\n/)) {
    const m = /^\((\d+)\)\s+(\w+)\s+\S+:\s*(0x[0-9a-fA-F]+)/.exec(line.trim());
    if (m) core[m[2]] = { index: +m[1], value: m[3] };
  }

  return {
    ok: true, connected: true,
    clock,
    rcc: {
      regs: RCC_REGS.map(([name, off, desc]) => ({
        name, desc, addr: '0x' + (RCC_BASE + off).toString(16),
        value: '0x' + ((regs.get(RCC_BASE + off) || 0) >>> 0).toString(16).padStart(8, '0'),
      })),
      apb2enr, apb1enr, ahbenr,
      enabledAPB2: enabledA,
      enabledAPB1: enabledB,
    },
    gpio,
    core,
    raw: { regs: Object.fromEntries([...regs].map(([a, v]) => ['0x' + a.toString(16), '0x' + v.toString(16).padStart(8, '0')])) },
  };
}

/** 把两侧的模式名归一到同一套代号，便于比较 */
function normMode(s) {
  const t = String(s || '');
  if (/复用推挽/.test(t)) return 'AF_PP';
  if (/复用开漏/.test(t)) return 'AF_OD';
  if (/推挽/.test(t)) return 'OUT_PP';
  if (/开漏/.test(t)) return 'OUT_OD';
  if (/上拉/.test(t)) return 'IPU';
  if (/下拉/.test(t)) return 'IPD';
  if (/浮空/.test(t)) return 'IN_FLOATING';
  if (/模拟/.test(t)) return 'AIN';
  if (/输入/.test(t)) return 'IN';
  return t || '?';
}

/** SWD/JTAG 引脚：调试器连上时会自动配置它们，不代表程序行为，对照时要排除 */
const DEBUG_PINS = new Set(['PA13', 'PA14', 'PA15', 'PB3', 'PB4']);

/**
 * 对照「源码静态分析」与「芯片里的实际配置」。
 * 这是整个工作台最有价值的一步：能立刻看出板子上跑的是不是这份代码。
 *
 * 两类必须排除的假差异（否则会误报程序不对）：
 *   · 浮空输入的值（CRL/CRH = 0x4）**等于复位默认值** —— 芯片里分不出「主动配成浮空」和「从没配过」
 *   · SWD/JTAG 引脚被调试器配置 —— 跟被烧的程序无关
 */
function comparePinmapWithChip(pinmap, reg) {
  const code = new Map();
  (pinmap && pinmap.pins || []).forEach((p) => {
    code.set(p.name, {
      mode: (p.final && p.final.modeZh) || (p.configs[0] && p.configs[0].modeZh) || null,
      exti: p.exti || null,
    });
  });
  const chip = new Map();
  for (const port of Object.keys((reg && reg.gpio) || {})) {
    for (const p of reg.gpio[port].pins) if (p.configured) chip.set(p.name, p);
  }

  const rows = [];
  for (const n of [...new Set([...code.keys(), ...chip.keys()])].sort()) {
    const c = code.get(n), h = chip.get(n);
    if (c && h) {
      const same = normMode(c.mode) === normMode(h.text);
      rows.push({ pin: n, status: same ? 'match' : 'mode-diff', codeMode: c.mode, chipMode: h.text, chipSpeed: h.speed });
    } else if (c) {
      const floaty = normMode(c.mode) === 'IN_FLOATING';
      rows.push({
        pin: n, status: floaty ? 'indistinguishable' : 'code-only',
        codeMode: c.mode, chipMode: floaty ? '（浮空输入＝复位默认值，寄存器无法区分）' : '（芯片里未配置）',
      });
    } else {
      const dbg = DEBUG_PINS.has(n);
      rows.push({
        pin: n, status: dbg ? 'debug-pin' : 'chip-only',
        codeMode: dbg ? '（SWD/JTAG 引脚）' : '（代码里没有）',
        chipMode: h.text, chipSpeed: h.speed,
      });
    }
  }

  const count = (s) => rows.filter((r) => r.status === s).length;
  const matched = count('match');
  const modeDiff = count('mode-diff');
  const codeOnly = count('code-only');
  const chipOnly = count('chip-only');
  const debugPin = count('debug-pin');
  const indistinguishable = count('indistinguishable');
  const realDiff = modeDiff + codeOnly + chipOnly;

  let verdict;
  if (!rows.length) {
    verdict = '两边都没有配置任何引脚';
  } else if (realDiff === 0) {
    const notes = [];
    if (indistinguishable) notes.push(indistinguishable + ' 个配成浮空输入（与复位默认值相同，寄存器无法区分）');
    if (debugPin) notes.push(debugPin + ' 个 SWD/JTAG 引脚由调试器配置，已排除');
    verdict = '一致 —— ' + matched + ' 个可比对引脚全部吻合' + (notes.length ? '；' + notes.join('；') : '');
  } else if (codeOnly > matched) {
    verdict = '对不上 —— 芯片里缺了多数引脚，板子上跑的程序很可能不是这份代码编译出来的';
  } else {
    verdict = '有 ' + realDiff + ' 条实质差异 —— 见下表逐条';
  }

  return {
    rows, matched, modeDiff, codeOnly, chipOnly, debugPin, indistinguishable,
    realDiff, total: rows.length, comparable: matched + realDiff, verdict,
  };
}

module.exports = {
  readRegisters, decodeClock, decodeGpioPin, parseMdw, findHseValue,
  comparePinmapWithChip, normMode,
  RCC_BASE, GPIO_BASE, RCC_REGS, APB2_BITS, APB1_BITS,
};
