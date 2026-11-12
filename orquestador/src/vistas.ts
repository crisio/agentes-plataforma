// Herramientas propias de la plataforma: no llaman a nadie, solo producen eventos para la app.
// mostrar_vista arma una tabla/tarjetas/resumen con datos que el modelo YA trajo; sugerir_respuestas pone botones.
import type { HerramientaModelo } from './modelo.ts';

export const MAX_FILAS = 500;
export const MAX_TARJETAS = 30;
export const MAX_COLUMNAS = 12;
export const MAX_CELDA = 300;
export const MAX_CIFRAS = 12;
export const MAX_DETALLE = 12;
export const MAX_OPCIONES = 4;
export const MAX_OPCION = 40;

const TIPOS_VISTA = ['tabla', 'tarjetas', 'resumen'] as const;
const TIPOS_COLUMNA = ['texto', 'numero', 'moneda', 'fecha', 'estado'] as const;

export type Columna = { clave: string; titulo: string; tipo?: (typeof TIPOS_COLUMNA)[number] };
export type Tarjeta = { titulo: string; subtitulo?: string; valor?: string; etiqueta?: string; detalle?: { nombre: string; valor: string }[] };
export type Vista =
  | { tipo: 'tabla'; titulo: string; subtitulo?: string; columnas: Columna[]; filas: Record<string, string | number | null>[] }
  | { tipo: 'tarjetas'; titulo: string; subtitulo?: string; tarjetas: Tarjeta[] }
  | { tipo: 'resumen'; titulo: string; subtitulo?: string; cifras: { nombre: string; valor: string; nota?: string }[] }
  | { tipo: 'archivo'; titulo: string; url: string; vence?: string };

export const NOMBRE_VISTA = 'mostrar_vista';
export const NOMBRE_SUGERENCIAS = 'sugerir_respuestas';
export const HERRAMIENTAS_PROPIAS = new Set([NOMBRE_VISTA, NOMBRE_SUGERENCIAS]);

export const DEFINICIONES_PROPIAS: HerramientaModelo[] = [
  {
    type: 'function',
    function: {
      name: NOMBRE_VISTA,
      description: 'Muestra en la app una tabla, tarjetas o un resumen de cifras con datos que YA trajiste de otra herramienta (nunca inventados). '
        + 'Úsala cuando la respuesta tenga más de 3 filas o varias cifras; en el texto deja solo un resumen corto. '
        + `Límites: ${MAX_FILAS} filas, ${MAX_COLUMNAS} columnas, ${MAX_TARJETAS} tarjetas.`,
      parameters: {
        type: 'object',
        required: ['tipo', 'titulo'],
        properties: {
          tipo: { type: 'string', enum: [...TIPOS_VISTA] },
          titulo: { type: 'string' },
          subtitulo: { type: 'string' },
          columnas: {
            type: 'array', description: 'Para tipo tabla: columnas en orden.',
            items: { type: 'object', required: ['clave', 'titulo'], properties: { clave: { type: 'string' }, titulo: { type: 'string' }, tipo: { type: 'string', enum: [...TIPOS_COLUMNA] } } },
          },
          filas: { type: 'array', description: 'Para tipo tabla: objetos con las claves de las columnas.', items: { type: 'object' } },
          tarjetas: {
            type: 'array', description: 'Para tipo tarjetas.',
            items: {
              type: 'object', required: ['titulo'],
              properties: {
                titulo: { type: 'string' }, subtitulo: { type: 'string' }, valor: { type: 'string' }, etiqueta: { type: 'string' },
                detalle: { type: 'array', items: { type: 'object', properties: { nombre: { type: 'string' }, valor: { type: 'string' } } } },
              },
            },
          },
          cifras: {
            type: 'array', description: 'Para tipo resumen.',
            items: { type: 'object', required: ['nombre', 'valor'], properties: { nombre: { type: 'string' }, valor: { type: 'string' }, nota: { type: 'string' } } },
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: NOMBRE_SUGERENCIAS,
      description: `Pone de 2 a ${MAX_OPCIONES} botones de respuesta rápida bajo tu mensaje: los siguientes pasos más útiles, `
        + `cada uno en primera persona de quien pregunta y de máximo ${MAX_OPCION} caracteres (p. ej. «Ver la PO 0012»).`,
      parameters: {
        type: 'object', required: ['opciones'],
        properties: { opciones: { type: 'array', items: { type: 'string' }, maxItems: MAX_OPCIONES } },
      },
    },
  },
];

const texto = (v: unknown, max = MAX_CELDA): string | undefined => {
  if (v === null || v === undefined) return undefined;
  const s = (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v)).trim();
  return s ? (s.length > max ? s.slice(0, max - 1) + '…' : s) : undefined;
};

function celda(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  return texto(v) ?? null;
}

/** Valida y recorta lo que mandó el modelo. Devuelve la vista o el error para devolvérselo como resultado. */
export function validarVista(a: Record<string, unknown>): { ok: true; vista: Vista; recortes: string[] } | { ok: false; error: string } {
  const tipo = a.tipo;
  if (typeof tipo !== 'string' || !(TIPOS_VISTA as readonly string[]).includes(tipo)) return { ok: false, error: `«tipo» debe ser uno de: ${TIPOS_VISTA.join(', ')}.` };
  const titulo = texto(a.titulo, 120);
  if (!titulo) return { ok: false, error: '«titulo» es obligatorio.' };
  const subtitulo = texto(a.subtitulo, 200);
  const recortes: string[] = [];

  if (tipo === 'tabla') {
    if (!Array.isArray(a.columnas) || a.columnas.length === 0) return { ok: false, error: 'Una tabla necesita «columnas» (al menos una, con clave y titulo).' };
    if (!Array.isArray(a.filas) || a.filas.length === 0) return { ok: false, error: 'Una tabla necesita «filas» con los datos que ya trajiste.' };
    const columnas: Columna[] = [];
    const vistas = new Set<string>();
    for (const c of a.columnas.slice(0, MAX_COLUMNAS)) {
      const clave = texto((c as any)?.clave, 60);
      if (!clave) return { ok: false, error: 'Cada columna necesita «clave».' };
      if (vistas.has(clave)) return { ok: false, error: `La columna «${clave}» está repetida.` };
      vistas.add(clave);
      const t = (c as any)?.tipo;
      columnas.push({ clave, titulo: texto((c as any)?.titulo, 60) ?? clave, ...((TIPOS_COLUMNA as readonly string[]).includes(t) ? { tipo: t } : {}) });
    }
    if (a.columnas.length > MAX_COLUMNAS) recortes.push(`columnas recortadas a ${MAX_COLUMNAS}`);
    const filas: Record<string, string | number | null>[] = [];
    for (const f of a.filas.slice(0, MAX_FILAS)) {
      if (!f || typeof f !== 'object' || Array.isArray(f)) return { ok: false, error: 'Cada fila debe ser un objeto con las claves de las columnas.' };
      const fila: Record<string, string | number | null> = {};
      for (const c of columnas) fila[c.clave] = celda((f as Record<string, unknown>)[c.clave]);
      filas.push(fila);
    }
    if (filas.every((f) => columnas.every((c) => f[c.clave] === null))) return { ok: false, error: 'Ninguna fila tiene valores para esas columnas: revisa que las claves de las filas coincidan con las de las columnas.' };
    if (a.filas.length > MAX_FILAS) recortes.push(`filas recortadas a ${MAX_FILAS}`);
    return { ok: true, vista: { tipo, titulo, ...(subtitulo ? { subtitulo } : {}), columnas, filas }, recortes };
  }

  if (tipo === 'tarjetas') {
    if (!Array.isArray(a.tarjetas) || a.tarjetas.length === 0) return { ok: false, error: 'Faltan «tarjetas» (al menos una, con titulo).' };
    const tarjetas: Tarjeta[] = [];
    for (const t of a.tarjetas.slice(0, MAX_TARJETAS)) {
      const tt = texto((t as any)?.titulo, 120);
      if (!tt) return { ok: false, error: 'Cada tarjeta necesita «titulo».' };
      const det = Array.isArray((t as any)?.detalle) ? (t as any).detalle.slice(0, MAX_DETALLE)
        .map((d: any) => ({ nombre: texto(d?.nombre, 60), valor: texto(d?.valor) })).filter((d: any) => d.nombre && d.valor) : [];
      const tarjeta: Tarjeta = { titulo: tt };
      for (const k of ['subtitulo', 'valor', 'etiqueta'] as const) { const v = texto((t as any)?.[k], 120); if (v) tarjeta[k] = v; }
      if (det.length) tarjeta.detalle = det;
      tarjetas.push(tarjeta);
    }
    if (a.tarjetas.length > MAX_TARJETAS) recortes.push(`tarjetas recortadas a ${MAX_TARJETAS}`);
    return { ok: true, vista: { tipo, titulo, ...(subtitulo ? { subtitulo } : {}), tarjetas }, recortes };
  }

  if (!Array.isArray(a.cifras) || a.cifras.length === 0) return { ok: false, error: 'Un resumen necesita «cifras» (nombre y valor).' };
  const cifras = a.cifras.slice(0, MAX_CIFRAS).map((c: any) => {
    const nota = texto(c?.nota, 120);
    return { nombre: texto(c?.nombre, 60), valor: texto(c?.valor, 60), ...(nota ? { nota } : {}) };
  });
  if (cifras.some((c) => !c.nombre || !c.valor)) return { ok: false, error: 'Cada cifra necesita «nombre» y «valor».' };
  if (a.cifras.length > MAX_CIFRAS) recortes.push(`cifras recortadas a ${MAX_CIFRAS}`);
  return { ok: true, vista: { tipo: 'resumen', titulo, ...(subtitulo ? { subtitulo } : {}), cifras: cifras as { nombre: string; valor: string; nota?: string }[] }, recortes };
}

export function validarSugerencias(a: Record<string, unknown>): { ok: true; opciones: string[] } | { ok: false; error: string } {
  if (!Array.isArray(a.opciones)) return { ok: false, error: '«opciones» debe ser una lista de textos.' };
  const opciones = [...new Set(a.opciones.map((o) => (typeof o === 'string' ? o.replace(/\s+/g, ' ').trim() : '')).filter(Boolean))]
    .map((o) => (o.length > MAX_OPCION ? o.slice(0, MAX_OPCION - 1) + '…' : o)).slice(0, MAX_OPCIONES);
  if (!opciones.length) return { ok: false, error: 'Manda al menos una opción con texto.' };
  return { ok: true, opciones };
}

/** Enlaces de archivo que devuelve Hilo (vencen en 24 h): https://…/mcp/archivo/<token>. */
const RX_ARCHIVO = /https?:\/\/[^\s"'()<>\]]+\/mcp\/archivo\/[A-Za-z0-9_-]{8,}(?:\?[^\s"'()<>\]]*)?/g;

export function enlacesDeArchivo(texto: string, ahora = new Date()): Vista[] {
  const vistos = new Set<string>();
  const salida: Vista[] = [];
  for (const m of texto.matchAll(RX_ARCHIVO)) {
    const url = m[0].replace(/[.,;:]+$/, '');
    if (vistos.has(url) || salida.length >= 5) continue;
    vistos.add(url);
    // Título: lo que diga la línea donde aparece el enlace (sin el enlace), o uno genérico.
    const inicio = texto.lastIndexOf('\n', m.index ?? 0) + 1;
    const fin = texto.indexOf('\n', m.index ?? 0);
    const linea = texto.slice(inicio, fin < 0 ? undefined : fin).replace(m[0], '').replace(/[\[\]()*_`#>:\-–—.,;]+/g, ' ').replace(/\s+/g, ' ').trim();
    salida.push({ tipo: 'archivo', titulo: (linea && linea.length <= 120 ? linea : 'Archivo de Hilo'), url, vence: new Date(ahora.getTime() + 24 * 3600_000).toISOString() });
  }
  return salida;
}
