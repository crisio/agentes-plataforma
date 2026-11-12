// Genera los PNG de la PWA desde public/icono*.svg con Chrome (puppeteer-core).
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const chrome = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const b = await puppeteer.launch({ executablePath: chrome, headless: true });
const p = await b.newPage();
for (const [svg, tam, salida] of [['icono', 192, 'icono-192'], ['icono', 512, 'icono-512'], ['icono-maskable', 512, 'icono-maskable-512'], ['icono-maskable', 180, 'apple-touch-icon']]) {
  const s = fs.readFileSync(`public/${svg}.svg`, 'utf8');
  await p.setViewport({ width: tam, height: tam });
  await p.setContent(`<body style="margin:0;background:transparent">${s.replace('<svg ', `<svg width="${tam}" height="${tam}" `)}</body>`);
  await p.screenshot({ path: `public/${salida}.png`, omitBackground: true });
}
await b.close();
