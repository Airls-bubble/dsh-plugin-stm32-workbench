'use strict';
/** show-vectors.js —— 打印 bin 的向量表与可见字符串，用于辨认固件
 *  用法：node scripts/show-vectors.js <a.bin> [b.bin ...]
 */
const fs = require('fs');
const path = require('path');

const N = ['初始 SP', 'Reset', 'NMI', 'HardFault', 'MemManage', 'BusFault', 'UsageFault', '保留'];
const w = (b, o) => ((b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0);

for (const p of process.argv.slice(2)) {
  if (!fs.existsSync(p)) { console.log('（不存在）' + p); continue; }
  const b = fs.readFileSync(p);
  const nonEmpty = b.filter((x) => x !== 0xFF && x !== 0x00).length;
  console.log('');
  console.log('══ ' + path.basename(p));
  console.log('   ' + b.length + ' B · 有效字节（非 FF/00）' + nonEmpty);
  for (let i = 0; i < 6; i++) {
    const v = w(b, i * 4);
    console.log('   [' + String(i).padStart(2) + '] ' + N[i].padEnd(11) + '0x' + v.toString(16).padStart(8, '0'));
  }
  const hits = b.slice(0, 0x8000).toString('latin1').match(/[\x20-\x7E]{6,}/g);
  if (hits && hits.length) {
    console.log('   可见字符串样本：' + hits.slice(0, 5).map((s) => s.trim()).join(' | ').slice(0, 140));
  } else {
    console.log('   可见字符串样本：（这一段没有可打印的连续字符串）');
  }
}
