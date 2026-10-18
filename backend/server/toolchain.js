'use strict';
/**
 * toolchain.js —— 工具链探测
 *
 * 设计原则：不假设安装位置，按「注册表 → 常见目录 → PATH」的顺序找，
 * 找不到就如实报告不可用，绝不用假路径糊弄调用方。
 * 找到之后所有命令行都用「相对路径 + cwd」方式执行 —— 项目目录含中文时
 * armcc 的 ANSI 命令行会把路径拆坏，相对路径是唯一稳妥解法。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const KEIL_HINTS = ['C:\\Keil_v5', 'C:\\Keil', 'D:\\Keil_v5', 'C:\\Keil_v4'];

function firstExisting(paths) {
  for (const p of paths) {
    if (!p) continue;
    try { if (fs.existsSync(p)) return p; } catch (_) { /* ignore */ }
  }
  return null;
}

function runQuiet(file, args, opts = {}) {
  try {
    const out = execFileSync(file, args, {
      encoding: 'utf8', timeout: opts.timeout || 8000, windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, out: String(out).trim() };
  } catch (err) {
    return { ok: false, out: String((err.stdout || '') + (err.stderr || '')).trim(), error: err };
  }
}

/** 从注册表卸载项里捞 Keil 安装路径（Keil 通常不写 HKLM 的 App Paths） */
function keilFromRegistry() {
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "$keys=@('HKLM:\\SOFTWARE\\WOW6432Node\\Keil\\Products\\MDK','HKLM:\\SOFTWARE\\Keil\\Products\\MDK','HKCU:\\SOFTWARE\\Keil\\Products\\MDK')",
    "foreach($k in $keys){$v=(Get-ItemProperty $k).Path; if($v){Write-Output $v; break}}",
  ].join('; ');
  const r = runQuiet('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
  const line = r.out.split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0];
  if (line && fs.existsSync(line)) return line;
  return null;
}

function findKeilRoot() {
  const env = process.env.KEIL_ROOT || process.env.KEIL_PATH;
  const candidates = [env, ...KEIL_HINTS, keilFromRegistry()].filter(Boolean);
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'ARM', 'ARMCC', 'bin', 'armcc.exe'))) return c;
    if (fs.existsSync(path.join(c, 'ARM', 'ARMCLANG', 'bin', 'armclang.exe'))) return c;
    if (fs.existsSync(path.join(c, 'UV4', 'UV4.exe'))) return c;
  }
  return null;
}

function detectCompilers() {
  const found = [];
  const keil = findKeilRoot();
  if (keil) {
    const ac5 = path.join(keil, 'ARM', 'ARMCC', 'bin');
    if (fs.existsSync(path.join(ac5, 'armcc.exe'))) {
      found.push({
        id: 'keil-ac5', name: 'ARM Compiler 5 (armcc)', vendor: 'Keil MDK',
        path: ac5, exe: path.join(ac5, 'armcc.exe'),
        asm: path.join(ac5, 'armasm.exe'),
        linker: path.join(ac5, 'armlink.exe'),
        fromelf: path.join(ac5, 'fromelf.exe'),
        lang: 'c99', usable: true,
      });
    }
    const ac6 = path.join(keil, 'ARM', 'ARMCLANG', 'bin');
    if (fs.existsSync(path.join(ac6, 'armclang.exe'))) {
      found.push({
        id: 'keil-ac6', name: 'ARM Compiler 6 (armclang)', vendor: 'Keil MDK',
        path: ac6, exe: path.join(ac6, 'armclang.exe'), usable: false,
        note: '已发现但当前构建器只走 AC5 流程，AC6 留作后续接入',
      });
    }
  }
  if (!keil) {
    // 提示还可能存在 GNU 工具链，仅登记不启用
    const gnu = firstExisting([
      'C:\\Program Files (x86)\\Arm GNU Toolchain arm-none-eabi',
      'C:\\Program Files\\Arm GNU Toolchain arm-none-eabi',
    ]);
    if (gnu) {
      found.push({ id: 'gnu-arm', name: 'Arm GNU Toolchain', vendor: 'Arm', path: gnu, usable: false, note: '未接入（本项目当前用 AC5 流程）' });
    }
  }
  return { keilRoot: keil, compilers: found };
}

/** 查找 xPack OpenOCD：先看项目内 tools/，再看 PATH 与常见目录 */
function findOpenOCD() {
  const roots = [path.join(ROOT, 'tools', 'openocd')];
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    try {
      const stack = [r];
      while (stack.length) {
        const cur = stack.pop();
        for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
          const p = path.join(cur, e.name);
          if (e.isDirectory()) stack.push(p);
          else if (e.name.toLowerCase() === 'openocd.exe') {
            const binDir = path.dirname(p);
            const scripts = path.join(path.dirname(binDir), 'openocd', 'scripts');
            return {
              id: 'openocd', name: 'OpenOCD (xPack)', path: p,
              scripts: fs.existsSync(scripts) ? scripts : null,
              usable: true,
              note: fs.existsSync(scripts) ? '' : '未找到 scripts 目录，烧录需要 -s 指定',
            };
          }
        }
      }
    } catch (_) { /* ignore */ }
  }
  return null;
}

function detectFlashers() {
  const found = [];
  const ocd = findOpenOCD();
  if (ocd) found.push(ocd);
  const cube = firstExisting([
    'C:\\Program Files\\STMicroelectronics\\STM32Cube\\STM32CubeProgrammer\\bin\\STM32_Programmer_CLI.exe',
    'C:\\Program Files (x86)\\STMicroelectronics\\STM32Cube\\STM32CubeProgrammer\\bin\\STM32_Programmer_CLI.exe',
  ]);
  if (cube) found.push({ id: 'cubeprog', name: 'STM32CubeProgrammer CLI', path: cube, usable: true });
  return found;
}

/** 串口列表：Windows 走 PowerShell，其他平台走 /dev 粗扫 */
function listSerialPorts() {
  if (process.platform !== 'win32') {
    const out = [];
    for (const dir of ['/dev']) {
      try {
        for (const n of fs.readdirSync(dir)) {
          if (/^(ttyUSB|ttyACM|ttyS\d|cu\.|tty\.usb)/.test(n)) out.push({ path: path.join(dir, n), description: '' });
        }
      } catch (_) { /* ignore */ }
    }
    return out;
  }
  const script = [
    "$ErrorActionPreference='SilentlyContinue'",
    "Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match '\\(COM\\d+\\)' } |",
    "ForEach-Object { $m=[regex]::Match($_.Name,'\\((COM\\d+)\\)'); if($m.Success){",
    "  $p=$m.Groups[1].Value; $d=($_.Name -replace '\\s*\\(COM\\d+\\)','').Trim();",
    "  '{0}|{1}|{2}' -f $p,$d,$_.Manufacturer } }",
  ].join(' ');
  const r = runQuiet('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15000 });
  const ports = [];
  for (const line of r.out.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.includes('|')) continue;
    const [p, desc, man] = t.split('|');
    if (!p) continue;
    const isStlink = /ST-?Link|STMicro/i.test(desc + man);
    ports.push({
      path: p, description: desc || '', manufacturer: man || '',
      role: isStlink ? 'stlink-vcp' : 'usb-serial',
    });
  }
  return ports;
}

/** 认板：看串口与 ST-Link 痕迹，给出结论与理由（不猜） */
function assessBoard(ports) {
  const stlinkVcp = ports.filter(p => p.role === 'stlink-vcp');
  const usbSerial = ports.filter(p => p.role === 'usb-serial');
  const evidence = [];
  if (stlinkVcp.length) evidence.push(`发现 ST-Link 虚拟串口：${stlinkVcp.map(p => p.path).join(', ')}`);
  if (usbSerial.length) evidence.push(`发现 USB 转串口：${usbSerial.map(p => `${p.path} (${p.description})`).join(', ')}`);
  if (!ports.length) evidence.push('当前没有检测到任何串口设备');
  return {
    stlinkLikelyPresent: stlinkVcp.length > 0,
    serialAvailable: ports.length > 0,
    evidence,
    caveat: '串口存在不代表 SWD 可用：ST-Link 的 SWD 口与虚拟串口是两条独立通道，烧录能否成功只有真正连接后才知道。',
  };
}

/**
 * detectEnv 的结果不是免费的：Windows 上枚举串口要起一个 powershell.exe
 * （实测 ~2 s），编译器和烧录器还要扫磁盘。界面会反复拉 /api/env，
 * 所以默认缓存 5 s；需要立刻反映插拔时传 { fresh: true }。
 * 缓存只影响「探测结果」的新鲜度，不影响任何编译/烧录用的真实路径。
 */
let envCache = null;
let envCacheAt = 0;
const ENV_CACHE_MS = Math.max(0, Number(process.env.MCU_ENV_CACHE_MS || 5000));

function detectEnv(options) {
  const fresh = options === true || !!(options && options.fresh);
  if (!fresh && envCache && Date.now() - envCacheAt < ENV_CACHE_MS) return envCache;
  const { keilRoot, compilers } = detectCompilers();
  const flashers = detectFlashers();
  const serialPorts = listSerialPorts();
  envCache = {
    host: { platform: process.platform, arch: process.arch, node: process.version, cwd: ROOT },
    keilRoot,
    compilers, flashers, serialPorts,
    board: assessBoard(serialPorts),
    generatedAt: new Date().toISOString(),
    cachedForMs: ENV_CACHE_MS,
  };
  envCacheAt = Date.now();
  return envCache;
}

module.exports = { ROOT, detectEnv, detectCompilers, detectFlashers, listSerialPorts, findKeilRoot, firstExisting };
