// Recorrido de punta a punta en Chrome contra la app (9941) y el gateway real (9942) con el esquema agentes_prueba.
// Requiere AGENTES_CORREO_MODO=consola y el archivo de log del gateway en GATEWAY_LOG (para leer el código).
// Uso: GATEWAY_LOG=<ruta> node scripts/e2e.mjs
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const chrome = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const base = process.env.APP || 'http://127.0.0.1:9941';
const gw = process.env.GATEWAY || 'http://127.0.0.1:9942';
const log = process.env.GATEWAY_LOG;
const correo = 'prueba@agentes.local';
const clave = 'clave-de-prueba-12345';
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync('.capturas', { recursive: true });

const b = await puppeteer.launch({ executablePath: chrome, headless: true });
const p = await b.newPage();
await p.setViewport({ width: 1440, height: 900 });
const resultados = [];
const consola = [];
p.on('console', (m) => { if (m.type() === 'error') consola.push(m.text()); });
p.on('response', (r) => { if (r.url().includes('/api/') && r.status() >= 400) consola.push(`${r.status()} ${r.request().method()} ${r.url()}`); });

const foto = async (n) => { await esperar(500); await p.screenshot({ path: `.capturas/e2e-${n}.png`, fullPage: true }); };
const clic = async (texto, ultimo = false) => {
  const ok = await p.evaluate((t, u) => {
    const bs = [...document.querySelectorAll('button')].filter((x) => x.textContent.trim().includes(t) && !x.disabled);
    const el = u ? bs[bs.length - 1] : bs[0];
    el?.click();
    return !!el;
  }, texto, ultimo);
  if (!ok) throw new Error(`No hay botón activo «${texto}»`);
};
const texto = (t, ms = 10000) => p.waitForFunction((x) => document.body.innerText.includes(x), { timeout: ms }, t);
const paso = async (nombre, fn) => {
  try { await fn(); resultados.push([nombre, 'OK']); console.log('OK   ', nombre); }
  catch (e) { resultados.push([nombre, 'FALLA ' + e.message]); console.log('FALLA', nombre, e.message); await foto('falla-' + resultados.length); throw e; }
};

// Con el modo consola el gateway solo imprime el código si la petición no viene por proxy: se pide directo al gateway.
async function codigoDirecto(conClave) {
  const antes = fs.readFileSync(log, 'utf8').split('[CODIGO-CONSOLA]').length;
  await fetch(`${gw}/api/acceso/codigo`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agentes': '1' }, body: JSON.stringify({ correo, ...(conClave ? { clave } : {}) }) });
  for (let i = 0; i < 40; i++) {
    const t = fs.readFileSync(log, 'utf8');
    if (t.split('[CODIGO-CONSOLA]').length > antes) return [...t.matchAll(/\[CODIGO-CONSOLA\].*codigo=(\d{6})/g)].pop()[1];
    await esperar(250);
  }
  throw new Error('No apareció el código en la consola del gateway');
}
// Límite de 3 códigos por correo cada 15 min: como la app y la consola piden uno cada una, se limpia la tabla de prueba.
function limpiarCodigos() {
  execFileSync('node', ['scripts/aplicar-sql.mjs', process.env.LIMPIAR_CODIGOS, '--esquema', 'agentes_prueba'], { cwd: '..', env: { ...process.env, MSSQL_PATH: process.env.MSSQL_PATH } , stdio: 'ignore' });
}
const ir = async (r) => { await p.goto(base + r, { waitUntil: 'networkidle0' }); await esperar(300); };

try {
  await paso('Entrar por primera vez', async () => {
    await ir('/entrar');
    await foto('01-entrar');
    await p.type('#correo', correo);
    await clic('primera vez');
    await clic('Enviar código');
    await texto('Revisa tu correo');
    const c = await codigoDirecto(false);
    await p.type('#codigo', c);
    await foto('02-codigo');
    await clic('Continuar');
    await texto('Crea tu clave');
    await p.type('#nueva', clave);
    await p.type('#repite', clave);
    await foto('03-crear-clave');
    await clic('Guardar y entrar');
    await p.waitForSelector('.ficha', { timeout: 10000 });
  });

  await paso('Roster con 3 agentes', async () => {
    const n = (await p.$$('.ficha')).length;
    if (n !== 3) throw new Error(`Se esperaban 3 agentes y hay ${n}`);
    await foto('04-roster');
  });

  await paso('Salir y volver a entrar con clave y código', async () => {
    await clic('Salir');
    limpiarCodigos();
    await p.waitForSelector('#correo', { timeout: 10000 });
    await p.type('#correo', correo);
    await p.type('#clave', clave);
    await clic('Enviar código');
    await texto('Revisa tu correo');
    const c = await codigoDirecto(true);
    await p.type('#codigo', c);
    await clic('Entrar');
    await p.waitForSelector('.ficha', { timeout: 10000 });
    await foto('05-reingreso');
  });

  let parte;
  await paso('Bóveda: inicializar 1 de 1', async () => {
    await ir('/boveda');
    await texto('Todavía no está inicializada');
    await foto('06-boveda-vacia');
    await p.$eval('#i-partes', (e) => e.select());
    await p.type('#i-partes', '1');
    await p.$eval('#i-umbral', (e) => e.select());
    await p.type('#i-umbral', '1');
    await clic('Inicializar bóveda');
    await p.waitForSelector('.parte code', { timeout: 10000 });
    parte = await p.$eval('.parte code', (e) => e.textContent.trim());
    if (!parte) throw new Error('Sin parte');
    await foto('07-partes');
    await p.click('.check input');
    await clic('Listo');
    await texto('Abierta');
  });

  await paso('Bóveda: crear secreto prueba/sql', async () => {
    await foto('08-abierta');
    await clic('Nuevo secreto');
    await p.waitForSelector('#s-nombre');
    await p.type('#s-nombre', 'prueba/sql');
    await p.select('#s-tipo', 'connection_string');
    await p.type('#s-desc', 'Secreto de prueba');
    await p.type('#s-valor', 'Server=x;Password=y');
    await foto('09-nuevo-secreto');
    await clic('Guardar');
    await texto('Secreto creado');
    await texto('prueba/sql');
    await foto('10-secreto-creado');
  });

  await paso('Bóveda: política para hilo', async () => {
    await clic('Políticas');
    await esperar(400);
    await clic('Agente');
    await p.waitForSelector('.fila-politica input');
    await p.type('.fila-politica input', 'hilo');
    const sel = await p.$$('.fila-politica select');
    await sel[0].select('8');
    await sel[1].select('18');
    await foto('11-politica');
    await clic('Guardar', true);
    await texto('Políticas guardadas');
    await texto('hilo');
    await foto('12-politica-guardada');
  });

  await paso('Bóveda: rotar', async () => {
    await clic('Rotar');
    await p.waitForSelector('#r-valor');
    await p.type('#r-valor', 'Server=x;Password=nueva');
    await clic('Rotar', true);
    await texto('Secreto rotado');
    await texto('v2');
    await foto('13-rotado');
  });

  await paso('Bóveda: sellar y abrir con la parte', async () => {
    await clic('Sellar');
    await texto('Sellada');
    await foto('14-sellada');
    await p.type('input[aria-label="Parte de la llave"]', parte);
    await clic('Abrir');
    await texto('Abierta');
    await texto('prueba/sql');
    await foto('15-reabierta');
  });

  await paso('Bóveda: revocar', async () => {
    await clic('Revocar');
    await texto('Revocar secreto');
    await clic('Revocar', true);
    await texto('Secreto revocado');
    await texto('Revocado');
    await foto('16-revocado');
  });

  await paso('Usuarios: alta con rol de agente', async () => {
    await ir('/usuarios');
    await texto('Prueba');
    await clic('Nuevo usuario');
    await p.waitForSelector('#u-nombre');
    await p.type('#u-nombre', 'Persona Dos');
    await p.type('#u-correo', 'dos@agentes.local');
    const sel = await p.$('select[aria-label^="Rol en"]');
    await sel.select('aprobador');
    await foto('17-alta-usuario');
    await clic('Crear usuario');
    await texto('Usuario creado');
    await texto('Persona Dos');
    await foto('18-usuarios');
  });

  await paso('Auditoría: eventos y cadena íntegra', async () => {
    await ir('/auditoria');
    await texto('Cadena íntegra', 20000);
    const filas = (await p.$$('table tbody tr')).length;
    if (filas < 10) throw new Error(`Pocos eventos: ${filas}`);
    await foto('19-auditoria');
    await p.select('#f-tipo', 'secreto_rotado');
    await esperar(900);
    const f2 = await p.$$eval('table tbody tr', (r) => r.map((x) => x.innerText));
    if (!f2.length || !f2.every((t) => t.includes('Secreto rotado'))) throw new Error('El filtro por tipo no funcionó');
    await foto('20-auditoria-filtro');
  });
} catch (e) {
  console.log('Interrumpido:', e.message);
}
console.log('\nErrores de consola/red:', consola.length ? consola : 'ninguno');
await b.close();
process.exit(resultados.some(([, r]) => r !== 'OK') ? 1 : 0);
