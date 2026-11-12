// Un turno de chat: historial + texto nuevo → modelo ↔ herramientas (máx. 6 vueltas, 120 s) → eventos.
import { AGENTES } from './agentes.ts';
import { ErrorModelo, type FuncionModelo, type HerramientaModelo, type MensajeModelo } from './modelo.ts';
import { DEFINICIONES_PROPIAS, enlacesDeArchivo, HERRAMIENTAS_PROPIAS, NOMBRE_VISTA, validarSugerencias, validarVista, type Vista } from './vistas.ts';

export const MAX_VUELTAS = 6;
export const MAX_MS = 120_000;
export const MAX_RESULTADO = 12_000;
const MAX_HISTORIAL = 30;
const MAX_CHARS_HISTORIAL = 60_000;

export type Evento =
  | { tipo: 'texto'; delta: string }
  | { tipo: 'herramienta'; id: string; nombre: string; estado: 'corriendo' | 'lista' | 'error'; ms?: number }
  | { tipo: 'vista'; vista: Vista & { id: string } }
  | { tipo: 'sugerencias'; opciones: string[] }
  | { tipo: 'fin' }
  | { tipo: 'error'; codigo: string; detalle?: string };

export type HerramientaSistema = { name: string; description?: string; inputSchema?: unknown };

/** Lo que el turno necesita del mundo; en producción son la bóveda, el ejecutor y OpenRouter. */
export type Dependencias = {
  llave: (usuarioId: number) => Promise<string>;
  herramientas: (sistema: string, usuarioId: number) => Promise<HerramientaSistema[]>;
  llamar: (sistema: string, usuarioId: number, nombre: string, args: Record<string, unknown>) => Promise<unknown>;
  modelo: FuncionModelo;
  nombreModelo: string;
  ahora?: () => Date;
};

export class ErrorTurno extends Error {
  readonly codigo: string;
  constructor(codigo: string, detalle?: string) { super(detalle ?? codigo); this.codigo = codigo; }
}

export type PeticionTurno = { agente: string; historial: { rol: string; texto: string }[]; texto: string };

/** Texto de un resultado MCP (content[].text), recortado. */
export function textoResultado(r: unknown): { texto: string; error: boolean } {
  const o = r as { content?: { type?: string; text?: string }[]; isError?: boolean } | null;
  let t = Array.isArray(o?.content) ? o!.content.filter((c) => c?.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n') : '';
  if (!t) t = JSON.stringify(r ?? null);
  if (t.length > MAX_RESULTADO) t = t.slice(0, MAX_RESULTADO) + `\n[… recortado: el resultado tenía ${t.length} caracteres]`;
  return { texto: t, error: o?.isError === true };
}

function historialAMensajes(h: PeticionTurno['historial']): MensajeModelo[] {
  const ultimos = h.filter((m) => (m.rol === 'usuario' || m.rol === 'agente') && typeof m.texto === 'string' && m.texto).slice(-MAX_HISTORIAL);
  let total = 0;
  const salida: MensajeModelo[] = [];
  for (let i = ultimos.length - 1; i >= 0; i--) {
    total += ultimos[i].texto.length;
    if (total > MAX_CHARS_HISTORIAL) break;
    salida.unshift(ultimos[i].rol === 'usuario' ? { role: 'user', content: ultimos[i].texto } : { role: 'assistant', content: ultimos[i].texto });
  }
  return salida;
}

export async function correrTurno(p: PeticionTurno, usuarioId: number, deps: Dependencias, emitir: (e: Evento) => void, senalExterna?: AbortSignal): Promise<void> {
  const cfg = AGENTES[p.agente];
  if (!cfg) throw new ErrorTurno('agente_desconocido');
  if (!cfg.sistema) throw new ErrorTurno('sin_conexion', `${cfg.nombre} todavía no está conectado a la plataforma.`);

  const control = new AbortController();
  const tope = setTimeout(() => control.abort(), MAX_MS);
  const alCortar = () => control.abort();
  senalExterna?.addEventListener('abort', alCortar);
  try {
    const [llave, lista] = await Promise.all([deps.llave(usuarioId), deps.herramientas(cfg.sistema, usuarioId)]);
    // Las del sistema no pueden llamarse igual que las propias de la plataforma.
    const permitidas = lista.filter((h) => !cfg.excluir.has(h.name) && !HERRAMIENTAS_PROPIAS.has(h.name) && /^[A-Za-z0-9_-]{1,64}$/.test(h.name));
    const herramientas: HerramientaModelo[] = permitidas.map((h) => ({
      type: 'function',
      function: { name: h.name, description: (h.description ?? '').slice(0, 1024), parameters: h.inputSchema ?? { type: 'object', properties: {} } },
    }));
    herramientas.push(...DEFINICIONES_PROPIAS);
    const nombres = new Set(permitidas.map((h) => h.name));
    let nVistas = 0;
    const archivosVistos = new Set<string>();
    const emitirVista = (v: Vista) => emitir({ tipo: 'vista', vista: { id: `v${++nVistas}`, ...v } });
    const hoy = (deps.ahora?.() ?? new Date()).toLocaleDateString('es-HN', { timeZone: 'America/Tegucigalpa', weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' });

    const mensajes: MensajeModelo[] = [
      { role: 'system', content: `${cfg.instrucciones}\n\nHoy es ${hoy} (hora de Honduras).` },
      ...historialAMensajes(p.historial),
      { role: 'user', content: p.texto },
    ];

    for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
      const ultima = vuelta === MAX_VUELTAS - 1;
      const r = await deps.modelo({ llave, modelo: deps.nombreModelo, mensajes, herramientas, senal: control.signal, soloTexto: ultima },
        (delta) => emitir({ tipo: 'texto', delta }));
      if (!r.llamadas.length) { emitir({ tipo: 'fin' }); return; }

      mensajes.push({ role: 'assistant', content: r.texto || null, tool_calls: r.llamadas });
      for (const ll of r.llamadas) {
        const nombre = ll.function.name;
        const inicio = Date.now();
        const propia = HERRAMIENTAS_PROPIAS.has(nombre);   // las propias no se muestran como herramienta en curso
        if (!propia) emitir({ tipo: 'herramienta', id: ll.id, nombre, estado: 'corriendo' });
        let contenido: string;
        let fallo = false;
        if (HERRAMIENTAS_PROPIAS.has(nombre)) {
          // Propias: no llaman a nadie; validan y emiten el evento. Un error vuelve al modelo para que corrija.
          let args: Record<string, unknown> | null = null;
          try { const a = JSON.parse(ll.function.arguments || '{}'); if (a && typeof a === 'object' && !Array.isArray(a)) args = a; } catch { /* abajo */ }
          if (!args) { contenido = 'Los argumentos no eran JSON válido.'; fallo = true; }
          else if (nombre === NOMBRE_VISTA) {
            const v = validarVista(args);
            if (v.ok) { emitirVista(v.vista); contenido = JSON.stringify({ ok: true, ...(v.recortes.length ? { aviso: v.recortes.join('; ') } : {}) }); }
            else { contenido = JSON.stringify({ ok: false, error: v.error }); fallo = true; }
          } else {
            const v = validarSugerencias(args);
            if (v.ok) { emitir({ tipo: 'sugerencias', opciones: v.opciones }); contenido = JSON.stringify({ ok: true }); }
            else { contenido = JSON.stringify({ ok: false, error: v.error }); fallo = true; }
          }
        }
        else if (!nombres.has(nombre)) { contenido = `La herramienta «${nombre}» no está disponible en este chat.`; fallo = true; }
        else {
          let args: Record<string, unknown> = {};
          try { const a = JSON.parse(ll.function.arguments || '{}'); if (a && typeof a === 'object' && !Array.isArray(a)) args = a; }
          catch { fallo = true; }
          if (fallo) contenido = 'Los argumentos no eran JSON válido.';
          else {
            try {
              const res = textoResultado(await deps.llamar(cfg.sistema, usuarioId, nombre, args));
              contenido = res.texto; fallo = res.error;
              if (!fallo) for (const a of enlacesDeArchivo(res.texto, deps.ahora?.() ?? new Date())) {
                if (a.tipo === 'archivo' && !archivosVistos.has(a.url)) { archivosVistos.add(a.url); emitirVista(a); }
              }
            } catch (e) {
              const codigo = (e as { codigo?: string })?.codigo ?? 'error';
              if (codigo === 'reconectar' || codigo === 'sin_conexion' || codigo === 'sellada' || codigo === 'no_inicializada') throw new ErrorTurno(codigo);
              contenido = `La herramienta falló (${codigo}).`; fallo = true;
            }
          }
        }
        if (!propia) emitir({ tipo: 'herramienta', id: ll.id, nombre, estado: fallo ? 'error' : 'lista', ms: Date.now() - inicio });
        mensajes.push({ role: 'tool', tool_call_id: ll.id, content: contenido });
        if (control.signal.aborted) throw new ErrorTurno('tiempo_agotado');
      }
    }
    emitir({ tipo: 'fin' });
  } catch (e) {
    if (e instanceof ErrorTurno || e instanceof ErrorModelo) throw new ErrorTurno(e.codigo, e.message !== e.codigo ? e.message : undefined);
    if (control.signal.aborted) throw new ErrorTurno('tiempo_agotado');
    throw e;
  } finally {
    clearTimeout(tope);
    senalExterna?.removeEventListener('abort', alCortar);
  }
}
