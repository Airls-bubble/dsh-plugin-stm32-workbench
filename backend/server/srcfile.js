'use strict';
/**
 * srcfile.js —— 编码感知的源码读写
 *
 * 现实问题：Keil 工程里的源码常常是 GBK(ANSI) 存盘的（中文注释在 Keil 里正常，
 * 但按 UTF-8 读会报 invalid UTF-8 或满屏乱码）。本模块负责识别真实编码并按它读写，
 * 绝不把用户的中文注释改成乱码。
 *
 * 读：Node 内置 TextDecoder 支持 gbk。
 * 写：Node 没有内置 GBK 编码器 —— 由 transcode.ps1 走 .NET 完成（见 writeText）。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PS1 = path.join(__dirname, '..', 'scripts', 'transcode.ps1');

/** 判断 Buffer 的实际编码 */
function detectEncoding(buf) {
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return 'utf8-bom';
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return 'utf16le';
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return 'utf16be';
  // 能在 UTF-8 下往返 → 是合法 UTF-8（纯 ASCII 也走这条路）
  if (Buffer.from(buf.toString('utf8'), 'utf8').equals(buf)) {
    return buf.some((b) => b > 0x7F) ? 'utf8' : 'ascii';
  }
  return 'gbk';
}

function decode(buf, enc) {
  if (enc === 'gbk') {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch (_) {
      return buf.toString('utf8'); // 环境没有 gbk 就退化为 utf8，至少不崩
    }
  }
  if (enc === 'utf16be') {
    // Node 的 'utf16le' 解不了 BE：交换字节再解
    const swapped = Buffer.from(buf);
    swapped.swap16();
    return swapped.toString('utf16le');
  }
  return buf.toString(enc === 'utf8-bom' ? 'utf8' : enc);
}

/**
 * 读文本文件，自动识别编码。
 * @returns {{text:string, encoding:string, bytes:number, hadBom:boolean, file:string}}
 */
function readText(file) {
  const buf = fs.readFileSync(file);
  const enc = detectEncoding(buf);
  let text = decode(buf, enc);
  const hadBom = text.charCodeAt(0) === 0xFEFF;
  if (hadBom) text = text.slice(1);
  return { text, encoding: enc, bytes: buf.length, hadBom, file };
}

/**
 * 按指定编码写回。GBK 交给 PowerShell/.NET（Node 无内置 GBK 编码器）。
 *
 * **BOM 必须保住**（2026-10-15，用户问题记录第 9 条）：
 * armcc 靠 BOM 判断源文件编码。含中文的 `.c` 一旦丢了 `EF BB BF`，
 * 轻则 `#870-D invalid multibyte character sequence`，重则**编出乱码** ——
 * 屏幕上是问号或错字，而编译器一声不吭。这类损坏是静默的，所以在这里做成结构性保证：
 * 磁盘上原本有 BOM，写回就一定有 BOM，不管调用方传了什么 encoding。
 *
 * @param {string} file
 * @param {string} text
 * @param {string} encoding
 * @param {{keepBom?:boolean}} [opts] 显式覆盖「沿用原文件的 BOM 状态」
 * @returns {{ok:boolean, encoding:string, bytes:number, hadBom:boolean, warning?:string, error?:string}}
 */
function writeText(file, text, encoding, opts) {
  const o = opts || {};
  const enc = encoding || 'utf8';
  const body = text == null ? '' : String(text);

  // 磁盘上原本有没有 BOM
  let originalBom = false;
  try {
    const cur = fs.readFileSync(file);
    originalBom = cur.length >= 3 && cur[0] === 0xEF && cur[1] === 0xBB && cur[2] === 0xBF;
  } catch (_) { /* 文件不存在（新建）→ 当没有 */ }
  const keepBom = o.keepBom === undefined ? originalBom : !!o.keepBom;

  /* 调用方可能把内容连 BOM 一起带进来（比如整段复制了原文）——
     先剥掉，免得写成两个 BOM，那比没有 BOM 更难查。 */
  const content = body.charCodeAt(0) === 0xFEFF ? body.slice(1) : body;

  /** 没 BOM 又要写非 ASCII：armcc 可能编出乱码。如实警告，但不擅自改用户文件的编码。 */
  const bomWarning = (!keepBom && enc !== 'gbk' && /[^\x00-\x7F]/.test(content))
    ? '这个文件没有 BOM，而写入的内容含非 ASCII 字符（中文等）。armcc 可能报 #870-D ' +
      '或编出乱码。若要长期放中文，请在 Keil 里把该文件另存为 UTF-8 with BOM，' +
      '或先去掉中文注释。'
    : undefined;

  if (enc === 'ascii' || enc === 'utf8') {
    // 纯 ASCII 写 UTF-8 与写 GBK 等价；UTF-8 原样写回，不要求内容是 ASCII
    const out = keepBom ? '\uFEFF' + content : content;
    fs.writeFileSync(file, out, 'utf8');
    const r = {
      ok: true,
      encoding: keepBom ? 'utf8-bom' : enc,
      bytes: Buffer.byteLength(out, 'utf8'),
      hadBom: keepBom,
    };
    if (bomWarning) r.warning = bomWarning;
    return r;
  }
  if (enc === 'utf8-bom') {
    const out = '\uFEFF' + content;
    fs.writeFileSync(file, out, 'utf8');
    return { ok: true, encoding: 'utf8-bom', bytes: Buffer.byteLength(out, 'utf8'), hadBom: true };
  }
  if (enc === 'gbk') {
    if (!fs.existsSync(PS1)) return { ok: false, encoding: enc, bytes: 0, error: '缺少转码脚本 ' + PS1 };
    const tmp = file + '.utf8tmp';
    fs.writeFileSync(tmp, content, 'utf8');
    const r = spawnSync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1,
      '-Source', tmp, '-Target', file, '-Encoding', 'GBK',
    ], { encoding: 'utf8', timeout: 60000 });
    try { fs.unlinkSync(tmp); } catch (_) { /* 忽略 */ }
    if (r.status !== 0) {
      return { ok: false, encoding: enc, bytes: 0, error: (r.stderr || r.stdout || '转码失败').trim() };
    }
    return { ok: true, encoding: enc, bytes: fs.statSync(file).size, hadBom: false };
  }
  // 其余编码暂不支持写入，明确失败而不是悄悄写坏
  return { ok: false, encoding: enc, bytes: 0, error: '暂不支持写回 ' + enc };
}

/** 扫一个目录下所有源码，返回编码统计（只读） */
function scanEncodings(dir, exts = /\.(c|h|s|sct|txt|md)$/i, skip = ['Objects', 'Listings', '.git', 'node_modules', 'build']) {
  const out = [];
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (skip.indexOf(e.name) < 0) walk(p); }
      else if (exts.test(e.name)) {
        try {
          const buf = fs.readFileSync(p);
          out.push({ file: p, rel: path.relative(dir, p), encoding: detectEncoding(buf), bytes: buf.length });
        } catch (_) { /* 读不了就跳过 */ }
      }
    }
  };
  walk(dir);
  return out;
}

module.exports = { readText, writeText, detectEncoding, scanEncodings };
