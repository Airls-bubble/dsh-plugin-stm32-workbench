'use strict';
/**
 * sync-to-dsh.cjs —— 把本目录（DSH 实际加载的源码）同步到**可选的便携副本**
 * `~\.dsh\local-plugins\stm32-workbench`。
 *
 * 加载关系（2026-10-18 修正）：
 *   · 代码（index.js / client.js）与后端都由 DSH 从本目录加载 ——
 *     `profiles\desktop\node_modules\dsh-plugin-stm32-workbench` 是指向本目录的符号链接，
 *     `config.backendDir` 留空 → 后端取 `index.js` 旁的 `backend/`（/mcu/state 实测 codeDir==backendDir）；
 *   · `~\.dsh\local-plugins\stm32-workbench` **不被 profile 加载**，只是「拷走能用」的便携副本，
 *     也是后端目录的第三候选兜底（本目录的 backend 丢了才会用到）。
 *
 * 所以：**正常开发不需要运行本脚本**。只有确实想在 local-plugins 留一份可移植副本时才跑，
 * 而且跑完必须重启 DSH/后端才会用上（装载器不热替换）。旧版本文档误称「后端从 local-plugins spawn」，
 * 已按实测修正 —— 不要把它当成运行期必须同步的第二份代码。
 *
 * 这个脚本因此必须可靠：一旦写出坏文件，症状是「后端启动即死、界面只显示未连接」，
 * 而根因（比如 package.json 被截成 0 字节）在界面上完全看不见。
 * 所以复制之后一律**逐字节校验**，不对就立刻中止并说明。
 *
 * 只同步代码与数据，不动 10 MB 的便携工具链和 build 产物。
 */
const fs = require('fs');
const path = require('path');

const SRC = __dirname;
const DST = path.join(process.env.USERPROFILE || '', '.dsh', 'local-plugins', 'stm32-workbench');

const ITEMS = [
  'client.js',
  'index.js',
  'package.json',
  // DSH 0.2.1 起的显示元数据：漏同步会让副本的 exports 指向不存在的文件（加载即坏）。
  'locale',
  'icon.svg',
  // cordis.patch.yml 也要同步：它在安装时定义 host 插件行的 config（比如 backendDir 留空），
  // 漏掉它的话，重新安装时用到的还是旧配置。
  'cordis.patch.yml',
  'README.md',
  'PORTING.md',
  // 问题台账：跨机器也要带着，不然换了电脑又从头踩一遍
  'ISSUES.md',
  '.gitignore',
  'AGENT.md',
  path.join('backend', 'server'),
  path.join('backend', 'scripts'),
  path.join('backend', 'data'),
  path.join('backend', 'package.json'),
  path.join('backend', 'AGENT.md'),
  path.join('backend', 'README.md'),
];

if (!fs.existsSync(DST)) {
  console.error('✗ DSH 插件目录不存在：' + DST);
  console.error('  先确认插件已安装（plugin_manager install_bundle）。');
  process.exit(1);
}

/* 防「往自己身上拷」：copyFileSync 同源同目标会把文件截成 0 字节，
   这正是 package.json 变 0 字节最典型的成因，先挡掉。 */
try {
  if (fs.realpathSync(SRC) === fs.realpathSync(DST)) {
    console.error('✗ 源与目标是同一个目录：' + SRC);
    console.error('  往自己身上拷会把文件截成 0 字节，已中止。');
    process.exit(2);
  }
} catch (_) { /* realpath 失败不致命，下面的逐字节校验兜底 */ }

console.log('源  ：' + SRC);
console.log('目标：' + DST);
console.log('─'.repeat(70));

/** 单文件校验：必须存在、非 0 字节、且与源逐字节一致 */
function verifyFile(sp, dp) {
  if (!fs.existsSync(dp)) return '目标不存在';
  const a = fs.readFileSync(sp);
  const b = fs.readFileSync(dp);
  if (a.length === 0) return null;                       // 源本来就是空的，不算错
  if (b.length === 0) return '目标被截成 0 字节';
  if (!a.equals(b)) return '内容不一致（' + a.length + ' B vs ' + b.length + ' B）';
  return null;
}

/** 递归校验一个目录 */
function verifyTree(sp, dp, prefix) {
  const bad = [];
  for (const e of fs.readdirSync(sp, { withFileTypes: true })) {
    const s = path.join(sp, e.name);
    const d = path.join(dp, e.name);
    const r = (prefix ? prefix + '/' : '') + e.name;
    if (e.isDirectory()) bad.push(...verifyTree(s, d, r));
    else {
      const why = verifyFile(s, d);
      if (why) bad.push(r + ' → ' + why);
    }
  }
  return bad;
}

let n = 0;
const problems = [];

for (const item of ITEMS) {
  const sp = path.join(SRC, item);
  const dp = path.join(DST, item);
  if (!fs.existsSync(sp)) { console.log('  跳过（源不存在）：' + item); continue; }
  const st = fs.statSync(sp);
  let bad = [];
  if (st.isDirectory()) {
    fs.rmSync(dp, { recursive: true, force: true });
    fs.cpSync(sp, dp, { recursive: true });
    bad = verifyTree(sp, dp, '');
    let count = 0;
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name)); else count++;
      }
    })(sp);
    console.log((bad.length ? '  ✗ ' : '  ✓ ') + item + '/  （' + count + ' 个文件' +
      (bad.length ? '，校验失败 ' + bad.length + ' 项' : '，逐字节一致') + '）');
  } else {
    fs.mkdirSync(path.dirname(dp), { recursive: true });
    fs.copyFileSync(sp, dp);
    const why = verifyFile(sp, dp);
    if (why) bad.push(item + ' → ' + why);
    console.log((bad.length ? '  ✗ ' : '  ✓ ') + item + '  （' + st.size + ' B' +
      (bad.length ? '，校验失败：' + why : '，逐字节一致') + '）');
  }
  bad.forEach((b) => problems.push(b));
  n++;
}

console.log('─'.repeat(70));

if (problems.length) {
  console.error('✗ 同步后校验失败 ' + problems.length + ' 项：');
  problems.forEach((p) => console.error('   · ' + p));
  console.error('\n**先别重启 DSH** —— 这份副本是坏的，后端会启动即死。');
  console.error('重跑一次同步；若仍失败，检查杀毒软件/文件锁，或手工复制那一项。');
  process.exit(4);
}

console.log('同步完成：' + n + ' 项，全部与源逐字节一致 ✓');
console.log('');
console.log('⚠ 接下来必须让 DSH 重新加载：');
console.log('   1. 客户端界面（client.js）→ 重启 DSH + 刷新页面');
console.log('   2. 后端与工具（server/*.js、index.js）→ 重启 DSH');
