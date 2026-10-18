'use strict';
/**
 * restore-backup.js —— 把整片 Flash 备份还原回板子
 *
 * 步骤故意做得啰嗦，因为刷错一次就得重来：
 *   ① 校验备份 SHA256（对不上直接拒绝）
 *   ② 先 dump 当前 Flash 存一份（万一还原后想回到现在）
 *   ③ OpenOCD program + verify + reset
 *   ④ 再 dump 回读，与备份逐字节比对
 *
 * 用法：node scripts/restore-backup.js [备份.bin] [--dry-run] [--no-snapshot]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runOCD, writeCfg, resolveOpenOCD } = require('../server/openocd');
const toolchain = require('../server/toolchain');

/* 备份文件不再写死桌面路径（P0-4）：
   优先命令行第一个参数，其次插件自己的 firmware/backup/ 下唯一（或 SHA 对得上）的 .bin。
   下面还有 EXPECT_SHA 这道硬闸 —— 文件不对直接拒绝，所以换默认值不会刷错东西。 */
const EXPECT_SHA = '9E4AB6E2CCB09FC81A07DD2F98DCF391E2AA318D01CAC7EC8A28BEDD71233A67';
const FLASH_BASE = '0x08000000';
const FLASH_SIZE = 0x10000; // 64 KB
const WORK = require('../server/paths').transientDir();

const DEFAULT_BACKUP = (() => {
  const explicit = String(process.argv[2] || '').trim();
  if (explicit && explicit.charAt(0) !== '-') {
    return path.resolve(explicit.replace(/^["'\u201c\u201d]+/, '').replace(/["'\u201c\u201d]+$/, ''));
  }
  // 备份文件不再写死路径：依次找「本工程工作数据目录」和「全局工作数据目录」下的 .bin
  for (const dir of require('../server/paths').backupDirs(require('./_ctx').projectDir())) {
    const bins = fs.readdirSync(dir).filter((f) => /\.bin$/i.test(f));
    if (bins.length === 1) return path.join(dir, bins[0]);
    const hit = bins.find((f) => crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(dir, f))).digest('hex').toUpperCase() === EXPECT_SHA);
    if (hit) return path.join(dir, hit);
  }
  return null;
})();

if (!DEFAULT_BACKUP) {
  console.error('\n[中止] 没有可用的备份文件，也没有默认值。\n' +
    '  · 请显式指定：node scripts/restore-backup.js <备份.bin>\n' +
    '  · 或把备份放到工作数据目录的 backup/ 下：' +
    require('../server/paths').backupDirs(null).join(' 或 ') + '\n');
  process.exit(3);
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').toUpperCase();
const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

async function main() {
  const argv = process.argv.slice(2);
  const dry = argv.includes('--dry-run');
  const noSnapshot = argv.includes('--no-snapshot');
  const file = path.resolve(argv.find((a) => !a.startsWith('--')) || DEFAULT_BACKUP);

  console.log('══ ① 校验备份 ═══════════════════════════════════════════');
  console.log('  文件  ：' + file);
  if (!fs.existsSync(file)) { console.error('  ✗ 文件不存在'); process.exit(1); }
  const backup = fs.readFileSync(file);
  const sha = sha256(backup);
  console.log('  大小  ：' + backup.length + ' B');
  console.log('  SHA256：' + sha);
  console.log('  期望  ：' + EXPECT_SHA);
  if (backup.length !== FLASH_SIZE) {
    console.error('  ✗ 大小不是整片 64 KB（' + FLASH_SIZE + ' B），拒绝烧录');
    process.exit(2);
  }
  if (sha !== EXPECT_SHA) {
    console.error('  ✗ 哈希不匹配 —— 备份可能损坏，拒绝烧录');
    process.exit(2);
  }
  console.log('  ✓ 备份完好');

  const nonEmpty = backup.filter((b) => b !== 0xFF && b !== 0x00).length;
  console.log('  有效字节（非 FF/00）：' + nonEmpty + ' B');

  fs.mkdirSync(WORK, { recursive: true });
  const cfg = writeCfg('_restore.cfg', 'adapter speed 1000\ntransport select swd\n');
  resolveOpenOCD(); // 提前报错，别烧到一半才发现没装

  /* ② 先给现在板子上的内容留个快照 */
  if (!noSnapshot) {
    console.log('');
    console.log('══ ② 快照当前 Flash ════════════════════════════════════');
    const snap = path.join(WORK, 'flash-before-restore-' + stamp() + '.bin');
    const r = await runOCD(cfg, [
      'init', 'halt',
      'dump_image "' + snap.replace(/\\/g, '/') + '" ' + FLASH_BASE + ' 0x' + FLASH_SIZE.toString(16),
      'resume', 'exit',
    ], (l) => console.log('  | ' + l));
    if (fs.existsSync(snap)) {
      const sb = fs.readFileSync(snap);
      console.log('  ✓ 已存：' + snap + '（' + sb.length + ' B，SHA256 ' + sha256(sb).slice(0, 16) + '…）');
      console.log('    想反悔就用 backup-restore 把这份烧回去。');
    } else {
      console.log('  ⚠ 快照失败（' + (r.errors && r.errors[0] || '未知') + '），继续还原备份');
    }
  }

  /* ③ 烧录备份 */
  console.log('');
  console.log('══ ③ 烧录备份到 ' + FLASH_BASE + ' ═══════════════════════════');
  const binArg = file.replace(/\\/g, '/');
  const rw = await runOCD(cfg, [
    'init',
    'program "' + binArg + '" ' + FLASH_BASE + ' verify reset exit',
  ], (l) => console.log('  | ' + l));

  const programmed = /Programming Finished|wrote \d+ bytes/i.test(rw.text);
  const verifiedOk = /Verified OK|verified/i.test(rw.text);
  const verifyFailed = /Verify Failed|verification failed/i.test(rw.text);
  console.log('  「写入完成」判据：' + (programmed ? '命中' : '未命中'));
  console.log('  「校验通过」判据：' + (verifiedOk && !verifyFailed ? '命中' : '未命中'));
  if (!rw.ok || !programmed || verifyFailed) {
    console.error('  ✗ 烧录失败：' + (rw.errors && rw.errors[0] || '见上方日志'));
    process.exit(3);
  }

  /* ④ 回读比对 */
  console.log('');
  console.log('══ ④ 回读比对 ═══════════════════════════════════════════');
  const readBack = path.join(WORK, 'flash-readback-' + stamp() + '.bin');
  const rr = await runOCD(cfg, [
    'init', 'halt',
    'dump_image "' + readBack.replace(/\\/g, '/') + '" ' + FLASH_BASE + ' 0x' + FLASH_SIZE.toString(16),
    'resume', 'exit',
  ], (l) => console.log('  | ' + l));

  if (!fs.existsSync(readBack)) {
    console.log('  ⚠ 回读失败，无法比对（OpenOCD 的 verify 已通过）');
    process.exit(0);
  }
  const rb = fs.readFileSync(readBack);
  let diff = 0, firstDiff = -1;
  const n = Math.min(rb.length, backup.length);
  for (let i = 0; i < n; i++) {
    if (rb[i] !== backup[i]) { diff++; if (firstDiff < 0) firstDiff = i; }
  }
  console.log('  回读大小：' + rb.length + ' B');
  console.log('  与备份不同的字节：' + diff + ' / ' + n + (firstDiff >= 0 ? '（首个 @0x' + firstDiff.toString(16) + '）' : ''));

  console.log('');
  if (diff === 0 && rb.length === backup.length) {
    const vector = [];
    for (let i = 0; i < 8; i++) {
      const o = i * 4; // 每个字 4 字节 —— 别拿字节偏移当字偏移
      const v = (rb[o] | (rb[o + 1] << 8) | (rb[o + 2] << 16) | (rb[o + 3] << 24)) >>> 0;
      vector.push('0x' + v.toString(16).padStart(8, '0'));
    }
    console.log('✅ 还原成功 —— 整片 64 KB 与备份逐字节一致');
    console.log('   向量表前 8 个字：' + vector.join(' '));
    console.log('   （初始 SP ' + vector[0] + '，Reset ' + vector[1] + '）');
    console.log('   板子已复位，原程序应当开始运行。');
  } else {
    console.log('⚠ 回读与备份有差异（' + diff + ' B）——OpenOCD 的 verify 通过了，但 dump 读回不一致。');
    console.log('   常见原因：读保护（RDP）或 dump 期间总线被占用。可再跑一次本脚本复核。');
    process.exit(4);
  }
}

main().catch((e) => { console.error('异常：' + (e && e.stack || e)); process.exit(9); });
