// Cliente de la bóveda para las conexiones de las personas («conexion/…»). El valor nunca se registra.
import type { TokenServicio } from './token-servicio.ts';

export class ErrorBoveda extends Error {
  readonly codigo: string; readonly estado: number;
  constructor(codigo: string, estado: number) { super(codigo); this.codigo = codigo; this.estado = estado; }
}

export interface Almacen {
  leer(nombre: string, usuarioId: number): Promise<string | null>;
  guardar(nombre: string, valor: string, usuarioId: number, descripcion?: string): Promise<void>;
  borrar(nombre: string, usuarioId: number): Promise<void>;
}

export class ClienteBoveda implements Almacen {
  readonly base: string; readonly tokens: TokenServicio;
  constructor(base: string, tokens: TokenServicio) { this.base = base; this.tokens = tokens; }

  async #llamar(ruta: string, accion: string, usuarioId: number, cuerpo: object): Promise<{ estado: number; json: any }> {
    let res: Response;
    try {
      res = await fetch(this.base + ruta, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Servicio ' + this.tokens.crear('ejecutor', usuarioId, null, accion) },
        body: JSON.stringify(cuerpo),
        signal: AbortSignal.timeout(15_000),
      });
    } catch { throw new ErrorBoveda('boveda_no_disponible', 503); }
    const json = await res.json().catch(() => ({}));
    return { estado: res.status, json };
  }

  async leer(nombre: string, usuarioId: number): Promise<string | null> {
    const r = await this.#llamar('/v1/conexion/leer', 'conexion_leer', usuarioId, { nombre });
    if (r.estado === 404) return null;
    if (r.estado !== 200) throw new ErrorBoveda(r.json?.error ?? 'boveda_error', r.estado);
    return r.json.valor as string;
  }

  async guardar(nombre: string, valor: string, usuarioId: number, descripcion?: string): Promise<void> {
    const r = await this.#llamar('/v1/conexion/guardar', 'conexion_guardar', usuarioId, { nombre, valor, descripcion });
    if (r.estado !== 200) throw new ErrorBoveda(r.json?.error ?? 'boveda_error', r.estado);
  }

  async borrar(nombre: string, usuarioId: number): Promise<void> {
    const r = await this.#llamar('/v1/conexion/borrar', 'conexion_borrar', usuarioId, { nombre });
    if (r.estado !== 200) throw new ErrorBoveda(r.json?.error ?? 'boveda_error', r.estado);
  }
}
