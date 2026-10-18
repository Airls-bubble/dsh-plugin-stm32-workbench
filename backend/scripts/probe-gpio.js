'use strict';
/** probe-gpio.js —— 看一眼用户工程里 GPIO/RCC 是怎么写的（只读） */
const fs = require('fs');
const path = require('path');
const { readText } = require('../server/srcfile');
const ctx = require('./_ctx');

/* 工程目录来自「当前打开的工程」，不再写死开发机路径 */
const DIR = ctx.projectDir();

const FILES = [
  'User\\main.c',
  'Hardware\\LED.c',
  'Hardware\\Key.c',
  'Hardware\\OLED.c',
  'Hardware\\HC-SR04.c',
  'Hardware\\IRSensor.c',
  'Hardware\\usart.c',
  'Hardware\\esp8266.c',
];

for (const rel of FILES) {
  const p = path.join(DIR, rel);
  if (!fs.existsSync(p)) { console.log('（不存在）' + rel); continue; }
  const { text, encoding } = readText(p);
  const lines = text.split(/\r?\n/);
  const hits = [];
  lines.forEach((l, i) => {
    if (/GPIO_(Init|Pin_|Mode_|Speed_)|RCC_APB|GPIO_Init\s*\(|->CR[LH]|EXTI_|AFIO/.test(l)) {
      hits.push({ n: i + 1, t: l.trim() });
    }
  });
  console.log('');
  console.log('═══ ' + rel + '  [' + encoding + ', ' + lines.length + ' 行, ' + hits.length + ' 处 GPIO 相关] ═══');
  hits.slice(0, 34).forEach((h) => console.log('  ' + String(h.n).padStart(4) + ' | ' + h.t.slice(0, 108)));
  if (hits.length > 34) console.log('  …还有 ' + (hits.length - 34) + ' 处');
}
