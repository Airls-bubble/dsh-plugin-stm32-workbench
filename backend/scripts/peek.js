'use strict';
/** peek.js —— 查看工程内任意源文件的指定行（自动识别 GBK/UTF-8）
 *  用法：node scripts/peek.js <相对路径> [起始行] [结束行]
 */
const path = require('path');
const fs = require('fs');
const { readText } = require('../server/srcfile');
const ctx = require('./_ctx');

/* 工程目录来自「当前打开的工程」，不再写死开发机路径 */
const DIR = ctx.projectDir();
const rel = process.argv[2];
const from = parseInt(process.argv[3] || '1', 10);
const to = parseInt(process.argv[4] || String(from + 30), 10);

if (!rel) { console.error('用法：node scripts/peek.js <相对路径> [起始行] [结束行]'); process.exit(1); }
const p = path.join(DIR, rel);
if (!fs.existsSync(p)) { console.error('不存在：' + p); process.exit(1); }

const { text, encoding } = readText(p);
const lines = text.split(/\r?\n/);
console.log('══ ' + rel + '  [' + encoding + '，共 ' + lines.length + ' 行]  ' + from + '–' + to + ' ══');
for (let i = from; i <= Math.min(to, lines.length); i++) {
  console.log(String(i).padStart(5) + ' | ' + lines[i - 1]);
}
