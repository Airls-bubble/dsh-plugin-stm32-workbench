'use strict';
/**
 * keil-build-cli.js —— 命令行验证：编译一个外部 Keil 工程
 * 用法：node scripts/keil-build-cli.js [工程.uvprojx 或目录] [可选输出目录]
 */
const path = require('path');
const fs = require('fs');
const { buildKeil } = require('../server/keil-build');
const ctx = require('./_ctx');

/* 默认工程来自「当前打开的工程」（或 --project / MCU_PROJECT），不再写死开发机路径 */
const DEFAULT_PROJ = ctx.projectFile();

function resolveArg(a) {
  if (!a) return DEFAULT_PROJ;
  const p = path.resolve(a);
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
    const hit = fs.readdirSync(p).filter((f) => /\.uvprojx$/i.test(f))[0];
    if (!hit) throw new Error('目录里没有 .uvprojx：' + p);
    return path.join(p, hit);
  }
  return p;
}

const PREFIX = { cmd: '  $ ', error: '  ✗ ', diag: '  · ', phase: '  » ', build: '    ' };

(async () => {
  const projectFile = resolveArg(process.argv[2]);
  const outDir = process.argv[3] || undefined;
  console.log('工程：' + projectFile);
  console.log('输出：' + (outDir || '（默认工作区内）'));
  console.log('─'.repeat(70));

  const r = await buildKeil({
    projectFile,
    outDir,
    onLine: (l, tag) => console.log((PREFIX[tag] || '    ') + l),
  });

  console.log('─'.repeat(70));
  console.log('结果：ok=' + r.ok + '  stage=' + r.stage);
  if (r.programSize) {
    const p = r.programSize;
    console.log('账本：Code=' + p.code + ' RO=' + p.rodata + ' RW=' + p.rwdata + ' ZI=' + p.zidata);
    console.log('     Flash ' + p.flashBytes + '/' + (p.flashKB * 1024) + ' B   SRAM ' + p.ramBytes + '/' + (p.ramKB * 1024) + ' B');
  }
  if (r.warnings && r.warnings.length) console.log('有警告的文件：' + r.warnings.join('、'));
  if (r.artifact) {
    console.log('产物：');
    for (const k of ['axf', 'hex', 'bin']) {
      const f = r.artifact[k];
      console.log('  ' + k.padEnd(4) + (f && fs.existsSync(f) ? fs.statSync(f).size + ' B  ' + f : '（缺失）'));
    }
  }
  console.log('输出目录：' + r.outDir);
  process.exit(r.ok ? 0 : 1);
})().catch((e) => { console.error('异常：' + (e && e.stack || e)); process.exit(2); });
