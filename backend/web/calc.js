/* calc.js — 两个真算得准的工程计算器
 *   1) 定时器定时周期：TIMx 16 位，period = (PSC+1)*(ARR+1)/TIMxCLK
 *   2) USART 波特率 BRR：F1 只有 16 倍过采样，USARTDIV = PCLK/(16*baud)，
 *      BRR = DIV_Mantissa<<4 | DIV_Fraction，小数按 1/16 就近取整并处理进位。
 * 纯函数（timer / solveTimer / brr）与 DOM 装配（mount）分开，便于用 node 直接验证数值。
 */
window.STM32Calc = (function () {
  'use strict';

  /* ───────── 数值格式 ───────── */
  function trim(x, sig) {
    if (!isFinite(x)) return '—';
    if (x === 0) return '0';
    const a = Math.abs(x);
    if (a >= 1e9 || a < 1e-6) return x.toExponential(4);
    return String(Number(x.toPrecision(sig || 6)));
  }
  function timeParts(sec) {
    if (!isFinite(sec)) return [NaN, 's'];
    const a = Math.abs(sec);
    if (a < 1e-3) return [sec * 1e6, 'µs'];
    if (a < 1) return [sec * 1e3, 'ms'];
    if (a < 60) return [sec, 's'];
    return [sec / 60, 'min'];
  }
  function freqParts(hz) {
    const a = Math.abs(hz);
    if (a >= 1e6) return [hz / 1e6, 'MHz'];
    if (a >= 1e3) return [hz / 1e3, 'kHz'];
    return [hz, 'Hz'];
  }

  /* ═════════ 定时器 ═════════ */
  const PSC_MAX = 65535, ARR_MAX = 65535;

  /**
   * @param {{clk:number, psc:number, arr:number}} o  clk 单位 Hz
   * @returns {{ok:boolean, error?:string, period?:number, freq?:number, tick?:number, tickHz?:number, maxPeriod?:number}}
   */
  function timer(o) {
    const clk = Number(o && o.clk);
    const psc = Number(o && o.psc);
    const arr = Number(o && o.arr);
    if (!isFinite(clk) || clk <= 0) return { ok: false, error: '定时器时钟必须是大于 0 的有限数值（单位 Hz）' };
    if (!Number.isInteger(psc) || psc < 0 || psc > PSC_MAX) return { ok: false, error: 'PSC 必须是 0 – ' + PSC_MAX + ' 的整数' };
    if (!Number.isInteger(arr) || arr < 0 || arr > ARR_MAX) return { ok: false, error: 'ARR 必须是 0 – ' + ARR_MAX + ' 的整数' };
    const tickHz = clk / (psc + 1);
    const period = (psc + 1) * (arr + 1) / clk;
    return {
      ok: true, clk, psc, arr,
      tickHz, tick: 1 / tickHz,
      period, freq: 1 / period,
      maxPeriod: (psc + 1) * (ARR_MAX + 1) / clk,
      overflowAt: period > 1e300 ? Infinity : period
    };
  }

  /**
   * 由目标周期反解 PSC / ARR：(PSC+1)*(ARR+1) ≈ T*clk。
   * 从「能装下 ARR 的最小预分频」开始向后扫一段，取实际周期最接近目标的那组
   * （同样接近时取 ARR 更大者 —— 分辨率更高），因此 72 MHz 想要 1 s 会得到
   * PSC=1199 / ARR=59999 这种精确解，而不是误差更大的近似解。
   * @param {number} clk Hz
   * @param {number} targetSec 目标周期（秒）
   */
  function solveTimer(clk, targetSec) {
    const c = Number(clk), T = Number(targetSec);
    if (!isFinite(c) || c <= 0) return { ok: false, error: '定时器时钟必须是大于 0 的有限数值' };
    if (!isFinite(T) || T <= 0) return { ok: false, error: '目标周期必须是大于 0 的有限数值' };
    const ticks = T * c;                       // 需要的计数拍数 = (PSC+1)*(ARR+1)
    if (ticks < 1) return { ok: false, error: '目标周期太短：' + trim(T, 4) + ' s 小于 1 个计数周期（最小 ' + trim(1 / c, 4) + ' s）' };
    if (ticks > 65536 * 65536) {
      return { ok: false, error: '目标周期太长：16 位定时器在 ' + trim(c, 4) + ' Hz 下的上限是 ' + trim(65536 * 65536 / c, 4) + ' s（约 ' + trim(65536 * 65536 / c / 60, 4) + ' min）' };
    }
    const preMin = Math.max(1, Math.ceil(ticks / 65536));
    const preLimit = Math.min(65536, preMin + 1024);
    let best = null;
    for (let pre = preMin; pre <= preLimit; pre++) {
      let arr1 = Math.round(ticks / pre);
      if (arr1 < 1) arr1 = 1;
      if (arr1 > 65536) continue;
      const err = Math.abs(pre * arr1 - ticks) / ticks;
      if (!best || err < best.err - 1e-15 || (err <= best.err + 1e-15 && arr1 > best.arr1)) {
        best = { pre, arr1, err };
      }
      if (err === 0) break;
    }
    if (!best) return { ok: false, error: '无法在 16 位范围内组合出该周期' };
    const psc = best.pre - 1, arr = best.arr1 - 1;
    const r = timer({ clk: c, psc, arr });
    return { ok: true, psc, arr, period: r.period, freq: r.freq, errorPct: (r.period - T) / T * 100, ticks };
  }

  /* ═════════ USART BRR ═════════ */
  /**
   * F1 系列：仅 16 倍过采样，BRR 必须 ≥ 0x10（即 USARTDIV ≥ 1）。
   * @param {number} pclk 外设时钟 Hz
   * @param {number} baud 目标波特率 bit/s
   */
  function brr(pclk, baud) {
    const c = Number(pclk), b = Number(baud);
    if (!isFinite(c) || c <= 0) return { ok: false, error: '外设时钟 PCLK 必须是大于 0 的有限数值（单位 Hz）' };
    if (!isFinite(b) || b <= 0) return { ok: false, error: '波特率必须是大于 0 的有限数值' };
    const maxBaud = c / 16;
    const div = c / (16 * b);
    if (div < 1) {
      return {
        ok: false,
        error: 'PCLK ' + trim(c, 6) + ' Hz 时 16 倍过采样的上限是 ' + trim(maxBaud, 6) + ' bit/s，无法产生 ' + trim(b, 6) + ' bit/s'
      };
    }
    let mantissa = Math.floor(div);
    let fraction = Math.round((div - mantissa) * 16);
    let carried = false;
    if (fraction === 16) { mantissa += 1; fraction = 0; carried = true; }
    if (mantissa > 0xFFF) {
      return { ok: false, error: 'USARTDIV = ' + trim(div, 6) + ' 超出 BRR 的 12 位整数部分（最大 4095.9375）' };
    }
    const brrValue = (mantissa << 4) | fraction;
    const divActual = mantissa + fraction / 16;
    const actualBaud = c / (16 * divActual);
    const errorPct = (actualBaud - b) / b * 100;
    const notes = [];
    if (carried) notes.push('小数部分进位：DIV_Mantissa 已 +1');
    if (Math.abs(errorPct) > 2) notes.push('误差超过 2%，长帧有误码风险');
    if (mantissa < 1) notes.push('BRR < 0x10：RM0008 要求 USARTDIV ≥ 1');
    return {
      ok: true, pclk: c, baud: b, div, mantissa, fraction, brr: brrValue,
      divActual, actualBaud, errorPct, carried, notes, maxBaud
    };
  }

  const COMMON_BAUD = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];

  /* ═════════ DOM 装配 ═════════ */
  function mount(cfg) {
    const doc = (cfg && cfg.document) || document;
    const $ = (id) => doc.getElementById(id);
    if (!$('timerOut') || !$('usartOut')) return null;

    const cell = (label, value, unit, note, tone) =>
      '<div class="result-cell"' + (tone ? ' data-tone="' + tone + '"' : '') + '>' +
        '<span class="rlabel">' + label + '</span>' +
        '<span class="rvalue">' + value + '</span>' + (unit ? '<span class="runit">' + unit + '</span>' : '') +
        (note ? '<span class="rnote">' + note + '</span>' : '') +
      '</div>';

    function renderTimer() {
      const out = $('timerOut');
      const r = timer({ clk: $('tClk').value, psc: $('tPsc').value, arr: $('tArr').value });
      if (!r.ok) { out.innerHTML = cell('无法计算', r.error, '', '', 'err'); return; }
      const [pv, pu] = timeParts(r.period);
      const [fv, fu] = freqParts(r.freq);
      const [tv, tu] = timeParts(r.tick);
      const [mv, mu] = timeParts(r.maxPeriod);
      out.innerHTML =
        cell('周期 T', trim(pv), pu, '= (PSC+1)×(ARR+1)/CLK = ' + trim(r.period, 8) + ' s') +
        cell('频率 f', trim(fv), fu, '= 1/T') +
        cell('计数时钟', trim(r.tickHz, 6), 'Hz', 'CLK/(PSC+1)') +
        cell('单拍时间', trim(tv), tu, '1 个计数') +
        cell('该 PSC 下最长定时', trim(mv), mu, 'ARR = 65535');
    }

    function renderUsart() {
      const out = $('usartOut');
      const pclk = Number($('uClk').value), baud = Number($('uBaud').value);
      const r = brr(pclk, baud);
      if (!r.ok) { out.innerHTML = cell('无法计算', r.error, '', '', 'err'); renderBaudTable(pclk); return; }
      const tone = Math.abs(r.errorPct) > 2 ? 'err' : (Math.abs(r.errorPct) > 1 ? 'warn' : 'ok');
      out.innerHTML =
        cell('USARTDIV', trim(r.div, 8), '', 'PCLK/(16×baud)') +
        cell('BRR 值', '0x' + r.brr.toString(16).toUpperCase().padStart(3, '0'), '', '十进制 ' + r.brr) +
        cell('DIV_Mantissa / Fraction', r.mantissa + ' / ' + r.fraction, '', 'BRR = ' + r.mantissa + '<<4 | ' + r.fraction) +
        cell('实际波特率', trim(r.actualBaud, 8), 'bit/s', 'USARTDIV = ' + trim(r.divActual, 8)) +
        cell('误差', (r.errorPct >= 0 ? '+' : '') + trim(r.errorPct, 4), '%', Math.abs(r.errorPct) <= 2 ? '在常用容差（±2%）内' : '偏大：换时钟或降波特率', tone) +
        (r.notes.length ? cell('备注', r.notes.join('；'), '', '', 'warn') : '');
      renderBaudTable(pclk);
    }

    function renderBaudTable(pclk) {
      const body = $('baudTableBody');
      if (!isFinite(pclk) || pclk <= 0) { body.innerHTML = '<tr class="empty-row"><td colspan="4">PCLK 无效</td></tr>'; return; }
      body.innerHTML = COMMON_BAUD.map((b) => {
        const r = brr(pclk, b);
        if (!r.ok) return '<tr><td class="mono">' + b + '</td><td colspan="3" class="dim">超出 ' + trim(pclk / 16, 6) + ' bit/s 上限</td></tr>';
        const tone = Math.abs(r.errorPct) > 2 ? 'err' : (Math.abs(r.errorPct) > 1 ? 'warn' : '');
        return '<tr><td class="mono">' + b + '</td><td class="mono">0x' + r.brr.toString(16).toUpperCase() +
          '</td><td class="mono">' + trim(r.actualBaud, 7) + '</td><td class="mono"' +
          (tone ? ' style="color:var(--' + tone + ')"' : '') + '>' + (r.errorPct >= 0 ? '+' : '') + trim(r.errorPct, 3) + ' %</td></tr>';
      }).join('');
    }

    function bind() {
      ['tClk', 'tPsc', 'tArr'].forEach((id) => $(id).addEventListener('input', renderTimer));
      ['uClk', 'uBaud'].forEach((id) => $(id).addEventListener('input', renderUsart));
      $('tClkPreset').addEventListener('change', (ev) => {
        if (!ev.target.value) return;
        $('tClk').value = ev.target.value; renderTimer();
      });
      $('uClkPreset').addEventListener('change', (ev) => {
        if (!ev.target.value) return;
        $('uClk').value = ev.target.value; renderUsart();
      });
      $('btnTimerSolve').addEventListener('click', () => {
        const unit = Number($('tTargetUnit').value);
        const target = Number($('tTarget').value) * unit;
        const r = solveTimer(Number($('tClk').value), target);
        if (!r.ok) {
          $('timerOut').innerHTML = cell('求解失败', r.error, '', '', 'err');
          return;
        }
        $('tPsc').value = String(r.psc);
        $('tArr').value = String(r.arr);
        renderTimer();
        $('timerOut').insertAdjacentHTML('afterbegin',
          cell('已回填', 'PSC=' + r.psc + ' ARR=' + r.arr, '', '实际 ' + trim(timeParts(r.period)[0], 6) + ' ' + timeParts(r.period)[1] +
            '，误差 ' + (r.errorPct >= 0 ? '+' : '') + trim(r.errorPct, 4) + '%', Math.abs(r.errorPct) > 1 ? 'warn' : 'ok'));
      });
    }

    bind();
    renderTimer();
    renderUsart();
    return { renderTimer, renderUsart };
  }

  return { timer, solveTimer, brr, COMMON_BAUD, mount, trim, timeParts, freqParts };
})();
