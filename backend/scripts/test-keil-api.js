'use strict';
/**
 * test-keil-api.js —— 验证新增的 Keil 接入 API（对着一个测试实例跑，不动 DSH 里的后端）
 * 用法：node scripts/test-keil-api.js [port]
 */
const http = require('http');
const ctx = require('./_ctx');

const PORT = parseInt(process.argv[2] || '8799', 10);
/* 工程来自「当前打开的工程」，不再写死开发机路径 */
const PROJ = ctx.projectDir();

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {},
      timeout: 120000,
    }, (res) => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { s += d; });
      res.on('end', () => {
        // NDJSON 流：逐行解析
        const lines = s.split(/\r?\n/).filter(Boolean);
        if (lines.length > 1) {
          try { resolve({ _stream: true, lines: lines.map((l) => JSON.parse(l)) }); } catch (_) { resolve({ raw: s }); }
        } else {
          try { resolve(JSON.parse(s)); } catch (_) { resolve({ raw: s }); }
        }
      });
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('超时')));
    if (data) r.write(data);
    r.end();
  });
}

const ok = (c) => (c ? '✓' : '✗');

(async () => {
  console.log('测试后端实例：http://127.0.0.1:' + PORT);
  console.log('─'.repeat(70));

  /* 1. 存活 */
  const env = await req('GET', '/api/env');
  console.log('1) GET  /api/env          ' + ok(env && env.compilers) +
    '   检测到编译器 ' + ((env.compilers || []).filter((c) => c.usable).length) + ' 个');

  /* 2. 打开 Keil 工程 */
  const open = await req('POST', '/api/keil/open', { path: PROJ });
  if (!open.ok) { console.log('2) POST /api/keil/open    ✗  ' + open.error); process.exit(1); }
  console.log('2) POST /api/keil/open    ✓  ' + open.project.name);
  console.log('     芯片 ' + open.project.device + ' · ' + open.project.summary);
  console.log('     HSE  ' + (open.project.hse.hz / 1e6) + ' MHz（' + open.project.hse.source + '）');
  console.log('     分组 ' + open.project.groups.map((g) => g.name + ':' + g.files).join('  '));
  console.log('     诊断 ' + open.diagnostics.length + ' 条' +
    (open.diagnostics.length ? '：' + open.diagnostics.map((d) => d.code).join(',') : ''));

  /* 3. 引脚配置 */
  const pins = await req('GET', '/api/keil/pins');
  if (!pins.ok) { console.log('3) GET  /api/keil/pins    ✗  ' + pins.error); }
  else {
    console.log('3) GET  /api/keil/pins    ✓  用到 ' + pins.usedPins + ' 个引脚，冲突 ' + pins.conflicts.length + ' 条');
    pins.pins.slice(0, 8).forEach((x) => {
      const m = (x.final && x.final.modeZh) || (x.configs[0] && x.configs[0].modeZh) || '?';
      console.log('     ' + x.name.padEnd(6) + '物理脚 ' + String(x.physicalPin == null ? '—' : x.physicalPin).padStart(3) +
        '  ' + String(m).padEnd(10) + (x.reinitCount > 1 ? ('重配 ' + x.reinitCount + ' 次') : ''));
    });
    console.log('     …（共 ' + pins.pins.length + ' 个）');
    pins.conflicts.forEach((c) => console.log('     ⚠ ' + c.pin + '：' + c.detail));
  }

  /* 4. 寄存器 */
  const regs = await req('POST', '/api/keil/registers', {});
  if (!regs.ok) { console.log('4) POST /api/keil/registers ✗（未连接？） ' + regs.error); }
  else {
    const c = regs.clock;
    console.log('4) POST /api/keil/registers ✓');
    console.log('     SYSCLK ' + (c.sysclkHz / 1e6) + ' MHz（' + c.source + '，PLL ' + c.pll.src + ' ×' + c.pll.mul + '）');
    console.log('     APB1 ' + (c.pclk1Hz / 1e6) + ' MHz · APB2 ' + (c.pclk2Hz / 1e6) + ' MHz');
    console.log('     APB2 使能：' + (regs.rcc.enabledAPB2.join(' ') || '无'));
    console.log('     APB1 使能：' + (regs.rcc.enabledAPB1.join(' ') || '无'));
    if (regs.compare) {
      console.log('     对照：' + regs.compare.matched + '/' + regs.compare.total + ' 吻合 —— ' + regs.compare.verdict);
    }
    console.log('     GPIOA 已配置引脚：' + (regs.gpio.A.used.map((p) => p.name).join(' ') || '无'));
    console.log('     GPIOB 已配置引脚：' + (regs.gpio.B.used.map((p) => p.name).join(' ') || '无'));
    console.log('     GPIOC 已配置引脚：' + (regs.gpio.C.used.map((p) => p.name).join(' ') || '无'));
  }

  /* 5. 编译（流式） */
  console.log('5) POST /api/keil/build   编译中…');
  const t0 = Date.now();
  const b = await req('POST', '/api/keil/build', {});
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (b._stream) {
    const last = b.lines[b.lines.length - 1] || {};
    const errs = b.lines.filter((l) => l.tag === 'error');
    console.log('     ' + ok(last.ok) + '  ok=' + last.ok + '  stage=' + last.stage + '  耗时 ' + secs + ' s  （' + b.lines.length + ' 行输出）');
    if (last.programSize) {
      const p = last.programSize;
      console.log('     Code=' + p.code + ' RO=' + p.rodata + ' RW=' + p.rwdata + ' ZI=' + p.zidata +
        ' → Flash ' + p.flashBytes + ' B / SRAM ' + p.ramBytes + ' B');
    }
    errs.slice(0, 3).forEach((e) => console.log('     ✗ ' + e.text));
  } else {
    console.log('     ✗ ' + JSON.stringify(b).slice(0, 200));
  }

  console.log('─'.repeat(70));
  console.log('全部接口测试完成');
})().catch((e) => { console.error('异常：' + (e && e.stack || e)); process.exit(2); });
