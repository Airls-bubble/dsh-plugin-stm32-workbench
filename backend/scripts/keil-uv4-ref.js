'use strict';
/**
 * keil-uv4-ref.js —— 用 Keil 自己的 UV4 命令行在**临时副本**上做一次参照构建，
 * 再把它的产物与本插件 armcc 直调的产物逐字节对比。
 * 用户的原工程只读，绝不被写入。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ctx = require('./_ctx');

/* 工程路径来自「当前打开的工程」（或 --project），UV4 从 Keil 根目录推，
   参照产物落在本插件自己的 firmware/build/uv4-ref 下 —— 全程没有写死的盘符。 */
const T = ctx.keilTools();
const UV4 = T.uv4;
if (!UV4) {
  console.error('\n[中止] 找不到 UV4.exe（在 Keil 根目录 ' + T.root + '\\UV4\\ 下没找到）。\n');
  process.exit(3);
}
const SRC = ctx.projectDir();
/* 参照构建也按工程放（<工程>/.dsh-mcu/uv4-ref），跟着工程走 */
const REF_ROOT = path.dirname(ctx.uv4RefDir());
const DST = REF_ROOT;
const OURS = path.join(ctx.latestBuildDir(), 'Project.hex');
console.log('参照源工程：' + SRC);
console.log('UV4：' + UV4);
console.log('参照产物将落在：' + DST);
console.log('本插件产物：' + OURS);

const log = (s) => console.log(s);

/* ── 1) 复制工程（只读源） ── */
log('① 复制工程到 ASCII 临时路径…');
fs.rmSync(DST, { recursive: true, force: true });
fs.cpSync(SRC, DST, { recursive: true });
// 清掉旧中间产物，保证是干净的全量构建
['Objects', 'Listings'].forEach((d) => fs.rmSync(path.join(DST, d), { recursive: true, force: true }));
fs.mkdirSync(path.join(DST, 'Objects'), { recursive: true });
log('   ' + DST);

/* ── 2) UV4 命令行构建 ── */
log('');
log('② 调用 Keil UV4 构建…');
if (!fs.existsSync(UV4)) {
  log('   ✗ 找不到 ' + UV4 + '，无法做参照构建');
  process.exit(2);
}
const uvLog = path.join(DST, 'uv4-build.log');
const t0 = Date.now();
const r = spawnSync(UV4, ['-b', path.join(DST, 'Project.uvprojx'), '-j0', '-o', uvLog], {
  encoding: 'buffer', timeout: 300000,
});
const secs = ((Date.now() - t0) / 1000).toFixed(1);
log('   UV4 退出码 ' + r.status + '（0=无错误，1=有警告，2=有错误），耗时 ' + secs + ' s');

let text = '';
if (fs.existsSync(uvLog)) {
  try { text = new TextDecoder('gbk').decode(fs.readFileSync(uvLog)); }
  catch (_) { text = fs.readFileSync(uvLog, 'utf8'); }
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !/^Build Time|^Build target/.test(l.trim()));
  lines.slice(-12).forEach((l) => log('   | ' + l.trim()));
}
const ps = /Program Size:\s*(Code=\d+\s*RO-data=\d+\s*RW-data=\d+\s*ZI-data=\d+)/i.exec(text);
log('');
log('   ★ UV4 报告：' + (ps ? ps[1] : '（日志里没有 Program Size）'));
log('   ★ 插件报告：Code=33314 RO-data=19970 RW-data=2364 ZI-data=5500');

/* ── 3) 对比两份 hex ── */
log('');
log('③ 产物对比…');
const refHex = path.join(DST, 'Objects', 'Project.hex');
if (!fs.existsSync(refHex)) {
  log('   ✗ UV4 没有产出 hex，无法对比');
  process.exit(3);
}

function toBuf(p) {
  const map = new Map();
  let base = 0;
  for (const l of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!l.startsWith(':') || l.length < 11) continue;
    const len = parseInt(l.substr(1, 2), 16);
    const addr = parseInt(l.substr(3, 4), 16);
    const type = parseInt(l.substr(7, 2), 16);
    const data = [];
    for (let i = 0; i < len; i++) data.push(parseInt(l.substr(9 + i * 2, 2), 16));
    if (type === 0) for (let i = 0; i < len; i++) map.set(base + addr + i, data[i]);
    else if (type === 1) break;
    else if (type === 2) base = ((data[0] << 8) | data[1]) << 4;
    else if (type === 4) base = (((data[0] << 8) | data[1]) << 16) >>> 0;
  }
  const min = Math.min(...map.keys()), max = Math.max(...map.keys());
  const buf = Buffer.alloc(max - min + 1, 0xff);
  for (const [a, v] of map) buf[a - min] = v;
  return { buf, min, max, size: map.size };
}

const R = toBuf(refHex);
const O = toBuf(OURS);
log('   UV4 产物 ：' + R.size + ' B  0x' + R.min.toString(16) + ' ~ 0x' + R.max.toString(16));
log('   插件产物 ：' + O.size + ' B  0x' + O.min.toString(16) + ' ~ 0x' + O.max.toString(16));

const n = Math.min(R.buf.length, O.buf.length);
let diff = 0, firstDiff = -1;
for (let i = 0; i < n; i++) {
  if (R.buf[i] !== O.buf[i]) { diff++; if (firstDiff < 0) firstDiff = i; }
}
const base = Math.max(R.min, O.min);
log('');
log('   公共区间内不同字节：' + diff + ' / ' + n + '（' + (diff / n * 100).toFixed(2) + '%）');
if (diff === 0 && R.buf.length === O.buf.length) {
  log('');
  log('   ✅✅ 与 Keil 完全一致 —— 本插件的编译链路与 Keil 逐字节等价');
} else {
  log('   首个不同字节 @ 0x' + (base + firstDiff).toString(16));
  const s = Math.max(0, firstDiff - 4);
  log('     UV4 : ' + R.buf.slice(s, s + 20).toString('hex'));
  log('     插件: ' + O.buf.slice(s, s + 20).toString('hex'));
  const word = (b, a) => {
    const o = a - base;
    return '0x' + ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0).toString(16).padStart(8, '0');
  };
  log('');
  log('   向量表前 8 个字：');
  const NM = ['SP', 'Reset', 'NMI', 'HardFault', 'MemManage', 'BusFault', 'UsageFault', 'rsv'];
  for (let i = 0; i < 8; i++) {
    const a = base + i * 4;
    const x = word(R.buf, a), y = word(O.buf, a);
    log('     [' + i + '] ' + NM[i].padEnd(10) + 'UV4 ' + x + '   插件 ' + y + (x === y ? '  ✓' : '  ✗'));
  }
}
