'use strict';
/**
 * verify-consistency.js —— 跨文件一致性校验
 *
 * 为什么需要它：EXTI 曾出现 PB0/PB1/PB2 被写成 EXTI8/9/10 的错误
 * （EXTI 线号只看端口位号 0-15，与端口无关），而 peripherals.json 当时是对的——
 * 两份文件自相矛盾。单文件校验查不出这种错，必须交叉核对。
 *
 * 检查项：
 *   1. pins.json 每条 EXTI 的线号 == 该引脚位号（PD0/PD1 也适用）
 *   2. peripherals.json 里 EXTI 的 signal↔pins 必须与 pins.json 完全一致（双向）
 *   3. peripherals.json 引用的脚号都存在于 pins.json
 *   4. 外设信号的 kind 与 pins.json 中同信号的 kind 一致
 * 用法: node scripts/verify-consistency.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const pins = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'pins.json'), 'utf8'));
const per = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'peripherals.json'), 'utf8'));

let fail = 0, warn = 0, pass = 0;
const P = (m) => { pass++; console.log('  [通过] ' + m); };
const F = (m) => { fail++; console.log('  [失败] ' + m); };
const W = (m) => { warn++; console.log('  [警告] ' + m); };

const byPin = new Map(pins.pins.map(p => [p.pin, p]));

// ---------- 1. EXTI 线号 vs 端口位号 ----------
console.log('\n== 1. EXTI 线号与引脚位号一致 ==');
let extiChecked = 0, extiBad = [];
for (const p of pins.pins) {
  const bitM = /^P[A-E](\d+)/.exec(p.name || '');
  if (!bitM) continue;
  const bit = Number(bitM[1]);
  for (const f of p.functions || []) {
    if (f.kind !== 'exti') continue;
    extiChecked++;
    const line = Number(String(f.signal).replace(/\D/g, ''));
    if (line !== bit) extiBad.push(`pin ${p.pin} ${p.name}: 写 ${f.signal}，应为 EXTI${bit}`);
  }
}
if (extiChecked === 0) F('没有找到任何 EXTI 条目');
else if (extiBad.length) extiBad.forEach(b => F(b));
else P(`${extiChecked} 条 EXTI 全部与位号一致`);

// ---------- 2. peripherals.json 的 EXTI ↔ pins.json 双向一致 ----------
console.log('\n== 2. EXTI 映射双向一致 ==');
const extiPer = (per.peripherals || []).find(x => x.id === 'EXTI');
if (!extiPer) F('peripherals.json 缺少 EXTI 条目');
else {
  const fromPer = new Map(); // 线号 -> Set(pin)
  for (const s of extiPer.signals) {
    const line = Number(String(s.signal).replace(/\D/g, ''));
    fromPer.set(line, new Set(s.pins));
  }
  const fromPins = new Map();
  for (const p of pins.pins) {
    for (const f of p.functions || []) {
      if (f.kind !== 'exti') continue;
      const line = Number(String(f.signal).replace(/\D/g, ''));
      if (!fromPins.has(line)) fromPins.set(line, new Set());
      fromPins.get(line).add(p.pin);
    }
  }
  let mismatched = 0;
  for (const [line, set] of fromPins) {
    const other = fromPer.get(line);
    if (!other) { F(`pins.json 有 EXTI${line}，peripherals.json 没有这条线`); mismatched++; continue; }
    for (const pin of set) if (!other.has(pin)) { F(`EXTI${line}: pins.json 含脚 ${pin}，peripherals.json 不含`); mismatched++; }
  }
  for (const [line, set] of fromPer) {
    const other = fromPins.get(line) || new Set();
    for (const pin of set) if (!other.has(pin)) { F(`EXTI${line}: peripherals.json 含脚 ${pin}，pins.json 不含`); mismatched++; }
  }
  if (!mismatched) P(`EXTI0-15 共 ${fromPer.size} 条线的引脚映射两文件完全一致`);
}

// ---------- 3. peripherals 引用脚号存在性 + 信号确实属于该脚 ----------
// 匹配策略：先按 kind（外设表 kind 与引脚功能 kind 同为领域分类），再做信号名词元交集。
// 为什么不直接比字符串：两边命名口径不同是合理的（pins.json 写 "JTMS/SWDIO"，
// 外设表写 "SWDIO"；pins.json 写 "USART1_TX"，外设表写 "TX"）。硬比字符串会制造假警报。
console.log('\n== 3. 外设引用脚号与信号归属一致 ==');
const KIND_ALIAS = { boot: 'boot', debug: 'debug', pwr: 'pwr' };
let refCount = 0, missing = 0, notOnPin = 0, kindMismatch = 0;
const tokensOf = (s) => String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
for (const item of per.peripherals || []) {
  for (const s of item.signals || []) {
    const sigTokens = tokensOf(s.signal);
    for (const pinNo of s.pins || []) {
      refCount++;
      const p = byPin.get(pinNo);
      if (!p) { F(`${item.id}/${s.signal} 引用不存在的脚号 ${pinNo}`); missing++; continue; }
      // kind 口径必须相同（同为领域分类）
      const sameKind = (p.functions || []).filter(f => f.kind === item.kind);
      if (sameKind.length === 0) {
        F(`${item.id}/${s.signal} 引用脚 ${pinNo}(${p.name})，但该脚没有任何 kind=${item.kind} 的功能`);
        kindMismatch++;
        continue;
      }
      // 信号名词元交集：至少共享一个可辨识词元
      const hit = sameKind.some(f => {
        const ft = tokensOf(f.signal);
        return sigTokens.some(t => ft.includes(t));
      });
      if (!hit) {
        W(`${item.id}/${s.signal} 引用脚 ${pinNo}(${p.name})，但该脚的 ${item.kind} 信号为 [${sameKind.map(f => f.signal).join(', ')}]（命名口径不同或缺登记）`);
        notOnPin++;
      }
    }
  }
}
if (!missing) P(`${refCount} 条外设-脚号引用全部指向存在的引脚`);
if (!kindMismatch) P('每条引用都能在该脚找到同 kind 的功能（无分类错配）');
if (notOnPin) W(`${notOnPin} 条引用的信号名与引脚侧命名不同（不一定是错，建议人工确认一次）`);

// ---------- 4. 汇总 ----------
console.log('\n' + '='.repeat(46));
console.log(`  检查通过 ${pass} · 失败 ${fail} · 警告 ${warn}`);
console.log(`  结果：${fail === 0 ? 'PASS' : 'FAIL'}`);
console.log('');
process.exit(fail === 0 ? 0 : 1);
