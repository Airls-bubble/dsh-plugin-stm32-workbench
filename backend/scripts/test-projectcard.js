'use strict';
/**
 * test-projectcard.js —— 工程卡（.dsh-mcu/project.json）的模块级验证
 *
 * 为什么要有它：卡是「AI 换工程时唯一该读的事实层」，猜错引脚/串口的代价比没有卡更大。
 * 这里逐条验证：
 *   · 没卡时 read 不报错、validate 能预览 import 草案；
 *   · import 只填 .uvprojx 里真有的字段（引脚表必须留空 —— 不猜）；
 *   · write 是深合并（只发改动字段）、数组整体替换、null 删字段；
 *   · 引脚冲突/保留脚冲突能被拦成 error；
 *   · ESP-IDF / PlatformIO 目录靠证据文件识别，认不出就如实报错。
 *
 * 全程在临时目录里跑，**不碰任何真实工程**（只读一份 .uvprojx 当输入）。
 * 用法：node backend/scripts/test-projectcard.js
 * 退出码：0 通过 / 1 断言失败 / 2 前提缺失（找不到可当输入的 .uvprojx）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const paths = require('../server/paths');
const card = require('../server/projectcard');
const uvprojx = require('../server/uvprojx');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); return true; }
  failures++;
  console.log('  ✗ ' + name + (extra ? '\n      ' + extra : ''));
  return false;
}

/** 找一个真实 .uvprojx 当导入输入（只读） */
function findRealUvprojx() {
  try {
    const r = JSON.parse(fs.readFileSync(paths.recentFile(), 'utf8'));
    if (r && r.file && fs.existsSync(r.file)) return r.file;
  } catch (_) { /* 没有最近工程 */ }
  const guess = 'C:\\Users\\asus\\Desktop\\STM32 OLED显示屏\\Project.uvprojx';
  if (fs.existsSync(guess)) return guess;
  return null;
}

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mcu-card-' + tag + '-'));
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

(function main() {
  const realUv = findRealUvprojx();
  if (!realUv) {
    console.error('前提缺失：找不到可当导入输入的 .uvprojx（先打开一个 Keil 工程，或在默认路径放一个）');
    process.exit(2);
  }
  console.log('=== 工程卡验证 ===');
  console.log('导入输入（只读）：' + realUv);

  const made = [];
  const temp = (tag) => { const d = tmpDir(tag); made.push(d); return d; };

  try {
    /* ── 1) 路径解析 ── */
    console.log('\n[1] 路径解析与引脚规范化');
    const d1 = temp('import');
    const uvCopy = path.join(d1, path.basename(realUv));
    fs.copyFileSync(realUv, uvCopy);
    const r1 = card.resolve(uvCopy);
    check('resolve(.uvprojx) → 工程目录 + .dsh-mcu/project.json',
      r1.dir === d1 && r1.cardFile === path.join(d1, '.dsh-mcu', 'project.json'), JSON.stringify(r1));
    check('resolve(目录) 也指向默认卡位置', card.resolve(d1).cardFile === r1.cardFile);
    check('normalizePin: pB08 → PB8', card.normalizePin('pB08', 'stm32') === 'PB8');
    check('normalizePin: 4 → GPIO4（esp32）', card.normalizePin('4', 'esp32') === 'GPIO4');
    check('normalizePin: io04 → GPIO4（esp32）', card.normalizePin('io04', 'esp32') === 'GPIO4');
    check('findUvprojx 在目录里能找到工程文件', card.findUvprojx(d1).length === 1);

    /* ── 2) 没卡时的行为 ── */
    console.log('\n[2] 没有工程卡');
    const empty = card.read(d1);
    check('read: has=false 且不抛异常', empty.ok === true && empty.has === false);
    check('read: 正文告诉你怎么生成', /import/.test(empty.text) && /init/.test(empty.text));
    check('read: 校验结构完整', empty.validation && Array.isArray(empty.validation.missing));

    const dry = card.validateOnly(d1);
    check('validate(.uvprojx 目录): 给草案且不落盘',
      dry.dryRun === true && dry.has === false && fs.existsSync(dry.path) === false);
    check('validate: 草案从 .uvprojx 抽到芯片型号',
      dry.card && dry.card.target && !!dry.card.target.chip &&
      /STM32/i.test(dry.card.target.chip), JSON.stringify(dry.card && dry.card.target));
    check('validate: 草案里引脚表是空的（不猜引脚）',
      dry.card.pins.map.length === 0);
    check('validate: 草案把「引脚表为空」列为待补',
      (dry.validation.missing || []).some((m) => /引脚表为空/.test(m)),
      JSON.stringify(dry.validation.missing));
    check('validate: 草案正文明确写了「草案，还没写入」', /草案，还没写入/.test(dry.text));
    check('validate: 没落盘', fs.existsSync(dry.path) === false);

    /* ── 3) import ── */
    console.log('\n[3] op=import');
    const im = card.importCard(d1);
    check('import: 落盘成功', im.ok === true && im.has === true && fs.existsSync(im.path));
    check('import: backend=keil-ac5', im.card.toolchain.backend === 'keil-ac5');
    check('import: family=stm32', im.card.target.family === 'stm32');
    check('import: 填了工程文件名', im.card.toolchain.projectFile === path.basename(realUv));
    check('import: 填了 Flash/RAM 容量（来自 <Cpu> 的 IROM/IRAM）',
      Number(im.card.target.flashKB) > 0 && Number(im.card.target.ramKB) > 0,
      JSON.stringify({ flash: im.card.target.flashKB, ram: im.card.target.ramKB }));
    check('import: 串口不猜（留空）', !im.card.runtime.serial.port);
    check('import: 写入前没有原件，所以没有备份', !im.backup);
    check('import: summary 带芯片与工具链',
      /stm32/.test(im.summary) && /keil-ac5/.test(im.summary), im.summary);
    check('import: 正文含引脚表待补', /待补/.test(im.text));

    let threw = null;
    try { card.importCard(d1); } catch (err) { threw = err; }
    check('import: 已有卡时拒绝覆盖（EXISTS）', !!threw && threw.code === 'EXISTS', threw && threw.message);

    /* ── 4) write 增量语义 ── */
    console.log('\n[4] op=write（深合并）');
    const patch1 = '```json\n' + JSON.stringify({
      pins: {
        map: [
          { pin: 'PB8', signal: 'OLED_SCL', mode: 'out-od', note: '软件 I2C' },
          { pin: 'PB9', signal: 'OLED_SDA', mode: 'out-od' },
          { pin: 'PB1', signal: 'KEY1', mode: 'in-pullup', note: '按下为低' },
        ],
      },
      runtime: { flash: { port: 'COM3' }, serial: { port: 'COM3', baud: 115200 } },
    }, null, 2) + '\n```';
    const w1 = card.writeContent(d1, patch1);
    check('write: 剥得掉 ```json 代码围栏', w1.ok === true && w1.has === true);
    check('write: 引脚落盘 3 个', w1.card.pins.map.length === 3 && w1.validation.counts.pins === 3);
    check('write: 深合并没丢 import 的字段',
      w1.card.toolchain.backend === 'keil-ac5' && w1.card.target.chip === im.card.target.chip &&
      w1.card.files && w1.card.files.count > 0);
    check('write: 有原件时会备份', !!w1.backup && fs.existsSync(w1.backup));
    check('write: 待补清单清空了',
      (w1.validation.missing || []).length === 0, JSON.stringify(w1.validation.missing));
    check('write: 正文里有引脚明细', /PB8/.test(w1.text) && /OLED_SCL/.test(w1.text));

    const w2 = card.writeContent(d1, JSON.stringify({ pins: { map: w1.card.pins.map } }));
    check('write: 内容没变时 changed=false', w2.changed === false);

    /* ── 5) 冲突校验 ── */
    console.log('\n[5] 冲突校验');
    const c1 = card.writeContent(d1, JSON.stringify({
      pins: { map: [{ pin: 'PB8', signal: 'I2C_SCL' }, { pin: 'PB8', signal: 'LED' }] },
    }));
    check('冲突: 同一引脚两个信号 → error',
      c1.validation.ok === false && c1.validation.errors.some((e) => /PB8/.test(e) && /冲突/.test(e)),
      JSON.stringify(c1.validation.errors));
    const c2 = card.writeContent(d1, JSON.stringify({ pins: { map: [{ pin: 'PA13', signal: 'LED' }] } }));
    check('冲突: 保留脚被占用 → error',
      c2.validation.errors.some((e) => /PA13/.test(e) && /保留脚/.test(e)),
      JSON.stringify(c2.validation.errors));
    const c3 = card.writeContent(d1, JSON.stringify({
      pins: { map: [{ pin: 'PB8', signal: 'I2C_SCL' }, { pin: 'PB9', signal: 'I2C_SDA' }] },
      peripherals: [{ type: 'i2c', name: 'OLED', scl: 'PB8', sda: 'PB12' }],
    }));
    check('校验: 外设引用了不在表里的引脚 → warning（不是 error）',
      c3.validation.warnings.some((w) => /PB12/.test(w)), JSON.stringify(c3.validation.warnings));

    const c4 = card.writeContent(d1, JSON.stringify({ runtime: { serial: null } }));
    check('write: null 删除字段', c4.card.runtime.serial === undefined);

    /* ── 6) ESP-IDF 目录识别 ── */
    console.log('\n[6] op=init：ESP-IDF 目录');
    const d2 = temp('idf');
    writeFile(path.join(d2, 'CMakeLists.txt'), '# ESP-IDF project\ninclude($ENV{IDF_PATH}/tools/cmake/project.cmake)\nproject(esp32cam)\n');
    writeFile(path.join(d2, 'main', 'CMakeLists.txt'), 'idf_component_register(SRCS "app_main.c")\n');
    writeFile(path.join(d2, 'main', 'app_main.c'), 'void app_main(void){}\n');
    writeFile(path.join(d2, 'sdkconfig'), '# auto generated\n');
    const ini = card.initCard(d2);
    check('init: 识别为 esp-idf / esp32',
      ini.card.toolchain.backend === 'esp-idf' && ini.card.target.family === 'esp32',
      JSON.stringify(ini.card.toolchain));
    check('init: 烧录方式给的是 ESP32 常规做法（usb-serial-jtag）',
      ini.card.runtime.flash.method === 'usb-serial-jtag');
    check('init: 烧录串口不猜（留空 + 待补）',
      !ini.card.runtime.flash.port && (ini.validation.missing || []).some((m) => /烧录串口/.test(m)));
    check('init: 引脚表留空并列为待补',
      ini.card.pins.map.length === 0 && ini.validation.missing.some((m) => /引脚表为空/.test(m)));
    check('init: 识别依据写进了 detected', ini.detected.evidence.some((e) => /sdkconfig/.test(e)),
      JSON.stringify(ini.detected));
    check('init: 正文明确是骨架、要补什么', /待补/.test(ini.text));

    /* ── 7) PlatformIO 目录识别 ── */
    console.log('\n[7] op=init：PlatformIO 目录');
    const d3 = temp('pio');
    writeFile(path.join(d3, 'platformio.ini'), '[env:esp32dev]\nplatform = espressif32\nboard = esp32dev\n');
    const pio = card.initCard(d3);
    check('init: platformio.ini → platformio + esp32',
      pio.card.toolchain.backend === 'platformio' && pio.card.target.family === 'esp32',
      JSON.stringify(pio.card));
    const d4 = temp('pio-stm');
    writeFile(path.join(d4, 'platformio.ini'), '[env:bluepill]\nplatform = ststm32\nboard = bluepill_f103c8\n');
    const pioStm = card.initCard(d4);
    check('init: platform=ststm32 → family=stm32',
      pioStm.card.toolchain.backend === 'platformio' && pioStm.card.target.family === 'stm32',
      JSON.stringify(pioStm.card.target));

    /* ── 8) 认不出就如实报错 ── */
    console.log('\n[8] 认不出工具链');
    const d5 = temp('empty');
    let noBackend = null;
    try { card.initCard(d5); } catch (err) { noBackend = err; }
    check('init: 空目录 → NO_BACKEND（不瞎猜）',
      !!noBackend && noBackend.code === 'NO_BACKEND', noBackend && noBackend.message);
    check('init: 空目录没有留下任何文件', fs.readdirSync(d5).length === 0);

    /* ── 9) 坏 JSON ── */
    console.log('\n[9] 坏 JSON');
    const d6 = temp('broken');
    fs.mkdirSync(path.join(d6, '.dsh-mcu'), { recursive: true });
    fs.writeFileSync(path.join(d6, '.dsh-mcu', 'project.json'), '{ this is not json', 'utf8');
    const bad = card.read(d6);
    check('read: 坏卡 has=true/broken=true 且不抛异常', bad.has === true && bad.broken === true);
    check('read: 正文指出解析失败并给出原文片段',
      /解析失败/.test(bad.text) && /not json/.test(bad.text));

    /* ── 10) 没有卡时 status 用的摘要字段 ── */
    console.log('\n[10] summaryLine / resolve 边界');
    check('summaryLine: 含家族/芯片/后端/引脚数',
      (() => { const s = card.summaryLine(w1.card); return /stm32/.test(s) && /keil-ac5/.test(s) && /引脚 3/.test(s); })(),
      card.summaryLine(w1.card));
    let noPath = null;
    try { card.read(''); } catch (err) { noPath = err; }
    check('resolve: 空路径 → NO_PATH', !!noPath && noPath.code === 'NO_PATH');
    const plainFile = path.join(d1, 'notes.txt');
    fs.writeFileSync(plainFile, 'hello', 'utf8');
    let badPath = null;
    try { card.read(plainFile); } catch (err) { badPath = err; }
    check('resolve: 普通文件 → BAD_PATH（不会当成卡）', !!badPath && badPath.code === 'BAD_PATH');
  } finally {
    made.forEach((d) => {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* 清理失败不影响结论 */ }
    });
  }

  console.log('\n' + (failures === 0 ? '全部通过 ✅' : failures + ' 项失败 ❌'));
  process.exit(failures === 0 ? 0 : 1);
})();
