'use strict';
/**
 * verify-artifact.js —— 产物结构校验
 *
 * 目的：证明生成的固件在结构上确实是「能被 Cortex-M3 从 0x08000000 启动」的镜像，
 * 而不是只看文件存在。检查项：
 *   1. Intel HEX 记录格式、校验和、结束记录
 *   2. 中断向量表：初始 SP 必须落在 SRAM（0x20000000..0x20005000）
 *   3. Reset_Handler 必须落在 Flash 内且为奇数（Thumb 位）
 *   4. .bin 大小与 Flash 容量
 * 用法: node scripts/verify-artifact.js [工程名，默认 blink-uart]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const project = process.argv[2] || 'blink-uart';
/* 自带测试工程的构建输出现在落在全局工作数据目录（不写进插件本体） */
const dir = path.join(require('../server/paths').globalRoot(), 'build', project);

const FLASH_BASE = 0x08000000;
const FLASH_SIZE = 64 * 1024;
const SRAM_BASE = 0x20000000;
const SRAM_SIZE = 20 * 1024;

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail });
  return ok;
}

// ---------- 1. Intel HEX ----------
const hexFile = path.join(dir, `${project}.hex`);
let minAddr = Infinity, maxAddr = -Infinity, bytes = 0, lineNo = 0, sawEof = false;
const memory = new Map(); // addr -> byte（用于读向量表）

if (!fs.existsSync(hexFile)) {
  check('HEX 文件存在', false, hexFile + ' 不存在，先构建');
} else {
  const lines = fs.readFileSync(hexFile, 'utf8').split(/\r?\n/).filter(Boolean);
  let base = 0, badChecksum = 0, badFormat = 0;
  for (const line of lines) {
    lineNo++;
    if (line[0] !== ':') { badFormat++; continue; }
    const hexPart = line.slice(1);
    const raw = Buffer.from(hexPart, 'hex');
    const sum = raw.reduce((a, b) => (a + b) & 0xff, 0);
    if (sum !== 0) badChecksum++;
    const len = raw[0], addr = (raw[1] << 8) | raw[2], type = raw[3];
    const data = raw.slice(4, 4 + len);
    if (type === 0x00) {
      const abs = base + addr;
      for (let i = 0; i < data.length; i++) {
        memory.set(abs + i, data[i]);
        minAddr = Math.min(minAddr, abs + i);
        maxAddr = Math.max(maxAddr, abs + i);
      }
      bytes += data.length;
    } else if (type === 0x01) { sawEof = true; }
    else if (type === 0x04) { base = ((data[0] << 8) | data[1]) << 16; }
  }
  check('HEX 记录格式合法', badFormat === 0, badFormat ? `${badFormat} 行不是 : 开头` : `${lineNo} 行全部合法`);
  check('HEX 校验和正确', badChecksum === 0, badChecksum ? `${badChecksum} 行校验和错误` : '全部通过');
  check('HEX 有结束记录(EOF)', sawEof, sawEof ? ':00000001FF 存在' : '缺少 EOF 记录');
  check('HEX 覆盖 Flash 地址区间', minAddr >= FLASH_BASE && maxAddr < FLASH_BASE + FLASH_SIZE,
    `0x${minAddr.toString(16)}..0x${maxAddr.toString(16)}（${bytes} 字节）`);
}

// ---------- 2/3. 中断向量表 ----------
function read32(addr) {
  const b = [0, 1, 2, 3].map(i => memory.get(addr + i));
  if (b.some(x => x === undefined)) return null;
  return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
}
if (memory.size) {
  const sp = read32(FLASH_BASE);
  const reset = read32(FLASH_BASE + 4);
  const nmi = read32(FLASH_BASE + 8);
  check('向量表[0] 初始 SP 落在 SRAM',
    sp !== null && sp >= SRAM_BASE && sp <= SRAM_BASE + SRAM_SIZE,
    sp === null ? '读不到' : `SP=0x${sp.toString(16)}（合法区间 0x${SRAM_BASE.toString(16)}..0x${(SRAM_BASE + SRAM_SIZE).toString(16)}）`);
  check('向量表[1] Reset_Handler 在 Flash 内且带 Thumb 位',
    reset !== null && reset % 2 === 1 && (reset & ~1) >= FLASH_BASE && (reset & ~1) < FLASH_BASE + FLASH_SIZE,
    reset === null ? '读不到' : `Reset=0x${reset.toString(16)}（最低位 1 表示 Thumb）`);
  check('向量表[2] NMI 向量非 0', nmi !== null && nmi !== 0,
    nmi === null ? '读不到' : `NMI=0x${nmi.toString(16)}`);
}

// ---------- 4. .bin ----------
const binFile = path.join(dir, `${project}.bin`);
if (fs.existsSync(binFile)) {
  const size = fs.statSync(binFile).size;
  check('.bin 小于 64 KB Flash 上限', size > 0 && size <= FLASH_SIZE,
    `${size} B / ${FLASH_SIZE} B（${(size / FLASH_SIZE * 100).toFixed(2)}%）`);
} else {
  check('.bin 存在', false, '未生成');
}

// ---------- 汇总 ----------
const pass = checks.filter(c => c.ok).length;
console.log('');
console.log(`  产物校验：${project}`);
console.log('  ' + '─'.repeat(62));
for (const c of checks) {
  console.log(`  ${c.ok ? '[通过]' : '[失败]'} ${c.name}`);
  if (c.detail) console.log(`         ${c.detail}`);
}
console.log('  ' + '─'.repeat(62));
console.log(`  结果：${pass}/${checks.length} 通过`);
console.log('');
process.exit(pass === checks.length ? 0 : 1);
