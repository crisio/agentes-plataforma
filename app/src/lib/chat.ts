// Cliente del chat (docs/fase-2-chat-contrato.md): conversaciones guardadas y respuestas en streaming (SSE).
import { ApiError } from '@/lib/api';

export type Herr = { id?: string; nombre: string; estado: 'corriendo' | 'lista' | 'error'; ms?: number };
export type Columna = { clave: string; titulo: string; tipo?: 'texto' | 'numero' | 'moneda' | 'fecha' | 'estado' };
export type Tarjeta = { titulo: string; subtitulo?: string; valor?: string; etiqueta?: string; detalle?: { nombre: string; valor: string }[] };
/** Vista de datos que arma el agente con lo que ya trajo (adenda 11-nov del contrato). */
export type Vista = {
  id?: string; tipo: 'tabla' | 'tarjetas' | 'resumen' | 'archivo'; titulo: string; subtitulo?: string;
  columnas?: Columna[]; filas?: Record<string, unknown>[]; tarjetas?: Tarjeta[]; cifras?: { nombre: string; valor: string; nota?: string }[];
  url?: string; vence?: string;
};
export type Mensaje = { id?: number; clave: string; rol: 'usuario' | 'agente'; texto: string; herramientas: Herr[]; vistas: Vista[]; sugerencias: string[]; error?: string | null; momentoUtc?: string };
export type ConversacionResumen = { id: number; titulo: string | null; actualizadaUtc: string; ultimo?: { texto: string; rol: 'usuario' | 'agente' } | null };
export type Conversacion = { id: number; agente: string; titulo: string | null; mensajes: { id: number; rol: 'usuario' | 'agente'; texto: string; herramientas: Herr[] | string | null; vistas?: Vista[] | string | null; sugerencias?: string[] | string | null; momentoUtc: string; error: string | null }[] };

export type Evento =
  | { tipo: 'inicio'; conversacionId: number; mensajeUsuarioId?: number }
  | { tipo: 'texto'; delta: string }
  | { tipo: 'herramienta'; id?: string; nombre: string; estado: Herr['estado']; ms?: number }
  | { tipo: 'vista'; vista: Vista }
  | { tipo: 'sugerencias'; opciones: string[] }
  | { tipo: 'fin'; mensajeId?: number }
  | { tipo: 'error'; codigo: string; detalle?: string };

/** Las herramientas guardadas pueden venir como JSON en texto. */
export function herramientasDe(h: Herr[] | string | null | undefined): Herr[] {
  if (!h) return [];
  if (Array.isArray(h)) return h;
  try { const j = JSON.parse(h); return Array.isArray(j) ? j : []; } catch { return []; }
}

/** Lo guardado puede venir como JSON en texto o ya como arreglo. */
export function arregloDe<T>(v: T[] | string | null | undefined): T[] {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try { const j = JSON.parse(v); return Array.isArray(j) ? j : []; } catch { return []; }
}

/** Envía un mensaje y va entregando los eventos a medida que llegan. */
export async function enviar(agente: string, cuerpo: { conversacionId?: number; texto: string }, alEvento: (e: Evento) => void, senal?: AbortSignal) {
  let r: Response;
  try {
    r = await fetch(`/api/chat/${encodeURIComponent(agente)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', 'X-Agentes': '1' },
      credentials: 'same-origin',
      body: JSON.stringify(cuerpo),
      signal: senal,
    });
  } catch (e) {
    if ((e as { name?: string })?.name === 'AbortError') throw e;
    throw new ApiError(0, 'No hay conexión con el servidor.');
  }
  if (r.status === 401) { window.location.assign('/entrar'); throw new ApiError(401, 'La sesión terminó.'); }
  if (!r.ok || !r.body) {
    let codigo = 'error';
    try { const j = await r.json(); if (typeof j?.error === 'string') codigo = j.error; } catch { /* sin cuerpo */ }
    alEvento({ tipo: 'error', codigo: r.status === 404 && codigo === 'error' ? 'chat_no_disponible' : codigo });
    return;
  }

  const lector = r.body.getReader();
  const dec = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await lector.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let corte: number;
    while ((corte = buffer.indexOf('\n\n')) >= 0) {
      const bloque = buffer.slice(0, corte);
      buffer = buffer.slice(corte + 2);
      let tipo = 'message';
      const datos: string[] = [];
      for (const linea of bloque.split('\n')) {
        if (linea.startsWith('event:')) tipo = linea.slice(6).trim();
        else if (linea.startsWith('data:')) datos.push(linea.slice(5).replace(/^ /, ''));
      }
      if (!datos.length) continue;
      let d: Record<string, unknown> = {};
      try { d = JSON.parse(datos.join('\n')); } catch { continue; }
      // La vista trae su propio «tipo» (tabla, tarjetas…): va envuelta para no pisar el del evento.
      alEvento(tipo === 'vista' ? { tipo: 'vista', vista: d as unknown as Vista } : ({ ...d, tipo } as Evento));
    }
  }
}

/** Texto claro para cada error del contrato. */
export function textoErrorChat(codigo: string, agente: string): string {
  switch (codigo) {
    case 'sin_llave_modelo': return 'Falta cargar la llave del modelo en la Bóveda (secreto «modelo/openrouter»).';
    case 'sellada': return 'La bóveda está sellada. Un custodio tiene que abrirla con su parte para que los agentes trabajen.';
    case 'sin_conexion': return `Todavía no conectas tu cuenta de ${agente}.`;
    case 'reconectar': return `Tu acceso a ${agente} venció. Conéctalo de nuevo.`;
    case 'modelo_no_disponible': return 'El modelo no respondió. Inténtalo en un momento.';
    case 'tiempo_agotado': return 'Se tardó demasiado en responder. Prueba con una pregunta más acotada.';
    case 'sin_permiso': return `No tienes acceso a ${agente}.`;
    case 'chat_no_disponible': return 'El chat todavía no está activo en el servidor.';
    case 'texto_invalido': return 'El mensaje está vacío o es demasiado largo (máximo 4000 caracteres).';
    default: return 'No se pudo completar la respuesta. Inténtalo de nuevo.';
  }
}

const VERBOS: Record<string, string> = {
  buscar: 'Buscando', consultar: 'Consultando', leer: 'Leyendo', ver: 'Revisando', detalle: 'Revisando', estado: 'Revisando',
  reporte: 'Armando el reporte de', ranking: 'Armando el ranking de', proyeccion: 'Proyectando', historial: 'Revisando el historial de',
  pagos: 'Revisando pagos', cuadro: 'Armando el cuadro de', libro: 'Revisando el libro de', alerta: 'Revisando alertas de',
  ventas: 'Revisando ventas', productos: 'Revisando productos', vencimientos: 'Revisando vencimientos', mandar: 'Preparando',
};

/** «buscar_ordenes» → «Buscando órdenes…» mientras corre; «buscar ordenes» cuando ya terminó. */
export function etiquetaHerramienta(nombre: string, corriendo: boolean): string {
  const partes = nombre.split('_');
  const legible = nombre.replace(/_/g, ' ').replace(/\bordenes\b/g, 'órdenes').replace(/\bimportacion(es)?\b/g, 'importación$1');
  if (!corriendo) return legible.charAt(0).toUpperCase() + legible.slice(1);
  const v = VERBOS[partes[0]];
  if (!v) return `Consultando ${legible}…`;
  const resto = legible.split(' ').slice(1).join(' ');
  return resto ? `${v} ${resto}…` : `${v}…`;
}
