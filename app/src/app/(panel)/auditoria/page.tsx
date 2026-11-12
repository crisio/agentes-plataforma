'use client';
import Cabecera from '@/components/Cabecera';
import { useCallback, useEffect, useState } from 'react';
import { api, textoError } from '@/lib/api';

type Evento = {
  id: number | string;
  tipo: string;
  momentoUtc: string;
  usuarioId?: number | null;
  usuario?: string | null;
  agenteId?: number | null;
  canal?: string;
  objeto?: string | null;
  resultado?: string;
  detalle?: unknown;
};

const TIPOS: [string, string][] = [
  ['ingreso_codigo_enviado', 'Código enviado'], ['ingreso_ok', 'Ingreso'], ['ingreso_rechazado', 'Ingreso rechazado'],
  ['clave_creada', 'Clave creada'], ['sesion_cerrada', 'Sesión cerrada'], ['usuario_creado', 'Usuario creado'],
  ['usuario_modificado', 'Usuario modificado'], ['rol_cambiado', 'Rol cambiado'], ['permiso_agente_cambiado', 'Permiso de agente'],
  ['boveda_inicializada', 'Bóveda inicializada'], ['boveda_abierta', 'Bóveda abierta'], ['boveda_parte_rechazada', 'Parte rechazada'],
  ['boveda_sellada', 'Bóveda sellada'], ['secreto_creado', 'Secreto creado'], ['secreto_rotado', 'Secreto rotado'],
  ['secreto_revocado', 'Secreto revocado'], ['politica_cambiada', 'Política cambiada'], ['secreto_entregado', 'Secreto entregado'],
  ['secreto_denegado', 'Secreto denegado'], ['esquema_aplicado', 'Esquema aplicado'],
];
const etiqueta = (t: string) => TIPOS.find(([k]) => k === t)?.[1] ?? t.replace(/_/g, ' ');
const MALOS = new Set(['ingreso_rechazado', 'boveda_parte_rechazada', 'secreto_denegado']);

function fmt(e: Evento) {
  const f = e.momentoUtc;
  if (!f) return '';
  const d = new Date(/z|[+-]\d\d:?\d\d$/i.test(f) ? f : f + 'Z');
  return d.toLocaleString('es-HN', { timeZone: 'America/Tegucigalpa', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function Detalle({ d }: { d: unknown }) {
  let o: unknown = d;
  if (typeof d === 'string') { try { o = JSON.parse(d); } catch { return <span className="detalle">{d}</span>; } }
  if (!o || typeof o !== 'object') return null;
  const par = Object.entries(o as Record<string, unknown>);
  if (!par.length) return null;
  return (
    <span className="detalle">
      {par.map(([k, v], i) => (
        <span key={k}>{i > 0 && ' · '}<b>{k}</b> {typeof v === 'object' ? JSON.stringify(v) : String(v)}</span>
      ))}
    </span>
  );
}

function safeParse(t: string): Record<string, unknown> {
  try { const o = JSON.parse(t); return o && typeof o === 'object' ? o : { detalle: t }; } catch { return { detalle: t }; }
}

type Integridad = { sana: boolean; primeraRota?: { id: number | string; falla?: string } };

export default function Auditoria() {
  const [filas, setFilas] = useState<Evento[]>([]);
  const [siguiente, setSiguiente] = useState<number | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState('');
  const [tipo, setTipo] = useState('');
  const [usuario, setUsuario] = useState('');
  const [integ, setInteg] = useState<Integridad | 'revisando' | 'falla'>('revisando');

  const cargar = useCallback(async (reiniciar: boolean, antesDe?: number | null) => {
    setCargando(true); setError('');
    const q = new URLSearchParams();
    if (antesDe != null && !reiniciar) q.set('antesDe', String(antesDe));
    if (tipo) q.set('tipo', tipo);
    if (/^d+$/.test(usuario.trim())) q.set('usuario', usuario.trim());
    q.set('limite', '50');
    try {
      const d = await api<{ eventos: Evento[]; siguiente: number | null }>(`/auditoria?${q}`);
      const a = d.eventos ?? [];
      setFilas((p) => (reiniciar ? a : [...p, ...a]));
      setSiguiente(d.siguiente ?? null);
    } catch (e) { setError(textoError(e)); }
    finally { setCargando(false); }
  }, [tipo, usuario]);

  useEffect(() => { const t = setTimeout(() => cargar(true), 250); return () => clearTimeout(t); }, [cargar]);

  const verificar = useCallback(async () => {
    setInteg('revisando');
    try { setInteg(await api<Integridad>('/auditoria/verificar')); } catch { setInteg('falla'); }
  }, []);
  useEffect(() => { verificar(); }, [verificar]);

  return (
    <main className="pagina">
      <Cabecera titulo="Auditoría" />
      <div className="cabeza">
        <div className="integridad">
          {integ === 'revisando' && <span className="pastilla">Verificando cadena…</span>}
          {integ === 'falla' && <span className="pastilla alerta">No se pudo verificar</span>}
          {typeof integ === 'object' && (integ.sana
            ? <span className="pastilla ok">Cadena íntegra</span>
            : <span className="pastilla alerta">Cadena rota desde el evento {integ.primeraRota?.id}</span>)}
          <button className="btn sec chico" onClick={verificar} disabled={integ === 'revisando'}>Verificar</button>
        </div>
      </div>

      <div className="barra">
        <div className="campo">
          <label htmlFor="f-tipo">Tipo de evento</label>
          <select id="f-tipo" className="entrada" value={tipo} onChange={(e) => setTipo(e.target.value)}>
            <option value="">Todos</option>
            {TIPOS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </div>
        <div className="campo">
          <label htmlFor="f-usuario">Id de usuario</label>
          <input id="f-usuario" className="entrada" inputMode="numeric" placeholder="Todos" value={usuario} onChange={(e) => setUsuario(e.target.value)} />
        </div>
      </div>

      {error && <p className="aviso error">{error}</p>}
      {!error && !cargando && filas.length === 0 && (
        <div className="tarjeta vacio"><h3>Sin eventos</h3><p className="tenue">No hay registros con estos filtros.</p></div>
      )}
      {filas.length > 0 && (
        <div className="tarjeta tabla-caja">
          <table className="tabla">
            <thead><tr><th>Fecha</th><th>Evento</th><th>Usuario</th><th>Detalle</th></tr></thead>
            <tbody>
              {filas.map((e) => (
                <tr key={e.id}>
                  <td className="fecha" data-et="Fecha">{fmt(e)}</td>
                  <td data-et="Evento"><span className={`pastilla sin-punto${MALOS.has(e.tipo) ? ' alerta' : ''}`}>{etiqueta(e.tipo)}</span></td>
                  <td data-et="Usuario">{e.usuario ? <button type="button" className="btn texto" title="Filtrar por este usuario" onClick={() => setUsuario(String(e.usuarioId))}>{e.usuario}</button> : <span className="mas-tenue">Sistema</span>}</td>
                  <td><Detalle d={{ ...(e.objeto ? { objeto: e.objeto } : {}), ...(e.resultado && e.resultado !== 'ok' ? { resultado: e.resultado } : {}), ...(typeof e.detalle === 'string' && e.detalle ? safeParse(e.detalle) : {}) }} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cargando && <div className="cargando" style={{ marginTop: 14, height: 64 }} />}
      {siguiente !== null && !cargando && (
        <div style={{ textAlign: 'center', marginTop: 20 }}>
          <button className="btn sec" onClick={() => cargar(false, siguiente)}>Cargar más</button>
        </div>
      )}
    </main>
  );
}
