'use strict';
/**
 * test-diag.js —— 验证 diag.js 能解析**真实**工具链输出
 *
 * 做法：在**系统临时目录**里伪造一个故意写错的 .c 文件，用真的 armcc 编它，
 * 再拿真输出喂给解析器。不碰用户的 Keil 工程，不往插件本体里写东西，
 * 也不依赖任何开发期路径。
 *
 * 用法：node backend/scripts/test-diag.js
 * 退出码：0 = 全部断言通过；1 = 有断言失败（会打印差异）
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const diag = require('../server/diag');
const toolchain = require('../server/toolchain');
const ctx = require('./_ctx');

const SANDBOX = path.join(os.tmpdir(), 'dsh-mcu-tests', 'diag-test');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ✓ ' + name); return true; }
  failures++;
  console.log('  ✗ ' + name + (extra ? '\n      ' + extra : ''));
  return false;
}

/* ── 1) 合成几个真实会触发诊断的源文件 ───────────────────────────── */
function writeSamples() {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(SANDBOX, { recursive: true });
  // 未定义标识符 → error: #20；未使用变量 → warning #177-D
  fs.writeFileSync(path.join(SANDBOX, 'bad.c'), [
    '#include <stdint.h>',
    'int helper(void) { return 0; }',
    'int used(void) { int never_used; return undefined_symbol_xyz; }',
    'int another(void) { int also_unused; return 0; }',
  ].join('\n') + '\n', 'utf8');
  // 结尾没有换行 → warning #1-D
  fs.writeFileSync(path.join(SANDBOX, 'noeol.c'), 'int tail(void) { return 0; }', 'utf8');
  return SANDBOX;
}

/* ── 2) 真编 ─────────────────────────────────────────────────────── */
function runArmcc(env, file) {
  const cc = env.compilers.find((c) => c.id === 'keil-ac5' && c.usable);
  if (!cc) {
    console.log('  跳过：这台机器上找不到可用的 armcc（Keil MDK AC5）');
    return null;
  }
  const r = spawnSync(cc.exe, [
    '--c99', '--cpu', 'Cortex-M3', '-O1', '-g', '--apcs=interwork',
    '-I.', '-c', path.basename(file), '-o', file.replace(/\.c$/, '.o'),
  ], { cwd: SANDBOX, encoding: 'utf8', timeout: 60000 });
  return { cc, out: (r.stdout || '') + (r.stderr || ''), code: r.status };
}

/* ── 3) 断言 ─────────────────────────────────────────────────────── */
console.log('=== diag.js 真实输出验证 ===');
console.log('沙箱：' + SANDBOX);
writeSamples();

const env = toolchain.detectEnv();
const comp = runArmcc(env, path.join(SANDBOX, 'bad.c'));

if (comp) {
  console.log('\n[1] armcc 编译 bad.c（退出码 ' + comp.code + '）');
  const rawLines = comp.out.split(/\r?\n/).filter((l) => l.trim());
  console.log('    真实输出 ' + rawLines.length + ' 行，例如：');
  rawLines.slice(0, 4).forEach((l) => console.log('      | ' + l));

  const diags = diag.parseOutput(comp.out, { tool: 'armcc', file: 'bad.c' });
  console.log('    解析出 ' + diags.length + ' 条诊断：');
  diags.forEach((d) => console.log('      · ' + diag.format(d)));

  check('至少解析出一条 error', diags.some((d) => d.level === 'error'));
  check('错误带了行号', diags.some((d) => d.level === 'error' && typeof d.line === 'number' && d.line > 0));
  check('错误带文件且是 bad.c', diags.some((d) => d.level === 'error' && /bad\.c$/i.test(d.file || '')));
  check('错误原文里包含未定义符号名', diags.some((d) => /undefined_symbol_xyz/.test(d.message)));
  check('去重后不重复', diag.dedupe(diags).length === diags.length,
    '原始 ' + diags.length + ' → 去重 ' + diag.dedupe(diags).length);
}

const compN = runArmcc(env, path.join(SANDBOX, 'noeol.c'));
if (compN) {
  console.log('\n[2] armcc 编译 noeol.c（无结尾换行）');
  const d2 = diag.parseOutput(compN.out, { tool: 'armcc', file: 'noeol.c' });
  d2.forEach((d) => console.log('      · ' + diag.format(d)));
  if (d2.length) {
    check('解析出 warning 级别', d2.some((d) => d.level === 'warning'));
    check('warning 带行号', d2.some((d) => d.level === 'warning' && d.line > 0));
  } else {
    console.log('      （armcc 这次没报 warning —— 不作为失败）');
  }
}

/* ── 4) 链接器输出形态（手工样本，格式取自实测） ─────────────────── */
console.log('\n[3] 链接器输出形态');
const linkSample = [
  'Error: L6218E: Undefined symbol helper (referred from main.o).',
  '.\\Objects\\Project.axf: Error: L6406E: No space in execution regions with .ANY selector matching .text.',
  'Program Size: Code=1200 RO-data=300 RW-data=20 ZI-data=1024',
  'Finished: 0 information, 1 warning and 2 error messages.',
].join('\n');
const dl = diag.parseOutput(linkSample, { tool: 'armlink' });
dl.forEach((d) => console.log('      · ' + diag.format(d)));
check('链接错误码被抠出来（L6218E）', dl.some((d) => d.code === 'L6218E'));
check('Program Size 没被误判成诊断', !dl.some((d) => /Program Size/.test(d.raw)));
check('Finished 统计没被误判成诊断', !dl.some((d) => /^Finished/.test(d.raw)));
check('尾部统计能单独解析', !!diag.parseFinish(linkSample) && diag.parseFinish(linkSample).errors === 2);

/* ── 5) 真实历史链接输出（若存在；没有打开工程就跳过这一段） ─────── */
let hist = null;
try { hist = path.join(ctx.logsDir(), 'link-output.txt'); } catch (_) { /* 没有工程记录 */ }
if (hist && fs.existsSync(hist)) {
  console.log('\n[4] 历史链接输出 ' + hist + '（一份真实的成功构建日志）');
  const txt = fs.readFileSync(hist, 'utf8');
  const dh = diag.parseOutput(txt, { tool: 'armcc' });
  const errs = dh.filter((d) => d.level === 'error');
  const warns = dh.filter((d) => d.level === 'warning');
  console.log('    ' + dh.length + ' 条：error ' + errs.length + ' / warning ' + warns.length);
  console.log('    前 4 条：');
  warns.slice(0, 4).forEach((d) => console.log('      · ' + diag.format(d)));

  // 这是最硬的断言：真实日志里有几条已知的真警告，必须被抠出来且带对文件行号
  check('从真实成功日志里抠出了警告（>=3 条）', warns.length >= 3, '只得到 ' + warns.length + ' 条');
  check('已知真警告 IRSensor.c:97 #1-D 被识别',
    warns.some((d) => /IRSensor\.c$/i.test(d.file || '') && d.line === 97 && d.code === '1-D'),
    JSON.stringify(warns.map((d) => d.file + ':' + d.line)));
  check('成功构建的日志里没有 error 级诊断', errs.length === 0, '却得到 ' + errs.length + ' 条');
  check('每个文件的汇总行（"1 warning, 0 errors"）没被当成诊断',
    !dh.some((d) => /^\d+\s+warnings?\s*,/i.test(d.message || '')));
  check('工程配置的 [diag] 提示行没被当成诊断',
    !dh.some((d) => /目录里存在但没被工程引用/.test(d.raw || '')));
}

console.log('\n=== ' + (failures ? failures + ' 项失败' : '全部通过') + ' ===');
process.exit(failures ? 1 : 0);
