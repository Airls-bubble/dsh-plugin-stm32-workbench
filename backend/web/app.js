/* app.js — 工作台外壳：状态条 / 工作区切换 / 项目 / 构建 / 烧录 / 串口
 * 后端契约（同源 /api，见 web/README.md）：
 *   GET  /api/env | GET /api/detect  → 环境探测
 *   GET  /api/templates | GET|POST|DELETE /api/projects
 *   POST /api/build | /api/flash | /api/reset | /api/chip-info   （NDJSON 流）
 *   POST /api/serial/open | /api/serial/close | /api/serial/write
 *   GET  /api/serial/stream?sessionId=                            （NDJSON 流）
 *   GET  /api/pins                                                （引脚数据，失败则内置兜底）
 * 后端不在时：状态条报「后端未启动」，引脚图与计算器照常工作。
 */
window.STM32App = (function () {
  'use strict';

  const API = '/api';
  const LS = { project: 'stm32wb.project.v1', theme: 'stm32wb.theme.v1', assign: 'stm32wb.assignments.v1' };
  const VIEWS = ['pins', 'build', 'flash', 'serial', 'calc'];
  const START_CMD = 'node server/server.js';

  const $ = (id) => document.getElementById(id);

  const state = {
    online: false,
    env: null,
    projects: [],
    templates: [],
    projectId: null,
    buildCtl: null,
    buildLines: 0,
    flashCtl: null,
    flashLines: 0,
    serial: { sessionId: null, ctl: null, rx: 0, tx: 0, open: false }
  };
  let planner = null;          // 引脚规划视图实例（boot 时创建）

  /* ═══════════ 基础工具 ═══════════ */
  let toastTimer = null;
  function toast(msg, tone) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    el.setAttribute('data-tone', tone || '');
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { el.hidden = true; }, tone === 'err' ? 5200 : 3000);
  }

  function setStatus(el, text, tone) {
    el.textContent = text;
    if (tone) el.setAttribute('data-tone', tone); else el.removeAttribute('data-tone');
  }

  function fmtBytes(n) {
    if (!isFinite(n)) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(2) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function nowStamp(ts) {
    const d = ts ? new Date(ts) : new Date();
    const p = (v, w) => String(v).padStart(w || 2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.' + p(d.getMilliseconds(), 3);
  }

  function logAppend(el, text, cls, max) {
    if (!el) return;
    const span = document.createElement('span');
    span.className = 'ln' + (cls ? ' ' + cls : '');
    span.textContent = String(text) + '\n';
    el.appendChild(span);
    const cap = max || 2000;
    while (el.childNodes.length > cap) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
  }

  function logClear(el, metaEl) {
    if (el) el.textContent = '';
    if (metaEl) metaEl.textContent = '0 行';
  }

  /* ═══════════ HTTP ═══════════ */
  async function fetchJSON(path, opts, timeoutMs) {
    const ctl = new AbortController();
    const to = window.setTimeout(() => ctl.abort(), timeoutMs || 8000);
    try {
      const res = await fetch(path, Object.assign({}, opts || {}, {
        signal: ctl.signal,
        headers: Object.assign({ Accept: 'application/json' }, (opts && opts.headers) || {})
      }));
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
      if (!res.ok) {
        const detail = (body && (body.error || body.message)) || (text ? text.slice(0, 200) : '');
        throw new Error('HTTP ' + res.status + (detail ? '：' + detail : ''));
      }
      if (body === null) throw new Error('响应不是 JSON（' + text.slice(0, 160) + '）');
      return body;
    } finally { window.clearTimeout(to); }
  }

  function postJSON(path, payload, timeoutMs) {
    return fetchJSON(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {})
    }, timeoutMs);
  }

  /** 解析一行 NDJSON；解析失败按普通文本行处理 */
  function makeLineHandler(onEvent) {
    return function (raw) {
      const s = String(raw).replace(/\r$/, '');
      if (!s.trim()) return;
      try { onEvent(JSON.parse(s)); }
      catch (e) { onEvent({ type: 'line', text: s, unparsed: true }); }
    };
  }

  /**
   * 逐行读 NDJSON 流。
   * @returns {{promise:Promise, abort:Function}}
   */
  function streamNdjson(url, opts, onEvent) {
    const ctl = new AbortController();
    const handle = makeLineHandler(onEvent);
    const promise = (async () => {
      const res = await fetch(url, Object.assign({}, opts || {}, {
        signal: ctl.signal,
        headers: Object.assign({ Accept: 'application/x-ndjson' }, (opts && opts.headers) || {})
      }));
      if (!res.ok) {
        let detail = '';
        try { detail = (await res.text()).slice(0, 300); } catch (e) { /* ignore */ }
        throw new Error('HTTP ' + res.status + ' ' + res.statusText + (detail ? '：' + detail : ''));
      }
      if (!res.body || !res.body.getReader) {           // 兜底：整体读取
        const text = await res.text();
        text.split('\n').forEach(handle);
        return;
      }
      const reader = res.body.getReader();
      const dec = new TextDecoder('utf-8');
      let buf = '';
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buf += dec.decode(chunk.value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
      }
      buf += dec.decode();
      if (buf.trim()) handle(buf);
    })();
    return { promise, abort: () => ctl.abort() };
  }

  function streamPost(path, payload, onEvent) {
    return streamNdjson(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {})
    }, onEvent);
  }

  function streamGet(path, onEvent) {
    return streamNdjson(path, { method: 'GET' }, onEvent);
  }

  /* ═══════════ 后端探测 / 状态条 ═══════════ */
  async function probe() {
    const dot = $('backendDot');
    const txt = $('backendText');
    dot.setAttribute('data-state', 'unknown');
    txt.textContent = '正在探测 ' + API + '/env …';
    let env = null, err = null;
    try { env = await fetchJSON(API + '/env', null, 4000); }
    catch (e1) {
      try { env = await fetchJSON(API + '/detect', null, 4000); }
      catch (e2) { err = e1; }
    }
    if (!env) {
      state.online = false;
      state.env = null;
      dot.setAttribute('data-state', 'offline');
      txt.textContent = '后端未启动（' + API + ' 无响应）· 启动：' + START_CMD + '（或 npm start，端口 8788）';
      $('envHint').textContent = START_CMD + '   ·   端口 8788';
      $('envHint').classList.add('bad');
      $('envHost').textContent = '未连接';
      $('envHost').classList.add('bad');
      $('envCompilers').textContent = '—';
      $('envFlashers').textContent = '—';
      $('envSerial').textContent = '—';
      renderEnvDetail(null);
      applyFlasherAvailability();
      return false;
    }
    state.online = true;
    state.env = env;
    const compilers = Array.isArray(env.compilers) ? env.compilers : [];
    const flashers = Array.isArray(env.flashers) ? env.flashers : [];
    const ports = Array.isArray(env.serialPorts) ? env.serialPorts : [];
    const board = env.board || {};
    const usableC = compilers.filter((c) => c.usable);
    const usableF = flashers.filter((f) => f.usable);

    const stlink = board.stlinkLikelyPresent === undefined ? usableF.length > 0 : !!board.stlinkLikelyPresent;
    const partial = !usableC.length || !usableF.length;
    dot.setAttribute('data-state', partial ? 'partial' : 'online');
    txt.textContent = '后端正常 · ' + (env.host ? (env.host.platform || '') + ' node ' + (env.host.node || '') : '已连接') +
      ' · 编译器 ' + usableC.length + '/' + compilers.length + ' · 烧录器 ' + usableF.length + '/' + flashers.length +
      ' · 串口 ' + ports.length + (stlink ? ' · ST-Link 在线' : ' · 未检测到 ST-Link');

    $('envHost').textContent = env.host ? ((env.host.platform || '?') + ' · node ' + (env.host.node || '?')) : '已连接';
    $('envHost').classList.remove('bad');
    $('envCompilers').textContent = compilers.length
      ? compilers.map((c) => c.name + ' ' + (c.version || '') + (c.usable ? '' : '（不可用）')).join('；')
      : '未探测到';
    $('envCompilers').classList.toggle('bad', !usableC.length);
    $('envFlashers').textContent = flashers.length
      ? flashers.map((f) => f.name + ' ' + (f.version || '') + (f.usable ? '' : '（不可用）')).join('；')
      : '未探测到';
    $('envFlashers').classList.toggle('bad', !usableF.length);
    $('envSerial').textContent = ports.length
      ? ports.map((p) => p.path + (p.role ? ' [' + p.role + ']' : '') + (p.description ? ' ' + p.description : '')).join('；')
      : '未发现串口';
    $('envHint').textContent = '同源 ' + API + ' · 端口 8788';
    $('envHint').classList.remove('bad');

    renderEnvDetail(env);
    fillFlashers(flashers);
    fillSerialPorts(ports);
    applyFlasherAvailability();
    return true;
  }

  function renderEnvDetail(env) {
    const dl = $('envDetail');
    if (!env) {
      dl.innerHTML = '<dt>状态</dt><dd id="envDetailState" class="bad">后端未启动</dd>' +
        '<dt>启动</dt><dd class="mono">' + START_CMD + '</dd>' +
        '<dt>说明</dt><dd>引脚图与计算器仍可用；构建/烧录/串口需要后端。</dd>';
      return;
    }
    const rows = [];
    rows.push(['状态', '已连接']);
    if (env.host) rows.push(['主机', (env.host.platform || '?') + ' / node ' + (env.host.node || '?')]);
    if (env.keilRoot) rows.push(['Keil', env.keilRoot]);
    for (const c of (env.compilers || [])) rows.push(['编译器', c.name + ' ' + (c.version || '') + ' — ' + (c.path || '') + (c.usable ? '' : '（不可用）')]);
    for (const f of (env.flashers || [])) rows.push(['烧录器', f.name + ' ' + (f.version || '') + ' — ' + (f.path || '') + (f.usable ? '' : '（不可用）')]);
    for (const p of (env.serialPorts || [])) rows.push(['串口', p.path + (p.role ? ' [' + p.role + ']' : '') + (p.description ? ' ' + p.description : '')]);
    if (env.board) {
      rows.push(['ST-Link', env.board.stlinkLikelyPresent ? '疑似在线' : '未检测到']);
      if (Array.isArray(env.board.evidence) && env.board.evidence.length) rows.push(['依据', env.board.evidence.join('；')]);
    }
    dl.innerHTML = rows.map(([k, v], i) =>
      '<dt>' + k + '</dt><dd' + (i === 0 ? ' id="envDetailState" class="good"' : '') + '>' + escapeHtml(v) + '</dd>').join('');
  }

  function escapeHtml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function usableFlashers() {
    const env = state.env;
    if (!env || !Array.isArray(env.flashers)) return [];
    return env.flashers.filter((f) => f.usable);
  }

  function fillFlashers(flashers) {
    const sel = $('flasherSelect');
    const keep = sel.value;
    sel.innerHTML = '<option value="">自动</option>' + (flashers || []).map((f) =>
      '<option value="' + escapeHtml(f.id) + '">' + escapeHtml(f.name) + (f.usable ? '' : '（不可用）') + '</option>').join('');
    if (keep) sel.value = keep;
  }

  function applyFlasherAvailability() {
    const any = usableFlashers().length > 0;
    const warn = $('flasherWarn');
    warn.hidden = any;
    ['btnFlash', 'btnReset', 'btnChipInfo'].forEach((id) => {
      const b = $(id);
      if (!b) return;
      b.disabled = !any || !state.online;
      b.title = any ? '' : '未检测到 ST-Link / OpenOCD，无法执行';
    });
  }

  /* ═══════════ 项目 ═══════════ */
  async function loadProjects() {
    const list = $('projectList');
    if (!state.online) {
      list.innerHTML = '<li class="empty">后端未启动，无法读取项目列表</li>';
      return;
    }
    try {
      const data = await fetchJSON(API + '/projects');
      state.projects = Array.isArray(data.projects) ? data.projects : [];
      renderProjects();
      const saved = window.localStorage ? window.localStorage.getItem(LS.project) : null;
      if (saved && state.projects.some((p) => p.id === saved)) setProject(saved);
      else if (state.projects.length && !state.projectId) setProject(state.projects[0].id);
    } catch (err) {
      list.innerHTML = '<li class="empty">读取失败：' + escapeHtml(err.message) + '</li>';
    }
  }

  function renderProjects() {
    const list = $('projectList');
    if (!state.projects.length) {
      list.innerHTML = '<li class="empty">还没有项目，点「新建」</li>';
      return;
    }
    list.innerHTML = state.projects.map((p) =>
      '<li><button type="button" class="project-btn" data-id="' + escapeHtml(p.id) + '" aria-current="' +
        (p.id === state.projectId ? 'true' : 'false') + '">' + escapeHtml(p.name || p.id) +
        ' <span class="pid">' + escapeHtml(p.id) + '</span></button>' +
      '<button type="button" class="project-del" data-del="' + escapeHtml(p.id) + '" title="删除项目">删</button></li>').join('');
  }

  function setProject(id) {
    state.projectId = id || null;
    const p = state.projects.find((x) => x.id === id);
    const label = p ? (p.name || p.id) + ' (' + p.id + ')' : '未选择';
    $('buildProject').textContent = label;
    $('flashProject').textContent = label;
    $('currentProject').textContent = p ? (p.name || p.id) : '未选择';
    if (window.localStorage) { try { window.localStorage.setItem(LS.project, id || ''); } catch (e) { /* ignore */ } }
    renderProjects();
  }

  async function createProject(id, name, template) {
    const data = await postJSON(API + '/projects', { id, name, template });
    if (!data || data.ok === false) throw new Error((data && data.error) || '创建失败');
    await loadProjects();
    setProject((data.project && data.project.id) || id);
    toast('已创建项目 ' + ((data.project && data.project.name) || name), 'ok');
  }

  async function deleteProject(id) {
    if (!window.confirm('删除项目 ' + id + '？该操作由后端执行，可能不可恢复。')) return;
    try {
      const data = await fetchJSON(API + '/projects/' + encodeURIComponent(id), { method: 'DELETE' });
      if (!data || data.ok === false) throw new Error((data && data.error) || '删除失败');
      if (state.projectId === id) setProject(null);
      await loadProjects();
      toast('已删除 ' + id, 'ok');
    } catch (err) { toast('删除失败：' + err.message, 'err'); }
  }

  async function openNewProjectDialog() {
    const dlg = $('dlgNewProject');
    $('npError').hidden = true;
    $('npId').value = '';
    $('npName').value = '';
    const sel = $('npTemplate');
    sel.innerHTML = '<option value="">（默认模板）</option>';
    if (state.online) {
      try {
        const data = await fetchJSON(API + '/templates');
        state.templates = Array.isArray(data.templates) ? data.templates : [];
        sel.innerHTML = '<option value="">（默认模板）</option>' + state.templates.map((t) =>
          '<option value="' + escapeHtml(t.id) + '">' + escapeHtml(t.name) + (t.description ? ' — ' + escapeHtml(t.description) : '') + '</option>').join('');
      } catch (err) {
        sel.innerHTML = '<option value="">（模板读取失败：' + escapeHtml(err.message) + '）</option>';
      }
    } else {
      sel.innerHTML = '<option value="">（后端未启动，无法读取模板）</option>';
    }
    if (typeof dlg.showModal === 'function') dlg.showModal();
    else dlg.setAttribute('open', 'open');
    window.setTimeout(() => $('npId').focus(), 30);
  }

  function closeNewProjectDialog() {
    const dlg = $('dlgNewProject');
    if (typeof dlg.close === 'function') dlg.close();
    else dlg.removeAttribute('open');
  }

  async function submitNewProject(ev) {
    ev.preventDefault();
    const id = $('npId').value.trim();
    const name = $('npName').value.trim();
    const template = $('npTemplate').value;
    const err = $('npError');
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
      err.textContent = '项目 ID 只能是字母/数字/下划线/短横线（1–32 字）';
      err.hidden = false;
      return;
    }
    if (!state.online) {
      err.textContent = '后端未启动（' + START_CMD + '），无法创建项目。';
      err.hidden = false;
      return;
    }
    try {
      await createProject(id, name || id, template || undefined);
      closeNewProjectDialog();
    } catch (e2) {
      err.textContent = '创建失败：' + e2.message;
      err.hidden = false;
    }
  }

  /* ═══════════ 构建台 ═══════════ */
  function setRomRam(size) {
    const DEFAULT_FLASH = 64 * 1024, DEFAULT_RAM = 20 * 1024;
    const num = (v) => (v === undefined || v === null || v === '') ? NaN : Number(v);
    let rom = NaN, ram = NaN, flashCap = DEFAULT_FLASH, ramCap = DEFAULT_RAM, detail = '';

    if (size && typeof size === 'object') {
      flashCap = isFinite(num(size.flashKB)) ? num(size.flashKB) * 1024 : DEFAULT_FLASH;
      ramCap = isFinite(num(size.ramKB)) ? num(size.ramKB) * 1024 : DEFAULT_RAM;
      if (isFinite(num(size.flashBytes)) && isFinite(num(size.ramBytes))) {
        // 契约：size = {code,rodata,rwdata,zidata,flashBytes,ramBytes,flashKB,ramKB}
        rom = num(size.flashBytes); ram = num(size.ramBytes);
        detail = 'Code ' + (isFinite(num(size.code)) ? num(size.code) : '?') + ' B · RO-data ' +
          (isFinite(num(size.rodata)) ? num(size.rodata) : '?') + ' B · RW-data ' +
          (isFinite(num(size.rwdata)) ? num(size.rwdata) : '?') + ' B · ZI-data ' +
          (isFinite(num(size.zidata)) ? num(size.zidata) : '?') + ' B\n';
      } else if ([size.text, size.data, size.bss].every((v) => isFinite(num(v)))) {
        // 兼容旧形状 {text,data,bss}：ROM = text+data，RAM = data+bss
        rom = num(size.text) + num(size.data);
        ram = num(size.data) + num(size.bss);
        detail = 'text ' + num(size.text) + ' B · data ' + num(size.data) + ' B · bss ' + num(size.bss) + ' B\n';
      }
    }

    if (!isFinite(rom) || !isFinite(ram)) {
      $('romText').textContent = '— / 64 KB';
      $('ramText').textContent = '— / 20 KB';
      $('romBar').style.width = '0%';
      $('ramBar').style.width = '0%';
      $('romBar').setAttribute('data-tone', '');
      $('ramBar').setAttribute('data-tone', '');
      $('sizeText').textContent = size ? ('size 字段无法解析：' + JSON.stringify(size)) : '构建结束时没有返回 size';
      return;
    }
    const setMeter = (bar, txtEl, value, cap, label) => {
      const pct = Math.max(0, Math.min(100, value / cap * 100));
      bar.style.width = pct.toFixed(1) + '%';
      bar.setAttribute('data-tone', pct > 90 ? 'err' : (pct > 70 ? 'warn' : ''));
      txtEl.textContent = fmtBytes(value) + ' / ' + label + '（' + pct.toFixed(1) + '%）';
    };
    setMeter($('romBar'), $('romText'), rom, flashCap, (flashCap / 1024) + ' KB');
    setMeter($('ramBar'), $('ramText'), ram, ramCap, (ramCap / 1024) + ' KB');
    $('sizeText').textContent = detail +
      'Flash(ROM) ' + rom + ' B / ' + flashCap + ' B\n' +
      'SRAM(RAM) ' + ram + ' B / ' + ramCap + ' B';
  }

  function renderArtifacts(artifact) {
    const ul = $('buildArtifacts');
    if (!artifact) { ul.innerHTML = '<li class="empty">构建结束时没有返回产物路径</li>'; return; }
    const rows = [];
    if (artifact.axf) rows.push(['axf', artifact.axf]);
    if (artifact.hex) rows.push(['hex', artifact.hex]);
    if (artifact.bin) rows.push(['bin', artifact.bin]);
    if (!rows.length) { ul.innerHTML = '<li class="empty">构建结束时没有返回产物路径</li>'; return; }
    ul.innerHTML = rows.map(([k, v]) => '<li><b>' + k + '</b> ' + escapeHtml(v) + '</li>').join('') +
      '<li class="dim">复核产物结构（HEX 校验和 / 中断向量表 / .bin 大小）：' +
      '<span class="mono">node scripts/verify-artifact.js ' + escapeHtml(state.projectId || '<工程名>') + '</span></li>';
  }

  async function runBuild() {
    if (!state.online) { toast('后端未启动：' + START_CMD, 'err'); setStatus($('buildStatus'), '后端未启动', 'err'); return; }
    if (!state.projectId) { toast('先在左侧选择项目', 'warn'); return; }
    if (state.buildCtl) { toast('已有构建在进行', 'warn'); return; }
    logClear($('buildLog'), $('buildLogMeta'));
    state.buildLines = 0;
    setRomRam(null);
    renderArtifacts(null);
    $('btnBuild').disabled = true;
    $('btnCancelBuild').disabled = false;
    setStatus($('buildStatus'), '构建中…', 'run');

    const job = streamPost(API + '/build', { project: state.projectId }, (ev) => {
      state.buildLines++;
      $('buildLogMeta').textContent = state.buildLines + ' 行';
      if (ev.type === 'start') {
        logAppend($('buildLog'), '▶ 构建开始：' + (ev.text || state.projectId), 'ln-sys');
      } else if (ev.type === 'end') {
        if (ev.ok) {
          logAppend($('buildLog'), '✔ 构建成功' + (ev.text ? '：' + ev.text : ''), 'ln-ok');
          setStatus($('buildStatus'), '构建成功', 'ok');
          renderArtifacts(ev.artifact);
          setRomRam(ev.size);
          toast('构建成功', 'ok');
        } else {
          logAppend($('buildLog'), '✘ 构建失败' + (ev.text ? '：' + ev.text : ''), 'ln-err');
          setStatus($('buildStatus'), '构建失败', 'err');
          renderArtifacts(ev.artifact);
          setRomRam(ev.size);
          toast('构建失败，查看日志', 'err');
        }
      } else {
        const text = ev.text !== undefined ? ev.text : ev.line;
        logAppend($('buildLog'), (ev.line !== undefined && ev.text !== undefined ? String(ev.line).padStart(4, ' ') + '  ' : '') + text,
          /error|错误|Error|undefined reference/i.test(String(text)) ? 'ln-err'
            : /warning|警告/i.test(String(text)) ? 'ln-warn' : '');
      }
    });
    state.buildCtl = job;
    try {
      await job.promise;
      if ($('buildStatus').getAttribute('data-tone') === 'run') setStatus($('buildStatus'), '流已结束（未见 end 事件）', 'warn');
    } catch (err) {
      if (err && err.name === 'AbortError') {
        logAppend($('buildLog'), '■ 已中止', 'ln-warn');
        setStatus($('buildStatus'), '已中止', 'warn');
      } else {
        logAppend($('buildLog'), '✘ 请求失败：' + (err && err.message ? err.message : err), 'ln-err');
        setStatus($('buildStatus'), '请求失败', 'err');
        toast('构建请求失败：' + (err && err.message ? err.message : err), 'err');
      }
    } finally {
      state.buildCtl = null;
      $('btnBuild').disabled = false;
      $('btnCancelBuild').disabled = true;
    }
  }

  /* ═══════════ 烧录 ═══════════ */
  async function runFlashStream(path, payload, opts) {
    const logEl = $('flashLog');
    const statusEl = $('flashStatus');
    const btn = opts && opts.button ? $(opts.button) : null;
    if (!state.online) { toast('后端未启动：' + START_CMD, 'err'); setStatus(statusEl, '后端未启动', 'err'); return; }
    if (opts && opts.needHardware && !usableFlashers().length) {
      toast('未检测到 ST-Link，无法执行', 'err');
      setStatus(statusEl, '未检测到 ST-Link', 'err');
      return;
    }
    if (opts && opts.needProject && !state.projectId) { toast('先在左侧选择项目', 'warn'); return; }
    if (state.flashCtl) { toast('已有烧录任务在进行', 'warn'); return; }
    if (btn) btn.disabled = true;
    setStatus(statusEl, (opts && opts.running) || '执行中…', 'run');
    logAppend(logEl, '▶ ' + ((opts && opts.title) || path), 'ln-sys');
    let sawEnd = false;
    const job = streamPost(path, payload, (ev) => {
      state.flashLines++;
      $('flashLogMeta').textContent = state.flashLines + ' 行';
      if (ev.type === 'start') {
        logAppend(logEl, '▶ ' + (ev.text || '开始'), 'ln-dim');
      } else if (ev.type === 'end') {
        sawEnd = true;
        const ok = ev.ok !== false && ev.connected !== false;
        logAppend(logEl, (ok ? '✔ ' : '✘ ') + (ev.text || ev.reason || (ok ? '完成' : '失败')), ok ? 'ln-ok' : 'ln-err');
        setStatus(statusEl, ok ? ((opts && opts.done) || '完成') : ((ev.reason || (opts && opts.fail)) || '失败'), ok ? 'ok' : 'err');
        if (path === API + '/chip-info' && ev.chip) renderChipInfo(ev.chip, ev);
        else if (path === API + '/chip-info') renderChipInfo(null, ev);
      } else {
        const text = ev.text !== undefined ? ev.text : ev.line;
        logAppend(logEl, (ev.line !== undefined && ev.text !== undefined ? String(ev.line).padStart(4, ' ') + '  ' : '') + text,
          /error|fail|错误/i.test(String(text)) ? 'ln-err' : '');
      }
    });
    state.flashCtl = job;
    try {
      await job.promise;
      if (!sawEnd) setStatus(statusEl, '流已结束（未见 end 事件）', 'warn');
    } catch (err) {
      logAppend(logEl, '✘ 请求失败：' + (err && err.message ? err.message : err), 'ln-err');
      setStatus(statusEl, '请求失败', 'err');
      toast('请求失败：' + (err && err.message ? err.message : err), 'err');
    } finally {
      state.flashCtl = null;
      if (btn) btn.disabled = false;
    }
  }

  function renderChipInfo(chip, endEv) {
    const out = $('chipInfoOut');
    if (!chip) {
      out.textContent = endEv && endEv.reason
        ? '未读到芯片信息：' + endEv.reason
        : '未读到芯片信息（end 事件没有 chip 字段）' + (endEv && endEv.text ? '：' + endEv.text : '');
      return;
    }
    const rows = Object.keys(chip).map((k) => k + ' : ' + chip[k]);
    out.textContent = rows.length ? rows.join('\n') : '(空)';
  }

  /* ═══════════ 串口 ═══════════ */
  function fillSerialPorts(ports) {
    const sel = $('serialPort');
    const keep = sel.value;
    const list = Array.isArray(ports) ? ports : [];
    sel.innerHTML = list.length
      ? list.map((p) => '<option value="' + escapeHtml(p.path) + '">' + escapeHtml(p.path) +
          (p.role === 'stlink-vcp' ? '（ST-Link VCP）' : '') +
          (p.description ? ' — ' + escapeHtml(p.description) : '') + '</option>').join('')
      : '<option value="">（未发现串口）</option>';
    if (keep && list.some((p) => p.path === keep)) sel.value = keep;
  }

  function serialLine(kind, text, cls) {
    const el = $('serialLog');
    const parts = [];
    if ($('chkTimestamp').checked) parts.push('<span class="ts">[' + nowStamp() + ']</span> ');
    parts.push('<span class="dir' + (kind === 'TX' ? ' dir-tx' : '') + '">' + kind + '</span> ');
    const span = document.createElement('span');
    span.className = 'ln' + (cls ? ' ' + cls : '');
    span.innerHTML = parts.join('') + escapeHtml(text) + '\n';
    el.appendChild(span);
    while (el.childNodes.length > 2000) el.removeChild(el.firstChild);
    if ($('chkAutoscroll').checked) el.scrollTop = el.scrollHeight;
  }

  function updateSerialStats() {
    $('serialStats').textContent = '收 ' + state.serial.rx + ' B · 发 ' + state.serial.tx + ' B';
  }

  function bytesOfHex(hexStr) {
    const clean = String(hexStr).replace(/0x/gi, '').replace(/[\s,;:]/g, '');
    if (!/^[0-9a-fA-F]*$/.test(clean)) return { ok: false, error: 'HEX 里出现了非十六进制字符' };
    if (clean.length % 2 !== 0) return { ok: false, error: 'HEX 位数必须是偶数（每字节两位）' };
    if (!clean.length) return { ok: false, error: '没有要发送的字节' };
    let bin = '';
    for (let i = 0; i < clean.length; i += 2) bin += String.fromCharCode(parseInt(clean.substr(i, 2), 16));
    return { ok: true, bytes: clean.length / 2, bin, hex: clean.toUpperCase().match(/../g).join(' ') };
  }

  async function serialOpen() {
    if (!state.online) { toast('后端未启动：' + START_CMD, 'err'); return; }
    const port = $('serialPort').value;
    const baud = Number($('serialBaud').value);
    if (!port) { toast('没有可用串口，先刷新端口', 'warn'); return; }
    if (!isFinite(baud) || baud <= 0) { toast('波特率无效', 'err'); return; }
    try {
      const data = await postJSON(API + '/serial/open', { port, baud });
      if (!data || data.ok === false || !data.sessionId) throw new Error((data && data.error) || '后端没有返回 sessionId');
      state.serial.sessionId = data.sessionId;
      state.serial.open = true;
      $('btnSerialOpen').disabled = true;
      $('btnSerialClose').disabled = false;
      $('btnSend').disabled = false;
      $('serialState').textContent = '已打开 ' + port + ' @ ' + baud;
      $('serialState').setAttribute('data-tone', 'ok');
      $('serialStreamState').textContent = '已连接 ' + port;
      $('sendHint').textContent = '已连接 ' + port + ' @ ' + baud + '；HEX 模式按二进制字符串写入 data，并附带 hex 字段。';
      serialLine('SYS', '打开 ' + port + ' @ ' + baud + '（session ' + data.sessionId + '）', 'ln-sys');
      startSerialStream(data.sessionId);
    } catch (err) {
      toast('打开失败：' + err.message, 'err');
      $('serialState').textContent = '打开失败';
      $('serialState').setAttribute('data-tone', 'err');
    }
  }

  function startSerialStream(sessionId) {
    if (state.serial.ctl) state.serial.ctl.abort();
    const job = streamGet(API + '/serial/stream?sessionId=' + encodeURIComponent(sessionId), (ev) => {
      if (ev.type === 'data') {
        const showHex = $('chkHex').checked;
        const text = showHex ? (ev.hex !== undefined && ev.hex !== null ? String(ev.hex) : '(无 hex 字段)')
                             : (ev.text !== undefined && ev.text !== null ? String(ev.text) : '(无 text 字段)');
        const bytes = ev.hex ? String(ev.hex).replace(/[^0-9a-fA-F]/g, '').length / 2 : (ev.text ? ev.text.length : 0);
        state.serial.rx += bytes;
        updateSerialStats();
        serialLine('RX', text.replace(/\n$/, ''), '');
      } else if (ev.type === 'ready') {
        $('serialStreamState').textContent = '已连接' + (ev.text ? '：' + ev.text : '');
      } else if (ev.type === 'ping') {
        /* 心跳，保持连接用，不刷屏 */
      } else if (ev.type === 'error') {
        serialLine('ERR', ev.text || '串口错误', 'ln-err');
      } else if (ev.type === 'closed') {
        serialLine('SYS', '串口流已关闭' + (ev.text ? '：' + ev.text : ''), 'ln-warn');
        serialMarkClosed();
      }
    });
    state.serial.ctl = job;
    job.promise.catch((err) => {
      if (err && err.name === 'AbortError') return;
      serialLine('ERR', '流中断：' + (err && err.message ? err.message : err), 'ln-err');
      serialMarkClosed();
    });
  }

  function serialMarkClosed() {
    state.serial.open = false;
    state.serial.sessionId = null;
    state.serial.ctl = null;
    $('btnSerialOpen').disabled = false;
    $('btnSerialClose').disabled = true;
    $('btnSend').disabled = true;
    $('serialState').textContent = '已关闭';
    $('serialState').setAttribute('data-tone', '');
    $('serialStreamState').textContent = '未连接';
  }

  async function serialClose() {
    const sid = state.serial.sessionId;
    if (state.serial.ctl) { state.serial.ctl.abort(); state.serial.ctl = null; }
    if (!sid) { serialMarkClosed(); return; }
    try {
      await postJSON(API + '/serial/close', { sessionId: sid });
      serialLine('SYS', '已关闭 session ' + sid, 'ln-sys');
    } catch (err) {
      serialLine('ERR', '关闭失败：' + err.message, 'ln-err');
    }
    serialMarkClosed();
  }

  /** 文本 → UTF-8 字节的 HEX 串（后端契约里的 hex 字段） */
  function textToHex(text) {
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
      let c = text.charCodeAt(i);
      if (c < 0x80) bytes.push(c);
      else if (c < 0x800) bytes.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < text.length) {
        const c2 = text.charCodeAt(++i);
        const cp = 0x10000 + ((c - 0xD800) << 10) + (c2 - 0xDC00);
        bytes.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3F), 0x80 | ((cp >> 6) & 0x3F), 0x80 | (cp & 0x3F));
      } else bytes.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
    }
    return bytes.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
  }

  async function serialSend() {
    if (!state.serial.sessionId) { toast('串口未打开', 'warn'); return; }
    const raw = $('serialInput').value;
    if (!raw.length) { toast('发送内容为空', 'warn'); return; }
    let payload, echoText, bytes;
    if ($('chkSendHex').checked) {
      const r = bytesOfHex(raw);
      if (!r.ok) { toast('HEX 发送失败：' + r.error, 'err'); return; }
      payload = { sessionId: state.serial.sessionId, data: r.bin, hex: r.hex.replace(/\s/g, '') };
      echoText = r.hex + '   (' + r.bytes + ' B)';
      bytes = r.bytes;
    } else {
      const text = raw + ($('chkAppendCRLF').checked ? '\r\n' : '');
      payload = { sessionId: state.serial.sessionId, data: text, hex: textToHex(text) };
      echoText = JSON.stringify(text);
      bytes = text.length;
    }
    try {
      const data = await postJSON(API + '/serial/write', payload);
      if (!data || data.ok === false) throw new Error((data && data.error) || '写入失败');
      state.serial.tx += bytes;
      updateSerialStats();
      serialLine('TX', echoText, 'ln-dim');
    } catch (err) {
      toast('发送失败：' + err.message, 'err');
      serialLine('ERR', '发送失败：' + err.message, 'ln-err');
    }
  }

  /* ═══════════ 页签 / 侧栏 / 主题 ═══════════ */
  function activate(view, silent) {
    if (VIEWS.indexOf(view) < 0) view = 'pins';
    for (const id of VIEWS) {
      const tab = $('tab-' + id);
      const panel = $('view-' + id);
      const on = id === view;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      panel.hidden = !on;
    }
    if (!silent && window.location.hash !== '#' + view) window.location.hash = view;
  }

  function bindTabs() {
    const tabs = VIEWS.map((v) => $('tab-' + v));
    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => activate(VIEWS[i]));
      tab.addEventListener('keydown', (ev) => {
        let n = null;
        if (ev.key === 'ArrowRight') n = (i + 1) % tabs.length;
        else if (ev.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
        else if (ev.key === 'Home') n = 0;
        else if (ev.key === 'End') n = tabs.length - 1;
        if (n === null) return;
        ev.preventDefault();
        tabs[n].focus();
        activate(VIEWS[n]);
      });
    });
    window.addEventListener('hashchange', () => {
      const v = window.location.hash.replace(/^#/, '');
      if (VIEWS.indexOf(v) >= 0) activate(v, true);
    });
    const initial = window.location.hash.replace(/^#/, '');
    activate(VIEWS.indexOf(initial) >= 0 ? initial : 'pins', true);
  }

  function bindSidebar() {
    const sidebar = $('sidebar');
    const btn = $('btnSidebar');
    btn.addEventListener('click', () => {
      const open = sidebar.classList.toggle('open');
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && sidebar.classList.contains('open')) {
        sidebar.classList.remove('open');
        btn.setAttribute('aria-expanded', 'false');
        btn.focus();
      }
    });
  }

  function bindTheme() {
    const sel = $('themeSelect');
    let saved = null;
    try { saved = window.localStorage ? window.localStorage.getItem(LS.theme) : null; } catch (e) { saved = null; }
    const apply = (v) => {
      if (v === 'auto') document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', v);
    };
    sel.value = saved || 'auto';
    apply(sel.value);
    sel.addEventListener('change', () => {
      apply(sel.value);
      try { if (window.localStorage) window.localStorage.setItem(LS.theme, sel.value); } catch (e) { /* ignore */ }
    });
  }

  /* ═══════════ 引脚数据 ═══════════ */
  async function loadPins(planner) {
    try {
      const data = await fetchJSON(API + '/pins', null, 5000);
      if (planner.setData(data, 'GET /api/pins')) return true;
      planner.setData(window.STM32Pinout.fallbackData(), '内置兜底表（/api/pins 数据不合法）');
      return false;
    } catch (err) {
      planner.setData(window.STM32Pinout.fallbackData(), '内置兜底表（/api/pins 不可用）');
      return false;
    }
  }

  function restoreAssignments(planner) {
    try {
      const raw = window.localStorage ? window.localStorage.getItem(LS.assign) : null;
      if (!raw) return;
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) {
        planner.setAssignments(arr);
        toast('已恢复上次的 ' + arr.length + ' 项引脚分配', '');
      }
    } catch (e) { /* 忽略坏数据 */ }
  }

  function persistAssignments(list) {
    try { if (window.localStorage) window.localStorage.setItem(LS.assign, JSON.stringify(list)); } catch (e) { /* ignore */ }
  }

  /* ═══════════ 启动 ═══════════ */
  function bindActions() {
    $('btnDetect').addEventListener('click', async () => {
      setStatus($('backendText'), '正在重新探测…');
      const ok = await probe();
      if (planner) loadPins(planner);
      if (ok) loadProjects();
      toast(ok ? '环境探测完成' : '仍然连不上后端（' + START_CMD + '）', ok ? 'ok' : 'err');
    });
    $('btnRefreshProjects').addEventListener('click', loadProjects);
    $('btnNewProject').addEventListener('click', openNewProjectDialog);
    $('npCancel').addEventListener('click', closeNewProjectDialog);
    $('npForm').addEventListener('submit', submitNewProject);
    $('projectList').addEventListener('click', (ev) => {
      const del = ev.target.closest ? ev.target.closest('button[data-del]') : null;
      if (del) { deleteProject(del.getAttribute('data-del')); return; }
      const btn = ev.target.closest ? ev.target.closest('button[data-id]') : null;
      if (btn) { setProject(btn.getAttribute('data-id')); toast('当前项目：' + btn.getAttribute('data-id'), ''); }
    });

    $('btnBuild').addEventListener('click', runBuild);
    $('btnCancelBuild').addEventListener('click', () => { if (state.buildCtl) state.buildCtl.abort(); });
    $('btnClearBuildLog').addEventListener('click', () => logClear($('buildLog'), $('buildLogMeta')));

    $('btnFlash').addEventListener('click', () => runFlashStream(API + '/flash',
      { project: state.projectId, flasher: $('flasherSelect').value || undefined, verify: $('verifyAfterFlash').checked },
      { button: 'btnFlash', needProject: true, needHardware: true, title: '烧录 ' + (state.projectId || ''), running: '烧录中…', done: '烧录完成', fail: '烧录失败' }));
    $('btnReset').addEventListener('click', () => runFlashStream(API + '/reset',
      { flasher: $('flasherSelect').value || undefined },
      { button: 'btnReset', needHardware: true, title: '复位运行', running: '复位中…', done: '已复位', fail: '复位失败' }));
    $('btnChipInfo').addEventListener('click', () => runFlashStream(API + '/chip-info',
      { flasher: $('flasherSelect').value || undefined },
      { button: 'btnChipInfo', needHardware: true, title: '读芯片信息', running: '读取中…', done: '已读取', fail: '读取失败' }));
    $('btnClearFlashLog').addEventListener('click', () => { logClear($('flashLog'), $('flashLogMeta')); state.flashLines = 0; });

    $('btnRefreshPorts').addEventListener('click', async () => {
      if (!state.online) { toast('后端未启动：' + START_CMD, 'err'); return; }
      try {
        const data = await fetchJSON(API + '/env');
        fillSerialPorts(Array.isArray(data.serialPorts) ? data.serialPorts : []);
        toast('串口列表已刷新', 'ok');
      } catch (err) { toast('刷新失败：' + err.message, 'err'); }
    });
    $('btnSerialOpen').addEventListener('click', serialOpen);
    $('btnSerialClose').addEventListener('click', serialClose);
    $('btnSend').addEventListener('click', serialSend);
    $('btnClearSerial').addEventListener('click', () => {
      $('serialLog').textContent = '';
      state.serial.rx = 0; state.serial.tx = 0; updateSerialStats();
    });
    $('chkHex').addEventListener('change', () => {
      serialLine('SYS', $('chkHex').checked ? '显示切换为 16 进制（只影响之后收到的数据）' : '显示切换为文本', 'ln-sys');
    });
    $('serialInput').addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); serialSend(); }
    });
    window.addEventListener('beforeunload', () => {
      if (state.serial.sessionId) {
        try {
          navigator.sendBeacon && navigator.sendBeacon(API + '/serial/close',
            new Blob([JSON.stringify({ sessionId: state.serial.sessionId })], { type: 'application/json' }));
        } catch (e) { /* ignore */ }
      }
    });
  }

  async function boot() {
    bindTabs();
    bindSidebar();
    bindTheme();
    bindActions();

    if (!window.STM32Pinout) {
      toast('pinout.js 未加载：引脚图不可用', 'err');
      return;
    }
    planner = window.STM32Pinout.createPlanner({
      onToast: toast,
      onChange: persistAssignments
    });
    planner.mount();
    restoreAssignments(planner);

    if (window.STM32Calc && window.STM32Calc.mount) window.STM32Calc.mount();

    try {
      const online = await probe();
      if (online) loadProjects();
    } catch (err) {
      toast('环境探测异常：' + (err && err.message ? err.message : err), 'err');
    }
    loadPins(planner);      // 无论后端是否在线都试一次；失败自动落回内置兜底表
    updateSerialStats();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  return { state: state, probe: probe, toast: toast };
})();
