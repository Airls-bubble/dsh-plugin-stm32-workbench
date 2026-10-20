'use strict';
/**
 * features.js —— 单片机的「功能契约」
 *
 * 目的：**用户读的是人话，不是 C 代码。**
 * 每次改完代码，模型必须把「这块板子现在能干什么」写成**结构化**的自然语言；
 * 这份描述显示在插件面板上，用户直接改它，再发回给模型改成对应的代码。
 *
 * 位置：`<工程目录>/.dsh-mcu/features.json`
 *   —— 跟工程走。换工作区就换一整套描述；工程拷到别的机器，描述跟着走。
 *   —— 插件本体仍然只装代码，运行期一个字都不往自己目录写（见 paths.js 的原则①）。
 *
 * 为什么是**结构化**而不是一段散文（2026-10-15 用户要求）：
 *   散文会写成「本模块主要负责……同时对……进行管理」，读的人拿不到任何可核对的事实。
 *   固定字段逼着写的人回答具体问题：什么时候发生？看到什么？哪个引脚？什么数值？有什么限制？
 *   字段填不出来就空着 —— 空着是信息，废话不是。
 *
 * 这一层是**契约**，不是注释：用户可以改它，改完就是需求。
 * 所以写文件很保守 —— 每次都留历史版本，restore 永远能回去。
 */
const fs = require('fs');
const path = require('path');
const paths = require('./paths');

/** 功能状态：给用户看的四个词，别再多（多一个用户就要多想一次） */
const STATUSES = ['done', 'partial', 'todo', 'broken'];
const STATUS_ZH = {
  done: '已实现',
  partial: '部分实现',
  todo: '还没做',
  broken: '有问题',
};

/** 列表型字段：一行一条，不写成段落 */
const LIST_FIELDS = ['behavior', 'hardware', 'params', 'limits', 'files'];

/** 字段的中文名（界面、生成给模型的话、Markdown 共用一份） */
const FIELD_ZH = {
  name: '名称',
  status: '状态',
  summary: '一句话',
  trigger: '何时发生',
  behavior: '现象',
  hardware: '引脚与外设',
  params: '关键数值',
  limits: '限制与注意',
  files: '涉及文件',
};

/** 字段顺序 = 界面顺序 = 模型写 JSON 时的建议顺序 */
const FIELD_ORDER = ['summary', 'trigger', 'behavior', 'hardware', 'params', 'limits', 'files'];

/** 各字段长度上限 —— 挡住异常大的输入把面板和上下文撑爆 */
const LIMITS = {
  modules: 200,
  name: 120,
  summary: 100,
  trigger: 240,
  item: 120,
  listLen: 16,
  files: 50,
  fileLen: 400,
  id: 64,
};

/**
 * 写这份描述必须守的行文规矩。
 *
 * 这不是文风洁癖 —— 用户的原话是「AI 的描述有很多废话，我想要结构化的描述」。
 * 废话在这里有具体形状：复述实现、写「主要用于」、把一件事摊成一段。
 * 所以规则写成可判定的短句，并且被三处复用（生成说明、模型 Markdown、测试）。
 */
const STYLE_RULES = [
  '**一行一件事，短句优先。** 每条不超过 40 字，超过就该拆成两条。',
  '**只写能被观察到的。** 「屏幕第二行显示 12.3%」可以；「用 DWT 计数器统计占用率」不行（那是实现，不是现象）。',
  '**禁止空话。** 不许出现「该模块主要用于」「通过调用……实现」「负责管理并维护」这类句子，'
    + '也不要说「重要」「核心」「完善」—— 这些词不提供任何信息。',
  '**正文里不写函数名、不贴代码、不写文件路径** —— 文件有专门的字段。',
  '**想不到就留空。** 某个字段没内容就给空数组或空字符串，**不要为了凑格式编内容**。',
];

/** 源码扩展名（判断「代码比描述新」用） */
const SRC_EXT = ['.c', '.h', '.s', '.cpp', '.hpp', '.cc'];
/** 这些目录里的东西不是「用户写的代码」：构建产物、Keil 中间件、版本库 */
const SKIP_DIRS = [
  '.dsh-mcu', '.git', '.svn', 'objects', 'listings', 'debugconfig',
  'rte', 'node_modules', '.vscode', '.idea', 'backup', '__pycache__',
];

/* ────────────────────────── 路径 ────────────────────────── */

function featuresPath(projectDir) {
  return path.join(paths.projectRoot(projectDir), 'features.json');
}

function historyDir(projectDir) {
  return paths.ensureDir(path.join(paths.projectRoot(projectDir), 'features-history'));
}

/* ────────────────────────── 规范化 ────────────────────────── */

function clampText(v, max) {
  const s = String(v == null ? '' : v);
  return s.length > max ? s.slice(0, max) : s;
}

/** 列表字段：收数组，也收「换行/顿号/分号分隔的字符串」（面板和模型都可能这么给） */
function toList(v, maxItems, maxItem) {
  let arr;
  if (Array.isArray(v)) arr = v;
  else if (typeof v === 'string') arr = v.split(/\r?\n|[、;；]/);
  else if (v == null) arr = [];
  else arr = [v];
  const out = [];
  for (const x of arr) {
    const s = clampText(x, maxItem).replace(/\s+$/, '').trim();
    if (!s) continue;
    // 面板里用户可能写成 "- xxx" / "· xxx"，剥掉前缀
    out.push(s.replace(/^[-*·•]\s*/, ''));
    if (out.length >= maxItems) break;
  }
  return out;
}

/** id 只留字母数字下划线连字符与中文；空的话交给调用方补 */
function normId(v) {
  const s = String(v == null ? '' : v).trim().replace(/[^0-9A-Za-z_\u4e00-\u9fa5-]/g, '-');
  return s.slice(0, LIMITS.id);
}

/**
 * 从任意输入里把模块数组掏出来。
 *
 * 为什么要掏两层：模型的 `content` 常常直接给整个 `{"modules":[…]}`，
 * 而 POST 的 body 又是 `{modules: <那个对象>}` —— 于是变成 `{modules:{modules:[…]}}`。
 * 实测踩到：工具报「已保存：0 个模块」，面板一片空白。
 * 与其在两条路上各修一次，不如在唯一的入口处认下来。
 */
function pickList(input) {
  if (Array.isArray(input)) return input;
  if (input && typeof input === 'object') {
    if (Array.isArray(input.modules)) return input.modules;
    if (input.modules && typeof input.modules === 'object' && Array.isArray(input.modules.modules)) {
      return input.modules.modules;
    }
  }
  return [];
}

/**
 * 把任意外来输入（模型的 JSON、面板的草稿、磁盘上的旧文件）整成规范形状。
 * 宽容读、严格写：缺字段补默认值，多了的丢掉，绝不因为一个坏字段整体失败。
 *
 * **旧格式无损迁移**：2026-10-15 之前的模块只有一个散文 `detail`。
 * 直接丢掉用户就白写了 —— 所以把它的每一行搬进 `behavior`。
 *
 * @param {unknown} input
 * @returns {{version:number, modules:Array}}
 */
function normalize(input) {
  const list = pickList(input && typeof input === 'object' ? input : {});
  const used = new Set();
  const modules = [];
  list.slice(0, LIMITS.modules).forEach((m, i) => {
    if (!m || typeof m !== 'object') return;
    let id = normId(m.id);
    if (!id || used.has(id)) {
      // 没有 id 或撞车：用序号兜底，不用随机数 —— 随机 id 每次写都变，
      // 面板会以为每个模块都被改过
      let n = i + 1;
      while (used.has('m' + n)) n += 1;
      id = 'm' + n;
    }
    used.add(id);

    const status = STATUSES.indexOf(String(m.status)) >= 0 ? String(m.status) : 'done';
    const name = clampText(m.name, LIMITS.name).trim();
    const mod = {
      id,
      name: name || ('未命名功能 ' + id),
      status,
      summary: clampText(m.summary, LIMITS.summary).replace(/\s+/g, ' ').trim(),
      trigger: clampText(m.trigger, LIMITS.trigger).replace(/\s+/g, ' ').trim(),
      behavior: toList(m.behavior, LIMITS.listLen, LIMITS.item),
      hardware: toList(m.hardware, LIMITS.listLen, LIMITS.item),
      params: toList(m.params, LIMITS.listLen, LIMITS.item),
      limits: toList(m.limits, LIMITS.listLen, LIMITS.item),
      files: toList(m.files, LIMITS.files, LIMITS.fileLen),
    };

    // 旧格式（散文 detail）→ 行为列表，别丢字
    if (!mod.behavior.length && typeof m.detail === 'string' && m.detail.trim()) {
      mod.behavior = toList(m.detail, LIMITS.listLen, LIMITS.item);
    }
    modules.push(mod);
  });
  return { version: 1, modules };
}

/* ────────────────────────── 读 ────────────────────────── */

/**
 * 读工程的功能描述。
 * 文件不存在 → has:false，不是错误（第一次用本来就该是空的）。
 * 文件坏了 → broken:true，**不删也不覆盖**，让用户自己决定。
 */
function read(projectDir) {
  const file = featuresPath(projectDir);
  if (!fs.existsSync(file)) {
    return { has: false, broken: false, path: file, spec: { version: 1, modules: [] } };
  }
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    return { has: true, broken: true, path: file, error: '读不出来：' + String(err.message || err),
      spec: { version: 1, modules: [] } };
  }
  let json;
  try {
    json = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (err) {
    return { has: true, broken: true, path: file, error: 'JSON 坏了：' + String(err.message || err),
      spec: { version: 1, modules: [] } };
  }
  const norm = normalize(json);
  return {
    has: true,
    broken: false,
    path: file,
    spec: {
      version: 1,
      revision: Number(json.revision) || 0,
      updatedAt: typeof json.updatedAt === 'string' ? json.updatedAt : null,
      updatedBy: typeof json.updatedBy === 'string' ? json.updatedBy : null,
      project: typeof json.project === 'string' ? json.project : null,
      modules: norm.modules,
    },
  };
}

/* ────────────────────────── 写 ────────────────────────── */

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function atomicWrite(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 增量补丁：只给改动/新增的模块（`updates`）和要删的 id（`remove`），不必每次全量重写。
 *
 * 为什么要它（2026-10-19）：全量重写一次 8~10 个模块的 JSON，是几百到上千 token 的**输出**；
 * 而日常改动往往只动一两句参数/状态。增量把每轮输出压到最小，也不再逼模型复述没变的部分。
 *
 * 语义：`updates` = upsert（有就只合并给出的字段，没有就新增，新增至少要 name 或 summary）；
 *       `remove`  = 按 id 删除。
 */
function applyPatch(baseModules, patch) {
  const byId = new Map();
  (baseModules || []).forEach((m) => {
    const n = normalize({ modules: [m] }).modules[0];
    if (n) byId.set(n.id, n);
  });
  (patch.updates || []).forEach((u) => {
    const id = normId(u && u.id);
    if (!id) throw new Error('updates 里每一项都要有 id');
    const old = byId.get(id);
    if (!old && !(u.name || u.summary)) {
      throw new Error('updates 里的新模块 "' + id + '" 至少要有 name 或 summary');
    }
    byId.set(id, Object.assign({}, old || {}, u, { id }));
  });
  (patch.remove || []).forEach((id) => {
    const key = normId(id);
    if (!key) throw new Error('remove 里要写模块 id');
    byId.delete(key);
  });
  return Array.from(byId.values());
}

/**
 * 保存功能描述。
 * 旧内容进 features-history/（保留最近 20 份），所以「改错了」永远能退回去。
 *
 * @param {string} projectDir
 * @param {unknown} input 全量：modules 数组或 {modules:[...]}；增量：{updates:[...], remove:[...]}
 * @param {{by?:string, project?:string}} opts
 */
function write(projectDir, input, opts) {
  const o = opts || {};
  const before = read(projectDir);
  /* 增量补丁先合并到当前清单上，再走原来的全量校验/落盘路径 —— 两条路最终一份真相 */
  const payload = (input && !Array.isArray(input.modules) && (input.updates || input.remove))
    ? { modules: applyPatch(before.spec.modules, input) }
    : input;
  const norm = normalize(payload);
  const file = featuresPath(projectDir);

  // 内容没变就别写：避免「点一次保存就多一份历史、revision 还 +1」
  const same = before.has && JSON.stringify(before.spec.modules) === JSON.stringify(norm.modules);
  if (same) {
    return { ok: true, changed: false, revision: before.spec.revision, spec: before.spec, path: file };
  }

  if (before.has && !before.broken) {
    try {
      /* **存原文件的字节，不存归一化后的对象**（2026-10-15 修）。
         归一化会丢掉不认识的字段、也会抹平「字符串 vs 数组」这类写法差异 ——
         历史是给用户回退用的，必须和当时磁盘上那份一模一样，不能失真。
         实测踩到：某次看历史版本时发现列表被按顿号拆成了一地碎片，
         而那不是当时磁盘上的样子，只是归一化的投影。 */
      fs.copyFileSync(file, path.join(historyDir(projectDir),
        stamp() + '-r' + (before.spec.revision || 0) + '.json'));
    } catch (_) { /* 历史存不下不该挡住保存 */ }
  }
  pruneHistory(projectDir, 20);

  const revision = (before.spec.revision || 0) + 1;
  const spec = {
    version: 1,
    revision,
    updatedAt: new Date().toISOString(),
    updatedBy: o.by || 'ai',
    project: o.project || before.spec.project || path.basename(projectDir),
    modules: norm.modules,
  };
  atomicWrite(file, JSON.stringify(spec, null, 2));
  return { ok: true, changed: true, revision, spec, path: file };
}

function listHistory(projectDir) {
  const dir = historyDir(projectDir);
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch (_) { return []; }
  return names.sort().reverse().slice(0, 20).map((n) => {
    const full = path.join(dir, n);
    let st = null;
    try { st = fs.statSync(full); } catch (_) { /* 读不到就只给名字 */ }
    let count = null;
    try { count = normalize(JSON.parse(fs.readFileSync(full, 'utf8'))).modules.length; } catch (_) { /* 坏档 */ }
    return {
      stamp: n.replace(/\.json$/, ''),
      file: full,
      at: st ? st.mtime.toISOString() : null,
      bytes: st ? st.size : null,
      modules: count,
    };
  });
}

function pruneHistory(projectDir, keep) {
  try {
    const dir = historyDir(projectDir);
    const names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
    while (names.length > keep) {
      const victim = names.shift();
      try { fs.unlinkSync(path.join(dir, victim)); } catch (_) { /* 删不掉就算了 */ }
    }
  } catch (_) { /* 历史是附加价值，失败不影响主流程 */ }
}

/**
 * 回到某个历史版本。restore 本身也会把「当前版本」存进历史，
 * 所以「撤销撤销」也是通的。
 */
function restore(projectDir, histStamp, opts) {
  const dir = historyDir(projectDir);
  const name = String(histStamp || '').replace(/\.json$/, '');
  if (!/^[0-9A-Za-z-]+$/.test(name)) throw new Error('历史版本名不合法：' + JSON.stringify(histStamp));
  const file = path.join(dir, name + '.json');
  if (!fs.existsSync(file)) throw new Error('找不到历史版本：' + name);
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  return write(projectDir, json, Object.assign({ by: 'restore' }, opts));
}

/* ────────────────────────── 过期判定 ────────────────────────── */

/** 工程里用户写的源码文件（绝对路径），跳过构建产物目录 */
function listSources(projectDir, cap) {
  const out = [];
  const max = cap || 3000;
  const walk = (dir, depth) => {
    if (out.length >= max || depth > 8) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (out.length >= max) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.indexOf(e.name.toLowerCase()) >= 0) continue;
        walk(full, depth + 1);
      } else if (SRC_EXT.indexOf(path.extname(e.name).toLowerCase()) >= 0) {
        out.push(full);
      }
    }
  };
  walk(projectDir, 0);
  return out;
}

/**
 * 这份描述跟代码对得上吗？
 *   missing —— 一个字都没写过
 *   stale   —— 描述写完之后，又有源码被改过（说明改代码的人忘了更新描述）
 *   ok      —— 描述比所有源码都新
 *
 * 这条判断是整套机制的**牙齿**：模型忘了写描述，用户一眼就能看见，
 * 而不是等改出问题才发现描述是旧的。
 */
function staleness(projectDir, spec) {
  const files = listSources(projectDir);
  let newest = 0;
  let newestFile = null;
  const specAt = spec && spec.updatedAt ? Date.parse(spec.updatedAt) : 0;
  let changed = 0;
  for (const f of files) {
    let st;
    try { st = fs.statSync(f); } catch (_) { continue; }
    const t = st.mtimeMs;
    if (t > newest) { newest = t; newestFile = f; }
    if (specAt && t > specAt + 1000) changed += 1;   // +1s 容差：写文件和存描述可能同一秒
  }
  const hasSpec = !!(spec && Array.isArray(spec.modules) && spec.modules.length);
  const rel = newestFile ? path.relative(projectDir, newestFile) : null;
  let state = 'ok';
  if (!hasSpec) state = 'missing';
  else if (!specAt || changed > 0) state = 'stale';
  return {
    state,
    changedFiles: changed,
    sourceCount: files.length,
    codeAt: newest ? new Date(newest).toISOString() : null,
    newestFile: rel,
    specAt: specAt ? new Date(specAt).toISOString() : null,
  };
}

/* ────────────────────────── 给模型看的文本 ────────────────────────── */

function bullets(items, indent) {
  const pad = indent || '';
  return items.map((x) => pad + '- ' + x).join('\n');
}

/**
 * 把功能描述渲染成 Markdown。
 * 模型读这份比读 JSON 省事，也**更像人话** —— 它接下来要做的正是用自然语言工作。
 * 小节的顺序和名字与面板上的字段一一对应，模型和用户看到的是同一套结构。
 */
function toMarkdown(spec, meta) {
  const m = meta || {};
  const head = ['# 当前单片机功能描述'];
  if (m.project) head.push('工程：' + m.project);
  if (spec.updatedAt) {
    head.push('更新：' + spec.updatedAt + '（' + (spec.updatedBy || '?') + '，r' + (spec.revision || 0) + '）');
  }
  const st = m.stale || null;
  if (st && st.state === 'missing') {
    head.push('⚠ 状态：还没有任何功能描述。请调用 mcu action=spec 写一份（content 给 JSON）。');
  } else if (st && st.state === 'stale') {
    head.push('⚠ 状态：**已过期** —— 描述写完之后又有 ' + st.changedFiles + ' 个源文件被改过' +
      (st.newestFile ? '（最近：' + st.newestFile + '，' + st.codeAt + '）' : '') +
      '。请立刻调用 mcu action=spec 重写。');
  } else if (st) {
    head.push('状态：与代码同步（工程内 ' + st.sourceCount + ' 个源文件，无人在描述之后改过代码）。');
  }

  const body = [];
  if (!spec.modules || !spec.modules.length) {
    body.push('（空 —— 还没有写过功能描述）');
  } else {
    spec.modules.forEach((mod, i) => {
      body.push('## ' + (i + 1) + '. ' + mod.name + '　[' + (STATUS_ZH[mod.status] || mod.status) + ']');
      body.push('id：`' + mod.id + '`');
      if (mod.summary) body.push('- **一句话**：' + mod.summary);
      if (mod.trigger) body.push('- **何时发生**：' + mod.trigger);
      LIST_FIELDS.forEach((f) => {
        const items = mod[f] || [];
        if (!items.length) return;
        if (f === 'files') {
          body.push('- **涉及文件**：' + items.join('、'));
        } else {
          body.push('- **' + FIELD_ZH[f] + '**：');
          body.push(bullets(items, '  '));
        }
      });
      body.push('');
    });
  }
  return head.join('\n') + '\n\n' + body.join('\n');
}

/**
 * 面板/工具用的短名单（不带正文，省流量）。
 *
 * 计数刻意用 `nXxx` 命名而不是直接叫 `behavior`：工具把这份清单交给模型看，
 * 如果字段名和正文列表同名却是个数字，模型很容易以为「behavior 要填个数」。
 */
function toOutline(spec) {
  return (spec.modules || []).map((m) => ({
    id: m.id, name: m.name, status: m.status, summary: m.summary,
    nBehavior: (m.behavior || []).length,
    nHardware: (m.hardware || []).length,
    nParams: (m.params || []).length,
    nLimits: (m.limits || []).length,
    nFiles: (m.files || []).length,
  }));
}

/* ────────────────────────── 差异 → 发回给模型的话 ────────────────────────── */

function sameList(a, b) {
  return JSON.stringify(a || []) === JSON.stringify(b || []);
}

function fieldDiff(a, b) {
  const out = [];
  if ((a.name || '') !== (b.name || '')) out.push('name');
  if ((a.status || '') !== (b.status || '')) out.push('status');
  if ((a.summary || '') !== (b.summary || '')) out.push('summary');
  if ((a.trigger || '') !== (b.trigger || '')) out.push('trigger');
  LIST_FIELDS.forEach((f) => { if (!sameList(a[f], b[f])) out.push(f); });
  return out;
}

/**
 * 用户改完描述后，跟服务器上的版本比一比，看动了哪些模块。
 * @returns {{changed:Array, added:Array, removed:Array}}
 */
function diffModules(before, after) {
  const b = normalize(before).modules;
  const a = normalize(after).modules;
  const bm = new Map(b.map((m) => [m.id, m]));
  const am = new Map(a.map((m) => [m.id, m]));
  const changed = [];
  const added = [];
  const removed = [];
  a.forEach((m) => {
    const old = bm.get(m.id);
    if (!old) { added.push(m); return; }
    const fields = fieldDiff(old, m);
    if (fields.length) changed.push({ before: old, after: m, fields });
  });
  b.forEach((m) => { if (!am.has(m.id)) removed.push(m); });
  return { changed, added, removed };
}

/** 把一个模块渲染成「字段: 内容」的短块（差值消息里的最小单元） */
function moduleBlock(m, indent) {
  const pad = indent || '  ';
  const lines = [];
  if (m.summary) lines.push(pad + '一句话：' + m.summary);
  if (m.trigger) lines.push(pad + '何时发生：' + m.trigger);
  LIST_FIELDS.forEach((f) => {
    const items = m[f] || [];
    if (!items.length) return;
    if (f === 'files') { lines.push(pad + '涉及文件：' + items.join('、')); return; }
    lines.push(pad + FIELD_ZH[f] + '：');
    items.forEach((x) => lines.push(pad + '  · ' + x));
  });
  if (m.status) lines.push(pad + '状态：' + (STATUS_ZH[m.status] || m.status));
  return lines.join('\n');
}

/**
 * 把「用户改过的描述」变成一条发给模型的话。
 *
 * 这是整个功能的回程：面板 → 自然语言 → 会话。
 * 措辞上刻意**不要求模型输出代码**，而是要求它输出「改了什么」——
 * 因为用户看的就是自然语言，代码只是手段。
 */
function buildMessage(before, after, opts) {
  const o = opts || {};
  const d = diffModules(before, after);
  const lines = [];
  lines.push('【单片机功能描述修订】');
  lines.push('');
  lines.push('我在「单片机工作台 → 功能清单」里改了功能描述。请**按下面的描述修改工程代码**，');
  lines.push('改完后调用 mcu 工具（action=spec）把功能描述重新写一遍，保持和代码完全一致。');
  if (o.project) { lines.push(''); lines.push('工程：' + o.project); }
  lines.push('');

  if (d.changed.length) {
    lines.push('──────── 修改的功能（' + d.changed.length + ' 项）────────');
    lines.push('');
    d.changed.forEach((c) => {
      lines.push('■ ' + (c.after.name || c.before.name) + '（模块 id：' + c.after.id + '）—— 改了：' +
        c.fields.map((f) => FIELD_ZH[f] || f).join('、'));
      // 只贴真正动过的字段：没动的字段贴出来只会稀释重点
      const blocks = [];
      if (c.fields.indexOf('name') >= 0) {
        blocks.push('  【原名称】' + c.before.name + '\n  【改为】' + c.after.name);
      }
      if (c.fields.indexOf('status') >= 0) {
        blocks.push('  【原状态】' + (STATUS_ZH[c.before.status] || c.before.status) +
          ' → 【改为】' + (STATUS_ZH[c.after.status] || c.after.status));
      }
      ['summary', 'trigger'].forEach((f) => {
        if (c.fields.indexOf(f) < 0) return;
        blocks.push('  【原' + FIELD_ZH[f] + '】' + (c.before[f] || '（空）'));
        blocks.push('  【改为】' + (c.after[f] || '（空）'));
      });
      LIST_FIELDS.forEach((f) => {
        if (c.fields.indexOf(f) < 0) return;
        const A = c.before[f] || [];
        const B = c.after[f] || [];
        if (f === 'files') {
          blocks.push('  【原涉及文件】' + (A.join('、') || '（空）'));
          blocks.push('  【改为】' + (B.join('、') || '（空）'));
          return;
        }
        blocks.push('  【原' + FIELD_ZH[f] + '】\n' + (A.length ? bullets(A, '    ') : '    （空）'));
        blocks.push('  【改为】\n' + (B.length ? bullets(B, '    ') : '    （空）'));
      });
      lines.push(blocks.join('\n'));
      lines.push('');
    });
  }

  const showNew = (m) => {
    lines.push('■ ' + m.name + '（模块 id：' + m.id + '）');
    lines.push(moduleBlock(m));
  };

  if (d.added.length) {
    lines.push('──────── 新增的功能（' + d.added.length + ' 项）────────');
    lines.push('');
    d.added.forEach((m) => { showNew(m); lines.push(''); });
  }
  if (d.removed.length) {
    lines.push('──────── 删除的功能（' + d.removed.length + ' 项）────────');
    lines.push('');
    d.removed.forEach((m) => { showNew(m); lines.push(''); });
    lines.push('（这些功能不要再维护。代码里若还有实现，按你的判断处理，但要在回复里说明。）');
    lines.push('');
  }

  if (o.note) {
    lines.push('──────── 我的补充说明 ────────');
    lines.push('');
    lines.push(String(o.note).trim());
    lines.push('');
  }

  lines.push('──────── 要求 ────────');
  lines.push('');
  lines.push('1. 以上面的描述为**最终需求**，不要按你自己的理解改需求。');
  lines.push('2. 只改与这些描述相关的代码，别顺手重构无关模块。');
  lines.push('3. 改完必须编译通过（mcu action=build）；烧录前先问我。');
  lines.push('4. 最后调用 mcu action=spec，把**整份**功能清单更新成与代码一致的版本（包括你没改的模块）。');
  lines.push('5. 回复里说清「改了哪几个功能、改成什么样」——短句，不要贴代码，不要写空话。');
  return lines.join('\n');
}

/** 重写描述时必须守的行文规矩（describe / refresh / 工具描述共用一份措辞） */
function styleRulesBlock() {
  return ['──────── 行文规矩（用户明确要求过：不要废话）────────', '']
    .concat(STYLE_RULES.map((s, i) => (i + 1) + '. ' + s)).join('\n');
}

/** 模块 JSON 的形状说明（三处复用同一份，避免说一套做一套） */
function schemaBlock() {
  return [
    'mcu action=spec，content 给这样的 JSON（注释只是说明，实际 JSON 里不要写注释）：',
    '',
    '{"modules":[',
    '  {"id":"pages",',
    '   "name":"五页仪表盘与翻页",',
    '   "status":"done",',
    '   "summary":"屏幕 5 页，5 秒自动翻页，也可按键翻页",',
    '   "trigger":"上电即开始；停满 5 秒自动翻页；按下 PB1/PB11 立即翻页",',
    '   "behavior":["屏幕第 1 行显示 P1/5 OVERVIEW",',
    '               "每页停留 5 秒后自动换到下一页，第 5 页之后回到第 1 页"],',
    '   "hardware":["PB8 — OLED SCL（软件 I2C）",',
    '               "PB9 — OLED SDA（软件 I2C）"],',
    '   "params":["自动翻页间隔 5 秒","趋势图 16 列 = 最近 16 秒"],',
    '   "limits":["趋势图最左边一列是最新的一秒，方向容易看反"],',
    '   "files":[".\\\\User\\\\UI.c"]}]}',
    '',
    '字段含义：id 稳定短标识 · status ∈ done/partial/todo/broken · summary 一句话(≤40 字) ·',
    'trigger 何时发生 · behavior 能看到什么(一行一条) · hardware 引脚与外设(一行一条) ·',
    'params 关键数值带单位(一行一条) · limits 限制与注意(一行一条) · files 工程内相对路径。',
  ].join('\n');
}

/**
 * 还没有功能描述时，让模型**先读代码再写一份**。
 * 用词刻意按住「别把文件当模块」：模型最容易犯的错就是照着目录树写一遍文件说明，
 * 那样用户还是得读代码才能知道板子会干什么。
 */
function buildDescribeMessage(project) {
  const lines = [];
  lines.push('【请生成单片机功能描述】');
  lines.push('');
  lines.push('这个工程还没有功能描述。请通读源码，然后用**自然语言、按功能模块**写清楚');
  lines.push('「这块板子现在到底能干什么」，再用 mcu 工具（action=spec）保存。');
  if (project) { lines.push(''); lines.push('工程：' + project); }
  lines.push('');
  lines.push('──────── 结构要求 ────────');
  lines.push('');
  lines.push('每个模块固定这几个字段，**一项一项填，填不出来就留空**：');
  lines.push('');
  lines.push('| 字段 | 写什么 |');
  lines.push('| --- | --- |');
  lines.push('| name | 功能名（「OLED 显示」），不是文件名（「OLED.c」） |');
  lines.push('| status | done 已实现 / partial 部分实现 / todo 还没做 / broken 有问题 |');
  lines.push('| summary | 一句话说清这个功能干什么，≤40 字 |');
  lines.push('| trigger | 什么时候发生：上电时 / 每 1 秒 / 按下 PB1 时 / 串口收到数据时 |');
  lines.push('| behavior | 能看到什么（一行一条）：屏幕显示什么、灯怎么变、串口吐什么 |');
  lines.push('| hardware | 涉及哪些引脚和外设（一行一条），如「PB1 — 按键 K1，上拉输入，按下为低」 |');
  lines.push('| params | 关键数值（一行一条），**带单位**，如「自动翻页 5 s」「消抖 30 ms」 |');
  lines.push('| limits | 限制与已知问题（一行一条）：什么情况下会失效、哪里是半成品 |');
  lines.push('| files | 真正承载这个功能的文件，工程内相对路径 |');
  lines.push('');
  lines.push('规矩：');
  lines.push('1. **按功能分模块，不要按文件分**。用户不该靠读代码才知道板子会干什么。');
  lines.push('2. 详细内容全部写进上面那几个列表字段里，**不要另外写一段散文**。');
  lines.push('3. 发现代码里有 bug、死代码或半成品，就在那个模块上标 broken/partial 并写清现象。');
  lines.push('4. **状态要如实**：没接的东西标 todo，跑了但没验证的别写成「正常」。');
  lines.push('');
  lines.push(styleRulesBlock());
  lines.push('');
  lines.push(schemaBlock());
  return lines.join('\n');
}

/**
 * 描述过期、但用户没手动改描述时的说法：请对照代码**重写整份**。
 * 和 buildMessage 分开是因为语义不同 —— 那个是「照我说的改代码」，
 * 这个是「你改完代码忘了回写描述，现在补上」。
 */
function buildRefreshMessage(project, stale, spec) {
  const lines = [];
  lines.push('【请对照代码刷新功能描述】');
  lines.push('');
  lines.push('工作台里的功能描述已经和代码对不上了：描述写完之后又有 ' +
    ((stale && stale.changedFiles) || 0) + ' 个源文件被改过' +
    (stale && stale.newestFile ? '（最近改动：' + stale.newestFile + '，' + stale.codeAt + '）' : '') + '。');
  lines.push('请重新读一遍相关代码，然后用 mcu 工具（action=spec）**重写整份功能描述**。');
  if (project) { lines.push(''); lines.push('工程：' + project); }
  lines.push('');
  lines.push('──────── 要求 ────────');
  lines.push('');
  lines.push('1. 以**代码的实际行为**为准重写，不要照抄旧描述 —— 旧描述正是过期的那个。');
  lines.push('2. 按功能模块写，不按文件写；模块 id 尽量沿用旧的那套，这样用户能看出哪个功能变了。');
  if (spec && spec.modules && spec.modules.length) {
    lines.push('   旧的模块 id：' + spec.modules.map((m) => m.id).join('、'));
  }
  lines.push('3. 字段一个不落地填：summary / trigger / behavior / hardware / params / limits / files。');
  lines.push('4. 只调 spec，不要顺手改代码 —— 这次是同步描述，不是改需求。');
  lines.push('5. 最后用短句说一句「哪个功能变了」，不贴代码。');
  lines.push('');
  lines.push(styleRulesBlock());
  lines.push('');
  lines.push(schemaBlock());
  return lines.join('\n');
}

module.exports = {
  STATUSES, STATUS_ZH, LIMITS, LIST_FIELDS, FIELD_ZH, FIELD_ORDER, STYLE_RULES,
  featuresPath, historyDir,
  normalize, read, write, restore, listHistory, applyPatch,
  listSources, staleness,
  toMarkdown, toOutline,
  diffModules, buildMessage, buildDescribeMessage, buildRefreshMessage,
  schemaBlock, styleRulesBlock,
};
