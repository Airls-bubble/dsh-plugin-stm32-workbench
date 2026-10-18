'use strict';
/**
 * pinmap.js —— 从工程源码里解析出「当前引脚配置」
 *
 * 为什么需要：Keil 只让你写代码，不告诉你这些代码最终把 48 个脚配成了什么。
 * 这个模块读**真正参与编译的源文件**（清单来自 .uvprojx），跟踪 SPL 的
 * GPIO_InitTypeDef / EXTI_InitTypeDef 变量状态，还原每个引脚的配置与冲突。
 *
 * 关键点：SPL 的结构体是**有状态**的 —— 同一个变量会被反复复用，只改 Pin 不改 Mode
 * （用户代码里 usart.c / esp8266.c / IRSensor.c 都是这种写法），所以必须按顺序跟踪。
 *
 * 只读：绝不修改任何源文件。
 */
const fs = require('fs');
const path = require('path');
const { readText } = require('./srcfile');

const PINS_JSON = path.join(__dirname, '..', 'data', 'pins.json');

/** Start / Library 是 ST 的第三方代码，不是用户配置 */
const LIB_GROUP = /^(start|library|cmsis|bsp)$/i;

/* ── 注释剥离：保留行结构，保护字符串里的 // 与 /* ── */
function stripComments(text) {
  const out = [];
  let inBlock = false;
  for (const raw of String(text).split(/\r?\n/)) {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end < 0) { out.push(''); continue; }
      line = line.slice(end + 2);
      inBlock = false;
    }
    let res = '';
    let i = 0;
    let inStr = false;
    let inChr = false;
    while (i < line.length) {
      const c = line[i], c2 = line[i + 1];
      if (inStr) {
        res += c;
        if (c === '\\') { if (c2) { res += c2; i += 2; continue; } }
        else if (c === '"') inStr = false;
        i++; continue;
      }
      if (inChr) {
        res += c;
        if (c === '\\') { if (c2) { res += c2; i += 2; continue; } }
        else if (c === "'") inChr = false;
        i++; continue;
      }
      if (c === '"') { inStr = true; res += c; i++; continue; }
      if (c === "'") { inChr = true; res += c; i++; continue; }
      if (c2 === '/' && c === '/') break;
      if (c2 === '*' && c === '/') {
        const end = line.indexOf('*/', i + 2);
        if (end < 0) { inBlock = true; break; }
        i = end + 2; continue;
      }
      res += c; i++;
    }
    out.push(res);
  }
  return out;
}

/* ── 中文描述表 ── */
const MODE_ZH = {
  GPIO_Mode_AIN: '模拟输入',
  GPIO_Mode_IN_FLOATING: '浮空输入',
  GPIO_Mode_IPD: '下拉输入',
  GPIO_Mode_IPU: '上拉输入',
  GPIO_Mode_Out_OD: '开漏输出',
  GPIO_Mode_Out_PP: '推挽输出',
  GPIO_Mode_AF_OD: '复用开漏',
  GPIO_Mode_AF_PP: '复用推挽',
};
const TRIGGER_ZH = {
  EXTI_Trigger_Rising: '上升沿触发',
  EXTI_Trigger_Falling: '下降沿触发',
  EXTI_Trigger_Rising_Falling: '双边沿触发',
};
const SPEED_ZH = { GPIO_Speed_10MHz: '10 MHz', GPIO_Speed_2MHz: '2 MHz', GPIO_Speed_50MHz: '50 MHz' };
const modeZh = (m) => MODE_ZH[m] || (m || '（未设置）');
const speedZh = (s) => SPEED_ZH[s] || s || '';

/** GPIO_Pin_3 | GPIO_Pin_5 → [3,5]；GPIO_Pin_All → 0..15 */
function parsePinExpr(expr) {
  const e = String(expr || '');
  if (/GPIO_Pin_All\b/.test(e)) return Array.from({ length: 16 }, (_, i) => i);
  const bits = [];
  const re = /GPIO_Pin_(\d+)\b/g;
  let m;
  while ((m = re.exec(e))) bits.push(parseInt(m[1], 10));
  return Array.from(new Set(bits)).sort((a, b) => a - b);
}

let _pins = null;
function loadPins() {
  if (_pins) return _pins;
  try {
    const raw = JSON.parse(fs.readFileSync(PINS_JSON, 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw.pins || []);
    _pins = { list: arr, byPort: new Map() };
    for (const e of arr) if (e && e.port) _pins.byPort.set(String(e.port).toUpperCase(), e);
  } catch (_) {
    _pins = { list: [], byPort: new Map() };
  }
  return _pins;
}

/* ── 初始化调用顺序 ──────────────────────────────────────────────
 * 「某个引脚最终是什么模式」取决于**运行时初始化顺序**，不是文件在工程清单里的排列。
 * 早先的实现按 .uvprojx 的分组顺序扫文件 —— 结论有时是对的，但理由不成立：
 * 把 main.c 里两次 Init 的顺序对调，它照样输出旧结论，还不告诉你在猜。
 * 这里从 main() 抽出真实调用序列，按它给文件排序；没被 main 调到的排在最后并标注。
 */

const KEYWORDS = new Set(['if', 'while', 'for', 'switch', 'return', 'sizeof', 'do',
  'else', 'case', 'break', 'continue', 'goto', 'defined']);

/** 抓函数定义名（要求前面带返回类型，避免把调用点当定义） */
const DEF_RE = /(?:^|\n)[ \t]*(?:static\s+|extern\s+)?(?:void|int|char|short|long|float|double|unsigned|signed|u?int(?:8|16|32|64)_t|size_t|u8|u16|u32)[\w\s\*]*?([A-Za-z_]\w*)\s*\([^;{)]*\)\s*\{/g;

/**
 * 解析初始化顺序。
 * 局限（如实记录）：只认 main() 的**直接调用**，不做递归调用图；宏包装的初始化调不到。
 */
function resolveInitOrder(model) {
  const sources = (model.sources || []).filter((s) => s.kind === 'c');
  const texts = new Map();
  const funcFile = new Map(); // 函数名 → 定义所在文件

  for (const s of sources) {
    let text;
    try { ({ text } = readText(s.abs)); } catch (_) { continue; }
    const clean = stripComments(text).join('\n');
    texts.set(s.raw, clean);
    DEF_RE.lastIndex = 0;
    let m;
    while ((m = DEF_RE.exec(clean))) {
      const name = m[1];
      if (!KEYWORDS.has(name) && !funcFile.has(name)) funcFile.set(name, s.raw);
    }
  }

  const mainSrc = sources.find((s) => /(^|[\\/])main\.c$/i.test(s.raw)) || null;
  const sequence = [];
  const files = [];

  if (mainSrc) {
    const text = texts.get(mainSrc.raw) || '';
    const start = text.search(/\b(?:int|void)\s+main\s*\(/);
    if (start >= 0) {
      const body = text.slice(start);
      const CALL_RE = /\b([A-Za-z_]\w*)\s*\(/g;
      const seen = new Set();
      let c;
      while ((c = CALL_RE.exec(body))) {
        const fn = c[1];
        if (KEYWORDS.has(fn) || seen.has(fn)) continue;
        seen.add(fn);
        const file = funcFile.get(fn);
        if (file && file !== mainSrc.raw) {
          sequence.push({ fn, file });
          if (files.indexOf(file) < 0) files.push(file);
        }
      }
    }
  }

  const unmapped = sources
    .map((s) => s.raw)
    .filter((f) => f !== (mainSrc && mainSrc.raw) && files.indexOf(f) < 0);

  return {
    method: mainSrc ? '按 main() 的直接调用顺序' : '没找到 main.c，退回工程清单顺序',
    entry: mainSrc ? mainSrc.raw : null,
    sequence,
    files,
    unmapped,
    confidence: (mainSrc && sequence.length) ? 'high' : 'low',
  };
}

/** 按初始化顺序重排源文件；main.c 本身与没被调到的排最后 */
function orderedSources(model, initOrder) {
  const c = (model.sources || []).filter((s) => s.kind === 'c');
  const byRaw = new Map(c.map((s) => [s.raw, s]));
  const out = [];
  for (const f of initOrder.files) {
    const s = byRaw.get(f);
    if (s) { out.push(s); byRaw.delete(f); }
  }
  for (const s of c) if (byRaw.has(s.raw)) out.push(s);
  return out;
}

/**
 * 扫描工程，还原引脚配置。
 * @param {object} model parseUvprojx() 的结果
 * @returns {object} 引脚配置报告
 */
function scanProjectPins(model) {
  if (!model || !Array.isArray(model.sources)) {
    throw new Error('scanProjectPins 需要 parseUvprojx() 的结果');
  }

  const events = [];      // GPIO 配置事件（按源码顺序）
  const extiRaw = [];     // EXTI 属性赋值
  const extiApplied = []; // EXTI_Init 应用结果
  const clockRows = [];   // 使能的外设时钟
  const notes = [];
  let order = 0;

  const initOrder = resolveInitOrder(model);

  for (const src of orderedSources(model, initOrder)) {
    if (src.kind !== 'c') continue;
    let text;
    try { ({ text } = readText(src.abs)); } catch (_) {
      notes.push({ level: 'warn', message: '读不了源文件：' + src.raw });
      continue;
    }
    const lines = stripComments(text);
    const vars = new Map();       // 变量名 → {pinExpr, mode, speed}
    const filePinPort = new Map(); // pin 号 → 该文件内最近一次配置的端口
    const extiVars = new Map();   // 变量名 → {line, trigger, mode, lineCmd}

    const getVar = (n) => {
      if (!vars.has(n)) vars.set(n, { pinExpr: null, mode: null, speed: null });
      return vars.get(n);
    };
    const getExti = (n) => {
      if (!extiVars.has(n)) extiVars.set(n, { line: null, trigger: null, mode: null, lineCmd: null, decl: null });
      return extiVars.get(n);
    };

    lines.forEach((line, idx) => {
      const L = line.trim();
      if (!L) return;
      const ln = idx + 1;
      let m;

      /* ① 外设时钟使能 */
      if ((m = /RCC_APB([12])PeriphClockCmd\s*\(([^)]*)\)/.exec(L))) {
        // 参数形如 (RCC_APB2Periph_GPIOA | RCC_APB2Periph_AFIO, ENABLE)
        const args = m[2].split(',');
        if (!/ENABLE/.test(args[1] || '')) return; // DISABLE 不算使能
        for (const part of (args[0] || '').split('|')) {
          const t = part.trim();
          if (/^RCC_APB[12]Periph_(GPIO[A-G]|AFIO|USART\d|TIM\d+|SPI\d|I2C\d|ADC\d|DMA\d|CAN\d?|PWR|BKP)$/.test(t)) {
            if (!clockRows.some((c) => c.periph === t)) {
              clockRows.push({ periph: t, file: src.raw, line: ln });
            }
          }
        }
        return;
      }

      /* ② 结构体属性（SPL 的用法是复用一个变量，必须按序跟踪） */
      if ((m = /(\w+)\s*\.\s*GPIO_Pin\s*=\s*([^;]+);/.exec(L))) { getVar(m[1]).pinExpr = m[2].trim(); return; }
      if ((m = /(\w+)\s*\.\s*GPIO_Mode\s*=\s*([^;]+);/.exec(L))) { getVar(m[1]).mode = m[2].trim(); return; }
      if ((m = /(\w+)\s*\.\s*GPIO_Speed\s*=\s*([^;]+);/.exec(L))) { getVar(m[1]).speed = m[2].trim(); return; }

      /* ③ 应用配置 */
      if ((m = /GPIO_Init\s*\(\s*(GPIO[A-G])\s*,\s*&\s*(\w+)\s*\)/.exec(L))) {
        const port = m[1].slice(-1);
        const v = getVar(m[2]);
        const bits = parsePinExpr(v.pinExpr);
        if (!bits.length) {
          notes.push({ level: 'warn', message: src.raw + ':' + ln + ' GPIO_Init 时 ' + m[2] + '.GPIO_Pin 未设置，无法判断引脚' });
        }
        for (const bit of bits) {
          events.push({
            port, bit,
            name: 'P' + port + bit,
            mode: v.mode, modeZh: modeZh(v.mode),
            speed: v.speed, speedZh: speedZh(v.speed),
            file: src.raw, line: ln, order: order++,
          });
          filePinPort.set(bit, port);
        }
        return;
      }

      /* ④ EXTI */
      if ((m = /(\w+)\s*\.\s*EXTI_Line\s*=\s*([^;]+);/.exec(L))) { getExti(m[1]).line = m[2].trim(); getExti(m[1]).decl = ln; return; }
      if ((m = /(\w+)\s*\.\s*EXTI_Trigger\s*=\s*([^;]+);/.exec(L))) { getExti(m[1]).trigger = m[2].trim(); return; }
      if ((m = /(\w+)\s*\.\s*EXTI_Mode\s*=\s*([^;]+);/.exec(L))) { getExti(m[1]).mode = m[2].trim(); return; }
      if ((m = /(\w+)\s*\.\s*EXTI_LineCmd\s*=\s*([^;]+);/.exec(L))) { getExti(m[1]).lineCmd = m[2].trim(); return; }
      if ((m = /EXTI_Init\s*\(\s*&\s*(\w+)\s*\)/.exec(L))) {
        const e = getExti(m[1]);
        const lineM = /EXTI_Line(\d+|16_?10)?/.exec(e.line || '');
        let lineNo = null;
        if (lineM) {
          if (e.line.indexOf('EXTI_Line16_10') >= 0 || e.line.indexOf('EXTI_Line10_15') >= 0) lineNo = '10-15';
          else lineNo = parseInt(lineM[1], 10);
        }
        extiApplied.push({
          varName: m[1], line: lineNo, lineExpr: e.line,
          trigger: e.trigger, triggerZh: TRIGGER_ZH[e.trigger] || e.trigger || '',
          mode: e.mode, lineCmd: e.lineCmd,
          port: (typeof lineNo === 'number' && filePinPort.has(lineNo)) ? filePinPort.get(lineNo) : null,
          file: src.raw, srcLine: ln,
        });
        return;
      }

      /* ⑤ 直接寄存器操作：只提示，不猜语义。
         库/启动代码（system_stm32f10x.c 的 AFIO 复位等）不算用户配置，跳过。 */
      if (/GPIO[A-G]\s*->\s*(CR[LH]|ODR|BSRR|BRR|IDR)/.test(L)) {
        if (LIB_GROUP.test(String(src.group || ''))) return;
        const reg = /(GPIO[A-G])\s*->\s*(\w+)/.exec(L);
        notes.push({ level: 'info', message: src.raw + ':' + ln + ' 直接操作寄存器 ' +
          (reg ? reg[1] + '->' + reg[2] : '') + '，静态解析不覆盖这类写法' });
      }
    });
  }

  /* ── 按引脚归并 ── */
  const { byPort } = loadPins();
  const pinMap = new Map();
  for (const ev of events) {
    if (!pinMap.has(ev.name)) {
      const meta = byPort.get(ev.name.toUpperCase()) || null;
      pinMap.set(ev.name, {
        name: ev.name, port: ev.port, bit: ev.bit,
        physicalPin: meta ? meta.pin : null,
        chipName: meta ? meta.name : null,
        type: meta ? meta.type : 'gpio',
        fiveVTolerant: meta ? !!meta.fiveVTolerant : null,
        configs: [], exti: null, conflict: false,
      });
    }
    pinMap.get(ev.name).configs.push(ev);
  }

  /* EXTI 关联到引脚 */
  for (const ex of extiApplied) {
    if (ex.port == null || typeof ex.line !== 'number') continue;
    const nm = 'P' + ex.port + ex.line;
    let p = pinMap.get(nm);
    if (!p) {
      const meta = byPort.get(nm.toUpperCase()) || null;
      p = { name: nm, port: ex.port, bit: ex.line, physicalPin: meta ? meta.pin : null,
        chipName: meta ? meta.name : null, type: meta ? meta.type : 'gpio',
        fiveVTolerant: meta ? !!meta.fiveVTolerant : null, configs: [], exti: null, conflict: false };
      pinMap.set(nm, p);
    }
    p.exti = { line: ex.line, trigger: ex.trigger, triggerZh: ex.triggerZh, mode: ex.mode, file: ex.file, srcLine: ex.srcLine };
  }

  /* ── 分三级，别用一个 "conflict" 盖住严重程度差很远的事 ──
   *   reinit        初始化阶段被覆盖，最终态明确（多为 SPL 复用结构体没重设 Mode），无害
   *   exti-mismatch EXTI 中断还开着但引脚最终是输出/复用 —— 真问题
   *   exti-clash    同一条 EXTI 线被两个端口抢
   */
  for (const p of pinMap.values()) {
    const finals = p.configs.map((c) => c.mode);
    const distinct = Array.from(new Set(finals));
    p.reinitCount = p.configs.length;
    p.reconfigured = p.configs.length > 1 && distinct.length > 1;
    p.final = p.configs.length ? p.configs[p.configs.length - 1] : null;
    p.conflict = false; // 真问题在下面判定
  }

  const all = Array.from(pinMap.values()).sort((a, b) => {
    if (a.port !== b.port) return a.port < b.port ? -1 : 1;
    return a.bit - b.bit;
  });

  const reconfigs = [];
  const conflicts = [];

  for (const p of all) {
    if (p.reconfigured) {
      reconfigs.push({
        pin: p.name, physicalPin: p.physicalPin, severity: 'info', kind: 'reinit',
        detail: p.configs.map((c) => c.file + ':' + c.line + ' → ' + c.modeZh).join('，随后 '),
        effective: p.final ? p.final.modeZh : null,
        effectiveAt: p.final ? p.final.file + ':' + p.final.line : null,
      });
    }
    /* EXTI 还开着，引脚却成了输出／复用 */
    if (p.exti && p.final && /GPIO_Mode_(Out|AF)/.test(p.final.mode || '')) {
      p.conflict = true;
      conflicts.push({
        pin: p.name, physicalPin: p.physicalPin, severity: 'danger', kind: 'exti-mode-mismatch',
        detail: '配了「' + p.exti.triggerZh + '」的 EXTI 中断，但该引脚最终被配成「' + p.final.modeZh +
          '」（' + p.final.file + ':' + p.final.line + '）—— 中断仍然会触发',
        effective: p.final.modeZh,
        effectiveAt: p.final.file + ':' + p.final.line,
        exti: p.exti.triggerZh,
      });
    }
  }

  /* 同一条 EXTI 线被两个引脚抢 */
  const byLine = new Map();
  for (const p of all) {
    if (!p.exti || typeof p.exti.line !== 'number') continue;
    if (!byLine.has(p.exti.line)) byLine.set(p.exti.line, []);
    byLine.get(p.exti.line).push(p);
  }
  for (const [line, arr] of byLine) {
    if (arr.length < 2) continue;
    arr.forEach((p) => { p.conflict = true; });
    conflicts.push({
      pin: arr.map((p) => p.name).join(' / '), physicalPin: arr[0].physicalPin,
      severity: 'warn', kind: 'exti-clash',
      detail: 'EXTI_Line' + line + ' 被 ' + arr.map((p) => p.name + '（' + p.exti.file + '）').join(' 和 ') +
        ' 同时占用 —— 同一条中断线只能挂一个引脚',
      effective: null, effectiveAt: null, exti: 'EXTI' + line,
    });
  }

  return {
    ok: true,
    project: { name: model.name, device: model.device, file: model.file },
    usedPins: all.length,
    pins: all,
    byPhysical: (() => {
      const o = {};
      for (const p of all) if (p.physicalPin != null) o[p.physicalPin] = p;
      return o;
    })(),
    exti: extiApplied,
    clocks: clockRows,
    conflicts,   // 真问题（带 severity: danger/warn）
    reconfigs,   // 初始化被覆盖但最终态明确的（severity: info，一般不用管）
    /** 「最终生效」是按什么顺序推的 —— 用来自证结论的依据，别让人以为是魔法 */
    orderSource: {
      method: initOrder.method,
      entry: initOrder.entry,
      confidence: initOrder.confidence,
      sequence: initOrder.sequence,
      unmapped: initOrder.unmapped,
    },
    notes,
  };
}

module.exports = { scanProjectPins, stripComments, parsePinExpr, MODE_ZH, TRIGGER_ZH, SPEED_ZH };
