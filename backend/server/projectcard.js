'use strict';
/**
 * projectcard.js —— 工程卡：`<工程>/.dsh-mcu/project.json`
 *
 * 为什么要有它（2026-10-24 定）：
 *   AI 换工程时真正需要知道的是「这块板子现在是什么」——芯片、工具链、烧录端口、串口、
 *   引脚表、外设。这些信息现在一半藏在 `.uvprojx`（XML，只为 Keil 服务，换个 ESP-IDF
 *   工程就完全不适用），一半根本不存在（引脚分配、烧录端口只在人脑子里）。
 *   于是每换一个工程，模型都要重新解析工程文件 + 扫一遍源码，还得猜。
 *
 *   解法：把「工程事实」抽成一份**与工具链无关**的 JSON。AI 只读它；工具链（Keil /
 *   ESP-IDF / PlatformIO）降级成可替换的执行后端，各自去实现 build/flash。
 *
 * 三条边界（不是洁癖，是踩过的坑）：
 *   ① 卡里只写**有证据**的东西。导入器只填 .uvprojx 里确实存在的字段，其余留空，
 *      由 validate 报「缺失」。引脚表与串口**绝不猜** —— 猜错的引脚表比没有更糟。
 *   ② 写入是**深合并**：日常只发改动字段（和 features.json 的增量补丁同一个思路），
 *      数组整体替换，`null` 表示删除该字段。整份重写既费 token 又容易丢手写内容。
 *   ③ 与 features.json 分工：卡 = 硬件/工具链事实（一年改几次）；契约 = 行为
 *      （每次迭代都改）。两层分开，模型每次只读改动的那一层。
 *
 * 位置为什么在 .dsh-mcu/ 下：和 features.json、构建账本放一起，切工程即换一整套。
 * 想让工程卡进 git（跟着仓库走），在工程 .gitignore 里加一行 `!.dsh-mcu/project.json`。
 */
const fs = require('fs');
const path = require('path');

const CARD_NAME = 'project.json';
const DATA_DIR = '.dsh-mcu';
const SCHEMA_VERSION = 1;

/** 已知芯片家族；未知的写 other，validate 只提示不拦 */
const FAMILIES = ['stm32', 'esp32', 'rp2040', 'avr', 'other'];

/** 已知构建后端。新增后端时这里加名字，卡不用改格式 */
const BACKENDS = ['keil-ac5', 'esp-idf', 'platformio', 'arduino', 'cmake', 'none'];

/** 不做「聪明猜测」的跳目录（构建产物里也可能有 .uvprojx 缓存） */
const SKIP_DIRS = new Set(['Objects', 'Listings', 'DebugConfig', 'node_modules', '.git',
  'build', 'Output', 'RTE', 'DebugConfig', 'Backup', '.vs', '.dsh-mcu']);

/* ───────────────────────── 路径 ───────────────────────── */

function stripQuotes(input) {
  return String(input == null ? '' : input).trim()
    .replace(/^["'\u201c\u201d\u2018\u2019]+/, '')
    .replace(/["'\u201c\u201d\u2018\u2019]+$/, '')
    .trim();
}

function cardFileOf(dir) {
  return path.join(dir, DATA_DIR, CARD_NAME);
}

/** 从工程卡文件反推工程目录：`<工程>/.dsh-mcu/project.json` → `<工程>` */
function projectDirOfCard(cardFile) {
  const parent = path.dirname(cardFile);
  return path.basename(parent) === DATA_DIR ? path.dirname(parent) : parent;
}

/**
 * 把调用方给的路径统一成 { dir, cardFile, uvprojx? }。
 * 接受：工程目录 / .dsh-mcu/project.json / .uvprojx（导入时）。
 * @throws {Error & {code:string}} NO_PATH（不存在）/ BAD_PATH（类型不认）
 */
function resolve(input) {
  const s = stripQuotes(input);
  if (!s) {
    const e = new Error('需要 path：工程目录、.dsh-mcu/project.json 或 .uvprojx');
    e.code = 'NO_PATH'; throw e;
  }
  const p = path.resolve(s);
  let st;
  try { st = fs.statSync(p); } catch (_) {
    const e = new Error('路径不存在：' + p);
    e.code = 'NO_PATH'; throw e;
  }
  if (st.isDirectory()) return { dir: p, cardFile: cardFileOf(p) };
  const base = path.basename(p);
  if (base.toLowerCase() === CARD_NAME) {
    return { dir: projectDirOfCard(p), cardFile: p };
  }
  if (/\.uvprojx$/i.test(base)) {
    return { dir: path.dirname(p), cardFile: cardFileOf(path.dirname(p)), uvprojx: p };
  }
  const e = new Error('project 只认工程目录、.dsh-mcu/project.json 或 .uvprojx，收到：' + p);
  e.code = 'BAD_PATH'; throw e;
}

/** 在目录里找 .uvprojx（限深度，最多 30 个，跳过构建产物目录） */
function findUvprojx(dir, maxDepth = 3, depth = 0, out = []) {
  if (depth > maxDepth || out.length >= 30) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (out.length >= 30) break;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) findUvprojx(path.join(dir, e.name), maxDepth, depth + 1, out);
    } else if (/\.uvprojx$/i.test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

/* ───────────────────────── 规范化 ───────────────────────── */

/** STM32：PB8 / pB08 → PB8；ESP32：4 / IO4 / gpio04 → GPIO4 */
function normalizePin(raw, family) {
  const s = String(raw == null ? '' : raw).trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return '';
  const fam = String(family || '').toLowerCase();
  if (fam === 'stm32') {
    const m = /^P([A-K])([0-9]{1,2})$/.exec(s);
    return m ? 'P' + m[1] + parseInt(m[2], 10) : s;
  }
  if (fam === 'esp32') {
    const m = /^(?:GPIO|IO)([0-9]{1,2})$/.exec(s);
    if (m) return 'GPIO' + parseInt(m[1], 10);
    if (/^[0-9]{1,2}$/.test(s)) return 'GPIO' + parseInt(s, 10);
    return s;
  }
  return s;
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 深合并：对象递归合并、数组整体替换、null 删除字段。
 * 这样模型只发改动的一小段 JSON 就能改卡，不用把整份重述一遍。
 */
function deepMerge(base, patch) {
  const out = isPlainObject(base) ? Object.assign({}, base) : {};
  Object.keys(patch || {}).forEach((k) => {
    const v = patch[k];
    if (v === null) { delete out[k]; return; }
    if (isPlainObject(v)) { out[k] = deepMerge(isPlainObject(out[k]) ? out[k] : {}, v); return; }
    out[k] = Array.isArray(v) ? v.slice() : v;
  });
  return out;
}

/** 模型爱把 JSON 包在 ```json 里 —— 剥掉再解析 */
function parseJsonLoose(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) { const e = new Error('content 为空'); e.code = 'BAD_JSON'; throw e; }
  const cleaned = raw.replace(/^```[A-Za-z]*\s*/, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(cleaned); } catch (err) {
    const e = new Error('content 不是合法 JSON：' + String(err.message || err));
    e.code = 'BAD_JSON'; throw e;
  }
}

function slug(s) {
  const out = String(s == null ? '' : s).trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
  return out.slice(0, 40) || 'project';
}

/** 器件型号 → 家族（只做前缀匹配，认不出的老实写 other） */
function familyOfDevice(device) {
  const d = String(device || '').toUpperCase();
  if (/^STM32/.test(d)) return 'stm32';
  if (/^ESP32/.test(d)) return 'esp32';
  if (/^RP2040/.test(d)) return 'rp2040';
  if (/^(ATMEGA|ATTINY)/.test(d)) return 'avr';
  return 'other';
}

/** 器件型号 → OpenOCD target 配置文件（OpenOCD 自己的命名，别自创） */
function ocdTargetOf(device) {
  const table = [
    [/^STM32F0/, 'target/stm32f0x.cfg'], [/^STM32F1/, 'target/stm32f1x.cfg'],
    [/^STM32F2/, 'target/stm32f2x.cfg'], [/^STM32F3/, 'target/stm32f3x.cfg'],
    [/^STM32F4/, 'target/stm32f4x.cfg'], [/^STM32F7/, 'target/stm32f7x.cfg'],
    [/^STM32G0/, 'target/stm32g0x.cfg'], [/^STM32G4/, 'target/stm32g4x.cfg'],
    [/^STM32H7/, 'target/stm32h7x.cfg'], [/^STM32L0/, 'target/stm32l0.cfg'],
    [/^STM32L1/, 'target/stm32l1.cfg'], [/^STM32L4/, 'target/stm32l4x.cfg'],
    [/^ESP32S3/, 'target/esp32s3.cfg'], [/^ESP32S2/, 'target/esp32s2.cfg'],
    [/^ESP32/, 'target/esp32.cfg'],
  ];
  const d = String(device || '').toUpperCase();
  for (const [re, cfg] of table) if (re.test(d)) return cfg;
  return null;
}

/* ───────────────────────── 校验 ───────────────────────── */

/**
 * 校验工程卡。**不抛异常**：坏卡也要能读出来给人/模型看，所以统一返回
 * { ok, errors, warnings, missing, counts }。
 *
 * errors   = 自相矛盾（引脚冲突、schema 不对）→ 必须修
 * warnings = 可疑但可能是真的（不在引脚表的引用、文件被改名）
 * missing  = 还没填的关键信息 → 不是错误，是「下一步该补什么」
 */
function validate(card, ctx) {
  const errors = [];
  const warnings = [];
  const missing = [];
  const emptyCounts = { pins: 0, reserved: 0, peripherals: 0 };
  if (!isPlainObject(card)) {
    return { ok: false, errors: ['工程卡必须是一个 JSON 对象'], warnings, missing, counts: emptyCounts };
  }

  if (card.schema !== SCHEMA_VERSION) {
    errors.push('schema 必须是 ' + SCHEMA_VERSION + '（收到 ' + JSON.stringify(card.schema) + '）');
  }

  const target = isPlainObject(card.target) ? card.target : {};
  const familyRaw = String(target.family || '').trim();
  const family = familyRaw.toLowerCase();
  if (!familyRaw) errors.push('target.family 缺了（stm32 / esp32 / rp2040 / other）');
  else if (FAMILIES.indexOf(family) < 0) {
    warnings.push('target.family "' + familyRaw + '" 不在已知列表 ' + FAMILIES.join('/') + ' 里（工具按 other 处理）');
  }
  if (!target.chip) missing.push('芯片型号未填（target.chip）');

  /* 引脚：规范化后判重、判保留脚、判格式 */
  const pinMap = card.pins && Array.isArray(card.pins.map) ? card.pins.map : [];
  const reserved = card.pins && Array.isArray(card.pins.reserved) ? card.pins.reserved : [];
  const reservedSet = new Set();
  reserved.forEach((r) => {
    const raw = isPlainObject(r) ? (r.pin != null ? r.pin : r.gpio) : r;
    const pin = normalizePin(raw, family);
    if (!pin) { warnings.push('pins.reserved 里有一项没写 pin'); return; }
    if (reservedSet.has(pin)) warnings.push('保留脚重复登记：' + pin);
    reservedSet.add(pin);
  });
  const seen = new Map();
  pinMap.forEach((entry) => {
    const obj = isPlainObject(entry) ? entry : { pin: entry };
    const pin = normalizePin(obj.pin != null ? obj.pin : obj.gpio, family);
    const signal = obj.signal != null ? String(obj.signal) : '';
    if (!pin) { warnings.push('pins.map 里有一项没写 pin'); return; }
    if (family === 'stm32' && !/^P[A-K][0-9]{1,2}$/.test(pin)) {
      warnings.push('引脚名不像 STM32：' + pin + '（形如 PB8）');
    }
    if (family === 'esp32' && !/^GPIO[0-9]{1,2}$/.test(pin)) {
      warnings.push('引脚名不像 ESP32：' + pin + '（形如 GPIO4 或 4）');
    }
    if (reservedSet.has(pin)) {
      errors.push('引脚冲突：' + pin + ' 已声明为保留脚，却又分配给了 ' + (signal || '(未命名信号)'));
    }
    const prev = seen.get(pin);
    if (prev) {
      const prevSignal = prev.signal != null ? String(prev.signal) : '';
      if (prevSignal !== signal) {
        errors.push('引脚冲突：' + pin + ' 同时被 ' + (prevSignal || '?') + ' 和 ' + (signal || '?') + ' 使用');
      } else {
        warnings.push('引脚重复登记：' + pin + '（' + (signal || '?') + '）');
      }
    } else {
      seen.set(pin, obj);
    }
  });
  if (!pinMap.length) missing.push('引脚表为空（pins.map）—— AI 只能读代码猜引脚');

  /* 外设：只检查「像引脚的字符串」是否在表里，不猜外设语义 */
  const per = card.peripherals && Array.isArray(card.peripherals) ? card.peripherals : [];
  const looksLikePin = (v) => {
    const s = String(v || '').trim();
    if (family === 'esp32') return /^(?:GPIO|IO)[0-9]{1,2}$/i.test(s);
    if (family === 'stm32') return /^P[A-K][0-9]{1,2}$/i.test(s);
    return /^P[A-K][0-9]{1,2}$/i.test(s) || /^(?:GPIO|IO)[0-9]{1,2}$/i.test(s);
  };
  per.forEach((x, i) => {
    if (!isPlainObject(x)) { warnings.push('peripherals[' + i + '] 不是对象'); return; }
    const label = x.name || x.type || ('#' + i);
    Object.keys(x).forEach((k) => {
      const v = x[k];
      if (typeof v !== 'string' || !looksLikePin(v)) return;
      const pin = normalizePin(v, family);
      if (!seen.has(pin) && !reservedSet.has(pin)) {
        warnings.push('外设 ' + label + ' 的 ' + k + '=' + v + ' 不在引脚表里');
      }
    });
  });

  /* 工具链 */
  const tool = isPlainObject(card.toolchain) ? card.toolchain : {};
  const backend = String(tool.backend || '').trim();
  if (!backend) errors.push('toolchain.backend 缺了（keil-ac5 / esp-idf / platformio / arduino / cmake）');
  else if (BACKENDS.indexOf(backend) < 0) warnings.push('未知 toolchain.backend：' + backend);
  if (backend === 'keil-ac5' && !tool.projectFile) missing.push('Keil 工程文件名未填（toolchain.projectFile）');
  if (backend === 'keil-ac5' && tool.projectFile && ctx && ctx.dir) {
    if (!fs.existsSync(path.resolve(ctx.dir, String(tool.projectFile)))) {
      warnings.push('toolchain.projectFile 指向的文件不存在：' + tool.projectFile + '（改名或移动了？）');
    }
  }

  /* 运行期：烧录端口是换电脑/换板子最容易错的一项，缺了就明说 */
  const rt = isPlainObject(card.runtime) ? card.runtime : {};
  const fl = isPlainObject(rt.flash) ? rt.flash : {};
  if (family === 'esp32') {
    if (!fl.port) missing.push('烧录串口未填（runtime.flash.port，如 COM7）');
    if (fl.method && ['usb-serial-jtag', 'uart', 'jtag'].indexOf(String(fl.method)) < 0) {
      warnings.push('runtime.flash.method "' + fl.method + '" 不常见（usb-serial-jtag / uart / jtag）');
    }
  }
  if (family === 'stm32') {
    if (!fl.method) missing.push('烧录方式未填（runtime.flash.method，通常是 swd）');
    if (!fl.probe) missing.push('调试器未填（runtime.flash.probe，如 st-link）');
  }
  /* 串口故意不校验：不是每个工程都接串口，缺了不该变成噪音。
     要看串口输出时模型自己会问，或 read 卡的 runtime.serial 段。 */

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    missing,
    counts: { pins: pinMap.length, reserved: reserved.length, peripherals: per.length },
  };
}

/* ───────────────────────── 从各种来源生成草案 ───────────────────────── */

/**
 * 目录里认工具链：只看**证据文件**，认不出就报错（不猜）。
 * @returns {{backend:string, family:string, evidence:string[], projectFile?:string}}
 */
function detect(dir) {
  const has = (rel) => fs.existsSync(path.join(dir, rel));
  const evidence = [];

  let uv = null;
  try { uv = fs.readdirSync(dir).filter((f) => /\.uvprojx$/i.test(f))[0] || null; } catch (_) { /* 目录读不了下面会报 */ }

  if (uv) {
    evidence.push(uv);
    if (has('CMakeLists.txt')) evidence.push('CMakeLists.txt');
    return { backend: 'keil-ac5', family: 'stm32', evidence, projectFile: uv };
  }

  const idfSignals = ['sdkconfig', 'sdkconfig.defaults', 'sdkconfig.ci', 'idf_component.yml', 'flasher_args.json'];
  const idfHit = idfSignals.filter(has);
  const hasMain = has('main/CMakeLists.txt') || has('main/main.c');
  if (has('CMakeLists.txt') && (idfHit.length || hasMain)) {
    evidence.push('CMakeLists.txt');
    idfHit.forEach((f) => evidence.push(f));
    if (hasMain) evidence.push('main/');
    return { backend: 'esp-idf', family: 'esp32', evidence };
  }

  if (has('platformio.ini')) {
    evidence.push('platformio.ini');
    let family = 'other';
    try {
      const ini = fs.readFileSync(path.join(dir, 'platformio.ini'), 'utf8');
      const m = /platform\s*=\s*([^\r\n#]+)/i.exec(ini);
      if (m) {
        const plat = m[1].trim();
        evidence.push('platform=' + plat);
        const low = plat.toLowerCase();
        if (/esp32|espressif/.test(low)) family = 'esp32';
        else if (/ststm32|stm32/.test(low)) family = 'stm32';
        else if (/raspberrypi|rp2040/.test(low)) family = 'rp2040';
        else if (/atmel|avr/.test(low)) family = 'avr';
      }
    } catch (_) { /* 读不了就按 other */ }
    return { backend: 'platformio', family, evidence };
  }

  if (has('CMakeLists.txt')) {
    evidence.push('CMakeLists.txt');
    return { backend: 'cmake', family: 'other', evidence };
  }

  const e = new Error('认不出这个目录的工具链：没找到 .uvprojx / ESP-IDF 的 CMakeLists.txt+sdkconfig / platformio.ini。' +
    '　可以在目录里用 op=write 手写一份工程卡（content 至少要 schema+target.family+toolchain.backend）。');
  e.code = 'NO_BACKEND'; throw e;
}

/** 按后端给默认烧录方式（是「这套工具链的常规做法」，不是对板子的断言） */
function defaultFlash(backend, family) {
  if (backend === 'esp-idf' || (backend === 'platformio' && family === 'esp32')) {
    return { method: 'usb-serial-jtag', port: null, baud: 921600 };
  }
  if (backend === 'platformio') return { method: null, port: null, baud: null };
  if (backend === 'keil-ac5' || family === 'stm32') return { method: 'swd', probe: 'st-link', target: null };
  return { method: null, port: null, baud: null };
}

/** 新建骨架（op=init）：只写工具链层面能确定的事 */
function initDraft(dir, det) {
  const name = path.basename(dir);
  return {
    schema: SCHEMA_VERSION,
    id: slug(name),
    name,
    origin: 'init:' + det.backend,
    target: { family: det.family, chip: null },
    toolchain: det.projectFile
      ? { backend: det.backend, projectFile: det.projectFile }
      : { backend: det.backend },
    runtime: {
      flash: defaultFlash(det.backend, det.family),
      serial: { port: null, baud: 115200 },
    },
    pins: { map: [], reserved: [] },
    peripherals: [],
    contract: { features: '.dsh-mcu/features.json' },
  };
}

/**
 * 从 .uvprojx 生成草案（op=import）。
 * **只填工程文件里真有的字段**：器件、内存布局、编译目标、源文件分布。
 * 引脚、串口、烧录端口一律留空 —— 那些 .uvprojx 里没有，猜就是编。
 */
function importDraft(uvprojxMod, uvprojxFile) {
  const model = uvprojxMod.parseUvprojx(uvprojxFile);
  const family = familyOfDevice(model.device);

  /* 源文件目录分布：只取编译进来的 C/汇编，按相对目录归并（不编 glob，避免把没参与编译的也算上） */
  const dirs = [];
  (model.sources || []).forEach((s) => {
    const rel = path.dirname(String(s.raw || '').replace(/[\\/]/g, '/'));
    const d = rel === '.' || rel === '' ? '(根目录)' : rel.replace(/^\.\//, '');
    if (dirs.indexOf(d) < 0) dirs.push(d);
  });
  const entry = (model.sources || []).find((s) => /(^|[\\/])main\.c$/i.test(String(s.raw || '')));
  const target = ocdTargetOf(model.device);

  const card = {
    schema: SCHEMA_VERSION,
    id: slug(model.projectName),
    name: model.name,
    origin: 'import:' + path.basename(uvprojxFile),
  };
  card.target = {
    family,
    chip: model.device || null,
    vendor: model.vendor || null,
    core: model.cpu.core || null,
    clockHz: model.cpu.clockHz || null,
    flashKB: model.cpu.irom ? Math.round(model.cpu.irom.size / 1024) : null,
    ramKB: model.cpu.iram ? Math.round(model.cpu.iram.size / 1024) : null,
  };
  card.toolchain = {
    backend: 'keil-ac5',
    projectFile: path.basename(uvprojxFile),
    compiler: model.useAC6 ? 'AC6' : 'AC5',
  };
  card.runtime = {
    flash: { method: 'swd', probe: 'st-link', target: target || null },
    debug: target ? { backend: 'openocd', interface: 'interface/stlink.cfg', target } : { backend: 'openocd' },
    serial: { port: null, baud: 115200 },
  };
  card.pins = {
    map: [],
    reserved: family === 'stm32'
      ? [{ pin: 'PA13', reason: 'SWDIO（调试口）' }, { pin: 'PA14', reason: 'SWCLK（调试口）' }]
      : [],
  };
  card.peripherals = [];
  card.files = {
    entry: entry ? String(entry.raw).replace(/[\\/]/g, '/').replace(/^\.\//, '') : null,
    count: (model.sources || []).length,
    dirs: dirs.slice(0, 20),
  };
  card.contract = { features: DATA_DIR + '/features.json' };
  if (model.orphanSources && model.orphanSources.length) {
    card.files.orphans = model.orphanSources.slice(0, 10);
  }
  return card;
}

/* ───────────────────────── 文字渲染（工具唯一可见部分）───────────────────────── */

function pad2(n) { return String(n).padStart(2, '0'); }

function fmtTime(ms) {
  if (!ms) return '?';
  const d = new Date(ms);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
    pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

function fmtMHz(hz) {
  if (!hz || !Number.isFinite(Number(hz))) return null;
  return (Math.round(Number(hz) / 1e5) / 10) + ' MHz';
}

function fmtKB(kb) { return kb ? kb + ' KB' : null; }

/** 一行摘要，给 status / 面板用 */
function summaryLine(card) {
  if (!isPlainObject(card)) return '';
  const t = isPlainObject(card.target) ? card.target : {};
  const tool = isPlainObject(card.toolchain) ? card.toolchain : {};
  const rt = isPlainObject(card.runtime) ? card.runtime : {};
  const fl = isPlainObject(rt.flash) ? rt.flash : {};
  const bits = [];
  if (t.family) bits.push(String(t.family));
  if (t.chip) bits.push(String(t.chip));
  if (tool.backend) bits.push(String(tool.backend));
  const pins = card.pins && Array.isArray(card.pins.map) ? card.pins.map.length : 0;
  bits.push('引脚 ' + pins);
  if (fl.port) bits.push(String(fl.port));
  return bits.join(' · ');
}

/**
 * 把工程卡渲染成人/模型都能读的正文。
 * 工具那边只把这段正文给模型看（省掉整份 JSON 再抄一遍），要看原始 JSON 用 full:true
 * 或直接 `mcu read path=.dsh-mcu/project.json`。
 */
function toText(p) {
  if (p.dryRun && p.card) {
    return '（草案，还没写入；确认后 op=import / op=init 落盘，或 op=write 手写）\n' + renderCard(p);
  }
  if (!p.has) {
    return [
      '还没有工程卡：' + p.path,
      '生成方式：op=import（Keil 工程，从 .uvprojx 抽芯片/文件/工具链）或 op=init（目录里已有 ESP-IDF/PlatformIO 工程时自动识别）。',
      '导入只填工程文件里真有的字段；引脚表与烧录串口需要补（本工具不猜）。',
    ].join('\n');
  }
  if (p.broken) {
    return [
      '工程卡 JSON 解析失败：' + p.error,
      p.path,
      '修好后再读；或删掉该文件重新 import。',
      '',
      String(p.rawPreview || '').slice(0, 400),
    ].join('\n');
  }
  return renderCard(p);
}

/** 卡片正文（「有没有卡 / 卡坏没坏」由 toText 判断，这里只管内容） */
function renderCard(p) {
  const c = p.card || {};
  const target = isPlainObject(c.target) ? c.target : {};
  const tool = isPlainObject(c.toolchain) ? c.toolchain : {};
  const rt = isPlainObject(c.runtime) ? c.runtime : {};
  const fl = isPlainObject(rt.flash) ? rt.flash : {};
  const dbg = isPlainObject(rt.debug) ? rt.debug : {};
  const se = isPlainObject(rt.serial) ? rt.serial : {};
  const v = p.validation || { errors: [], warnings: [], missing: [], counts: {} };
  const lines = [];

  lines.push('工程卡 ' + p.path + '（' + fmtTime(p.mtime) + ' 修改，' + (p.bytes || 0) + ' 字节' +
    (c.origin ? '，来源 ' + c.origin : '') + '）');

  const chipBits = [];
  if (target.chip) chipBits.push(String(target.chip));
  if (target.vendor) chipBits.push(String(target.vendor));
  if (target.core) chipBits.push(String(target.core));
  const clk = fmtMHz(target.clockHz); if (clk) chipBits.push(clk);
  const flKB = fmtKB(target.flashKB); if (flKB) chipBits.push('Flash ' + flKB);
  const ramKB = fmtKB(target.ramKB); if (ramKB) chipBits.push('RAM ' + ramKB);
  const psKB = fmtKB(target.psramKB); if (psKB) chipBits.push('PSRAM ' + psKB);
  lines.push('芯片  ' + (target.family ? String(target.family) : '?') +
    (chipBits.length ? ' · ' + chipBits.join(' · ') : ' ·（型号未填）'));

  lines.push('工具链  ' + (tool.backend ? String(tool.backend) : '?') +
    (tool.projectFile ? ' · ' + tool.projectFile : '') +
    (tool.compiler ? ' · ' + tool.compiler : ''));

  const flashBits = [];
  if (fl.method) flashBits.push(String(fl.method));
  if (fl.probe) flashBits.push(String(fl.probe));
  if (fl.target) flashBits.push(String(fl.target));
  if (fl.command) flashBits.push('命令 ' + fl.command);
  lines.push('烧录  ' + (flashBits.length ? flashBits.join(' · ') : '（未填）') +
    (fl.port ? ' · 端口 ' + fl.port : '') + (fl.baud ? ' · ' + fl.baud + ' baud' : ''));

  if (dbg.backend || dbg.interface || dbg.target) {
    const dbgBits = [dbg.backend || 'debug', dbg.interface || '', dbg.target || ''].filter(Boolean);
    lines.push('调试  ' + dbgBits.join(' · '));
  }
  if (se.port) lines.push('串口  ' + se.port + (se.baud ? ' @ ' + se.baud : '') + (se.command ? ' · ' + se.command : ''));
  else if (se.command) lines.push('串口  命令 ' + se.command);

  const map = c.pins && Array.isArray(c.pins.map) ? c.pins.map : [];
  const reserved = c.pins && Array.isArray(c.pins.reserved) ? c.pins.reserved : [];
  lines.push('引脚  ' + map.length + ' 个' + (reserved.length ? '（保留 ' + reserved.length + '：' +
    reserved.map((r) => normalizePin(isPlainObject(r) ? (r.pin != null ? r.pin : r.gpio) : r, target.family)).join(' ') + '）' : ''));
  map.slice(0, 30).forEach((entry) => {
    const o = isPlainObject(entry) ? entry : { pin: entry };
    const pin = normalizePin(o.pin != null ? o.pin : o.gpio, target.family);
    const bits = [pin];
    if (o.signal) bits.push(String(o.signal));
    if (o.mode) bits.push(String(o.mode));
    if (o.peripheral) bits.push(String(o.peripheral));
    if (o.note) bits.push(String(o.note));
    lines.push('  ' + bits.join('  '));
  });
  if (map.length > 30) lines.push('  …还有 ' + (map.length - 30) + ' 个（full:true 看原始 JSON）');

  const per = c.peripherals && Array.isArray(c.peripherals) ? c.peripherals : [];
  per.slice(0, 10).forEach((x) => {
    if (!isPlainObject(x)) { lines.push('外设  ' + String(x)); return; }
    const head = [x.type || '?', x.name || ''].filter(Boolean).join(' ');
    const rest = Object.keys(x)
      .filter((k) => k !== 'type' && k !== 'name' && k !== 'note')
      .map((k) => k + '=' + String(x[k])).join(' ');
    lines.push('外设  ' + head + (rest ? ' · ' + rest : '') + (x.note ? ' · ' + x.note : ''));
  });
  if (per.length > 10) lines.push('外设  …还有 ' + (per.length - 10) + ' 个');

  const files = isPlainObject(c.files) ? c.files : {};
  if (files.entry || files.count || (files.dirs && files.dirs.length)) {
    const fb = [];
    if (files.entry) fb.push('入口 ' + files.entry);
    if (files.count) fb.push(files.count + ' 个源文件');
    if (files.dirs && files.dirs.length) fb.push('目录 ' + files.dirs.slice(0, 8).join(' / '));
    lines.push('代码  ' + fb.join(' · '));
  }

  if (v.missing && v.missing.length) {
    lines.push('待补  ' + v.missing.slice(0, 6).join('；') + (v.missing.length > 6 ? ' …' : ''));
  }
  if (v.errors && v.errors.length) {
    v.errors.slice(0, 6).forEach((e) => lines.push('⛔ ' + e));
    if (v.errors.length > 6) lines.push('⛔ …还有 ' + (v.errors.length - 6) + ' 处');
  }
  if (v.warnings && v.warnings.length) {
    v.warnings.slice(0, 5).forEach((w) => lines.push('⚠ ' + w));
    if (v.warnings.length > 5) lines.push('⚠ …还有 ' + (v.warnings.length - 5) + ' 条');
  }
  if (!p.dryRun) {
    lines.push('改卡：op=write + content 只写要改的部分（深合并，数组整体替换，null 删除字段）。');
  }
  return lines.join('\n');
}

/* ───────────────────────── 读写 ───────────────────────── */

function statOf(file) {
  try {
    const st = fs.statSync(file);
    return { mtime: st.mtimeMs, bytes: st.size };
  } catch (_) { return { mtime: null, bytes: null }; }
}

/** 组装给上层的统一载荷（read/write/import/init/validate 都返回这个形状） */
function payloadOf(t, extra) {
  const st = statOf(t.cardFile);
  const p = Object.assign({
    ok: true,
    has: false,
    broken: false,
    error: null,
    path: t.cardFile,
    dir: t.dir,
    card: null,
    mtime: st.mtime,
    bytes: st.bytes,
    validation: { ok: true, errors: [], warnings: [], missing: [], counts: { pins: 0, reserved: 0, peripherals: 0 } },
    summary: null,
  }, extra || {});
  p.text = toText(p);
  return p;
}

/** 读工程卡（不抛「没卡」异常：has=false 是正常状态） */
function read(input) {
  const t = resolve(input);
  let raw;
  try {
    raw = fs.readFileSync(t.cardFile, 'utf8');
  } catch (_) {
    return payloadOf(t);
  }
  let card = null;
  let broken = false;
  let error = null;
  try {
    card = JSON.parse(raw);
  } catch (err) {
    broken = true;
    error = String(err.message || err);
  }
  const validation = broken
    ? { ok: false, errors: ['JSON 解析失败：' + error], warnings: [], missing: [], counts: { pins: 0, reserved: 0, peripherals: 0 } }
    : validate(card, { dir: t.dir });
  if (broken) {
    return payloadOf(t, { has: true, broken: true, error, card: null, validation, rawPreview: raw.slice(0, 400) });
  }
  return payloadOf(t, { has: true, card, validation, summary: summaryLine(card) });
}

/** 写卡（内部用）：落盘前备份上一版；返回是否真的有变化 */
function persist(t, card) {
  fs.mkdirSync(path.dirname(t.cardFile), { recursive: true });
  let prev = null;
  try { prev = fs.readFileSync(t.cardFile, 'utf8'); } catch (_) { /* 首次写 */ }
  let backup = null;
  if (prev != null) {
    backup = t.cardFile + '.bak';
    try { fs.writeFileSync(backup, prev, 'utf8'); } catch (_) { backup = null; }
  }
  const body = JSON.stringify(card, null, 2) + '\n';
  const changed = prev !== body;
  if (changed) fs.writeFileSync(t.cardFile, body, 'utf8');
  return { changed, backup };
}

/** op=write：深合并补丁并落盘（模型日常只发改动字段） */
function writeContent(input, rawContent) {
  const t = resolve(input);
  const parsed = typeof rawContent === 'string' ? parseJsonLoose(rawContent) : rawContent;
  if (!isPlainObject(parsed)) {
    const e = new Error('content 必须是 JSON 对象（不能是数组/标量）');
    e.code = 'BAD_JSON'; throw e;
  }
  let current = null;
  try {
    const prev = JSON.parse(fs.readFileSync(t.cardFile, 'utf8'));
    current = isPlainObject(prev) ? prev : null;
  } catch (_) { /* 没有或损坏：按新建处理（损坏时先备份） */ }

  const merged = deepMerge(current ? current : { schema: SCHEMA_VERSION }, parsed);
  if (merged.schema == null) merged.schema = SCHEMA_VERSION;
  const validation = validate(merged, { dir: t.dir });
  const { changed, backup } = persist(t, merged);
  return payloadOf(t, {
    has: true, card: merged, validation, changed, backup,
    summary: summaryLine(merged),
  });
}

/** 生成草案并写入（import / init 共用）。已有卡时拒绝覆盖，避免冲掉手写引脚表 */
function createFrom(t, card, extra) {
  if (fs.existsSync(t.cardFile)) {
    const e = new Error('已经有工程卡了：' + t.cardFile +
      '　导入/初始化不会覆盖（避免冲掉手写的引脚表）。要改请 op=write 增量写；确实要重来先删掉该文件。');
    e.code = 'EXISTS'; throw e;
  }
  const validation = validate(card, { dir: t.dir });
  const { changed, backup } = persist(t, card);
  return payloadOf(t, Object.assign({
    has: true, card, validation, changed, backup, summary: summaryLine(card),
  }, extra || {}));
}

/** op=import：从 .uvprojx 生成 */
function importCard(input) {
  const t = resolve(input);
  let uv = t.uvprojx;
  if (!uv) {
    const hits = findUvprojx(t.dir);
    if (!hits.length) {
      const e = new Error('这个目录（含三层子目录）里没有 .uvprojx：' + t.dir +
        '　非 Keil 工程请用 op=init（自动认 ESP-IDF/PlatformIO）。');
      e.code = 'NO_PROJECT'; throw e;
    }
    uv = hits[0];
  }
  // 延迟 require：uvprojx.js 只在这个分支用得上
  const uvprojxMod = require('./uvprojx');
  const card = importDraft(uvprojxMod, uv);
  return createFrom(t, card, {
    detected: { backend: 'keil-ac5', family: card.target.family, evidence: [path.basename(uv)] },
  });
}

/** op=init：按目录里的证据文件识别工具链并生成骨架 */
function initCard(input) {
  const t = resolve(input);
  const det = detect(t.dir);
  const card = initDraft(t.dir, det);
  return createFrom(t, card, { detected: det });
}

/** op=validate：只读不写。路径是 .uvprojx 且还没卡时，先给出「import 会生成什么」的草案 */
function validateOnly(input) {
  const t = resolve(input);
  if (!fs.existsSync(t.cardFile)) {
    let uv = t.uvprojx;
    if (!uv) {
      const hits = findUvprojx(t.dir);
      if (hits.length) uv = hits[0];
    }
    if (uv) {
      const uvprojxMod = require('./uvprojx');
      const card = importDraft(uvprojxMod, uv);
      const validation = validate(card, { dir: t.dir });
      return payloadOf(t, {
        has: false, dryRun: true, card, validation, summary: summaryLine(card),
        detected: { backend: 'keil-ac5', family: card.target.family, evidence: [path.basename(uv)] },
      });
    }
    const det = detect(t.dir);
    const card = initDraft(t.dir, det);
    const validation = validate(card, { dir: t.dir });
    return payloadOf(t, { has: false, dryRun: true, card, validation, summary: summaryLine(card), detected: det });
  }
  const r = read(t.cardFile);
  r.dryRun = false;
  return r;
}

module.exports = {
  CARD_NAME, DATA_DIR, SCHEMA_VERSION, FAMILIES, BACKENDS,
  cardFileOf, resolve, findUvprojx, normalizePin,
  validate, detect, importDraft, initDraft,
  read, writeContent, importCard, initCard, validateOnly,
  summaryLine, toText, deepMerge, parseJsonLoose,
};
