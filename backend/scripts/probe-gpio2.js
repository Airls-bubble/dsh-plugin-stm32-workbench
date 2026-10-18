'use strict';
/** probe-gpio2.js —— 第二轮侦察：OLED 相关文件 + main.c 的初始化调用链（只读） */
const fs = require('fs');
const path = require('path');
const { readText } = require('../server/srcfile');
const ctx = require('./_ctx');

/* 工程目录来自「当前打开的工程」，不再写死开发机路径 */
const DIR = ctx.projectDir();

const FILES = [
  'Hardware\\OLED_driver.c',
  'Hardware\\OLED_UI.c',
  'Hardware\\OLED_UI_Driver.c',
  'Hardware\\OLED_UI_MenuData.c',
  'User\\stm32f10x_it.c',
];

for (const rel of FILES) {
  const p = path.join(DIR, rel);
  if (!fs.existsSync(p)) { console.log('（不存在）' + rel); continue; }
  const { text, encoding } = readText(p);
  const lines = text.split(/\r?\n/);
  const hits = [];
  lines.forEach((l, i) => {
    if (/GPIO_(Init|Pin_|Mode_|Speed_)|RCC_APB|GPIO_Init\s*\(|->CR[LH]|EXTI_Init|I2C_|SPI_/.test(l)) {
      hits.push({ n: i + 1, t: l.trim() });
    }
  });
  console.log('');
  console.log('═══ ' + rel + '  [' + encoding + ', ' + lines.length + ' 行, ' + hits.length + ' 处] ═══');
  hits.slice(0, 20).forEach((h) => console.log('  ' + String(h.n).padStart(4) + ' | ' + h.t.slice(0, 106)));
  if (hits.length > 20) console.log('  …还有 ' + (hits.length - 20) + ' 处');
}

/* main.c：看初始化调用链 */
const mp = path.join(DIR, 'User\\main.c');
const { text: mainText, encoding: mainEnc } = readText(mp);
const ml = mainText.split(/\r?\n/);
console.log('');
console.log('═══ User\\main.c [' + mainEnc + ', ' + ml.length + ' 行] 初始化/调用链 ═══');
ml.forEach((l, i) => {
  if (/^\s*\/\//.test(l)) return;
  if (/\w+\s*\(\s*\)\s*;|_Init\s*\(|_Config\s*\(|GPIO_|RCC_|EXTI_|TIM_|USART_|NVIC_/.test(l)) {
    console.log('  ' + String(i + 1).padStart(4) + ' | ' + l.trim().slice(0, 106));
  }
});
