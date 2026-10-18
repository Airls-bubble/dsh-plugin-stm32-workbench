'use strict';
/**
 * openocd.js —— 烧录与芯片信息（OpenOCD + ST-Link，SWD 接口）
 *
 * 全部命令走 OpenOCD 自己支持的指令，不做假动作：
 *   flash probe 0  只在探测；失败就是失败，如实上报
 *   program ... verify reset exit  真正的下载 + 校验 + 复位
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const toolchain = require('./toolchain');

const ROOT = toolchain.ROOT;

function resolveOpenOCD() {
  const f = toolchain.detectFlashers().find(x => x.id === 'openocd' && x.usable);
  if (!f) throw new Error('没有找到 OpenOCD。请运行 backend\\scripts\\fetch-openocd.ps1 下载便携版，或把 openocd 放进 PATH。');
  if (!f.scripts) throw new Error('OpenOCD 找到了但缺少 scripts 目录：' + f.path);
  return f;
}

/**
 * 生成一个临时 cfg（ASCII 文件名，避免中文路径进命令行）。
 * 落在系统临时目录：以前写在 <插件>/backend/build/ 下，等于让插件本体被运行期数据污染。
 */
function writeCfg(name, body) {
  const dir = require('./paths').transientDir();
  const file = path.join(dir, name);
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

/**
 * 跑**一次** OpenOCD，带硬超时。
 *
 * 用户问题记录第 6 条：实测有一次 openocd 调用卡住 1 分多钟不返回（后台任务一直
 * 「still running」），最后只能手动 kill。现在超时到点就结束子进程，
 * 并且（默认）自动重试一次 —— 偶发的 ST-Link 握手卡住常常重试一次就过。
 */
function runOCDOnce(cfgFile, extraCmds, onLine = () => {}, opts = {}) {
  const ocd = resolveOpenOCD();
  const args = ['-s', ocd.scripts, '-f', 'interface/stlink.cfg', '-f', 'target/stm32f1x.cfg', '-f', cfgFile];
  for (const c of extraCmds) args.push('-c', c);
  const timeoutMs = Math.max(2000, Number(opts.timeoutMs) || 90000);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ocd.path, args, { cwd: ROOT, windowsHide: true });
    } catch (err) {
      resolve({ ok: false, code: -1, text: String(err.message || err) });
      return;
    }
    let text = '';
    let settled = false;
    let killTimer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      onLine('OpenOCD 超过 ' + Math.round(timeoutMs / 1000) + ' 秒未返回，结束它');
      try { child.kill(); } catch (_) { /* 可能已退出 */ }
      killTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) { /* 已退出 */ }
      }, 1500);
      if (killTimer.unref) killTimer.unref();
      finish({ ok: false, code: null, timeout: true, text, errors: [], timeoutMs });
    }, timeoutMs);
    if (timer.unref) timer.unref();
    const feed = (b) => {
      const t = b.toString('utf8');
      text += t;
      for (const l of t.split(/\r?\n/)) if (l.trim()) onLine(l.trim());
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', err => finish({ ok: false, code: -1, text: text + String(err.message || err) }));
    child.on('close', (code) => {
      const hardErrors = text.split(/\r?\n/)
        .filter(l => /^Error:|in procedure|No target|open failed|unable to find/i.test(l.trim()));
      finish({ ok: code === 0 && hardErrors.length === 0, code, text, errors: hardErrors });
    });
  });
}

/**
 * ST-Link 克隆/廉价调试器的**瞬时**故障。这块板子实测（2026-10-18）会稳定出现：
 *   Error: Fail reading CTRL/STAT register. Force reconnect
 *   Error: [stm32f1x.cpu] Polling failed, trying to reexamine
 *   Error: unknown/unexpected STLINK status code 0x16
 * 这些不是「操作结果」，重连一次往往就过；不能直接当最终失败上报。
 */
const TRANSIENT_OCD = /Polling failed|trying to reexamine|Force reconnect|Fail reading CTRL\/STAT|unexpected STLINK status|USB communication|Error connecting/i;

/**
 * runOCD = 带「瞬时故障自动重试一次」的 wrapper。
 * 注意：flash 这类**会改芯片**的操作必须传 retryOnTimeout:false —— 已经写进去一半再重跑，
 * 后果比失败更糟（可能重复编程或校验失败）。读类操作（probe/readmem/reset 的状态复核）可重试。
 */
async function runOCD(cfgFile, extraCmds, onLine = () => {}, opts = {}) {
  const first = await runOCDOnce(cfgFile, extraCmds, onLine, opts);
  const transient = first.timeout || (!first.ok && TRANSIENT_OCD.test(String(first.text || '')));
  if (!transient || opts.retryOnTimeout === false) return first;
  onLine(first.timeout ? 'OpenOCD 超时，自动重试一次' : 'OpenOCD 瞬时故障（重连类错误），自动重试一次');
  const second = await runOCDOnce(cfgFile, extraCmds, onLine, opts);
  second.retried = true;
  return second;
}

/** mdw 输出解析：`0x40021000: 03035b83 001d040a ...` -> [{addr, words[]}] */
function parseMdw(text) {
  const rows = [];
  const re = /^\s*(0x[0-9a-fA-F]+):\s+((?:[0-9a-fA-F]{8}\s+)+)/gm;
  let m;
  while ((m = re.exec(String(text || '')))) {
    rows.push({
      addr: parseInt(m[1], 16) >>> 0,
      words: m[2].trim().split(/\s+/).map((w) => parseInt(w, 16) >>> 0),
    });
  }
  return rows;
}

function parseAddress(addr) {
  if (typeof addr === 'number' && Number.isFinite(addr)) return addr >>> 0;
  const s = String(addr == null ? '' : addr).trim();
  if (/^0x[0-9a-f]+$/i.test(s)) return parseInt(s, 16) >>> 0;
  if (/^\d+$/.test(s)) return parseInt(s, 10) >>> 0;
  const n = Number(s);
  if (Number.isFinite(n)) return n >>> 0;
  throw new Error('地址格式不对：' + JSON.stringify(addr) + '（要 0x20000000 这样的十六进制，或变量名）');
}

/**
 * 读目标内存（用户问题记录第 1 条）。
 *
 * 关键点：**不 halt**。实测这块板子 `init → mdw → exit` 就能读到 RAM/外设寄存器
 * （读数与 /api/keil/registers 的 RCC 值逐字一致），读完整条 OpenOCD 会话直接退出，
 * 目标保持原运行状态 —— 不会出现「读一次寄存器，屏幕停住」那种事。
 * mdw 只支持 32 位字，一次最多读 4 KB；地址必须 4 字节对齐。
 */
async function readMemory(addr, length = 64, onLine = () => {}, opts = {}) {
  const startAddr = parseAddress(addr);
  if (startAddr % 4 !== 0) {
    throw new Error('mdw 只能从 4 字节对齐的地址读：0x' + startAddr.toString(16) +
      ' —— 写成 0x' + (startAddr - (startAddr % 4)).toString(16) + ' 再按偏移截取');
  }
  const want = Math.max(4, Math.min(4096, Math.ceil(Number(length || 64) / 4) * 4));
  const words = want / 4;
  const cfg = writeCfg('_readmem.cfg', 'adapter speed 1000\ntransport select swd\n');
  const r = await runOCD(cfg, ['init', 'mdw 0x' + startAddr.toString(16) + ' ' + words, 'exit'], onLine, opts);
  const rows = parseMdw(r.text);
  const values = [];
  rows.sort((a, b) => a.addr - b.addr)
    .forEach((row) => row.words.forEach((w, i) => values.push({ addr: row.addr + i * 4, value: w })));
  if (!values.length) {
    throw new Error('OpenOCD 没有返回内存数据：' + whyFailed(r, '读取失败'));
  }
  const bytes = [];
  for (const v of values) {
    bytes.push(v.value & 0xff, (v.value >>> 8) & 0xff, (v.value >>> 16) & 0xff, (v.value >>> 24) & 0xff);
  }
  const trimmed = bytes.slice(0, want);
  return {
    ok: true,
    addr: startAddr,
    length: trimmed.length,
    words: values,
    bytes: trimmed,
    hex: Buffer.from(trimmed).toString('hex'),
    timeout: !!r.timeout,
    log: r.text,
  };
}

/** 把 readMemory 的结果排成人能读的 hexdump（也给模型看） */
function formatHexdump(addr, bytes) {
  const lines = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.slice(i, i + 16);
    const hex = chunk.map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = chunk.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
    lines.push('0x' + (addr + i).toString(16).padStart(8, '0') + '  ' +
      hex.padEnd(47, ' ') + '  |' + ascii + '|');
  }
  return lines.join('\n');
}

/** 解析 OpenOCD 报出的芯片信息 */
function parseChipInfo(text) {
  const info = {};
  const id = /device id\s*=\s*(0x[0-9a-fA-F]+)/i.exec(text);
  if (id) info.deviceId = id[1];
  const flash = /flash size\s*=\s*(\d+)\s*(k|K)?i?B/i.exec(text);
  if (flash) info.flashKB = parseInt(flash[1], 10);
  const rp = /RDP\s*=\s*(0x[0-9a-fA-F]+)/i.exec(text);
  if (rp) info.readoutProtection = rp[1];
  const target = /Cortex-M3 r(\d)p(\d)/i.exec(text);
  if (target) info.core = `Cortex-M3 r${target[1]}p${target[2]}`;
  const hw = /hardware version\s*=\s*(.+)$/im.exec(text);
  if (hw) info.stlinkHardware = hw[1].trim();
  return info;
}

/**
 * 从一次 OpenOCD 运行里提炼「为什么失败」—— 别只回一句「失败」。
 *
 * 为什么需要它：runOCD 的 errors 只认 `^Error:` 这样的行首错误，而很多失败
 * （例如 `reset run` 的非零退出）根本没有那种行，于是 reason 退化成「复位失败」四个字，
 * 什么信息都没有。这里按「硬错误 → 含 error/fail 的行 → 最后一行」逐级退化，
 * 并始终带上退出码，让人有个查下去的方向。
 */
function whyFailed(r, fallback) {
  const errs = Array.isArray(r.errors) ? r.errors.filter(Boolean) : [];
  if (errs.length) return errs[0];
  const lines = String(r.text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const flagged = lines.filter((l) => /\b(error|fail|failed|unable|cannot|timeout)\b/i.test(l));
  const picked = flagged.length ? flagged[flagged.length - 1] : lines[lines.length - 1];
  return (fallback || 'OpenOCD 未成功') +
    (picked ? '：' + picked : '') +
    (r.code !== undefined ? '（OpenOCD 退出码 ' + r.code + '）' : '');
}

/**
 * 探测板子：ST-Link 在不在、目标芯片认不认得出
 * 注意：不插板子时这里必须失败 —— 界面显示「未检测到」是正确行为，不是 bug。
 */
async function probe(onLine = () => {}) {
  const cfg = writeCfg('_probe.cfg',
    ['adapter speed 1000', 'transport select swd'].join('\n') + '\n');
  const r = await runOCD(cfg, ['init', 'targets', 'flash probe 0', 'exit'], onLine);
  const chip = parseChipInfo(r.text);
  const notFound = /open failed|No ST-LINK|unable to find|No target|not found/i.test(r.text);
  /* 判据不能只看退出码。
     实测（2026-10-14）：这块 ST-Link 会稳定打出
     `Error: Failed to read memory at 0xe00fffec`（mem_helper.tcl 的已知噪音），
     而 OpenOCD 的退出码**时好时坏** —— 同一台板子同一条命令，这次 0 下次非 0。
     只看退出码会把「已经读到 DEVICE_ID 和 Flash 容量」误判成探测失败。
     所以：**拿到芯片身份就算连通**，没身份又没报 notFound 才按错误处理。 */
  const identified = !!(chip && (chip.deviceId || chip.flashKB || chip.core));
  const ok = r.ok || (identified && !notFound);
  return {
    ok, connected: ok && !notFound,
    reason: ok ? '' : (notFound
      ? '没找到 ST-Link 或目标芯片：检查 USB 是否插好、SWD 四根线（3V3/GND/SWDIO/SWCLK）是否接对、板子是否上电'
      : whyFailed(r, 'OpenOCD 报错')),
    chip, log: r.text,
  };
}

/** 烧录工程产物（默认烧 hex） */
async function flash(projectId, opts = {}, onLine = () => {}) {
  const build = require('./build');
  build.assertSafeName(projectId);
  const outDir = path.join(build.BUILD_DIR, projectId);
  const hex = path.join(outDir, `${projectId}.hex`);
  if (!fs.existsSync(hex)) {
    throw new Error(`没有找到可烧录的产物：${hex}\n请先构建成功再烧录。`);
  }
  const verify = opts.verify !== false;
  const cfg = writeCfg('_flash.cfg', [
    'adapter speed 1000',
    'transport select swd',
  ].join('\n') + '\n');

  // OpenOCD 吃正斜杠路径最稳
  const hexArg = hex.replace(/\\/g, '/');
  const cmds = [
    'init',
    `program "${hexArg}" ${verify ? 'verify' : ''} reset exit`.replace(/\s+/g, ' ').trim(),
  ];
  const r = await runOCD(cfg, cmds, onLine, { retryOnTimeout: false });
  const wrote = /wrote\s+\d+\s+bytes/i.exec(r.text);
  /* 与 flashFile 同一套证据判据：不用 r.ok（这块 ST-Link 的噪音会让它恒为 false） */
  const programmed = /Programming Finished|wrote \d+\s+bytes/i.test(r.text);
  const verifyFailed = /Verify Failed|verification failed|checksum mismatch/i.test(r.text);
  const ok = programmed && !verifyFailed;
  return {
    ok,
    bytes: wrote ? parseInt(wrote[0].replace(/\D+/g, ''), 10) : null,
    verified: verify && /verified/i.test(r.text) && !verifyFailed,
    reason: ok ? '' : whyFailed(r, verifyFailed ? '回读校验失败（Verify Failed）' : '烧录失败'),
    openocdOk: r.ok,
    log: r.text,
  };
}

/**
 * 烧录任意 hex 文件（Keil 工程产物等）。
 * 判据沿用修过的版本：OpenOCD 0.12 的 program 不打印 "wrote N bytes"，
 * 成功标志是 ** Programming Finished ** + ** Verified OK **；出现 Verify Failed 一律判失败。
 */
async function flashFile(hexPath, opts = {}, onLine = () => {}) {
  if (!hexPath || !fs.existsSync(hexPath)) {
    throw new Error('没有找到可烧录的产物：' + hexPath);
  }
  const verify = opts.verify !== false;
  const cfg = writeCfg('_flash_file.cfg', 'adapter speed 1000\ntransport select swd\n');
  const hexArg = hexPath.replace(/\\/g, '/');
  const cmds = [
    'init',
    `program "${hexArg}" ${verify ? 'verify' : ''} reset exit`.replace(/\s+/g, ' ').trim(),
  ];
  const r = await runOCD(cfg, cmds, onLine, { retryOnTimeout: false });
  const programmed = /Programming Finished|wrote \d+\s+bytes/i.test(r.text);
  const verifiedOk = /Verified OK|verified/i.test(r.text);
  const verifyFailed = /Verify Failed|verification failed|checksum mismatch/i.test(r.text);
  /* 判据用**证据**而不是 r.ok。
     runOCD 把任何 `^Error:` 行都算硬错误，而实测（2026-10-14）这块 ST-Link 会**稳定**打印
     `Error: Failed to read memory at 0xe00fffec`（mem_helper.tcl 的已知噪音）——
     于是 r.ok 恒为 false，若还要求它，**烧录成功也会被报成失败**。
     证据判据本来就是上面注释写的那条：出现 Programming Finished 且没有 Verify Failed 即成功。 */
  const ok = programmed && !verifyFailed;
  return {
    ok,
    programmed,
    verified: verify && verifiedOk && !verifyFailed,
    reason: ok ? '' : whyFailed(r, verifyFailed ? '回读校验失败（Verify Failed）' : '烧录失败'),
    openocdOk: r.ok,
    log: r.text,
  };
}

/** 复位目标（不烧录）。读类操作，允许瞬时故障重试。 */
async function reset(onLine = () => {}) {
  const cfg = writeCfg('_reset.cfg', 'adapter speed 1000\ntransport select swd\n');
  const r = await runOCD(cfg, ['init', 'reset run', 'exit'], onLine);
  if (r.ok) return { ok: true, reason: '', log: r.text, verified: 'openocd-exit' };
  /* 这块 ST-Link 的「复位噪声」很具体（实测 2026-10-18）：
     `Error: Failed to write memory at 0xe00fffec`、`Polling failed, trying to reexamine`、
     `Fail reading CTRL/STAT register. Force reconnect` —— 它们既不代表复位没执行，
     也不代表执行了。既然读内存不 halt，就直接复核内核状态：
     DHCSR 的 S_REGRDY=1 且 S_HALT=0 → 内核在跑（复位成功、且没被按在 halt）。 */
  const noise = TRANSIENT_OCD.test(String(r.text || '')) || /Failed to write memory at 0xe00fffec/i.test(String(r.text || ''));
  if (noise) {
    try {
      const st = await readMemory('0xE000EDF0', 4, () => { });
      const dhcsr = st.words && st.words[0] ? st.words[0].value >>> 0 : 0;
      const regRdy = ((dhcsr >>> 16) & 1) === 1;
      const halted = ((dhcsr >>> 1) & 1) === 1;
      if (regRdy && !halted) {
        return {
          ok: true, reason: '', log: r.text, verified: 'dhcsr', dhcsr: '0x' + dhcsr.toString(16),
          note: 'OpenOCD 退出码/日志有 ST-Link 噪声，但读回 DHCSR 显示内核未 halt（已复位并在运行）',
        };
      }
      if (regRdy && halted) {
        return {
          ok: false, reason: '复位后内核仍处于 halt（DHCSR S_HALT=1）——再试一次 reset；仍不行就重新插拔 ST-Link',
          log: r.text, verified: 'dhcsr', dhcsr: '0x' + dhcsr.toString(16),
        };
      }
    } catch (_) { /* 复核失败就退回原始错误 */ }
  }
  return { ok: false, reason: whyFailed(r, '复位失败'), log: r.text };
}

module.exports = {
  probe, flash, flashFile, reset, parseChipInfo, resolveOpenOCD, runOCD, writeCfg,
  readMemory, formatHexdump, parseMdw, parseAddress,
};
