'use strict';
/**
 * keil-build.js —— 用**用户 Keil 工程自己的配置**驱动 armcc / armasm / armlink / fromelf
 *
 * 与 build.js 的区别：build.js 编译插件自带的 firmware/projects/<id>/（参数写死）；
 * 这里编译任意一个外部 .uvprojx 工程，文件清单、宏、头路径、优化级别、内存布局
 * 全部来自工程文件本身。
 *
 * ── 中文路径怎么活的 ─────────────────────────────────────────────
 * armcc 是 ANSI 程序，命令行里出现中文会被拆坏。所以：
 *   · cwd 设为工程目录，源文件与 -I 全部用工程文件里的**相对路径原文**（纯 ASCII）；
 *   · 只有 -o / --scatter 用绝对路径，且一律落在插件工作区（纯 ASCII + 空格）。
 * 输出刻意不写进用户工程目录，避免污染；需要对齐 Keil 的 Objects\ 时再显式指定。
 *
 * ── 诊断（2026-10-14 改） ────────────────────────────────────────
 * 以前失败时只回一串文件名（`{file:'..\\User\\main.c'}`），行号/错误码/原文全丢，
 * 界面等于什么都没说。现在所有工具链输出都过 diag.js 解析成结构化诊断，
 * 成功构建时的警告也不再被丢掉（毕设工程本来就有 8 条警告一直看不见）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const toolchain = require('./toolchain');
const { parseUvprojx } = require('./uvprojx');
const { runCommand, parseProgramSize } = require('./build');
const mapMod = require('./mapfile');
const diagMod = require('./diag');
const paths = require('./paths');

/**
 * 某个工程的构建输出根：`<工程目录>/.dsh-mcu/build/keil`。
 *
 * **跟着工程走，不落在插件本体里** —— 这是 2026-10-14 重构的核心：
 *   · 插件目录从此不被运行期数据污染，整包拷走就是干净的一份；
 *   · 换工作区等于换一整套缓存，切回去直接读得到，不用重新编译；
 *   · 顺手消掉「两份副本输出目录同名」那个陷阱 —— 输出不在插件里了，
 *     就没有「读到另一个副本的陈旧产物还打印一致」的可能。
 */
function buildRootFor(model) {
  return paths.keilBuildRoot(model.dir);
}

/** 工程目录名可能是中文：用「ASCII 工程名 + 路径哈希」做稳定且安全的输出目录名 */
function outputKey(model) {
  const h = crypto.createHash('sha1').update(model.dir).digest('hex').slice(0, 8);
  const ascii = String(model.projectName || 'project').replace(/[^A-Za-z0-9_.-]/g, '') || 'project';
  return ascii + '-' + h;
}

function defaultOutDir(model) {
  return path.join(buildRootFor(model), outputKey(model));
}

const h32 = (n) => '0x' + (n >>> 0).toString(16).padStart(8, '0');

/**
 * 工程没指定分散加载文件时，按 .uvprojx 里 <Cpu> 的 IRAM/IROM 生成一份等价布局
 * （就是 Keil 默认那份 scatter 的样子）。
 */
function genScatter(cpu, outFile) {
  const rom = cpu.irom || { base: 0x08000000, size: 0x10000 };
  const ram = cpu.iram || { base: 0x20000000, size: 0x5000 };
  const text = [
    '; 由 stm32-workbench 依 .uvprojx 的 <Cpu> 内存布局自动生成',
    'LR_IROM1 ' + h32(rom.base) + ' ' + h32(rom.size) + '  {',
    '  ER_IROM1 ' + h32(rom.base) + ' ' + h32(rom.size) + '  {',
    '   *.o (RESET, +First)',
    '   *(InRoot$$Sections)',
    '   .ANY (+RO)',
    '   .ANY (+XO)',   // Keil 生成的 .sct 里有这一行，照抄才能完全一致
    '  }',
    '  RW_IRAM1 ' + h32(ram.base) + ' ' + h32(ram.size) + '  {',
    '   .ANY (+RW +ZI)',
    '  }',
    '}',
    '',
  ].join('\n');
  fs.writeFileSync(outFile, text, 'utf8');
  return outFile;
}

/** 相对路径 → 扁平对象文件名，例如 .\Hardware\OLED.c → Hardware_OLED.o */
function objectName(raw, ext) {
  const flat = String(raw).replace(/^\.?[\\/]+/, '').replace(/[\\/]+/g, '_').replace(/\.\._/g, '');
  return flat.replace(/\.[^.]+$/, '') + ext;
}

/**
 * 编译一个 Keil 工程。
 *
 * @param {object}   opts
 * @param {string}   opts.projectFile  .uvprojx 绝对路径（也可以是包含它的目录）
 * @param {string}  [opts.outDir]      产物目录；缺省落在插件工作区
 * @param {Function}[opts.onLine]      (line, tag) 逐行回调，tag ∈ cmd|build|error|diag|phase
 * @returns {Promise<object>} { ok, stage, model, programSize, artifact, outDir,
 *                             diagnostics, warnings, errors, failedFiles }
 *          diagnostics 是结构化诊断；warnings/errors 是它按严重度分好的两份。
 */
async function buildKeil(opts) {
  const { projectFile, outDir, onLine = () => {} } = opts || {};
  if (!projectFile) throw new Error('缺少 projectFile（.uvprojx 路径）');

  // 允许直接给目录：在里面找 .uvprojx
  let pf = projectFile;
  if (fs.existsSync(pf) && fs.statSync(pf).isDirectory()) {
    const hit = fs.readdirSync(pf).filter((f) => /\.uvprojx$/i.test(f))[0];
    if (!hit) throw new Error('这个目录里没有 .uvprojx：' + pf);
    pf = path.join(pf, hit);
  }

  const model = parseUvprojx(pf);

  /* 工程配置里已知的硬错误：先摊开给用户看，别急着编译 */
  const errors = model.diagnostics.filter((d) => d.level === 'error');
  model.diagnostics.filter((d) => d.level !== 'error').forEach((d) => {
    onLine('[' + d.level.toUpperCase() + '] ' + d.message, 'diag');
  });
  if (errors.length) {
    errors.forEach((d) => onLine('[ERROR] ' + d.message, 'error'));
    return {
      ok: false, stage: 'parse', model, outDir: null,
      diagnostics: errors, warnings: [], errors, failedFiles: [],
      programSize: null, artifact: null,
    };
  }

  const env = toolchain.detectEnv();
  const cc = env.compilers.find((c) => c.id === 'keil-ac5' && c.usable);
  if (!cc) {
    throw new Error('没有找到可用的 armcc（Keil MDK AC5）。请安装 Keil MDK，或用 -KeilRoot 指定路径。');
  }
  onLine('工具链：' + cc.name + ' @ ' + cc.exe, 'phase');

  const absOut = outDir ? path.resolve(outDir) : defaultOutDir(model);
  fs.rmSync(absOut, { recursive: true, force: true });
  fs.mkdirSync(absOut, { recursive: true });

  const cwd = model.dir; // 相对路径的锚点，同时避开 armcc 的中文 argv 问题
  const scatter = model.scatterFileAbs || genScatter(model.cpu, path.join(absOut, '_autogen.ld'));
  onLine('分散加载：' + (model.scatterFileAbs ? '工程自带 ' + model.scatterFile : '按 <Cpu> 自动生成') + ' → ' + scatter, 'phase');

  const incArgs = model.includes.map((i) => '-I' + i.raw);
  const defArgs = model.defines.map((d) => '-D' + d);
  const cpu = model.cpu.core || 'Cortex-M3';

  const objects = [];
  const failList = [];
  let ok = true;

  /* 所有诊断统一收在这里（结构化：文件 / 行号 / 错误码 / 原文） */
  const diagnostics = [];
  /**
   * 包一层 onLine：顺手把诊断抠出来；错误行改打 'error' 标签，界面才能标红。
   * @param {string} tool 工具名，写进诊断便于回溯
   * @param {?string} file 当前文件；输出行里没写文件名时用它兜底
   */
  const tap = (tool, file) => (l) => {
    const d = diagMod.parseLine(l, { tool, file });
    if (d) diagnostics.push(d);
    onLine(l, d && d.level === 'error' ? 'error' : 'build');
  };

  /** 收尾时把诊断按严重度分好，并去掉 stdout/stderr 各打一次造成的重复 */
  const finish = (extra) => {
    const uniq = diagMod.dedupe(diagnostics);
    return Object.assign({
      model, diagnostics: uniq,
      warnings: uniq.filter((d) => d.level === 'warning'),
      errors: uniq.filter((d) => d.level === 'error'),
      failedFiles: failList,
    }, extra);
  };

  /* ── 1) C 源文件 ── */
  const cFiles = model.sources.filter((f) => f.kind === 'c');
  onLine('编译 ' + cFiles.length + ' 个 C 文件（' + model.optimFlag + '）', 'phase');
  for (const f of cFiles) {
    const objAbs = path.join(absOut, objectName(f.raw, '.o'));
    const args = [
      '--c99', '--cpu', cpu, model.optimFlag, '-g', '--apcs=interwork', '--split_sections',
      ...defArgs, ...incArgs, '-c', f.raw, '-o', objAbs,
    ];
    onLine('armcc ' + f.raw, 'cmd');
    const r = await runCommand(cc.exe, args, cwd, tap('armcc', f.raw));
    if (r.code !== 0) {
      ok = false;
      failList.push(f.raw);
      onLine('armcc 失败（退出码 ' + r.code + '）：' + f.raw, 'error');
    }
    objects.push(objAbs);
  }

  /* ── 2) 汇编启动文件 ── */
  const asmFiles = model.sources.filter((f) => f.kind === 'asm');
  for (const f of asmFiles) {
    if (!cc.asm) {
      ok = false;
      failList.push(f.raw);
      onLine('找不到 armasm，无法汇编启动文件', 'error');
      continue;
    }
    const objAbs = path.join(absOut, objectName(f.raw, '.o'));
    onLine('armasm ' + f.raw, 'cmd');
    const r = await runCommand(cc.asm, ['--cpu', cpu, '--apcs=interwork', f.raw, '-o', objAbs],
      cwd, tap('armasm', f.raw));
    if (r.code !== 0) {
      ok = false;
      failList.push(f.raw);
      onLine('armasm 失败（退出码 ' + r.code + '）：' + f.raw, 'error');
    }
    objects.push(objAbs);
  }

  if (!ok) {
    onLine('编译阶段有错误，已停止链接', 'error');
    return finish({ ok: false, stage: 'compile', outDir: absOut, programSize: null, artifact: null });
  }

  /* ── 3) 链接 ── */
  const axf = path.join(absOut, model.outputName + '.axf');
  onLine('armlink', 'cmd');
  const rLink = await runCommand(cc.linker, [
    '--cpu', cpu, '--info', 'summarysizes', '--map', '--scatter', scatter,
    '--entry', 'Reset_Handler', ...objects, '-o', axf,
  ], cwd, tap('armlink', null));
  const programSize = parseProgramSize(rLink.stdout + rLink.stderr);
  /* --map 把内存映射打在 stdout：解析出每个对象/函数真实占了多少（链接后，未用的已被删） */
  const mapText = rLink.stdout + rLink.stderr;
  const map = mapMod.parseMap(mapText);
  map.objects.forEach((o) => { o.source = mapMod.labelObject(o.name, model); });
  map.functions.forEach((f) => { f.source = mapMod.labelObject(f.object, model); });
  /* 顺手把完整 map 落成文件（用户问题记录第 4 条：构建目录里只有 .axf/.hex/.bin）。
     armlink 的 --map 输出本来就在手里，落盘成本为零；以后想查「某个符号落在哪」
     不必再自己跑 fromelf / 翻日志。 */
  let mapFile = null;
  if (rLink.code === 0) {
    mapFile = path.join(absOut, model.outputName + '.map');
    try { fs.writeFileSync(mapFile, mapText, 'utf8'); } catch (_) { /* 落不了盘不影响构建 */ }
  }
  if (rLink.code !== 0) {
    onLine('链接失败（退出码 ' + rLink.code + '）——常见原因：超出 Flash/SRAM、缺 Reset_Handler、scatter 与器件不符', 'error');
    return finish({ ok: false, stage: 'link', outDir: absOut, programSize, artifact: null });
  }
  if (programSize) {
    onLine('Program Size: Code=' + programSize.code + ' RO-data=' + programSize.rodata +
      ' RW-data=' + programSize.rwdata + ' ZI-data=' + programSize.zidata, 'phase');
    onLine('占用：Flash ' + programSize.flashBytes + ' B / ' + (model.cpu.irom ? model.cpu.irom.size : 65536) +
      ' B（' + (programSize.flashBytes / (model.cpu.irom ? model.cpu.irom.size : 65536) * 100).toFixed(1) + '%）' +
      ' · SRAM ' + programSize.ramBytes + ' B / ' + (model.cpu.iram ? model.cpu.iram.size : 20480) + ' B（' +
      (programSize.ramBytes / (model.cpu.iram ? model.cpu.iram.size : 20480) * 100).toFixed(1) + '%）', 'phase');
    programSize.flashKB = model.cpu.irom ? model.cpu.irom.size / 1024 : 64;
    programSize.ramKB = model.cpu.iram ? model.cpu.iram.size / 1024 : 20;
  }

  /* ── 4) hex / bin ── */
  const hex = path.join(absOut, model.outputName + '.hex');
  const bin = path.join(absOut, model.outputName + '.bin');
  onLine('fromelf → hex/bin', 'cmd');
  const rHex = await runCommand(cc.fromelf, ['--i32combined', '--output', hex, axf], cwd, tap('fromelf', null));
  const rBin = await runCommand(cc.fromelf, ['--bin', '--output', bin, axf], cwd, tap('fromelf', null));
  if (rHex.code !== 0 || rBin.code !== 0) {
    ok = false;
    onLine('fromelf 生成产物失败', 'error');
  }

  const artifact = ok ? { axf, hex, bin, map: mapFile } : null;
  if (ok) {
    onLine('构建成功：' + (artifact.hex ? path.basename(artifact.hex) : '') + ' / ' + path.basename(artifact.bin), 'phase');
  }

  return finish({ ok, stage: 'done', outDir: absOut, programSize, artifact, map });
}

module.exports = { buildKeil, parseUvprojx, genScatter, defaultOutDir, outputKey, buildRootFor };
