'use strict';
/**
 * build.js —— Keil AC5 构建流程
 *
 * armcc → armasm → armlink → fromelf，全部用相对路径 + cwd 执行。
 * 为什么不用 make/cmake：这台机器上没有它们，而 Keil 的 AC5 已经够用；
 * 而且相对路径同时解决了中文目录在 armcc ANSI 命令行下被拆坏的问题。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const toolchain = require('./toolchain');

const ROOT = toolchain.ROOT;
const PROJECTS_DIR = path.join(ROOT, 'firmware', 'projects');
/* 自带测试工程的构建输出：放到全局工作数据目录，不写进插件本体 ——
   插件目录只装代码，这样整包拷到别的机器就是干净的一份（2026-10-14 重构）。 */
const paths = require('./paths');
const BUILD_DIR = paths.ensureDir(path.join(paths.globalRoot(), 'build'));
const BSP = path.join('firmware', 'bsp');

/** 工程名只允许安全字符：它要进命令行，不能有空格、中文、.. */
function assertSafeName(name) {
  if (!name || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(name) || name.includes('..')) {
    const e = new Error('工程名只允许字母/数字/下划线/短横线点，且不能以特殊字符开头：' + name);
    e.code = 'BAD_NAME';
    throw e;
  }
  return name;
}

function projectDir(name) {
  return path.join(PROJECTS_DIR, assertSafeName(name));
}

function listSourceFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['build', 'obj', '.git', 'node_modules'].includes(e.name)) continue;
      out.push(...listSourceFiles(p));
    } else if (/\.(c|C)$/.test(e.name)) {
      out.push(e.name);
    }
  }
  return out;
}

function listProjects() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  const out = [];
  for (const e of fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = path.join(PROJECTS_DIR, e.name);
    const metaFile = path.join(dir, 'project.json');
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch (_) { /* 允许没有 meta */ }
    const stat = fs.statSync(dir);
    out.push({
      id: e.name, name: meta.name || e.name, path: dir,
      mcu: meta.mcu || 'STM32F103C8T6', template: meta.template || null,
      note: meta.note || '',
      sources: listSourceFiles(dir).length,
      createdAt: stat.birthtime ? stat.birthtime.toISOString() : stat.ctime.toISOString(),
      lastBuildAt: meta.lastBuildAt || null,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

function ensureTemplate(templateId) {
  const src = path.join(ROOT, 'firmware', 'template', templateId || 'blink-uart');
  if (!fs.existsSync(src)) throw new Error('模板不存在：' + templateId);
  return src;
}

function createProject(id, name, templateId) {
  assertSafeName(id);
  const dest = projectDir(id);
  if (fs.existsSync(dest)) { const e = new Error('工程已存在：' + id); e.code = 'EXISTS'; throw e; }
  const src = ensureTemplate(templateId);
  fs.mkdirSync(dest, { recursive: true });
  for (const f of fs.readdirSync(src, { withFileTypes: true })) {
    if (f.isDirectory()) continue;
    fs.copyFileSync(path.join(src, f.name), path.join(dest, f.name));
  }
  fs.writeFileSync(path.join(dest, 'project.json'), JSON.stringify({
    id, name: name || id, mcu: 'STM32F103C8T6', template: templateId || 'blink-uart',
    createdAt: new Date().toISOString(),
  }, null, 2));
  return { id, name: name || id, path: dest };
}

/** 从 armlink 输出里抠出 Program Size —— 这就是给界面看的 ROM/RAM 账本 */
function parseProgramSize(text) {
  const m = /Program Size:\s*Code=(\d+)\s*RO-data=(\d+)\s*RW-data=(\d+)\s*ZI-data=(\d+)/.exec(text || '');
  if (!m) return null;
  const code = +m[1], ro = +m[2], rw = +m[3], zi = +m[4];
  return {
    code, rodata: ro, rwdata: rw, zidata: zi,
    flashBytes: code + ro + rw,
    ramBytes: rw + zi,
    flashKB: 64, ramKB: 20,
  };
}

function runCommand(exe, args, cwd, onLine) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, args, { cwd, windowsHide: true });
    } catch (err) {
      resolve({ code: -1, stdout: '', stderr: String(err && err.message || err) });
      return;
    }
    let stdout = '', stderr = '';
    const feed = (buf, tag) => {
      const text = buf.toString('utf8');
      if (tag === 'out') stdout += text; else stderr += text;
      if (onLine) {
        for (const l of text.split(/\r?\n/)) if (l.trim()) onLine(l, tag);
      }
    };
    child.stdout.on('data', b => feed(b, 'out'));
    child.stderr.on('data', b => feed(b, 'err'));
    child.on('error', err => { stderr += String(err.message || err); resolve({ code: -1, stdout, stderr }); });
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

/**
 * 构建一个工程。逐行回调给上层做流式输出。
 * @param {string} id 工程名
 * @param {(line:string, tag:string)=>void} onLine
 */
async function build(id, onLine = () => {}) {
  assertSafeName(id);
  const dir = projectDir(id);
  if (!fs.existsSync(dir)) throw new Error('工程不存在：' + id);

  const env = toolchain.detectEnv();
  const cc = env.compilers.find(c => c.id === 'keil-ac5' && c.usable);
  if (!cc) {
    throw new Error('没有找到可用的 armcc（Keil MDK AC5）。请安装 Keil MDK（可用 KEIL_ROOT 指定安装位置）后重试。');
  }

  const outDir = path.join(BUILD_DIR, id);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  // 从「工程目录」视角看的相对路径 —— 这一点是中文路径能跑通的关键
  const relBsp = path.relative(dir, path.join(ROOT, BSP)).replace(/\\/g, '\\');
  const relOut = path.relative(dir, outDir);
  const relScatter = path.relative(dir, path.join(ROOT, BSP, 'startup', 'stm32f103c8.ld'));
  const relStartup = path.relative(dir, path.join(ROOT, BSP, 'startup', 'startup_stm32f10x_md.s'));
  const relSystem = path.relative(dir, path.join(ROOT, BSP, 'cmsis', 'DeviceSupport', 'system_stm32f10x.c'));

  const incArgs = [
    '-I.',
    `-I${relBsp}\\cmsis\\CoreSupport`,
    `-I${relBsp}\\cmsis\\DeviceSupport`,
  ];
  const defines = ['-DSTM32F10X_MD'];
  const objects = [];
  let ok = true;
  let programSize = null;
  const warnings = [];

  // 1) C 源文件
  const sources = listSourceFiles(dir);
  for (const s of sources) {
    const obj = `${path.basename(s, path.extname(s))}.o`;
    const args = ['--c99', '--cpu', 'Cortex-M3', '-g', '-O1', '--apcs=interwork', ...defines, ...incArgs, '-c', s, '-o', `${relOut}\\${obj}`];
    onLine(`armcc ${s}`, 'cmd');
    const r = await runCommand(cc.exe, args, dir, l => onLine(l, 'build'));
    if (r.code !== 0) { ok = false; onLine(`armcc 失败 (${r.code})：${s}`, 'error'); }
    if (/warning/i.test(r.stdout + r.stderr)) warnings.push(s);
    objects.push(`${relOut}\\${obj}`);
  }

  // 2) 系统文件
  onLine('armcc system_stm32f10x.c', 'cmd');
  const rSys = await runCommand(cc.exe,
    ['--c99', '--cpu', 'Cortex-M3', '-g', '-O1', '--apcs=interwork', ...defines, ...incArgs, '-c', relSystem, '-o', `${relOut}\\system_stm32f10x.o`],
    dir, l => onLine(l, 'build'));
  if (rSys.code !== 0) { ok = false; onLine('armcc 失败：system_stm32f10x.c', 'error'); }
  objects.push(`${relOut}\\system_stm32f10x.o`);

  // 3) 启动文件
  if (!cc.asm) {
    ok = false;
    onLine('找不到 armasm，无法汇编启动文件', 'error');
  } else {
    onLine('armasm startup_stm32f10x_md.s', 'cmd');
    const rAsm = await runCommand(cc.asm,
      ['--cpu', 'Cortex-M3', '--apcs=interwork', relStartup, '-o', `${relOut}\\startup.o`],
      dir, l => onLine(l, 'build'));
    if (rAsm.code !== 0) { ok = false; onLine('armasm 失败', 'error'); }
    objects.push(`${relOut}\\startup.o`);
  }

  if (!ok) {
    onLine('编译阶段有错误，已停止链接', 'error');
    return { ok: false, warnings, programSize: null, artifact: null, outDir };
  }

  // 4) 链接
  const axf = `${relOut}\\${id}.axf`;
  onLine('armlink', 'cmd');
  const rLink = await runCommand(cc.linker,
    ['--cpu', 'Cortex-M3', '--strict', '--info', 'summarysizes', '--scatter', relScatter,
      '--entry', 'Reset_Handler', ...objects, '-o', axf],
    dir, l => onLine(l, 'build'));
  programSize = parseProgramSize(rLink.stdout + rLink.stderr);
  if (rLink.code !== 0) {
    ok = false;
    onLine('链接失败：常见原因是超出 64 KB Flash / 20 KB SRAM，或缺少 Reset_Handler', 'error');
    return { ok: false, warnings, programSize, artifact: null, outDir };
  }

  // 5) 生成 hex / bin
  const hex = `${relOut}\\${id}.hex`;
  const bin = `${relOut}\\${id}.bin`;
  onLine('fromelf → hex/bin', 'cmd');
  const rHex = await runCommand(cc.fromelf, ['--i32combined', '--output', hex, axf], dir, l => onLine(l, 'build'));
  const rBin = await runCommand(cc.fromelf, ['--bin', '--output', bin, axf], dir, l => onLine(l, 'build'));
  if (rHex.code !== 0 || rBin.code !== 0) { ok = false; onLine('fromelf 生成产物失败', 'error'); }

  // 6) 记账：把最后构建时间写回 project.json
  try {
    const metaFile = path.join(dir, 'project.json');
    const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    meta.lastBuildAt = new Date().toISOString();
    fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
  } catch (_) { /* meta 可选 */ }

  const artifact = ok ? {
    axf: path.join(outDir, `${id}.axf`),
    hex: path.join(outDir, `${id}.hex`),
    bin: path.join(outDir, `${id}.bin`),
  } : null;

  return { ok, warnings, programSize, artifact, outDir };
}

module.exports = {
  ROOT, PROJECTS_DIR, BUILD_DIR,
  listProjects, createProject, projectDir, build, parseProgramSize, assertSafeName, listSourceFiles,
  runCommand, // keil-build.js 复用同一条「逐行回调 + 退出码」的执行通道
};
