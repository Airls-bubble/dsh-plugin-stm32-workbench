'use strict';
/**
 * test-build-map.js —— 走 HTTP 实测 /api/keil/build 的 end 事件里带没带 map
 * 这能回答「为什么构建完 Flash 占用页不刷新」。
 */
const http = require('http');
const ctx = require('./_ctx');

const PORT = parseInt(process.argv[2] || '8799', 10);
/* 工程来自「当前打开的工程」，不再写死开发机路径 */
const PROJ = ctx.projectDir();

function post(p, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}), 'utf8');
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }, timeout: 300000,
    }, (res) => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { s += d; });
      res.on('end', () => resolve(s));
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('超时')));
    r.write(data);
    r.end();
  });
}

(async () => {
  console.log('构建中（走 HTTP，与界面完全同一条路径）…');
  const t0 = Date.now();
  const raw = await post('/api/keil/build', { path: PROJ });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  const lines = raw.split('\n').filter(Boolean);
  const lens = lines.map((l) => l.length).sort((a, b) => a - b);
  console.log('耗时 ' + secs + ' s　NDJSON ' + lines.length + ' 行　总 ' + raw.length + ' 字符');
  console.log('行长：最大 ' + lens[lens.length - 1] + '　中位 ' + lens[Math.floor(lens.length / 2)]);

  let end = null;
  let parseFail = 0;
  for (const l of lines) {
    try {
      const o = JSON.parse(l);
      if (o.type !== 'line' && o.type !== 'start') end = o;
    } catch (_) { parseFail++; }
  }
  console.log('解析失败的行：' + parseFail);
  if (!end) { console.log('✗ 没找到 end 事件'); process.exit(1); }

  console.log('');
  console.log('end 事件字段：' + Object.keys(end).join(', '));
  console.log('  ok          = ' + end.ok);
  console.log('  programSize = ' + (end.programSize ? '有' : '无'));
  console.log('  map         = ' + (end.map ? '有' : '无 ✗'));
  if (end.map) {
    console.log('    objects   = ' + (end.map.objects || []).length + ' 个');
    console.log('    functions = ' + (end.map.functions || []).length + ' 个');
    console.log('    regions   = ' + (end.map.regions || []).length + ' 个');
    console.log('  end 事件 JSON 大小 = ' + JSON.stringify(end).length + ' 字符');
  }
  console.log('');
  console.log('结论：' + (end.map
    ? '后端确实把 map 发出去了 → 问题在客户端如何消费'
    : '后端没发 map → 问题在后端'));
})().catch((e) => { console.error('异常：' + (e && e.stack || e)); process.exit(9); });
