'use strict';
/** dump-link-output.js —— 把完整构建输出存下来，用于分析 armlink --map 的格式 */
const fs = require('fs');
const path = require('path');
const { buildKeil } = require('../server/keil-build');
const ctx = require('./_ctx');

const PROJ = process.argv[2] || ctx.projectDir();

(async () => {
  const lines = [];
  const r = await buildKeil({
    projectFile: PROJ,
    onLine: (l, tag) => lines.push('[' + tag + '] ' + l),
  });
  const out = path.join(ctx.logsDir(), 'link-output.txt');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, lines.join('\n'), 'utf8');
  console.log('ok=' + r.ok + '　共 ' + lines.length + ' 行 → ' + out);
})();
