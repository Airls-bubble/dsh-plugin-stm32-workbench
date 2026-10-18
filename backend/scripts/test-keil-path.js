'use strict';
/** test-keil-path.js —— 验证路径解析（引号 / 目录 / 递归查找 / 持久化） */
const http = require('http');
const path = require('path');
const ctx = require('./_ctx');

const PORT = parseInt(process.argv[2] || '8799', 10);
/* 路径全部来自「当前打开的工程」，不再写死开发机路径 */
const PROJ_DIR = ctx.projectDir();
const QUOTED = '"' + ctx.projectFile() + '"';
const PARENT = path.dirname(PROJ_DIR);

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
      timeout: 60000,
    }, (res) => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { s += d; });
      res.on('end', () => { try { resolve(JSON.parse(s)); } catch (_) { resolve({ raw: s }); } });
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('超时')));
    if (data) r.write(data);
    r.end();
  });
}

(async () => {
  console.log('测试 http://127.0.0.1:' + PORT);
  console.log('─'.repeat(72));

  console.log('① 带引号的路径（Windows「复制文件地址」的格式）');
  console.log('   输入：' + QUOTED);
  const a = await req('POST', '/api/keil/open', { path: QUOTED });
  console.log('   ' + (a.ok ? '✓ 成功打开：' + a.project.name : '✗ ' + a.error));

  console.log('');
  console.log('② 直接给目录（不是 .uvprojx 文件）');
  console.log('   输入：' + PROJ_DIR);
  const b = await req('POST', '/api/keil/open', { path: PROJ_DIR });
  console.log('   ' + (b.ok ? '✓ 成功打开：' + b.project.name + '（候选 ' + (b.candidates || []).length + ' 个）'
    : '✗ ' + b.error));

  console.log('');
  console.log('③ 递归扫描上级目录');
  const c = await req('POST', '/api/keil/scan', { dir: PARENT });
  if (!c.ok) console.log('   ✗ ' + c.error);
  else {
    console.log('   ✓ 在 ' + c.dir + ' 下找到 ' + c.projects.length + ' 个工程：');
    c.projects.forEach((p) => console.log('      ' + (p.label || '?') + '  ·  ' + p.device + '  ·  ' + p.file));
  }

  console.log('');
  console.log('④ 状态持久化（重启后端后应能自动恢复）');
  const d = await req('GET', '/api/keil/state');
  console.log('   ' + (d.open ? '✓ 当前工程：' + d.project.name : '✗ 未打开'));
  const e = await req('GET', '/api/keil/pins');
  console.log('   ' + (e.ok ? '✓ 引脚配置可用：' + e.usedPins + ' 个引脚，' + e.conflicts.length + ' 条冲突'
    : '✗ ' + e.error));
  console.log('─'.repeat(72));
})().catch((e) => { console.error('异常：' + (e && e.stack || e)); process.exit(2); });
