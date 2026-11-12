// Rutas del ejecutor: qué servicio puede pedir qué acción, y que llamar/herramientas lleguen al conector.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { crearServidor } from '../src/servidor.ts';
import { TokenServicio } from '../src/token-servicio.ts';
import { ErrorConexion, type ConectorOAuth } from '../src/conector-oauth.ts';

const ts = new TokenServicio(Buffer.alloc(32, 3));
const llamadas: unknown[] = [];
const conector = {
  async herramientas() { return [{ name: 'buscar_ordenes', description: 'Busca', inputSchema: { type: 'object', properties: { po: { type: 'string' } } } }, { name: 'sin_esquema' }]; },
  async llamar(u: number, nombre: string, args: object) {
    llamadas.push({ u, nombre, args });
    if (nombre === 'falla') throw new ErrorConexion('reconectar');
    return { content: [{ type: 'text', text: 'ok' }] };
  },
} as unknown as ConectorOAuth;

async function conServidor(f: (base: string) => Promise<void>) {
  const s = crearServidor(ts, { hilo: conector });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  try { await f(`http://127.0.0.1:${(s.address() as AddressInfo).port}`); } finally { s.close(); }
}
const post = (base: string, ruta: string, tok: string, cuerpo: object) =>
  fetch(base + ruta, { method: 'POST', headers: { Authorization: 'Servicio ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(cuerpo) });

test('el orquestador lista herramientas y llama en nombre de la persona del token', async () => {
  await conServidor(async (b) => {
    let r = await post(b, '/v1/conexiones/hilo/herramientas', ts.crear('orquestador', 7, null, 'conexion_herramientas'), {});
    assert.equal(r.status, 200);
    const j: any = await r.json();
    assert.equal(j.herramientas[0].name, 'buscar_ordenes');
    assert.deepEqual(j.herramientas[1].inputSchema, { type: 'object', properties: {} });
    r = await post(b, '/v1/conexiones/hilo/llamar', ts.crear('orquestador', 7, null, 'conexion_llamar'), { nombre: 'buscar_ordenes', argumentos: { po: '0023' } });
    assert.equal(r.status, 200);
    assert.deepEqual(llamadas.at(-1), { u: 7, nombre: 'buscar_ordenes', args: { po: '0023' } });
  });
});

test('cada servicio solo puede sus acciones', async () => {
  await conServidor(async (b) => {
    assert.equal((await post(b, '/v1/conexiones/hilo/llamar', ts.crear('gateway', 7, null, 'conexion_llamar'), { nombre: 'x' })).status, 401);
    assert.equal((await post(b, '/v1/conexiones/hilo/iniciar', ts.crear('orquestador', 7, null, 'conexion_iniciar'), {})).status, 401);
    assert.equal((await post(b, '/v1/conexiones/hilo/borrartodo', ts.crear('gateway', 7, null, 'conexion_borrartodo'), {})).status, 404);
  });
});

test('nombre de herramienta inválido y errores del sistema', async () => {
  await conServidor(async (b) => {
    let r = await post(b, '/v1/conexiones/hilo/llamar', ts.crear('orquestador', 7, null, 'conexion_llamar'), { nombre: '../x y' });
    assert.equal(r.status, 400);
    r = await post(b, '/v1/conexiones/hilo/llamar', ts.crear('orquestador', 7, null, 'conexion_llamar'), { nombre: 'falla' });
    assert.equal(r.status, 409);
    assert.equal(((await r.json()) as any).error, 'reconectar');
  });
});
