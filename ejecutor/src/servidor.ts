// Servidor HTTP del ejecutor. Solo atiende a otros servicios locales con token de servicio; nunca devuelve tokens de
// los sistemas, solo el resultado.
//   gateway     → conexiones: iniciar, completar, probar, desconectar
//   orquestador → conexiones: herramientas, llamar (en nombre de la persona del token)
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ErrorBoveda } from './boveda.ts';
import { ErrorConexion, type ConectorOAuth } from './conector-oauth.ts';
import type { TokenServicio } from './token-servicio.ts';

const ACCIONES_GATEWAY = new Set(['iniciar', 'completar', 'probar', 'desconectar']);
const ACCIONES_ORQUESTADOR = new Set(['herramientas', 'llamar']);

function responder(res: ServerResponse, estado: number, cuerpo: unknown) {
  res.writeHead(estado, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(cuerpo));
}

async function leerJson(req: IncomingMessage): Promise<any> {
  let total = 0; const trozos: Buffer[] = [];
  for await (const t of req) { total += t.length; if (total > 256 * 1024) throw new ErrorConexion('cuerpo_grande'); trozos.push(t as Buffer); }
  if (!total) return {};
  try { return JSON.parse(Buffer.concat(trozos).toString('utf8')); } catch { throw new ErrorConexion('json_invalido'); }
}

const ESTADO_POR_CODIGO: Record<string, number> = {
  direccion_invalida: 400, intento_desconocido: 400, intento_vencido: 410, acceso_denegado: 403, json_invalido: 400, cuerpo_grande: 413,
  peticion_invalida: 400, sin_conexion: 404, reconectar: 409, sin_permiso_en_sistema: 403, tiempo_agotado: 504,
  sistema_no_disponible: 502, sistema_error: 502, token_rechazado: 502, registro_rechazado: 502, respuesta_invalida: 502,
};

export function crearServidor(tokens: TokenServicio, conectores: Record<string, ConectorOAuth>): Server {
  return createServer(async (req, res) => {
    const ip = req.socket.remoteAddress ?? '';
    if (!(ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1')) return responder(res, 403, { error: 'solo_local' });
    const ruta = new URL(req.url ?? '/', 'http://x').pathname;
    if (req.method === 'GET' && ruta === '/v1/salud') return responder(res, 200, { ok: true });

    // POST /v1/conexiones/{sistema}/{accion}
    const m = /^\/v1\/conexiones\/([a-z]+)\/([a-z]+)$/.exec(ruta);
    if (req.method !== 'POST' || !m) return responder(res, 404, { error: 'ruta' });
    const [, sistema, accion] = m;
    const svc = ACCIONES_GATEWAY.has(accion) ? 'gateway' : ACCIONES_ORQUESTADOR.has(accion) ? 'orquestador' : null;
    if (!svc) return responder(res, 404, { error: 'ruta' });
    const conector = conectores[sistema];
    if (!conector) return responder(res, 404, { error: 'sistema_desconocido' });

    const cab = req.headers.authorization ?? '';
    const v = tokens.validar(cab.startsWith('Servicio ') ? cab.slice(9).trim() : undefined, svc, 'conexion_' + accion);
    if (!v.ok) { console.warn(`token rechazado (${v.error}) en ${ruta}`); return responder(res, 401, { error: 'token_invalido' }); }
    const usuarioId = v.rec.usr;
    if (!usuarioId) return responder(res, 400, { error: 'usuario_requerido' });

    const inicio = Date.now();
    let detalleLog = '';
    try {
      const body = await leerJson(req);
      let r: unknown;
      if (accion === 'iniciar') r = await conector.iniciar(usuarioId);
      else if (accion === 'completar') {
        const { herramientas } = await conector.completar(usuarioId, String(body.direccion ?? ''));
        r = { herramientas: herramientas.map((h) => ({ nombre: h.name, soloLectura: h.annotations?.readOnlyHint === true })) };
      } else if (accion === 'probar') {
        const herramientas = await conector.herramientas(usuarioId);
        r = { herramientas: herramientas.map((h) => ({ nombre: h.name, soloLectura: h.annotations?.readOnlyHint === true })) };
      } else if (accion === 'herramientas') {
        const herramientas = await conector.herramientas(usuarioId);
        r = { herramientas: herramientas.map((h) => ({ name: h.name, description: h.description ?? '', inputSchema: h.inputSchema ?? { type: 'object', properties: {} } })) };
      } else if (accion === 'llamar') {
        const nombre = typeof body.nombre === 'string' ? body.nombre : '';
        const args = body.argumentos && typeof body.argumentos === 'object' && !Array.isArray(body.argumentos) ? body.argumentos : {};
        if (!/^[A-Za-z0-9_.-]{1,100}$/.test(nombre)) throw new ErrorConexion('peticion_invalida');
        detalleLog = ' ' + nombre;
        r = await conector.llamar(usuarioId, nombre, args);
      } else { await conector.desconectar(usuarioId); r = { desconectada: true }; }
      console.log(`${new Date().toISOString()} ${sistema}/${accion}${detalleLog} u${usuarioId} ok ${Date.now() - inicio}ms`);
      return responder(res, 200, r);
    } catch (e) {
      const codigo = e instanceof ErrorConexion || e instanceof ErrorBoveda ? e.codigo : 'interno';
      const estado = e instanceof ErrorBoveda ? (e.estado === 423 || e.estado === 409 ? e.estado : 503) : ESTADO_POR_CODIGO[codigo] ?? 500;
      const detalle = e instanceof ErrorConexion && e.message !== e.codigo ? e.message.slice(0, 200) : undefined;
      console.warn(`${new Date().toISOString()} ${sistema}/${accion}${detalleLog} u${usuarioId} ${codigo} ${Date.now() - inicio}ms`);
      if (codigo === 'interno') console.error(e);
      return responder(res, estado, { error: codigo, detalle });
    }
  });
}
