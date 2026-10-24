'use strict';
/**
 * server.js —— 本地工作台后端（零依赖，只用 node:http）
 *
 * 职责：工具链探测 / 工程管理 / 构建（流式日志）/ 烧录 / 串口 / 静态界面。
 * 只监听 127.0.0.1，不做鉴权也不暴露到局域网 —— 这是一个本机开发工具。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const toolchain = require('./toolchain');
const buildMod = require('./build');
const ocd = require('./openocd');
const serial = require('./serial');
const uvprojxMod = require('./uvprojx');
const keilMod = require('./keil-build');
const pinmapMod = require('./pinmap');
const regreadMod = require('./regread');
const srcfileMod = require('./srcfile');
const featuresMod = require('./features');
const symbolsMod = require('./symbols');
const gfxMod = require('./gfx');
const projectcardMod = require('./projectcard');
const paths = require('./paths');

/** 当前打开的 Keil 工程（持久化，重启后界面能自动恢复） */
let currentKeil = null;
/** 最近一次 Keil 构建产物 —— 「烧录」按钮直接烧它。**只对当前工程有效** */
let lastKeilBuild = null;

/* 「上次打开哪个工程」是跨工程的记忆 → 全局一份。
   而构建账本能落盘成**每个工程一份**（见下），否则切换工程后会拿旧工程的
   programSize/map 冒充新工程的占用数据 —— 界面上还挂着新工程的名字。 */
const RECENT_FILE = paths.recentFile();

/** 当前工程的账本文件；没有打开的工程时返回 null */
function ledgerOf(projectDir) {
  return projectDir ? paths.ledgerFile(projectDir) : null;
}

/** 构建账本落盘：否则重启后端后，Flash 占用页又要等一次构建才有数据 */
function saveLastBuild(b) {
  const file = ledgerOf(currentKeil && currentKeil.model && currentKeil.model.dir);
  if (!file) return;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(b), 'utf8');
  } catch (_) { /* 存不下不影响使用 */ }
}

/** 只读**当前工程**的账本 */
function loadLastBuild() {
  const file = ledgerOf(currentKeil && currentKeil.model && currentKeil.model.dir);
  if (!file) return null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    // 产物已经被删掉的话，账本也没意义了
    if (j && j.artifact && j.artifact.hex && fs.existsSync(j.artifact.hex)) return j;
  } catch (_) { /* 这个工程还没构建过 */ }
  return null;
}

function saveRecent(file) {
  try {
    fs.mkdirSync(path.dirname(RECENT_FILE), { recursive: true });
    fs.writeFileSync(RECENT_FILE, JSON.stringify({ file, openedAt: Date.now() }, null, 2), 'utf8');
  } catch (_) { /* 记不住不影响使用 */ }
}

function loadRecent() {
  try {
    const j = JSON.parse(fs.readFileSync(RECENT_FILE, 'utf8'));
    if (j && j.file && fs.existsSync(j.file)) {
      return { file: j.file, model: uvprojxMod.parseUvprojx(j.file), openedAt: j.openedAt || Date.now() };
    }
  } catch (_) { /* 工程被删或改了，忽略 */ }
  return null;
}

/**
 * 读类接口统一懒加载「上次打开的工程」。
 *
 * 以前只有 state/size 这么做，pins/symbols 会回 409「先调 open」——
 * 模型于是要多花一轮 open 才能读一个符号，纯属空转 token。
 * 读操作按最近工程走是安全的（写操作仍然走各自的显式检查）。
 */
function ensureKeil() {
  if (!currentKeil) currentKeil = loadRecent();
  return currentKeil;
}

const SKIP_DIRS = new Set(['Objects', 'Listings', 'DebugConfig', 'node_modules', '.git',
  'build', 'Output', 'RTE', 'DebugConfig', 'Backup', '.vs']);

/** 递归找 .uvprojx（限深度，别把整个硬盘扫了） */
function findUvprojx(dir, maxDepth = 3, depth = 0, out = []) {
  if (depth > maxDepth || out.length >= 30) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    if (out.length >= 30) break;
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) {
        findUvprojx(path.join(dir, e.name), maxDepth, depth + 1, out);
      }
    } else if (/\.uvprojx$/i.test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

/**
 * 把「目录或 .uvprojx」统一解析成工程文件路径。
 * 注意要先把引号剥掉：Windows 资源管理器「复制文件地址」给的是 "C:\...\Project.uvprojx"，
 * 带引号的字符串不是合法绝对路径，path.resolve 会把它拼到当前工作目录后面。
 */
function resolveKeilPath(input) {
  let s = String(input == null ? '' : input).trim();
  s = s.replace(/^["'\u201c\u201d\u2018\u2019]+/, '').replace(/["'\u201c\u201d\u2018\u2019]+$/, '').trim();
  if (!s) { const e = new Error('路径为空'); e.code = 'NO_PATH'; throw e; }
  const p = path.resolve(s);
  if (!fs.existsSync(p)) {
    const e = new Error('路径不存在：' + p + '　（可以填 .uvprojx 文件，也可以填它所在的目录）');
    e.code = 'NO_PATH'; throw e;
  }
  if (fs.statSync(p).isDirectory()) {
    const hits = findUvprojx(p);
    if (!hits.length) {
      const e = new Error('这个目录（含三层子目录）里没有找到 .uvprojx：' + p);
      e.code = 'NO_PROJECT'; throw e;
    }
    return { file: hits[0], candidates: hits };
  }
  return { file: p, candidates: [p] };
}

/* ───────── 源码路径守卫 ─────────
 * 只允许读写「当前打开的 Keil 工程目录」里的文件。
 * 这不是洁癖：调用方可能是模型，路径写错一个字符就会去改别的工程乃至系统文件。
 */

/** 当前工程目录（越界判断的基准） */
function sourceRoot() {
  const cur = currentKeil || loadRecent();
  if (!cur) { const e = new Error('还没有打开 Keil 工程，无法定位源码目录'); e.code = 'NO_PROJECT'; throw e; }
  return cur.model.dir;
}

/**
 * 把调用方给的路径解析成工程目录内的绝对路径。
 * 支持工程文件里的相对路径原文（`.\Hardware\OLED.c`）、相对工程目录的路径、以及工程内的绝对路径。
 * @throws {Error & {code:string}} 越界抛 code='OUTSIDE'；空路径抛 code='NO_PATH'
 */
function resolveSourcePath(input) {
  let s = String(input == null ? '' : input).trim();
  s = s.replace(/^["'\u201c\u201d\u2018\u2019]+/, '').replace(/["'\u201c\u201d\u2018\u2019]+$/, '').trim();
  if (!s) { const e = new Error('路径为空'); e.code = 'NO_PATH'; throw e; }
  const root = sourceRoot();
  const abs = path.resolve(root, s);
  // 用 relative 判断包含关系：比 startsWith 安全，能挡住 ..\..\ 这类穿越
  const rel = path.relative(root, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    const e = new Error('拒绝访问工程目录之外的路径：' + abs + '（当前工程目录：' + root + '）');
    e.code = 'OUTSIDE'; throw e;
  }
  return abs;
}

/** 工程摘要：给界面用的稳定结构 */
function keilSummary(model) {
  return {
    file: model.file,
    dir: model.dir,
    name: model.name,
    projectName: model.projectName,
    target: model.targetName,
    device: model.device,
    vendor: model.vendor,
    packId: model.packId,
    summary: uvprojxMod.summarise(model),
    core: model.cpu ? model.cpu.core : null,
    clockHz: model.cpu ? model.cpu.clockHz : null,
    flashKB: model.cpu && model.cpu.irom ? model.cpu.irom.size / 1024 : null,
    ramKB: model.cpu && model.cpu.iram ? model.cpu.iram.size / 1024 : null,
    useAC6: model.useAC6,
    optim: model.optim,
    optimFlag: model.optimFlag,
    defines: model.defines,
    autoDefines: model.autoDefines,
    includes: model.includes.map((i) => ({ raw: i.raw, exists: fs.existsSync(i.abs) })),
    groups: model.groups.map((g) => ({ name: g.name, files: g.files.length })),
    sourceCount: model.sourceCount,
    sources: model.sources.map((s) => ({ raw: s.raw, kind: s.kind, group: s.group })),
    scatterFile: model.scatterFile,
    outputName: model.outputName,
    outputDirectory: model.outputDirectory,
    createHex: model.createHex,
    hse: regreadMod.findHseValue(model),
  };
}

const ROOT = toolchain.ROOT;
const WEB_DIR = path.join(ROOT, 'web');
const DATA_DIR = path.join(ROOT, 'data');
const PORT = parseInt(process.env.MCU_AGENT_PORT || '8788', 10);
const STARTED_AT = Date.now();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

/** NDJSON 流：给构建/烧录这类长任务用，界面能逐行实时看到 */
function ndjson(res) {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Accel-Buffering': 'no',
    'Connection': 'keep-alive',
  });
  if (res.socket) res.socket.setNoDelay(true);
  return {
    send(obj) { if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n'); },
    end(obj) { if (obj) this.send(obj); if (!res.writableEnded) res.end(); },
  };
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  // 防目录穿越：解析后必须仍在 web/ 内
  const target = path.resolve(WEB_DIR, '.' + rel);
  if (!target.startsWith(WEB_DIR)) { sendJson(res, 403, { error: '非法路径' }); return; }
  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      // 单页应用兜底：未知路径回 index.html，但 api 路径不兜底
      if (!rel.startsWith('/api/')) {
        const idx = path.join(WEB_DIR, 'index.html');
        if (fs.existsSync(idx)) {
          const body = fs.readFileSync(idx);
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': body.length, 'Cache-Control': 'no-store' });
          res.end(body);
          return;
        }
      }
      sendJson(res, 404, { error: '找不到：' + rel });
      return;
    }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
    });
    fs.createReadStream(target).pipe(res);
  });
}

function readJsonFile(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

const TEMPLATES = [
  {
    id: 'blink-uart',
    name: 'LED 闪烁 + 串口问候（寄存器级）',
    description: 'PC13 板载 LED 闪烁，USART1 115200 打印启动信息并回显收到的字符。不依赖标准外设库，只用 CMSIS 设备头。',
    provides: ['GPIO 输出', 'USART1 收发', '忙等延时', '中断向量表'],
  },
];

async function handleApi(req, res, url) {
  const p = url.pathname;

  /* 廉价健康检查：只回已经内存里的东西，不碰磁盘、不起子进程。
     宿主插件用它判断「后端是否就绪」—— 不能再用 /api/env：那边要枚举串口
     （Windows 上起一个 powershell.exe，实测 2 s 左右），当健康检查用会被
     误判成「后端启动超时」（2026-10-18 实测踩到，DSH 0.2.1 下必现）。 */
  if (p === '/api/ping' && req.method === 'GET') {
    sendJson(res, 200, {
      ok: true,
      name: 'stm32-workbench-backend',
      pid: process.pid,
      cwd: ROOT,
      port: server.address() && typeof server.address() === 'object' ? server.address().port : PORT,
      startedAt: STARTED_AT,
      uptimeMs: Date.now() - STARTED_AT,
    });
    return;
  }
  if (p === '/api/env' && req.method === 'GET') {
    // detectEnv 默认走 5 s 缓存；?fresh=1 强制重新探测（界面上的「重新检测」按钮用）
    sendJson(res, 200, toolchain.detectEnv({ fresh: url.searchParams.get('fresh') === '1' }));
    return;
  }
  if (p === '/api/detect' && req.method === 'POST') {
    sendJson(res, 200, toolchain.detectEnv({ fresh: true }));
    return;
  }
  /* ───────── Keil 工程接入：读工程 / 引脚配置 / 寄存器 / 按工程编译 ───────── */

  if (p === '/api/keil/open' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const picked = resolveKeilPath(body.path);
      const model = uvprojxMod.parseUvprojx(picked.file);
      currentKeil = { file: picked.file, model, openedAt: Date.now() };
      /* 换工程必须把内存里的账本清掉。
         不清的话，「烧录」会烧上一个工程的产物，「Flash 占用」会把上一个工程的
         programSize/map 挂在当前工程名下显示 —— 一个看不出破绽的错数字。 */
      lastKeilBuild = null;
      saveRecent(picked.file);
      sendJson(res, 200, {
        ok: true,
        project: keilSummary(model),
        diagnostics: model.diagnostics,
        // 选目录时可能找到多个工程，界面可以拿来给用户换
        candidates: picked.candidates.map((f) => {
          let label = path.basename(path.dirname(f));
          try { const m2 = uvprojxMod.parseUvprojx(f); label = m2.name + ' · ' + m2.device; } catch (_) { /* 解析不了就只用目录名 */ }
          return { file: f, label };
        }),
      });
    } catch (err) {
      sendJson(res, err.code === 'NO_PATH' || err.code === 'NO_PROJECT' ? 400 : 500,
        { ok: false, error: String(err.message || err) });
    }
    return;
  }

  if (p === '/api/keil/scan' && req.method === 'POST') {
    let body = {};
    try { body = await readBody(req); } catch (_) { /* 允许空 */ }
    try {
      const raw = String(body.dir || '').trim()
        .replace(/^["'\u201c\u201d]+/, '').replace(/["'\u201c\u201d]+$/, '').trim();
      if (!raw) { sendJson(res, 400, { ok: false, error: '缺少目录 dir' }); return; }
      const base = path.resolve(raw);
      if (!fs.existsSync(base)) { sendJson(res, 400, { ok: false, error: '目录不存在：' + base }); return; }
      const hits = fs.statSync(base).isDirectory() ? findUvprojx(base) : [base];
      sendJson(res, 200, {
        ok: true, dir: base,
        projects: hits.map((f) => {
          let label = path.basename(path.dirname(f));
          let device = '';
          try { const m2 = uvprojxMod.parseUvprojx(f); label = m2.name; device = m2.device; } catch (_) { /* 忽略 */ }
          return { file: f, dir: path.dirname(f), label, device };
        }),
      });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err.message || err) });
    }
    return;
  }

  if (p === '/api/keil/state' && req.method === 'GET') {
    ensureKeil(); // 懒加载：重启后端后自动恢复上次的工程
    if (!currentKeil) { sendJson(res, 200, { ok: true, open: false }); return; }
    sendJson(res, 200, { ok: true, open: true, project: keilSummary(currentKeil.model), openedAt: currentKeil.openedAt });
    return;
  }

  if (p === '/api/keil/pins' && req.method === 'GET') {
    if (!ensureKeil()) { sendJson(res, 409, { ok: false, error: '还没有打开 Keil 工程（先调 /api/keil/open）' }); return; }
    try {
      /* 工程卡里写了引脚表就以卡为准：那是用户/AI 明确声明的「物理真相」，
         比从 SPL 结构体反推出来的更可信（反推是为了「没卡的历史工程」保底）。
         卡里没有引脚表时才扫源码 —— 结论会标明 fromCard，避免两边混淆。 */
      const cardRead = projectcardMod.read(currentKeil.model.dir);
      const family = (cardRead.card && cardRead.card.target && cardRead.card.target.family) || 'stm32';
      const cardPins = cardRead.has && !cardRead.broken && cardRead.card && cardRead.card.pins &&
        Array.isArray(cardRead.card.pins.map) ? cardRead.card.pins.map : [];
      if (cardPins.length) {
        sendJson(res, 200, {
          ok: true, project: currentKeil.model.name, fromCard: true,
          cardPath: cardRead.path, cardMtime: cardRead.mtime,
          pins: cardPins.map((entry) => {
            const o = entry && typeof entry === 'object' ? entry : { pin: entry };
            return {
              pin: projectcardMod.normalizePin(o.pin != null ? o.pin : o.gpio, family),
              signal: o.signal || null, mode: o.mode || null,
              peripheral: o.peripheral || null, note: o.note || null,
            };
          }),
          /* 卡里的自相矛盾（引脚冲突等）直接当冲突带出去，别让模型以为卡=正确 */
          conflicts: (cardRead.validation.errors || []).map((reason) => ({ severity: 'danger', reason })),
          reconfigs: [],
          orderSource: 'project.json（工程卡，权威）',
          clock: null,
        });
        return;
      }
      const pinmap = pinmapMod.scanProjectPins(currentKeil.model);
      sendJson(res, 200, Object.assign({ ok: true, project: currentKeil.model.name, fromCard: false }, pinmap));
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err.message || err) });
    }
    return;
  }

  /* ───────── 工程卡（<工程>/.dsh-mcu/project.json）─────────
   * 工程事实（芯片 / 工具链 / 烧录端口 / 引脚表 / 外设）的单一来源。
   * 逻辑全在 server/projectcard.js，这里只做 HTTP 薄壳（面板与 mcu 工具同一条路径）。
   * 注意：**不要求已打开 Keil 工程** —— 给 path 就能读写；ESP-IDF 工程没有 .uvprojx，
   * 靠这条接口先描述出来，后端适配器以后按卡执行 build/flash。 */
  function projectInput(body) {
    if (body && body.path) return body.path;
    const cur = currentKeil || loadRecent();
    if (!cur) {
      const e = new Error('还没有打开工程，也没有给 path。给 path=工程目录（或 .uvprojx），或先 open');
      e.code = 'NO_PROJECT'; throw e;
    }
    return cur.model.dir;
  }

  function sendProjectError(res, err) {
    const code = err.code || null;
    const status = code === 'NO_PROJECT' ? 409
      : (code === 'NO_PATH' || code === 'BAD_PATH') ? 404
        : code === 'EXISTS' ? 409 : 400;
    sendJson(res, status, { ok: false, code, error: String(err.message || err) });
  }

  if (p === '/api/project' && req.method === 'GET') {
    try {
      const u = new URL(req.url, 'http://127.0.0.1');
      const q = u.searchParams.get('path');
      sendJson(res, 200, projectcardMod.read(projectInput(q ? { path: q } : null)));
    } catch (err) { sendProjectError(res, err); }
    return;
  }

  if (p === '/api/project' && req.method === 'POST') {
    let body = {};
    try { body = await readBody(req); } catch (_) { /* 允许空 body */ }
    try {
      const op = String(body.op || 'read').trim().toLowerCase();
      const input = projectInput(body);
      let out;
      if (op === 'read') out = projectcardMod.read(input);
      else if (op === 'import') out = projectcardMod.importCard(input);
      else if (op === 'init') out = projectcardMod.initCard(input);
      else if (op === 'write') out = projectcardMod.writeContent(input, body.content);
      else if (op === 'validate') out = projectcardMod.validateOnly(input);
      else {
        const e = new Error('未知 op：' + op + '（read / import / init / write / validate）');
        e.code = 'BAD_OP'; throw e;
      }
      sendJson(res, 200, Object.assign({ ok: out.ok !== false }, out));
    } catch (err) { sendProjectError(res, err); }
    return;
  }

  if (p === '/api/keil/registers' && req.method === 'POST') {
    let body = {};
    try { body = await readBody(req); } catch (_) { /* 允许空 body */ }
    try {
      const hse = currentKeil ? regreadMod.findHseValue(currentKeil.model)
        : { hz: 8000000, source: '默认估算（还没有打开工程）', confident: false };
      const r = await regreadMod.readRegisters({ hseHz: hse.hz });
      if (!r.ok) { sendJson(res, 503, { ok: false, connected: false, error: r.reason, hse }); return; }
      const payload = { ok: true, connected: true, hse, clock: r.clock, rcc: r.rcc, gpio: r.gpio };
      if (body.compare !== false && currentKeil) {
        const pinmap = pinmapMod.scanProjectPins(currentKeil.model);
        payload.pinmap = pinmap;
        payload.compare = regreadMod.comparePinmapWithChip(pinmap, r);
      }
      sendJson(res, 200, payload);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err.message || err) });
    }
    return;
  }

  if (p === '/api/keil/readmem' && req.method === 'POST') {
    let body = {};
    try { body = await readBody(req); } catch (_) { /* 允许空 body */ }
    ensureKeil();
    try {
      if (body.addr === undefined || body.addr === null || String(body.addr).trim() === '') {
        throw new Error('需要 addr：十六进制地址（如 0x20000000）或符号名（如 shadow，需要先 build 过）');
      }
      let addr = body.addr;
      let symbol = null;
      const s = String(addr).trim();
      const numeric = /^0x[0-9a-f]+$/i.test(s) || /^\d+$/.test(s);
      if (!numeric) {
        if (!lastKeilBuild) lastKeilBuild = loadLastBuild();
        const axf = lastKeilBuild && lastKeilBuild.artifact && lastKeilBuild.artifact.axf;
        if (!axf) throw new Error('addr 写的是符号名，但还没有构建产物可查符号表 —— 先 build，或直接给十六进制地址');
        symbol = await symbolsMod.resolveSymbolAddress(axf, s);
        addr = symbol.addr;
      }
      const length = Math.max(1, Math.min(4096, Number(body.length) || 64));
      /* 注意：这里**不 halt**。实测 init → mdw → exit 就能读到 RAM/外设寄存器，
         整条会话结束即退出，目标保持原运行状态（用户问题记录第 1 条的正解）。 */
      const r = await ocd.readMemory(addr, length);
      sendJson(res, 200, {
        ok: true, addr: r.addr, addrHex: '0x' + r.addr.toString(16), length: r.length,
        bytes: r.bytes, hex: r.hex, words: r.words, symbol, timeout: r.timeout,
        dump: ocd.formatHexdump(r.addr, r.bytes),
        note: '不 halt、读完即退出；目标保持原运行状态。',
      });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err.message || err) });
    }
    return;
  }

  /* ───────── 一次调用摸清全貌（为模型省往返）─────────
   * 新会话要「知道这个工程现在是什么状态」以前要调 4 次：status + spec + size + chip。
   * 这里全用已有数据拼：当前工程、功能契约摘要、上次构建账本、工具链/板子探测（有缓存）。
   * 不启动 OpenOCD、不编译 —— 只读文件与缓存，毫秒级。 */
  if (p === '/api/keil/overview' && req.method === 'GET') {
    try {
      const cur = ensureKeil();
      const env = toolchain.detectEnv();               // 5 s 缓存，通常零成本
      const armcc = (env.compilers || []).find((c) => c.usable && c.id === 'keil-ac5');
      const ocdOk = (env.flashers || []).some((f) => f.id === 'openocd' && f.usable);
      const out = {
        ok: true,
        open: !!cur,
        toolchain: {
          armcc: armcc ? armcc.path : null,
          openocd: ocdOk,
          serialPorts: (env.serialPorts || []).map((s) => s.path),
        },
      };
      if (cur) {
        out.project = keilSummary(cur.model);
        out.file = cur.file;
        out.openedAt = cur.openedAt;
        try {
          const f = featuresMod.read(cur.model.dir);
          const spec = f.spec || { modules: [] };
          const stale = featuresMod.staleness(cur.model.dir, spec);
          out.spec = {
            has: !!f.has, broken: !!f.broken, error: f.error || null,
            revision: spec.revision || 0, updatedAt: spec.updatedAt || null,
            stale: stale.state, changedFiles: stale.changedFiles || 0,
            modules: (spec.modules || []).map((m) => ({
              id: m.id, name: m.name, status: m.status, summary: m.summary,
            })),
          };
        } catch (err) {
          out.spec = { has: false, error: String(err.message || err) };
        }
        /* 工程卡摘要：AI 换了工程直接在这儿看到芯片/工具链/引脚数/串口，
           不用再调一次 project（省一轮往返）。 */
        try {
          const cr = projectcardMod.read(cur.model.dir);
          out.card = {
            has: !!cr.has, broken: !!cr.broken, path: cr.path,
            summary: cr.summary || null,
            counts: cr.validation.counts,
            missing: cr.validation.missing,
            errors: cr.validation.errors,
          };
        } catch (err) {
          out.card = { has: false, error: String(err.message || err) };
        }
        if (!lastKeilBuild) lastKeilBuild = loadLastBuild();
        if (lastKeilBuild) {
          const diags = lastKeilBuild.diagnostics || [];
          out.build = {
            at: lastKeilBuild.at,
            programSize: lastKeilBuild.programSize || null,
            errors: diags.filter((d) => d.level === 'error').length,
            warnings: diags.filter((d) => d.level === 'warning').length,
            hex: (lastKeilBuild.artifact && lastKeilBuild.artifact.hex) || null,
          };
        }
      }
      sendJson(res, 200, out);
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err.message || err) });
    }
    return;
  }

  /* ───────── 单会话连续采样（看「1 ms 节拍在不在跑」这类时序）───────── */
  if (p === '/api/keil/watch' && req.method === 'POST') {
    let body = {};
    try { body = await readBody(req); } catch (_) { /* 允许空 body */ }
    ensureKeil();
    try {
      if (body.addr === undefined || body.addr === null || String(body.addr).trim() === '') {
        throw new Error('需要 addr：十六进制地址（如 0x40000024）或符号名（如 shadow）');
      }
      let addr = body.addr;
      let symbol = null;
      const s = String(addr).trim();
      const numeric = /^0x[0-9a-f]+$/i.test(s) || /^\d+$/.test(s);
      if (!numeric) {
        if (!lastKeilBuild) lastKeilBuild = loadLastBuild();
        const axf = lastKeilBuild && lastKeilBuild.artifact && lastKeilBuild.artifact.axf;
        if (!axf) throw new Error('addr 写的是符号名，但还没有构建产物可查符号表 —— 先 build，或直接给十六进制地址');
        symbol = await symbolsMod.resolveSymbolAddress(axf, s);
        addr = symbol.addr;
      }
      const r = await ocd.watchMemory(addr, {
        samples: body.samples, intervalMs: body.intervalMs,
      });
      sendJson(res, 200, Object.assign({}, r, {
        addrHex: '0x' + r.addr.toString(16), symbol: symbol || null,
        note: '单次 OpenOCD 会话内采样；实际间隔 ≈ mdw 耗时 + sleep，用于定性判断（精确计时请用 DWT/SWO）',
      }));
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err.message || err) });
    }
    return;
  }

  /* ───────── 屏幕显存 → ASCII / PBM（用户问题记录第 13 条）─────────
   * SSD1306 的 I2C 读不可靠，看不到「屏幕上到底画了什么」。这里用 readmem 读显存、
   * 按页格式解成点阵。
   *
   * 2026-10-19 为「省 token」重做：默认只回**指纹 + 点亮数 + 与基线的差异**（一行输出），
   * 只有明确要 `mode=ascii` 时才拉 ASCII；`region` 可以只画一行；`baseline` 可以
   * 存/比一帧基准 —— 「按键后第一行变了没有」这类验证从 2K token 降到几十 token。 */
  if (p === '/api/keil/gfx' && req.method === 'POST') {
    let body = {};
    try { body = await readBody(req); } catch (_) { /* 允许空 body */ }
    ensureKeil();
    try {
      const width = Math.max(8, Math.min(256, Number(body.width) || gfxMod.DEFAULT_WIDTH));
      const height = Math.max(8, Math.min(128, Number(body.height) || gfxMod.DEFAULT_HEIGHT));
      const invert = body.invert === true;
      const mode = body.mode === 'ascii' || body.mode === 'both' ? body.mode : 'info';
      const baselineOp = ['save', 'compare', 'clear'].indexOf(String(body.baseline || '')) >= 0
        ? String(body.baseline) : null;
      let region = null;
      if (Array.isArray(body.region) && body.region.length === 4) region = body.region.map(Number);
      else if (typeof body.region === 'string' && body.region.trim()) {
        region = body.region.split(',').map((x) => Number(x.trim()));
        if (region.length !== 4 || region.some((n) => !Number.isFinite(n))) {
          throw new Error('region 要写 "x0,y0,x1,y1"（如 "0,0,127,15" 只看第一行）');
        }
      }
      let addr = body.addr;
      let symbol = null;
      const s = addr === undefined || addr === null ? '' : String(addr).trim();
      const numeric = /^0x[0-9a-f]+$/i.test(s) || /^\d+$/.test(s);
      if (!s) {
        /* 不写 addr 时自动找常见显存符号：本工程叫 shadow，别的工程可能叫 fb / buffer / OLED_GRAM… */
        if (!lastKeilBuild) lastKeilBuild = loadLastBuild();
        const axf = lastKeilBuild && lastKeilBuild.artifact && lastKeilBuild.artifact.axf;
        if (!axf) throw new Error('没有指定 addr，也没有构建产物可查显存符号 —— 先 build，或直接给 addr=0x20000068');
        const { symbols } = await symbolsMod.readSymbols(axf);
        const candidates = ['shadow', 'fb', 'framebuffer', 'frameBuffer', 'buffer', 'oled_buf', 'OLED_GRAM', 'g_oled_buf'];
        for (const name of candidates) {
          const rows = symbolsMod.findSymbol(symbols, name, true);
          if (rows.length === 1) { symbol = rows[0]; break; }
        }
        if (!symbol) {
          throw new Error('没有指定 addr，也没在符号表里找到常见显存符号（试过 ' + candidates.join('/') +
            '）。先用 action=symbols 找显存变量，再传 addr=符号名');
        }
        addr = symbol.addr;
      } else if (!numeric) {
        if (!lastKeilBuild) lastKeilBuild = loadLastBuild();
        const axf = lastKeilBuild && lastKeilBuild.artifact && lastKeilBuild.artifact.axf;
        if (!axf) throw new Error('addr 写的是符号名，但还没有构建产物可查符号表 —— 先 build，或直接给十六进制地址');
        symbol = await symbolsMod.resolveSymbolAddress(axf, s);
        addr = symbol.addr;
      }
      const need = width * Math.ceil(height / 8);
      const r = await ocd.readMemory(addr, need);
      if (r.length < need) throw new Error('读到的字节数不足：需要 ' + need + ' B，只拿到 ' + r.length + ' B');
      const bitmap = gfxMod.decodeSsd1306(r.bytes, width, height);
      const blank = gfxMod.isBlank(r.bytes);
      const litPixels = bitmap.bits.reduce((a, b) => a + b, 0);
      const hash = gfxMod.hashBytes(r.bytes);

      /* 基线：一帧「基准画面」，用来回答「屏幕变了没有 / 变在哪一块」 */
      const outDir = (currentKeil && currentKeil.model && currentKeil.model.dir)
        ? paths.tmpDir(currentKeil.model.dir, 'gfx')
        : paths.transientDir();
      const baseFile = path.join(outDir, 'baseline.bin');
      const baseMetaFile = path.join(outDir, 'baseline.json');
      let baseInfo = null;
      let diff = null;
      if (baselineOp === 'save') {
        fs.writeFileSync(baseFile, Buffer.from(r.bytes));
        baseInfo = { saved: true, at: new Date().toISOString(), hash, addr: r.addr, width, height, invert };
        fs.writeFileSync(baseMetaFile, JSON.stringify(baseInfo, null, 2), 'utf8');
      } else if (baselineOp === 'clear') {
        try { fs.unlinkSync(baseFile); } catch (_) { /* 本来就没有 */ }
        try { fs.unlinkSync(baseMetaFile); } catch (_) { /* 本来就没有 */ }
        baseInfo = { cleared: true };
      } else if (baselineOp === 'compare' || fs.existsSync(baseFile)) {
        if (!fs.existsSync(baseFile)) {
          if (baselineOp === 'compare') throw new Error('还没有保存过基线 —— 先 gfx baseline=save 存一帧');
        } else {
          const prev = gfxMod.decodeSsd1306(fs.readFileSync(baseFile), width, height);
          diff = gfxMod.diffBitmaps(prev, bitmap);
          try { baseInfo = Object.assign({ compare: true }, JSON.parse(fs.readFileSync(baseMetaFile, 'utf8'))); }
          catch (_) { baseInfo = { compare: true }; }
        }
      }

      let ascii = null;
      let asciiRegion = null;
      if (mode === 'ascii' || mode === 'both') {
        const crop = gfxMod.cropAscii(bitmap, region, { invert });
        ascii = crop.text;
        asciiRegion = { x0: crop.x0, y0: crop.y0, x1: crop.x1, y1: crop.y1, width: crop.width, height: crop.height };
      }
      let file = null;
      if (mode === 'ascii' || mode === 'both' || baselineOp === 'save') {
        file = gfxMod.writePbm(bitmap, outDir, { invert });
      }
      sendJson(res, 200, {
        ok: true, addr: r.addr, addrHex: '0x' + r.addr.toString(16), symbol: symbol || null,
        width, height, invert, mode, bytes: need, litPixels, blank, hash,
        baseline: baseInfo, diff,
        ascii, asciiRegion, file,
        note: blank ? '显存全 0：屏幕可能是灭的，或固件没在跑（这不是 gfx 失败）'
          : 'diff.changedPixels=0 表示和基线一模一样；bbox 是变化区域',
      });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err.message || err) });
    }
    return;
  }

  if (p === '/api/keil/build' && req.method === 'POST') {
    let body = {};
    try { body = await readBody(req); } catch (_) { /* 允许空 body */ }
    const out = ndjson(res);
    let file = null;
    try { file = body.path ? resolveKeilPath(body.path).file : (currentKeil && currentKeil.file); }
    catch (err) { out.end({ ok: false, error: String(err.message || err) }); return; }
    if (!file) { out.end({ ok: false, error: '没有指定工程，也没有已打开的工程' }); return; }

    out.send({ type: 'start', project: file, at: Date.now() });
    try {
      const r = await keilMod.buildKeil({
        projectFile: file,
        outDir: body.outDir,
        onLine: (line, tag) => out.send({ type: 'line', text: line, tag }),
      });
      if (r.ok && r.artifact) {
        // 记住这次产物，烧录按钮才能直接烧它
        lastKeilBuild = { file, artifact: r.artifact, outDir: r.outDir,
          programSize: r.programSize, map: r.map || null,
          diagnostics: r.diagnostics || [], at: Date.now() };
        saveLastBuild(lastKeilBuild);
      }
      out.end({
        ok: r.ok, stage: r.stage, programSize: r.programSize, artifact: r.artifact,
        outDir: r.outDir, warnings: r.warnings, errors: r.errors,
        diagnostics: r.diagnostics || [], failedFiles: r.failedFiles || [],
        map: r.map || null,
      });
    } catch (err) {
      out.send({ type: 'line', text: String(err.message || err), tag: 'error' });
      out.end({ ok: false, error: String(err.message || err) });
    }
    return;
  }

  if (p === '/api/keil/flash' && req.method === 'POST') {
    let body = {};
    try { body = await readBody(req); } catch (_) { /* 允许空 body */ }
    const out = ndjson(res);
    if (!lastKeilBuild || !lastKeilBuild.artifact) {
      out.end({ ok: false, error: '还没有构建过 Keil 工程 —— 先点「构建」再烧录' });
      return;
    }
    const hex = lastKeilBuild.artifact.hex;
    out.send({ type: 'start', file: hex, at: Date.now() });
    out.send({ type: 'line', text: '烧录 ' + hex, tag: 'phase' });
    try {
      const r = await ocd.flashFile(hex, { verify: body.verify !== false },
        (line) => out.send({ type: 'line', text: line, tag: 'build' }));
      out.send({ type: 'line', text: r.programmed ? '** Programming Finished **' : '未检测到写入完成标志', tag: r.programmed ? 'phase' : 'error' });
      if (r.verified) out.send({ type: 'line', text: '** Verified OK **', tag: 'phase' });
      out.end({ ok: r.ok, verified: r.verified, reason: r.reason, hex });
    } catch (err) {
      out.send({ type: 'line', text: String(err.message || err), tag: 'error' });
      out.end({ ok: false, error: String(err.message || err) });
    }
    return;
  }

  if (p === '/api/keil/size' && req.method === 'GET') {
    if (!lastKeilBuild) lastKeilBuild = loadLastBuild(); // 重启后自动恢复上次的账本
    if (!lastKeilBuild) { sendJson(res, 200, { ok: true, has: false }); return; }
    sendJson(res, 200, {
      ok: true,
      has: true,
      programSize: lastKeilBuild.programSize,
      map: lastKeilBuild.map || null,
      diagnostics: lastKeilBuild.diagnostics || [],
      builtAt: lastKeilBuild.at,
      project: currentKeil ? currentKeil.model.name : null,
      artifact: lastKeilBuild.artifact,
      mapFile: (lastKeilBuild.artifact && lastKeilBuild.artifact.map) || null,
    });
    return;
  }

  /* ───────── 符号表（用户问题记录第 3 条）────────────────────────────
   * 「想知道 shadow / reqPage 在 RAM 里的地址，只能读链接器段列表自己推」。
   * 现在直接解析构建出来的 .axf：符号名 → 地址/大小，filter 支持子串匹配。 */
  if (p === '/api/keil/symbols' && req.method === 'GET') {
    ensureKeil();
    if (!lastKeilBuild) lastKeilBuild = loadLastBuild();
    const axf = lastKeilBuild && lastKeilBuild.artifact && lastKeilBuild.artifact.axf;
    if (!axf) {
      sendJson(res, 409, { ok: false, error: '还没有构建过 Keil 工程 —— 先 build 一次，才能从 .axf 读符号表' });
      return;
    }
    try {
      const { symbols, cached } = await symbolsMod.readSymbols(axf);
      const filter = String(url.searchParams.get('filter') || '').trim();
      const type = String(url.searchParams.get('type') || '').trim();
      const limit = Math.max(1, Math.min(2000, Number(url.searchParams.get('limit')) || 200));
      let rows = symbols;
      if (filter) rows = rows.filter((s) => s.name.toLowerCase().includes(filter.toLowerCase()));
      if (type) rows = rows.filter((s) => String(s.type).toLowerCase() === type.toLowerCase());
      sendJson(res, 200, {
        ok: true, axf, total: symbols.length, matched: rows.length,
        symbols: rows.slice(0, limit), omitted: Math.max(0, rows.length - limit), cached,
      });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err.message || err) });
    }
    return;
  }

  /* ───────── 源码读写（编码感知）─────────────────────────────────────
   * 为什么要有这组路由：Keil 工程里的源码常常是 GBK(ANSI) 存盘的。按 UTF-8 读会乱码，
   * 按 UTF-8 写回去更糟 —— 在 Keil 里满屏乱码。插件早就写好了 srcfile.js（含 writeText），
   * 但一直没有任何路由调用它，所以「改代码」这一环在界面上是断的。这里把它接上。
   *
   * 两条安全规矩：
   *   1. 只能碰**当前打开的工程目录**里的文件，越界一律 403。
   *   2. 写之前先备份原件到插件工作区，并把备份路径回给调用方。
   */

  if (p === '/api/keil/src/list' && req.method === 'GET') {
    try {
      const cur = currentKeil || loadRecent();
      if (!cur) { sendJson(res, 400, { ok: false, error: '还没有打开 Keil 工程' }); return; }
      const dir = cur.model.dir;
      const files = cur.model.sources.map((f) => {
        const abs = path.resolve(dir, f.raw);
        let bytes = null, encoding = null, mtime = null;
        try {
          const st = fs.statSync(abs);
          bytes = st.size; mtime = st.mtimeMs;
          encoding = srcfileMod.detectEncoding(fs.readFileSync(abs));
        } catch (_) { /* 工程里列了但磁盘上没有：exists=false */ }
        return {
          rel: f.raw, group: f.group || '', kind: f.kind || '',
          abs, exists: bytes !== null, bytes, encoding, mtime,
        };
      });
      sendJson(res, 200, {
        ok: true, project: cur.model.name, dir, count: files.length,
        files: files.map((f) => Object.assign({}, f, { abs: undefined })),
      });
    } catch (err) {
      sendJson(res, 500, { ok: false, error: String(err.message || err) });
    }
    return;
  }

  if (p === '/api/keil/src/read' && req.method === 'GET') {
    try {
      const abs = resolveSourcePath(url.searchParams.get('path'));
      if (!fs.existsSync(abs)) { sendJson(res, 404, { ok: false, error: '文件不存在：' + abs }); return; }
      const r = srcfileMod.readText(abs);
      const st = fs.statSync(abs);
      sendJson(res, 200, {
        ok: true, abs, rel: path.relative(sourceRoot(), abs),
        encoding: r.encoding, hadBom: r.hadBom, bytes: r.bytes, mtime: st.mtimeMs,
        lines: r.text.split(/\r?\n/).length,
        text: r.text,
      });
    } catch (err) {
      sendJson(res, err.code === 'OUTSIDE' ? 403 : 400, { ok: false, error: String(err.message || err) });
    }
    return;
  }

  if (p === '/api/keil/src/write' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const abs = resolveSourcePath(body.path);
      if (typeof body.content !== 'string') {
        sendJson(res, 400, { ok: false, error: '缺少 content（要写入的完整文本）' }); return;
      }
      const ENCODINGS = ['utf8', 'utf8-bom', 'gbk', 'ascii'];
      if (body.encoding !== undefined && ENCODINGS.indexOf(String(body.encoding)) < 0) {
        sendJson(res, 400, {
          ok: false, error: '不支持的 encoding：' + body.encoding + '（可用：' + ENCODINGS.join(' / ') + '）',
        });
        return;
      }
      const existed = fs.existsSync(abs);
      const before = existed ? srcfileMod.readText(abs) : {
        text: null,
        /* 新文件的默认编码：内容含非 ASCII（中文注释）就用 UTF-8 BOM —— armcc 靠 BOM 判源文件编码，
           没有 BOM 的中文源文件会 #870-D 或静默编出乱码（用户问题记录第 9 条）。
           纯 ASCII 用 utf8（与工程里多数文件一致）。调用方可用 body.encoding 显式覆盖。 */
        encoding: body.encoding || (/[^\x00-\x7F]/.test(body.content) ? 'utf8-bom' : 'utf8'),
        hadBom: false,
      };
      const st = existed ? fs.statSync(abs) : null;

      /* 并发防呆：调用方读过文件就该把当时的 mtime 带回来；对不上说明中途被人改了。
         新建文件没有旧 mtime，跳过该检查。 */
      if (existed && body.expectMtime != null && Number(body.expectMtime) !== st.mtimeMs) {
        sendJson(res, 409, {
          ok: false, code: 'STALE',
          error: '文件在你读取之后被改过了（mtime 不符），拒绝覆盖',
          currentMtime: st.mtimeMs, expectMtime: Number(body.expectMtime),
        });
        return;
      }
      if (existed && before.text === body.content) {
        sendJson(res, 200, {
          ok: true, changed: false, created: false, abs, rel: path.relative(sourceRoot(), abs),
          encoding: before.encoding, bytes: st.size, mtime: st.mtimeMs,
          hadBom: before.hadBom,
        });
        return;
      }

      /* 备份原件：写坏了要能一键还原。放在**本工程**的工作数据目录下，跟工程一起走。
         新文件没有原件，跳过备份（backup 回 null）。 */
      let backup = null;
      if (existed) {
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
        const backupDir = paths.srcBackupDir(sourceRoot(), stamp);
        const flat = path.relative(sourceRoot(), abs).replace(/[\\/]+/g, '__');
        /* 时间戳只到秒，而同一秒里对同一个文件写两次是常事（脚本、连续编辑、测试）——
           那样后一次的备份会把前一次的原件顶掉，「一键还原」就退不回真正的最初状态。
           实测踩到：BOM 回归测试里的连续两次写入互相覆盖，最后还原出来的是中间态。
           加个序号后缀，保证每一次写入都留下自己那份原件。 */
        backup = path.join(backupDir, flat);
        for (let n = 2; fs.existsSync(backup) && n < 1000; n += 1) {
          backup = path.join(backupDir, flat + '.' + n);
        }
        fs.copyFileSync(abs, backup);
      }

      /* 默认按**原编码**写回，除非调用方显式指定。
         `keepBom` 不传 → writeText 自己保证「原本有 BOM 就还有 BOM」——
         含中文的 .c 丢了 BOM，armcc 会编出乱码（用户问题记录第 9 条）。
         新建文件时 keepBom 以 before.encoding 的默认策略为准（utf8-bom 会带 BOM）。 */
      const enc = body.encoding || before.encoding;
      const w = srcfileMod.writeText(abs, body.content, enc,
        body.keepBom === undefined ? {} : { keepBom: !!body.keepBom });
      if (!w.ok) {
        sendJson(res, 500, { ok: false, error: w.error || '写回失败', encoding: enc, backup });
        return;
      }
      const after = fs.statSync(abs);
      sendJson(res, 200, {
        ok: true, changed: true, created: !existed, abs, rel: path.relative(sourceRoot(), abs),
        encoding: w.encoding, bytes: after.size, mtime: after.mtimeMs,
        backup, lines: body.content.split(/\r?\n/).length,
        hadBom: !!w.hadBom, bomBefore: existed ? before.hadBom : false,
        bomKept: !existed || before.hadBom === !!w.hadBom,
        warning: w.warning || null,
      });
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        sendJson(res, 400, {
          ok: false, error: '目标目录不存在（mcu write 不会自动建目录）：' + String(err.path || ''),
        });
        return;
      }
      sendJson(res, err.code === 'OUTSIDE' ? 403 : 400, { ok: false, error: String(err.message || err) });
    }
    return;
  }

  /* ───────── 功能契约（<工程>/.dsh-mcu/features.json）─────────
   * 用户看的是「这块板子能干什么」，不是 C 文件。这份描述是代码与用户之间的合同：
   * 模型改完代码必须重写它，用户改它就能反过来要求改代码。
   * 逻辑全在 server/features.js，这里只做 HTTP 薄壳（面板和 mcu 工具共用同一份）。 */

  function featureContext() {
    const cur = currentKeil || loadRecent();
    if (!cur) {
      const e = new Error('还没有打开 Keil 工程，无法定位功能描述（先在面板里打开工程）');
      e.code = 'NO_PROJECT'; throw e;
    }
    return { dir: cur.model.dir, name: cur.model.name };
  }

  function featurePayload(ctx, withHistory) {
    const r = featuresMod.read(ctx.dir);
    const stale = featuresMod.staleness(ctx.dir, r.spec);
    const out = {
      ok: true, has: r.has, broken: !!r.broken, error: r.error || null,
      path: r.path, project: ctx.name, dir: ctx.dir,
      spec: r.spec,
      stale,
      /* 紧凑清单（不带正文）：工具那边用它，免得把整份描述在 JSON 里再塞一遍 */
      outline: featuresMod.toOutline(r.spec),
      /* 渲染好的 Markdown：工具那一侧直接用，免得同一个渲染器存在两份 */
      markdown: featuresMod.toMarkdown(r.spec, { project: ctx.name, stale }),
    };
    if (withHistory) out.history = featuresMod.listHistory(ctx.dir);
    return out;
  }

  if (p === '/api/features' && req.method === 'GET') {
    try { sendJson(res, 200, featurePayload(featureContext(), true)); }
    catch (err) { sendJson(res, err.code === 'NO_PROJECT' ? 409 : 500, { ok: false, code: err.code || null, error: String(err.message || err) }); }
    return;
  }

  if (p === '/api/features' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const ctx = featureContext();
      const r = featuresMod.write(ctx.dir, body, {
        by: body.by === 'ai' ? 'ai' : 'user', project: ctx.name,
      });
      sendJson(res, 200, Object.assign(featurePayload(ctx, true), {
        saved: true, changed: r.changed, revision: r.revision,
      }));
    } catch (err) {
      sendJson(res, err.code === 'NO_PROJECT' ? 409 : 400, { ok: false, code: err.code || null, error: String(err.message || err) });
    }
    return;
  }

  /* 把「用户在面板上改的描述」编译成一条发给模型的话。
   * 放在后端而不是前端：这段措辞是这套机制的核心（要求模型改代码 + 回写描述 + 用自然语言汇报），
   * 只有一份、可测试，前端只负责显示和发送。 */
  if (p === '/api/features/message' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const ctx = featureContext();
      const before = featuresMod.read(ctx.dir).spec;
      const mode = String(body.mode || 'revise');
      const st = featuresMod.staleness(ctx.dir, before);
      let text;
      if (mode === 'describe') {
        text = featuresMod.buildDescribeMessage(ctx.name);
      } else if (mode === 'refresh') {
        text = featuresMod.buildRefreshMessage(ctx.name, st, before);
      } else {
        text = featuresMod.buildMessage(before, { modules: body.modules }, {
          project: ctx.name, note: body.note,
        });
      }
      const diff = (mode === 'revise') ? featuresMod.diffModules(before, body.modules) : null;
      sendJson(res, 200, {
        ok: true, mode, text, project: ctx.name,
        chars: text.length,
        changed: diff ? diff.changed.length : 0,
        added: diff ? diff.added.length : 0,
        removed: diff ? diff.removed.length : 0,
      });
    } catch (err) {
      sendJson(res, err.code === 'NO_PROJECT' ? 409 : 400, { ok: false, code: err.code || null, error: String(err.message || err) });
    }
    return;
  }

  if (p === '/api/features/restore' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const ctx = featureContext();
      const r = featuresMod.restore(ctx.dir, body.stamp, { project: ctx.name });
      sendJson(res, 200, Object.assign(featurePayload(ctx, true), { saved: true, revision: r.revision }));
    } catch (err) {
      sendJson(res, err.code === 'NO_PROJECT' ? 409 : 400, { ok: false, code: err.code || null, error: String(err.message || err) });
    }
    return;
  }

  if (p === '/api/pins' && req.method === 'GET') {
    const pins = readJsonFile(path.join(DATA_DIR, 'pins.json'), null);
    if (!pins) { sendJson(res, 404, { error: 'data/pins.json 还没准备好' }); return; }
    sendJson(res, 200, pins);
    return;
  }
  if (p === '/api/peripherals' && req.method === 'GET') {
    const per = readJsonFile(path.join(DATA_DIR, 'peripherals.json'), null);
    if (!per) { sendJson(res, 404, { error: 'data/peripherals.json 还没准备好' }); return; }
    sendJson(res, 200, per);
    return;
  }
  if (p === '/api/templates' && req.method === 'GET') {
    sendJson(res, 200, { templates: TEMPLATES });
    return;
  }
  if (p === '/api/projects' && req.method === 'GET') {
    sendJson(res, 200, { projects: buildMod.listProjects() });
    return;
  }
  if (p === '/api/projects' && req.method === 'POST') {
    const body = await readBody(req);
    const id = String(body.id || '').trim();
    if (!id) { sendJson(res, 400, { ok: false, error: '缺少工程名 id' }); return; }
    try {
      const created = buildMod.createProject(id, body.name, body.template || 'blink-uart');
      sendJson(res, 200, { ok: true, project: created });
    } catch (err) {
      sendJson(res, err.code === 'EXISTS' ? 409 : 400, { ok: false, error: String(err.message || err) });
    }
    return;
  }
  if (p.startsWith('/api/projects/') && req.method === 'DELETE') {
    const id = decodeURIComponent(p.slice('/api/projects/'.length));
    try {
      buildMod.assertSafeName(id);
      const dir = buildMod.projectDir(id);
      if (!fs.existsSync(dir)) { sendJson(res, 404, { ok: false, error: '工程不存在' }); return; }
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(path.join(buildMod.BUILD_DIR, id), { recursive: true, force: true });
      sendJson(res, 200, { ok: true });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: String(err.message || err) });
    }
    return;
  }
  if (p === '/api/build' && req.method === 'POST') {
    const body = await readBody(req);
    const project = String(body.project || '').trim();
    const out = ndjson(res);
    out.send({ type: 'start', project, at: Date.now() });
    try {
      const result = await buildMod.build(project, (line, tag) => out.send({ type: 'line', text: line, tag }));
      out.end({
        type: 'end', ok: result.ok,
        size: result.programSize, warnings: result.warnings,
        artifact: result.artifact, outDir: result.outDir,
      });
    } catch (err) {
      out.send({ type: 'line', text: '构建中断：' + String(err.message || err), tag: 'error' });
      out.end({ type: 'end', ok: false, error: String(err.message || err) });
    }
    return;
  }
  if (p === '/api/flash' && req.method === 'POST') {
    const body = await readBody(req);
    const out = ndjson(res);
    out.send({ type: 'start', project: body.project, at: Date.now() });
    try {
      const r = await ocd.flash(String(body.project || ''), { verify: body.verify !== false },
        line => out.send({ type: 'line', text: line, tag: 'flash' }));
      out.end({ type: 'end', ok: r.ok, reason: r.reason, bytes: r.bytes, verified: r.verified });
    } catch (err) {
      out.send({ type: 'line', text: String(err.message || err), tag: 'error' });
      out.end({ type: 'end', ok: false, error: String(err.message || err) });
    }
    return;
  }
  if (p === '/api/chip-info' && req.method === 'POST') {
    const out = ndjson(res);
    out.send({ type: 'start', at: Date.now() });
    try {
      const r = await ocd.probe(line => out.send({ type: 'line', text: line, tag: 'probe' }));
      out.end({ type: 'end', ok: r.ok, connected: r.connected, reason: r.reason, chip: r.chip });
    } catch (err) {
      out.send({ type: 'line', text: String(err.message || err), tag: 'error' });
      out.end({ type: 'end', ok: false, error: String(err.message || err) });
    }
    return;
  }
  if (p === '/api/reset' && req.method === 'POST') {
    const out = ndjson(res);
    out.send({ type: 'start', at: Date.now() });
    try {
      const r = await ocd.reset(line => out.send({ type: 'line', text: line, tag: 'reset' }));
      out.end({ type: 'end', ok: r.ok, reason: r.reason });
    } catch (err) {
      out.send({ type: 'line', text: String(err.message || err), tag: 'error' });
      out.end({ type: 'end', ok: false, error: String(err.message || err) });
    }
    return;
  }
  if (p === '/api/serial/open' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      const r = serial.open(String(body.port || ''), body.baud || 115200, { dtr: body.dtr, rts: body.rts });
      sendJson(res, 200, r);
    } catch (err) { sendJson(res, 400, { ok: false, error: String(err.message || err) }); }
    return;
  }
  if (p === '/api/serial/close' && req.method === 'POST') {
    const body = await readBody(req);
    sendJson(res, 200, serial.close(String(body.sessionId || '')));
    return;
  }
  if (p === '/api/serial/write' && req.method === 'POST') {
    const body = await readBody(req);
    try {
      // 前端可能给 {data:"...", hex:"AA55"}：hex 存在时以它为准（见 serial.write 注释）
      sendJson(res, 200, serial.write(String(body.sessionId || ''), body.hex ? { hex: body.hex } : body.data, !!body.hex));
    } catch (err) { sendJson(res, 400, { ok: false, error: String(err.message || err) }); }
    return;
  }
  if (p === '/api/serial/list' && req.method === 'GET') {
    sendJson(res, 200, { sessions: serial.list() });
    return;
  }
  if (p === '/api/serial/stream' && req.method === 'GET') {
    const id = url.searchParams.get('sessionId') || '';
    const unsub = serial.subscribe(id, ev => {
      if (!res.writableEnded) res.write(JSON.stringify(ev) + '\n');
    });
    if (!unsub) { sendJson(res, 404, { error: '串口会话不存在' }); return; }
    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store', 'Connection': 'keep-alive',
    });
    if (res.socket) res.socket.setNoDelay(true);
    const keep = setInterval(() => { if (!res.writableEnded) res.write(JSON.stringify({ type: 'ping', ts: Date.now() }) + '\n'); }, 15000);
    const done = () => { clearInterval(keep); unsub(); };
    req.on('close', done);
    res.on('close', done);
    return;
  }

  sendJson(res, 404, { error: '未知接口：' + p });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch(err => {
      if (!res.headersSent) sendJson(res, 500, { error: String(err && err.message || err) });
      else if (!res.writableEnded) res.end();
    });
    return;
  }
  serveStatic(req, res, url.pathname);
});

/**
 * 一次性迁移（2026-10-14 数据目录重构）：老版本的状态记在插件本体的 backend/build/ 下，
 * 现在搬到全局 recent.json + 按工程的 .dsh-mcu/。逻辑在 paths.migrateLegacyState，幂等。
 */
try {
  const moved = paths.migrateLegacyState();
  if (moved.length) console.log('  已迁移旧状态：' + moved.join('、'));
} catch (_) { /* 迁移失败不影响使用 */ }

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`后端无法监听 127.0.0.1:${PORT}：端口已被占用。`);
    console.error('常见原因：上一次 DSH 异常退出/崩溃后，后端进程没被带走，还占着这个端口。');
    console.error('处理：结束那个 node 进程；或把插件 config.port 设为 0（让系统分配空闲端口，推荐）。');
    process.exit(2);
  }
  console.error('后端启动失败：' + (err && err.stack || err));
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  // MCU_AGENT_PORT=0 时由系统分配空闲端口：真实端口从 address() 读，不能再用 PORT
  const addr = server.address();
  const actualPort = addr && typeof addr === 'object' ? addr.port : PORT;
  const url = `http://127.0.0.1:${actualPort}/`;
  /* 机器可读行**必须先打印**：宿主插件靠它在启动阶段认领端口。
     以前这行排在 toolchain.detectEnv() 之后 —— 那边要起 powershell 枚举串口（约 2 s），
     宿主又被 DSH 启动期的负载拖慢，20 s 的启动窗口被白白吃掉，一超时就误报
     「后端启动超时」，而进程其实活得好好的（2026-10-18 实测）。 */
  console.log(`  LISTEN ${url}`);
  const env = toolchain.detectEnv();
  const cc = env.compilers.find(c => c.usable);
  const fl = env.flashers.find(f => f.usable);
  console.log('');
  console.log('  STM32F103C8T6 工作台后端已启动');
  console.log('  ─────────────────────────────────────────────');
  console.log(`  界面   ${url}`);
  console.log(`  编译器 ${cc ? cc.name + '  (' + cc.path + ')' : '未找到 —— 构建不可用'}`);
  console.log(`  烧录器 ${fl ? fl.name : '未找到 —— 烧录不可用'}`);
  console.log(`  串口   ${env.serialPorts.length ? env.serialPorts.map(p => p.path).join(', ') : '当前无'}`);
  console.log('  按 Ctrl+C 停止');
  console.log('');
});

process.on('SIGINT', () => {
  serial.closeAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500);
});
process.on('SIGTERM', () => { serial.closeAll(); server.close(() => process.exit(0)); });

module.exports = server;
