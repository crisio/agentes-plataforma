// Conexión de una persona con un sistema que expone MCP con OAuth 2.1 (registro dinámico + PKCE), como Hilo.
// Sin tocar el otro sistema: la vuelta del login va a localhost y la persona pega esa dirección en la app.
// El refresh token rota en cada renovación y reusar uno viejo revoca toda la familia: se renueva de a uno por persona
// y el nuevo se guarda en la bóveda antes de usar el acceso.
import { createHash, randomBytes } from 'node:crypto';
import type { Almacen } from './boveda.ts';

export type ConfigConector = {
  clave: string;            // 'hilo'
  nombre: string;           // nombre del cliente que se registra en el sistema
  urlPublica: string;       // donde la persona inicia sesión (https://hilo.ejemplo.com)
  urlApi: string;           // donde el ejecutor canjea y llama (http://127.0.0.1:9000): la data no sale del servidor
  redireccion: string;      // http://localhost:9941/conexiones/hilo/vuelta
  alcance?: string;         // 'hilo'
};

export class ErrorConexion extends Error {
  readonly codigo: string;
  constructor(codigo: string, mensaje?: string) { super(mensaje ?? codigo); this.codigo = codigo; }
}

type Pendiente = { usuarioId: number; verificador: string; clienteId: string; vence: number };
type Guardado = { clienteId: string; refresh: string; conectadaUtc: string };
export type Herramienta = { name: string; description?: string; inputSchema?: unknown; annotations?: Record<string, unknown> };

const b64url = (b: Buffer) => b.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const MINUTOS_PENDIENTE = 15;
const VERSION_MCP = '2025-06-18';

function sinRed(e: unknown): ErrorConexion {
  return new ErrorConexion((e as { name?: string })?.name === 'TimeoutError' ? 'tiempo_agotado' : 'sistema_no_disponible');
}

export class ConectorOAuth {
  readonly #pendientes = new Map<string, Pendiente>();
  readonly #accesos = new Map<number, { acceso: string; vence: number }>();
  readonly #colas = new Map<number, Promise<unknown>>();
  #clienteId: string | null = null;

  readonly cfg: ConfigConector; readonly almacen: Almacen; readonly http: typeof fetch; readonly ahora: () => number;
  constructor(cfg: ConfigConector, almacen: Almacen, http: typeof fetch = fetch, ahora: () => number = Date.now) {
    this.cfg = cfg; this.almacen = almacen; this.http = http; this.ahora = ahora;
  }

  get recurso() { return this.cfg.urlPublica.replace(/\/$/, '') + '/mcp'; }
  nombreSecreto(usuarioId: number) { return `conexion/${this.cfg.clave}/u${usuarioId}`; }
  get nombreCliente() { return `conexion/${this.cfg.clave}/cliente`; }

  /** Una sola operación de token a la vez por persona (la rotación del refresh no admite carreras). */
  #enCola<T>(usuarioId: number, f: () => Promise<T>): Promise<T> {
    const previa = this.#colas.get(usuarioId) ?? Promise.resolve();
    const siguiente = previa.catch(() => {}).then(f);
    this.#colas.set(usuarioId, siguiente);
    siguiente.finally(() => { if (this.#colas.get(usuarioId) === siguiente) this.#colas.delete(usuarioId); }).catch(() => {});
    return siguiente;
  }

  async #cliente(usuarioId: number): Promise<string> {
    if (this.#clienteId) return this.#clienteId;
    const guardado = await this.almacen.leer(this.nombreCliente, usuarioId);
    if (guardado) {
      const j = JSON.parse(guardado);
      if (j.redireccion === this.cfg.redireccion && j.clienteId) return (this.#clienteId = j.clienteId as string);
    }
    let res: Response;
    try {
      res = await this.http(this.cfg.urlApi + '/oauth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_name: this.cfg.nombre, redirect_uris: [this.cfg.redireccion], token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) { throw sinRed(e); }
    const j: any = await res.json().catch(() => ({}));
    if ((res.status !== 201 && res.status !== 200) || !j.client_id) throw new ErrorConexion('registro_rechazado', j.error_description ?? j.error);
    await this.almacen.guardar(this.nombreCliente, JSON.stringify({ clienteId: j.client_id, redireccion: this.cfg.redireccion }), usuarioId,
      `Cliente OAuth de Agentes GC en ${this.cfg.clave}`);
    return (this.#clienteId = j.client_id as string);
  }

  /** Paso 1: la dirección donde la persona inicia sesión en el sistema. */
  async iniciar(usuarioId: number): Promise<{ url: string; vence: string }> {
    const clienteId = await this.#cliente(usuarioId);
    for (const [k, p] of this.#pendientes) if (p.vence <= this.ahora() || p.usuarioId === usuarioId) this.#pendientes.delete(k); // vale solo el último intento
    const verificador = b64url(randomBytes(32));
    const estado = b64url(randomBytes(24));
    const vence = this.ahora() + MINUTOS_PENDIENTE * 60_000;
    this.#pendientes.set(estado, { usuarioId, verificador, clienteId, vence });
    const q = new URLSearchParams({
      response_type: 'code', client_id: clienteId, redirect_uri: this.cfg.redireccion, state: estado,
      code_challenge: b64url(createHash('sha256').update(verificador).digest()), code_challenge_method: 'S256',
      scope: this.cfg.alcance ?? '', resource: this.recurso,
    });
    return { url: this.cfg.urlPublica.replace(/\/$/, '') + '/oauth/authorize?' + q.toString(), vence: new Date(vence).toISOString() };
  }

  /** Paso 2: la persona pega la dirección de vuelta (la que el navegador no pudo abrir). */
  async completar(usuarioId: number, pegada: string): Promise<{ herramientas: Herramienta[] }> {
    let u: URL;
    try { u = new URL(pegada.trim()); } catch { throw new ErrorConexion('direccion_invalida'); }
    const base = new URL(this.cfg.redireccion);
    if (u.origin !== base.origin || u.pathname !== base.pathname) throw new ErrorConexion('direccion_invalida');
    const estado = u.searchParams.get('state') ?? '';
    const p = this.#pendientes.get(estado);
    if (!p || p.usuarioId !== usuarioId) throw new ErrorConexion('intento_desconocido');
    this.#pendientes.delete(estado);
    if (p.vence <= this.ahora()) throw new ErrorConexion('intento_vencido');
    const err = u.searchParams.get('error');
    if (err) throw new ErrorConexion('acceso_denegado', err);
    const code = u.searchParams.get('code');
    if (!code) throw new ErrorConexion('direccion_invalida');

    await this.#enCola(usuarioId, async () => {
      let t;
      try {
        t = await this.#token({ grant_type: 'authorization_code', code, redirect_uri: this.cfg.redireccion, code_verifier: p.verificador, client_id: p.clienteId, resource: this.recurso });
      } catch (e) {
        // En el canje, invalid_grant es que el código del sistema venció (Hilo: 2 min) o ya se usó; no hay conexión que reconectar.
        if (e instanceof ErrorConexion && e.codigo === 'reconectar') throw new ErrorConexion('intento_vencido', e.message);
        throw e;
      }
      const g: Guardado = { clienteId: p.clienteId, refresh: t.refresh, conectadaUtc: new Date(this.ahora()).toISOString() };
      await this.almacen.guardar(this.nombreSecreto(usuarioId), JSON.stringify(g), usuarioId, `Conexión de una persona con ${this.cfg.clave}`);
      this.#accesos.set(usuarioId, { acceso: t.acceso, vence: this.ahora() + (t.segundos - 60) * 1000 });
    });
    return { herramientas: await this.herramientas(usuarioId) };
  }

  async #token(form: Record<string, string>): Promise<{ acceso: string; refresh: string; segundos: number }> {
    let res: Response;
    try {
      res = await this.http(this.cfg.urlApi + '/oauth/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(), signal: AbortSignal.timeout(20_000),
      });
    } catch (e) { throw sinRed(e); }
    const j: any = await res.json().catch(() => ({}));
    if (res.status !== 200 || !j.access_token) {
      if (j.error === 'invalid_grant' || j.error === 'invalid_client') throw new ErrorConexion('reconectar', j.error_description ?? j.error);
      throw new ErrorConexion('token_rechazado', j.error_description ?? j.error ?? String(res.status));
    }
    return { acceso: j.access_token, refresh: j.refresh_token, segundos: Number(j.expires_in) || 3600 };
  }

  /** Acceso vigente: de memoria o renovado con el refresh de la bóveda (y el nuevo refresh guardado antes de usarlo). */
  async acceso(usuarioId: number, forzar = false): Promise<string> {
    const enMemoria = this.#accesos.get(usuarioId);
    if (!forzar && enMemoria && enMemoria.vence > this.ahora()) return enMemoria.acceso;
    return this.#enCola(usuarioId, async () => {
      const otra = this.#accesos.get(usuarioId);
      if (!forzar && otra && otra.vence > this.ahora()) return otra.acceso;
      const crudo = await this.almacen.leer(this.nombreSecreto(usuarioId), usuarioId);
      if (!crudo) throw new ErrorConexion('sin_conexion');
      const g = JSON.parse(crudo) as Guardado;
      let t;
      try { t = await this.#token({ grant_type: 'refresh_token', refresh_token: g.refresh, client_id: g.clienteId }); }
      catch (e) {
        if (e instanceof ErrorConexion && e.codigo === 'reconectar') {
          this.#accesos.delete(usuarioId);
          await this.almacen.borrar(this.nombreSecreto(usuarioId), usuarioId).catch(() => {});
        }
        throw e;
      }
      if (t.refresh) await this.almacen.guardar(this.nombreSecreto(usuarioId), JSON.stringify({ ...g, refresh: t.refresh } satisfies Guardado), usuarioId);
      this.#accesos.set(usuarioId, { acceso: t.acceso, vence: this.ahora() + (t.segundos - 60) * 1000 });
      return t.acceso;
    });
  }

  async #rpc(usuarioId: number, metodo: string, params: object, msTope: number, reintento = true): Promise<any> {
    const acceso = await this.acceso(usuarioId);
    const cuerpo = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: VERSION_MCP, capabilities: {}, clientInfo: { name: 'agentes-gc', version: '0.2.0' } } },
      { jsonrpc: '2.0', id: 2, method: metodo, params },
    ];
    let res: Response;
    try {
      res = await this.http(this.cfg.urlApi + '/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer ' + acceso, 'MCP-Protocol-Version': VERSION_MCP },
        body: JSON.stringify(cuerpo), signal: AbortSignal.timeout(msTope),
      });
    } catch (e) { throw sinRed(e); }
    if (res.status === 401 && reintento) {
      this.#accesos.delete(usuarioId);
      await this.acceso(usuarioId, true);
      return this.#rpc(usuarioId, metodo, params, msTope, false);
    }
    if (res.status === 401) throw new ErrorConexion('reconectar');
    if (res.status === 403) throw new ErrorConexion('sin_permiso_en_sistema', (await res.text().catch(() => '')).slice(0, 200));
    if (res.status !== 200) throw new ErrorConexion('sistema_error', String(res.status));
    const j: any = await res.json().catch(() => null);
    const r = Array.isArray(j) ? j.find((x: any) => x?.id === 2) : j;
    if (!r) throw new ErrorConexion('respuesta_invalida');
    if (r.error) throw new ErrorConexion('sistema_error', r.error.message ?? String(r.error.code));
    return r.result;
  }

  async herramientas(usuarioId: number): Promise<Herramienta[]> {
    const r = await this.#rpc(usuarioId, 'tools/list', {}, 30_000);
    return (r?.tools ?? []) as Herramienta[];
  }

  async llamar(usuarioId: number, nombre: string, args: Record<string, unknown>): Promise<unknown> {
    return this.#rpc(usuarioId, 'tools/call', { name: nombre, arguments: args }, 250_000);
  }

  async desconectar(usuarioId: number): Promise<void> {
    this.#accesos.delete(usuarioId);
    for (const [k, p] of this.#pendientes) if (p.usuarioId === usuarioId) this.#pendientes.delete(k);
    await this.almacen.borrar(this.nombreSecreto(usuarioId), usuarioId);
  }
}
