'use strict';
/**
 * mapfile.js —— 解析 armlink --map 的输出，算清楚「到底是谁吃了 Flash」
 *
 * 为什么用 map 而不是猜：
 *   · armlink 加了 --split_sections（Keil 的 OneElfS=1）后，**每个函数独立成段**，
 *     所以 Memory Map 里每一行就是链接后真实留下来的一个函数，带地址、大小、所属对象。
 *   · 未被调用的函数已经被链接器删掉了 —— 这里看到的就是最终固件里的账，不是估算。
 *
 * 输入是 armlink 的原始输出（--map 把内存映射打到 stdout，并不生成文件）。
 */

const RE_LOAD = /^\s*Load Region (\w+) \(Base: (0x[0-9a-fA-F]+), Size: (0x[0-9a-fA-F]+), Max: (0x[0-9a-fA-F]+)/;
/* armlink 的 Execution Region 有两种写法：带 Exec/Load base 的，和只有 Base 的 */
const RE_EXEC_A = /^\s*Execution Region (\w+) \(Exec base: (0x[0-9a-fA-F]+), Load base: (0x[0-9a-fA-F]+), Size: (0x[0-9a-fA-F]+), Max: (0x[0-9a-fA-F]+)/;
const RE_EXEC_B = /^\s*Execution Region (\w+) \(Base: (0x[0-9a-fA-F]+), Size: (0x[0-9a-fA-F]+), Max: (0x[0-9a-fA-F]+)/;
/* 一行段记录： Base Addr   Size   Type  Attr   Idx  [*] Section  Object */
const RE_ROW = /^\s*(0x[0-9a-fA-F]{8})\s+(0x[0-9a-fA-F]{8})\s+(\S+)\s+(\S+)\s+(\d+)\s*(?:\*\s*)?(\S+)\s+(\S+)\s*$/;

/** 库对象形如 c_w.l(__main.o) —— 不属于用户代码 */
const isLibrary = (obj) => /\.l\(/.test(obj) || /\.l$/.test(obj) || /^\.\./.test(obj);

function parseMap(text) {
  const regions = [];
  const rows = [];
  let currentRegion = '';

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.replace(/^\[[a-z]+\]\s?/, ''); // 容错：去掉可能带的 [build] 前缀

    let m = RE_LOAD.exec(line);
    if (m) {
      regions.push({
        name: m[1], load: true, base: parseInt(m[2], 16),
        size: parseInt(m[3], 16), max: parseInt(m[4], 16),
      });
      continue;
    }
    m = RE_EXEC_A.exec(line) || RE_EXEC_B.exec(line);
    if (m) {
      currentRegion = m[1];
      if (m.length >= 6) { // 带 Exec/Load base 的写法
        regions.push({
          name: m[1], load: false, base: parseInt(m[2], 16), loadBase: parseInt(m[3], 16),
          size: parseInt(m[4], 16), max: parseInt(m[5], 16),
        });
      } else {
        regions.push({
          name: m[1], load: false, base: parseInt(m[2], 16),
          size: parseInt(m[3], 16), max: parseInt(m[4], 16),
        });
      }
      continue;
    }
    m = RE_ROW.exec(line);
    if (!m) continue;
    const type = m[3];
    if (type === 'PAD') continue;
    rows.push({
      addr: parseInt(m[1], 16),
      size: parseInt(m[2], 16),
      type,
      attr: m[4],
      section: m[6],
      object: m[7],
      region: currentRegion,
    });
  }

  /* ── 按对象聚合 ── */
  const objMap = new Map();
  const functions = [];

  for (const r of rows) {
    const lib = isLibrary(r.object);
    let o = objMap.get(r.object);
    if (!o) {
      o = { name: r.object, library: lib, code: 0, roData: 0, rwData: 0, ziData: 0, sections: 0 };
      objMap.set(r.object, o);
    }
    o.sections++;
    if (r.type === 'Code') o.code += r.size;
    else if (r.attr === 'ZI' || /^zero$/i.test(r.type)) o.ziData += r.size;
    else if (r.attr === 'RW') o.rwData += r.size;
    else o.roData += r.size;

    /* 函数级：--split_sections 之后每个函数独立成段，段名形如 i.<函数名> */
    if (!lib && /^i\./.test(r.section)) {
      functions.push({ name: r.section.slice(2), object: r.object, size: r.size, addr: r.addr });
    }
  }

  const objects = [...objMap.values()].map((o) => {
    o.flash = o.code + o.roData + o.rwData;
    o.ram = o.rwData + o.ziData;
    return o;
  });
  objects.sort((a, b) => b.flash - a.flash);
  functions.sort((a, b) => b.size - a.size);

  const sum = (list) => list.reduce((a, o) => {
    a.code += o.code; a.roData += o.roData; a.rwData += o.rwData; a.ziData += o.ziData;
    a.flash += o.flash; a.ram += o.ram;
    return a;
  }, { code: 0, roData: 0, rwData: 0, ziData: 0, flash: 0, ram: 0 });

  const libObjects = objects.filter((o) => o.library);
  const userObjects = objects.filter((o) => !o.library);
  // RW/ZI 段在 SRAM，不占 Flash —— 上面按 attr 分过了
  const ramRegions = regions.filter((r) => /IRAM|RAM/i.test(r.name));

  return {
    regions,
    objects,
    userObjects,
    libObjects,
    functions,
    library: sum(libObjects),
    user: sum(userObjects),
    totals: sum(objects),
    ramUsed: ramRegions.reduce((a, r) => a + r.size, 0),
    ramMax: ramRegions.reduce((a, r) => a + r.max, 0),
    sectionCount: rows.length,
  };
}

/** 对象名 → 源文件（keil-build 里对象名是 <Group>_<basename>.o 的扁平形式） */
function labelObject(objName, model) {
  if (!model || !Array.isArray(model.sources)) return objName;
  const base = objName.replace(/\.o$/i, '').toLowerCase();
  for (const s of model.sources) {
    const flat = String(s.raw).replace(/^\.?[\\/]+/, '').replace(/[\\/]+/g, '_').replace(/\.\._/g, '').replace(/\.[^.]+$/, '');
    if (flat.toLowerCase() === base) return s.raw;
  }
  return objName;
}

module.exports = { parseMap, labelObject, isLibrary };
