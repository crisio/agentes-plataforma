// Dependencias reales del turno: llave del modelo desde la bóveda y herramientas desde el ejecutor.
import type { TokenServicio } from '../../ejecutor/src/token-servicio.ts';
import { ErrorTurno, type HerramientaSistema } from './turno.ts';

const CACHE_LLAVE_MS = 5 * 60_000;
const CACHE_HERRAMIENTAS_MS = 5 * 60_000;

async function post(url: string, token: string, cuerpo: object, ms: number): Promise<{ estado: number; json: any }> {
  let res: Response;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Servicio ' + token }, body: JSON.stringify(cuerpo), signal: AbortSignal.timeout(ms) });
  } catch (e) {
    throw new ErrorTurno((e as { name?: string })?.name === 'TimeoutError' ? 'tiempo_agotado' : 'servicio_no_disponible');
  }
  return { estado: res.status, json: await res.json().catch(() => ({})) };
}

export function crearLlave(tokens: TokenServicio, boveda: string, nombre = 'modelo/openrouter') {
  let cache: { valor: string; vence: number } | null = null;
  return async (usuarioId: number): Promise<string> => {
    if (cache && cache.vence > Date.now()) return cache.valor;
    const r = await post(boveda + '/v1/modelo/entregar', tokens.crear('orquestador', usuarioId, null, 'modelo_entregar'), { nombre }, 15_000);
    if (r.estado === 423) throw new ErrorTurno('sellada');
    if (r.estado === 409 && r.json?.error === 'no_inicializada') throw new ErrorTurno('no_inicializada');
    if (r.estado === 404) throw new ErrorTurno('sin_llave_modelo');
    if (r.estado !== 200 || typeof r.json.valor !== 'string') throw new ErrorTurno('servicio_no_disponible', 'boveda ' + r.estado);
    cache = { valor: r.json.valor, vence: Date.now() + CACHE_LLAVE_MS };
    return cache.valor;
  };
}

function errorEjecutor(estado: number, json: any): ErrorTurno {
  const codigo = typeof json?.error === 'string' ? json.error : 'servicio_no_disponible';
  if (estado === 423) return new ErrorTurno('sellada');
  if (codigo === 'no_inicializada') return new ErrorTurno('no_inicializada');
  return new ErrorTurno(codigo, typeof json?.detalle === 'string' ? json.detalle : undefined);
}

export function crearEjecutor(tokens: TokenServicio, ejecutor: string) {
  const cache = new Map<string, { lista: HerramientaSistema[]; vence: number }>();
  return {
    async herramientas(sistema: string, usuarioId: number): Promise<HerramientaSistema[]> {
      const k = `${sistema}:${usuarioId}`;
      const c = cache.get(k);
      if (c && c.vence > Date.now()) return c.lista;
      const r = await post(`${ejecutor}/v1/conexiones/${sistema}/herramientas`, tokens.crear('orquestador', usuarioId, null, 'conexion_herramientas'), {}, 40_000);
      if (r.estado !== 200) { cache.delete(k); throw errorEjecutor(r.estado, r.json); }
      const lista = (r.json.herramientas ?? []) as HerramientaSistema[];
      cache.set(k, { lista, vence: Date.now() + CACHE_HERRAMIENTAS_MS });
      return lista;
    },
    async llamar(sistema: string, usuarioId: number, nombre: string, args: Record<string, unknown>): Promise<unknown> {
      const r = await post(`${ejecutor}/v1/conexiones/${sistema}/llamar`, tokens.crear('orquestador', usuarioId, null, 'conexion_llamar'), { nombre, argumentos: args }, 260_000);
      if (r.estado !== 200) throw errorEjecutor(r.estado, r.json);
      return r.json;
    },
  };
}
