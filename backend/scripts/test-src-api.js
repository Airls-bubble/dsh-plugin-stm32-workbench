'use strict';
/**
 * test-src-api.js —— 端到端验证 `/api/keil/src/*`（编码感知的源码读写）
 *
 * 为什么不拿用户的毕设工程测写入：那是真源码，测坏了不好交代。
 * 这个脚本在插件自己的工作区里**造一个沙箱工程**（含一个 GBK 编码的 .c），
 * 对它做完整的 打开→列文件→读→越界拒绝→写→回读 验证。
 *
 * 前提：`backend/build/keil-recent.json` 里记录着一个真实的 .uvprojx —— 沙箱直接复用它的
 * 工程文件（只复制 .uvprojx，不碰它引用的任何源文件）。没有这个记录就**大声失败**，
 * 而不是悄悄跳过（悄悄跳过 = 假绿灯，这正是 P0 要根治的毛病）。
 *
 * 用法：node backend/scripts/test-src-api.js
 * 退出码：0 通过 / 1 断言失败 / 2 前提缺失
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const toolchain = require('../server/toolchain');
const { detectEncoding } = require('../server/srcfile');
const pathsMod = require('../server/paths');

const ROOT = toolchain.ROOT;                       // <plugin>/backend
const PORT = Number(process.env.TEST_PORT || 8799);
const BASE = 'http://127.0.0.1:' + PORT;
/* 沙箱放系统临时目录：测试不该往插件本体里写东西（插件要能整包拷走） */
const SANDBOX = path.join(os.tmpdir(), 'dsh-mcu-tests', 'src-api-test');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); return true; }
  failures++;
  console.log('  ✗ ' + name + (extra ? '\n      ' + extra : ''));
  return false;
}

/* ── 0) 前提：找得到真实 .uvprojx ─────────────────────────────────── */
pathsMod.migrateLegacyState();   // 老版本状态在插件本体内：先跑幂等迁移
const recentFile = pathsMod.recentFile();
if (!fs.existsSync(recentFile)) {
  console.error('前提缺失：' + recentFile + ' 不存在。');
  console.error('先在工作台里打开一次 Keil 工程，或执行 POST /api/keil/open 指定 .uvprojx。');
  process.exit(2);
}
let realProj = null;
try { realProj = JSON.parse(fs.readFileSync(recentFile, 'utf8')).file; } catch (_) { /* 下面统一报 */ }
if (!realProj || !fs.existsSync(realProj)) {
  console.error('前提缺失：keil-recent.json 里的工程不存在 → ' + realProj);
  process.exit(2);
}
console.log('复用真实工程文件：' + realProj);

/* ── 1) 造沙箱工程 ───────────────────────────────────────────────── */
console.log('\n[1] 造沙箱工程 ' + SANDBOX);
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(SANDBOX, { recursive: true });
fs.copyFileSync(realProj, path.join(SANDBOX, path.basename(realProj)));

/** 带中文注释的样例源码 —— 中文是重点：GBK 写回写坏了，这里就会现形 */
const ORIGINAL = [
  '/* 沙箱样例源码（不是真实源码） */',
  '#include "stm32f10x.h"',
  '',
  '/* 初始化：把某个引脚当作输入，上拉 */',
  'void Sample_Init(void)',
  '{',
  '    GPIO_InitTypeDef GPIO_InitStructure;',
  '    /* 使能时钟 */',
  '    RCC_APB2PeriphClockCmd(RCC_APB2Periph_GPIOA, ENABLE);',
  '}',
  '',
].join('\r\n');

/* 样例文件**必须落在工程自己引用的某个源文件路径上** —— 否则它不会出现在 src/list 里。
   以前这里写死 `.\Hardware\IRSensor.c`，换个工程（比如 STM32 OLED显示屏）就没有这个文件，
   测试会莫名其妙地失败。现在改成：打开沙箱后从清单里挑第一个 C 源文件，再照它的路径造样例。 */
let REL_C = null;
let cGbk = null;

/** 把 UTF-8 文本按 GBK 写到沙箱里的相对路径 */
function writeSample(rel) {
  const abs = path.join(SANDBOX, rel.replace(/^\.\\/, '').replace(/\\/g, path.sep));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = abs + '.utf8tmp';
  fs.writeFileSync(tmp, ORIGINAL, 'utf8');
  const conv = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(ROOT, 'scripts', 'transcode.ps1'),
    '-Source', tmp, '-Target', abs, '-Encoding', 'GBK',
  ], { encoding: 'utf8', timeout: 60000 });
  try { fs.unlinkSync(tmp); } catch (_) { /* 忽略 */ }
  if (conv.status !== 0) throw new Error('造 GBK 样例失败：' + (conv.stderr || conv.stdout || ''));
  return abs;
}

/* ── 2) 起一个独立后端 ───────────────────────────────────────────── */
/* 打开沙箱工程会覆盖全局的 recent.json（「上次打开哪个工程」），测完要还原。
   账本现在**按工程存放**，沙箱工程的账本落在沙箱自己的 .dsh-mcu/ 里 ——
   不会再像以前那样把真实工程的构建记录顶掉。 */
const STATE_FILES = [pathsMod.recentFile()];
const stateSnapshot = STATE_FILES.map((f) => (fs.existsSync(f) ? fs.readFileSync(f) : null));
let stateRestored = false;
function restoreState() {
  if (stateRestored) return true;
  stateRestored = true;
  try {
    STATE_FILES.forEach((f, i) => {
      if (stateSnapshot[i] === null) { if (fs.existsSync(f)) fs.unlinkSync(f); }
      else fs.writeFileSync(f, stateSnapshot[i]);
    });
    return true;
  } catch (err) {
    console.error('！！还原 build 状态文件失败：' + String(err.message || err));
    return false;
  }
}

let child = null;
async function startServer() {
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { MCU_AGENT_PORT: String(PORT) }),
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (c) => { err += c.toString('utf8'); });
  child.stdout.on('data', () => { /* 只等健康检查 */ });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(BASE + '/api/env');
      if (r.ok) return true;
    } catch (_) { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('后端没起来：' + err.slice(-400));
}

async function api(p, init) {
  const r = await fetch(BASE + p, init);
  let body = null;
  try { body = await r.json(); } catch (_) { /* 有些响应不是 JSON */ }
  return { status: r.status, body };
}
const post = (p, obj) => api(p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj || {}),
});

/* ── 3) 跑断言 ───────────────────────────────────────────────────── */
(async () => {
  console.log('\n[2] 启动独立后端 :' + PORT);
  await startServer();
  console.log('    就绪');

  const opened = await post('/api/keil/open', { path: SANDBOX });
  console.log('\n[3] POST /api/keil/open（沙箱）→ ' + opened.status);
  check('打开沙箱工程成功', opened.status === 200 && opened.body && opened.body.ok,
    JSON.stringify(opened.body).slice(0, 300));

  const list = await api('/api/keil/src/list');
  const files = (list.body && list.body.files) || [];
  console.log('\n[4] GET /api/keil/src/list → ' + list.status + '，' + files.length + ' 个文件');
  check('列出源码清单', list.status === 200 && files.length > 0);
  check('清单里没给未参与编译的文件泄露绝对路径',
    files.every((f) => f.abs === undefined));

  /* 从**这个工程自己的**源文件里挑一个当样例 —— 写死路径的版本换个工程就失效。 */
  const pick = files.find((f) => f.kind === 'c');
  check('清单里有可用的 C 源文件（样例必须落在它上面才看得见）', !!pick,
    JSON.stringify(files.slice(0, 3)));
  if (!pick) { console.error('沙箱工程没有 C 源文件，无法继续。'); process.exit(2); }
  REL_C = pick.rel;
  cGbk = writeSample(REL_C);
  const gbkEnc = detectEncoding(fs.readFileSync(cGbk));
  console.log('    样例落在 ' + REL_C + '，编码实测 ' + gbkEnc + '（' + fs.statSync(cGbk).size + ' 字节）');
  if (gbkEnc !== 'gbk') {
    console.error('样例不是 GBK，测试没有意义（得到 ' + gbkEnc + '）。');
    process.exit(2);
  }

  const list2 = await api('/api/keil/src/list');
  const gbkRow = ((list2.body && list2.body.files) || []).find((f) => f.rel === REL_C);
  check('沙箱样例被列出来且标记存在', !!gbkRow && gbkRow.exists === true, JSON.stringify(gbkRow));
  check('清单里认出 GBK 编码', !!gbkRow && gbkRow.encoding === 'gbk',
    gbkRow && ('encoding=' + gbkRow.encoding));

  const read1 = await api('/api/keil/src/read?path=' + encodeURIComponent(REL_C));
  const txt1 = read1.body && read1.body.text;
  console.log('\n[5] GET /api/keil/src/read → ' + read1.status + '，' +
    (read1.body && read1.body.encoding) + '，' + (read1.body && read1.body.bytes) + ' 字节');
  check('读到文件', read1.status === 200 && typeof txt1 === 'string');
  check('识别出 GBK', read1.body && read1.body.encoding === 'gbk');
  check('中文注释没变成乱码', typeof txt1 === 'string' && txt1.indexOf('沙箱样例源码') >= 0);
  check('GBK 往返后与原文逐字符一致', txt1 === ORIGINAL,
    typeof txt1 === 'string' ? ('长度 ' + txt1.length + ' vs ' + ORIGINAL.length) : '');

  /* 越界守卫：绝对路径与相对穿越都必须被挡住 */
  const outside1 = await api('/api/keil/src/read?path=' + encodeURIComponent('..\\..\\..\\Windows\\win.ini'));
  const outside2 = await api('/api/keil/src/read?path=' + encodeURIComponent('C:\\Windows\\win.ini'));
  console.log('\n[6] 越界守卫 → ' + outside1.status + ' / ' + outside2.status);
  check('相对穿越被拒绝（403）', outside1.status === 403, JSON.stringify(outside1.body));
  check('工程外的绝对路径被拒绝（403）', outside2.status === 403, JSON.stringify(outside2.body));

  /* 无变化写入：不该产生备份，也不该改文件 */
  const mtimeBefore = read1.body.mtime;
  const noop = await post('/api/keil/src/write', { path: REL_C, content: ORIGINAL, expectMtime: mtimeBefore });
  console.log('\n[7] POST /api/keil/src/write（内容不变）→ ' + noop.status);
  check('内容一致时判定 changed=false', noop.status === 200 && noop.body && noop.body.changed === false,
    JSON.stringify(noop.body));

  /* 并发防呆：mtime 对不上必须拒绝 */
  const stale = await post('/api/keil/src/write', { path: REL_C, content: ORIGINAL + '\r\n', expectMtime: 1 });
  console.log('\n[8] POST /api/keil/src/write（mtime 不符）→ ' + stale.status);
  check('mtime 不符时返回 409 且拒绝覆盖',
    stale.status === 409 && stale.body && stale.body.code === 'STALE',
    JSON.stringify(stale.body));

  /* 真正写入：追加一行中文注释，检验 GBK 没被写成 UTF-8 */
  const originalBytes = fs.readFileSync(cGbk);   // 写入前的原始字节，用来校验备份是否忠实
  const MARK = '/* 工作台写入测试 —— 这一行必须是 GBK 存盘 */';
  const NEXT = ORIGINAL + MARK + '\r\n';
  const wrote = await post('/api/keil/src/write', { path: REL_C, content: NEXT, expectMtime: mtimeBefore });
  console.log('\n[9] POST /api/keil/src/write（真写入）→ ' + wrote.status);
  check('写入成功且 changed=true', wrote.status === 200 && wrote.body && wrote.body.changed === true,
    JSON.stringify(wrote.body));
  check('写回沿用 GBK 编码', wrote.body && wrote.body.encoding === 'gbk',
    wrote.body && ('encoding=' + wrote.body.encoding));
  check('写入前备份了原件', !!(wrote.body && wrote.body.backup && fs.existsSync(wrote.body.backup)),
    wrote.body && wrote.body.backup);
  check('备份件与写入前的原件逐字节一致（可一键还原）',
    !!(wrote.body && wrote.body.backup) &&
    fs.readFileSync(wrote.body.backup).equals(originalBytes),
    wrote.body && wrote.body.backup);

  const onDisk = detectEncoding(fs.readFileSync(cGbk));
  console.log('    磁盘上现在是什么编码：' + onDisk);
  check('磁盘文件仍是 GBK（没被悄悄写成 UTF-8）', onDisk === 'gbk', '得到 ' + onDisk);

  const read2 = await api('/api/keil/src/read?path=' + encodeURIComponent(REL_C));
  const txt2 = read2.body && read2.body.text;
  check('回读内容 = 原文 + 新增行', txt2 === NEXT,
    typeof txt2 === 'string' ? ('长度 ' + txt2.length + ' vs ' + NEXT.length) : '');
  check('回读后中文依旧完好', typeof txt2 === 'string' &&
    txt2.indexOf('沙箱样例源码') >= 0 && txt2.indexOf('必须是 GBK 存盘') >= 0);

  /* ── BOM 保真（2026-10-15，用户「工具问题记录」第 9 条）──────────────
     armcc 靠 BOM 判断源文件编码。含中文的 .c 丢了 BOM，轻则 #870-D，
     重则**静默编出乱码**（屏幕上是问号）。宿主工具的 edit/write 就踩过这个坑。
     所以「原本有 BOM 就一定有 BOM」在这里必须是**结构性保证**，
     不能指望调用方记得传对 encoding —— 下面专门用错的 encoding 去撞它。 */
  const BOM_TEXT = '/* 中文注释：BOM 必须活着 */\r\nint bom_probe(void) { return 1; }\r\n';
  fs.writeFileSync(cGbk, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(BOM_TEXT, 'utf8')]));
  const bomRead = await api('/api/keil/src/read?path=' + encodeURIComponent(REL_C));
  console.log('\n[10] BOM 保真 → 编码 ' + (bomRead.body && bomRead.body.encoding) +
    '，hadBom=' + (bomRead.body && bomRead.body.hadBom));
  check('认出 UTF-8 BOM 文件',
    bomRead.body && bomRead.body.encoding === 'utf8-bom' && bomRead.body.hadBom === true);
  check('正文里不含 BOM 字符（BOM 属于编码层，不属于文本）',
    bomRead.body.text.charCodeAt(0) !== 0xFEFF);

  /* 陷阱：调用方**显式**传 encoding:'utf8'（很多工具就是这么传的）——
     BOM 不能因为这个参数就丢掉。 */
  const bomWrite = await post('/api/keil/src/write', {
    path: REL_C,
    content: bomRead.body.text + '/* 追加一行 */\r\n',
    encoding: 'utf8',
    expectMtime: bomRead.body.mtime,
  });
  console.log('    写回（故意传 encoding=utf8）→ ' + bomWrite.status +
    '，hadBom=' + (bomWrite.body && bomWrite.body.hadBom));
  check('BOM 文件写回成功', bomWrite.status === 200 && bomWrite.body.ok === true,
    JSON.stringify(bomWrite.body));
  check('调用方传 utf8 也不会弄丢 BOM（结构性保证）',
    bomWrite.body.hadBom === true && bomWrite.body.bomKept === true, JSON.stringify(bomWrite.body));
  const bomDisk = fs.readFileSync(cGbk);
  check('磁盘上前三个字节确实是 EF BB BF',
    bomDisk[0] === 0xEF && bomDisk[1] === 0xBB && bomDisk[2] === 0xBF,
    Buffer.from(bomDisk.slice(0, 3)).toString('hex'));
  check('BOM 之后的中文完好可解码',
    bomDisk.slice(3).toString('utf8').indexOf('BOM 必须活着') >= 0);

  /* 反向：本来没有 BOM 的文件，写进非 ASCII 内容 —— 必须**如实警告**，
     但不擅自替用户改编码（那会把一个文件坑成两种编码）。 */
  const NOBOM = '/* 没有 BOM 的中文 */\r\n';
  fs.writeFileSync(cGbk, NOBOM, 'utf8');
  const nbRead = await api('/api/keil/src/read?path=' + encodeURIComponent(REL_C));
  const nbWrite = await post('/api/keil/src/write', {
    path: REL_C, content: NOBOM + '/* 追加 */\r\n', expectMtime: nbRead.body.mtime,
  });
  check('无 BOM + 中文 → 给出 #870-D / 乱码 风险警告',
    !!(nbWrite.body && nbWrite.body.warning) && /#870-D|乱码/.test(nbWrite.body.warning),
    JSON.stringify(nbWrite.body && nbWrite.body.warning));
  check('警告不等于擅自动手：磁盘上仍然没有 BOM',
    fs.readFileSync(cGbk)[0] !== 0xEF);

  /* 还原：把备份盖回去，确认沙箱恢复原样 */
  if (wrote.body && wrote.body.backup) {
    fs.copyFileSync(wrote.body.backup, cGbk);
    const back = await api('/api/keil/src/read?path=' + encodeURIComponent(REL_C));
    check('用备份还原后与最初一致', back.body && back.body.text === ORIGINAL);
  }

  console.log('\n=== ' + (failures ? failures + ' 项失败' : '全部通过') + ' ===');
})().catch((err) => {
  console.error('测试异常：' + (err && err.stack ? err.stack : err));
  failures++;
}).finally(() => {
  if (child) { try { child.kill(); } catch (_) { /* 已退出 */ } }
  // 还原全局的 recent.json（「上次打开哪个工程」），别让沙箱把真实工程的记录顶掉
  if (!restoreState()) failures++;
  else console.log('已还原全局 recent.json');
  setTimeout(() => process.exit(failures ? 1 : 0), 300);
});
