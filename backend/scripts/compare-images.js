'use strict';
/**
 * compare-images.js —— 比较两份固件映像的差异分布
 * 默认对比：刚编译的毕设程序  vs  板子上还原的备份固件
 * 用法：node scripts/compare-images.js [a.bin] [b.bin]
 */
const fs = require('fs');
const path = require('path');
const ctx = require('./_ctx');

/* 两份映像都从本机解析：A = 本插件最新构建的 .bin，B = 命令行指定的另一份。
   以前写死了开发期的 build 目录名（Project-b04c7833）和桌面备份路径 ——
   换个工程就会拿旧产物跟错误的对象比，比出什么都没有意义。 */
function latestBin() {
  const dir = ctx.latestBuildDir();
  const bins = fs.readdirSync(dir).filter((f) => /\.bin$/i.test(f));
  if (!bins.length) throw new ctx.ScriptError('最新产物目录里没有 .bin：' + dir);
  return path.join(dir, bins[0]);
}

const f1 = process.argv[2] ? path.resolve(process.argv[2]) : latestBin();
const f2 = process.argv[3] ? path.resolve(process.argv[3]) : null;
if (!f2) {
  ctx.die(new ctx.ScriptError(
    '需要指定第二份映像：node scripts/compare-images.js [A.bin] <B.bin>\n' +
    '  · A 省略时用本插件最新构建的：' + f1 + '\n' +
    '  · B 必须显式给出（备份固件放哪由你决定，脚本不替你猜）'));
}

for (const f of [f1, f2]) {
  if (!fs.existsSync(f)) { console.error('✗ 不存在：' + f); process.exit(1); }
}

const a = fs.readFileSync(f1);   // 刚编译的
const b = fs.readFileSync(f2);   // 板子上的备份

console.log('A（刚编译）  ：' + path.basename(f1) + '  ' + a.length + ' B');
console.log('B（板子备份）：' + path.basename(f2) + '  ' + b.length + ' B');
console.log('─'.repeat(70));

// 备份是整片 64 KB，含 0xFF 填充；只看 A 覆盖的范围
const n = Math.min(a.length, b.length);
let diff = 0, first = -1;
const runs = [];
for (let i = 0; i < n; i++) {
  if (a[i] !== b[i]) {
    diff++;
    if (first < 0) first = i;
    const last = runs[runs.length - 1];
    if (last && i - last.end <= 32) last.end = i; else runs.push({ start: i, end: i });
  }
}
console.log('相同长度区间内不同字节：' + diff + ' / ' + n + '（' + (diff / n * 100).toFixed(2) + '%）');
if (first >= 0) console.log('首个不同字节 @ 0x' + (0x08000000 + first).toString(16));

console.log('');
console.log('差异区间（' + runs.length + ' 段，相邻 32 B 内合并）：');
runs.slice(0, 12).forEach((r) => {
  console.log('  0x' + (0x08000000 + r.start).toString(16).padStart(8, '0') + '  ' +
    String(r.end - r.start + 1).padStart(6) + ' B');
});
if (runs.length > 12) console.log('  …还有 ' + (runs.length - 12) + ' 段');

/* 向量表对比最有信息量 */
const word = (buf, o) => ((buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24)) >>> 0);
console.log('');
console.log('向量表关键项：');
console.log('  初始 SP   A=' + '0x' + word(a, 0).toString(16).padStart(8, '0') +
  '   B=' + '0x' + word(b, 0).toString(16).padStart(8, '0') +
  (word(a, 0) === word(b, 0) ? '  ✓' : '  ✗'));
console.log('  Reset     A=' + '0x' + word(a, 4).toString(16).padStart(8, '0') +
  '   B=' + '0x' + word(b, 4).toString(16).padStart(8, '0') +
  (word(a, 4) === word(b, 4) ? '  ✓' : '  ✗'));

/* 结论 */
const nonFF = (buf, len) => { let c = 0; for (let i = 0; i < len; i++) if (buf[i] !== 0xFF && buf[i] !== 0x00) c++; return c; };
console.log('');
console.log('有效字节（前 ' + n + ' B 内，非 FF/00）：A=' + nonFF(a, n) + '   B=' + nonFF(b, n));
console.log('');
if (diff === 0) {
  console.log('✅ 完全一致 —— 板子上那份备份固件就是用这份源码编译出来的');
} else if (word(a, 4) === word(b, 4) && word(a, 0) === word(b, 0)) {
  console.log('→ 向量表一致、代码区有差异：同一个工程的不同版本（改动多集中在代码段）');
} else {
  console.log('→ 连向量表都不同：两份是不同的程序或不同编译配置');
}
