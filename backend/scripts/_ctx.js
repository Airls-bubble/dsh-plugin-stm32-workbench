'use strict';
/**
 * _ctx.js —— 诊断脚本共用的路径解析与服务自检（P0-4 的底座）
 *
 * ── 为什么要有这个文件 ────────────────────────────────────────────
 * backend/scripts 里的诊断脚本是「为什么我们的构建和 Keil 差 48 字节」那次调试的产物。
 * 当时为了省事，把调试现场的绝对路径写死进了源码：
 *
 *     const OURS_DIR = '<某个写死的绝对路径>\\backend\\firmware\\build\\keil\\Project-b04c7833';
 *
 * 危险的地方不是「跑不起来」，而是**跑起来更像对的**：
 *   · 插件真正在用的是 DSH 本地插件目录（`~/.dsh/local-plugins/...`）那一份；
 *   · 而 keil-build.js 的 outputKey() 是「工程名 + 路径哈希」，两份目录**同名**；
 *   · 于是脚本会去读 D 盘那份陈旧的产物，跟参照构建一比，打印「0 差异」——
 *     一个与当前代码毫无关系的绿灯。这比脚本直接报错坏得多。
 *
 * ── 规矩 ──────────────────────────────────────────────────────────
 *   1. 一切路径从**这个文件所在的位置**推出来，源码里不出现任何绝对路径；
 *   2. 缺东西就抛错，绝不静默退化或使用陈旧数据；
 *   3. 命令行可覆盖：--project <uvprojx|目录>、--build-dir <目录>。
 */

const fs = require('fs');
const path = require('path');

/** <plugin>/backend/scripts → <plugin>/backend */
const BACKEND = path.resolve(__dirname, '..');
/** <plugin>/backend → <plugin> */
const PLUGIN = path.resolve(BACKEND, '..');
/** 跨工程的工作数据（只有「上次打开的工程」这类） */
const BUILD = require('../server/paths').globalRoot();

class ScriptError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ScriptError';
  }
}

/** 读命令行里的 `--name value`（也支持 `--name=value`） */
function arg(name) {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1];
    if (argv[i].indexOf(name + '=') === 0) return argv[i].slice(name.length + 1);
  }
  return undefined;
}

/** 缺文件就大声失败，并把「该怎么补」写清楚 */
function requirePath(p, what) {
  if (!p) throw new ScriptError('缺少' + (what || '路径') + '。');
  if (!fs.existsSync(p)) {
    throw new ScriptError('找不到' + (what || '文件') + '：' + p + '\n' +
      '  · 若是工程路径：先在 DSH 工作台里打开一次 Keil 工程，或用 --project 指定。');
  }
  return p;
}

/**
 * 当前打开的 Keil 工程。后端把这件事记在全局的 recent.json 里
 * （<DSH_HOME>/mcu/recent.json —— 「上次打开哪个工程」是跨工程的记忆）。
 * @param {string} [override] 命令行 --project 的值
 */
function projectFile(override) {
  const explicit = override || arg('--project') || arg('-p') || process.env.MCU_PROJECT;
  if (explicit) {
    let p = String(explicit).trim().replace(/^["'\u201c\u201d]+/, '').replace(/["'\u201c\u201d]+$/, '');
    p = path.resolve(p);
    requirePath(p, '工程路径');
    if (fs.statSync(p).isDirectory()) {
      const hit = fs.readdirSync(p).filter((f) => /\.uvprojx$/i.test(f))[0];
      if (!hit) throw new ScriptError('这个目录里没有 .uvprojx：' + p);
      return path.join(p, hit);
    }
    return p;
  }
  const recent = path.join(BUILD, 'recent.json');
  if (!fs.existsSync(recent)) {
    throw new ScriptError('没有「当前工程」记录：' + recent + '\n' +
      '  · 这是后端打开工程时写下的。先在工作台里打开一次工程，或用 --project <路径> 指定。');
  }
  let j;
  try { j = JSON.parse(fs.readFileSync(recent, 'utf8')); } catch (err) {
    throw new ScriptError('工程记录读不动：' + recent + '（' + err.message + '）');
  }
  requirePath(j && j.file, '记录里的工程');
  return j.file;
}

/** 工程所在目录 */
function projectDir(override) {
  return path.dirname(projectFile(override));
}

/** 某个工程的工作数据目录：<工程>/.dsh-mcu（只读工程会退到全局） */
function dataRoot(override) {
  return require('../server/paths').projectRoot(projectDir(override));
}

/** 某个工程的构建输出根：<工程>/.dsh-mcu/build/keil（与 keil-build.js 一致） */
function keilBuildRoot(override) {
  return path.join(dataRoot(override), 'build', 'keil');
}

/** 某个工程的长日志目录 */
function logsDir(override) {
  return path.join(dataRoot(override), 'logs');
}

/** 构建输出根下所有产物目录，按修改时间新→旧 */
function buildDirs() {
  const root = keilBuildRoot();
  if (!fs.existsSync(root)) {
    throw new ScriptError('这个工程还没有构建产物：' + root + '\n  · 先构建一次。');
  }
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const p = path.join(root, e.name);
      return { name: e.name, dir: p, mtime: fs.statSync(p).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

/**
 * 当前工程最新的那次构建产物目录。
 *
 * 2026-10-14 起产物落在**工程自己的** `.dsh-mcu/build/keil/` 下，不再在插件本体里。
 * 这从结构上消掉了老陷阱：以前插件有多个副本、而输出目录名由工程路径哈希决定，
 * 同名目录会让人比对到**另一个副本的陈旧产物**还打印「0 差异」。
 */
function latestBuildDir(override) {
  const explicit = override || arg('--build-dir') || process.env.MCU_BUILD_DIR;
  if (explicit) return requirePath(path.resolve(String(explicit).trim().replace(/^["']|["']$/g, '')), '产物目录');
  const dirs = buildDirs();
  if (!dirs.length) throw new ScriptError('这个工程还没有构建产物目录，先构建一次。');
  return dirs[0].dir;
}

/** Keil UV4 参照构建的输出目录（keil-uv4-ref.js 造出来的那份，按工程放） */
function uv4RefDir(override) {
  return path.join(dataRoot(override), 'uv4-ref', 'Objects');
}

/**
 * Keil 工具链路径，全部来自 toolchain.detectEnv() —— 不再写死 C:\Keil_v5。
 * UV4 由 armcc 的位置反推（<KeilRoot>\ARM\ARMCC\bin\armcc.exe → <KeilRoot>\UV4\UV4.exe）。
 */
function keilTools() {
  const toolchain = require('../server/toolchain');
  const env = toolchain.detectEnv();
  const ac5 = (env.compilers || []).find((c) => c.id === 'keil-ac5' && c.usable);
  if (!ac5 || !ac5.exe) {
    throw new ScriptError('没找到可用的 armcc（Keil MDK AC5）。装好 Keil 或设 KEIL_ROOT 环境变量。');
  }
  // <KeilRoot>\ARM\ARMCC\bin\armcc.exe → 上溯 4 层
  const keilRoot = path.resolve(path.dirname(ac5.exe), '..', '..', '..', '..');
  const uv4 = path.join(keilRoot, 'UV4', 'UV4.exe');
  return {
    root: keilRoot,
    armcc: ac5.exe,
    armasm: ac5.asm || null,
    armlink: ac5.linker || null,
    fromelf: ac5.fromelf || null,
    uv4: fs.existsSync(uv4) ? uv4 : null,
  };
}

/**
 * 产物是否比源码旧 —— 「比对到旧产物还打印一致」的正面拦截。
 * @returns {?string} 陈旧就返回一句人话警告，新鲜返回 null
 */
function staleness(dir, projDir) {
  if (!fs.existsSync(dir)) return '产物目录不存在：' + dir;
  const newest = (root, exts, skip) => {
    let best = 0;
    const stack = [root];
    while (stack.length) {
      const d = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
      for (const e of entries) {
        if (e.isDirectory()) {
          if (skip && skip.indexOf(e.name) >= 0) continue;
          stack.push(path.join(d, e.name));
        } else if (exts.test(e.name)) {
          try { best = Math.max(best, fs.statSync(path.join(d, e.name)).mtimeMs); } catch (_) { /* 忽略 */ }
        }
      }
    }
    return best;
  };
  const artTime = newest(dir, /\.(axf|hex|bin|o|map)$/i, null);
  const srcTime = projDir ? newest(projDir, /\.(c|h|s|sct)$/i, ['Objects', 'Listings', '.git', 'build', '.uv4-ref-tmp']) : 0;
  if (!artTime) return '产物目录里没有 .axf/.hex/.bin/.o：' + dir;
  if (srcTime > artTime + 1000) {
    return '产物比源码旧：产物 ' + new Date(artTime).toLocaleString() +
      '，源码 ' + new Date(srcTime).toLocaleString() + '　→ 请先重新构建，否则比对结果没有意义。';
  }
  return null;
}

/** 统一的「要死了」出口：打印一句能照做的提示 */
function die(err) {
  const msg = err && err.message ? err.message : String(err);
  console.error('\n[脚本中止] ' + msg + '\n');
  process.exit(err instanceof ScriptError ? 3 : 1);
}

module.exports = {
  BACKEND, PLUGIN, BUILD,
  ScriptError, arg, requirePath,
  projectFile, projectDir, dataRoot, keilBuildRoot, logsDir,
  buildDirs, latestBuildDir, uv4RefDir, keilTools, staleness, die,
};
