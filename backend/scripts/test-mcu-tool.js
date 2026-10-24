'use strict';
/**
 * test-mcu-tool.js —— 脱离 DSH，直接验证宿主注册的那个 `mcu` 工具
 *
 * 为什么要有它：工具一旦注册错，要等到重启 DSH 才会发现，而重启一次要麻烦巨维动手。
 * 这个脚本把 mcuToolDefinition 单独 import 出来，配一个真后端跑全部 action，
 * 在重启之前就把逻辑、参数、输出形状都验一遍。
 *
 * 顺带自检参数 Schema 是否符合 DSH 的 JSON Schema 子集
 * （关键词只允许 type/oneOf/properties/required/additionalProperties/items/enum/const）。
 *
 * 前提：`backend/build/keil-recent.json` 记着一个真实工程（检验用真实工程，但只读它）。
 * 用法：node backend/scripts/test-mcu-tool.js
 * 退出码：0 通过 / 1 断言失败 / 2 前提缺失
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('node:url');
const toolchain = require('../server/toolchain');

const ROOT = toolchain.ROOT;                       // <plugin>/backend
const PLUGIN = path.join(ROOT, '..');              // <plugin>
const PORT = Number(process.env.TEST_PORT || 8799);
const BASE = 'http://127.0.0.1:' + PORT;

let failures = 0;
/** 测试用的后端子进程；挂到模块作用域，保证 finally 里一定能杀掉，不留孤儿占端口 */
let child = null;
function check(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); return true; }
  failures++;
  console.log('  ✗ ' + name + (extra ? '\n      ' + extra : ''));
  return false;
}

/**
 * 收集会让 DSH 判「无损 JSON」失败的路径（undefined / NaN / Infinity / 函数等）。
 * DSH 会把工具返回值快照成 JSON，任何 undefined 属性都会让**整条结果**报
 * `tool "mcu" returned invalid output: value is not lossless JSON`，
 * 真正的业务错误反而被盖住（2026-10-18 实测：write 失败分支的 currentMtime 就是 undefined）。
 */
function lossyJsonPaths(value) {
  const bad = [];
  const walk = (v, p) => {
    if (v === undefined) { bad.push(p + ' = undefined'); return; }
    if (typeof v === 'number' && !Number.isFinite(v)) { bad.push(p + ' = ' + v); return; }
    if (typeof v === 'function' || typeof v === 'symbol' || typeof v === 'bigint') { bad.push(p + ' = ' + typeof v); return; }
    if (Array.isArray(v)) { v.forEach((it, i) => walk(it, p + '[' + i + ']')); return; }
    if (v && typeof v === 'object') { for (const k of Object.keys(v)) walk(v[k], p + '.' + k); }
  };
  walk(value, 'value');
  return bad;
}

/* ── DSH 允许的 JSON Schema 关键词子集 ───────────────────────────── */
const ALLOWED_KEYS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties',
  'items', 'enum', 'const', 'description', 'title', 'default', 'examples']);

/** 递归自检：用不支持的写法会静默失效，所以宁可在这里炸掉 */
function auditSchema(node, where, problems) {
  if (!node || typeof node !== 'object') { problems.push(where + ' 不是对象'); return; }
  Object.keys(node).forEach((k) => {
    if (!ALLOWED_KEYS.has(k)) problems.push(where + '.' + k + ' 不是受支持的关键词');
  });
  if (Object.hasOwn(node, 'required')) {
    if (!Array.isArray(node.required) || node.required.some((k) => typeof k !== 'string')) {
      problems.push(where + '.required 必须是字符串数组（DSH 不是 per-property 的 required:true）');
    }
  }
  if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
    problems.push(where + '.additionalProperties 必须是布尔');
  }
  if (node.properties) {
    Object.keys(node.properties).forEach((k) => auditSchema(node.properties[k], where + '.properties.' + k, problems));
  }
  if (node.items) auditSchema(node.items, where + '.items', problems);
}

(async () => {
  /* ── 0) 前提 ─────────────────────────────────────────────────── */
  // 老版本的状态记在插件本体内：先跑一次幂等迁移，否则升级后第一次跑测试会「找不到工程」
  const pathsMod = require('../server/paths');
  pathsMod.migrateLegacyState();
  const recentFile = pathsMod.recentFile();
  if (!fs.existsSync(recentFile)) {
    console.error('前提缺失：' + recentFile + '。先在工作台打开一次 Keil 工程。');
    process.exit(2);
  }
  const proj = JSON.parse(fs.readFileSync(recentFile, 'utf8')).file;
  if (!proj || !fs.existsSync(proj)) { console.error('前提缺失：工程不存在 → ' + proj); process.exit(2); }

  console.log('=== mcu 工具验证 ===');
  console.log('插件目录：' + PLUGIN);
  console.log('真实工程：' + proj);

  /* ── 1) 起后端 + 导入工具定义 ─────────────────────────────────── */
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    cwd: ROOT, env: Object.assign({}, process.env, { MCU_AGENT_PORT: String(PORT) }),
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
  const deadline = Date.now() + 20000;
  let up = false;
  while (Date.now() < deadline && !up) {
    try { up = (await fetch(BASE + '/api/env')).ok; } catch (_) { /* 等 */ }
    if (!up) await new Promise((r) => setTimeout(r, 300));
  }
  if (!up) { console.error('后端没起来：' + stderr.slice(-400)); process.exit(2); }
  console.log('后端就绪 :' + PORT);

  const mod = await import(pathToFileURL(path.join(PLUGIN, 'index.js')).href);
  console.log('index.js 导出：' + Object.keys(mod).join(', '));

  console.log('\n[1] 工具定义形状');
  check('导出了 mcuToolDefinition', typeof mod.mcuToolDefinition === 'function');
  const def = mod.mcuToolDefinition(() => Promise.resolve({ port: PORT }));
  check('name = mcu', def.name === 'mcu', def.name);
  check('有非空 description', typeof def.description === 'string' && def.description.length > 80);
  check('有 parameters 与 output.render', !!def.parameters && typeof def.output.render === 'function');
  check('声明了正整数 timeoutMs', Number.isFinite(def.timeoutMs) && def.timeoutMs > 0, String(def.timeoutMs));

  const problems = [];
  auditSchema(def.parameters, 'parameters', problems);
  auditSchema(def.output.schema, 'output.schema', problems);
  check('Schema 只用 DSH 支持的关键词', problems.length === 0, problems.join('\n      '));
  check('parameters.required 是数组', Array.isArray(def.parameters.required));
  check('action 有 enum', Array.isArray(def.parameters.properties.action.enum) &&
    def.parameters.properties.action.enum.length >= 10);
  check('render 返回 text block', (() => {
    const b = def.output.render({}, { ok: true, action: 'x', summary: '测试' });
    return Array.isArray(b) && b.length === 1 && b[0].type === 'text' && b[0].text === '测试';
  })());

  /* ── 2) 跑各个 action ─────────────────────────────────────────── */
  const signal = new AbortController().signal;
  const run = (args) => def.execute(args, { signal });

  /** 每个结果都要满足自己声明的输出形状，否则注册到 DSH 后会被判非法 */
  const shapeOk = (r) => r && typeof r.ok === 'boolean' && typeof r.action === 'string' &&
    typeof r.summary === 'string' && r.summary.length > 0 &&
    (r.data === undefined || (typeof r.data === 'object' && r.data !== null && !Array.isArray(r.data)));

  console.log('\n[2] 逐个 action（对着真后端）');

  const st = await run({ action: 'status' });
  console.log('    status  → ' + st.summary);
  check('status: 输出形状合法', shapeOk(st));
  check('status: 已打开工程', st.ok && st.data.open === true);
  check('status: 一次带回契约/构建/工具链（替代 status+spec+size+chip 四次调用）',
    st.ok && st.data.spec && st.data.toolchain &&
    typeof st.data.spec.revision === 'number' && typeof st.data.toolchain.openocd === 'boolean',
    JSON.stringify(st.data.spec && st.data.spec.revision));

  const op = await run({ action: 'open', path: proj });
  console.log('    open    → ' + op.summary.slice(0, 110));
  check('open: 输出形状合法', shapeOk(op));
  check('open: 成功且带回工程摘要', op.ok && op.data.project && op.data.project.device);

  const fl = await run({ action: 'files' });
  console.log('    files   → ' + fl.summary);
  check('files: 输出形状合法', shapeOk(fl));
  const gbkFile = (fl.data.files || []).find((f) => f.encoding === 'gbk' && f.kind === 'c' && f.exists);
  check('files: 找到 GBK 源文件用于下一步', !!gbkFile, fl.summary);

  if (gbkFile) {
    const rd = await run({ action: 'read', path: gbkFile.rel });
    console.log('    read    → ' + rd.summary);
    check('read: 输出形状合法', shapeOk(rd));
    check('read: GBK 被正确解码（文本非空且含中文或代码）',
      rd.ok && typeof rd.data.text === 'string' && rd.data.text.length > 20);
    check('read: 返回了 mtime（write 的并发防呆要用）', typeof rd.data.mtime === 'number');
    check('read: 编码标成 gbk', rd.data.encoding === 'gbk');
  }

  const bd = await run({ action: 'build' });
  console.log('    build   → ' + bd.summary);
  check('build: 输出形状合法', shapeOk(bd));
  check('build: 构建成功', bd.ok === true, bd.summary);
  check('build: 带回 programSize', !!(bd.data.programSize && bd.data.programSize.code > 0),
    JSON.stringify(bd.data.programSize));
  check('build: 带回结构化诊断数组', Array.isArray(bd.data.errors) && Array.isArray(bd.data.warnings));
  check('build: 成功构建时 errorCount = 0', bd.data.errorCount === 0, String(bd.data.errorCount));
  /* 项目无关的断言：不同工程的警告数天然不同（毕设工程 8 条、OLED 工程 2 条），
     写死条数就会换个工程就误报。这里断言的是「警告被结构化地带出来」这件事本身；
     「警告不再被丢掉」由 test-diag.js 用真实 armcc 输出单独覆盖。 */
  check('build: 警告数与诊断数组自洽（不依赖具体工程）',
    bd.data.warningCount === (bd.data.warnings || []).length + (bd.data.warningsOmitted || 0),
    'warningCount=' + bd.data.warningCount + ' 数组=' + (bd.data.warnings || []).length +
    ' omitted=' + (bd.data.warningsOmitted || 0));
  if (bd.data.warnings.length) {
    const w0 = bd.data.warnings[0];
    check('build: 警告带文件/行号/错误码',
      !!w0.file && typeof w0.line === 'number' && !!w0.code,
      JSON.stringify(w0));
  }

  const sz = await run({ action: 'size' });
  console.log('    size    → ' + sz.summary);
  check('size: 输出形状合法', shapeOk(sz));
  check('size: 有文件体积排行（userObjects，与界面同一份数据）',
    sz.ok && Array.isArray(sz.data.userObjects) && sz.data.userObjects.length > 0);
  check('size: 排行里每项都带 flash 字节数（字段名以 mapfile.js 为准）',
    sz.data.userObjects.every((o) => typeof o.flash === 'number' && o.flash > 0),
    JSON.stringify(sz.data.userObjects[0]));
  check('size: 带出「你的代码 vs C 库」两项合计',
    !!(sz.data.user && sz.data.library &&
      sz.data.user.flash + sz.data.library.flash === sz.data.totals.flash),
    JSON.stringify({ user: sz.data.user && sz.data.user.flash, lib: sz.data.library && sz.data.library.flash }));

  const pn = await run({ action: 'pins' });
  console.log('    pins    → ' + pn.summary.slice(0, 120));
  check('pins: 输出形状合法', shapeOk(pn));
  check('pins: 解析出引脚', pn.ok && Array.isArray(pn.data.pins));

  const rg = await run({ action: 'regs' });
  console.log('    regs    → ' + rg.summary.slice(0, 120));
  check('regs: 输出形状合法', shapeOk(rg));
  // 没插 ST-Link 时应当「如实失败」，而不是假装成功
  check('regs: 要么读到寄存器、要么如实报失败（不装成功）',
    (rg.ok && !!rg.data.clock) || (!rg.ok && /失败|未|error/i.test(rg.summary)),
    rg.summary);

  /* ── 补齐 2026-10-14 报告里「自测绕过」的那几个 action ──────────────
     报告指出：本测试只跑了 8/13，chip / reset / flash / scan 从未被调用，
     而出事的恰好就是 chip 与 reset（NDJSON 被当成普通 JSON 解析）。
     教训：**自测的覆盖面必须等于接口面**，否则测试给的绿灯是假的。 */
  const WITH_FLASH = process.argv.includes('--with-flash') || process.env.MCU_TEST_FLASH === '1';
  const covered = ['status', 'open', 'files', 'read', 'build', 'size', 'pins', 'regs'];

  const sc = await run({ action: 'scan', dir: path.dirname(proj) });
  console.log('    scan    → ' + sc.summary.slice(0, 110));
  check('scan: 输出形状合法', shapeOk(sc));
  check('scan: 扫到至少一个工程', sc.ok && Array.isArray(sc.data.projects) && sc.data.projects.length >= 1);
  covered.push('scan');

  /* write：用**原文回写**让后端判定 changed=false —— 既能跑到整条写入路径，
     又不改动用户的任何源码。再加一条 mtime 不符的拒绝断言。
     ⚠ 安全前提：**必须挑一个能一次读完的小文件**。
     2026-10-14 踩到：read 改成默认只返回 400 行之后，用截断的 `data.text` 回写
     就等于「把 1685 行的文件截成 400 行」—— 那次是靠 GBK 转码报错才没写进去，
     纯属运气。所以这里先挑小文件，再**断言读到的不是截断内容**，否则绝不动手。 */
  const cFiles = (fl.data.files || [])
    .filter((f) => f.kind === 'c' && f.exists && typeof f.bytes === 'number')
    .sort((a, b) => a.bytes - b.bytes);
  const small = cFiles.find((f) => f.bytes < 20000) || null;
  const writeTarget = small;
  if (!small) {
    console.log('    write   → 跳过（工程里没有小于 20 KB 的 C 文件，不做回写测试以免截断源码）');
  } else {
    const before = await run({ action: 'read', path: writeTarget.rel });
    console.log('    write   → 目标 ' + writeTarget.rel + '（' + writeTarget.bytes + ' B）');
    check('write 前置：样例文件必须一次读完（截断内容回写会毁掉源码）',
      before.ok === true && before.data.truncated !== true, before.summary);
    if (before.ok === true && before.data.truncated !== true) {
      const noop = await run({ action: 'write', path: writeTarget.rel, content: before.data.text, expectMtime: before.data.mtime });
      console.log('    write   → ' + noop.summary.slice(0, 110));
      check('write: 内容不变时 changed=false 且不落盘', noop.ok === true && noop.data.changed === false, noop.summary);
      const stale = await run({ action: 'write', path: writeTarget.rel, content: before.data.text + '\n', expectMtime: 1 });
      check('write: mtime 不符时拒绝覆盖（并发防呆）',
        stale.ok === false && /拒绝写入/.test(stale.summary), stale.summary);

      /* 2026-10-18 回归：write 失败分支以前带 undefined 的 currentMtime，
         DSH 会把整条工具结果判成「value is not lossless JSON」，真正的错误被吞掉。
         这里直接检查返回值是否无损，以及失败时 data 是否给 null。 */
      const projDir = path.dirname(proj);
      const probeRel = '.dsh-mcu\\tmp\\mcu-write-probe.c';
      const probeAbs = path.join(projDir, probeRel);
      try {
        const cr = await run({ action: 'write', path: probeRel, content: '/* 探针：中文注释 */\nint probe_value = 1;\n' });
        check('write: 文件不存在时能新建，含中文默认 UTF-8 BOM（created=true）',
          cr.ok === true && cr.data.created === true && cr.data.hadBom === true, cr.summary);
        check('write: 新建结果是无损 JSON', lossyJsonPaths(cr).length === 0, lossyJsonPaths(cr).join(', '));
      } finally {
        try { fs.unlinkSync(probeAbs); } catch (_) { /* 文件没建出来也无妨 */ }
      }
      const outside = await run({ action: 'write', path: '..\\..\\outside-probe.c', content: 'int x;\n' });
      check('write: 失败时 summary 给出真实原因、data 无 undefined（lossless JSON 回归）',
        outside.ok === false && /写入失败|拒绝/.test(outside.summary) &&
        outside.data.currentMtime === null && lossyJsonPaths(outside).length === 0,
        outside.summary + ' | ' + lossyJsonPaths(outside).join(', '));
      covered.push('write');

      /* render 是否真的把 data 交给了模型（2026-10-14 报告第 3 条） */
      const blocks = def.output.render({ action: 'read' }, before);
      check('render: 源码正文出现在模型可见的内容块里（bug3 回归）',
        Array.isArray(blocks) && blocks.length >= 2 &&
        blocks.some((b) => b.type === 'text' && b.text.includes(before.data.text.slice(0, 60))),
        '块数 ' + (Array.isArray(blocks) ? blocks.length : 0));
    }
  }

  /* render 对结构化结果也要带出 data（跟有没有小文件无关） */
  const bBlocks = def.output.render({ action: 'build' }, bd);
  check('render: 结构化结果的 data 也带出去了（bug3 回归）',
    Array.isArray(bBlocks) && bBlocks.length >= 2 &&
    bBlocks.some((b) => b.type === 'text' && /Code=|诊断|Flash/.test(b.text)),
    '块数 ' + (Array.isArray(bBlocks) ? bBlocks.length : 0));

  /* spec = 功能契约（用户唯一会读的东西）。
     这里**只读不写**：写路径已经在 test-features.js 里对着沙箱工程跑全了，
     没必要往巨维的真实工程里塞一份测试用的功能描述 —— 那会出现在他的面板上。 */
  const sp = await run({ action: 'spec' });
  console.log('    spec    → ' + sp.summary.slice(0, 130));
  check('spec: 输出形状合法', shapeOk(sp));
  check('spec: 带回模块数组与 revision',
    Array.isArray(sp.data.modules) && typeof sp.data.revision === 'number');
  check('spec: 带回过期判定（面板横幅与工具共用同一份数据）',
    !!sp.data.stale && typeof sp.data.stale.state === 'string', JSON.stringify(sp.data.stale));
  check('spec: render 把描述正文交给模型（否则模型读不到自己写的功能清单）', (() => {
    const b = def.output.render({ action: 'spec' }, sp);
    return Array.isArray(b) && b.length >= 2;
  })());
  covered.push('spec');

  /* chip / reset 是 NDJSON 流：以前工具用 json() 解析，必然抛
     「后端返回的不是 JSON」——这两个断言就是那条 bug 的回归测试。 */
  let chipErr = null; let chip = null;
  try { chip = await run({ action: 'chip' }); } catch (e) { chipErr = e; }
  console.log('    chip    → ' + (chip ? chip.summary.slice(0, 130) : '抛错：' + chipErr.message));
  check('chip: 不再抛「不是 JSON」（bug1 回归）', !chipErr,
    chipErr && String(chipErr.message));
  if (chip) {
    check('chip: 输出形状合法', shapeOk(chip));
    /* 硬件相关的 action 只能断言「如实」：连通就给芯片身份，不连通就给得出原因。
       实测这块 ST-Link 会稳定打 `Failed to read memory at 0xe00fffec` 噪音、
       退出码时好时坏，所以不能要求它必须成功。 */
    check('chip: 要么给出芯片身份、要么给出真实原因（不装成功）',
      chip.ok
        ? !!(chip.data.chip && (chip.data.chip.deviceId || chip.data.chip.flashKB))
        : /报错|失败|未检测到|没找到|拒绝|检查|Error|open failed/i.test(chip.summary),
      chip.summary);
    if (chip.ok && chip.data.chip && chip.data.chip.flashKB) {
      check('chip: summary 里带出 Flash 容量（字段是 flashKB，之前误读成 flashSizeKB）',
        /Flash\s+\d+\s*KB/.test(chip.summary), chip.summary);
    }
  }
  covered.push('chip');

  let resetErr = null; let rst = null;
  try { rst = await run({ action: 'reset' }); } catch (e) { resetErr = e; }
  console.log('    reset   → ' + (rst ? rst.summary.slice(0, 130) : '抛错：' + resetErr.message));
  check('reset: 不再抛「不是 JSON」（bug1 回归）', !resetErr, resetErr && String(resetErr.message));
  if (rst) check('reset: 输出形状合法', shapeOk(rst));
  covered.push('reset');

  /* symbols（用户问题记录第 3 条）：从 .axf 读符号表，地址应能对上变量。
     build 已在上面跑过，所以一定有产物。 */
  const sym = await run({ action: 'symbols', filter: 'reqDirty' });
  console.log('    symbols → ' + sym.summary.slice(0, 130));
  check('symbols: 输出形状合法', shapeOk(sym));
  check('symbols: 从 axf 解析出符号且能按 filter 命中',
    sym.ok && sym.data.total > 100 && sym.data.matched >= 1 &&
    Array.isArray(sym.data.symbols) && /0x[0-9a-f]{8}/i.test(String(sym.data.symbols[0].addr)),
    sym.summary);
  covered.push('symbols');

  /* readmem（用户问题记录第 1 条）：硬件相关，只能断言「如实」。
     有板子时读 RCC 的 CR 寄存器，应与 /api/keil/registers 读到的同一个值一致。 */
  const rd = await run({ action: 'readmem', addr: '0x40021000', length: 4 });
  console.log('    readmem → ' + rd.summary.slice(0, 130));
  check('readmem: 输出形状合法', shapeOk(rd));
  if (rd.ok) {
    const hex = String(rd.data.hex || '');
    check('readmem: 返回长度与请求一致（4 字节 → 8 个 hex 字符）', hex.length === 8, hex);
    check('readmem: 不 halt（summary 里如实说明）', /不 halt/.test(rd.summary), rd.summary);
    if (rg && rg.ok && rg.data && rg.data.rcc && Array.isArray(rg.data.rcc.regs)) {
      const crReg = rg.data.rcc.regs.find((x) => x.name === 'CR');
      if (crReg) {
        const want = String(crReg.value).toLowerCase().replace(/^0x/, '').padStart(8, '0');
        // 小端：内存字节序反过来
        const got = hex.toLowerCase();
        const rev = got.match(/../g).reverse().join('');
        check('readmem: 0x40021000 与 registers 的 RCC_CR 一致（互相印证）', got === want || rev === want,
          'registers=' + want + ' readmem=' + got);
      }
    }
  } else {
    check('readmem: 失败时给出真实原因（不装成功）',
      /失败|报错|拒绝|Error|OpenOCD/i.test(rd.summary), rd.summary);
  }
  covered.push('readmem');

  /* gfx：默认 info 只回指纹/差异（省 token），要图才 mode=ascii。硬件相关：没 ST-Link 时如实失败。 */
  const gfx = await run({ action: 'gfx' });
  console.log('    gfx     → ' + gfx.summary.slice(0, 130));
  check('gfx: 输出形状合法', shapeOk(gfx));
  if (gfx.ok) {
    check('gfx: 默认不返回整张 ASCII（省 token）', gfx.data.text === undefined || gfx.data.text === '',
      'text=' + String(gfx.data.text || '').length);
    check('gfx: 带回 hash 与点亮数', typeof gfx.data.hash === 'string' && typeof gfx.data.litPixels === 'number',
      'hash=' + gfx.data.hash);
    const gfxAscii = await run({ action: 'gfx', mode: 'ascii', region: '0,0,127,15' });
    check('gfx: mode=ascii + region 只画局部', gfxAscii.ok && (() => {
      const art = String(gfxAscii.data.text || '');
      return art.split('\n').length === 16 && art.split('\n')[0].length === 128;
    })(), gfxAscii.summary);
    const gfxSave = await run({ action: 'gfx', baseline: 'save' });
    check('gfx: baseline=save 返回基线信息', gfxSave.ok && gfxSave.data.baseline && gfxSave.data.baseline.saved === true,
      gfxSave.summary);
    const gfxDiff = await run({ action: 'gfx', baseline: 'compare' });
    check('gfx: baseline=compare 返回 changedPixels', gfxDiff.ok && gfxDiff.data.diff &&
      typeof gfxDiff.data.diff.changedPixels === 'number', gfxDiff.summary);
    const gfxClear = await run({ action: 'gfx', baseline: 'clear' });
    check('gfx: baseline=clear 成功', gfxClear.ok && gfxClear.data.baseline && gfxClear.data.baseline.cleared === true,
      gfxClear.summary);
  } else {
    check('gfx: 失败时给出真实原因（不装成功）',
      /失败|报错|拒绝|Error|OpenOCD|没有/i.test(gfx.summary), gfx.summary);
  }
  covered.push('gfx');

  /* watch：单会话采样。硬件相关，只断言「有数据时形状对 / 没数据时如实失败」。 */
  const wt = await run({ action: 'watch', addr: '0x40021000', samples: 4, intervalMs: 50 });
  console.log('    watch   → ' + wt.summary.slice(0, 130));
  check('watch: 输出形状合法', shapeOk(wt));
  if (wt.ok) {
    check('watch: 采样次数/统计与样本一致',
      wt.data.samples === 4 && Array.isArray(wt.data.values) && wt.data.values.length === 4 &&
      wt.data.min <= wt.data.max, wt.summary);
  } else {
    check('watch: 失败时给出真实原因（不装成功）',
      /失败|报错|拒绝|Error|OpenOCD|没有/i.test(wt.summary), wt.summary);
  }
  covered.push('watch');

  /* project = 工程卡（.dsh-mcu/project.json）：换工程/换芯片时唯一该读的事实层。
     ⚠ **不往用户的真实工程里写卡**：用临时目录 + 复制一份 .uvprojx 跑全流程；
       真实工程只做只读的 project/read。 */
  const cardRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcu-tool-card-'));
  try {
    const pr = await run({ action: 'project' });
    console.log('    project → ' + pr.summary.slice(0, 130));
    check('project: 输出形状合法', shapeOk(pr));
    check('project: 真实工程只读成功（有没有卡都应是正常状态）',
      pr.ok === true && typeof pr.data.has === 'boolean');

    fs.copyFileSync(proj, path.join(cardRoot, path.basename(proj)));
    const pv = await run({ action: 'project', op: 'validate', path: cardRoot });
    console.log('    project/validate → ' + pv.summary.slice(0, 130));
    check('project: op=validate 给草案且不落盘',
      pv.ok === true && pv.data.dryRun === true &&
      !fs.existsSync(path.join(cardRoot, '.dsh-mcu', 'project.json')), pv.summary);
    check('project: 草案从 .uvprojx 抽到芯片家族',
      /stm32/.test(String(pv.data.cardSummary || '')), pv.summary);

    const pi = await run({ action: 'project', op: 'import', path: cardRoot });
    console.log('    project/import  → ' + pi.summary.slice(0, 130));
    check('project: op=import 落盘并带回芯片/工具链',
      pi.ok === true && pi.data.has === true &&
      fs.existsSync(path.join(cardRoot, '.dsh-mcu', 'project.json')), pi.summary);
    check('project: 导入结果标明 keil-ac5 且引脚数 0（不猜引脚）',
      /keil-ac5/.test(pi.summary) && pi.data.counts.pins === 0, pi.summary);

    const pw = await run({
      action: 'project', op: 'write', path: cardRoot,
      content: JSON.stringify({
        pins: { map: [{ pin: 'PB8', signal: 'OLED_SCL', mode: 'out-od' }] },
        runtime: { serial: { port: 'COM9', baud: 115200 } },
      }),
    });
    console.log('    project/write   → ' + pw.summary.slice(0, 130));
    check('project: op=write 深合并并更新计数',
      pw.ok === true && pw.data.changed === true && pw.data.counts.pins === 1, pw.summary);
    check('project: write 后仍保留 import 的字段（深合并没整份覆盖）',
      fs.existsSync(path.join(cardRoot, '.dsh-mcu', 'project.json')) &&
      JSON.parse(fs.readFileSync(path.join(cardRoot, '.dsh-mcu', 'project.json'), 'utf8')).toolchain.backend === 'keil-ac5');

    const pr2 = await run({ action: 'project', path: cardRoot });
    check('project: 读回内容一致（引脚 1 个、串口 COM9）',
      pr2.ok === true && pr2.data.counts.pins === 1 &&
      /COM9/.test(JSON.stringify(pr2.data.cardSummary || '') + pr2.data.text), pr2.summary);
    const pfull = await run({ action: 'project', path: cardRoot, full: true });
    check('project: full:true 的正文是原始 JSON（要整份才用）', (() => {
      const blocks = def.output.render({ action: 'project', full: true }, pfull);
      return blocks.some((b) => b.type === 'text' && /"pins"/.test(b.text));
    })(), pfull.summary);

    const pc = await run({
      action: 'project', op: 'write', path: cardRoot,
      content: JSON.stringify({ pins: { map: [{ pin: 'PB8', signal: 'A' }, { pin: 'PB8', signal: 'B' }] } }),
    });
    check('project: 引脚冲突在摘要里明说（ok 但带 errors）',
      pc.ok === true && (pc.data.errors || []).length >= 1 && /冲突/.test(pc.summary), pc.summary);

    /* ESP-IDF 目录：靠证据文件识别，不猜引脚/串口 */
    const idfDir = path.join(cardRoot, 'esp32-cam');
    fs.mkdirSync(path.join(idfDir, 'main'), { recursive: true });
    fs.writeFileSync(path.join(idfDir, 'CMakeLists.txt'), 'project(esp32cam)\n', 'utf8');
    fs.writeFileSync(path.join(idfDir, 'sdkconfig'), '# auto\n', 'utf8');
    fs.writeFileSync(path.join(idfDir, 'main', 'CMakeLists.txt'), 'idf_component_register()\n', 'utf8');
    const pu = await run({ action: 'project', op: 'init', path: idfDir });
    console.log('    project/init    → ' + pu.summary.slice(0, 130));
    check('project: op=init 从证据文件认出 ESP-IDF', pu.ok === true && /esp-idf/.test(pu.summary), pu.summary);
    const pr3 = await run({ action: 'project', path: idfDir });
    check('project: ESP-IDF 卡把「烧录串口未填」列为待补',
      pr3.ok === true && (pr3.data.missing || []).some((m) => /烧录串口/.test(m)),
      JSON.stringify(pr3.data.missing));

    const again = await run({ action: 'project', op: 'import', path: cardRoot });
    check('project: 已有卡时 import 拒绝覆盖（不冲掉手写引脚表）',
      again.ok === false && /已经有工程卡/.test(again.summary), again.summary);
    covered.push('project');

    /* pins 以工程卡为准（有卡时不再扫源码）—— 临时往真实工程写一张卡，finally 删掉。
       这条是整件事的收益点：换工程时不用重扫源码就能拿到「这块板子接了什么」。 */
    const realCardFile = path.join(path.dirname(proj), '.dsh-mcu', 'project.json');
    if (!fs.existsSync(realCardFile)) {
      try {
        fs.mkdirSync(path.dirname(realCardFile), { recursive: true });
        fs.writeFileSync(realCardFile, JSON.stringify({
          schema: 1,
          target: { family: 'stm32', chip: 'STM32F103C8' },
          toolchain: { backend: 'keil-ac5', projectFile: path.basename(proj) },
          runtime: { flash: { method: 'swd', probe: 'st-link' } },
          pins: { map: [{ pin: 'PC13', signal: 'LED', mode: 'out', note: '低电平点亮' }], reserved: [] },
        }, null, 2), 'utf8');
        const pnCard = await run({ action: 'pins' });
        check('pins: 有工程卡时以卡为准（fromCard=true，不再扫源码）',
          pnCard.ok === true && pnCard.data.fromCard === true &&
          pnCard.data.pins.length === 1 && pnCard.data.pins[0].pin === 'PC13',
          pnCard.summary + ' | ' + JSON.stringify(pnCard.data.pins));
        const stCard = await run({ action: 'status' });
        check('status: 带回工程卡摘要（换工程一眼看到芯片/引脚数）',
          stCard.ok === true && !!stCard.data.card && stCard.data.card.has === true &&
          /stm32|STM32F103C8/.test(JSON.stringify(stCard.data.card)),
          stCard.summary);
        const prCard = await run({ action: 'project' });
        check('project: 读真实工程里的卡（引脚 1）', prCard.ok === true && prCard.data.counts.pins === 1, prCard.summary);
      } finally {
        try { fs.unlinkSync(realCardFile); } catch (_) { /* 没建出来也无妨 */ }
      }
    } else {
      console.log('    pins/card → 跳过（真实工程已有工程卡，不动它）');
    }
  } finally {
    try { fs.rmSync(cardRoot, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ }
  }

  if (WITH_FLASH) {
    const fls = await run({ action: 'flash' });
    console.log('    flash   → ' + fls.summary.slice(0, 130));
    check('flash: 输出形状合法', shapeOk(fls));
    check('flash: 完成且回读校验通过', fls.ok === true && fls.data.verified === true, fls.summary);
    covered.push('flash');
  } else {
    console.log('    flash   → 跳过（**会真的擦写板子**，需要显式加 --with-flash）');
  }

  console.log('\n[3] 覆盖面');
  // 直接取工具自己声明的 enum —— 这样「声明的接口面」和「测试跑过的面」是同一份真相
  const declared = (def.parameters.properties.action.enum || []).slice();
  const missing = declared.filter((x) => covered.indexOf(x) < 0);
  console.log('    已实跑 ' + covered.length + '/' + declared.length +
    (missing.length ? '，未跑：' + missing.join(', ') : ''));
  check('本次测试覆盖所有 action（或用 --with-flash 显式跳过）',
    missing.length === 0 || (missing.length === 1 && missing[0] === 'flash'),
    '未跑：' + missing.join(', '));

  console.log('\n[4] 错误处理');
  let threw = null;
  try { await run({ action: '不存在的动作' }); } catch (e) { threw = e; }
  check('未知 action 明确抛错', !!threw && /未知 action/.test(String(threw.message)));

  let threw2 = null;
  try { await run({ action: 'read' }); } catch (e) { threw2 = e; }
  check('read 缺 path 明确抛错', !!threw2 && /需要 path/.test(String(threw2.message)));

  let threw3 = null;
  try { await run({ action: 'write', path: '.\\User\\main.c' }); } catch (e) { threw3 = e; }
  check('write 缺 content 明确抛错', !!threw3 && /需要 content/.test(String(threw3.message)));

  const out = await run({ action: 'read', path: '..\\..\\..\\Windows\\win.ini' });
  console.log('    越界读取 → ' + out.summary.slice(0, 90));
  check('越界路径被后端拒绝且工具如实回报失败', out.ok === false && /拒绝/.test(out.summary));

  console.log('\n=== ' + (failures ? failures + ' 项失败' : '全部通过') + ' ===');
})().catch((err) => {
  console.error('测试异常：' + (err && err.stack ? err.stack : err));
  failures++;
}).finally(() => {
  if (child && !child.killed) { try { child.kill(); } catch (_) { /* 已退出 */ } }
  setTimeout(() => process.exit(failures ? 1 : 0), 300);
});
