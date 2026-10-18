'use strict';
/**
 * paths.js —— 工作台的数据落在哪儿
 *
 * 三条原则（2026-10-14 定，起因是插件本体被运行期数据撑到 61 MB、且散在三处副本）：
 *
 *   ① **插件本体只装代码**。运行期不往插件自己的目录里写任何东西 ——
 *      整个插件目录拷到别的机器就是干净的一份，不需要先做清理。
 *   ② **跟某个工程有关的一切**都放在「该工程目录下的 .dsh-mcu/」：
 *      构建产物、构建账本、链接日志、源码备份、UV4 参照构建、临时配置。
 *      换工作区 = 换一整套缓存；切回去直接读得到，不用重新编译。
 *   ③ **只有跨工程的记忆**（上次打开的是哪个工程）才放全局：<DSH_HOME>/mcu/recent.json。
 *
 * 顺带修掉一个真错误：原来构建账本是**全局唯一一份**，切换工程后会把旧工程的
 * programSize/map 拿来当新工程的占用数据展示（界面上还挂着新工程的名字）。
 * 按工程分开存之后，这个错误在结构上就不可能发生。
 *
 * .dsh-mcu/ 里会自动放一个 .gitignore（内容就是 `*`），用户不会误提交。
 * 工程目录只读时（网络盘、受保护目录）自动退到 <DSH_HOME>/mcu/projects/<哈希>/。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

/** 工作数据目录名（放在被选工程目录下，隐藏 + 自带 .gitignore） */
const DATA_DIR_NAME = '.dsh-mcu';

/** DSH 主目录 */
function dshHome() {
  if (process.env.DSH_HOME) return process.env.DSH_HOME;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return path.join(home, '.dsh');
}

/** 跨工程的数据（只有「上次打开的工程」这类） */
function globalRoot() {
  return path.join(dshHome(), 'mcu');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 某个工程的工作数据根目录。
 *
 * 优先 `<工程目录>/.dsh-mcu/`；建不出来（目录只读）就退到全局
 * `<DSH_HOME>/mcu/projects/<路径哈希>/`，并在里面留一张纸条说明为什么在这儿。
 *
 * @param {string} projectDir 被选工程目录（.uvprojx 所在目录）
 * @returns {string}
 */
function projectRoot(projectDir) {
  if (!projectDir) throw new Error('paths.projectRoot 需要工程目录');
  const local = path.join(projectDir, DATA_DIR_NAME);
  try {
    ensureDir(local);
    const marker = path.join(local, '.gitignore');
    if (!fs.existsSync(marker)) {
      fs.writeFileSync(marker,
        '# 这是 stm32-workbench 的工作数据目录（构建产物、账本、日志、源码备份）。\n' +
        '# 全部都可以安全删除 —— 下次构建会重新生成。\n*\n', 'utf8');
    }
    return local;
  } catch (_) {
    const key = crypto.createHash('sha1').update(path.resolve(projectDir)).digest('hex').slice(0, 12);
    const fallback = ensureDir(path.join(globalRoot(), 'projects', key));
    const note = path.join(fallback, 'WHY-HERE.txt');
    if (!fs.existsSync(note)) {
      fs.writeFileSync(note,
        '工程目录写不进去（只读或受保护），所以工作数据退到了这里。\n' +
        '原工程目录：' + projectDir + '\n', 'utf8');
    }
    return fallback;
  }
}

/* ── 按工程分的各种子目录/文件 ─────────────────────────────────── */

/** Keil 工程构建输出根：<工程>/.dsh-mcu/build/keil */
function keilBuildRoot(projectDir) {
  return path.join(projectRoot(projectDir), 'build', 'keil');
}

/** 构建账本（programSize / map / 诊断 / 产物路径）：一个工程一份 */
function ledgerFile(projectDir) {
  return path.join(projectRoot(projectDir), 'last-build.json');
}

/** 长日志（armlink --map 的完整输出等） */
function logsDir(projectDir) {
  return ensureDir(path.join(projectRoot(projectDir), 'logs'));
}

/** 源码写回前的备份 */
function srcBackupDir(projectDir, stamp) {
  const base = path.join(projectRoot(projectDir), 'src-backup');
  return stamp ? ensureDir(path.join(base, stamp)) : ensureDir(base);
}

/** UV4 参照构建（用于「与 Keil 逐字节一致」的验证）：按工程放 */
function uv4RefRoot(projectDir) {
  return path.join(projectRoot(projectDir), 'uv4-ref');
}

/** 参数实验、诊断沙箱之类的临时目录 */
function tmpDir(projectDir, name) {
  return ensureDir(path.join(projectRoot(projectDir), 'tmp', name || ''));
}

/** OpenOCD / 寄存器读取用的临时脚本目录 */
function ocdTmpDir(projectDir) {
  return ensureDir(path.join(projectRoot(projectDir), 'tmp', 'ocd'));
}

/* ── 全局的 ─────────────────────────────────────────────────────── */

/** 「上次打开哪个工程」—— 唯一一处跨工程记忆 */
function recentFile() {
  return path.join(globalRoot(), 'recent.json');
}

/**
 * 一次性临时文件（OpenOCD 的 cfg 之类）。
 * 放系统临时目录：既不进插件本体，也不进用户工程，随系统清理。
 * 注意 OpenOCD 是 ANSI 程序，这个路径要尽量 ASCII —— 系统临时目录在绝大多数
 * 机器上满足（若用户名是中文，两者都不行，那是 OpenOCD 本身的限制）。
 */
function transientDir() {
  return ensureDir(path.join(os.tmpdir(), 'dsh-mcu'));
}

/** 整片 Flash 备份的存放处：优先工程目录下，其次全局 */
function backupDirs(projectDir) {
  const dirs = [];
  if (projectDir) dirs.push(path.join(projectRoot(projectDir), 'backup'));
  dirs.push(path.join(globalRoot(), 'backup'));
  return dirs.map(ensureDir);
}

/** 便携工具链、引脚数据等只读资源仍然在插件本体里（那是代码的一部分，不是数据） */

/* ── 一次性迁移（2026-10-14 数据目录重构）─────────────────────────── */

/**
 * 老版本把「上次打开哪个工程」和构建账本记在**插件本体内**的 backend/build/ 下；
 * 新版本前者进全局 recent.json，后者按工程进 <工程>/.dsh-mcu/。
 * 不搬的话，升级后用户会莫名其妙地「忘了之前开的工程」。
 *
 * 幂等：目标已存在就不动。返回搬了哪几样，方便调用方打一行日志。
 */
function migrateLegacyState() {
  const backendRoot = path.resolve(__dirname, '..');
  const legacyDir = path.join(backendRoot, 'build');
  const moved = [];
  const copyIfMissing = (from, to, label) => {
    try {
      if (fs.existsSync(to) || !fs.existsSync(from)) return;
      ensureDir(path.dirname(to));
      fs.copyFileSync(from, to);
      moved.push(label);
    } catch (_) { /* 搬不动就算了，不影响使用 */ }
  };
  copyIfMissing(path.join(legacyDir, 'keil-recent.json'), recentFile(), 'recent');
  try {
    const j = JSON.parse(fs.readFileSync(recentFile(), 'utf8'));
    if (j && j.file) {
      copyIfMissing(path.join(legacyDir, 'keil-last-build.json'),
        ledgerFile(path.dirname(j.file)), 'ledger');
    }
  } catch (_) { /* 没有旧记录 */ }
  return moved;
}

module.exports = {
  DATA_DIR_NAME,
  dshHome, globalRoot, projectRoot,
  keilBuildRoot, ledgerFile, logsDir, srcBackupDir, uv4RefRoot, tmpDir, ocdTmpDir,
  recentFile, transientDir, backupDirs, ensureDir, migrateLegacyState,
};
