/**
 * 宿主半边：单片机工作台的宿主侧。
 *
 * 三件事：
 *  1. 注册「单片机模式」Agent preset —— 用 ctx.agentPresets.register()，
 *     不再手改 profile 补丁（那是错的：注册表不扫目录，但插件可以程序化注册，
 *     参考 dsh-openwrite 的做法）。
 *  2. 拉起/停止 MCU 后端进程（真编译器 armcc / OpenOCD / 串口桥都在里面）。
 *  3. 在 DSH 自己的 HTTP 服务上注册同源路由 /mcu/*，代理到后端：
 *     浏览器端插件不用跨域、不用知道端口。
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'stm32-workbench';
export const inject = ['webServer'];

const ROUTE_PREFIX = '/mcu';
const PRESET_ID = 'mcu';

/* ───────────────────────── 单片机模式（preset） ───────────────────────── */

const PERSONA_PREFIX = [
  'You are an embedded-systems coding agent powered by the {{model}} model,',
  'working on STM32F103C8T6 (Cortex-M3, LQFP48, 64 KB Flash / 20 KB SRAM) bare-metal firmware.',
  'Toolchain: Keil MDK ARM Compiler 5 (armcc/armasm/armlink/fromelf) plus xPack OpenOCD with an ST-Link.',
  'The workbench backend, firmware sources, pin data and 便携 OpenOCD live beside this plugin (backend/).',
  'Read the stm32f103-dev skill before acting: it carries the Chinese-path pitfall, the build/flash commands,',
  'and the reporting rules. Report only what the tools actually output.',
  '**The user reads natural language, not C.** After every change to firmware code you MUST finish by calling',
  'the mcu tool with action=spec and rewriting the modular plain-language description of what this board does,',
  'so the workbench panel always matches the code. Write it for someone who will never open a .c file:',
  'describe observable behaviour (what happens on power-up, what a button or sensor does, what the display shows,',
  'what the UART prints, when it misbehaves) — not functions, files or registers. Keep the module list stable',
  'across edits so the user can track one feature over time. Their edits to that description are requirements:',
  'when the user sends an edited description, treat it as the specification and change the code to match it.',
].join(' ');

/** 与 standard 预设同构的本地开发工具面；去掉委派/workflow，加嵌入式专属技能目录 */
function presetPlugins() {
  const win = process.platform === 'win32';
  const rows = [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: {
      prefix: PERSONA_PREFIX,
      // DSH 0.2.1 起 agent loop 只注册 provider / model 两个提示词变量，内置 {{cwd}} 没有了；
      // 未解析的引用会让整轮 prompt 装配直接失败（unknown prompt variable "{{cwd}}" ...
      // registered variables: provider, model），表现就是「本轮运行失败、什么模型都用不了」。
      // 当前工作目录现在由 working-directory 服务作为用户上下文自动注入，这里不用再复述。
      suffix: '',
    } },
    { id: 'agent-instructions', name: '@deepseek-ai/dsh-agent-instructions', config: { maxBytes: 65536 } },
    { id: win ? 'tool-pwsh' : 'tool-bash', name: win ? '@deepseek-ai/dsh-tool-pwsh' : '@deepseek-ai/dsh-tool-bash' },
    { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
    { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } },
    { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
    { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem', config: {
      customSkillDirs: [path.join(process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh'), 'skills')],
    } },
    { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
    { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60000 } },
    { id: 'present', name: '@deepseek-ai/dsh-tool-present' },
    { id: 'command-goal', name: '@deepseek-ai/dsh-command-goal' },
    { id: 'tool-goal', name: '@deepseek-ai/dsh-tool-goal' },
    { id: 'compaction', name: 'cordis:group', group: true, isolate: { compaction: true, toolResultPruner: true }, config: [
      { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
      { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
      { id: 'tool-result-pruner', name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
        config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 } },
    ] },
    { id: 'planning', name: 'cordis:group', group: true, isolate: { planMode: true }, config: [
      { id: 'plan-mode', name: '@deepseek-ai/dsh-plan-mode', config: {
        section: [
          'You are in plan mode. Stay in plan mode until exit_plan_mode succeeds or the user switches the session mode.',
          'Explore first with non-mutating reads: the workbench AGENT.md, the real toolchain paths, existing firmware',
          'sources and data/pins.json. Do not edit files, do not build or flash, do not carry out the plan.',
          'Make the plan decision-complete: goal and success criteria, files to change, pin and peripheral choices,',
          'clock and memory budget, build and flash steps, how to verify on hardware, what cannot be verified without',
          'the board, and explicit datasheet questions. When ready, call exit_plan_mode as the only and final tool call.',
        ].join(' '),
      } },
    ] },
  ];
  return rows;
}

const PRESET_DEFINITION = {
  id: PRESET_ID,
  name: '单片机模式',
  description: 'STM32F103C8T6 裸机开发：Keil AC5 编译、ST-Link/OpenOCD 烧录、串口调试、引脚规划工作台',
  order: 5,
  plugins: presetPlugins(),
};

/* ───────────────────────── DSH 工具：mcu ─────────────────────────
 *
 * 为什么要有这个工具：以前界面走 HTTP、AI 自己跑 node 脚本或手工拼 URL —— 同一个逻辑
 * 两条路，出了「Flash 面板数字不对」「诊断脚本比对到旧产物还说一致」这类事故。
 * 工具一旦存在，AI 和界面就共用**同一条已经被验证过的路径**。
 *
 * 注册形态照 DSH 自己的 dsh-tool-todo 来（不导入 @deepseek-ai/dsh-tools：
 * 插件不能依赖 Harness 的包，defineTool 那套 DSL 编译完就是原生 JSON Schema，
 * 直接写原生 JSON Schema 注册等价，且少一个版本耦合点）。
 */

const TOOL_NAME = 'mcu';

/** 所有 action 及其用途，description 与校验共用一份，避免说一套做一套 */
const TOOL_ACTIONS = [
  'status', 'open', 'scan', 'files', 'read', 'write',
  'build', 'flash', 'size', 'pins', 'regs', 'chip', 'reset', 'spec',
  'symbols', 'readmem', 'gfx', 'watch',
];

/**
 * read 单次返回的最大行数。
 *
 * 为什么要有这个上限：DSH 的 `tool-result-pruner` 会用 `surfaceOp: replace`
 * **就地改写历史里超过 8192 字符的工具结果** —— 改写的是一条**旧消息**，
 * 于是从那条往后的前缀全变，**模型侧的 KV 缓存整段失效**。
 * 读整个文件（工程里有 60 KB 的单文件）正好把自己送进那个名单。
 * 分段读既保住缓存，也让「读到哪了」这件事显式可见。
 */
const DEFAULT_READ_LINES = 400;

const TOOL_DESCRIPTION = [
  'STM32F103 工作台（Keil AC5 + ST-Link/OpenOCD）。',
  '**先 status 一次拿到工程/契约/构建/工具链全貌，再动手**（不要 status→spec→size→chip 连调四次）。',
  'action：status=全貌；open/scan=选工程；files/read/write=源码（write 按原编码、可新建）；',
  'build=编译（返回结构化诊断，产物带 map）；flash=烧上次构建（烧完自动运行）；size=占用排行；',
  'pins=引脚；regs=寄存器/时钟；chip=探测芯片；reset=复位；',
  'open=打开工程（path 给 .uvprojx 或目录）；scan=扫目录里的工程（dir）；files=源文件与编码；',
  'read=读源码（path 用工程内相对路径，如 .\\User\\main.c；默认前 ' + DEFAULT_READ_LINES + ' 行，大文件用 offset/limit）；',
  'write=写源码（path + content，可选 expectMtime/encoding）——已有文件按原编码写回并备份，文件不存在按 encoding 新建；',
  'symbols=读构建产物 .axf 的符号表（filter 子串过滤）——变量/函数的地址与大小；',
  'readmem=读目标内存：addr 写十六进制地址或符号名，length 字节数（默认 64，上限 4096）；**不 halt**；',
  'gfx=看屏幕：默认只回 hash/点亮数/与基线差异（省 token）；mode=ascii 才拉图，region="0,0,127,15" 只看局部；' +
  'baseline=save|compare 做「屏幕变没变/变在哪」验证；addr 不写时自动找 shadow/fb 之类显存符号；',
  'watch=采样一个变量/寄存器（addr 可写符号名，samples/intervalMs），看节拍/周期类时序；',
  'spec=**功能契约**（人读的描述）。不带 content 读；带 content 写。写有两种：' +
  '全量 {"modules":[…]}（首次描述用）；**日常只用增量** {"updates":[{"id":"x", …只写要改的字段}]} 或 {"remove":["y"]}。' +
  '字段：id/name/status(done|partial|todo|broken)/summary(≤40字)/trigger/behavior[]/hardware[]/params[]/limits[]/files[]。' +
  '**只在行为或模块变化时更新**，没变就别写；用户改过的描述就是需求，照它改代码。',
  '行文：一行一件事、只写可观察现象、每条 ≤40 字；不写实现细节与空话。',
  '返回里 summary 是给人看的一行；默认还附紧凑表格，`full:true` 才回原始 JSON。失败时 ok=false 且 summary 说明原因。',
].join('');

const TOOL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: TOOL_ACTIONS.slice(),
      description: '要执行的动作。',
    },
    path: {
      type: 'string',
      description: 'open 用：.uvprojx 或目录；read/write 用：工程内的相对路径（如 .\\User\\main.c）。',
    },
    dir: { type: 'string', description: 'scan 用：要搜索 .uvprojx 的目录。' },
    content: {
      type: 'string',
      description: 'write 用：写进文件的完整文本。' +
        'spec 用：功能描述 JSON。全量 {"modules":[…]}；增量 {"updates":[{id,…}]} 或 {"remove":[id]}（推荐日常用）。',
    },
    offset: { type: 'number', description: 'read 用：起始行号，从 1 开始。缺省 1。' },
    limit: { type: 'number', description: 'read 用：最多读几行，缺省 ' + DEFAULT_READ_LINES + '，上限 2000。' },
    expectMtime: {
      type: 'number',
      description: 'write 用：读文件时拿到的 mtime。对不上说明中途被改过，写入会被拒绝（409）。',
    },
    verify: { type: 'boolean', description: 'flash 用：烧录后是否回读校验，默认 true。' },
    hseHz: { type: 'number', description: 'regs 用：外部晶振频率（Hz），缺省从工程源码里的 HSE_VALUE 读。' },
    filter: { type: 'string', description: 'symbols 用：按符号名子串过滤（如 reqDirty、shadow）。' },
    addr: { type: 'string', description: 'readmem 用：十六进制地址（0x20000000）或符号名（如 shadow，需要先 build 过）。' },
    length: {
      type: 'number',
      description: 'readmem 用：读取字节数，默认 64，上限 4096；内部按 4 字节字读，不足 4 的倍数会向上取整后截回。',
    },
    invert: { type: 'boolean', description: 'gfx 用：面板是反色（bit=0 才点亮）时传 true。默认 false。' },
    mode: {
      type: 'string',
      enum: ['info', 'ascii', 'both'],
      description: 'gfx 用：info（默认，只回 hash/亮点/基线差异，省 token）| ascii（拉点阵图）| both。',
    },
    region: { type: 'string', description: 'gfx 用："x0,y0,x1,y1"（含端点），只画这个区域，如 "0,0,127,15" 只看第一行。' },
    baseline: {
      type: 'string',
      enum: ['save', 'compare', 'clear'],
      description: 'gfx 用：save 把当前屏存为基线；compare 与基线比（回 changedPixels + 变化包围盒）；clear 清除。',
    },
    samples: { type: 'number', description: 'watch 用：采样次数，默认 20，上限 200。' },
    intervalMs: { type: 'number', description: 'watch 用：每个采样点之间的 sleep，默认 50 ms（实际间隔还要加 SWD 读耗时）。' },
    full: { type: 'boolean', description: '所有 action 用：true 时返回完整原始 JSON（默认是紧凑表格，省 token）。' },
    encoding: {
      type: 'string',
      enum: ['utf8', 'utf8-bom', 'gbk', 'ascii'],
      description: 'write 用（可选）：目标编码。已有文件默认沿用原编码；新建文件默认含非 ASCII 用 utf8-bom、否则 utf8。',
    },
  },
};

const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'action', 'summary'],
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string' },
    summary: { type: 'string' },
    data: { type: 'object', additionalProperties: true },
  },
};

/** 诊断压成一行，界面与工具输出共用同一个格式（diag.format 的等价实现，这边是 ESM 侧） */
function fmtDiag(d) {
  const loc = d.file ? (d.line ? d.file + ':' + d.line : d.file) : '(无文件)';
  return loc + (d.code ? ' #' + d.code : '') + ' ' + String(d.message || '').trim();
}

/** 只保留前 n 条，避免一次返回几万条把上下文塞爆 */
function cap(list, n) {
  const arr = Array.isArray(list) ? list : [];
  return { rows: arr.slice(0, n), total: arr.length, omitted: Math.max(0, arr.length - n) };
}

/**
 * 把工具返回值清洗成「无损 JSON」（DSH 的硬要求）。
 *
 * 为什么必须有它：DSH 会把 execute 的返回值快照成 JSON，遇到 `undefined` 属性 /
 * `NaN` / `Infinity` 就判整条工具输出非法，界面只显示
 * `tool "mcu" returned invalid output: value is not lossless JSON`——
 * **真正的错误信息反而被盖住**（2026-10-18 实测：write 失败分支带了个 undefined 的
 * currentMtime，用户看到的是这句毫无指向性的报错，而不是「文件不存在」）。
 * 这里统一清洗：undefined 属性直接去掉，非有限数变 null；字符串/布尔原样。
 */
function toLosslessJson(value) {
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return value;
  if (t === 'number') return Number.isFinite(value) ? value : null;
  if (t === 'undefined') return undefined; // 调用方（对象属性/数组项）决定怎么处理
  if (Array.isArray(value)) {
    return value.map((item) => {
      const v = toLosslessJson(item);
      return v === undefined ? null : v;
    });
  }
  if (t === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      const v = toLosslessJson(value[key]);
      if (v !== undefined) out[key] = v;
    }
    return out;
  }
  return String(value); // function/symbol/bigint 之类：模型用不到，转成字符串保底
}

/* ─────────────────── 工具结果怎么呈现给模型 ───────────────────
 *
 * 关键认知：**render 的返回值就是模型能看到的一切**，execute 返回的 value 只是
 * 结构化载体。以前这里只吐一行 summary，于是 data 全丢 —— 工具在 description 里
 * 承诺「data 是原始结构」，模型却永远看不到：`read` 读不回源码正文。
 */

/** 单块文本上限；超了截断并**明说**，别让模型以为自己看到了全部 */
const RENDER_TEXT_LIMIT = 20000;

function safeJson(v) {
  try { return JSON.stringify(v, null, 1); } catch (_) { return String(v); }
}

/**
 * 把工具结果渲染成模型能读到的内容块。
 *
 * 2026-10-19「省 token」重做：以前所有 action 都把整份 data 用 JSON 再吐一遍，
 * 于是 `size`/`symbols`/`pins`/`regs`/`readmem` 的返回里大量字段是 summary 已经说过的，
 * 每轮白烧几千 token，还更容易触发 DSH 的结果裁剪。现在：
 *   · 默认按 action 输出**紧凑表格/清单**；
 *   · `full:true` 才回原始 JSON（排查时才用）；
 *   · 带正文的结果（read/spec/readmem/gfx/watch）只回精选元数据 + 正文。
 */
function renderToolResult(value, args) {
  const summary = String((value && value.summary) || '（无输出）');
  const blocks = [{ type: 'text', text: summary }];
  const data = value && value.data;
  if (!data || typeof data !== 'object' || Object.keys(data).length === 0) return blocks;
  const action = String((value && value.action) || '');

  if (typeof data.text === 'string') {
    const meta = pickMeta(action, data);
    let metaText = safeJson(meta);
    if (metaText.length > 1500) metaText = metaText.slice(0, 1500) + '…（元数据已截断）';
    blocks.push({ type: 'text', text: '元数据：' + metaText });
    blocks.push({
      type: 'text',
      text: '----- ' + (data.rel || '正文') + ' -----\n' + data.text,
    });
    return blocks;
  }

  /* full:true → 原始 JSON（保底排查用） */
  if (args && args.full === true) {
    let body = JSON.stringify(data);
    if (body.length > RENDER_TEXT_LIMIT) body = body.slice(0, RENDER_TEXT_LIMIT) + '…（已截断）';
    blocks.push({ type: 'text', text: body });
    return blocks;
  }

  const lines = compactLines(action, data);
  if (lines.length) {
    let text = lines.join('\n');
    if (text.length > RENDER_TEXT_LIMIT) text = text.slice(0, RENDER_TEXT_LIMIT) + '\n…（已截断，full:true 看原始结构）';
    blocks.push({ type: 'text', text });
    return blocks;
  }

  let body = JSON.stringify(data);
  if (body.length > RENDER_TEXT_LIMIT) body = body.slice(0, RENDER_TEXT_LIMIT) + '…（已截断）';
  blocks.push({ type: 'text', text: body });
  return blocks;
}

/** 带正文的结果只回必要元数据（避免 words/bytes/ascii 再抄一遍） */
function pickMeta(action, data) {
  const pick = (keys) => {
    const out = {};
    keys.forEach((k) => { if (data[k] !== undefined) out[k] = data[k]; });
    return out;
  };
  if (action === 'read') return pick(['rel', 'encoding', 'bytes', 'lines', 'truncated', 'mtime', 'offset']);
  if (action === 'spec') return pick(['has', 'broken', 'error', 'revision', 'updatedAt', 'stale', 'project']);
  if (action === 'readmem') return pick(['addr', 'length', 'symbol', 'hex']);
  if (action === 'gfx') return pick(['addr', 'width', 'height', 'hash', 'litPixels', 'blank', 'diff', 'baseline', 'file']);
  if (action === 'watch') return pick(['addr', 'symbol', 'samples', 'intervalMs', 'elapsedMs', 'min', 'max', 'changes', 'first', 'last']);
  return pick(Object.keys(data).filter((k) => typeof data[k] !== 'object'));
}

function hex12(n) { return '0x' + (Number(n) >>> 0).toString(16).padStart(8, '0'); }

/** 每个 action 的紧凑展示（省 token 的主体） */
function compactLines(action, data) {
  const lines = [];
  const add = (s) => { if (s !== undefined && s !== null && String(s) !== '') lines.push(String(s)); };
  if (action === 'status') {
    if (data.project) {
      const p = data.project;
      add(p.name + ' · ' + p.device + ' · ' + p.core + ' · ' + p.optimFlag + ' · ' + p.sourceCount + ' 源文件');
    }
    if (data.spec) {
      const sp = data.spec;
      add('契约：' + (sp.has ? (sp.modules.length + ' 模块 r' + sp.revision + (sp.stale === 'stale' ? ' ⚠过期(' + sp.changedFiles + ' 文件被改)' : ' 同步')) : '还没有功能描述'));
      if (sp.modules && sp.modules.length) {
        add('模块：' + sp.modules.slice(0, 12).map((m) => m.id + '/' + m.status).join(' ') + (sp.modules.length > 12 ? ' …' : ''));
      }
    }
    if (data.build) {
      const b = data.build; const s = b.programSize || {};
      add('构建：Flash ' + s.flashBytes + ' B，SRAM ' + s.ramBytes + ' B，' + b.errors + ' 错 ' + b.warnings + ' 警告（' + (b.at ? new Date(b.at).toLocaleString() : '?') + '）');
    }
    if (data.toolchain) add('工具链：armcc ' + (data.toolchain.armcc ? '✓' : '✗') + ' · OpenOCD ' + (data.toolchain.openocd ? '✓' : '✗') + ' · 串口 ' + (data.toolchain.serialPorts.length || '无'));
    return lines;
  }
  if (action === 'symbols') {
    const rows = Array.isArray(data.symbols) ? data.symbols : [];
    add('共 ' + data.total + ' 个，匹配 ' + data.matched + (data.omitted ? '（省略 ' + data.omitted + '，缩小 filter 或加大 limit）' : ''));
    rows.slice(0, 40).forEach((s) => add(s.name + '  ' + s.addr + '  ' + (s.size ? s.size + ' B' : '-') + '  ' + s.type));
    return lines;
  }
  if (action === 'pins') {
    const pins = Array.isArray(data.pins) ? data.pins : [];
    add('引脚 ' + pins.length + ' 个，冲突 ' + ((data.conflicts || []).length) + '，重配 ' + ((data.reconfigs || []).length));
    pins.slice(0, 30).forEach((p) => add(Object.entries(p).filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => k + '=' + (typeof v === 'object' ? JSON.stringify(v) : v)).join(' ')));
    return lines;
  }
  if (action === 'regs') {
    if (data.clock) add('SYSCLK ' + (data.clock.sysclkHz / 1e6).toFixed(1) + ' MHz ' + (data.clock.source || ''));
    if (data.compare) add('与源码对照：一致 ' + (data.compare.matched || 0) + '，差异 ' + ((data.compare.differences || []).length) + '，缺失 ' + ((data.compare.missing || []).length));
    return lines;
  }
  if (action === 'size') {
    const s = data.programSize || {};
    add('Flash ' + s.flashBytes + ' B（' + ((s.flashBytes / ((s.flashKB || 64) * 1024)) * 100).toFixed(1) + '%） · SRAM ' + s.ramBytes + ' B（' + ((s.ramBytes / ((s.ramKB || 20) * 1024)) * 100).toFixed(1) + '%）');
    const uo = Array.isArray(data.userObjects) ? data.userObjects : [];
    if (uo.length) {
      add('最大文件：' + uo.slice(0, 5).map((o) => o.name + ' ' + o.flash + 'B').join(' · '));
    }
    const fn = Array.isArray(data.functions) ? data.functions : [];
    if (fn.length) add('最大函数：' + fn.slice(0, 5).map((f) => f.name + ' ' + f.flash + 'B').join(' · '));
    return lines;
  }
  if (action === 'build') {
    const s = data.programSize;
    if (s) add('Code=' + s.code + ' RO=' + s.rodata + ' RW=' + s.rwdata + ' ZI=' + s.zidata + ' · Flash ' + s.flashBytes + '/' + (s.flashKB || 64) + ' KB');
    const diags = Array.isArray(data.diagnostics) ? data.diagnostics : [];
    const errs = diags.filter((d) => d.level === 'error');
    const warns = diags.filter((d) => d.level === 'warning');
    add('诊断：' + errs.length + ' 错 / ' + warns.length + ' 警告' + (data.artifact ? '；产物已生成' : ''));
    errs.slice(0, 6).forEach((d) => add('E ' + (d.file || '?') + ':' + (d.line || '?') + ' ' + (d.code || '') + ' ' + String(d.message || '').slice(0, 120)));
    warns.slice(0, 2).forEach((d) => add('W ' + (d.file || '?') + ':' + (d.line || '?') + ' ' + String(d.message || '').slice(0, 100)));
    if (data.logTail && data.logTail.length && errs.length) {
      add('日志尾部：'); data.logTail.slice(-6).forEach((l) => add('  ' + String(l).slice(0, 160)));
    }
    return lines;
  }
  if (action === 'readmem') {
    add(data.addr + '  ' + data.length + ' B' + (data.symbol ? '（' + data.symbol.name + '）' : ''));
    add('hex: ' + data.hex);
    return lines;
  }
  if (action === 'gfx') {
    add((data.width || 128) + '×' + (data.height || 64) + ' @ ' + data.addr + ' · hash ' + data.hash + ' · ' + (data.blank ? '全 0（屏幕灭/固件没跑？）' : '点亮 ' + data.litPixels + ' 像素'));
    if (data.diff) {
      add(data.diff.changedPixels ? ('与基线差异 ' + data.diff.changedPixels + ' 像素，区域 ' +
        data.diff.bbox.x0 + ',' + data.diff.bbox.y0 + ' → ' + data.diff.bbox.x1 + ',' + data.diff.bbox.y1)
        : '与基线完全一致');
    }
    if (data.baseline && data.baseline.saved) add('基线已保存 ' + data.baseline.at);
    if (data.baseline && data.baseline.cleared) add('基线已清除');
    if (data.ascii) add('ASCII ' + data.asciiRegion.width + '×' + data.asciiRegion.height + '（mode=ascii 时才输出，已省略）');
    return lines;
  }
  if (action === 'watch') {
    add('采样 ' + data.samples + ' 次 @ ' + data.addr + '：first=' + hex12(data.first) + ' last=' + hex12(data.last) +
      ' min=' + hex12(data.min) + ' max=' + hex12(data.max) + ' changes=' + data.changes +
      '（' + data.elapsedMs + ' ms，约 ' + Math.round(data.elapsedMs / data.samples) + ' ms/点）');
    add('值：' + (data.values || []).map(hex12).join(' '));
    return lines;
  }
  if (action === 'files') {
    const files = Array.isArray(data.files) ? data.files : [];
    add('共 ' + data.count + ' 个（GBK ' + (data.gbkCount || 0) + '，缺失 ' + ((data.missing || []).length) + '）');
    files.slice(0, 25).forEach((f) => add((f.rel || f.path) + '  ' + f.encoding + (f.exists === false ? '  [缺失]' : '')));
    return lines;
  }
  if (action === 'open') {
    if (data.project) add(data.project.name + ' · ' + data.project.device + ' · ' + data.project.summary);
    (data.diagnostics || []).slice(0, 5).forEach((d) => add('· ' + d.level + ': ' + String(d.message || '').slice(0, 140)));
    return lines;
  }
  if (action === 'scan') {
    (data.projects || []).slice(0, 20).forEach((p) => add((p.name || p.file) + '  ' + (p.device || '')));
    return lines;
  }
  return [];
}


/**
 * 构造 mcu 工具定义。
 * 导出是为了能脱离 DSH 单独测试（scripts/test-mcu-tool.js 直接对着真后端跑一遍），
 * Cordis 只关心 name / inject / apply 三个导出，多一个不影响加载。
 * @param {() => Promise<{port:number}>} ensureBackend 能拿到后端端口（必要时负责拉起）
 */
export function mcuToolDefinition(ensureBackend) {
  /* ── 与后端对话的两个小 helper ── */

  /** 一次性请求：缓冲区用完就返回（构建/烧录都只有几秒，不需要真流式） */
  function call(method, url, body, timeoutMs, signal) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const payload = body === undefined || body === null ? null : Buffer.from(JSON.stringify(body), 'utf8');
      const headers = payload ? { 'content-type': 'application/json', 'content-length': String(payload.length) } : {};
      const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', (err) => reject(err));
      req.setTimeout(timeoutMs, () => req.destroy(new Error('后端响应超时（' + timeoutMs + ' ms）')));
      if (signal) {
        if (signal.aborted) { req.destroy(new Error('调用已取消')); return; }
        signal.addEventListener('abort', () => req.destroy(new Error('调用已取消')), { once: true });
      }
      if (payload) req.write(payload);
      req.end();
    });
  }

  /** 后端的流式接口是 NDJSON：逐行 JSON，最后那一行（没有 type 字段）才是结果 */
  function parseNdjson(text) {
    const lines = [];
    let final = null;
    String(text).split(/\r?\n/).forEach((l) => {
      if (!l.trim()) return;
      let o;
      try { o = JSON.parse(l); } catch (_) { return; }
      if (o && o.type === 'line') lines.push({ tag: o.tag || '', text: o.text || '' });
      else if (o && (o.ok !== undefined || o.error !== undefined)) final = o;
    });
    return { lines, final };
  }

  async function json(method, pathname, body, timeoutMs, signal) {
    const be = await ensureBackend();
    const r = await call(method, 'http://127.0.0.1:' + be.port + pathname, body, timeoutMs || 60000, signal);
    let parsed = null;
    try { parsed = JSON.parse(r.text); } catch (_) { /* 下面按状态码报错 */ }
    if (parsed === null) throw new Error('后端返回的不是 JSON（HTTP ' + r.status + '）：' + r.text.slice(0, 300));
    return { status: r.status, body: parsed };
  }

  async function stream(pathname, body, timeoutMs, signal) {
    const be = await ensureBackend();
    const r = await call('POST', 'http://127.0.0.1:' + be.port + pathname, body || {}, timeoutMs, signal);
    const { lines, final } = parseNdjson(r.text);
    if (!final) {
      throw new Error('后端没有给出结果行（HTTP ' + r.status + '）。最后几行：' +
        lines.slice(-5).map((l) => l.text).join(' | ').slice(0, 400));
    }
    return { lines, final };
  }

  return {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS,
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      /* render 决定**模型实际看到什么**。
         以前这里只吐一行 summary，等于把 data 整个丢掉 —— 工具在 description 里承诺
         「data 是原始结构」，模型却永远看不到：`read` 读不回源码正文、`build` 的结构化
         诊断也拿不到。（2026-10-14 报告确认，这个坑实际踩到过一次。） */
      render: (args, value) => renderToolResult(value, args),
    },
    /* 构建 41 个文件要 5 秒左右，烧录还要加上擦写 Flash 的时间 */
    timeoutMs: 600000,

    async execute(args, exec) {
      const a = args && typeof args === 'object' ? args : {};
      const action = String(a.action || '').trim().toLowerCase();
      if (TOOL_ACTIONS.indexOf(action) < 0) {
        throw new Error('未知 action：' + JSON.stringify(a.action) + '。可用：' + TOOL_ACTIONS.join(', '));
      }
      const signal = exec && exec.signal;
      /* data 必须先过一遍无损 JSON 清洗：undefined/NaN 会让 DSH 判整条工具结果非法，
         把真正的失败原因盖成一句「value is not lossless JSON」（2026-10-18 实战踩到）。 */
      const done = (ok, summary, data) => ({
        ok: !!ok, action, summary: String(summary), data: toLosslessJson(data || {}),
      });

      switch (action) {
        case 'status': {
          const r = await json('GET', '/api/keil/overview', null, 30000, signal);
          const b = r.body || {};
          if (!b.ok) return done(false, '读取工程概览失败：' + (b.error || ('HTTP ' + r.status)), { status: r.status });
          if (!b.open) {
            return done(true,
              '当前没有打开任何 Keil 工程。工具链：armcc ' +
              (b.toolchain && b.toolchain.armcc ? '✓' : '✗') + '，OpenOCD ' +
              (b.toolchain && b.toolchain.openocd ? '✓' : '✗') + '。用 open/scan 选一个工程。',
              { open: false, toolchain: b.toolchain || null });
          }
          const p = b.project || {};
          const sp = b.spec || {};
          const mods = Array.isArray(sp.modules) ? sp.modules : [];
          const parts = [
            '已打开：' + p.name + '（' + p.device + ' / ' + p.core + ' / ' + p.optimFlag + ' / ' + p.sourceCount + ' 源文件）',
          ];
          if (sp.has) {
            parts.push('功能契约 ' + mods.length + ' 模块 r' + sp.revision +
              (sp.stale === 'stale' ? ' ⚠已过期（' + sp.changedFiles + ' 个文件改过）' : '（与代码同步）'));
          } else {
            parts.push('还没有功能契约（首次可用 spec 全量写一份）');
          }
          if (b.build) {
            const s = b.build.programSize || {};
            parts.push('上次构建：Flash ' + s.flashBytes + '/' + ((s.flashKB || 64) * 1024) +
              ' B，SRAM ' + s.ramBytes + ' B，' + b.build.errors + ' 错 ' + b.build.warnings + ' 警告');
          }
          parts.push('工具链：armcc ' + (b.toolchain.armcc ? '✓' : '✗') +
            '，OpenOCD ' + (b.toolchain.openocd ? '✓' : '✗') +
            '，串口 ' + ((b.toolchain.serialPorts || []).join(',') || '无'));
          parts.push('下一步建议：' + (b.build ? '改代码→build→flash；看屏用 gfx；查变量用 symbols/readmem' : '先 build 一次，产物才能烧录/读符号'));
          return done(true, parts.join('；'), {
            open: true, file: b.file || null, project: p,
            spec: { has: !!sp.has, revision: sp.revision || 0, stale: sp.stale || null, modules: mods },
            build: b.build || null, toolchain: b.toolchain || null,
          });
        }

        case 'open': {
          if (!a.path) throw new Error('open 需要 path（.uvprojx 或它所在的目录）');
          const r = await json('POST', '/api/keil/open', { path: a.path }, 60000, signal);
          if (!r.body.ok) return done(false, '打开失败：' + r.body.error, { status: r.status });
          const p = r.body.project;
          return done(true,
            '已打开：' + p.name + '（' + p.device + ' · ' + p.summary + '）',
            { project: p, diagnostics: r.body.diagnostics || [], candidates: cap(r.body.candidates, 20) });
        }

        case 'scan': {
          if (!a.dir) throw new Error('scan 需要 dir');
          const r = await json('POST', '/api/keil/scan', { dir: a.dir }, 60000, signal);
          if (!r.body.ok) return done(false, '扫描失败：' + r.body.error, { status: r.status });
          const c = cap(r.body.projects, 30);
          return done(true, '在 ' + r.body.dir + ' 找到 ' + c.total + ' 个工程。', { dir: r.body.dir, projects: c.rows, total: c.total });
        }

        case 'files': {
          const r = await json('GET', '/api/keil/src/list', null, 60000, signal);
          if (!r.body.ok) return done(false, '读取失败：' + r.body.error, { status: r.status });
          const gbk = r.body.files.filter((f) => f.encoding === 'gbk');
          const missing = r.body.files.filter((f) => !f.exists);
          return done(true,
            '工程 ' + r.body.project + ' 共 ' + r.body.count + ' 个源文件，其中 GBK 编码 ' + gbk.length +
            ' 个' + (missing.length ? '，磁盘上缺失 ' + missing.length + ' 个' : '') + '。',
            { project: r.body.project, dir: r.body.dir, files: r.body.files, gbkCount: gbk.length, missing: missing.map((f) => f.rel) });
        }

        case 'read': {
          if (!a.path) throw new Error('read 需要 path（工程内的相对路径，如 .\\User\\main.c）');
          const r = await json('GET', '/api/keil/src/read?path=' + encodeURIComponent(a.path), null, 60000, signal);
          if (!r.body.ok) return done(false, '读取失败：' + r.body.error, { status: r.status });
          /* 分段返回：整文件直接塞进模型可见内容，会把自己送进 tool-result-pruner 的名单，
             而裁剪器是**就地改写旧消息**的 —— 那会让模型侧的 KV 缓存整段失效。
             注意：切片必须**保住原来的行尾**（CRLF/LF/CR）。
             2026-10-14 实测踩到：用 split(/\r?\n/).join('\n') 会把整个 CRLF 工程悄悄改成 LF，
             42 行的文件少 41 字节 —— 「读一段再写回」直接毁掉用户的换行符。 */
          const all = String(r.body.text == null ? '' : r.body.text);
          const parts = all.split(/\r\n|\n|\r/);
          const seps = all.match(/\r\n|\n|\r/g) || [];
          const total = parts.length;
          const from = Math.min(Math.max(1, Number(a.offset) || 1), Math.max(1, total));
          const want = Math.min(2000, Math.max(1, Number(a.limit) || DEFAULT_READ_LINES));
          const to = Math.min(total, from + want - 1);
          let text = '';
          for (let i = from - 1; i < to; i++) {
            text += parts[i];
            if (seps[i] !== undefined) text += seps[i];
          }
          const more = to < total;
          return done(true,
            r.body.rel + '（' + r.body.encoding + '，共 ' + total + ' 行，' + r.body.bytes + ' 字节）' +
            (from === 1 && !more ? '：全文' : '：返回第 ' + from + '–' + to + ' 行' +
              (more ? '，还有 ' + (total - to) + ' 行；用 offset=' + (to + 1) + ' 继续读' : '')),
            {
              rel: r.body.rel, encoding: r.body.encoding, hadBom: r.body.hadBom, mtime: r.body.mtime,
              totalLines: total, from, to, truncated: more || from > 1,
              text,
            });
        }

        case 'write': {
          if (!a.path) throw new Error('write 需要 path');
          if (typeof a.content !== 'string') throw new Error('write 需要 content（完整文本）');
          const body = { path: a.path, content: a.content };
          if (a.expectMtime !== undefined) body.expectMtime = a.expectMtime;
          if (a.encoding !== undefined) body.encoding = a.encoding;
          const r = await json('POST', '/api/keil/src/write', body, 120000, signal);
          if (!r.body.ok) {
            return done(false,
              (r.body.code === 'STALE' ? '拒绝写入（文件已被改动）：' : '写入失败：') + r.body.error,
              /* currentMtime 只有 STALE 响应里才有；其它失败（文件不存在/越界/转码失败）
                 必须给 null —— 以前这里直接塞 undefined，DSH 会把整条结果判成
                 「value is not lossless JSON」，真正的错误信息被吞掉（2026-10-18 修复）。 */
              { status: r.status, code: r.body.code || null, currentMtime: r.body.currentMtime ?? null });
          }
          if (!r.body.changed) {
            return done(true, r.body.rel + ' 内容没变化，未写入。',
              { changed: false, created: false, rel: r.body.rel, hadBom: r.body.hadBom });
          }
          /* BOM 是硬约束：含中文的 .c 丢了 BOM，armcc 会编出乱码（用户问题记录第 9 条）。
             后端已经保证「原本有就还有」，这里把结论和警告如实带出来。 */
          const bomNote = r.body.bomBefore && !r.body.hadBom
            ? '　⚠ **原文件的 UTF-8 BOM 丢了** —— armcc 可能因此编出乱码，请立刻用 read 检查前几个字节。'
            : (r.body.bomBefore ? '　BOM 已保留。' : '');
          return done(true,
            (r.body.created ? '已新建 ' : '已写入 ') + r.body.rel + '（' + r.body.encoding + '，' +
            r.body.bytes + ' 字节，' + r.body.lines + ' 行）；' +
            (r.body.created ? '新文件，没有原件可备份' : '原件备份在 ' + r.body.backup) + bomNote +
            (r.body.warning ? '　⚠ ' + r.body.warning : ''),
            {
              changed: true, created: !!r.body.created, rel: r.body.rel, encoding: r.body.encoding,
              mtime: r.body.mtime, backup: r.body.backup || null,
              hadBom: !!r.body.hadBom, bomBefore: !!r.body.bomBefore,
              bomKept: r.body.bomKept !== false, warning: r.body.warning || null,
            });
        }

        case 'build': {
          const { final, lines } = await stream('/api/keil/build', a.path ? { path: a.path } : {}, 600000, signal);
          if (final.error) return done(false, '构建失败：' + final.error, { stage: final.stage || null });
          const diags = Array.isArray(final.diagnostics) ? final.diagnostics : [];
          const errs = diags.filter((d) => d.level === 'error');
          const warns = diags.filter((d) => d.level === 'warning');
          /* 构建成功后**再拉一次 /keil/size**：和界面走同一条路，不依赖 end 事件里那个大 map */
          let size = null;
          if (final.ok) {
            try { size = (await json('GET', '/api/keil/size', null, 60000, signal)).body; } catch (_) { /* 拿不到不影响构建结论 */ }
          }
          const ps = (size && size.programSize) || final.programSize || null;
          const e = cap(errs, 50);
          const w = cap(warns, 50);
          let summary;
          if (final.ok) {
            summary = '构建成功' + (ps ? '：Code=' + ps.code + ' RO=' + ps.rodata + ' RW=' + ps.rwdata +
              ' ZI=' + ps.zidata + '，Flash ' + ps.flashBytes + '/' + (ps.flashKB * 1024) +
              ' B（' + (ps.flashBytes / (ps.flashKB * 1024) * 100).toFixed(1) + '%）' : '') +
              '，警告 ' + w.total + ' 条。' +
              (w.total ? '首条：' + fmtDiag(w.rows[0]) : '');
          } else {
            summary = '构建失败（阶段 ' + (final.stage || '?') + '）：' + e.total + ' 个错误、' + w.total + ' 个警告。' +
              (e.total ? '首条：' + fmtDiag(e.rows[0]) : '');
          }
          return done(!!final.ok, summary, {
            stage: final.stage || null,
            programSize: ps,
            artifact: final.artifact || (size && size.artifact) || null,
            outDir: final.outDir || null,
            errors: e.rows, errorCount: e.total, errorsOmitted: e.omitted,
            warnings: w.rows, warningCount: w.total, warningsOmitted: w.omitted,
            failedFiles: final.failedFiles || [],
            logTail: lines.slice(-15).map((l) => l.text),
          });
        }

        case 'flash': {
          const { final, lines } = await stream('/api/keil/flash', { verify: a.verify !== false }, 600000, signal);
          if (final.error) return done(false, '烧录失败：' + final.error, {});
          const ok = !!final.ok;
          return done(ok,
            (ok ? '烧录完成' : '烧录未确认成功') + (final.verified ? '，回读校验通过' : '') +
            '；产物 ' + String(final.hex || '').split(/[\\/]/).pop() +
            (final.reason ? '（' + final.reason + '）' : ''),
            { verified: !!final.verified, hex: final.hex || null, reason: final.reason || null, logTail: lines.slice(-15).map((l) => l.text) });
        }

        case 'size': {
          const r = await json('GET', '/api/keil/size', null, 60000, signal);
          const b = r.body || {};
          if (!b.has) return done(true, '还没有构建记录——先 build 一次。', { has: false });
          const ps = b.programSize || null;
          const map = b.map || {};
          /* 字段名以 mapfile.js 为准：对象是 .flash（= code+roData+rwData），不是 .size；
             文件排行取 userObjects（和界面「你的文件按 Flash 占用排」用的是同一份数据）。 */
          const userObjs = cap(map.userObjects || map.objects, 25);
          const libObjs = cap(map.libObjects, 15);
          const fns = cap(map.functions, 25);
          const diags = Array.isArray(b.diagnostics) ? b.diagnostics : [];
          const warns = cap(diags.filter((d) => d.level === 'warning'), 50);
          const top = userObjs.rows[0];
          const topFn = fns.rows[0];
          return done(true,
            (ps ? 'Flash ' + ps.flashBytes + '/' + (ps.flashKB * 1024) + ' B（' +
              (ps.flashBytes / (ps.flashKB * 1024) * 100).toFixed(1) + '%），SRAM ' +
              ps.ramBytes + '/' + (ps.ramKB * 1024) + ' B；' : '') +
            (map.user ? '你的代码 ' + map.user.flash + ' B vs C 库/启动 ' + map.library.flash + ' B；' : '') +
            '最大文件 ' + (top ? (top.source || top.name) + ' ' + top.flash + ' B' : '—') +
            '；最大函数 ' + (topFn ? topFn.name + ' ' + topFn.size + ' B' : '—') +
            '；警告 ' + warns.total + ' 条。',
            {
              programSize: ps,
              userObjects: userObjs.rows, libObjects: libObjs.rows, functions: fns.rows,
              user: map.user || null, library: map.library || null, totals: map.totals || null,
              regions: map.regions || [],
              warnings: warns.rows, warningCount: warns.total,
              builtAt: b.builtAt, project: b.project, artifact: b.artifact || null,
            });
        }

        case 'pins': {
          const r = await json('GET', '/api/keil/pins', null, 120000, signal);
          const b = r.body || {};
          if (b.error) return done(false, '解析引脚失败：' + b.error, {});
          const conflicts = b.conflicts || [];
          const reconfigs = b.reconfigs || [];
          const pins = cap(b.pins, 60);
          const danger = conflicts.filter((c) => c.severity === 'danger');
          return done(true,
            '解析出 ' + pins.total + ' 个引脚；冲突 ' + conflicts.length +
            ' 处（其中严重 ' + danger.length + ' 处），良性重配 ' + reconfigs.length + ' 处。' +
            (danger.length ? '严重冲突：' + (danger[0].pin || '') + ' ' + (danger[0].reason || danger[0].message || '') : ''),
            { pins: pins.rows, conflicts, reconfigs, orderSource: b.orderSource || null, clock: b.clock || null });
        }

        case 'regs': {
          const body = a.hseHz ? { hseHz: a.hseHz } : {};
          const r = await json('POST', '/api/keil/registers', body, 120000, signal);
          const b = r.body || {};
          if (b.error) return done(false, '读寄存器失败：' + b.error, {});
          const cmp = b.compare || {};
          const keep = cmp.keep || cmp.matches || [];
          const diff = cmp.differences || cmp.diff || [];
          const clock = b.clock || {};
          return done(true,
            (clock.sysclkHz ? 'SYSCLK ' + (clock.sysclkHz / 1e6).toFixed(1) + ' MHz（' + clock.source + '）；' : '') +
            '与源码对照：一致 ' + (cmp.comparable || 0) + ' 项，差异 ' + (Array.isArray(diff) ? diff.length : 0) + ' 项' +
            (Array.isArray(diff) && diff.length ? '（首项 ' + (diff[0].pin || diff[0].name || '') + '：' + (diff[0].status || '') + '）' : ''),
            { clock, gpio: b.gpio || null, peripherals: b.peripherals || null, compare: cmp, matched: Array.isArray(keep) ? keep.length : 0 });
        }

        case 'chip': {
          /* chip-info 是 NDJSON 流，不是普通 JSON —— 用 json() 会拿整段响应体去 JSON.parse，
             必然抛「后端返回的不是 JSON」。所以 chip/reset 必须走 stream()。
             （2026-10-14 报告：这两个 action 100% 失败，与板子在不在无关。） */
          const { final, lines } = await stream('/api/chip-info', {}, 90000, signal);
          const tail = { logTail: lines.slice(-12).map((l) => l.text) };
          if (final.error) return done(false, '探测失败：' + final.error, tail);
          if (final.ok === false || final.connected === false) {
            /* reason 由 openocd.js 给出，本身已是完整且**区分原因**的句子：
               「没找到 ST-Link 或目标芯片…」 vs 「OpenOCD 报错：<真实错误>」。
               这里不要再套一层「未检测到 ST-Link」—— 那会把
               「ST-Link 在、但读不到目标芯片」误报成「没插 ST-Link」，
               让人去查 USB 线，而真正的问题在别处。（2026-10-14 实测踩到。） */
            return done(false, final.reason || '探测失败（OpenOCD 没给出原因）',
              Object.assign({ connected: !!final.connected }, tail));
          }
          const c = final.chip || {};
          /* 字段名以 openocd.js 的 parseChipInfo 为准：是 flashKB，不是 flashSizeKB。
             （2026-10-14：以前读错字段，Flash 容量从来没显示出来过。） */
          return done(true,
            'ST-Link 与芯片连通：' + (c.deviceId ? 'DEVICE_ID=' + c.deviceId : '未取到 DEVICE_ID') +
            (c.flashKB ? '，Flash ' + c.flashKB + ' KB' : '') +
            (c.core ? '，' + c.core : '') +
            (c.stlinkHardware ? '，ST-Link 硬件 ' + c.stlinkHardware : ''),
            Object.assign({ connected: true, chip: c }, tail));
        }

        case 'reset': {
          /* 同样是 NDJSON 流。reset 只复位芯片，不改 Flash，是安全的动作。 */
          const { final, lines } = await stream('/api/reset', {}, 60000, signal);
          const tail = { logTail: lines.slice(-12).map((l) => l.text) };
          if (final.error) return done(false, '复位失败：' + final.error, tail);
          return done(!!final.ok,
            final.ok ? '已复位目标芯片（reset run）：芯片复位后**开始运行**（不是停在复位状态）。'
              : '复位未确认成功：' + (final.reason || '未知原因'),
            Object.assign({ reason: final.reason || null }, tail));
        }

        /* ── 符号表（用户问题记录第 3 条）──
         * 变量地址不该靠「读链接器段列表 + 手动算偏移」得到：给 UI 加个 animHold，
         * reqDirty 的偏移就从 +0D 变成 +0E，硬编码的脚本当场失效。这里直接从 .axf 回答。 */
        case 'symbols': {
          const q = [];
          if (a.filter) q.push('filter=' + encodeURIComponent(String(a.filter)));
          if (a.limit !== undefined) q.push('limit=' + encodeURIComponent(String(Math.max(1, Math.min(2000, Number(a.limit) || 200)))));
          const r = await json('GET', '/api/keil/symbols' + (q.length ? '?' + q.join('&') : ''), null, 90000, signal);
          const b = r.body || {};
          if (!b.ok) return done(false, '读取符号表失败：' + b.error, { status: r.status });
          const rows = Array.isArray(b.symbols) ? b.symbols : [];
          const first = rows[0];
          return done(true,
            '从 ' + path.basename(String(b.axf || 'Project.axf')) + ' 解析出 ' + b.total + ' 个符号' +
            (a.filter ? '，匹配 "' + a.filter + '" 的 ' + b.matched + ' 个' : '，本次返回 ' + rows.length + ' 个') +
            (first ? '；首个 ' + first.name + ' ' + first.addr + (first.size ? '（' + first.size + ' B）' : '') : '') +
            (b.omitted ? '（另有 ' + b.omitted + ' 个未显示，缩小 filter 或加大 limit）' : '') +
            (b.cached ? '　（缓存）' : ''),
            {
              axf: b.axf, total: b.total, matched: b.matched, omitted: b.omitted || 0,
              symbols: rows, cached: !!b.cached,
              note: '变量/函数地址可以直接填进 readmem 的 addr；符号大小来自 ELF 符号表。',
            });
        }

        /* ── 读内存（用户问题记录第 1 条）──
         * 以前只能自己拼 OpenOCD：init 会 halt、shutdown 之后经常停在 halt，屏幕就不动了。
         * 后端现在用 init → mdw → exit，**不 halt**，读完即退出，目标保持原运行状态。 */
        case 'readmem': {
          if (a.addr === undefined || a.addr === null || String(a.addr).trim() === '') {
            throw new Error('readmem 需要 addr（十六进制地址 0x20000000，或符号名如 shadow；符号名需要先 build 过）');
          }
          const body = { addr: String(a.addr).trim() };
          if (a.length !== undefined) body.length = Number(a.length);
          const r = await json('POST', '/api/keil/readmem', body, 120000, signal);
          const b = r.body || {};
          if (!b.ok) return done(false, '读内存失败：' + b.error, { status: r.status });
          const hex = String(b.hex || '');
          return done(true,
            '读取 ' + b.length + ' B @ ' + b.addrHex +
            (b.symbol ? '（符号 ' + b.symbol.name + '，' + b.symbol.size + ' B）' : '') +
            '：' + (hex.length > 96 ? hex.slice(0, 96) + '…' : hex) +
            (b.timeout ? '　⚠ OpenOCD 超时过，数据可能不完整' : '') +
            '　（不 halt，目标保持运行）',
            {
              addr: b.addrHex, length: b.length, symbol: b.symbol || null,
              hex, words: b.words || [], bytes: b.bytes || [],
              rel: '内存 ' + b.addrHex, encoding: 'hex',
              lines: Array.isArray(b.words) ? b.words.length : 0, linesUnit: ' 个字',
              text: b.dump || '',
            });
        }

        /* ── 显存 → 指纹/差异/ASCII（用户问题记录第 13 条）──
         * 默认只回指纹与基线差异：模型做「屏幕变没变」验证时不必拉 8 KB ASCII。 */
        case 'gfx': {
          const body = {};
          if (a.addr !== undefined && a.addr !== null && String(a.addr).trim() !== '') body.addr = String(a.addr).trim();
          if (a.invert !== undefined) body.invert = a.invert === true;
          if (a.mode) body.mode = a.mode;
          if (a.region !== undefined) body.region = a.region;
          if (a.baseline) body.baseline = a.baseline;
          const r = await json('POST', '/api/keil/gfx', body, 120000, signal);
          const b = r.body || {};
          if (!b.ok) return done(false, '读屏幕失败：' + b.error, { status: r.status });
          let head = '屏幕 ' + b.width + '×' + b.height + ' @ ' + b.addrHex +
            (b.symbol ? '（' + b.symbol.name + '）' : '') + '；hash ' + b.hash + '；' +
            (b.blank ? '显存全 0（屏幕可能是灭的/固件没在跑）' : '点亮 ' + b.litPixels + ' 像素');
          if (b.diff) {
            head += b.diff.changedPixels
              ? '；与基线差异 ' + b.diff.changedPixels + ' 像素，区域 ' + b.diff.bbox.x0 + ',' + b.diff.bbox.y0 + '→' + b.diff.bbox.x1 + ',' + b.diff.bbox.y1
              : '；与基线完全一致';
          }
          if (b.baseline && b.baseline.saved) head += '；基线已保存';
          if (b.ascii) head += '；ASCII ' + b.asciiRegion.width + '×' + b.asciiRegion.height;
          const data = {
            addr: b.addrHex, width: b.width, height: b.height, invert: !!b.invert, hash: b.hash,
            litPixels: b.litPixels, blank: !!b.blank, diff: b.diff || null, baseline: b.baseline || null,
            file: b.file || null, symbol: b.symbol || null,
          };
          if (b.ascii) {
            data.rel = '屏幕 ' + b.width + '×' + b.height + '（# 点亮 / . 熄灭）';
            data.encoding = 'ascii';
            data.lines = b.asciiRegion.height;
            data.linesUnit = ' 行';
            data.text = b.ascii;
          }
          return done(true, head, data);
        }

        /* ── 单会话采样（看节拍/周期）── */
        case 'watch': {
          if (!a.addr) throw new Error('watch 需要 addr（0x40000024 或符号名）');
          const body = { addr: String(a.addr).trim() };
          if (a.samples !== undefined) body.samples = Number(a.samples);
          if (a.intervalMs !== undefined) body.intervalMs = Number(a.intervalMs);
          const r = await json('POST', '/api/keil/watch', body, 240000, signal);
          const b = r.body || {};
          if (!b.ok) return done(false, '采样失败：' + b.error, { status: r.status });
          const per = b.samples ? Math.round(b.elapsedMs / b.samples) : '?';
          return done(true,
            '采样 ' + b.samples + ' 次 @ ' + b.addrHex + (b.symbol ? '（' + b.symbol.name + '）' : '') +
            '：first=' + b.first + ' last=' + b.last + ' min=' + b.min + ' max=' + b.max +
            ' changes=' + b.changes + '（' + b.elapsedMs + ' ms，约 ' + per + ' ms/点）',
            {
              addr: b.addrHex, symbol: b.symbol || null, samples: b.samples, intervalMs: b.intervalMs,
              elapsedMs: b.elapsedMs, values: b.values, min: b.min, max: b.max,
              changes: b.changes, first: b.first, last: b.last,
              rel: '采样值（序号 / hex / decimal）', encoding: 'decimal',
              lines: b.samples, linesUnit: ' 个样本',
              text: (b.values || []).map((v, i) => String(i).padStart(3) + '  0x' + (v >>> 0).toString(16).padStart(8, '0') + '  ' + v).join('\n'),
            });
        }

        /* ── 功能契约 ──
         * 不带 content：读回「这块板子现在能干什么」的结构化描述。
         * 带 content：把模型写的模块化描述存进去（面板会立刻显示出来，用户直接改）。
         *
         * 为什么必须有这一步：用户不看代码。代码改完而描述没更新，面板上就是**假话**，
         * 用户会照着旧描述做决定。所以「改代码 → 改描述」在契约上是一次原子动作。
         *
         * data 里给的是**紧凑清单**（outline），正文走 data.text —— 两边都放一遍
         * 只会把工具结果撑大一倍，而工具结果越大越容易被 DSH 的裁剪器盯上。 */
        case 'spec': {
          const raw = a.content == null ? '' : String(a.content).trim();
          if (!raw) {
            const r = await json('GET', '/api/features', null, 30000, signal);
            const b = r.body || {};
            if (!b.ok) return done(false, '读功能描述失败：' + (b.error || ('HTTP ' + r.status)), { status: r.status });
            const st = b.stale || {};
            const n = (b.spec && b.spec.modules ? b.spec.modules.length : 0);
            const head = !b.has || !n
              ? '这个工程还没有功能描述 —— 请读源码后按功能模块写一份（字段见工具说明），再调 spec 保存。'
              : '当前功能描述：' + n + ' 个模块，r' + ((b.spec && b.spec.revision) || 0) +
                '，' + (b.spec && b.spec.updatedAt ? b.spec.updatedAt : '?') +
                (st.state === 'stale'
                  ? '。⚠ **已过期**：描述之后又有 ' + st.changedFiles + ' 个源文件被改过（最近 ' +
                    st.newestFile + '），请立刻用 spec 重写。'
                  : st.state === 'ok' ? '。与代码同步。' : '。');
            return done(true, head, {
              has: !!b.has, broken: !!b.broken, error: b.error || null,
              project: b.project, path: b.path, stale: st,
              revision: (b.spec && b.spec.revision) || 0,
              modules: b.outline || [],
              text: b.markdown || '', rel: '功能描述 features.json',
              encoding: 'markdown', lines: n, linesUnit: ' 个模块',
            });
          }

          let parsed;
          try {
            // 模型很爱把 JSON 包在 ```json 里 —— 忍了，剥掉再解析
            const cleaned = raw.replace(/^```[A-Za-z]*\s*/, '').replace(/```\s*$/, '').trim();
            parsed = JSON.parse(cleaned);
          } catch (err) {
            return done(false,
              'content 不是合法 JSON：' + String(err.message || err) +
              '　需要的形状：{"modules":[{"id":"pages","name":"五页仪表盘","status":"done",' +
              '"summary":"一句话（≤40 字）","trigger":"何时发生","behavior":["能看到什么"],' +
              '"hardware":["引脚与外设"],"params":["关键数值 带单位"],"limits":["限制与注意"],' +
              '"files":[".\\\\User\\\\UI.c"]}]}',
              { got: raw.slice(0, 400) });
          }
          const isPatch = parsed && !Array.isArray(parsed) && !parsed.modules && (parsed.updates || parsed.remove);
          const payload = isPatch
            ? { updates: parsed.updates || [], remove: parsed.remove || [] }
            : { modules: parsed };
          const r = await json('POST', '/api/features', Object.assign(payload, { by: 'ai' }), 30000, signal);
          const b = r.body || {};
          if (!b.ok) {
            return done(false, '保存功能描述失败：' + (b.error || ('HTTP ' + r.status)), { status: r.status });
          }
          const n = (b.spec && b.spec.modules ? b.spec.modules.length : 0);
          const st = b.stale || {};
          return done(true,
            '功能描述已' + (isPatch ? '增量更新' : '保存') + '：' + n + ' 个模块，r' + ((b.spec && b.spec.revision) || 0) +
            (b.changed === false ? '（内容没变，没有新增版本）' : '') +
            '。面板上现在显示的就是这份，用户可以直接改。' +
            (st.state === 'stale' ? ' ⚠ 但描述时间仍早于最新源码（' + st.changedFiles + ' 个文件），检查一下是不是漏写了。' : ''),
            {
              saved: true, changed: b.changed !== false, revision: (b.spec && b.spec.revision) || 0,
              path: b.path, project: b.project, stale: st,
              modules: b.outline || [],
              text: b.markdown || '', rel: '功能描述 features.json',
              encoding: 'markdown', lines: n, linesUnit: ' 个模块',
            });
        }

        default:
          throw new Error('未实现的 action：' + action);
      }
    },
  };
}

/* ───────────────────────── 后端进程与同源路由 ───────────────────────── */

/**
 * 本插件代码所在目录（DSH 实际加载 index.js 的地方）。
 *
 * **必须用 fileURLToPath，不能用 `new URL(...).pathname`** —— 后者会把空格编码成 %20、
 * 中文也会被百分号编码，于是路径根本不存在。实测踩到：
 * `/mcu/state` 报的 codeDir 是 `D:/AI%20workspace/stm32-workbench`，
 * 导致「插件自己那份 backend」这条候选永远命中不了，后端总是从本地插件副本启动，
 * 还把 splitCodeBackend 误报成 true。
 */
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));

/**
 * 依次尝试：显式配置 → 本插件旁的 backend/ → DSH 本地插件目录下的同名副本。
 *
 * **顺序是有意这样排的**：把自己那一份放前面，插件就是自包含的 —— 拷到别的机器照样跑。
 * 第三候选（`~/.dsh/local-plugins/stm32-workbench/backend`）只是**便携副本**的兜底：
 * 它不被 profile 加载（profile 通过 node_modules 符号链接直接加载本目录），
 * 只有「自己那份 backend 丢了」时才会用到。不要把它当成运行期必须同步的第二份代码 ——
 * 历史上就是因为误以为「代码在 D 盘、后端在 local-plugins」而白查过一轮
 * 「界面是新的、后端是旧的」。（那个说法来自旧版 `config.backendDir` 配置，现已留空。）
 */
function resolveBackendDir(configured) {
  const candidates = [];
  if (configured) candidates.push(configured);
  candidates.push(path.join(SELF_DIR, 'backend'));
  const dshHome = process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh');
  candidates.push(path.join(dshHome, 'local-plugins', 'stm32-workbench', 'backend'));
  for (const dir of candidates) {
    try {
      if (dir && fs.existsSync(path.join(dir, 'server', 'server.js'))) return dir;
    } catch (_) { /* 继续找 */ }
  }
  return null;
}

/**
 * 代码目录与后端目录是不是同一份？
 *
 * 正常情况下**是同一份**：`config.backendDir` 留空 → 后端就取自 `index.js` 旁边的 `backend/`
 * （实测 /mcu/state 的 codeDir == backendDir、splitCodeBackend=false）。
 * 只有用户显式把 `config.backendDir` 指到别处时才会是两份 —— 这种情况下需要自己保证同步。
 * 这里算出来摆到 /mcu/state 上，让「界面新、后端旧」这种不指向根因的问题一眼可见。
 */
function installSplit(backendDir) {
  if (!backendDir) return { split: false, codeDir: SELF_DIR, backendDir: null };
  return {
    split: path.resolve(backendDir) !== path.resolve(path.join(SELF_DIR, 'backend')),
    codeDir: SELF_DIR,
    backendDir,
  };
}

/**
 * 探测某个端口上是不是「本插件自己的后端」。
 *
 * 为什么要这一步：DSH 崩溃、热重启、或插件重载之后，上一次 spawn 的后端可能还活着，
 * 却已经不在当前模块的 `child` 变量里了。此时无脑 spawn 会 EADDRINUSE，
 * 用户看到「后端启动失败」，而真相是「后端其实一直好好跑着」。
 * 认领依据是 /api/ping 的 name 字段（2026-10-18 新增；旧版后端没有该端点，探测自然失败）。
 */
function probeBackend(port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/ping', method: 'GET', timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let body = null;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { /* 不是 JSON */ }
        if (res.statusCode === 200 && body && body.name === 'stm32-workbench-backend') {
          resolve({ ok: true, pid: body.pid || null, cwd: body.cwd || null, startedAt: body.startedAt || null });
        } else {
          resolve({ ok: false, reason: '端口上不是本插件的后端（HTTP ' + res.statusCode + '）' });
        }
      });
    });
    req.on('error', (err) => resolve({ ok: false, reason: String((err && err.message) || err) }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, reason: '探测超时' }); });
    req.end();
  });
}

/**
 * 健康检查**不能**再用 /api/env。
 *
 * /api/env 要枚举串口，在 Windows 上会起一个 powershell.exe（实测 ~2 s）；
 * 健康检查只给每次请求 1.5 s，于是每一次都超时，20 s 后报「后端启动超时」——
 * 而后端其实早就起来了。这个误判在 DSH 0.2.1 下 100% 复现（2026-10-18 实测）。
 * 现在打专用的 /api/ping：不碰磁盘、不起子进程，毫秒级返回。
 */
function waitForHealth(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const retry = () => {
      if (Date.now() > deadline) {
        reject(new Error('后端 ' + Math.round(timeoutMs / 1000) + ' 秒内没有通过健康检查（/api/ping）'));
        return;
      }
      setTimeout(attempt, 350);
    };
    const attempt = () => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/ping', method: 'GET', timeout: 3000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve(true); else retry();
      });
      req.on('error', retry);
      req.on('timeout', () => { req.destroy(); retry(); });
      req.end();
    };
    attempt();
  });
}

/** 从子进程 stdout 里认领真实端口（后端启动横幅带 `LISTEN http://127.0.0.1:<port>/`） */
function watchPort(child, fallbackPort, onPort) {
  let buf = '';
  let claimed = false;
  const claim = (p) => { if (!claimed && p > 0) { claimed = true; onPort(p); } };
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    if (claimed) return;
    const m = /LISTEN\s+http:\/\/127\.0\.0\.1:(\d+)/.exec(buf) || /http:\/\/127\.0\.0\.1:(\d+)/.exec(buf);
    if (m) claim(Number(m[1]));
  });
  if (fallbackPort > 0) setTimeout(() => claim(fallbackPort), 800);
}

export function apply(ctx, config = {}) {
  /* —— 1. 注册单片机模式 —— */
  ctx.inject(['agentPresets'], async function* (presetCtx) {
    if (typeof presetCtx.agentPresets?.register !== 'function') {
      ctx.logger?.warn?.('stm32-workbench: agentPresets.register 不可用，单片机模式未注册');
      return;
    }
    try {
      yield await presetCtx.agentPresets.register(PRESET_DEFINITION);
      ctx.logger?.info?.(`stm32-workbench: 已注册 Agent preset "${PRESET_ID}"（单片机模式）`);
    } catch (err) {
      ctx.logger?.warn?.(`stm32-workbench: 注册单片机模式失败（可能有同名 preset）：${String(err.message || err)}`);
    }
  });

  /* —— 2. 后端进程 —— */
  const configuredDir = String(config.backendDir || '').trim();
  /* 端口语义（2026-10-18 修正）：
       - 不写 / 写 0 → 让系统分配空闲端口（推荐：多实例、DSH 热重启都不会抢端口）
       - 写正数     → 固定端口；启动前会先复用同端口的旧后端（见 start()）
     以前这里有个 bug：wantedPort=0 时**没有**把 MCU_AGENT_PORT 传给后端，
     后端于是退回默认 8788 —— 配置里写的「0 = 系统分配」根本没生效，
     第二次 spawn 必然 EADDRINUSE。 */
  const rawPort = config.port === undefined || config.port === null || config.port === '' ? 0 : Number(config.port);
  const wantedPort = Number.isInteger(rawPort) && rawPort >= 0 ? rawPort : 0;
  const autoStart = config.autoStart !== false;
  /* DSH 启动期主线程很忙；延后一点再拉起后端，避免和启动期抢事件循环（以前 20 s 窗口会被吃光）。 */
  const autoStartDelayMs = Math.max(0, Number(config.autoStartDelayMs === undefined ? 1200 : config.autoStartDelayMs) || 0);

  let child = null;
  let childPort = 0;
  let childDir = null;
  let adopted = false;
  /** 最近一次解析到的后端目录（即使启动失败，/mcu/state 也要能报出来，方便排查） */
  let resolvedBackendDir = null;
  let starting = null;
  let lastError = null;

  async function start() {
    if (child && childPort) return { ok: true, port: childPort, dir: childDir };
    if (starting) return starting;
    starting = (async () => {
      const dir = resolveBackendDir(configuredDir);
      resolvedBackendDir = dir;
      if (!dir) {
        lastError = '没找到 MCU 后端目录（server/server.js）。请在插件 config.backendDir 指定。';
        throw new Error(lastError);
      }
      const split = installSplit(dir);
      if (split.split) {
        ctx.logger?.warn?.('stm32-workbench: config.backendDir 指向了另一份后端 —— 代码 ' + split.codeDir +
          '，后端 ' + dir + '。请自行保证两份一致，否则会出现「界面是新的、后端还是旧的」。');
      }
      /* 固定端口时先认领同端口的旧后端：DSH 崩溃/热重启/插件重载后，
         上一次 spawn 的后端常常还活着。直接 spawn 只会 EADDRINUSE，
         而用户看到的「后端启动失败」会把排查引向完全错误的方向。 */
      if (wantedPort > 0) {
        const found = await probeBackend(wantedPort);
        if (found.ok) {
          child = null; childPort = wantedPort; childDir = dir; adopted = true; lastError = null;
          ctx.logger?.warn?.('stm32-workbench: 端口 ' + wantedPort + ' 上已有本插件后端在运行（pid ' +
            found.pid + '），直接复用它');
          return { ok: true, port: wantedPort, dir, adopted: true };
        }
      }
      /* 总是把 MCU_AGENT_PORT 传给后端：0 是有效值（系统分配空闲端口）。
         以前只在 wantedPort > 0 时传，导致 config.port: 0 形同虚设、后端固定抢 8788。
         ELECTRON_RUN_AS_NODE=1 是加固：DSH 桌面版里 process.execPath 是 Electron 可执行文件，
         不带这个标记 spawn 出来的会是一个新桌面实例而不是 node 后端（不同 DSH 版本环境不同，
         显式带上无害且能保证行为一致；2026-10-18 由 dsh-compat 审计提出）。 */
      const env = { ...process.env, MCU_AGENT_PORT: String(wantedPort), ELECTRON_RUN_AS_NODE: '1' };
      const proc = spawn(process.execPath, [path.join('server', 'server.js')], {
        cwd: dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      child = proc; childDir = dir; adopted = false;
      /* 存住 stderr：后端启动失败时唯一有用的线索就在里面。
         以前只丢给 logger，界面看到的是「后端没有报告监听端口」——等于什么都没说，
         一次被截成 0 字节的 package.json 就能让人查半天。 */
      let stderrBuf = '';
      proc.on('exit', (code) => {
        ctx.logger?.warn?.(`stm32-workbench 后端退出，code=${code}` +
          (stderrBuf.trim() ? ' —— ' + stderrBuf.trim().slice(-500) : ''));
        if (child === proc) { child = null; childPort = 0; childDir = null; adopted = false; }
      });
      proc.stderr.on('data', (c) => {
        const t = c.toString('utf8');
        stderrBuf = (stderrBuf + t).slice(-4000);
        if (t.trim()) ctx.logger?.warn?.(`stm32-workbench 后端: ${t.trim()}`);
      });
      let port;
      try {
        port = await new Promise((resolve, reject) => {
          let settled = false;
          const fail = (why) => {
            if (settled) return;
            settled = true;
            reject(new Error(why + (stderrBuf.trim()
              ? '；后端 stderr：' + stderrBuf.trim().slice(-1200)
              : '；后端没有输出任何信息')));
          };
          /* 只等端口宣告，不要在超时里 kill —— 要不要杀掉由外层统一决定。
             以前这里 kill 了却不清 child 指针，留下一个「插件不知道」的半死状态。 */
          const timer = setTimeout(() => fail('后端 30 秒内没有报告监听端口'), 30000);
          // 进程提前死掉就立刻报错，不必干等
          proc.once('exit', (code) => { clearTimeout(timer); fail('后端进程启动后立即退出（退出码 ' + code + '）'); });
          watchPort(proc, wantedPort, (p) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(p);
          });
        });
      } catch (err) {
        const msg = String((err && err.message) || err) + ' ' + stderrBuf;
        /* 固定端口 + EADDRINUSE：先看是不是我们自己的后端；不是的话给一条能直接照做的错误。 */
        if (wantedPort > 0 && /EADDRINUSE|占用/.test(msg)) {
          const found = await probeBackend(wantedPort);
          if (found.ok) {
            stop();
            child = null; childPort = wantedPort; childDir = dir; adopted = true; lastError = null;
            ctx.logger?.warn?.('stm32-workbench: 端口 ' + wantedPort + ' 上的旧后端可用（pid ' +
              found.pid + '），已复用');
            return { ok: true, port: wantedPort, dir, adopted: true };
          }
          stop();
          lastError = '端口 ' + wantedPort + ' 已被其它进程占用（不是本插件的后端）';
          throw new Error(lastError +
            '。把插件 config.port 设为 0 让系统分配空闲端口（推荐），或先结束占用该端口的进程。');
        }
        stop();
        lastError = String((err && err.message) || err);
        throw err;
      }
      try {
        await waitForHealth(port);
      } catch (err) {
        /* 健康检查失败就把这次 spawn 的进程收掉。否则它会活着、占着端口，
           下一次 start() 再 spawn 就是 EADDRINUSE —— 这正是 2026-10-18 那次
           「后端启动超时 → 之后全部 EADDRINUSE」的死循环。 */
        stop();
        lastError = String((err && err.message) || err);
        throw err;
      }
      childPort = port; lastError = null;
      ctx.logger?.info?.(`stm32-workbench 后端就绪：127.0.0.1:${port}（${dir}）`);
      return { ok: true, port, dir, adopted: false };
    })();
    try { return await starting; } finally { starting = null; }
  }

  function stop() {
    const proc = child;
    child = null; childPort = 0; childDir = null; adopted = false;
    if (!proc) return;
    try { proc.kill(); } catch (_) { /* 已退出 */ }
  }

  /* —— 3. DSH 工具 ——
   * 界面走 HTTP，AI 走工具，两者最终都落到同一套 /api —— 这是这次要根治的病根。
   * 用 ctx.effect 管生命周期（和本文件其它注册一致，不依赖 inject 回调返回值的处理方式）。 */
  ctx.inject(['tools'], (toolCtx) => {
    if (!toolCtx.tools || typeof toolCtx.tools.register !== 'function') {
      ctx.logger?.warn?.('stm32-workbench: tools.register 不可用，mcu 工具未注册');
      return;
    }
    try {
      /* 归属上下文：注册在 tools 服务的 scope 上（service 重配导致回调重跑时，旧注册随 scope 一起撤销）。
         以前挂在插件根 ctx 上，重配时会对同一张路由表重复注册并抛错（DSH 0.2.1 规范 C5 项）。 */
      toolCtx.effect(() => toolCtx.tools.register(mcuToolDefinition(() => start())),
        'stm32-workbench: mcu tool');
      ctx.logger?.info?.('stm32-workbench: 已注册工具 "' + TOOL_NAME + '"');
    } catch (err) {
      ctx.logger?.warn?.('stm32-workbench: 注册 mcu 工具失败：' + String((err && err.message) || err));
    }
  });

  /* —— 4. 同源路由 —— */
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX + '/state',
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      const split = installSplit(configuredDir || childDir);
      res.end(JSON.stringify({
        ok: true, running: !!childPort, port: childPort, backendDir: childDir || resolvedBackendDir,
        configuredDir: configuredDir || null, presetId: PRESET_ID, error: lastError,
        // 复用了不是本进程 spawn 的旧后端（DSH 崩溃/热重启之后的常见状态）
        adopted, backendPid: child ? child.pid : null,
        // 代码目录 ≠ 后端目录时 splitCodeBackend 为 true：界面和 AI 可能在跑不同代际的代码
        codeDir: split.codeDir, splitCodeBackend: split.split,
      }));
    },
  }), 'stm32-workbench: state route');

  /**
   * 会话 → 它所属工作区的目录。
   *
   * 为什么需要这条路由：工作台要「跟着工作区切换工程」，就必须知道**当前会话的工作区路径**，
   * 而客户端这边 `uiWorkspace` / `workspaces` 都没有读接口、`sessions` 的会话快照里也没有路径。
   * 宿主有 `workspaceRegistry`，它的 `Workspace` 带 `path` 与 `sessionIds` —— 反查即可。
   * 这条对**已有会话**同样有效（只靠「插件建会话时记进 localStorage」那种快路径，
   * 插件出现之前建好的会话就永远查不到，实测就是这个原因导致自动切换不生效）。
   */
  ctx.inject(['workspaceRegistry'], (regCtx) => {
    /* 归属上下文：路由挂在 workspaceRegistry 的 scope 上，服务重配时旧注册随 scope 撤销（规范 C5 项）。 */
    regCtx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PREFIX + '/session-workspace',
      handler: (req, res) => {
        let sid = '';
        try { sid = new URL(req.url, 'http://127.0.0.1').searchParams.get('sessionId') || ''; } catch (_) { /* 留空 */ }
        let workspace = null;
        try {
          for (const w of regCtx.workspaceRegistry.list()) {
            const ids = Array.isArray(w.sessionIds) ? w.sessionIds : [];
            if (sid && ids.indexOf(sid) >= 0) {
              workspace = { id: w.id, path: w.path, title: w.title };
              break;
            }
          }
        } catch (err) {
          ctx.logger?.warn?.('stm32-workbench: 查会话工作区失败：' + String((err && err.message) || err));
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, sessionId: sid, workspace }));
      },
    }), 'stm32-workbench: session-workspace route');
  });

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PREFIX + '/start',
    handler: async (req, res) => {
      try {
        const r = await start();
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(r));
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: String(err.message || err) }));
      }
    },
  }), 'stm32-workbench: start route');

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE_PREFIX + '/stop',
    handler: (req, res) => {
      stop();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, running: false }));
    },
  }), 'stm32-workbench: stop route');

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (req, res) => {
      const strip = req.url.startsWith(ROUTE_PREFIX) ? req.url.slice(ROUTE_PREFIX.length) : req.url;
      const target = strip.startsWith('/') ? strip : '/' + strip;
      if (!childPort) {
        res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: lastError || '后端未启动' }));
        return;
      }
      const upstream = http.request({
        host: '127.0.0.1', port: childPort, path: target, method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${childPort}` },
      }, (up) => { res.writeHead(up.statusCode || 502, up.headers); up.pipe(res); });
      upstream.on('error', (err) => {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: '后端连接失败：' + String(err.message || err) }));
        } else res.end();
      });
      req.pipe(upstream);
    },
  }), 'stm32-workbench: api proxy');

  ctx.effect(() => () => stop(), 'stm32-workbench: backend lifetime');

  if (autoStart) {
    /* 别在 apply() 里同步抢跑：DSH 启动期主线程很忙，启动窗口容易被启动期负载吃光。
       延后 1.2 s（可配置）成本几乎为零。定时器必须由 ctx.effect 拥有 —— 插件卸载/热重载时
       要能取消，否则会在已卸载的实例上拉一个后端（规范 C14 项）。 */
    ctx.effect(() => {
      const timer = setTimeout(() => {
        start().catch((err) => {
          lastError = String(err.message || err);
          ctx.logger?.warn?.(`stm32-workbench 自动启动失败：${lastError}`);
        });
      }, autoStartDelayMs);
      if (timer.unref) timer.unref();
      return () => clearTimeout(timer);
    }, 'stm32-workbench: autostart');
  }

  ctx.logger?.info?.('stm32-workbench 宿主已挂载（preset + 路由 /mcu）');
}
