'use strict';
/**
 * diag.js —— 把 armcc / armasm / armlink 的输出解析成**结构化诊断**
 *
 * 之前 keil-build.js 只把失败的文件名塞进 errors（`{file: '..\\User\\main.c'}`），
 * 行号、错误码、错误原文全丢了 —— 编译失败时界面只有一串文件名，等于什么都没说。
 * 这个模块负责把真实输出里的 `文件, line N: error: #20: ...` 抠出来。
 *
 * 识别的形态（都来自实测输出）：
 *   "..\Hardware\OLED.c", line 123: error:  #20: identifier "x" is undefined
 *   "..\User\main.c", line 45: Warning:  #1-D: last line of file ends without a newline
 *   Error: #5: cannot open source input file "stm32f10x.h": No such file or directory
 *   .\Objects\Project.axf: Error: L6218E: Undefined symbol foo (referred from main.o).
 *   Error: L6218E: Undefined symbol foo
 *
 * 两条铁律：
 *   1. 解析不出来就返回 null，绝不编造行号 —— 宁可退化成一整行原文。
 *   2. level 只有 info/warning/error 三档，方便上层直接按严重度分组。
 */

/** 带文件与行号的编译器诊断；错误码保留 `-D` 之类的后缀（#177-D 是 armcc 的规范写法） */
const RE_CC = /^\s*"([^"]+)"\s*,\s*line\s+(\d+)(?:\s*[,(]\s*col\s*(\d+)\s*\)?)?\s*:\s*(fatal error|error|warning|remark|info)\s*:?\s*(#?\d+-?[A-Za-z]?)?\s*:?\s*(.*)$/i;
/** 不带文件/行号的编译器诊断（例如打不开头文件） */
const RE_CC_NOFILE = /^\s*(fatal error|error|warning|remark)\s*:?\s*(#?\d+-?[A-Za-z]?)?\s*:?\s*(.*)$/i;
/** 链接器诊断：可选 `文件: ` 前缀 + L#### 错误码 */
const RE_LINK = /^\s*(?:"([^"]+)"|([^\s:][^:]*?))?\s*:?\s*(Error|Warning|Fatal error)\s*:\s*([A-Z]\d+[A-Z]?)\s*:\s*(.*)$/i;
/** 链接器尾部统计：Finished: 0 information, 0 warning and 1 error messages.
 *  m 标志是必须的 —— 这一行在日志末尾，没有 m 的话 ^ 只匹配整个文本的开头。 */
const RE_FINISH = /^Finished:\s*(\d+)\s*information.*?(\d+)\s*warning.*?(\d+)\s*error/im;
/** armcc 常见被工具链自己吞掉的“提示”行，不该当成警告 */
const NOISE = /^(Copyright|ARM|Keil|Program Size|Image component sizes|Code \(inc\. data\)|RO Data|RW Data|ZI Data|Debug|Total RO|Total RW|Total ROM|=====|-----|\s*$)/i;
/** 每个文件编译完的汇总行，形如 `.\Hardware\x.c: 1 warning, 0 errors` —— 不是诊断，别当一条 */
const RE_SUMMARY = /\d+\s+warnings?\s*,\s*\d+\s+errors?/i;
/** 插件自己的工作台日志会把每行写成 `[tag] 原文`，解析前要脱掉这层壳 */
const RE_TAG = /^\[[a-z]+\]\s*/i;

/** 严重度归一化：armcc 的 'fatal error' 仍是 error，但记下 fatal 便于界面加重 */
function normLevel(word) {
  const w = String(word || '').toLowerCase();
  if (w.indexOf('fatal') >= 0) return 'error';
  if (w === 'error') return 'error';
  if (w === 'warning') return 'warning';
  if (w === 'remark' || w === 'info') return 'info';
  return 'info';
}

/**
 * 解析一行工具链输出。
 * @param {string} line 原始输出行
 * @param {object} [ctx] { tool, file } —— tool 形如 'armcc'/'armlink'；file 是当前正在编译的源文件（相对路径原文），
 *                       当输出行里没写文件名时用它兜底（armasm 有时不写）
 * @returns {object|null} { level, tool, file, line, col, code, message, raw, fatal }
 */
function parseLine(line, ctx) {
  const raw = String(line == null ? '' : line).replace(/\r$/, '');
  if (!raw.trim() || NOISE.test(raw) || RE_SUMMARY.test(raw)) return null;
  // 工作台落盘的日志每行都带 `[build] ` / `[phase] ` 前缀，脱掉再解析
  const body = raw.replace(RE_TAG, '');
  const tool = (ctx && ctx.tool) || 'tool';
  const fallbackFile = (ctx && ctx.file) || null;

  let m = RE_CC.exec(body);
  if (m) {
    return {
      level: normLevel(m[4]),
      fatal: /fatal/i.test(m[4]),
      tool,
      file: m[1],
      line: Number(m[2]),
      col: m[3] ? Number(m[3]) : null,
      code: m[5] ? m[5].replace(/^#/, '') : null,
      message: clean(m[6]),
      raw,
    };
  }

  m = RE_LINK.exec(body);
  if (m) {
    // RE_LINK 的第一个捕获可能是文件名，也可能为空
    const file = m[1] || m[2] || fallbackFile;
    return {
      level: normLevel(m[3]),
      fatal: /fatal/i.test(m[3]),
      tool: 'armlink',
      file: file && isPathLike(file) ? file : null,
      line: null,
      col: null,
      code: m[4],
      message: clean(m[5]),
      raw,
    };
  }

  m = RE_CC_NOFILE.exec(body);
  if (m) {
    return {
      level: normLevel(m[1]),
      fatal: /fatal/i.test(m[1]),
      tool,
      file: fallbackFile,
      line: null,
      col: null,
      code: m[2] ? m[2].replace(/^#/, '') : null,
      message: clean(m[3]),
      raw,
    };
  }

  return null;
}

function clean(s) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
}

/** 文件名长得像路径（含扩展名，或含目录分隔符）才认，避免把 “Finished” 之类当文件 */
function isPathLike(s) {
  return /[\\/]/.test(s) || /\.[A-Za-z0-9]{1,6}$/.test(s);
}

/** 解析整段输出，返回诊断数组（保持出现顺序） */
function parseOutput(text, ctx) {
  const out = [];
  String(text || '').split(/\r?\n/).forEach((l) => {
    const d = parseLine(l, ctx);
    if (d) out.push(d);
  });
  return out;
}

/** 从输出里读链接器尾部统计（用来交叉校验诊断条数是否对得上） */
function parseFinish(text) {
  const m = RE_FINISH.exec(String(text || ''));
  if (!m) return null;
  return { information: Number(m[1]), warnings: Number(m[2]), errors: Number(m[3]) };
}

/** 去重：同一条诊断可能被 armcc 在 stdout / stderr 各打一次 */
function dedupe(list) {
  const seen = new Set();
  const out = [];
  list.forEach((d) => {
    const key = [d.level, d.file, d.line, d.col, d.code, d.message].join('|');
    if (seen.has(key)) return;
    seen.add(key);
    out.push(d);
  });
  return out;
}

/** 人类可读的一行，界面/工具输出都用它，保证同一诊断两处长得一样 */
function format(d) {
  const loc = d.file ? (d.line ? d.file + ':' + d.line : d.file) : '(无文件)';
  const code = d.code ? ' #' + d.code : '';
  return loc + ' [' + d.level + ']' + code + ' ' + d.message;
}

/** 按文件分组的统计，给界面做“哪个文件错得最多” */
function byFile(list) {
  const m = new Map();
  list.forEach((d) => {
    const k = d.file || '(无文件)';
    if (!m.has(k)) m.set(k, { file: k, errors: 0, warnings: 0, infos: 0 });
    const row = m.get(k);
    if (d.level === 'error') row.errors++;
    else if (d.level === 'warning') row.warnings++;
    else row.infos++;
  });
  return Array.from(m.values()).sort((a, b) => (b.errors - a.errors) || (b.warnings - a.warnings));
}

module.exports = { parseLine, parseOutput, parseFinish, dedupe, format, byFile, normLevel };
