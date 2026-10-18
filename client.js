/**
 * 客户端半边：DSH 内的「单片机工作台」。
 *
 * 设计取自 dsh-openwrite 的正确做法，而不是把面板挂在每个对话里：
 *   1. 入口 = 侧栏底部按钮（sidebar.footer.action）：选工作区 → 建会话 → 选中 mcu 预设 → 打开
 *   2. 工作台 = conversation.view，**只在当前会话属于 mcu 预设时挂载**（门控见 isMcuSession）
 *   3. 面板数据来自宿主半边注册的同源路由 /mcu/api/*
 *
 * 只用主题令牌（--dsw-alias-*），不 import 任何 Harness 客户端包。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-stm32-workbench',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback, useMemo } = React;

    const API = '/mcu/api';
    const PRESET_ID = 'mcu';

    /* ────────────────────────── 样式（主题令牌） ────────────────────────── */

    const STYLE = `
      .wb-root{font-family:inherit;color:var(--dsw-alias-label-primary);font-size:12px;height:100%;
        display:flex;flex-direction:column;background:var(--dsw-alias-bg-base)}
      .wb-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
      .wb-title{font-size:13px;font-weight:600}
      .wb-chip{font-size:11px;padding:2px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);
        color:var(--dsw-alias-label-secondary);white-space:nowrap}
      .wb-chip.ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
      .wb-chip.warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
      .wb-spacer{flex:1 1 auto}
      .wb-btn{font:inherit;font-size:12px;line-height:1;padding:5px 9px;border-radius:6px;cursor:pointer;
        border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
      .wb-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}
      .wb-btn:disabled{opacity:.45;cursor:not-allowed}
      .wb-btn.primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
      .wb-tabs{display:flex;gap:4px;padding:8px 12px 0;border-bottom:1px solid var(--dsw-alias-border-l1);flex-wrap:wrap}
      .wb-tab{font:inherit;font-size:12px;padding:5px 10px;border:1px solid transparent;border-bottom:none;
        border-radius:6px 6px 0 0;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
      .wb-tab[aria-selected="true"]{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l1);
        background:var(--dsw-alias-bg-layer-2)}
      .wb-body{padding:12px;overflow:auto;flex:1 1 auto}
      .wb-grid{display:grid;grid-template-columns:minmax(260px,1fr) minmax(280px,1.15fr);gap:14px}
      @media (max-width:900px){.wb-grid{grid-template-columns:1fr}}
      .wb-log{font-family:ui-monospace,Consolas,"Courier New",monospace;font-size:11.5px;line-height:1.5;
        white-space:pre-wrap;word-break:break-all;max-height:320px;overflow:auto;padding:8px;border-radius:6px;
        background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);margin:6px 0 0}
      .wb-log .e{color:var(--dsw-alias-state-error-primary)}
      .wb-log .w{color:var(--dsw-alias-state-warn-primary)}
      .wb-log .c{color:var(--dsw-alias-label-secondary)}
      .wb-log .k{color:var(--dsw-alias-state-success-primary)}
      .wb-field{display:flex;align-items:center;gap:6px;font-size:12px;margin:5px 0;flex-wrap:wrap}
      .wb-field label{color:var(--dsw-alias-label-secondary);min-width:56px}
      .wb-field input,.wb-field select{font:inherit;font-size:12px;padding:4px 6px;border-radius:6px;
        border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);min-width:0}
      .wb-field input{width:120px}
      .wb-kv{font-size:12px;color:var(--dsw-alias-label-secondary);display:flex;justify-content:space-between;gap:10px;padding:2px 0}
      .wb-kv b{color:var(--dsw-alias-label-primary);font-weight:600}
      .wb-pin{stroke:var(--dsw-alias-border-l2);fill:var(--dsw-alias-bg-layer-2);cursor:pointer}
      .wb-pin.on{stroke:var(--dsw-alias-brand-primary);fill:var(--dsw-alias-brand-primary)}
      .wb-pintext{font-size:7.5px;fill:var(--dsw-alias-label-secondary);pointer-events:none}
      .wb-pintext.on{fill:var(--dsw-alias-label-primary)}
      .wb-pin.cfg{fill:var(--dsw-alias-state-success-primary);stroke:var(--dsw-alias-state-success-primary)}
      .wb-pin.conflict{fill:var(--dsw-alias-state-warn-primary);stroke:var(--dsw-alias-state-warn-primary)}
      .wb-pin.on{fill:var(--dsw-alias-brand-primary);stroke:var(--dsw-alias-brand-primary)}
      .wb-legend{display:flex;gap:12px;font-size:11px;color:var(--dsw-alias-label-secondary);
        justify-content:center;flex-wrap:wrap;margin-top:6px}
      .wb-dot{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:4px;vertical-align:-1px}
      .wb-tag{font-size:10.5px;padding:1px 6px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);
        color:var(--dsw-alias-label-secondary);white-space:nowrap}
      .wb-tag.ok{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}
      .wb-tag.bad{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
      .wb-inline{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:0 0 10px}
      .wb-inline input{flex:1 1 240px;font:inherit;font-size:12px;padding:5px 7px;border-radius:6px;
        border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
      .wb-card{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px;margin:0 0 10px}
      .wb-note{font-size:11.5px;color:var(--dsw-alias-label-secondary);line-height:1.6}
      .wb-sec{font-size:12px;font-weight:600;margin:0 0 4px}
      .wb-diag{border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:6px 8px;margin:0 0 6px;
        background:var(--dsw-alias-bg-layer-2)}
      .wb-diag.click{cursor:pointer}
      .wb-diag.click:hover{border-color:var(--dsw-alias-brand-primary)}
      .wb-diag-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
      .wb-diag-lvl{font-size:10.5px;padding:1px 6px;border-radius:999px;border:1px solid currentColor;white-space:nowrap}
      .wb-diag-lvl.error{color:var(--dsw-alias-state-error-primary)}
      .wb-diag-lvl.warning{color:var(--dsw-alias-state-warn-primary)}
      .wb-diag-lvl.info{color:var(--dsw-alias-label-secondary)}
      .wb-diag-loc{font-family:ui-monospace,Consolas,"Courier New",monospace;font-size:11.5px;
        color:var(--dsw-alias-label-primary);word-break:break-all}
      .wb-diag-code{font-size:11px;color:var(--dsw-alias-label-secondary)}
      .wb-diag-msg{font-size:12px;color:var(--dsw-alias-label-primary);margin-top:3px;line-height:1.55;word-break:break-word}
      .wb-src{font-family:ui-monospace,Consolas,"Courier New",monospace;font-size:11.5px;line-height:1.6;
        background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;
        padding:8px;margin:6px 0 0;overflow:auto;max-height:240px}
      .wb-src div{white-space:pre-wrap;word-break:break-all}
      .wb-src .ln{color:var(--dsw-alias-label-secondary);user-select:none;margin-right:8px}
      .wb-src .hit{outline:1px solid var(--dsw-alias-state-error-primary);border-radius:3px}
      .wb-entry{display:flex;align-items:center;gap:8px;font:inherit;font-size:13px;padding:6px 10px;cursor:pointer;
        border:1px solid transparent;border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary)}
      .wb-entry:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1)}
      .wb-dialog{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-overlay);
        color:var(--dsw-alias-label-primary);padding:16px;max-width:440px;width:calc(100vw - 40px);font-size:13px}
      .wb-dialog::backdrop{background:rgba(0,0,0,.35)}
      .wb-dialog h2{margin:0 0 6px;font-size:15px}
      .wb-dialog p{margin:0 0 10px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}
      .wb-dialog input{width:100%;box-sizing:border-box;font:inherit;font-size:12px;padding:6px 8px;border-radius:6px;
        border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
      .wb-row{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
      .wb-err{color:var(--dsw-alias-state-error-primary);font-size:12px;margin:8px 0 0;white-space:pre-wrap}

      /* ── 功能清单：用户唯一需要读的东西 ── */
      .wb-feat-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0 0 10px}
      .wb-banner{font-size:12px;line-height:1.65;padding:8px 10px;border-radius:8px;margin:0 0 12px;
        border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
      .wb-banner.warn{border-color:var(--dsw-alias-state-warn-primary)}
      .wb-banner.error{border-color:var(--dsw-alias-state-error-primary)}
      .wb-banner b{font-weight:600}
      .wb-mod{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px;margin:0 0 10px;
        transition:border-color .12s}
      .wb-mod.dirty{border-color:var(--dsw-alias-brand-primary)}
      .wb-mod-head{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:0 0 7px}
      .wb-mod-head input{flex:1 1 150px;font:inherit;font-size:12.5px;font-weight:600;padding:4px 7px;
        border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);
        color:var(--dsw-alias-label-primary);min-width:0;box-sizing:border-box}
      .wb-mod-head select{font:inherit;font-size:11.5px;padding:4px 6px;border-radius:6px;
        border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);
        color:var(--dsw-alias-label-primary)}
      .wb-mod .sum{width:100%;box-sizing:border-box;font:inherit;font-size:12px;padding:5px 8px;margin:0 0 6px;
        border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);
        color:var(--dsw-alias-label-primary)}
      .wb-mod textarea{width:100%;box-sizing:border-box;font:inherit;font-size:12px;line-height:1.7;
        padding:7px 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);
        background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);resize:vertical;
        min-height:74px}
      .wb-mod textarea:focus,.wb-mod .sum:focus,.wb-mod-head input:focus{outline:1px solid var(--dsw-alias-brand-primary)}
      .wb-files{display:flex;gap:4px;flex-wrap:wrap;margin-top:6px}
      .wb-status{font-size:10.5px;padding:1px 7px;border-radius:999px;border:1px solid currentColor;white-space:nowrap}
      .wb-status.done{color:var(--dsw-alias-state-success-primary)}
      .wb-status.partial{color:var(--dsw-alias-state-warn-primary)}
      .wb-status.todo{color:var(--dsw-alias-label-secondary)}
      .wb-status.broken{color:var(--dsw-alias-state-error-primary)}
      .wb-msg{font-family:ui-monospace,Consolas,"Courier New",monospace;font-size:11.5px;line-height:1.55;
        white-space:pre-wrap;word-break:break-word;max-height:280px;overflow:auto;padding:8px;border-radius:6px;
        background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);margin:6px 0 0}
      .wb-hist{font-size:11.5px;color:var(--dsw-alias-label-secondary);display:flex;
        justify-content:space-between;gap:8px;align-items:center;padding:3px 0}
      .wb-mod .id{font-family:ui-monospace,Consolas,monospace;font-size:10.5px;
        color:var(--dsw-alias-label-secondary);cursor:pointer;user-select:none}
      .wb-flabel{display:block;font-size:11px;color:var(--dsw-alias-label-secondary);margin:6px 0 2px}
      .wb-mod-toggle{display:block;width:100%;text-align:left;font:inherit;font-size:11.5px;
        color:var(--dsw-alias-label-secondary);background:transparent;border:none;border-top:1px dashed var(--dsw-alias-border-l1);
        padding:6px 0 2px;margin-top:8px;cursor:pointer}
      .wb-mod-toggle:hover{color:var(--dsw-alias-brand-primary)}
      .wb-mod-detail{border-top:1px solid var(--dsw-alias-border-l1);margin-top:2px;padding-top:2px}
      .wb-mod-detail textarea{min-height:56px;font-size:11.5px}
    `;

    /* ────────────────────────── 同源 API ────────────────────────── */

    async function api(path, opts) {
      const res = await fetch(API + path, opts);
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.json()).error || ''; } catch (_) { /* 非 JSON */ }
        throw new Error(detail || `HTTP ${res.status}`);
      }
      return res.json();
    }

    async function streamNdjson(path, body, onEvent, signal) {
      const res = await fetch(API + path, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}), signal,
      });
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.json()).error || ''; } catch (_) { /* 非 JSON */ }
        throw new Error(detail || `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          try { onEvent(JSON.parse(line)); } catch (_) { /* 半行 */ }
        }
      }
    }

    /* ────────────────────────── 引脚图 ────────────────────────── */

    function lqfpPos(n, geo) {
      // 逆时针：1-12 左↓ · 13-24 底→ · 25-36 右↑ · 37-48 顶←（相邻脚必须连号）
      const side = Math.floor((n - 1) / geo.perSide);
      const idx = (n - 1) % geo.perSide;
      if (side === 0) return { x: geo.x, y: geo.y + geo.pitch * (idx + 0.5) };
      if (side === 1) return { x: geo.x + geo.pitch * (idx + 0.5), y: geo.y + geo.size };
      if (side === 2) return { x: geo.x + geo.size, y: geo.y + geo.size - geo.pitch * (idx + 0.5) };
      return { x: geo.x + geo.size - geo.pitch * (idx + 0.5), y: geo.y };
    }

    function Pinout({ pins, selected, onSelect, cfg }) {
      const size = 190, pitch = size / 12, pad = 24;
      const geo = { x: pad, y: pad, size, pitch, perSide: 12 };
      const view = size + pad * 2 + 20;
      return h('svg', {
        viewBox: `0 0 ${view} ${view}`, width: '100%',
        style: { maxWidth: 300, display: 'block', margin: '0 auto' },
        role: 'img', 'aria-label': 'STM32F103C8T6 LQFP48 引脚图',
      },
        h('rect', { x: geo.x, y: geo.y, width: size, height: size, rx: 8,
          fill: 'var(--dsw-alias-bg-layer-2)', stroke: 'var(--dsw-alias-border-l1)' }),
        h('text', { x: geo.x + size / 2, y: geo.y + size / 2 - 5, textAnchor: 'middle', fontSize: 10,
          fill: 'var(--dsw-alias-label-secondary)' }, 'STM32F103'),
        h('text', { x: geo.x + size / 2, y: geo.y + size / 2 + 7, textAnchor: 'middle', fontSize: 10,
          fill: 'var(--dsw-alias-label-secondary)' }, 'C8T6 · LQFP48'),
        h('circle', { cx: geo.x + 9, cy: geo.y + 9, r: 3, fill: 'var(--dsw-alias-border-l2)' }),
        ...pins.map((p) => {
          const pos = lqfpPos(p.pin, geo);
          const on = selected === p.pin;
          const c = cfg && cfg[p.pin];
          const state = c ? (c.conflict ? ' conflict' : ' cfg') : '';
          return h('g', { key: p.pin },
            h('rect', {
              x: pos.x - 4.5, y: pos.y - 4.5, width: 9, height: 9, rx: 1.5,
              className: 'wb-pin' + state + (on ? ' on' : ''),
              role: 'button', tabIndex: 0,
              'aria-label': `引脚 ${p.pin} ${p.name}${c ? '（工程占用：' + (c.modeZh || '') + (c.conflict ? '，配置冲突' : '') + '）' : ''}${on ? '（已选中）' : ''}`,
              onClick: () => onSelect(p.pin),
              onKeyDown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(p.pin); } },
            }),
            h('text', { x: pos.x, y: pos.y + 2.4, textAnchor: 'middle',
              className: 'wb-pintext' + (on ? ' on' : '') }, String(p.pin)),
          );
        }),
      );
    }

    /* ────────────────────── 功能清单（用户唯一需要读的东西） ──────────────────────
     *
     * 这一页回答的是「这块板子现在能干什么」，不是「代码长什么样」。
     *
     * 结构（2026-10-15 改版，起因是用户报「没有返回给 AI 的按钮」「描述有很多废话」）：
     *   · 每个模块是**固定字段**而不是一段散文 —— 散文会写成「本模块主要负责……」，
     *     读的人拿不到可核对的事实；固定字段逼着回答具体问题：什么时候发生？看到什么？
     *     哪个引脚？什么数值？有什么限制？
     *   · 「提交给 AI 修改」**常驻**在操作栏里，改完就能按，不需要先点别的按钮生成预览 ——
     *     上一版把发送按钮藏在预览卡片里，结果就是「改了文字没法提交」。
     *   · 提交是**一次点击**：先算差分（对着服务器上的旧版本算，所以必须在保存之前算），
     *     再保存，再把那段话发进当前会话。发出去的内容留在下面可查、可复制。
     */

    const STATUS_OPTIONS = [['done', '已实现'], ['partial', '部分实现'], ['todo', '还没做'], ['broken', '有问题']];

    /** 列表字段：一行一条。顺序 = 界面顺序 = 模型写 JSON 时的建议顺序 */
    const LIST_FIELDS = [
      ['behavior', '现象', '能看到什么：屏幕显示什么、灯怎么变、串口吐什么。一行一条'],
      ['hardware', '引脚与外设', '如「PB1 — 按键 K1，上拉输入，按下为低」。一行一条'],
      ['params', '关键数值', '带单位，如「自动翻页 5 s」「消抖 30 ms」。一行一条'],
      ['limits', '限制与注意', '什么情况下会失效、哪里是半成品。一行一条'],
    ];

    function cloneModules(list) {
      try { return JSON.parse(JSON.stringify(Array.isArray(list) ? list : [])); }
      catch (_) { return []; }
    }

    /** 列表字段在 textarea 里是「一行一条」 */
    const listToText = (v) => (Array.isArray(v) ? v.join('\n') : '');
    const textToList = (v) => String(v == null ? '' : v)
      .split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

    function FeaturePanel({ push, askSession }) {
      const [spec, setSpec] = useState(null);
      const [draft, setDraft] = useState(null);
      const [stale, setStale] = useState(null);
      const [history, setHistory] = useState([]);
      const [filePath, setFilePath] = useState('');
      const [err, setErr] = useState('');
      const [busy, setBusy] = useState('');
      const [note, setNote] = useState('');
      const [sent, setSent] = useState(null);       // {ok, mode, text, at, error}
      const [showSent, setShowSent] = useState(false);
      const [showHist, setShowHist] = useState(false);
      const [openMap, setOpenMap] = useState({});   // 模块 id → 是否展开细节

      /* 轮询用：直接读 ref，避免把 dirty/busy 塞进 interval 的闭包（那会一直看旧值） */
      const dirtyRef = useRef(false);
      const busyRef = useRef('');
      const revRef = useRef(-1);

      const load = useCallback(async (keepDraft) => {
        setBusy('load'); setErr('');
        try {
          const r = await api('/features');
          setSpec(r.spec || { modules: [] });
          setStale(r.stale || null);
          setHistory(r.history || []);
          setFilePath(r.path || '');
          revRef.current = (r.spec && r.spec.revision) || 0;
          if (r.broken) setErr('features.json 解析失败（文件没被动过，修好它或删掉重来）：' + (r.error || ''));
          if (!keepDraft) setDraft(cloneModules(r.spec && r.spec.modules));
        } catch (e) {
          setErr(String(e.message || e));
        } finally { setBusy(''); }
      }, []);

      useEffect(() => { load(false); }, [load]);

      const baseline = useMemo(() => JSON.stringify((spec && spec.modules) || []), [spec]);
      const dirty = !!(draft && JSON.stringify(draft) !== baseline);
      dirtyRef.current = dirty;
      busyRef.current = busy;

      /* 模型改完代码会回写功能描述 —— 让这一页**自己变新**，别让用户去点刷新。
         8 秒一次的小 GET 而已；有未保存草稿时绝不覆盖（那是在替用户丢字）。 */
      useEffect(() => {
        const timer = setInterval(async () => {
          if (dirtyRef.current || busyRef.current) return;
          try {
            const r = await api('/features');
            const rev = (r.spec && r.spec.revision) || 0;
            if (rev === revRef.current) return;
            const first = revRef.current < 0;
            revRef.current = rev;
            setSpec(r.spec); setStale(r.stale || null); setHistory(r.history || []);
            setDraft(cloneModules(r.spec && r.spec.modules));
            if (!first) push('功能描述已更新（r' + rev + '）—— 模型改完代码回写了', 'k');
          } catch (_) { /* 后端没起来就不打扰 */ }
        }, 8000);
        return () => clearInterval(timer);
      }, [push]);
      const baseById = useMemo(() => {
        const m = new Map();
        ((spec && spec.modules) || []).forEach((x) => m.set(x.id, x));
        return m;
      }, [spec]);

      const setField = (i, k, v) => setDraft((d) => d.map((m, j) => (j === i ? Object.assign({}, m, { [k]: v }) : m)));
      const removeMod = (i) => setDraft((d) => d.filter((_, j) => j !== i));
      const addMod = () => setDraft((d) => {
        const used = new Set(d.map((m) => m.id));
        let n = d.length + 1;
        while (used.has('m' + n)) n += 1;
        return d.concat([{
          id: 'm' + n, name: '新功能', status: 'todo',
          summary: '', trigger: '', behavior: [], hardware: [], params: [], limits: [], files: [],
        }]);
      });

      const post = (path, body) => api(path, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}),
      });

      const save = useCallback(async () => {
        setBusy('save'); setErr('');
        try {
          const r = await post('/features', { modules: draft });
          setSpec(r.spec); setStale(r.stale || null); setHistory(r.history || []);
          setDraft(cloneModules(r.spec.modules));
          revRef.current = (r.spec && r.spec.revision) || 0;
          push('功能描述已保存（r' + ((r.spec && r.spec.revision) || 0) + '）', 'k');
        } catch (e) { setErr(String(e.message || e)); } finally { setBusy(''); }
      }, [draft, push]);

      /**
       * 提交给模型。**顺序不能反**：
       *   ① 先按当前草稿算差分（此刻服务器上还是旧版本，差分才算得出来）
       *   ② 再保存草稿（文件和面板一致）
       *   ③ 最后把那段话发进当前会话
       * 先保存再算差分的话，差分永远是空的 —— 消息里就只剩「要求」没有「改了什么」。
       */
      const submit = useCallback(async (mode) => {
        if (busy) return;
        setBusy('submit'); setErr(''); setSent(null); setShowSent(false);
        try {
          const m = await post('/features/message',
            mode === 'revise' ? { modules: draft, note, mode } : { note, mode });
          if (mode === 'revise' && dirty) {
            const r = await post('/features', { modules: draft });
            setSpec(r.spec); setStale(r.stale || null); setHistory(r.history || []);
            setDraft(cloneModules(r.spec.modules));
            revRef.current = (r.spec && r.spec.revision) || 0;
          }
          const at = new Date().toLocaleTimeString();
          try {
            if (typeof askSession !== 'function') throw new Error('当前环境拿不到会话接口');
            await askSession(m.text);
            setSent({ ok: true, mode: m.mode, text: m.text, at, chars: m.chars, note });
            setShowSent(true);
            push('已提交给模型（' + (m.chars || m.text.length) + ' 字符）', 'k');
          } catch (e) {
            setSent({ ok: false, mode: m.mode, text: m.text, at, error: String(e.message || e), note });
            setShowSent(true);
            setErr('提交失败：' + String(e.message || e) +
              '　—— 下面那段可以手动复制到对话里发给模型。');
          }
        } catch (e) { setErr(String(e.message || e)); } finally { setBusy(''); }
      }, [busy, dirty, draft, note, askSession, push]);

      const restore = useCallback(async (stamp) => {
        setBusy('restore'); setErr('');
        try {
          const r = await post('/features/restore', { stamp });
          setSpec(r.spec); setStale(r.stale || null); setHistory(r.history || []);
          setDraft(cloneModules(r.spec.modules)); setShowHist(false);
          revRef.current = (r.spec && r.spec.revision) || 0;
          push('功能描述已恢复到 ' + stamp, 'k');
        } catch (e) { setErr(String(e.message || e)); } finally { setBusy(''); }
      }, [push]);

      if (draft == null) {
        return h('div', null,
          h('p', { className: 'wb-note' }, busy === 'load' ? '正在读功能描述…' : '功能描述未加载'),
          err && h('p', { className: 'wb-err' }, err));
      }

      const state = (stale && stale.state) || 'missing';
      const canSend = typeof askSession === 'function';
      const nothingToSubmit = !dirty && state === 'ok';

      return h('div', null,
        // ── 新鲜度横幅：这一页最该被看见的一句话 ──
        h('div', { className: 'wb-banner' + (state === 'stale' ? ' warn' : '') },
          state === 'missing'
            ? h('div', null,
                h('b', null, '还没有功能描述。'),
                '代码已经在那儿了，但没有任何一句话说清这块板子现在能干什么 —— ',
                '点右上角「让 AI 写功能描述」，让它读一遍源码写下来。')
            : state === 'stale'
              ? h('div', null,
                  h('b', { style: { color: 'var(--dsw-alias-state-warn-primary)' } }, '⚠ 描述可能已经和板子对不上了：'),
                  '写完之后又有 ' + stale.changedFiles + ' 个源文件被改过（最近 ' +
                  (stale.newestFile || '?') + '，' + (stale.codeAt ? new Date(stale.codeAt).toLocaleString() : '?') +
                  '）。下面读到的功能可能已经不是实际行为，点「让 AI 重写描述」即可同步。')
              : h('div', null,
                  h('b', null, '与代码同步：'),
                  '工程内 ' + ((stale && stale.sourceCount) || 0) + ' 个源文件，描述之后没人改过代码。',
                  spec && spec.updatedAt ? h('span', null,
                    '　最后更新 ' + new Date(spec.updatedAt).toLocaleString() +
                    '（' + (spec.updatedBy === 'user' ? '你' : spec.updatedBy === 'ai' ? '模型'
                      : spec.updatedBy === 'restore' ? '恢复历史' : spec.updatedBy || '?') +
                    '，r' + (spec.revision || 0) + '）') : null),
          filePath && h('p', { className: 'wb-note', style: { marginTop: 4, wordBreak: 'break-all' } },
            '存放：' + filePath + '　（跟工程走，工程拷走它就跟着走）')),

        // ── 操作栏：提交按钮常驻，不需要先做别的 ──
        h('div', { className: 'wb-inline', style: { margin: '0 0 6px' } },
          h('input', { type: 'text', value: note,
            placeholder: '补充说明（可选）：为什么这么改、有没有额外要求…改动会连同这段一起发给模型',
            onChange: (e) => setNote(e.target.value) })),
        h('div', { className: 'wb-feat-bar' },
          h('button', { className: 'wb-btn primary', disabled: !!busy || nothingToSubmit,
            title: nothingToSubmit
              ? '当前没有改动、描述也没过期 —— 没什么可提交的'
              : '把你改过的描述作为需求发给模型（先算差分，再保存，再发进当前对话）',
            onClick: () => submit('revise') },
            busy === 'submit' ? '提交中…' : '提交给 AI 修改'),
          h('button', { className: 'wb-btn', disabled: !!busy || !dirty, onClick: save,
            title: '只保存，不发消息' },
            busy === 'save' ? '保存中…' : (dirty ? '保存改动' : '已保存')),
          h('button', { className: 'wb-btn', disabled: !!busy || !dirty,
            onClick: () => { setDraft(cloneModules(spec && spec.modules)); setSent(null); } },
            '放弃改动'),
          h('span', { className: 'wb-spacer' }),
          h('button', { className: 'wb-btn', disabled: !!busy,
            title: state === 'missing'
              ? '让模型读一遍源码，按固定字段写一份功能描述'
              : '不改描述，只让模型对照代码重新写一遍（描述过期时用这个）',
            onClick: () => submit(state === 'missing' ? 'describe' : 'refresh') },
            state === 'missing' ? '让 AI 写功能描述' : '让 AI 重写描述'),
          h('button', { className: 'wb-btn', disabled: !!busy,
            onClick: () => { load(true); setSent(null); }, title: '重新从后端读一次（模型改完代码后用）' },
            '刷新'),
          h('button', { className: 'wb-btn', disabled: !!busy || !history.length,
            onClick: () => setShowHist((v) => !v) }, '历史 ' + history.length)),

        err && h('p', { className: 'wb-err' }, err),
        !canSend && h('p', { className: 'wb-note', style: { marginTop: 6 } },
          '⚠ 当前环境拿不到会话接口，提交会退化成「生成一段话 + 复制」。'),

        // ── 提交结果：发出去了什么，留在这儿可查 ──
        sent && h('div', { className: 'wb-card', style: { marginTop: 8 } },
          h('div', { className: 'wb-feat-bar', style: { margin: 0 } },
            h('span', { className: sent.ok ? 'wb-status done' : 'wb-status broken' },
              sent.ok ? '已提交' : '提交失败'),
            h('span', { className: 'wb-note' },
              sent.at + '　' + (sent.mode === 'describe' ? '让模型写功能描述'
                : sent.mode === 'refresh' ? '让模型重写功能描述' : '按修改后的描述改代码') +
              (sent.chars ? '　' + sent.chars + ' 字符' : '')),
            h('span', { className: 'wb-spacer' }),
            h('button', { className: 'wb-btn', onClick: () => setShowSent((v) => !v) },
              showSent ? '收起内容' : '查看提交内容'),
            h('button', { className: 'wb-btn', onClick: () => {
              try {
                const p = navigator.clipboard.writeText(sent.text);
                if (p && p.catch) p.catch(() => {});
                push('已复制提交内容', 'c');
              } catch (_) { /* 没有剪贴板就靠下面的 <pre> 手动选 */ }
            } }, '复制')),
          sent.ok
            ? h('p', { className: 'wb-note', style: { marginTop: 6 } },
                '模型正在当前对话里按这份描述干活。它改完代码会回写功能描述，本页会自动更新（约 8 秒内）。')
            : h('p', { className: 'wb-note', style: { marginTop: 6, color: 'var(--dsw-alias-state-error-primary)' } },
                '投递失败：' + sent.error + ' —— 把下面这段复制到对话里发给模型即可。'),
          showSent && h('pre', { className: 'wb-msg' }, sent.text)),

        // ── 模块列表：折叠时只显示「读懂一个功能」最少需要的东西 ──
        draft.map((m, i) => {
          const b = baseById.get(m.id);
          const itemDirty = !b || JSON.stringify(b) !== JSON.stringify(m);
          const isNew = !b;
          const isOpen = openMap[m.id] !== undefined ? openMap[m.id] : isNew;
          const counts = LIST_FIELDS.map(([k, zh]) => [zh, (m[k] || []).length]);
          const fileCount = (m.files || []).length;
          return h('div', { key: m.id + ':' + i, className: 'wb-mod' + (itemDirty ? ' dirty' : '') },
            h('div', { className: 'wb-mod-head' },
              h('input', { value: m.name, 'aria-label': '功能名称',
                onChange: (e) => setField(i, 'name', e.target.value) }),
              h('select', { value: m.status, 'aria-label': '实现状态',
                onChange: (e) => setField(i, 'status', e.target.value) },
                STATUS_OPTIONS.map(([v, zh]) => h('option', { key: v, value: v }, zh))),
              isNew && h('span', { className: 'wb-tag ok' }, '新增'),
              itemDirty && !isNew && h('span', { className: 'wb-tag' }, '已改'),
              h('span', { className: 'id', title: '模块 id（模型靠它认这是同一个功能；点一下复制）',
                onClick: () => {
                  try {
                    const p = navigator.clipboard.writeText(m.id);
                    if (p && p.catch) p.catch(() => {});
                    push('已复制模块 id：' + m.id, 'c');
                  } catch (_) { /* 没有剪贴板就只当提示 */ }
                } },
                m.id),
              h('button', { className: 'wb-btn', title: '删掉这个功能模块（提交或保存后生效；历史里能找回）',
                onClick: () => removeMod(i) }, '删除')),
            h('label', { className: 'wb-flabel' }, '一句话'),
            h('input', { className: 'sum', value: m.summary, placeholder: '这个功能干什么（≤40 字）',
              'aria-label': '一句话', onChange: (e) => setField(i, 'summary', e.target.value) }),
            h('label', { className: 'wb-flabel' }, '何时发生'),
            h('input', { className: 'sum', value: m.trigger,
              placeholder: '上电时 / 每 1 秒 / 按下 PB1 时 / 串口收到数据时',
              'aria-label': '何时发生', onChange: (e) => setField(i, 'trigger', e.target.value) }),
            h('button', { className: 'wb-mod-toggle', 'aria-expanded': isOpen ? 'true' : 'false',
              onClick: () => setOpenMap((o) => Object.assign({}, o, { [m.id]: !isOpen })) },
              (isOpen ? '▾ ' : '▸ ') + '细节：' +
              counts.map(([zh, n]) => zh + ' ' + n).join(' · ') + ' · 文件 ' + fileCount),
            isOpen && h('div', { className: 'wb-mod-detail' },
              LIST_FIELDS.map(([k, zh, ph]) => h('div', { key: k },
                h('label', { className: 'wb-flabel' }, zh),
                h('textarea', { value: listToText(m[k]), rows: 3, placeholder: ph, 'aria-label': zh,
                  onChange: (e) => setField(i, k, textToList(e.target.value)) }))),
              h('label', { className: 'wb-flabel' }, '涉及文件'),
              h('textarea', { value: listToText(m.files), rows: 2,
                placeholder: '工程内相对路径，一行一个，如 .\\Hardware\\OLED.c', 'aria-label': '涉及文件',
                onChange: (e) => setField(i, 'files', textToList(e.target.value)) })));
        }),

        h('div', { className: 'wb-feat-bar' },
          h('button', { className: 'wb-btn', disabled: !!busy, onClick: addMod }, '+ 添加功能模块')),

        // ── 历史 ──
        showHist && h('div', { className: 'wb-card' },
          h('p', { className: 'wb-sec' }, '历史版本（点「恢复」退回那一版；恢复本身也会进历史）'),
          history.length ? history.map((v) => h('div', { key: v.stamp, className: 'wb-hist' },
            h('span', null, v.stamp.replace(/-r(\d+)$/, '　r$1') + '　' + (v.modules == null ? '?' : v.modules + ' 个模块') +
              (v.at ? '　' + new Date(v.at).toLocaleString() : '')),
            h('button', { className: 'wb-btn', disabled: !!busy, onClick: () => restore(v.stamp) }, '恢复')))
            : h('p', { className: 'wb-note' }, '还没有历史（保存过才有）。')),

        h('p', { className: 'wb-note', style: { marginTop: 8 } },
          '这一页是代码与需求之间的合同：模型改完代码必须回来更新它；你改它，等于给模型下了新需求。'),
      );
    }

    /* ────────────────────────── 工作台主体 ────────────────────────── */

    function Workbench({ uiWorkspace, sessionId, sessionPath, sessions }) {
      /* 默认停在「功能清单」：这一页是用户真正要读的东西，别的页都是给他排查用的。
         模型改完代码回写描述后，用户第一眼就该看到变化。 */
      const [tab, setTab] = useState('feat');
      const [env, setEnv] = useState(null);
      const [pins, setPins] = useState([]);
      const [sel, setSel] = useState(1);
      const [log, setLog] = useState([]);
      const [busy, setBusy] = useState('');
      const [projects, setProjects] = useState([]);
      const [project, setProject] = useState('');
      const [size, setSize] = useState(null);
      const [sizeFrom, setSizeFrom] = useState('');
      const [sizeMap, setSizeMap] = useState(null);
      const [keil, setKeil] = useState(null);
      const [keilPins, setKeilPins] = useState(null);
      const [keilPath, setKeilPath] = useState('');
      const [keilCandidates, setKeilCandidates] = useState(null);
      const [regs, setRegs] = useState(null);
      /* 编译诊断：以前后端返回了 warnings/errors，前端一个字都没用，编译失败只能自己翻日志 */
      const [diags, setDiags] = useState(null);
      const [peek, setPeek] = useState(null);
      const [peekLoading, setPeekLoading] = useState(false);
      const abortRef = useRef(null);

      const push = useCallback((text, kind) => {
        setLog((prev) => prev.concat([{ text, kind: kind || '' }]).slice(-400));
      }, []);

      /* ── 把一条消息投进当前会话 ──
       * 这是「用户改描述 → 模型改代码」的回程。宿主客户端只有 8 个服务，
       * sessions 是唯一能投递的那个：
       *   binding(id)  借一个**已经被宿主保留**的会话（会话开着就一定有）
       *   retain(id)   自己保一份（宿主没保留时兜底；用完释放，别占着历史不放手）
       * 两种都拿不到就抛错，面板会退化成「复制粘贴」—— 宁可退一步，也不假装发成功。 */
      const askSession = useCallback(async (text) => {
        const content = String(text == null ? '' : text);
        if (!content.trim()) throw new Error('内容为空');
        if (!sessionId) throw new Error('当前会话 id 缺失');
        const svc = sessions;
        if (!svc) throw new Error('宿主没有提供 sessions 服务');
        let binding = typeof svc.binding === 'function' ? svc.binding(sessionId) : undefined;
        let ref = null;
        if (!binding || !binding.session) {
          if (typeof svc.retain !== 'function') throw new Error('sessions 服务没有 binding/retain');
          let lastErr = null;
          for (const src of ['controllerOperation', 'gateway']) {
            try { ref = svc.retain(sessionId, { source: src }); break; } catch (e) { lastErr = e; }
          }
          if (!ref) throw lastErr || new Error('retain 失败');
          if (ref.ready && typeof ref.ready.then === 'function') {
            try { binding = await ref.ready; } catch (_) { /* 下面再兜一次 */ }
          }
          if (!binding || !binding.session) binding = ref.binding;
        }
        if (!binding || !binding.session || typeof binding.session.prompt !== 'function') {
          throw new Error('会话接口不可用（拿不到 prompt）');
        }
        try {
          const r = await binding.session.prompt([{ type: 'text', text: content }], 'queue');
          if (r && r.ok === false) {
            throw new Error((r.error && (r.error.message || r.error.code)) || '宿主拒绝了这条消息');
          }
        } finally {
          if (ref && typeof ref.release === 'function') { try { ref.release(); } catch (_) { /* 已释放 */ } }
        }
      }, [sessions, sessionId]);

      /* 当前会话所在的工作区目录。
         优先用父层传来的快路径，没有就**向宿主反查** —— 宿主有 workspaceRegistry，
         它的 Workspace 带 path 与 sessionIds，反查即可。
         这一点是关键：只靠「插件建会话时记进 localStorage」的话，
         **插件上线之前就存在的会话永远查不到**，自动切换就是个摆设（实测踩到）。 */
      const [wsPath, setWsPath] = useState(sessionPath || '');
      useEffect(() => {
        if (sessionPath) { setWsPath(sessionPath); return undefined; }
        if (!sessionId) return undefined;
        let alive = true;
        api('/session-workspace?sessionId=' + encodeURIComponent(sessionId))
          .then((r) => {
            if (!alive) return;
            if (r && r.workspace && r.workspace.path) { setWsPath(r.workspace.path); return; }
            push('没能从宿主查到本会话的工作区（/mcu/session-workspace 返回空），' +
              '不会自动切换工程 —— 可在上方手动指定', 'w');
          })
          .catch((err) => {
            if (alive) push('查本会话工作区失败：' + String(err.message || err), 'w');
          });
        return () => { alive = false; };
      }, [sessionId, sessionPath, push]);

      useEffect(() => {
        let alive = true;
        let timer = null;
        let attempt = 0;
        /* 后端是宿主按需拉起的，第一次可能还没就绪；以前这里失败一次就摆烂，
           整个面板停在「正在检查已打开的工程…」，看起来就像「自动启动坏了」。
           现在退避重试几次，自己恢复。 */
        const boot = async () => {
          try {
            await fetch('/mcu/start', { method: 'POST' }).catch(() => {});
            const [e, p, pr] = await Promise.all([api('/env'), api('/pins'), api('/projects')]);
            if (!alive) return;
            setEnv(e); setPins(p.pins || []); setProjects(pr.projects || []);
            setProject((pr.projects && pr.projects[0] && pr.projects[0].id) || '');
            /* 之前打开过的 Keil 工程要自动恢复，不然刷新一次就丢了 */
            try {
              const st = await api('/keil/state');
              if (!alive) return;
              if (st && st.open) {
                setKeil(st);
                const pm = await api('/keil/pins');
                if (alive) setKeilPins(pm);
                const sz = await api('/keil/size').catch(() => null);
                if (alive && sz && sz.has) {
                  setSize(sz.programSize); setSizeFrom('Keil 工程'); setSizeMap(sz.map || null);
                  setDiags(sz.diagnostics || []);
                }
              } else setKeil({ open: false });
            } catch (_) { if (alive) setKeil({ open: false }); }
          } catch (err) {
            if (!alive) return;
            attempt += 1;
            const msg = String(err.message || err);
            if (attempt <= 5) {
              push(`连接后端失败（第 ${attempt} 次）：${msg} —— ${attempt} 秒后自动重试`, 'w');
              timer = setTimeout(boot, 1000 * attempt);
            } else {
              setKeil({ open: false });
              push('连接后端失败：' + msg + '（已重试 5 次。看宿主后端状态：/mcu/state）', 'e');
            }
          }
        };
        boot();
        return () => { alive = false; if (timer) clearTimeout(timer); };
      }, [push]);

      /* 说明（2026-10-18 规范整改）：以前这里有一段「全页扫描宿主 DOM、按 cursor 猜分栏条并隐藏」
         的代码。它违反 DSH 插件规范（practices.md「Do not write DOM outside your component」、
         ui-plugin.md「Do not read another plugin's DOM… choose a slot that already allocates space」），
         已整段删除。布局问题改为：使用宿主已分配空间的插槽（conversation.view），不猜、不改宿主 DOM。
         若分栏条真的遮挡内容，应作为宿主布局问题反馈，而不是由插件在别人的 DOM 上打补丁。 */

      const run = useCallback(async (label, path, body) => {
        if (busy) return;
        setBusy(label); setLog([]); push(`▶ ${label}`, 'c');
        const ctl = new AbortController();
        abortRef.current = ctl;
        try {
          await streamNdjson(path, body, (ev) => {
            if (ev.type === 'line') push(ev.text, ev.tag === 'error' ? 'e' : (ev.tag === 'cmd' ? 'c' : ''));
            else if (ev.type === 'end') {
              if (ev.ok) {
                push(`✓ ${label} 完成`, 'k');
                // Keil 工程构建返回 programSize，自带工程返回 size —— 两者来源必须标清楚
                if (ev.programSize) {
                  setSize(ev.programSize); setSizeFrom('Keil 工程');
                  if (ev.map) setSizeMap(ev.map);   // armlink map：谁吃了 Flash
                } else if (ev.size) { setSize(ev.size); setSizeFrom('插件自带测试工程'); }
                // 保险：构建结束后再拉一次账本。这走的是和「切会话重挂载」完全相同的那条路
                // （GET /api/keil/size），不依赖流式事件里的 map 有没有落到 state 上。
                if (path === '/keil/build') {
                  api('/keil/size').then((sz) => {
                    if (sz && sz.has) {
                      setSize(sz.programSize); setSizeFrom('Keil 工程'); setSizeMap(sz.map || null);
                      setDiags(sz.diagnostics || []);
                    }
                  }).catch(() => { /* 拿不到就保持现状 */ });
                }
              } else push(`✗ ${label} 失败：${ev.reason || ev.error || '见上方日志'}`, 'e');
              // 失败也要把诊断摆出来 —— 编译错误正是最该被看见的时候
              if (path === '/keil/build') setDiags(ev.diagnostics || []);
            }
          }, ctl.signal);
        } catch (err) {
          if (String(err.name) !== 'AbortError') push('中断：' + String(err.message || err), 'e');
        } finally { setBusy(''); abortRef.current = null; }
      }, [busy, push]);

      /* ── Keil 工程接入 ── */
      const reloadKeilPins = useCallback(async () => {
        try {
          const pm = await api('/keil/pins');
          setKeilPins(pm);
          return pm;
        } catch (err) { push('读引脚配置失败：' + String(err.message || err), 'e'); return null; }
      }, [push]);

      const openKeil = useCallback(async (p) => {
        const target = String(p == null ? keilPath : p).trim();
        if (!target) { push('请先填 Keil 工程目录或 .uvprojx 路径', 'e'); return; }
        setBusy('打开工程');
        try {
          const r = await api('/keil/open', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: target }),
          });
          setKeil({ open: true, project: r.project, diagnostics: r.diagnostics || [] });
          const cands = r.candidates || [];
          setKeilCandidates(cands.length > 1 ? cands : null);
          push('✓ 已打开工程：' + r.project.name + ' · ' + r.project.summary, 'k');
          (r.diagnostics || []).forEach((d) => push('[' + d.level + '] ' + d.message, d.level === 'error' ? 'e' : 'w'));
          await reloadKeilPins();
          setTab('pin');
        } catch (err) {
          push('✗ 打开工程失败：' + String(err.message || err), 'e');
        } finally { setBusy(''); }
      }, [keilPath, push, reloadKeilPins]);

      /** 弹系统目录选择框（DSH 的 uiWorkspace.pickDirectory），选完直接打开 */
      const pickDir = useCallback(async () => {
        if (!uiWorkspace || typeof uiWorkspace.pickDirectory !== 'function') {
          push('当前环境没有目录选择能力，请手动填写路径', 'e');
          return;
        }
        try {
          const dir = await uiWorkspace.pickDirectory();
          if (!dir) return;
          setKeilPath(dir);
          await openKeil(dir);
        } catch (err) {
          push('选择目录失败：' + String(err.message || err), 'e');
        }
      }, [uiWorkspace, openKeil, push]);

      /** 点诊断 → 把出错那一行连上下文读出来（走 /api/keil/src/read，GBK 工程也能正确解码） */
      const peekSource = useCallback(async (d) => {
        if (!d || !d.file) return;
        setPeekLoading(true);
        try {
          const r = await api('/keil/src/read?path=' + encodeURIComponent(d.file));
          const all = String(r.text || '').split(/\r?\n/);
          const hit = d.line || 1;
          const from = Math.max(1, hit - 6);
          const to = Math.min(all.length, hit + 6);
          const lines = [];
          for (let n = from; n <= to; n++) lines.push({ n, text: all[n - 1] });
          setPeek({ rel: r.rel || d.file, encoding: r.encoding, hitLine: hit, lines, total: all.length });
        } catch (err) {
          push('读源码失败（先在「引脚规划」页打开 Keil 工程）：' + String(err.message || err), 'e');
          setPeek(null);
        } finally { setPeekLoading(false); }
      }, [push]);

      /**
       * 跟着会话走：当前会话的工作区里有 Keil 工程就自动打开。
       *
       * 为什么需要它：切到另一个工作区（= 另一个 mcu 会话）时，后端记的还是上一个工程，
       * 界面就显示着别人的工程，还得手动再选一次。现在由会话自带的 `sessionPath` 触发。
       * 守卫用 ref 记「这个工作区已经自动跑过」，所以之后用户手动改工程不会被抢回去。
       * 必须定义在 openKeil 之后 —— 依赖数组在渲染期求值，提前引用会踩 TDZ。
       */
      const autoTried = useRef('');
      useEffect(() => {
        if (!wsPath || keil === null) return;             // 工作区未知、或后端自检还没跑完
        if (autoTried.current === wsPath) return;
        autoTried.current = wsPath;
        const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
        (async () => {
          try {
            const scan = await api('/keil/scan', {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ dir: wsPath }),
            });
            const found = (scan && scan.projects) || [];
            if (!found.length) {
              push('当前工作区里没找到 .uvprojx：' + wsPath + '　（可在上方手动指定工程）', 'w');
              return;
            }
            const cur = (keil && keil.open && keil.project) || null;
            if (cur && found.some((x) => norm(x.file) === norm(cur.file))) return;   // 已经是对的那个，不折腾
            // 唯一候选直接打开；多个候选就把目录交给后端，让它把选择列表带回来
            await openKeil(found.length === 1 ? found[0].file : wsPath);
            push('已按当前工作区自动打开工程（该工作区有 ' + found.length + ' 个候选）', 'k');
          } catch (err) {
            push('按工作区自动识别工程失败：' + String(err.message || err), 'w');
          }
        })();
      }, [wsPath, keil, openKeil, push]);

      const readRegs = useCallback(async () => {
        setBusy('读寄存器');
        try {
          const r = await api('/keil/registers', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ compare: true }),
          });
          setRegs(r);
          if (r.ok) push('✓ 寄存器已读取：SYSCLK ' + (r.clock.sysclkHz / 1e6) + ' MHz（' + r.clock.source + '）', 'k');
        } catch (err) {
          setRegs({ ok: false, error: String(err.message || err) });
        } finally { setBusy(''); }
      }, [push]);

      /** 物理引脚号 → 工程里的配置（给引脚图染色用） */
      const pinCfg = useMemo(() => {
        const by = keilPins && keilPins.byPhysical;
        if (!by) return null;
        const out = {};
        Object.keys(by).forEach((k) => {
          const p = by[k];
          out[+k] = {
            name: p.name,
            modeZh: (p.final && p.final.modeZh) || (p.configs[0] && p.configs[0].modeZh) || '',
            conflict: !!p.conflict,
            exti: p.exti,
            file: p.final ? p.final.file : null,
            line: p.final ? p.final.line : null,
            reinitCount: p.reinitCount || 1,
          };
        });
        return out;
      }, [keilPins]);

      const selPin = pins.find((p) => p.pin === sel) || null;
      const selCfg = pinCfg ? pinCfg[sel] : null;
      const compiler = env && env.compilers ? env.compilers.find((c) => c.usable) : null;
      const flasher = env && env.flashers ? env.flashers.find((f) => f.usable) : null;
      const ports = (env && env.serialPorts) || [];
      const chip = (cls, text) => h('span', { className: 'wb-chip ' + (cls || '') }, text);

      return h('div', { className: 'wb-root' },
        h('style', null, STYLE),
        h('div', { className: 'wb-head' },
          h('span', { className: 'wb-title' }, 'STM32 工作台'),
          chip(compiler ? 'ok' : 'warn', compiler ? 'AC5 就绪' : '无编译器'),
          chip(flasher ? 'ok' : 'warn', flasher ? 'OpenOCD 就绪' : '未检测到 ST-Link'),
          chip('', ports.length ? `${ports.length} 个串口` : '无串口'),
          h('span', { className: 'wb-spacer' }),
          /* 打开了 Keil 工程就编它；没打开才用插件自带的测试工程 */
          keil && keil.open
            ? h('span', { className: 'wb-chip ok', title: keil.project.dir },
                'Keil：' + keil.project.name)
            : h('select', {
                value: project, onChange: (e) => setProject(e.target.value),
                style: { font: 'inherit', fontSize: 12, padding: '4px 6px', borderRadius: 6,
                  border: '1px solid var(--dsw-alias-border-l2)',
                  background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)' },
              }, (projects.length ? projects : [{ id: '', name: '（无工程）' }]).map((p) =>
                h('option', { key: p.id, value: p.id }, p.name || p.id))),
          h('button', { className: 'wb-btn', disabled: !!busy,
            title: (keil && keil.open) ? '按 .uvprojx 的配置编译 ' + keil.project.name : '编译插件自带的测试工程',
            onClick: () => ((keil && keil.open)
              ? run('构建 Keil 工程', '/keil/build', {})
              : run('构建', '/build', { project })) },
            busy === '构建' || busy === '构建 Keil 工程' ? '构建中…'
              : ((keil && keil.open) ? '构建 Keil 工程' : '构建')),
          h('button', { className: 'wb-btn primary', disabled: !!busy,
            title: (keil && keil.open)
              ? '烧录刚才构建的 Keil 产物并校验（会覆盖板上程序）'
              : (size ? '烧录并校验' : '先成功构建一次'),
            onClick: () => ((keil && keil.open)
              ? run('烧录', '/keil/flash', { verify: true })
              : run('烧录', '/flash', { project, verify: true })) },
            busy === '烧录' ? '烧录中…' : '烧录'),
          h('button', { className: 'wb-btn', disabled: !!busy,
            title: '快速确认 ST-Link 与目标芯片是否可识别：读设备 ID / Flash 容量 / 内核版本，不 halt 也不读寄存器（约 1 秒）',
            onClick: () => run('检测连接', '/chip-info', {}) },
            busy === '检测连接' ? '检测中…' : '检测连接'),
          busy && h('button', { className: 'wb-btn', onClick: () => abortRef.current && abortRef.current.abort() }, '中止'),
        ),
        h('div', { className: 'wb-tabs', role: 'tablist' },
          [['feat', '功能清单'], ['pin', '引脚规划'], ['reg', '寄存器'], ['size', 'Flash 占用'],
            ['build', '构建台'], ['serial', '串口'], ['calc', '计算器']].map(([k, label]) =>
            h('button', { key: k, className: 'wb-tab', role: 'tab', 'aria-selected': tab === k,
              onClick: () => setTab(k) }, label))),
        h('div', { className: 'wb-body' },
          tab === 'feat' && h(FeaturePanel, { push, askSession }),
          tab === 'pin' && h('div', null,
            h('div', { className: 'wb-card' },
              h('p', { className: 'wb-sec' }, '当前 Keil 工程'),
              h('div', { className: 'wb-inline' },
                h('input', {
                  type: 'text', value: keilPath,
                  placeholder: '工程目录或 .uvprojx 路径，例如 D:\\work\\MyProject',
                  onChange: (e) => setKeilPath(e.target.value),
                  onKeyDown: (e) => { if (e.key === 'Enter') openKeil(); },
                }),
                h('button', { className: 'wb-btn primary', disabled: !!busy, onClick: () => openKeil() },
                  busy === '打开工程' ? '打开中…' : '打开工程'),
                h('button', { className: 'wb-btn', disabled: !!busy, onClick: pickDir,
                  title: '弹出系统目录选择框，选完自动找 .uvprojx 并打开' }, '选择目录…')),
              keil == null ? h('p', { className: 'wb-note' }, '正在检查已打开的工程…')
                : keil.open ? h('div', null,
                    h('div', { className: 'wb-kv' }, h('span', null, '工程'), h('b', null, keil.project.name)),
                    h('div', { className: 'wb-kv' }, h('span', null, '路径'),
                      h('b', { style: { fontSize: 11, wordBreak: 'break-all', textAlign: 'right' } }, keil.project.dir)),
                    h('div', { className: 'wb-kv' }, h('span', null, '芯片 / 编译器'), h('b', null,
                      keil.project.device + ' · ' + (keil.project.useAC6 ? 'AC6' : 'AC5') + ' · ' + keil.project.optimFlag)),
                    h('div', { className: 'wb-kv' }, h('span', null, '源文件'), h('b', null,
                      keil.project.sourceCount + ' 个 · ' + keil.project.groups.map((g) => g.name + ':' + g.files).join(' '))),
                    h('div', { className: 'wb-kv' }, h('span', null, 'HSE 晶振'),
                      h('b', null, (keil.project.hse.hz / 1e6) + ' MHz')),
                    h('p', { className: 'wb-note', style: { marginTop: 4 } },
                      'HSE 取值：' + keil.project.hse.source + (keil.project.hse.confident ? '' : '　⚠ Keil 里填的那个值不可靠')),
                    keilCandidates && h('div', { className: 'wb-inline', style: { marginTop: 8 } },
                      h('select', {
                        value: '',
                        onChange: (e) => { if (e.target.value) openKeil(e.target.value); },
                        style: { flex: '1 1 260px', font: 'inherit', fontSize: 12, padding: '4px 6px', borderRadius: 6,
                          border: '1px solid var(--dsw-alias-border-l2)',
                          background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)' },
                      }, [h('option', { key: '', value: '' },
                        '这个目录下有 ' + keilCandidates.length + ' 个工程，换一个…')]
                        .concat(keilCandidates.map((c) => h('option', { key: c.file, value: c.file },
                          c.label + '　' + c.dir))))))
                  : h('p', { className: 'wb-note' },
                      '还没有打开工程。填入 Keil 工程路径后点「打开工程」，引脚图会按代码里的实际配置染色，并在右侧给出每个引脚的来源与冲突。')),
            h('div', { className: 'wb-grid' },
              h('div', null,
                h(Pinout, { pins, selected: sel, onSelect: setSel, cfg: pinCfg }),
                h('div', { className: 'wb-legend' },
                  h('span', null, h('i', { className: 'wb-dot', style: { background: 'var(--dsw-alias-state-success-primary)' } }), '工程已用'),
                  h('span', null, h('i', { className: 'wb-dot', style: { background: 'var(--dsw-alias-state-warn-primary)' } }), '配置冲突'),
                  h('span', null, h('i', { className: 'wb-dot', style: { background: 'var(--dsw-alias-brand-primary)' } }), '当前选中'),
                  h('span', null, h('i', { className: 'wb-dot', style: { background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l2)' } }), '空闲')),
                h('p', { className: 'wb-note', style: { textAlign: 'center', marginTop: 6 } },
                  pins.length ? `${pins.length} 个引脚 · 来自 /mcu/api/pins` +
                    (keilPins ? ` · 工程占用 ${keilPins.usedPins} 个` : '') : '引脚数据未加载')),
              h('div', null,
              selPin ? h('div', null,
                h('p', { className: 'wb-sec' }, `引脚 ${selPin.pin} · ${selPin.name}`),
                h('div', { className: 'wb-kv' }, h('span', null, '类型'), h('b', null, selPin.type || '—')),
                h('div', { className: 'wb-kv' }, h('span', null, '是否 IO'), h('b', null, selPin.io ? '是' : '否')),
                h('div', { className: 'wb-kv' }, h('span', null, '5V 容忍'),
                  h('b', { style: { color: selPin.fiveVTolerant ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-primary)' } },
                    selPin.fiveVTolerant ? '是（FT）' : '否')),
                !selPin.verified && h('p', { className: 'wb-note', style: { color: 'var(--dsw-alias-state-warn-primary)', marginTop: 4 } },
                  '⚠ 此脚数据未核实（verified:false），接 5V 前请实测'),
                selPin.note && h('p', { className: 'wb-note', style: { marginTop: 4 } }, selPin.note),
                h('p', { className: 'wb-sec', style: { marginTop: 8 } }, '复用功能'),
                h('p', { className: 'wb-note' }, (selPin.functions || []).map((f) => `${f.peripheral} · ${f.signal}`).join('   ') || '—'),
                selCfg ? h('div', null,
                  h('p', { className: 'wb-sec', style: { marginTop: 8 } }, '工程里的配置'),
                  h('div', { className: 'wb-kv' }, h('span', null, '引脚'), h('b', null, selCfg.name)),
                  h('div', { className: 'wb-kv' }, h('span', null, '模式'), h('b', null, selCfg.modeZh || '—')),
                  selCfg.file && h('div', { className: 'wb-kv' }, h('span', null, '来源'),
                    h('b', { style: { fontSize: 11 } }, selCfg.file + ':' + selCfg.line)),
                  selCfg.reinitCount > 1 && h('p', { className: 'wb-note', style: { color: 'var(--dsw-alias-state-warn-primary)', marginTop: 4 } },
                    '⚠ 此引脚在工程里被配置了 ' + selCfg.reinitCount + ' 次，最终生效的是最后一次'),
                  selCfg.exti && h('p', { className: 'wb-note', style: { marginTop: 4 } },
                    'EXTI：' + selCfg.exti.triggerZh + '（' + selCfg.exti.file + ':' + selCfg.exti.srcLine + '）'),
                  selCfg.conflict && h('p', { className: 'wb-note', style: { color: 'var(--dsw-alias-state-warn-primary)', marginTop: 4 } },
                    '⚠ 配置冲突：同引脚被多个模块初始化，后配置覆盖前者'),
                ) : (keilPins ? h('p', { className: 'wb-note', style: { marginTop: 8 } }, '此引脚未在工程中被配置') : null),
              ) : h('p', { className: 'wb-note' }, '点击左侧任意引脚查看详情'),
              keilPins && ((keilPins.conflicts || []).length || (keilPins.reconfigs || []).length) &&
                h('div', { style: { marginTop: 12 } },
                  h('p', { className: 'wb-sec' }, '引脚冲突'),
                  (keilPins.conflicts || []).map((c, i) => h('div', { key: 'cf' + i, style: { marginBottom: 6 } },
                    h('p', { className: 'wb-note', style: { color: c.severity === 'danger'
                      ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-warn-primary)' } },
                      (c.severity === 'danger' ? '严重 · ' : '注意 · ') + c.pin + '：' + c.detail),
                    c.effective && h('p', { className: 'wb-note' },
                      '最终生效：' + c.effective + '（' + c.effectiveAt + '）'))),
                  (keilPins.reconfigs || []).length > 0 && h('div', { style: { marginTop: 8 } },
                    h('p', { className: 'wb-sec' }, '初始化重配（最终态明确，一般无需处理）'),
                    (keilPins.reconfigs || []).map((c, i) => h('p', { key: 'rc' + i, className: 'wb-note' },
                      '· ' + c.pin + '：' + c.detail + '　→ ' + c.effective))),
                  keilPins.orderSource && h('p', { className: 'wb-note', style: { marginTop: 8 } },
                    '「最终生效」依据：' + keilPins.orderSource.method +
                    '（可信度 ' + keilPins.orderSource.confidence + '）' +
                    (keilPins.orderSource.entry ? '，入口 ' + keilPins.orderSource.entry : ''))),
              size && h('div', { style: { marginTop: 12 } },
                h('p', { className: 'wb-sec' }, '最近一次构建占用' + (sizeFrom ? '（' + sizeFrom + '）' : '')),
                h('div', { className: 'wb-kv' }, h('span', null, `Flash（${size.flashKB} KB）`),
                  h('b', null, `${size.flashBytes} B · ${(size.flashBytes / 1024 / size.flashKB * 100).toFixed(2)}%`)),
                h('div', { className: 'wb-kv' }, h('span', null, `SRAM（${size.ramKB} KB）`),
                  h('b', null, `${size.ramBytes} B · ${(size.ramBytes / 1024 / size.ramKB * 100).toFixed(2)}%`)),
              )),
            ),
          ),
          tab === 'reg' && h(Registers, { regs, onRead: readRegs, busy: busy === '读寄存器', keil }),
          tab === 'size' && h(SizePanel, {
            size, map: sizeMap, busy: !!busy, keil,
            onBuild: (keil && keil.open) ? () => run('构建 Keil 工程', '/keil/build', {}) : null,
          }),
          tab === 'build' && h('div', null,
            h(Diagnostics, {
              diags, peek, loading: peekLoading, onPeek: peekSource, busy: !!busy,
              onBuild: (keil && keil.open) ? () => run('构建 Keil 工程', '/keil/build', {}) : null,
            }),
            h('pre', { className: 'wb-log' },
              log.map((l, i) => h('div', { key: i, className: l.kind }, l.text)),
              !log.length && h('div', { className: 'c' }, '点右上角「构建」开始；日志实时出现在这里。'))),
          tab === 'serial' && h(SerialPanel, { ports, push }),
          tab === 'calc' && h(CalcPanel),
        ),
      );
    }

    /* ────────────────────────── 编译诊断面板 ────────────────────────── */

    /**
     * 列出每个错误与警告（文件 / 行号 / 错误码 / 原文），点一条就看那一行的源码。
     * 后端一直在返回这些数据，以前前端一个字都没用 —— 编译失败只能自己翻 50 KB 日志。
     */
    function Diagnostics({ diags, peek, onPeek, loading, onBuild, busy }) {
      const list = diags || [];
      const errs = list.filter((d) => d.level === 'error');
      const warns = list.filter((d) => d.level === 'warning');
      const others = list.filter((d) => d.level !== 'error' && d.level !== 'warning');
      const label = (lv) => (lv === 'error' ? '错误' : lv === 'warning' ? '警告' : '提示');

      const row = (d, i) => {
        const clickable = !!(d.file && onPeek);
        return h('div', {
          key: 'dg' + i,
          className: 'wb-diag' + (clickable ? ' click' : ''),
          onClick: clickable ? () => onPeek(d) : undefined,
          title: clickable ? '点击查看源码这一行' : undefined,
        },
          h('div', { className: 'wb-diag-head' },
            h('span', { className: 'wb-diag-lvl ' + d.level }, label(d.level)),
            h('span', { className: 'wb-diag-loc' },
              (d.file || '(无文件)') + (d.line ? ':' + d.line : '') + (d.col ? ':' + d.col : '')),
            d.code && h('span', { className: 'wb-diag-code' }, '#' + d.code),
            clickable && h('span', { className: 'wb-diag-code', style: { marginLeft: 'auto' } }, '查看源码 →')),
          h('div', { className: 'wb-diag-msg' }, d.message || ''));
      };

      if (!list.length) {
        return h('div', { className: 'wb-card' },
          h('p', { className: 'wb-sec' }, '编译诊断'),
          h('p', { className: 'wb-note' },
            '还没有诊断。构建一次就会在这里列出每个错误与警告（文件、行号、错误码、原文），点一条能直接看源码那一行。'),
          onBuild && h('div', { className: 'wb-inline', style: { marginTop: 8 } },
            h('button', { className: 'wb-btn primary', disabled: busy, onClick: onBuild },
              busy ? '构建中…' : '构建 Keil 工程')),
          !onBuild && h('p', { className: 'wb-note', style: { marginTop: 6 } }, '先在「引脚规划」页打开一个 Keil 工程。'));
      }

      return h('div', { className: 'wb-card' },
        h('p', { className: 'wb-sec' },
          '编译诊断：' + errs.length + ' 个错误 / ' + warns.length + ' 个警告' +
          (others.length ? ' / ' + others.length + ' 条提示' : '')),
        errs.map(row), warns.map(row), others.map(row),
        loading && h('p', { className: 'wb-note', style: { marginTop: 6 } }, '正在读取源码…'),
        peek && h('div', null,
          h('p', { className: 'wb-sec', style: { marginTop: 10 } },
            peek.rel + '（' + peek.encoding + '，共 ' + peek.total + ' 行）第 ' + peek.hitLine + ' 行'),
          h('div', { className: 'wb-src' },
            peek.lines.map((l) => h('div', { key: l.n, className: l.n === peek.hitLine ? 'hit' : '' },
              h('span', { className: 'ln' }, String(l.n).padStart(4, ' ') + '  '), l.text || ' ')))));
    }

    /* ────────────────────────── Flash 占用面板 ────────────────────────── */

    function SizePanel({ size, map, onBuild, busy, keil }) {
      const pct = (a, b) => (b ? (a / b * 100) : 0);
      const fmt = (b) => (b >= 1024 ? (b / 1024).toFixed(2) + ' KB' : b + ' B');
      const short = (s) => String(s || '').replace(/^\.\\/, '');
      const bar = (used, total, label) => h('div', { style: { margin: '6px 0 10px' } },
        h('div', { className: 'wb-kv' }, h('span', null, label),
          h('b', null, fmt(used) + ' / ' + fmt(total) + '　' + pct(used, total).toFixed(1) +
            '%　剩余 ' + fmt(Math.max(0, total - used)))),
        h('div', { style: { height: 8, borderRadius: 4, background: 'var(--dsw-alias-bg-layer-2)', overflow: 'hidden' } },
          h('div', { style: { height: '100%', width: Math.min(100, pct(used, total)).toFixed(1) + '%',
            background: pct(used, total) > 90 ? 'var(--dsw-alias-state-error-primary)'
              : pct(used, total) > 75 ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-brand-primary)' } })));

      if (!size || !map || !map.objects) {
        return h('div', { className: 'wb-card' },
          h('p', { className: 'wb-sec' }, 'Flash 占用分析'),
          h('p', { className: 'wb-note' },
            '还没有账本。点下面按钮（或顶部的「构建 Keil 工程」）编译一次就会生成。数据来自 armlink 的 --map，' +
            '是链接后的真实占用 —— 未被调用的函数已经被链接器删掉了，不是估算。'),
          onBuild && h('div', { className: 'wb-inline', style: { marginTop: 8 } },
            h('button', { className: 'wb-btn primary', disabled: busy, onClick: onBuild },
              busy ? '构建中…' : '构建 Keil 工程')),
          !onBuild && h('p', { className: 'wb-note', style: { marginTop: 6 } },
            '先在「引脚规划」页打开一个 Keil 工程。'));
      }

      const cap = (size.flashKB || 64) * 1024;
      const capRam = (size.ramKB || 20) * 1024;
      return h('div', null,
        h('div', { className: 'wb-card' },
          h('p', { className: 'wb-sec' }, '总账' + (keil && keil.open ? '（' + keil.project.name + '）' : '')),
          bar(size.flashBytes, cap, 'Flash'),
          bar(size.ramBytes, capRam, 'SRAM'),
          h('div', { className: 'wb-kv' }, h('span', null, 'Code / RO / RW / ZI'),
            h('b', null, size.code + ' / ' + size.rodata + ' / ' + size.rwdata + ' / ' + size.zidata)),
          h('div', { className: 'wb-kv' }, h('span', null, '你的代码 vs C 库/启动'),
            h('b', null, fmt(map.user.flash) + '（' + pct(map.user.flash, size.flashBytes).toFixed(1) + '%） vs ' +
              fmt(map.library.flash)))),

        h('div', { className: 'wb-card' },
          h('p', { className: 'wb-sec' }, '你的文件按 Flash 占用排'),
          map.userObjects.filter((o) => o.flash > 0).slice(0, 12).map((o) => h('div', { className: 'wb-kv', key: o.name },
            h('span', { style: { fontSize: 11, wordBreak: 'break-all' } }, short(o.source || o.name)),
            h('b', null, fmt(o.flash) + '　' + pct(o.flash, cap).toFixed(1) + '%')))),

        h('div', { className: 'wb-card' },
          h('p', { className: 'wb-sec' }, '单个函数 Top 12 —— 想省 Flash 从这里下手'),
          map.functions.slice(0, 12).map((f) => h('div', { className: 'wb-kv', key: f.name + f.addr },
            h('span', { style: { fontSize: 11, wordBreak: 'break-all' } },
              f.name + '　' + short(f.source || f.object)),
            h('b', null, fmt(f.size) + '　' + pct(f.size, cap).toFixed(1) + '%')))),

        h('div', { className: 'wb-card' },
          h('p', { className: 'wb-sec' }, 'C 库与启动代码（你改不了，但要知道它占了多少）'),
          map.libObjects.filter((o) => o.flash > 0).slice(0, 8).map((o) => h('div', { className: 'wb-kv', key: o.name },
            h('span', { style: { fontSize: 11, wordBreak: 'break-all' } }, o.name),
            h('b', null, fmt(o.flash))))),

        (map.regions || []).length > 0 && h('div', { className: 'wb-card' },
          h('p', { className: 'wb-sec' }, '内存区域'),
          map.regions.map((g) => h('div', { className: 'wb-kv', key: g.name },
            h('span', null, (g.load ? '装载域 ' : '执行域 ') + g.name + '　0x' + g.base.toString(16)),
            h('b', null, g.size + ' / ' + g.max + ' B　' + pct(g.size, g.max).toFixed(1) + '%')))),
      );
    }

    /* ────────────────────────── 寄存器面板 ────────────────────────── */

    function Registers({ regs, onRead, busy, keil }) {
      const mhz = (hz) => (hz / 1e6).toFixed(3).replace(/\.?0+$/, '') + ' MHz';
      const kv = (k, v, tone) => h('div', { className: 'wb-kv' }, h('span', null, k),
        h('b', { style: tone ? { color: tone } : null }, v));
      const hex8 = (n) => (n >>> 0).toString(16).padStart(8, '0');
      const STATUS = {
        match: '✓ 一致',
        'mode-diff': '≠ 模式不同',
        'code-only': '✗ 代码有·芯片无',
        'chip-only': '✗ 芯片有·代码无',
        'debug-pin': '· 调试口（已排除）',
        indistinguishable: '· 浮空输入（无法区分）',
      };
      const BAD = { 'mode-diff': 1, 'code-only': 1, 'chip-only': 1 };
      const RANK = { 'mode-diff': 0, 'code-only': 0, 'chip-only': 0, match: 1, 'debug-pin': 2, indistinguishable: 2 };

      return h('div', null,
        h('div', { className: 'wb-card' },
          h('p', { className: 'wb-sec' }, '读芯片寄存器（SWD 直读，不占串口）'),
          h('div', { className: 'wb-inline' },
            h('button', { className: 'wb-btn primary', disabled: busy, onClick: onRead },
              busy ? '读取中…' : '读取寄存器'),
            h('span', { className: 'wb-note' }, 'halt → 读 → resume，程序只停极短时间')),
          !regs && h('p', { className: 'wb-note' },
            '点按钮读取 RCC 时钟树、外设时钟使能、GPIO 实际配置，并与源码静态分析逐脚对照。')),

        regs && !regs.ok && h('div', { className: 'wb-card' },
          h('p', { className: 'wb-sec', style: { color: 'var(--dsw-alias-state-error-primary)' } }, '读取失败'),
          h('p', { className: 'wb-note', style: { whiteSpace: 'pre-wrap' } }, regs.error || '未知原因'),
          h('p', { className: 'wb-note', style: { marginTop: 6 } },
            '常见原因：ST-Link 没插好、SWD 四根线（3V3/GND/SWDIO/SWCLK）没接对、板子没上电。')),

        regs && regs.ok && h('div', null,
          h('div', { className: 'wb-card' },
            h('p', { className: 'wb-sec' }, '时钟树'),
            kv('时钟源', regs.clock.source + '（寄存器请求：' + regs.clock.swRequested + '）'),
            kv('SYSCLK', mhz(regs.clock.sysclkHz),
              regs.clock.sysclkHz > 72000000 ? 'var(--dsw-alias-state-warn-primary)' : null),
            kv('HCLK（AHB）', mhz(regs.clock.hclkHz) + '　分频 ' + regs.clock.prescalers.hpre),
            kv('PCLK1（APB1）', mhz(regs.clock.pclk1Hz) + '　分频 ' + regs.clock.prescalers.ppre1 + '（上限 36 MHz）'),
            kv('PCLK2（APB2）', mhz(regs.clock.pclk2Hz) + '　分频 ' + regs.clock.prescalers.ppre2 + '（上限 72 MHz）'),
            kv('ADCCLK', mhz(regs.clock.adcclkHz)),
            kv('PLL', (regs.clock.pll.on ? '开' : '关') + ' · ' + regs.clock.pll.src + ' ×' + regs.clock.pll.mul +
              ' → ' + mhz(regs.clock.pll.outHz)),
            kv('HSE', (regs.clock.hse.on ? '开' : '关') + ' · ' + mhz(regs.clock.hse.hz)),
            h('p', { className: 'wb-note', style: { marginTop: 4 } }, 'HSE 取值来源：' + regs.hse.source)),

          h('div', { className: 'wb-card' },
            h('p', { className: 'wb-sec' }, '外设时钟使能（芯片里真实开着的）'),
            h('p', { className: 'wb-note' }, 'APB2：' + (regs.rcc.enabledAPB2.join('　') || '（无）')),
            h('p', { className: 'wb-note' }, 'APB1：' + (regs.rcc.enabledAPB1.join('　') || '（无）'))),

          h('div', { className: 'wb-card' },
            h('p', { className: 'wb-sec' }, 'GPIO 实际配置（从 CRL/CRH 解码）'),
            ['A', 'B', 'C'].map((p) => regs.gpio[p] && h('div', { key: p, style: { marginBottom: 8 } },
              h('p', { className: 'wb-note', style: { fontFamily: 'ui-monospace,Consolas,monospace' } },
                'GPIO' + p + '　CRL=' + hex8(regs.gpio[p].crl) + ' CRH=' + hex8(regs.gpio[p].crh) +
                ' IDR=' + regs.gpio[p].idrHex + ' ODR=' + regs.gpio[p].odrHex),
              regs.gpio[p].used.length
                ? regs.gpio[p].used.map((pin) => h('div', { className: 'wb-kv', key: pin.name },
                    h('span', null, pin.name + '　' + (pin.isInput ? ('输入电平 ' + pin.inputLevel) : ('输出电平 ' + pin.outputLevel))),
                    h('b', null, pin.text + (pin.speed ? ' · ' + pin.speed : ''))))
                : h('p', { className: 'wb-note' }, '（全部处于复位默认：浮空输入）')))),

          regs.compare && h('div', { className: 'wb-card' },
            h('p', { className: 'wb-sec' }, '源码分析 vs 芯片实际'),
            h('p', { className: 'wb-note', style: { marginBottom: 6 } }, regs.compare.verdict),
            regs.compare.rows.slice()
              .sort((a, b) => (RANK[a.status] - RANK[b.status]) || a.pin.localeCompare(b.pin))
              .map((r) => h('div', { className: 'wb-kv', key: r.pin },
                h('span', null, r.pin + '　' + (r.codeMode || '—') + ' → ' + (r.chipMode || '—')),
                h('b', { style: BAD[r.status] ? { color: 'var(--dsw-alias-state-warn-primary)' } : { color: 'var(--dsw-alias-label-secondary)' } },
                  STATUS[r.status] || r.status))),
            h('p', { className: 'wb-note', style: { marginTop: 6 } },
              '可比对 ' + (regs.compare.comparable || 0) + ' 条：一致 ' + regs.compare.matched +
              ' · 实质差异 ' + (regs.compare.realDiff || 0) +
              '　（调试口 ' + (regs.compare.debugPin || 0) + ' 个已排除，浮空输入 ' +
              (regs.compare.indistinguishable || 0) + ' 个无法区分）')),

          keil && keil.open && h('p', { className: 'wb-note' }, '对照基准：' + keil.project.name + '（' + keil.project.dir + '）'),
        ),
      );
    }

    function SerialPanel({ ports, push }) {
      const [port, setPort] = useState('');
      const [baud, setBaud] = useState('115200');
      const [session, setSession] = useState('');
      const [text, setText] = useState('');
      const [send, setSend] = useState('');
      const abortRef = useRef(null);

      useEffect(() => { if (!port && ports.length) setPort(ports[0].path); }, [ports, port]);
      useEffect(() => () => { if (abortRef.current) abortRef.current.abort(); }, []);

      const open = async () => {
        try {
          const r = await api('/serial/open', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ port, baud: Number(baud) }),
          });
          setSession(r.sessionId); setText('');
          const ctl = new AbortController(); abortRef.current = ctl;
          const res = await fetch(`${API}/serial/stream?sessionId=${r.sessionId}`, { signal: ctl.signal });
          const reader = res.body.getReader(); const dec = new TextDecoder();
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
              const raw = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
              if (!raw) continue;
              let ev; try { ev = JSON.parse(raw); } catch (_) { continue; }
              if (ev.type === 'data') setText((p) => (p + ev.text).slice(-20000));
              else if (ev.type === 'error') setText((p) => p + `\n[错误] ${ev.text}`);
              else if (ev.type === 'closed') setText((p) => p + '\n[已关闭]');
            }
          }
        } catch (err) {
          if (String(err.name) !== 'AbortError') push('串口打开失败：' + String(err.message || err), 'e');
          setSession('');
        }
      };

      const close = async () => {
        if (abortRef.current) abortRef.current.abort();
        if (session) await fetch(API + '/serial/close', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: session }),
        }).catch(() => {});
        setSession('');
      };

      const sendNow = async () => {
        if (!session || !send) return;
        await fetch(API + '/serial/write', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: session, data: send + '\r\n' }),
        }).catch(() => {});
        setSend('');
      };

      return h('div', null,
        h('div', { className: 'wb-field' },
          h('label', null, '端口'),
          h('select', { value: port, onChange: (e) => setPort(e.target.value), disabled: !!session },
            (ports.length ? ports : [{ path: '' }]).map((p) =>
              h('option', { key: p.path, value: p.path }, p.path + (p.description ? ' — ' + p.description : '')))),
          h('label', null, '波特率'),
          h('input', { value: baud, onChange: (e) => setBaud(e.target.value), disabled: !!session, style: { width: 84 } }),
          session ? h('button', { className: 'wb-btn', onClick: close }, '关闭')
                  : h('button', { className: 'wb-btn primary', disabled: !port, onClick: open }, '打开')),
        !ports.length && h('p', { className: 'wb-note' }, '当前没有检测到串口设备。插上 USB 转串口后重启后端即可。'),
        h('pre', { className: 'wb-log', style: { maxHeight: 260 } }, text || '串口数据会显示在这里（115200 8N1）。'),
        h('div', { className: 'wb-field' },
          h('input', { value: send, onChange: (e) => setSend(e.target.value), disabled: !session,
            placeholder: '发送内容（自动追加 CRLF）', style: { flex: '1 1 220px', width: 'auto' },
            onKeyDown: (e) => { if (e.key === 'Enter') sendNow(); } }),
          h('button', { className: 'wb-btn', disabled: !session, onClick: sendNow }, '发送')),
      );
    }

    function CalcPanel() {
      const [clk, setClk] = useState('72000000');
      const [psc, setPsc] = useState('7199');
      const [arr, setArr] = useState('9999');
      const [baud, setBaud] = useState('115200');

      const timer = useMemo(() => {
        const P = Number(psc), A = Number(arr), C = Number(clk);
        if (![P, A, C].every(Number.isFinite) || P < 0 || P > 65535 || A < 0 || A > 65535 || C <= 0) {
          return { err: 'PSC/ARR 必须在 0–65535，时钟必须大于 0' };
        }
        const period = ((P + 1) * (A + 1)) / C;
        return { period, freq: 1 / period, count: C / (P + 1) };
      }, [psc, arr, clk]);

      const usart = useMemo(() => {
        const B = Number(baud), C = Number(clk);
        if (![B, C].every(Number.isFinite) || B <= 0 || C <= 0) return { err: '波特率与时钟必须大于 0' };
        if (C / 16 < B) return { err: '波特率超过 PCLK/16 上限（F1 只有 16 倍过采样）' };
        const div = C / (16 * B);
        const mant = Math.floor(div);
        let frac = Math.round((div - mant) * 16);
        let m = mant;
        if (frac === 16) { frac = 0; m += 1; }
        const actual = C / (16 * (m + frac / 16));
        return { brr: (m << 4) | frac, mant: m, frac, actual, errPct: (actual - B) / B * 100 };
      }, [baud, clk]);

      const fmt = (t) => (t >= 1 ? `${t.toFixed(4)} s` : t >= 1e-3 ? `${(t * 1e3).toFixed(4)} ms` : `${(t * 1e6).toFixed(3)} µs`);

      return h('div', { className: 'wb-grid' },
        h('div', null,
          h('p', { className: 'wb-sec' }, '定时器定时周期'),
          h('div', { className: 'wb-field' }, h('label', null, 'TIMxCLK'), h('input', { value: clk, onChange: (e) => setClk(e.target.value) })),
          h('div', { className: 'wb-field' }, h('label', null, 'PSC'), h('input', { value: psc, onChange: (e) => setPsc(e.target.value) })),
          h('div', { className: 'wb-field' }, h('label', null, 'ARR'), h('input', { value: arr, onChange: (e) => setArr(e.target.value) })),
          timer.err ? h('p', { className: 'wb-err' }, timer.err) : h('div', null,
            h('div', { className: 'wb-kv' }, h('span', null, '周期'), h('b', null, fmt(timer.period))),
            h('div', { className: 'wb-kv' }, h('span', null, '频率'), h('b', null, `${timer.freq.toFixed(4)} Hz`)),
            h('div', { className: 'wb-kv' }, h('span', null, '计数时钟'), h('b', null, `${(timer.count / 1e6).toFixed(3)} MHz`))),
          h('p', { className: 'wb-note' }, 'T = (PSC+1)(ARR+1)/TIMxCLK')),
        h('div', null,
          h('p', { className: 'wb-sec' }, 'USART 波特率（BRR）'),
          h('div', { className: 'wb-field' }, h('label', null, 'PCLK'), h('input', { value: clk, onChange: (e) => setClk(e.target.value) })),
          h('div', { className: 'wb-field' }, h('label', null, '波特率'), h('input', { value: baud, onChange: (e) => setBaud(e.target.value) })),
          usart.err ? h('p', { className: 'wb-err' }, usart.err) : h('div', null,
            h('div', { className: 'wb-kv' }, h('span', null, 'BRR'), h('b', null, `0x${usart.brr.toString(16).toUpperCase()}`)),
            h('div', { className: 'wb-kv' }, h('span', null, 'Mantissa / Fraction'), h('b', null, `${usart.mant} / ${usart.frac}`)),
            h('div', { className: 'wb-kv' }, h('span', null, '实际波特率'), h('b', null, usart.actual.toFixed(1))),
            h('div', { className: 'wb-kv' }, h('span', null, '误差'),
              h('b', null, `${usart.errPct >= 0 ? '+' : ''}${usart.errPct.toFixed(3)} %`))),
          h('p', { className: 'wb-note' }, 'USARTDIV = PCLK/(16×baud)，BRR = Mantissa<<4 | Fraction')),
      );
    }

    /* ────────────────────────── 侧栏入口 ────────────────────────── */

    function Launcher({ openProject }) {
      const dialog = useRef(null);
      const [open, setOpen] = useState(false);
      const [path, setPath] = useState('');
      const [busy, setBusy] = useState(false);
      const [error, setError] = useState('');

      useEffect(() => {
        if (open) dialog.current?.showModal?.();
        else dialog.current?.close?.();
      }, [open]);

      const go = async () => {
        setBusy(true); setError('');
        try {
          const ok = await openProject(path);
          if (ok) setOpen(false);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : String(cause));
        } finally { setBusy(false); }
      };

      return h(React.Fragment, null,
        h('button', {
          className: 'wb-entry', type: 'button', title: '新建单片机开发会话',
          'aria-label': '打开单片机工作台', onClick: () => setOpen(true),
        }, h('span', { 'aria-hidden': true }, '▣'), h('span', null, 'STM32 工作台')),
        h('dialog', { ref: dialog, className: 'wb-dialog', onCancel: () => setOpen(false) },
          h('style', null, STYLE),
          h('h2', null, '新建单片机开发会话'),
          h('p', null, '选一个工作区（建议填你的 STM32 工程根目录）。选定后会为它建立一个「单片机模式」会话，工作台随后出现在会话视图里。已有会话保持原样，不会被切换模式。'),
          h('label', { style: { display: 'block', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginBottom: 4 } },
            '工作区路径（留空则弹目录选择器）'),
          h('input', { value: path, onChange: (e) => setPath(e.target.value),
            placeholder: '例如 D:\\work\\MyProject（你的 Keil 工程根目录）' }),
          error && h('p', { className: 'wb-err', role: 'alert' }, error),
          h('div', { className: 'wb-row' },
            h('button', { className: 'wb-btn', type: 'button', onClick: () => setOpen(false) }, '取消'),
            h('button', { className: 'wb-btn primary', type: 'button', disabled: busy, onClick: go },
              busy ? '正在打开…' : (path.trim() ? '进入该工作区' : '选择目录并进入'))),
        ),
      );
    }

    /* ────────────────────────── 作用域门控 ────────────────────────── */

    /** 当前主视图正在显示的会话（0.2 用 retainedBy.mainView，0.1 用 list.current） */
    function displayedSession(state) {
      if (!state || !state.byId) return undefined;
      const ids = Array.isArray(state.ids) ? state.ids : Object.keys(state.byId);
      const retained = ids.find((id) => {
        const row = state.byId[id];
        return row && row.retainedBy && (row.retainedBy.mainView || 0) > 0;
      });
      return retained !== undefined ? retained : state.current;
    }

    function presetOf(state, sessionId) {
      if (!sessionId || !state || !state.byId) return undefined;
      const row = state.byId[sessionId];
      const value = row && row.projectionValues && row.projectionValues.agentPreset;
      return typeof value === 'string' ? value : undefined;
    }

    /** 当前会话是「单片机模式」就返回它的 id，否则 undefined —— 门控与「跟着会话走」共用同一份判断 */
    function mcuSessionId(state) {
      const id = displayedSession(state);
      const p = presetOf(state, id);
      return (typeof p === 'string' && (p === PRESET_ID || p.startsWith(PRESET_ID + '-'))) ? id : undefined;
    }

    function isMcuSession(state) { return mcuSessionId(state) !== undefined; }

    /**
     * 会话列表变化时挂载/卸载受门控的贡献 —— 与 dsh-openwrite 的 watchWritingScope 同构。
     *
     * **关键修正（2026-10-14）**：原来只在「是不是 mcu 会话」这一位翻转时才挂载/卸载。
     * 从 mcu 会话 A 切到 mcu 会话 B 时两边都是 mcu，谓词没变 → 视图**不会重挂**，
     * 于是工作台一直显示 A 的工程：切了工作区也不跟着走，必须手动再选一次。
     * 现在把「当前是哪个会话」也纳入判断：会话一变就重建，并把会话 id 交给 mount。
     */
    function watchScope(source, pick, mount) {
      let dispose;
      let mountedFor;
      const refresh = () => {
        let id;
        try { id = pick(source.getSnapshot()); } catch (_) { id = undefined; }
        if (id === mountedFor) return;                 // 同一个会话（或都为空）不动它
        if (dispose) { dispose(); dispose = undefined; }
        mountedFor = id;
        if (id !== undefined) dispose = mount(id);
      };
      const unsubscribe = source.subscribe(refresh);
      try { refresh(); } catch (error) { unsubscribe(); throw error; }
      return () => { unsubscribe(); if (dispose) dispose(); };
    }

    /* ────────────────────────── 注册 ────────────────────────── */

    return {
      /* remote 服务必须声明：进入工作台时要用 ctx.remote.agentPresets.select 把会话切到「单片机模式」。
         未注入也能碰运气访问到全局服务，但服务注册顺序/隔离一变就静默失效（DSH 0.2.1 规范项）。 */
      inject: ['slots', 'sessions', 'uiWorkspace', 'workspaces', 'remote'],
      apply(ctx) {
        const launched = new Set();

        /* 会话 → 工作区目录。切会话时靠它自动切换工程。
           存 localStorage：**页面一刷新内存就空了**，而这件事需要跨刷新记得住。
           键名带前缀，避免和宿主/别的插件撞。 */
        const WS_KEY = 'stm32-workbench.workspaces';
        const wsMap = (() => {
          try { return JSON.parse(localStorage.getItem(WS_KEY) || '{}') || {}; } catch (_) { return {}; }
        })();
        const rememberWorkspace = (sessionId, dir) => {
          if (!sessionId || !dir) return;
          wsMap[sessionId] = dir;
          try { localStorage.setItem(WS_KEY, JSON.stringify(wsMap)); } catch (_) { /* 存不下不影响本次会话 */ }
        };

        /** 侧栏入口干的事：选目录 → 建工作区 → 建会话 → 选 mcu 预设 → 打开 */
        const openProject = async (rawPath) => {
          const target = rawPath && rawPath.trim()
            ? rawPath.trim()
            : await ctx.uiWorkspace.pickDirectory();
          if (!target) return false;

          let workspaceId;
          if (typeof ctx.workspaces?.create === 'function') {
            const w = await ctx.workspaces.create({ path: target });
            workspaceId = w && (w.workspaceId || w.id);
          }

          let sessionId;
          if (workspaceId && typeof ctx.uiWorkspace?.connectWorkspace === 'function') {
            sessionId = await ctx.uiWorkspace.connectWorkspace(workspaceId);
          } else if (typeof ctx.uiWorkspace?.startSession === 'function') {
            ctx.uiWorkspace.startSession(workspaceId);
          }
          if (!sessionId) throw new Error('建会话失败：宿主没有返回会话 id（connectWorkspace 不可用？）');

          // 选中单片机模式；预设由宿主半边注册
          const presets = ctx.remote && ctx.remote.agentPresets;
          if (!presets || typeof presets.select !== 'function') {
            throw new Error('无法切换模式：ctx.remote.agentPresets.select 不可用');
          }
          const result = await presets.select(sessionId, PRESET_ID);
          if (result && result.ok === false) {
            throw new Error(`切换到「单片机模式」失败：${(result.error && result.error.message) || '未知错误'}。若提示预设不存在，请重启一次 DSH 让插件注册生效。`);
          }

          launched.add(sessionId);
          // 记住这个会话对应的工作区目录，切回来时才能自动切工程
          rememberWorkspace(sessionId, target);
          ctx.uiWorkspace.openSession(sessionId);
          return true;
        };

        // 1) 侧栏入口：永远可见（它是进入单片机模式的唯一门）
        ctx.slots.inject('sidebar.footer.action', () => ctx.effect(() => ctx.slots.register({
          name: 'sidebar.footer.action', id: 'stm32.launch', order: 12,
          inject: () => ({ openProject }),
        }, Launcher), 'stm32-workbench: launcher'));

        // 2) 工作台视图：只在 mcu 会话里挂载，并且**跟着当前会话走**（切会话即重建）
        const mountView = (sessionId) => ctx.effect(() => ctx.slots.register({
          name: 'conversation.view', id: 'stm32.workbench', order: 25,
          label: () => '单片机工作台',
        }, () => h(Workbench, {
          uiWorkspace: ctx.uiWorkspace,
          // 会话 id：工作台据此向宿主反查「这个会话属于哪个工作区」
          sessionId,
          // 插件自己建会话时记下的快路径（有就不必往宿主跑一趟）
          sessionPath: wsMap[sessionId],
          // 「改完描述发回给模型」这条回程要用：客户端只有 sessions 能投递消息
          sessions: ctx.sessions,
        })), 'stm32-workbench: workbench view');

        const list = ctx.sessions && ctx.sessions.list;
        if (list && typeof list.getSnapshot === 'function' && typeof list.subscribe === 'function') {
          ctx.slots.inject('conversation.view', () => watchScope(list, mcuSessionId, mountView));
        } else {
          // 宿主没暴露会话列表：退化成「由本插件入口打开过的会话才挂载」，
          // 宁可少显示，也绝不污染别的对话。
          console.warn('[stm32-workbench] 会话列表不可用，工作台视图改为按入口打开的会话惰性挂载');
          ctx.slots.inject('conversation.view', () => {
            let dispose;
            let mountedFor;
            const refresh = () => {
              const id = launched.size ? Array.from(launched)[0] : undefined;
              if (id === mountedFor) return;
              if (dispose) { dispose(); dispose = undefined; }
              mountedFor = id;
              if (id !== undefined) dispose = mountView(id);
            };
            const timer = setInterval(refresh, 1000);
            refresh();
            return () => { clearInterval(timer); if (dispose) dispose(); };
          });
        }
      },
    };
  },
});
