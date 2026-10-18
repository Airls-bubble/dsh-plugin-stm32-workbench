/* selftest.js — 交付前自验（Node 直接跑，不需要浏览器、不依赖后端）
 *
 *   node web/selftest.js            # 只用内置兜底表
 *   node web/selftest.js --api      # 额外拉一次 GET /api/pins 做在线数据一致性检查
 *
 * 覆盖：LQFP48 几何方向 / 角邻关系、标签与热区不重叠、定时器与 USART 数值、
 *       分配与冲突规则、C 代码生成的寄存器位移、兜底表与在线数据的字段一致性。
 * 不覆盖：真实浏览器里的 DOM 交互与像素级视觉（见 README §7 的 Edge headless 记录）。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const wantApi = process.argv.indexOf('--api') >= 0;
const ok = [], bad = [];
const T = (cond, msg) => { (cond ? ok : bad).push(msg); };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* ── 载入前端模块（它们在浏览器里挂到 window 上） ── */
const sandbox = { window: {}, console: console };
function load(file) {
  const src = fs.readFileSync(path.join(HERE, file), 'utf8');
  const fn = new Function('window', 'document', 'navigator', 'localStorage', src + '\n//# sourceURL=' + file);
  fn(sandbox.window, undefined, undefined, undefined);
}
load('pinout.js');
load('calc.js');
const P = sandbox.window.STM32Pinout;
const C = sandbox.window.STM32Calc;
T(!!P, 'pinout.js 暴露 STM32Pinout');
T(!!C, 'calc.js 暴露 STM32Calc');
if (!P || !C) { console.log(bad.map((m) => '✗ ' + m).join('\n')); process.exit(1); }

/* ── 1. 几何：脚号 → 坐标 ── */
const G = P.GEOM;
const pitch = G.body.w / G.perSide;
const corner = pitch * Math.SQRT1_2;
const L = (n) => P.layout(n);
const dist = (a, b) => Math.hypot(L(a).x - L(b).x, L(a).y - L(b).y);

for (let n = 1; n <= 12; n++) T(L(n).orient === 'left', '脚 ' + n + ' 在左侧');
for (let n = 13; n <= 24; n++) T(L(n).orient === 'bottom', '脚 ' + n + ' 在底边');
for (let n = 25; n <= 36; n++) T(L(n).orient === 'right', '脚 ' + n + ' 在右侧');
for (let n = 37; n <= 48; n++) T(L(n).orient === 'top', '脚 ' + n + ' 在顶边');
let dirOk = true;
for (let n = 1; n < 12; n++) if (!(L(n).y < L(n + 1).y)) dirOk = false;          // 左侧自上而下
for (let n = 13; n < 24; n++) if (!(L(n).x < L(n + 1).x)) dirOk = false;         // 底边自左向右
for (let n = 25; n < 36; n++) if (!(L(n).y > L(n + 1).y)) dirOk = false;         // 右侧自下而上
for (let n = 37; n < 48; n++) if (!(L(n).x > L(n + 1).x)) dirOk = false;         // 顶边自右向左
T(dirOk, '四段编号方向：左↓ / 底→ / 右↑ / 顶←');

const seen = new Map();
let dupPos = null;
for (let n = 1; n <= 48; n++) {
  const k = L(n).x.toFixed(3) + ',' + L(n).y.toFixed(3);
  if (seen.has(k)) dupPos = n + '/' + seen.get(k);
  seen.set(k, n);
}
T(dupPos === null, '48 个引脚坐标互不重复' + (dupPos ? '（重复：' + dupPos + '）' : ''));
T(near(dist(48, 1), corner, 0.05), '脚 48 与脚 1 相邻（对角间距 ' + corner.toFixed(2) + '）');
T(near(dist(36, 37), corner, 0.05), '脚 36 与脚 37 相邻 → 37 在顶右');
for (const [p, want] of [[36, 37], [37, 36], [48, 1], [1, 48]]) {
  let best = 0, bd = Infinity;
  for (let n = 1; n <= 48; n++) { if (n === p) continue; const d = dist(p, n); if (d < bd) { bd = d; best = n; } }
  T(best === want, '脚 ' + p + ' 的最近邻是脚 ' + want);
}

/* ── 2. 图面文字与热区不相交 ── */
const pins = P.fallbackData().pins;
const byNo = new Map(pins.map((p) => [p.pin, p]));
const CH = 8.4, LH = 15;
function textBox(anchor, x, y, text) {
  const w = String(text).length * CH;
  const x1 = anchor === 'end' ? x - w : (anchor === 'middle' ? x - w / 2 : x);
  return { x1, x2: x1 + w, y1: y - LH / 2, y2: y + LH / 2 };
}
const items = [];
for (let n = 1; n <= 48; n++) {
  const d = P.pinDrawing(n), pin = byNo.get(n);
  items.push(Object.assign(textBox(d.name.anchor, d.name.x, d.name.y, P.shortName(pin.name)), { n, kind: 'name' }));
  items.push(Object.assign(textBox(d.num.anchor, d.num.x, d.num.y, String(n)), { n, kind: 'num' }));
}
let overlap = null;
for (let i = 0; i < items.length && !overlap; i++) {
  for (let j = i + 1; j < items.length; j++) {
    const a = items[i], b = items[j];
    if (Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) > 0.5 && Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) > 0.5) {
      overlap = a.n + '/' + a.kind + ' × ' + b.n + '/' + b.kind; break;
    }
  }
}
T(overlap === null, '96 段引脚名/脚号文字互不相交' + (overlap ? '（重叠：' + overlap + '）' : ''));
const vb = G.viewBox;
T(items.every((t) => t.x1 >= 2 && t.x2 <= vb[2] - 2 && t.y1 >= 2 && t.y2 <= vb[3] - 2), '全部文字在 viewBox 内（估算字宽 ' + CH + '/字）');
const hits = [];
for (let n = 1; n <= 48; n++) { const d = P.pinDrawing(n); hits.push({ n, x1: d.hit.x, x2: d.hit.x + d.hit.w, y1: d.hit.y, y2: d.hit.y + d.hit.h }); }
let hitOverlap = null;
for (let i = 0; i < 48 && !hitOverlap; i++) {
  for (let j = i + 1; j < 48; j++) {
    const a = hits[i], b = hits[j];
    if (Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) > 0.5 && Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1) > 0.5) { hitOverlap = a.n + '×' + b.n; break; }
  }
}
T(hitOverlap === null, '48 个点击热区互不重叠' + (hitOverlap ? '（重叠：' + hitOverlap + '）' : ''));

/* ── 3. 兜底表自身 ── */
T(pins.length === 48, '兜底表 48 条');
T(new Set(pins.map((p) => p.pin)).size === 48, '脚号 1..48 无重复');
T(pins.every((p) => p.pin >= 1 && p.pin <= 48), '脚号都在 1..48');
T(pins.every((p) => !p.io || (p.port === 'A' || p.port === 'B' || p.port === 'C' || typeof p.port === 'string')), 'io 脚都有端口信息');

/* ── 4. 计算器 ── */
const r1 = C.timer({ clk: 72000000, psc: 7199, arr: 9999 });
T(r1.ok && near(r1.period, 1, 1e-12) && near(r1.freq, 1, 1e-12), 'T(72MHz,7199,9999) = 1 s / 1 Hz');
T(!C.timer({ clk: 0, psc: 1, arr: 1 }).ok, 'clk=0 报错');
T(!C.timer({ clk: 72e6, psc: 70000, arr: 1 }).ok, 'PSC 越界报错');
T(!C.timer({ clk: 72e6, psc: 1, arr: -1 }).ok, 'ARR 为负报错');
const s1 = C.solveTimer(72000000, 1);
T(s1.ok && near(s1.period, 1, 1e-9) && s1.psc >= 0 && s1.psc <= 65535 && s1.arr >= 0 && s1.arr <= 65535, '反解 1 s → PSC=' + s1.psc + ' / ARR=' + s1.arr + '（精确命中 1 s）');
T(!C.solveTimer(72000000, 1e-9).ok, '目标周期过短报错');
T(!C.solveTimer(1e3, 1e9).ok, '目标周期过长报错');
const b1 = C.brr(72000000, 115200);
T(b1.ok && b1.brr === 0x271 && b1.mantissa === 39 && b1.fraction === 1 && near(b1.errorPct, 0, 1e-9), 'BRR(72MHz,115200) = 0x271（39/1，误差 0%）');
const b2 = C.brr(36000000, 115200);
T(b2.ok && b2.brr === 0x139 && near(b2.errorPct, -0.16, 0.01), 'BRR(36MHz,115200) = 0x139（误差 −0.16%）');
const b3 = C.brr(8000000, 115200);
T(b3.ok && b3.brr === 0x45 && near(b3.errorPct, 0.64, 0.02), 'BRR(8MHz,115200) = 0x45（误差 +0.64%）');
const b4 = C.brr(72000000, 72000000 / (16 * 25.99));
T(b4.ok && b4.mantissa === 26 && b4.fraction === 0 && b4.carried, '小数进位：25.99 → mantissa 26 / fraction 0');
T(!C.brr(72000000, 5e6).ok, '超过 PCLK/16 的波特率报错');
T(!C.brr(0, 115200).ok, 'PCLK=0 报错');

/* ── 5. 分配 / 冲突 / 代码生成 ── */
function mk(pin, roleId, data) {
  const p = (data || pins).find((x) => x.pin === pin);
  const a = P.availableRoles(p).find((r) => r.role.id === roleId);
  if (!a) throw new Error('脚 ' + pin + ' 不支持 ' + roleId);
  return { pin, roleId, peripheral: a.fn.peripheral, signal: a.fn.signal, core: a.fn.core, kind: a.fn.kind, mode: a.role.mode, remap: !!a.fn.remap };
}
T(P.availableRoles(byNo.get(1)).length === 0, '电源脚不可分配');
T(P.availableRoles(byNo.get(30)).some((r) => r.role.id === 'usart-tx'), 'PA9 可分配 USART TX');
{
  const v = P.validate([mk(30, 'usart-tx'), mk(31, 'usart-rx')], byNo);
  T(v.errors.length === 0, 'USART1 TX+ RX 无冲突');
  const v2 = P.validate([mk(30, 'usart-tx'), mk(42, 'usart-tx')], byNo);
  T(v2.errors.some((e) => e.code === 'channel'), '同一 USART1_TX 被两脚占用 → 通道冲突');
  T(P.channelKey(mk(42, 'usart-tx')) === 'USART1:TX', 'channelKey 归一化（USART1_USART1_TX → USART1:TX）');
}
{
  const code = P.generateCode([mk(30, 'usart-tx'), mk(31, 'usart-rx')], { mcu: 'STM32F103C8T6', package: 'LQFP48', pins });
  T(code.code.indexOf('GPIOA->CRH = (GPIOA->CRH & ~(0xFUL << 4)) | (0xBUL << 4);') >= 0, 'PA9 → CRH 位移 4 / 0xB（复用推挽）');
  T(code.code.indexOf('GPIOA->CRH = (GPIOA->CRH & ~(0xFUL << 8)) | (0x4UL << 8);') >= 0, 'PA10 → CRH 位移 8 / 0x4（浮空输入）');
  T(code.code.indexOf('AFIO_MAPR_USART1_REMAP') < 0, 'PA9/PA10 是 USART1 默认脚，不写重映射');
  const c2 = P.generateCode([mk(42, 'usart-tx')], { mcu: 'STM32F103C8T6', package: 'LQFP48', pins });
  T(c2.code.indexOf('AFIO->MAPR = (AFIO->MAPR & ~AFIO_MAPR_USART1_REMAP) | AFIO_MAPR_USART1_REMAP;') >= 0, 'PB6 是 USART1 重映射脚 → 写 AFIO->MAPR');
  const c3 = P.generateCode([mk(42, 'i2c-scl')], { mcu: 'STM32F103C8T6', package: 'LQFP48', pins });
  T(c3.code.indexOf('GPIOB->CRL = (GPIOB->CRL & ~(0xFUL << 24)) | (0xFUL << 24);') >= 0, 'PB6 → CRL 位移 24 / 0xF（复用开漏）');
  const c4 = P.generateCode([mk(45, 'i2c-scl')], { mcu: 'STM32F103C8T6', package: 'LQFP48', pins });
  T(c4.code.indexOf('AFIO_MAPR_I2C1_REMAP') >= 0, 'PB8 是 I2C1 重映射脚 → 写 I2C1_REMAP');
  const c5 = P.generateCode([mk(18, 'exti')], { mcu: 'STM32F103C8T6', package: 'LQFP48', pins });
  T(/AFIO->EXTICR\[/.test(c5.code) && /NVIC_EnableIRQ\(EXTI/.test(c5.code), 'EXTI 生成 EXTICR 与 NVIC_EnableIRQ');
  const c6 = P.generateCode([mk(30, 'gpio-out')], { mcu: 'STM32F103C8T6', package: 'LQFP48', pins });
  T(c6.code.indexOf('GPIOA->CRH = (GPIOA->CRH & ~(0xFUL << 4)) | (0x3UL << 4);') >= 0, 'PA9 GPIO 推挽输出 → 0x3');
}

/* ── 6. 在线数据（可选） ── */
(async function () {
  if (wantApi) {
    let data = null, used = '';
    for (const u of ['http://127.0.0.1:8788/api/pins', 'http://127.0.0.1:8789/api/pins']) {
      try {
        const res = await fetch(u, { signal: AbortSignal.timeout(4000) });
        if (res.ok) { data = await res.json(); used = u; break; }
      } catch (e) { /* 下一个 */ }
    }
    if (!data) {
      console.log('! 跳过在线检查：/api/pins 不可达（这不影响离线自验结论）');
    } else {
      const norm = P.normalizePinData(data);
      T(!!norm, '在线数据可被 normalizePinData 接受（' + used + '）');
      if (norm) {
        const live = new Map(norm.pins.map((p) => [p.pin, p]));
        T(live.get(30).port === 'A', "port 'PA9' → 'A'");
        T(live.get(30).functions.some((f) => f.core === 'TX'), "signal 'USART1_TX' → core 'TX'");
        T(P.availableRoles(live.get(5)).length === 0, 'PD0（脚 5）在 LQFP48 上不可分配');
        let same = true;
        for (const p of pins) {
          const q = live.get(p.pin);
          if (!q || !!p.io !== !!q.io || !!p.fiveVTolerant !== !!q.fiveVTolerant || (p.verified === false) !== (q.verified === false)) same = false;
        }
        T(same, '内置兜底表与在线数据的 io / fiveVTolerant / verified 逐脚一致');
      }
    }
  }
  console.log(ok.map((m) => '  ✓ ' + m).join('\n'));
  console.log(bad.length
    ? ('\nFAIL ' + bad.length + ' 项\n' + bad.map((m) => '  ✗ ' + m).join('\n'))
    : ('\nPASS 自验通过：' + ok.length + ' 项检查（几何 / 标签 / 计算器 / 分配冲突 / 代码生成' + (wantApi ? ' / 在线数据' : '') + '）'));
  process.exit(bad.length ? 1 : 0);
})();
