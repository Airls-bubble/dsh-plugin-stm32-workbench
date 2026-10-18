'use strict';
/**
 * symbols.js —— 从 Keil 构建出来的 .axf 里读符号表（fromelf --text -s）
 *
 * 为什么需要它：用户问题记录第 3 条 —— 「想知道 shadow / reqPage 在 RAM 里的地址，
 * 只能读链接器打印的段列表自己推」。给 UI 加一个 animHold，reqDirty 的偏移就从
 * +0D 变成 +0E，靠偏移硬编码的脚本当场失效。符号地址这种事应该由工具回答，不该靠猜。
 *
 * 另一个用途：readmem 允许把 addr 写成变量名（如 shadow），由这里解析成地址。
 *
 * fromelf 的输出格式（ARM Compiler 5.06）：
 *   Symbol table .symtab (656 symbols, 461 local)
 *     #  Symbol Name                Value      Bind  Sec  Type  Vis  Size
 *   ========================================================================
 *     227  shadow                     0x20000068   Lc    3  Data  De   0x400
 * 注意：Size 只在 Code/Data/Sect 行存在，File 行没有；单位是十六进制。
 */
const fs = require('fs');
const { spawn } = require('child_process');
const toolchain = require('./toolchain');

/** fromelf 符号表一行（宽松匹配：多列之间任意空白，Size 可选） */
const SYMBOL_LINE = /^\s*(\d+)\s+(\S+)\s+(0x[0-9a-fA-F]+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(0x[0-9a-fA-F]+|\d+))?\s*$/;

function parseSize(raw) {
  if (!raw) return 0;
  return raw.startsWith('0x') || raw.startsWith('0X') ? parseInt(raw, 16) : parseInt(raw, 10);
}

/** 只有序号 + 名字（fromelf 对超长符号名会折行，例如 Image$$RW_IRAM1$$ZI$$Length） */
const SYMBOL_NAME_ONLY = /^\s*(\d+)\s+(\S+)\s*$/;
/** 折行后的续行：只有值 + Bind/Sec/Type/Vis（+可选 Size） */
const SYMBOL_CONT = /^\s*(0x[0-9a-fA-F]+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(0x[0-9a-fA-F]+|\d+))?\s*$/;

/** 把 `fromelf --text -s` 的整段输出解析成符号数组（纯函数，方便单测） */
function parseFromelfSymbols(text) {
  const out = [];
  let inTable = false;
  let pending = null; // 折行的 {index, name}
  const push = (index, name, valueRaw, bind, section, type, visibility, sizeRaw) => {
    const value = parseInt(valueRaw, 16) >>> 0;
    out.push({
      index: Number(index),
      name,
      value,
      addr: '0x' + value.toString(16).padStart(8, '0'),
      bind, section, type, visibility,
      size: parseSize(sizeRaw),
    });
  };
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (/Symbol table\s+.*\.symtab/i.test(line)) { inTable = true; pending = null; continue; }
    if (!inTable) continue;
    if (!line.trim()) continue;
    if (/^=+$/.test(line.trim())) continue;
    if (/^\s*#\s+Symbol Name/.test(line)) continue;
    const m = SYMBOL_LINE.exec(line);
    if (m) { push(m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]); pending = null; continue; }
    const nameOnly = SYMBOL_NAME_ONLY.exec(line);
    if (nameOnly) { pending = { index: nameOnly[1], name: nameOnly[2] }; continue; }
    if (pending) {
      const cont = SYMBOL_CONT.exec(line);
      if (cont) {
        push(pending.index, pending.name, cont[1], cont[2], cont[3], cont[4], cont[5], cont[6]);
        pending = null;
        continue;
      }
    }
    pending = null;
  }
  return out;
}

function findFromelf() {
  const env = toolchain.detectEnv();
  const cc = (env.compilers || []).find((c) => c.usable && c.fromelf);
  if (!cc) throw new Error('没有找到 fromelf —— 需要 Keil MDK 的 ARM Compiler 5（可用 KEIL_ROOT 指定 Keil 根目录）');
  return cc.fromelf;
}

/**
 * 跑一次 fromelf，带超时与输出上限（fromelf 正常 1~2 s；卡死时别把请求拖死）。
 * 注意 fromelf 会把内容打到 stdout，stderr 一般只有许可证/错误信息。
 */
function runFromelf(args, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(findFromelf(), args, { windowsHide: true });
    } catch (err) {
      resolve({ code: -1, out: '', err: String((err && err.message) || err) });
      return;
    }
    let out = '';
    let err = '';
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, out, err, timeout: false });
    };
    const timer = setTimeout(() => {
      if (done) return;
      try { child.kill(); } catch (_) { /* 可能已退出 */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) { /* 已退出 */ } }, 1500).unref?.();
      done = true;
      resolve({ code: null, out, err, timeout: true });
    }, Math.max(1000, timeoutMs));
    child.stdout.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr.on('data', (b) => { err += b.toString('utf8'); });
    child.on('error', (e) => { err += String((e && e.message) || e); finish(-1); });
    child.on('close', (code) => finish(code));
  });
}

/* 符号表缓存：axf 路径 + mtime + size 作为键。同一次构建里 UI/模型可能查很多次。 */
const cache = new Map();

/**
 * 读 axf 符号表。
 * @param {string} axfPath .axf 绝对路径；文件必须存在（不存在就是「先 build」）
 * @returns {Promise<{symbols:Array, axf:string, cached:boolean}>}
 */
async function readSymbols(axfPath) {
  if (!axfPath || !fs.existsSync(axfPath)) {
    throw new Error('没有可解析的 .axf 产物：先 build 一次（产物路径：' + (axfPath || '未指定') + '）');
  }
  const st = fs.statSync(axfPath);
  const key = axfPath;
  const hit = cache.get(key);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
    return { symbols: hit.symbols, axf: axfPath, cached: true };
  }
  const r = await runFromelf(['--text', '-s', axfPath], 30000);
  if (r.timeout) throw new Error('fromelf 解析符号表超时（30 s）—— 产物可能损坏，重新 build 一次');
  const symbols = parseFromelfSymbols(r.out + '\n' + r.err);
  if (!symbols.length) {
    throw new Error('fromelf 没有解析出任何符号（退出码 ' + r.code + '）。' +
      (r.err.trim() ? 'stderr：' + r.err.trim().slice(0, 400) : ''));
  }
  cache.set(key, { mtimeMs: st.mtimeMs, size: st.size, symbols });
  return { symbols, axf: axfPath, cached: false };
}

/** 按名字找符号；exact=true 时只认完全同名（默认），否则包含匹配 */
function findSymbol(symbols, name, exact = true) {
  const n = String(name || '').trim();
  if (!n) return [];
  const lower = n.toLowerCase();
  const rows = (symbols || []).filter((s) => (exact ? s.name.toLowerCase() === lower : s.name.toLowerCase().includes(lower)));
  return rows;
}

/** 把符号名解析成地址；找不到或有歧义都抛明确错误，绝不猜一个地址 */
async function resolveSymbolAddress(axfPath, name) {
  const { symbols } = await readSymbols(axfPath);
  const exact = findSymbol(symbols, name, true);
  const picked = exact.length ? exact : findSymbol(symbols, name, false);
  if (!picked.length) {
    throw new Error('符号表里没有 "' + name + '"。可先用 action=symbols 查（例如 filter="' + name + '"）');
  }
  if (picked.length > 1) {
    const names = picked.slice(0, 6).map((s) => s.name + '@' + s.addr).join('、');
    throw new Error('"' + name + '" 匹配到 ' + picked.length + ' 个符号，请写更完整的名字：' + names);
  }
  const sym = picked[0];
  if (!sym.value) throw new Error('符号 "' + sym.name + '" 的地址是 0（Abs 段/未分配），不能用来读内存');
  return sym;
}

module.exports = {
  parseFromelfSymbols,
  readSymbols, findSymbol, resolveSymbolAddress,
  // 便于单测
  _parseSize: parseSize,
  _runFromelf: runFromelf,
};
