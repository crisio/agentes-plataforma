// Token de servicio compatible con Agentes.Comun/TokenServicio.cs:
// base64url(json camelCase) + "." + base64url(HMAC-SHA256(clave, base64url(json))). Vence en ≤ 60 s; cada jti una vez.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export type Reclamos = { svc: string; usr: number | null; agt: number | null; acc: string; exp: number; jti: string };

const b64url = (b: Buffer) => b.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const deB64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
export const VIGENCIA_MAXIMA = 60;

export class TokenServicio {
  readonly #clave: Buffer;
  readonly #vistos = new Map<string, number>();
  readonly #reloj: () => number;

  constructor(clave: Buffer, reloj: () => number = () => Math.floor(Date.now() / 1000)) {
    if (clave.length < 32) throw new Error('La clave de servicio debe tener al menos 32 bytes.');
    this.#clave = clave;
    this.#reloj = reloj;
  }

  /** Lee AGENTES_CLAVE_SERVICIO (32 bytes en base64). Si falta, el servicio no arranca. */
  static desdeEntorno(): TokenServicio {
    const b64 = process.env.AGENTES_CLAVE_SERVICIO;
    if (!b64) throw new Error('Falta AGENTES_CLAVE_SERVICIO (32 bytes en base64). El ejecutor no arranca sin ella.');
    return new TokenServicio(Buffer.from(b64, 'base64'));
  }

  crear(svc: string, usr: number | null, agt: number | null, acc: string, vigencia = 30): string {
    const rec: Reclamos = { svc, usr, agt, acc, exp: this.#reloj() + vigencia, jti: randomUUID().replace(/-/g, '') };
    const cuerpo = b64url(Buffer.from(JSON.stringify(rec)));
    return cuerpo + '.' + b64url(createHmac('sha256', this.#clave).update(cuerpo, 'ascii').digest());
  }

  validar(token: string | undefined, svc: string, acc?: string): { ok: true; rec: Reclamos } | { ok: false; error: string } {
    if (!token || token.length > 2048) return { ok: false, error: 'formato' };
    const partes = token.split('.');
    if (partes.length !== 2 || !partes[0] || !partes[1]) return { ok: false, error: 'formato' };
    const esperada = createHmac('sha256', this.#clave).update(partes[0], 'ascii').digest();
    const firma = deB64url(partes[1]);
    if (firma.length !== esperada.length || !timingSafeEqual(firma, esperada)) return { ok: false, error: 'firma' };
    let rec: Reclamos;
    try {
      const j = JSON.parse(deB64url(partes[0]).toString('utf8'));
      rec = { svc: j.svc ?? j.Svc, usr: j.usr ?? j.Usr ?? null, agt: j.agt ?? j.Agt ?? null, acc: j.acc ?? j.Acc, exp: j.exp ?? j.Exp, jti: j.jti ?? j.Jti };
    } catch { return { ok: false, error: 'formato' }; }
    if (!rec.jti || !rec.svc || !rec.acc || typeof rec.exp !== 'number') return { ok: false, error: 'formato' };
    const ahora = this.#reloj();
    if (rec.exp <= ahora) return { ok: false, error: 'vencido' };
    if (rec.exp > ahora + VIGENCIA_MAXIMA) return { ok: false, error: 'vigencia_excesiva' };
    if (rec.svc !== svc) return { ok: false, error: 'servicio' };
    if (acc !== undefined && rec.acc !== acc) return { ok: false, error: 'accion' };
    for (const [j, exp] of this.#vistos) if (exp <= ahora) this.#vistos.delete(j);
    if (this.#vistos.has(rec.jti)) return { ok: false, error: 'repetido' };
    this.#vistos.set(rec.jti, rec.exp);
    return { ok: true, rec };
  }
}
