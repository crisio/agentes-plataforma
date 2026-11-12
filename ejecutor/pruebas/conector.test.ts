// Pruebas del conector OAuth + MCP contra un Hilo falso en memoria (nunca contra el sistema real).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ConectorOAuth, ErrorConexion } from '../src/conector-oauth.ts';
import type { Almacen } from '../src/boveda.ts';
import { TokenServicio } from '../src/token-servicio.ts';

class AlmacenMemoria implements Almacen {
  datos = new Map<string, string>();
  guardados = 0;
  async leer(n: string) { return this.datos.get(n) ?? null; }
  async guardar(n: string, v: string) { this.datos.set(n, v); this.guardados++; }
  async borrar(n: string) { this.datos.delete(n); }
}

/** Hilo falso: registro, canje con PKCE, refresh que rota (reusar uno viejo revoca la familia) y /mcp. */
function hiloFalso() {
  const s = { clientes: 0, codigos: new Map<string, { reto: string; cliente: string }>(), refrescos: new Map<string, boolean>(), accesos: new Set<string>(), n: 0, revocada: false, llamadasMcp: [] as any[] };
  const http = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const json = (estado: number, cuerpo: unknown) => new Response(JSON.stringify(cuerpo), { status: estado, headers: { 'Content-Type': 'application/json' } });
    if (u.pathname === '/oauth/register') { s.clientes++; return json(201, { client_id: 'cli-' + s.clientes }); }
    if (u.pathname === '/oauth/token') {
      const f = new URLSearchParams(String(init?.body));
      const emitir = () => { s.n++; const a = 'acc-' + s.n, r = 'ref-' + s.n; s.accesos.add(a); s.refrescos.set(r, true); return json(200, { access_token: a, refresh_token: r, expires_in: 3600 }); };
      if (f.get('grant_type') === 'authorization_code') {
        const c = s.codigos.get(f.get('code')!);
        if (!c) return json(400, { error: 'invalid_grant' });
        const reto = createHash('sha256').update(f.get('code_verifier')!).digest('base64url');
        if (reto !== c.reto || c.cliente !== f.get('client_id')) return json(400, { error: 'invalid_grant' });
        s.codigos.delete(f.get('code')!);
        return emitir();
      }
      const r = f.get('refresh_token')!;
      if (s.revocada || !s.refrescos.has(r)) return json(400, { error: 'invalid_grant' });
      if (s.refrescos.get(r) === false) { s.revocada = true; return json(400, { error: 'invalid_grant' }); }
      s.refrescos.set(r, false);
      return emitir();
    }
    if (u.pathname === '/mcp') {
      const tok = String((init?.headers as Record<string, string>).Authorization).slice(7);
      if (!s.accesos.has(tok)) return new Response('', { status: 401 });
      const lote = JSON.parse(String(init?.body));
      s.llamadasMcp.push(lote);
      return json(200, lote.map((m: any) => ({ jsonrpc: '2.0', id: m.id, result: m.method === 'tools/list'
        ? { tools: [{ name: 'buscar_ordenes', annotations: { readOnlyHint: true } }, { name: 'guardar_nota' }] }
        : m.method === 'tools/call' ? { content: [{ type: 'text', text: 'ok ' + m.params.name }] } : {} })));
    }
    return json(404, {});
  }) as typeof fetch;
  /** Simula el login de la persona en Hilo: devuelve la dirección de vuelta que el navegador no puede abrir. */
  const autorizar = (urlLogin: string, codigo = 'cod-1') => {
    const q = new URL(urlLogin).searchParams;
    s.codigos.set(codigo, { reto: q.get('code_challenge')!, cliente: q.get('client_id')! });
    return `${q.get('redirect_uri')}?code=${codigo}&state=${encodeURIComponent(q.get('state')!)}&iss=x`;
  };
  return { s, http, autorizar };
}

const cfg = { clave: 'hilo', nombre: 'Agentes GC', urlPublica: 'https://hilo.ejemplo', urlApi: 'http://hilo.local', redireccion: 'http://localhost:9941/conexiones/hilo/vuelta', alcance: 'hilo' };

test('conectar: registra el cliente una vez, canjea con PKCE, guarda el refresh y lista herramientas', async () => {
  const h = hiloFalso(); const alm = new AlmacenMemoria();
  const c = new ConectorOAuth(cfg, alm, h.http);
  const { url } = await c.iniciar(7);
  assert.match(url, /^https:\/\/hilo\.ejemplo\/oauth\/authorize\?/);
  assert.equal(new URL(url).searchParams.get('code_challenge_method'), 'S256');
  const r = await c.completar(7, h.autorizar(url));
  assert.deepEqual(r.herramientas.map((x) => x.name), ['buscar_ordenes', 'guardar_nota']);
  assert.equal(JSON.parse(alm.datos.get('conexion/hilo/u7')!).refresh, 'ref-1');
  await c.iniciar(8);
  assert.equal(h.s.clientes, 1, 'el cliente se registra una sola vez');
});

test('la dirección pegada tiene que ser del último intento de la misma persona', async () => {
  const h = hiloFalso(); const c = new ConectorOAuth(cfg, new AlmacenMemoria(), h.http);
  const { url } = await c.iniciar(7);
  const vuelta = h.autorizar(url);
  await assert.rejects(c.completar(8, vuelta), (e: ErrorConexion) => e.codigo === 'intento_desconocido');
  await assert.rejects(c.completar(7, 'http://evil.example/conexiones/hilo/vuelta?code=x&state=y'), (e: ErrorConexion) => e.codigo === 'direccion_invalida');
  const { url: url2 } = await c.iniciar(7);           // un intento nuevo invalida el anterior
  await assert.rejects(c.completar(7, vuelta), (e: ErrorConexion) => e.codigo === 'intento_desconocido');
  await c.completar(7, h.autorizar(url2, 'cod-2'));
});

test('intento vencido y acceso denegado', async () => {
  let reloj = 1_000_000;
  const h = hiloFalso(); const c = new ConectorOAuth(cfg, new AlmacenMemoria(), h.http, () => reloj);
  const { url } = await c.iniciar(7);
  reloj += 16 * 60_000;
  await assert.rejects(c.completar(7, h.autorizar(url)), (e: ErrorConexion) => e.codigo === 'intento_vencido');
  const { url: url2 } = await c.iniciar(7);
  const st = new URL(url2).searchParams.get('state')!;
  await assert.rejects(c.completar(7, `${cfg.redireccion}?error=access_denied&state=${st}`), (e: ErrorConexion) => e.codigo === 'acceso_denegado');
});

test('renovaciones simultáneas usan el refresh una sola vez y guardan el nuevo', async () => {
  let reloj = 1_000_000;
  const h = hiloFalso(); const alm = new AlmacenMemoria();
  const c = new ConectorOAuth(cfg, alm, h.http, () => reloj);
  const { url } = await c.iniciar(7);
  await c.completar(7, h.autorizar(url));
  reloj += 2 * 3600_000;                                 // el acceso venció
  const r = await Promise.all([c.llamar(7, 'buscar_ordenes', {}), c.llamar(7, 'buscar_ordenes', {}), c.herramientas(7)]);
  assert.equal(r.length, 3);
  assert.equal(h.s.revocada, false, 'nunca se reusó un refresh viejo');
  assert.equal(JSON.parse(alm.datos.get('conexion/hilo/u7')!).refresh, 'ref-2');
});

test('401 del MCP renueva una vez; refresh revocado borra la conexión y pide reconectar', async () => {
  const h = hiloFalso(); const alm = new AlmacenMemoria();
  const c = new ConectorOAuth(cfg, alm, h.http);
  const { url } = await c.iniciar(7);
  await c.completar(7, h.autorizar(url));
  h.s.accesos.clear();                                   // Hilo invalidó el acceso
  assert.ok(await c.llamar(7, 'buscar_ordenes', {}));
  h.s.revocada = true; h.s.accesos.clear();
  await assert.rejects(c.herramientas(7), (e: ErrorConexion) => e.codigo === 'reconectar');
  assert.equal(alm.datos.has('conexion/hilo/u7'), false);
  await assert.rejects(c.herramientas(7), (e: ErrorConexion) => e.codigo === 'sin_conexion');
});

test('código del sistema vencido o ya usado en el canje: intento_vencido, no reconectar', async () => {
  const h = hiloFalso(); const alm = new AlmacenMemoria();
  const c = new ConectorOAuth(cfg, alm, h.http);
  const { url } = await c.iniciar(7);
  const st = new URL(url).searchParams.get('state')!;
  // Hilo nunca emitió (o ya consumió) ese código: responde invalid_grant.
  await assert.rejects(c.completar(7, `${cfg.redireccion}?code=viejo&state=${encodeURIComponent(st)}`), (e: ErrorConexion) => e.codigo === 'intento_vencido');
  assert.equal(alm.datos.has('conexion/hilo/u7'), false);
});

test('desconectar borra el token de la persona', async () => {
  const h = hiloFalso(); const alm = new AlmacenMemoria();
  const c = new ConectorOAuth(cfg, alm, h.http);
  const { url } = await c.iniciar(7);
  await c.completar(7, h.autorizar(url));
  await c.desconectar(7);
  assert.equal(alm.datos.has('conexion/hilo/u7'), false);
  await assert.rejects(c.herramientas(7), (e: ErrorConexion) => e.codigo === 'sin_conexion');
});

test('token de servicio: firma, servicio, acción, vencimiento y jti único', () => {
  let t = 1000;
  const ts = new TokenServicio(Buffer.alloc(32, 7), () => t);
  const tok = ts.crear('gateway', 5, null, 'conexion_iniciar');
  assert.equal(ts.validar(tok, 'gateway', 'conexion_probar').ok, false);
  assert.equal(ts.validar(tok, 'ejecutor', 'conexion_iniciar').ok, false);
  const ok = ts.validar(tok, 'gateway', 'conexion_iniciar');
  assert.ok(ok.ok && ok.rec.usr === 5);
  assert.equal(ts.validar(tok, 'gateway', 'conexion_iniciar').ok, false, 'repetido');
  const otro = new TokenServicio(Buffer.alloc(32, 8), () => t);
  assert.equal(otro.validar(ts.crear('gateway', 5, null, 'x'), 'gateway').ok, false, 'otra clave');
  const viejo = ts.crear('gateway', 5, null, 'x'); t += 31;
  assert.equal(ts.validar(viejo, 'gateway').ok, false, 'vencido');
});
