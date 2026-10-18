'use strict';
/**
 * uvprojx.js —— 解析 Keil MDK 工程文件（.uvprojx）
 *
 * 为什么需要它：插件原本的 build.js 只认自己那套 firmware/projects/<id>/ + project.json，
 * 编译参数写死（-DSTM32F10X_MD、固定 include、固定 scatter）。要接管用户已有的 Keil 工程，
 * 就必须读工程文件本身，用它的文件清单 / 宏 / 头路径 / 输出设置来编译。
 *
 * .uvprojx 是纯 XML、字段稳定。Node 没有内置 XML 解析器，这里按标签取值；
 * 对不认识的结构保持宽容（不抛错，只在 diagnostics 里记一笔）。
 *
 * 本模块 **只读**：绝不写入被解析的工程目录。
 */
const fs = require('fs');
const path = require('path');

/* ── XML 取值小工具（够用即可） ───────────────────────────────── */

function first(xml, name) {
  const m = new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>').exec(xml);
  return m ? m[1].trim() : '';
}

/** 同名标签出现多次时取第一个非空值：.uvprojx 里 IncludePath 会出现两次，第一处为空 */
function firstNonEmpty(xml, name) {
  const re = new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>', 'g');
  let m;
  while ((m = re.exec(xml))) {
    const v = m[1].trim();
    if (v) return v;
  }
  return '';
}

function unescapeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&'); // 必须最后：避免二次解码
}

/* ── Keil 的 FileType → 我们要认的类型 ─────────────────────────── */

const FILE_KIND = { 1: 'c', 2: 'asm', 4: 'lib', 5: 'header', 7: 'text', 8: 'object' };

/* ── 器件 → SPL 容量宏 ───────────────────────────────────────────
 * Keil 在自己编译时，会根据 <Device> 自动定义 STM32F10X_MD 之类的宏，
 * 所以工程文件的 <Define> 里通常只有 USE_STDPERIPH_DRIVER。
 * 换到外部工具链（armcc 直调）就没人替你补了 —— 缺了它会直接
 * #error "Please select first the target STM32F10x device"。
 */

function capacityDefine(device) {
  const d = String(device || '').toUpperCase();
  const m = /^STM32F(10[0-9])([A-Z])([0-9A-Z])/.exec(d);
  if (!m) return null;
  const family = m[1];
  const flashChar = m[3];
  if (family === '105' || family === '107') return 'STM32F10X_CL';
  if ('46'.indexOf(flashChar) >= 0) return 'STM32F10X_LD';
  if ('8B'.indexOf(flashChar) >= 0) return 'STM32F10X_MD';
  if ('CDE'.indexOf(flashChar) >= 0) return 'STM32F10X_HD';
  if ('FG'.indexOf(flashChar) >= 0) return 'STM32F10X_XL';
  return null;
}

/** Cpu 串 → 内存布局，例如 IRAM(0x20000000,0x00005000) IROM(0x08000000,0x00010000) */
function parseCpu(cpu) {
  const grab = (re) => {
    const m = re.exec(cpu || '');
    return m ? { base: parseInt(m[1], 16), size: parseInt(m[2], 16) } : null;
  };
  const clockM = /CLOCK\((\d+)\)/.exec(cpu || '');
  const coreM = /CPUTYPE\("([^"]+)"\)/.exec(cpu || '');
  return {
    irom: grab(/IROM\(0x([0-9a-fA-F]+)\s*,\s*0x([0-9a-fA-F]+)\)/),
    iram: grab(/IRAM\(0x([0-9a-fA-F]+)\s*,\s*0x([0-9a-fA-F]+)\)/),
    clockHz: clockM ? +clockM[1] : null,
    core: coreM ? coreM[1] : null,
  };
}

/** Keil 的 Optim 数值 → armcc 的 -O 级别
 *
 * ⚠️ 实测结论（本机 Keil MDK 5.06u7）：<Optim> 是 **1-based** 的。
 * 工程里写着 <Optim>3</Optim> 时，用 -O3 编译出的 main 函数是 610 B，
 * 而 Keil 自己编出的是 590 B；换成 -O2 后逐字节一致。
 * 即映射为 1→-O0、2→-O1、3→-O2、4→-O3。
 */
function optimToFlag(optim) {
  const n = parseInt(optim, 10);
  if (!isFinite(n) || n <= 0) return '-O0';
  return '-O' + Math.max(0, Math.min(3, n - 1));
}

/* ── 主解析 ───────────────────────────────────────────────────── */

/**
 * @param {string} file  .uvprojx 绝对路径
 * @returns {object} 工程模型（详见 README 的字段说明）
 */
function parseUvprojx(file) {
  if (!fs.existsSync(file)) {
    const e = new Error('工程文件不存在：' + file);
    e.code = 'NO_PROJECT';
    throw e;
  }
  const xml = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  const dir = path.dirname(file);

  // 多个 Target 时只取第一个（Keil 绝大多数工程只有一个）
  const tStart = xml.indexOf('<Target>');
  const tEnd = xml.indexOf('</Target>');
  const tgt = (tStart >= 0 && tEnd > tStart) ? xml.slice(tStart, tEnd) : xml;
  const targetNames = [];
  {
    const re = /<TargetName>([\s\S]*?)<\/TargetName>/g;
    let m;
    while ((m = re.exec(xml))) targetNames.push(m[1].trim());
  }

  const device = unescapeXml(first(tgt, 'Device'));
  const cpuRaw = unescapeXml(first(tgt, 'Cpu'));
  const cpu = parseCpu(cpuRaw);

  /* 头文件路径 */
  const incRaw = unescapeXml(firstNonEmpty(tgt, 'IncludePath'));
  const includes = incRaw.split(';').map((s) => s.trim()).filter(Boolean).map((raw) => ({
    raw,
    abs: path.resolve(dir, raw.replace(/[\\/]/g, path.sep)),
  }));

  /* 宏定义（Keil 用逗号分隔） */
  const defineRaw = firstNonEmpty(tgt, 'Define');
  const defines = defineRaw.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  const autoDefines = [];
  const capDef = capacityDefine(device);
  if (capDef && defines.indexOf(capDef) < 0) {
    defines.push(capDef);
    autoDefines.push(capDef);
  }

  /* 分组与源文件 */
  const groups = [];
  const gRe = /<Group>([\s\S]*?)<\/Group>/g;
  let gm;
  while ((gm = gRe.exec(tgt))) {
    const gx = gm[1];
    const gname = unescapeXml(first(gx, 'GroupName'));
    const files = [];
    const fRe = /<File>([\s\S]*?)<\/File>/g;
    let fm;
    while ((fm = fRe.exec(gx))) {
      const fx = fm[1];
      const raw = unescapeXml(first(fx, 'FilePath'));
      if (!raw) continue;
      const ft = parseInt(first(fx, 'FileType'), 10) || 1;
      files.push({
        name: unescapeXml(first(fx, 'FileName')) || path.basename(raw),
        raw,
        abs: path.resolve(dir, raw.replace(/[\\/]/g, path.sep)),
        fileType: ft,
        kind: FILE_KIND[ft] || 'other',
        group: gname, // 分组名很有用：Start/Library 是第三方代码，其余是用户代码
        // Keil 里右键「Options for File → Include in Target Build」取消勾选会写 0
        inBuild: !/<IncludeInBuild>\s*0\s*<\/IncludeInBuild>/.test(fx),
      });
    }
    groups.push({ name: gname, files });
  }

  const allFiles = groups.reduce((a, g) => a.concat(g.files), []);
  const sources = allFiles.filter((f) => f.inBuild && (f.kind === 'c' || f.kind === 'asm'));
  const headers = allFiles.filter((f) => f.kind === 'header');

  /* 输出与工具设置 */
  const outputDirectory = unescapeXml(first(tgt, 'OutputDirectory')) || '.\\Objects\\';
  const outputName = unescapeXml(first(tgt, 'OutputName')) || 'Project';
  const listingPath = unescapeXml(first(tgt, 'ListingPath')) || '.\\Listings\\';
  const scatterFile = unescapeXml(first(tgt, 'ScatterFile'));
  const optim = first(tgt, 'Optim') || '1';
  const useAC6 = first(tgt, 'uAC6') === '1';
  const createHex = first(tgt, 'CreateHexFile') === '1';
  const miscControls = unescapeXml(firstNonEmpty(tgt, 'MiscControls'));
  const debugDll = unescapeXml(first(tgt, 'TargetDlls'));

  /* ── 诊断：只在**有证据**时记录，不做猜测 ── */
  const diagnostics = [];

  sources.filter((f) => !fs.existsSync(f.abs)).forEach((f) => {
    diagnostics.push({ level: 'error', code: 'MISSING_SOURCE',
      message: '工程引用的源文件不存在：' + f.raw });
  });
  includes.filter((i) => !fs.existsSync(i.abs)).forEach((i) => {
    diagnostics.push({ level: 'error', code: 'MISSING_INCLUDE',
      message: '头文件路径不存在：' + i.raw });
  });
  if (scatterFile) {
    const sAbs = path.resolve(dir, scatterFile.replace(/[\\/]/g, path.sep));
    if (!fs.existsSync(sAbs)) {
      diagnostics.push({ level: 'error', code: 'MISSING_SCATTER',
        message: '分散加载文件不存在：' + scatterFile });
    }
  }
  if (autoDefines.length) {
    diagnostics.push({ level: 'info', code: 'AUTO_DEFINE',
      message: 'Keil 会按器件自动定义 ' + autoDefines.join(', ') +
        '，工程文件里没有写 —— 已自动补上（外部工具链必须显式传）' });
  }
  if (!sources.some((f) => f.kind === 'asm')) {
    diagnostics.push({ level: 'warn', code: 'NO_STARTUP',
      message: '工程里没有汇编启动文件（.s）：链接会缺 Reset_Handler' });
  }
  if (useAC6) {
    diagnostics.push({ level: 'warn', code: 'AC6',
      message: '这个工程选了 ARM Compiler 6（armclang），当前后端只备了 AC5：语法/内联汇编可能有差异' });
  }

  /* 目录里躺着但没进工程的文件 —— 常见于「拷了别人的模板过来改」 */
  const referenced = {};
  allFiles.forEach((f) => { referenced[f.abs.toLowerCase()] = true; });
  const orphans = [];
  try {
    const walk = (d, depth) => {
      if (depth > 3) return;
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) {
          if (['Objects', 'Listings', '.git', 'DebugConfig', 'node_modules'].indexOf(e.name) >= 0) continue;
          walk(path.join(d, e.name), depth + 1);
        } else if (/\.(c|s)$/i.test(e.name)) {
          const abs = path.join(d, e.name);
          if (!referenced[abs.toLowerCase()]) {
            orphans.push(path.relative(dir, abs));
          }
        }
      }
    };
    walk(dir, 0);
  } catch (_) { /* 目录不可读就不做这项检查 */ }
  if (orphans.length) {
    diagnostics.push({ level: 'warn', code: 'ORPHAN_SOURCE',
      message: '目录里存在但没被工程引用的源文件（不会参与编译）：' + orphans.join('、') });
  }

  return {
    file,
    dir,
    name: path.basename(dir),
    projectName: path.basename(file, '.uvprojx'),
    targetName: targetNames[0] || first(tgt, 'TargetName') || 'Target',
    targetCount: targetNames.length || 1,

    device,
    vendor: unescapeXml(first(tgt, 'Vendor')),
    packId: unescapeXml(first(tgt, 'PackID')),
    cpu,
    cpuRaw,

    defines,
    autoDefines,
    includes,

    optim: parseInt(optim, 10),
    optimFlag: optimToFlag(optim),
    useAC6,
    miscControls,

    outputDirectory,
    outputDirectoryAbs: path.resolve(dir, outputDirectory.replace(/[\\/]/g, path.sep)),
    outputName,
    listingPath,
    createHex,
    scatterFile,
    scatterFileAbs: scatterFile ? path.resolve(dir, scatterFile.replace(/[\\/]/g, path.sep)) : null,
    debugDll,

    groups,
    sources,
    headers,
    sourceCount: sources.length,
    orphanSources: orphans,
    diagnostics,
  };
}

/** 把工程模型压成一行摘要，给界面/日志用 */
function summarise(model) {
  const irom = model.cpu.irom ? Math.round(model.cpu.irom.size / 1024) + ' KB' : '?';
  const iram = model.cpu.iram ? Math.round(model.cpu.iram.size / 1024) + ' KB' : '?';
  return [
    model.device + ' (' + irom + ' Flash / ' + iram + ' SRAM)',
    'AC' + (model.useAC6 ? '6' : '5'),
    model.optimFlag,
    model.sourceCount + ' 个源文件',
    model.defines.length + ' 个宏',
    model.includes.length + ' 个头路径',
  ].join(' · ');
}

module.exports = { parseUvprojx, summarise, capacityDefine, parseCpu, optimToFlag, FILE_KIND };
