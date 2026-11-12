import { api, ApiError } from '@/lib/api';
import type { Agente } from '@/lib/tipos';
import type { Conexion } from '@/components/Conectar';

export type Ultimo = { conversacionId: number; texto: string; rol: 'usuario' | 'agente'; momentoUtc: string };
export type Atencion = { motivo: 'sin_leer' | 'reconectar' | 'error'; cantidad?: number; conversacionId?: number };
export type AgenteInicio = Agente & {
  conectable: boolean;
  atencion?: Atencion | null;
  conexion: { estado: Conexion['estado']; herramientas: number | null } | null;
  ultimo: Ultimo | null;
};

/**
 * La lista de inicio (GET /api/inicio). Si el gateway todavía no la tiene (404 en un despliegue anterior), se arma
 * con /api/agentes y /api/conexiones, sin últimos mensajes.
 */
export async function cargarInicio(): Promise<{ agentes: AgenteInicio[]; atencion: number }> {
  try {
    const d = await api<{ agentes: AgenteInicio[]; atencion?: number }>('/inicio');
    const agentes = d.agentes ?? [];
    return { agentes, atencion: typeof d.atencion === 'number' ? d.atencion : agentes.filter((a) => a.atencion).length };
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 404) throw e;
    const [ag, cx] = await Promise.all([
      api<Agente[] | { agentes: Agente[] }>('/agentes'),
      api<{ conectables: string[]; conexiones: Conexion[] }>('/conexiones').catch(() => ({ conectables: [] as string[], conexiones: [] as Conexion[] })),
    ]);
    const lista = Array.isArray(ag) ? ag : ag.agentes ?? [];
    const agentes = lista.map((a) => {
      const c = cx.conexiones.find((x) => x.agente === a.clave);
      return { ...a, conectable: cx.conectables.includes(a.clave), conexion: c ? { estado: c.estado, herramientas: c.herramientas } : null, ultimo: null };
    });
    return { agentes, atencion: 0 };
  }
}

/** «5:36 p. m.» hoy, «ayer», el día de la semana esta semana, y si no la fecha corta. */
export function horaCorta(iso: string): string {
  const d = new Date(iso);
  const hoy = new Date();
  const dias = Math.floor((new Date(hoy.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86400_000);
  if (dias <= 0) return d.toLocaleTimeString('es-HN', { hour: 'numeric', minute: '2-digit' });
  if (dias === 1) return 'ayer';
  if (dias < 7) return d.toLocaleDateString('es-HN', { weekday: 'long' });
  return d.toLocaleDateString('es-HN', { day: 'numeric', month: 'short' });
}

/** Lo que dice la fila de un agente cuando todavía no hay conversación. */
export function estadoHonesto(a: AgenteInicio): { texto: string; apagado: boolean } {
  if (!a.conectable) return { texto: 'Todavía no está conectado a la plataforma', apagado: true };
  if (a.conexion?.estado === 'conectada') return { texto: `Conectado · ${a.conexion.herramientas ?? 0} herramientas · escríbele`, apagado: false };
  if (a.conexion?.estado === 'reconectar') return { texto: 'Tu acceso venció · reconéctalo', apagado: false };
  return { texto: `Conecta tu cuenta de ${a.nombre} para conversar`, apagado: false };
}

/** Por qué un agente pide atención, en una línea. */
export function motivoAtencion(a: AgenteInicio): string {
  const t = a.atencion;
  if (!t) return '';
  if (t.motivo === 'sin_leer') return (t.cantidad ?? 1) === 1 ? '1 mensaje sin leer' : `${t.cantidad} mensajes sin leer`;
  if (t.motivo === 'reconectar') return 'Tu acceso venció: reconecta';
  return 'La última respuesta falló';
}
