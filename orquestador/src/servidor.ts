// Servidor del orquestador (127.0.0.1:9943). Solo el gateway le habla, con token de servicio. Sin estado: el gateway
// manda el historial y guarda lo que vuelve. Responde en SSE: texto, herramienta, fin | error.
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { TokenServicio } from '../../ejecutor/src/token-servicio.ts';
import { correrTurno, ErrorTurno, type Dependencias, type Evento } from './turno.ts';

function json(res: ServerResponse, estado: number, cuerpo: unknown) {
  res.writeHead(estado, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(cuerpo));
}

export function crearServidor(tokens: TokenServicio, deps: Dependencias): Server {
  return createServer(async (req, res) => {
    const ip = req.socket.remoteAddress ?? '';
    if (!(ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1')) return json(res, 403, { error: 'solo_local' });
    const ruta = new URL(req.url ?? '/', 'http://x').pathname;
    if (req.method === 'GET' && ruta === '/v1/salud') return json(res, 200, { ok: true, modelo: deps.nombreModelo });
    if (req.method !== 'POST' || ruta !== '/v1/turno') return json(res, 404, { error: 'ruta' });

    const cab = req.headers.authorization ?? '';
    const v = tokens.validar(cab.startsWith('Servicio ') ? cab.slice(9).trim() : undefined, 'gateway', 'chat_turno');
    if (!v.ok) { console.warn(`token rechazado (${v.error})`); return json(res, 401, { error: 'token_invalido' }); }
    const usuarioId = v.rec.usr;
    if (!usuarioId) return json(res, 400, { error: 'usuario_requerido' });

    let body: any;
    try {
      let total = 0; const trozos: Buffer[] = [];
      for await (const t of req) { total += t.length; if (total > 1024 * 1024) return json(res, 413, { error: 'cuerpo_grande' }); trozos.push(t as Buffer); }
      body = JSON.parse(Buffer.concat(trozos).toString('utf8'));
    } catch { return json(res, 400, { error: 'json_invalido' }); }
    const texto = typeof body?.texto === 'string' ? body.texto.trim() : '';
    const agente = typeof body?.agente === 'string' ? body.agente : '';
    const historial = Array.isArray(body?.historial) ? body.historial : [];
    if (!texto || texto.length > 4000 || !agente) return json(res, 400, { error: 'peticion_invalida' });

    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const corte = new AbortController();
    res.on('close', () => { if (!res.writableFinished) corte.abort(); });
    const emitir = (e: Evento) => {
      if (res.writableEnded) return;
      const { tipo, ...resto } = e;
      const datos = e.tipo === 'vista' ? e.vista : resto;   // contrato: la data de «vista» es { id, ...vista }
      res.write(`event: ${tipo}\ndata: ${JSON.stringify(datos)}\n\n`);
    };
    // Mantiene viva la conexión mientras corre una herramienta larga.
    const latido = setInterval(() => { if (!res.writableEnded) res.write(': latido\n\n'); }, 15_000);

    const inicio = Date.now();
    let herramientas = 0;
    try {
      await correrTurno({ agente, historial, texto }, usuarioId, deps, (e) => { if (e.tipo === 'herramienta' && e.estado === 'corriendo') herramientas++; emitir(e); }, corte.signal);
      console.log(`${new Date().toISOString()} turno ${agente} u${usuarioId} ok ${herramientas} herr. ${Date.now() - inicio}ms`);
    } catch (e) {
      const codigo = e instanceof ErrorTurno ? e.codigo : 'interno';
      const detalle = e instanceof ErrorTurno && e.message !== e.codigo ? e.message.slice(0, 200) : undefined;
      if (codigo === 'interno') console.error(e);
      console.warn(`${new Date().toISOString()} turno ${agente} u${usuarioId} ${codigo} ${Date.now() - inicio}ms`);
      emitir({ tipo: 'error', codigo, detalle });
    } finally {
      clearInterval(latido);
      res.end();
    }
  });
}
