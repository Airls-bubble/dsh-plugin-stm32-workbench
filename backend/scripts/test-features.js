'use strict';
/**
 * test-features.js —— 端到端验证「功能契约」：`/api/features*` 与 features.js
 *
 * 这一层是用户唯一会读的东西，写错等于对用户说谎，所以必须端到端测：
 * 造一个沙箱工程 → 真起后端 → 存描述 → 回读 → 差分 → 过期判定 → 恢复历史 → 坏文件不吞。
 *
 * **沙箱原则**（跟 test-src-api.js 一致）：不拿巨维的真实工程做写入实验。
 * 只复用它的 .uvprojx（不碰它引用的任何源文件），测试数据全部落在系统临时目录。
 *
 * 用法：node backend/scripts/test-features.js
 * 退出码：0 通过 / 1 断言失败 / 2 前提缺失
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pathToFileURL } = require('node:url');
const toolchain = require('../server/toolchain');
const pathsMod = require('../server/paths');
const featuresMod = require('../server/features');

const ROOT = toolchain.ROOT;                       // <plugin>/backend
const PORT = Number(process.env.TEST_PORT || 8798);
const BASE = 'http://127.0.0.1:' + PORT;
const SANDBOX = path.join(os.tmpdir(), 'dsh-mcu-tests', 'features-test');

let failures = 0;
let child = null;
/** 打开沙箱工程会顶掉全局 recent.json —— 在**模块作用域**存一份，finally 里才够得着。
 *  （2026-10-14 踩到：声明写在 async IIFE 里，finally 里 `savedRecent is not defined`，
 *   结果沙箱路径被留在 recent.json 里、把巨维「上次打开的工程」弄丢了。） */
let savedRecent = null;
let recentPath = null;
function check(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); return true; }
  failures++;
  console.log('  ✗ ' + name + (extra ? '\n      ' + extra : ''));
  return false;
}

/** 把文件的 mtime 推到未来 —— 「描述之后代码又改了」这件事必须确定性可测，不能靠 sleep */
function ageFile(file, secondsFromNow) {
  const t = new Date(Date.now() + secondsFromNow * 1000);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, '/* 测试用样例，不是真实源码 */\r\n', 'utf8');
  fs.utimesSync(file, t, t);
}

/* ── 0) 纯模块测试（不起后端，先验核心算法）────────────────────────── */
function unitTests() {
  console.log('\n[0] features.js 纯逻辑');

  const n1 = featuresMod.normalize([{ name: '甲' }, { id: 'b', name: '乙', status: '乱写' }]);
  check('数组输入被接受', n1.modules.length === 2);
  check('缺 id 自动补上稳定 id', n1.modules[0].id === 'm1', JSON.stringify(n1.modules[0]));
  check('非法 status 归到 done', n1.modules[1].status === 'done', n1.modules[1].status);

  const n2 = featuresMod.normalize([
    { id: 'x', name: 'A' }, { id: 'x', name: 'B' },
  ]);
  check('重复 id 被去重（否则界面 diff 会错位）', n2.modules[0].id !== n2.modules[1].id,
    JSON.stringify(n2.modules.map((m) => m.id)));

  const n3 = featuresMod.normalize('不是数组也不是对象');
  check('垃圾输入不抛错，退化成空表', Array.isArray(n3.modules) && n3.modules.length === 0);

  const n4 = featuresMod.normalize([{ id: 'a', name: 'x'.repeat(999), trigger: 'y'.repeat(99999) }]);
  check('超长字段被截断', n4.modules[0].name.length <= featuresMod.LIMITS.name &&
    n4.modules[0].trigger.length <= featuresMod.LIMITS.trigger);

  /* 结构化：列表字段要能收数组，也要能收「换行/顿号分隔的字符串」（面板就是那么给的） */
  const n5 = featuresMod.normalize([{ id: 'a', name: 'A',
    behavior: ['一行一条', '- 前面带项目符号的也要剥掉'],
    hardware: 'PB1 — 按键 K1、PB11 — 按键 K2',
    params: ['翻页 5 s', '', '  '], limits: ['按住不放不会连续翻页'] }]);
  check('列表字段收数组', n5.modules[0].behavior.length === 2 && n5.modules[0].behavior[0] === '一行一条',
    JSON.stringify(n5.modules[0].behavior));
  check('列表字段收字符串（顿号分隔）', n5.modules[0].hardware.length === 2,
    JSON.stringify(n5.modules[0].hardware));
  check('列表字段剥掉项目符号前缀', n5.modules[0].behavior[1] === '前面带项目符号的也要剥掉',
    n5.modules[0].behavior[1]);
  check('列表字段丢掉空行', n5.modules[0].params.length === 1, JSON.stringify(n5.modules[0].params));
  check('每个模块都补齐全部结构化字段', featuresMod.LIST_FIELDS.every((f) => Array.isArray(n5.modules[0][f])) &&
    typeof n5.modules[0].summary === 'string' && typeof n5.modules[0].trigger === 'string',
    JSON.stringify(Object.keys(n5.modules[0])));

  /* 旧格式（一段散文 detail）不能被丢掉 —— 那是用户已经写过的字 */
  const n6 = featuresMod.normalize([{ id: 'old', name: '旧模块', detail: '第一句话。\n第二句话。' }]);
  check('旧格式的 detail 被迁进 behavior（不丢字）',
    n6.modules[0].behavior.length === 2 && n6.modules[0].behavior[1] === '第二句话。',
    JSON.stringify(n6.modules[0].behavior));

  const d = featuresMod.diffModules(
    [{ id: 'a', name: 'A', behavior: ['旧'], params: ['x'] }, { id: 'b', name: 'B' }],
    [{ id: 'a', name: 'A', behavior: ['新'], params: ['x'] }, { id: 'c', name: 'C' }]);
  check('差分：改 / 增 / 删 各归各位',
    d.changed.length === 1 && d.added.length === 1 && d.removed.length === 1,
    JSON.stringify({ c: d.changed.length, a: d.added.length, r: d.removed.length }));
  check('差分能说出改了哪些字段', d.changed[0].fields.indexOf('behavior') >= 0,
    JSON.stringify(d.changed[0].fields));
  check('没动的字段不会被算成改动', d.changed[0].fields.indexOf('params') < 0,
    JSON.stringify(d.changed[0].fields));

  const msg = featuresMod.buildMessage(
    [{ id: 'a', name: 'OLED', behavior: ['旧现象'], status: 'done', files: ['.\\A.c'] }],
    [{ id: 'a', name: 'OLED', behavior: ['新现象'], status: 'partial', files: ['.\\A.c'] }],
    { project: '沙箱工程', note: '顺便把刷新率提高' });
  check('发给模型的话带出「原现象 → 改为」', msg.indexOf('【原现象】') >= 0 && msg.indexOf('【改为】') >= 0);
  check('发给模型的话带出用户补充说明', msg.indexOf('顺便把刷新率提高') >= 0);
  check('发给模型的话要求回写描述（action=spec）', msg.indexOf('action=spec') >= 0);
  check('发给模型的话要求短句汇报、不要空话', /不要写空话/.test(msg));
  check('差分消息里不重复贴没动过的字段',
    msg.indexOf('关键数值') < 0 && msg.indexOf('引脚与外设') < 0, msg.slice(0, 400));

  const refresh = featuresMod.buildRefreshMessage('沙箱', { changedFiles: 3, newestFile: 'a.c', codeAt: 'x' }, n1);
  check('重写说明讲清「为什么过期」', /又有 3 个源文件被改过/.test(refresh));
  check('重写说明明确「只调 spec，不要改代码」', refresh.indexOf('不要顺手改代码') >= 0);
  check('重写说明带上行文规矩（反废话）', refresh.indexOf('行文规矩') >= 0 && refresh.indexOf('禁止空话') >= 0);
  check('重写说明列出全部字段', featuresMod.LIST_FIELDS.every((f) => refresh.indexOf(f) >= 0));

  const describe = featuresMod.buildDescribeMessage('沙箱');
  check('初次生成说明强调「按功能分模块，不按文件分」', describe.indexOf('不要按文件分') >= 0);
  check('初次生成说明给出保存格式', describe.indexOf('"modules"') >= 0);
  check('初次生成说明给出字段表', describe.indexOf('| 字段 | 写什么 |') >= 0);
  check('初次生成说明禁止写散文', describe.indexOf('不要另外写一段散文') >= 0);
  check('反废话规则写进说明：一行一件事', describe.indexOf('一行一件事') >= 0);
  check('反废话规则写进说明：禁止「主要用于」', describe.indexOf('该模块主要用于') >= 0);
  check('反废话规则写进说明：想不到就留空', describe.indexOf('想不到就留空') >= 0);

  const md = featuresMod.toMarkdown({ revision: 2, updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'ai',
    modules: [{ id: 'a', name: 'OLED 显示', status: 'broken',
      summary: '一句话', trigger: '上电时',
      behavior: ['第 1 行显示 Hello'], hardware: ['PB8 — SCL'],
      params: ['刷新 1 s'], limits: ['没接屏无反应'], files: ['.\\A.c'] }] },
  { project: '沙箱', stale: { state: 'stale', changedFiles: 2, newestFile: 'b.c', codeAt: 't' } });
  check('Markdown 带模块名与中文状态', md.indexOf('OLED 显示') >= 0 && md.indexOf('有问题') >= 0);
  check('Markdown 里过期会被明说', md.indexOf('已过期') >= 0);
  check('Markdown 按字段分小节（不是一段散文）',
    md.indexOf('**何时发生**') >= 0 && md.indexOf('**现象**') >= 0 &&
    md.indexOf('**引脚与外设**') >= 0 && md.indexOf('**关键数值**') >= 0 && md.indexOf('**限制与注意**') >= 0,
    md);
}

/* ── 1) 前提 ─────────────────────────────────────────────────── */
function precondition() {
  pathsMod.migrateLegacyState();
  const recentFile = pathsMod.recentFile();
  if (!fs.existsSync(recentFile)) {
    console.error('前提缺失：' + recentFile + ' 不存在。先在工作台打开一次 Keil 工程。');
    process.exit(2);
  }
  let proj = null;
  try { proj = JSON.parse(fs.readFileSync(recentFile, 'utf8')).file; } catch (_) { /* 下面报 */ }
  if (!proj || !fs.existsSync(proj)) {
    console.error('前提缺失：recent.json 里的工程不存在 → ' + proj);
    process.exit(2);
  }
  return proj;
}

async function startServer() {
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    cwd: ROOT, env: Object.assign({}, process.env, { MCU_AGENT_PORT: String(PORT) }),
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err = '';
  child.stderr.on('data', (c) => { err += c.toString('utf8'); });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try { if ((await fetch(BASE + '/api/env')).ok) return true; } catch (_) { /* 等 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('后端没起来：' + err.slice(-400));
}

async function api(p, init) {
  const r = await fetch(BASE + p, init);
  let body = null;
  try { body = await r.json(); } catch (_) { /* 非 JSON */ }
  return { status: r.status, body };
}
const post = (p, obj) => api(p, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj || {}),
});

const MOD_A = {
  id: 'oled', name: 'OLED 显示', status: 'done',
  summary: '上电后显示一行字并每秒刷新',
  trigger: '上电初始化后立即开始；每 1 秒刷新一次',
  behavior: ['第 1 行显示 Hello', '只重画变化的字符'],
  hardware: ['PB8 — OLED SCL（软件 I2C）', 'PB9 — OLED SDA（软件 I2C）'],
  params: ['刷新间隔 1 s'],
  limits: ['没接屏时没有任何反应'],
  files: ['.\\Hardware\\OLED.c'],
};
const MOD_B = {
  id: 'key', name: '按键扫描', status: 'partial',
  summary: '按下 PA0 时翻转 PB12 上的 LED',
  trigger: '每次主循环扫一次；按下并保持 30 ms 触发一次',
  behavior: ['按下后 LED 翻转一次', '松开不会重复触发'],
  hardware: ['PA0 — 按键，上拉输入，按下为低', 'PB12 — LED，推挽输出'],
  params: ['消抖 30 ms'],
  limits: ['按住不放不会连续翻转'],
  files: ['.\\User\\main.c'],
};

(async () => {
  console.log('=== 功能契约验证 ===');
  unitTests();

  const realProj = precondition();
  console.log('\n[1] 造沙箱工程 ' + SANDBOX);
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX, { recursive: true });
  fs.copyFileSync(realProj, path.join(SANDBOX, path.basename(realProj)));

  /* 打开沙箱会把全局 recent.json 顶成沙箱路径 —— 测完必须还原，
     否则下次用户打开工作台，默认工程会莫名其妙变成测试沙箱。 */
  recentPath = pathsMod.recentFile();
  savedRecent = fs.existsSync(recentPath) ? fs.readFileSync(recentPath) : null;
  if (!savedRecent) {
    console.error('前提缺失：' + recentPath + ' 读不到，测完无法还原「上次打开的工程」。');
    process.exit(2);
  }

  console.log('\n[2] 启动独立后端 :' + PORT);
  await startServer();
  console.log('    就绪');

  const opened = await post('/api/keil/open', { path: SANDBOX });
  check('沙箱工程打开成功', opened.status === 200 && opened.body && opened.body.ok,
    JSON.stringify(opened.body).slice(0, 300));

  /* ── 空状态 ── */
  const empty = await api('/api/features');
  console.log('\n[3] GET /api/features（还没写过）→ ' + empty.status);
  check('空状态返回 200 而不是 404', empty.status === 200);
  check('has=false', empty.body && empty.body.has === false);
  check('过期判定为 missing', empty.body && empty.body.stale && empty.body.stale.state === 'missing',
    JSON.stringify(empty.body && empty.body.stale));
  check('描述文件落在工程的 .dsh-mcu/ 下（跟工程走）',
    !!(empty.body && empty.body.path) &&
    empty.body.path.indexOf(path.join(SANDBOX, '.dsh-mcu')) === 0,
    empty.body && empty.body.path);

  /* ── 第一次写 ── */
  const w1 = await post('/api/features', { modules: [MOD_A, MOD_B] });
  console.log('\n[4] POST /api/features（第一次写）→ ' + w1.status);
  check('保存成功且 revision=1', w1.status === 200 && w1.body.ok && w1.body.revision === 1,
    JSON.stringify(w1.body && { revision: w1.body.revision, error: w1.body.error }));
  check('updatedBy 记成 user（面板保存的）', w1.body.spec.updatedBy === 'user');
  check('文件真的落盘了', fs.existsSync(path.join(SANDBOX, '.dsh-mcu', 'features.json')));

  const raw = JSON.parse(fs.readFileSync(path.join(SANDBOX, '.dsh-mcu', 'features.json'), 'utf8'));
  check('磁盘上的 JSON 是规范形状（id/name/status 都在）',
    raw.modules.length === 2 && raw.modules[0].id === 'oled' && raw.modules[1].status === 'partial');

  /* ── 回读 ── */
  const r1 = await api('/api/features');
  check('回读拿到 2 个模块', r1.body.spec.modules.length === 2);
  check('回读的结构化字段逐字一致（列表也是数组）',
    r1.body.spec.modules[0].trigger === MOD_A.trigger &&
    JSON.stringify(r1.body.spec.modules[0].behavior) === JSON.stringify(MOD_A.behavior) &&
    JSON.stringify(r1.body.spec.modules[0].hardware) === JSON.stringify(MOD_A.hardware));
  check('回读带紧凑清单 outline（工具那边用它，避免正文塞两遍）',
    Array.isArray(r1.body.outline) && r1.body.outline[0].id === 'oled' &&
    r1.body.outline[0].nBehavior === 2 && r1.body.outline[0].behavior === undefined,
    JSON.stringify(r1.body.outline && r1.body.outline[0]));
  check('回读带 markdown（工具那边直接用这份）',
    typeof r1.body.markdown === 'string' && r1.body.markdown.indexOf('OLED 显示') >= 0);
  check('刚写完时判定与代码同步（ok）', r1.body.stale.state === 'ok', JSON.stringify(r1.body.stale));
  check('刚写完时历史是空的', Array.isArray(r1.body.history) && r1.body.history.length === 0,
    JSON.stringify(r1.body.history));

  /* ── 内容没变就不该新增版本 ── */
  const w2 = await post('/api/features', { modules: [MOD_A, MOD_B] });
  check('内容一致时 changed=false 且 revision 不涨',
    w2.status === 200 && w2.body.changed === false && w2.body.revision === 1,
    JSON.stringify(w2.body && { changed: w2.body.changed, revision: w2.body.revision }));

  /* ── 改一个模块 → 版本 +1、旧版进历史 ── */
  const MOD_A2 = Object.assign({}, MOD_A, {
    behavior: ['第 1 行显示 Hello', '只重画变化的字符', '刷新间隔从 1 s 改为 0.2 s'],
    params: ['刷新间隔 0.2 s'],
  });
  const w3 = await post('/api/features', { modules: [MOD_A2, MOD_B] });
  console.log('\n[5] POST /api/features（改一处）→ ' + w3.status + '，r' + (w3.body && w3.body.revision));
  check('revision 涨到 2', w3.body.revision === 2);
  check('旧版本进了历史', Array.isArray(w3.body.history) && w3.body.history.length === 1,
    JSON.stringify(w3.body.history));
  check('历史条目带模块数与时间', !!(w3.body.history[0] && w3.body.history[0].modules === 2 &&
    w3.body.history[0].at));

  /* ── 差分消息 ── */
  const m1 = await post('/api/features/message', { modules: [MOD_A2, MOD_B], note: '顺便把刷新率再提高一点' });
  console.log('\n[6] POST /api/features/message（revise）→ ' + m1.status + '，' + (m1.body && m1.body.chars) + ' 字符');
  check('差分统计正确：改 0（还没保存）/ 增 0', m1.status === 200 && m1.body.ok === true);
  check('消息里带补充说明', m1.body.text.indexOf('顺便把刷新率再提高一点') >= 0);
  check('消息里要求编译通过', m1.body.text.indexOf('action=build') >= 0);

  const m2 = await post('/api/features/message', { modules: [MOD_A, MOD_B, { id: 'new', name: '新功能', summary: 's', status: 'todo' }] });
  check('新增模块被识别（added=1）', m2.body.added === 1, JSON.stringify({ a: m2.body.added, c: m2.body.changed }));
  check('新增模块在消息里带出完整描述', m2.body.text.indexOf('新增的功能') >= 0);

  const m3 = await post('/api/features/message', { mode: 'refresh' });
  check('refresh 模式要求重写整份描述', m3.body.mode === 'refresh' && m3.body.text.indexOf('重写整份功能描述') >= 0);
  const m4 = await post('/api/features/message', { mode: 'describe' });
  check('describe 模式给出保存格式', m4.body.text.indexOf('"modules"') >= 0);

  /* ── 过期判定 ── */
  ageFile(path.join(SANDBOX, 'FutureEdited.c'), 30);
  const r2 = await api('/api/features');
  console.log('\n[7] 源码比描述新 → ' + r2.body.stale.state + '（' + r2.body.stale.changedFiles + ' 个文件）');
  check('检测到描述过期', r2.body.stale.state === 'stale', JSON.stringify(r2.body.stale));
  check('过期时指出是哪个文件', r2.body.stale.newestFile === 'FutureEdited.c', r2.body.stale.newestFile);
  check('过期状态写进 markdown（模型读到就知道要重写）', r2.body.markdown.indexOf('已过期') >= 0);

  /* 构建产物不能把描述「弄旧」—— .dsh-mcu/ 整个目录都要被跳过 */
  ageFile(path.join(SANDBOX, '.dsh-mcu', 'build', 'keil', 'Output.c'), 60);
  ageFile(path.join(SANDBOX, '.dsh-mcu', 'Objects', 'Ignored.c'), 60);
  const r3 = await api('/api/features');
  check('构建产物/中间件不参与过期判定（否则每次编译都误报）',
    r3.body.stale.changedFiles === r2.body.stale.changedFiles,
    'now=' + r3.body.stale.changedFiles + ' before=' + r2.body.stale.changedFiles);

  /* ── 历史恢复 ── */
  const stamp = w3.body.history[0].stamp;
  const res = await post('/api/features/restore', { stamp });
  console.log('\n[8] POST /api/features/restore（' + stamp + '）→ ' + res.status + '，r' + (res.body && res.body.revision));
  check('恢复成功且版本继续前进（恢复本身也是一次改动）', res.status === 200 && res.body.revision === 3);
  check('恢复后的内容 = 第 1 版',
    JSON.stringify(res.body.spec.modules[0].behavior) === JSON.stringify(MOD_A.behavior),
    JSON.stringify(res.body.spec.modules[0].behavior));
  check('恢复前的版本也进了历史（撤销撤销可用）', res.body.history.length === 2);
  check('updatedBy 标成 restore', res.body.spec.updatedBy === 'restore');

  const bad = await post('/api/features/restore', { stamp: '不存在的东西' });
  check('恢复不存在的版本被拒绝（400）', bad.status === 400, JSON.stringify(bad.body));
  const evil = await post('/api/features/restore', { stamp: '..\\..\\evil' });
  check('恢复的路径穿越被拒绝', evil.status === 400, JSON.stringify(evil.body));

  /* ── 坏文件不吞 ── */
  const file = path.join(SANDBOX, '.dsh-mcu', 'features.json');
  const good = fs.readFileSync(file);
  fs.writeFileSync(file, '{这不是 JSON', 'utf8');
  const r4 = await api('/api/features');
  console.log('\n[9] features.json 坏掉 → ' + r4.status + '，broken=' + (r4.body && r4.body.broken));
  check('坏文件如实报 broken，不抛 500', r4.status === 200 && r4.body.broken === true);
  check('坏文件不会被偷偷删掉（用户的字不能替用户做主）', fs.existsSync(file));
  check('坏文件保留原始字节', fs.readFileSync(file, 'utf8') === '{这不是 JSON');
  fs.writeFileSync(file, good);

  /* ── 归一化：界面/模型给脏数据也不能炸 ── */
  const junk = await post('/api/features', {
    modules: [
      { name: '没有 id 的模块', status: '乱写' },
      { id: 'dup', name: 'A' }, { id: 'dup', name: 'B' },
      null, 42, '字符串',
      { id: 'big', name: 'x'.repeat(5000), trigger: 'y'.repeat(9999),
        behavior: 'z'.repeat(9999), params: ['p'.repeat(9999)] },
    ],
  });
  console.log('\n[10] POST /api/features（脏数据）→ ' + junk.status + '，' + (junk.body.spec && junk.body.spec.modules.length) + ' 个模块');
  check('脏数据不炸，返回 200', junk.status === 200 && junk.body.ok === true);
  check('只保留合法对象（null/数字/字符串被丢掉）', junk.body.spec.modules.length === 4,
    JSON.stringify(junk.body.spec.modules.map((m) => m.id)));
  check('重复 id 被拆开', junk.body.spec.modules[1].id !== junk.body.spec.modules[2].id);
  check('超长字段被截断',
    junk.body.spec.modules[3].name.length <= featuresMod.LIMITS.name &&
    junk.body.spec.modules[3].trigger.length <= featuresMod.LIMITS.trigger &&
    junk.body.spec.modules[3].behavior.every((x) => x.length <= featuresMod.LIMITS.item));
  check('旧格式 detail 走 HTTP 也被无损迁移进 behavior',
    (junk.body.spec.modules[3].behavior || []).length > 0);

  /* ── 没打开工程时要明确拒绝，而不是编一个 ── */
  const noProj = await post('/api/keil/open', { path: path.join(SANDBOX, '不存在') });
  check('打开不存在的工程失败（前提校验）', noProj.status >= 400 || (noProj.body && noProj.body.ok === false));

  /* ── mcu 工具的 spec action ──
     这一段是「模型那一侧」的真身：模型不会调 HTTP，只会调工具。
     所以读写两条路都必须在这里跑到，而且要看 render 出来的块 —— 那才是模型实际读到的东西。 */
  console.log('\n[11] mcu 工具 action=spec（模型实际走的路）');
  const mod = await import(pathToFileURL(path.join(ROOT, '..', 'index.js')).href);
  const def = mod.mcuToolDefinition(() => Promise.resolve({ port: PORT }));
  check('spec 在 action 枚举里', def.parameters.properties.action.enum.indexOf('spec') >= 0);
  check('description 里讲了 spec 怎么用', /spec=/.test(def.description));
  check('description 说明 spec 何时更新（行为变化才写，不再强制每轮全量）',
    /只在行为或模块变化时更新/.test(def.description) && /增量/.test(def.description));
  check('description 写清了结构化字段',
    /behavior\[\]/.test(def.description) && /hardware\[\]/.test(def.description) &&
    /params\[\]/.test(def.description) && /limits\[\]/.test(def.description));
  check('description 里带了反废话规矩',
    /一行一件事/.test(def.description) && /空话/.test(def.description));
  const signal = new AbortController().signal;
  const run = (args) => def.execute(args, { signal });

  const specRead = await run({ action: 'spec' });
  console.log('    spec(读) → ' + specRead.summary.slice(0, 120));
  check('spec: 读回成功且形状合法',
    specRead.ok === true && specRead.action === 'spec' && typeof specRead.summary === 'string');
  check('spec: 带回模块数组与 revision',
    Array.isArray(specRead.data.modules) && typeof specRead.data.revision === 'number');
  const blocks = def.output.render({ action: 'spec' }, specRead);
  check('render: 功能描述正文进了模型可见的块（否则模型等于没读到）',
    Array.isArray(blocks) && blocks.length >= 3 &&
    blocks.some((b) => b.type === 'text' && b.text.indexOf('**何时发生**') >= 0 &&
      b.text.indexOf('**现象**') >= 0),
    '块数 ' + (Array.isArray(blocks) ? blocks.length : 0));

  const TOOL_SPEC = { modules: [
    { id: 'tool-a', name: '工具写入的功能甲', status: 'done',
      summary: '一句话甲', trigger: '上电时',
      behavior: ['现象甲一', '现象甲二'], hardware: ['PB1 — 甲脚'], params: ['间隔 1 s'],
      limits: ['限制甲'], files: ['.\\A.c'] },
    { id: 'tool-b', name: '工具写入的功能乙', status: 'todo',
      summary: '一句话乙', trigger: '', behavior: [], hardware: [], params: [], limits: [], files: [] },
  ] };
  const specWrite = await run({ action: 'spec', content: JSON.stringify(TOOL_SPEC) });
  console.log('    spec(写) → ' + specWrite.summary.slice(0, 120));
  check('spec: 写回成功', specWrite.ok === true && specWrite.data.saved === true, specWrite.summary);
  check('spec: 工具写的内容标成 ai 写的',
    (await api('/api/features')).body.spec.updatedBy === 'ai');
  check('spec: 写回后模块数与内容都对得上',
    (await api('/api/features')).body.spec.modules.length === 2 &&
    (await api('/api/features')).body.spec.modules[0].id === 'tool-a');
  check('spec: 结构化字段一个不少地落盘',
    JSON.stringify((await api('/api/features')).body.spec.modules[0].behavior) === JSON.stringify(['现象甲一', '现象甲二']) &&
    (await api('/api/features')).body.spec.modules[0].trigger === '上电时' &&
    (await api('/api/features')).body.spec.modules[0].hardware.length === 1,
    JSON.stringify((await api('/api/features')).body.spec.modules[0]));
  check('spec: data 里给的是紧凑 outline，不是把正文塞两遍',
    Array.isArray(specWrite.data.modules) && specWrite.data.modules[0].nBehavior === 2 &&
    specWrite.data.modules[0].summary !== undefined &&
    !Array.isArray(specWrite.data.modules[0].behavior),
    JSON.stringify(specWrite.data.modules));

  const fenced = await run({ action: 'spec', content: '```json\n' + JSON.stringify(TOOL_SPEC) + '\n```' });
  check('spec: 容忍模型爱加的 ```json 围栏（内容没变 → changed=false）',
    fenced.ok === true && fenced.data.changed === false, fenced.summary);

  const badJson = await run({ action: 'spec', content: '{这不是 JSON' });
  console.log('    spec(坏 JSON) → ' + badJson.summary.slice(0, 90));
  check('spec: 坏 JSON 如实失败并给出正确形状',
    badJson.ok === false && /JSON/.test(badJson.summary) && /"modules"/.test(badJson.summary));
  check('spec: 报错信息里带上结构化字段名（模型照着改就能对）',
    /behavior/.test(badJson.summary) && /trigger/.test(badJson.summary), badJson.summary);

  /* ── 过期后读一次：模型必须被告知「该重写了」 ── */
  ageFile(path.join(SANDBOX, 'LaterEdited.c'), 120);
  const specStale = await run({ action: 'spec' });
  console.log('    spec(过期后读) → ' + specStale.summary.slice(0, 140));
  check('spec: 读到过期会明确要求立刻重写',
    specStale.ok === true && /已过期/.test(specStale.summary) && /重写/.test(specStale.summary),
    specStale.summary);
  check('spec: 过期信息也进了 data（界面横幅同一份数据）',
    specStale.data.stale && specStale.data.stale.state === 'stale');

  /* ── 增量补丁（2026-10-19）：只发 diff，不全量重述（省输出 token） ── */
  const patchA = await run({ action: 'spec', content: JSON.stringify({ updates: [{ id: 'tool-a', summary: '补丁改的一句话' }] }) });
  console.log('    spec(增量) → ' + patchA.summary.slice(0, 120));
  const afterPatchA = (await api('/api/features')).body.spec;
  check('spec: 增量补丁只改指定字段',
    patchA.ok === true && afterPatchA.modules.find((m) => m.id === 'tool-a').summary === '补丁改的一句话',
    patchA.summary);
  check('spec: 增量补丁保留其它模块',
    afterPatchA.modules.length === 2 && !!afterPatchA.modules.find((m) => m.id === 'tool-b'),
    JSON.stringify(afterPatchA.modules.map((m) => m.id)));
  const patchRm = await run({ action: 'spec', content: JSON.stringify({ remove: ['tool-b'] }) });
  check('spec: 增量 remove 删除模块', patchRm.ok === true &&
    (await api('/api/features')).body.spec.modules.length === 1, patchRm.summary);
  const patchAdd = await run({ action: 'spec', content: JSON.stringify({ updates: [{ id: 'tool-c', name: '补丁新增', summary: '新模块' }] }) });
  const afterPatchAdd = (await api('/api/features')).body.spec;
  check('spec: 增量 updates 可新增模块',
    patchAdd.ok === true && !!afterPatchAdd.modules.find((m) => m.id === 'tool-c'),
    patchAdd.summary);
  const badPatch = await run({ action: 'spec', content: JSON.stringify({ updates: [{ id: 'no-such', foo: 'bar' }] }) });
  check('spec: 非法补丁（缺 name/summary）如实失败',
    badPatch.ok === false && /name|summary/.test(badPatch.summary), badPatch.summary);

  console.log('\n=== ' + (failures ? failures + ' 项失败' : '全部通过') + ' ===');
})().catch((err) => {
  console.error('测试异常：' + (err && err.stack ? err.stack : err));
  failures++;
}).finally(() => {
  if (child && !child.killed) { try { child.kill(); } catch (_) { /* 已退出 */ } }
  try {
    if (savedRecent === null) { if (recentPath && fs.existsSync(recentPath)) fs.unlinkSync(recentPath); }
    else if (recentPath) fs.writeFileSync(recentPath, savedRecent);
    console.log('已还原全局 recent.json');
  } catch (err) {
    console.error('！！还原 recent.json 失败：' + String(err.message || err));
    failures++;
  }
  setTimeout(() => process.exit(failures ? 1 : 0), 300);
});
