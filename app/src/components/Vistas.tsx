'use client';
// Vistas de datos dentro del chat (adenda 11-nov del contrato): carrusel de tarjetas, tabla compacta con visor a
// pantalla completa, resumen de cifras y archivos. Todo sale de lo que el agente ya trajo; nada se inventa aquí.
import { useMemo, useState } from 'react';
import type { Columna, Vista } from '@/lib/chat';
import Icono from '@/components/Icono';
import Modal from '@/components/Modal';

const FILAS_COMPACTAS = 6;

const esNumerica = (c: Columna) => c.tipo === 'numero' || c.tipo === 'moneda';

function aNumero(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const limpio = v.replace(/[^\d.,-]/g, '');
  if (!limpio || !/\d/.test(limpio)) return null;
  // «1,234.56» o «1.234,56»: el último separador es el decimal.
  const ultimoPunto = limpio.lastIndexOf('.');
  const ultimaComa = limpio.lastIndexOf(',');
  const normal = ultimaComa > ultimoPunto ? limpio.replace(/\./g, '').replace(',', '.') : limpio.replace(/,/g, '');
  const n = Number(normal);
  return Number.isFinite(n) ? n : null;
}

const formato = new Intl.NumberFormat('es-HN', { maximumFractionDigits: 2 });
const formatoMoneda = new Intl.NumberFormat('es-HN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function celda(v: unknown, c: Columna): string {
  if (v == null || v === '') return '—';
  if (esNumerica(c) && typeof v === 'number') return (c.tipo === 'moneda' ? formatoMoneda : formato).format(v);
  return String(v);
}

/** Columnas declaradas o, si el agente no las mandó, las claves de la primera fila. */
function columnasDe(v: Vista): Columna[] {
  if (v.columnas?.length) return v.columnas;
  const primera = v.filas?.[0];
  return primera ? Object.keys(primera).map((k) => ({ clave: k, titulo: k.replace(/_/g, ' ') })) : [];
}

function Estado({ valor }: { valor: unknown }) {
  const t = String(valor ?? '');
  const tono = /venc|atras|error|rechaz|bloq|sin /i.test(t) ? 'alerta' : /ok|listo|recib|entreg|aprob|al día|vigente/i.test(t) ? 'ok' : '';
  return <span className={`pastilla sin-punto ${tono}`}>{t || '—'}</span>;
}

function Tabla({ v, filas, alTocar }: { v: Vista; filas: Record<string, unknown>[]; alTocar?: (f: Record<string, unknown>) => void }) {
  const cols = columnasDe(v);
  return (
    <table className="vt-tabla">
      <thead>
        <tr>{cols.map((c) => <th key={c.clave} className={esNumerica(c) ? 'num' : ''} scope="col">{c.titulo}</th>)}</tr>
      </thead>
      <tbody>
        {filas.map((f, i) => (
          <tr key={i} onClick={alTocar ? () => alTocar(f) : undefined} className={alTocar ? 'tocable' : ''}>
            {cols.map((c) => (
              <td key={c.clave} className={esNumerica(c) ? 'num' : ''}>
                {c.tipo === 'estado' ? <Estado valor={f[c.clave]} /> : celda(f[c.clave], c)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Visor a pantalla completa: búsqueda, ordenar por columna, totales y detalle de una fila. */
function Visor({ v, abierto, onCerrar }: { v: Vista; abierto: boolean; onCerrar: () => void }) {
  const cols = columnasDe(v);
  const [q, setQ] = useState('');
  const [orden, setOrden] = useState<{ clave: string; asc: boolean } | null>(null);
  const [detalle, setDetalle] = useState<Record<string, unknown> | null>(null);

  const filas = useMemo(() => {
    const todas = v.filas ?? [];
    const sinAcentos = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const buscado = sinAcentos(q.trim());
    let r = buscado ? todas.filter((f) => cols.some((c) => sinAcentos(String(f[c.clave] ?? '')).includes(buscado))) : todas;
    if (orden) {
      const c = cols.find((x) => x.clave === orden.clave);
      r = [...r].sort((a, b) => {
        const x = a[orden.clave], y = b[orden.clave];
        let d: number;
        if (c && esNumerica(c)) d = (aNumero(x) ?? -Infinity) - (aNumero(y) ?? -Infinity);
        else d = String(x ?? '').localeCompare(String(y ?? ''), 'es', { numeric: true });
        return orden.asc ? d : -d;
      });
    }
    return r;
  }, [v.filas, cols, q, orden]);

  const totales = cols.map((c) => {
    if (!esNumerica(c)) return null;
    const ns = filas.map((f) => aNumero(f[c.clave])).filter((n): n is number => n != null);
    return ns.length ? (c.tipo === 'moneda' ? formatoMoneda : formato).format(ns.reduce((a, b) => a + b, 0)) : null;
  });
  const hayTotales = totales.some((t) => t != null);

  return (
    <Modal abierto={abierto} onCerrar={() => { setDetalle(null); onCerrar(); }}>
      <div className="visor">
        <div className="hoja-cabeza">
          {detalle
            ? <button className="redondo" onClick={() => setDetalle(null)} aria-label="Volver a la tabla"><Icono n="atras" t={22} /></button>
            : <button className="redondo" onClick={onCerrar} aria-label="Cerrar"><Icono n="cerrar" t={22} /></button>}
          <h2>{v.titulo}</h2>
          <span />
        </div>

        {detalle ? (
          <div className="grupo">
            {cols.map((c) => (
              <div key={c.clave} className="fila" aria-disabled="true">
                <span className="cuerpo"><small>{c.titulo}</small><b>{c.tipo === 'estado' ? <Estado valor={detalle[c.clave]} /> : celda(detalle[c.clave], c)}</b></span>
              </div>
            ))}
          </div>
        ) : (
          <>
            <div className="visor-barra">
              <label className="visor-buscar">
                <Icono n="buscar" t={18} />
                <span className="sr">Buscar en la tabla</span>
                <input type="search" placeholder={`Buscar en ${v.filas?.length ?? 0} filas`} value={q} onChange={(e) => setQ(e.target.value)} enterKeyHint="search" />
              </label>
              <span className="tenue visor-cuenta">{filas.length === (v.filas?.length ?? 0) ? `${filas.length} filas` : `${filas.length} de ${v.filas?.length ?? 0}`}</span>
            </div>
            <div className="vt-marco grande">
              <table className="vt-tabla">
                <thead>
                  <tr>
                    {cols.map((c) => {
                      const activa = orden?.clave === c.clave;
                      return (
                        <th key={c.clave} className={esNumerica(c) ? 'num' : ''} scope="col" aria-sort={activa ? (orden!.asc ? 'ascending' : 'descending') : 'none'}>
                          <button onClick={() => setOrden(activa ? (orden!.asc ? { clave: c.clave, asc: false } : null) : { clave: c.clave, asc: true })}>
                            {c.titulo}<span className="flecha-orden" aria-hidden="true">{activa ? (orden!.asc ? '↑' : '↓') : ''}</span>
                          </button>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {filas.map((f, i) => (
                    <tr key={i} className="tocable" onClick={() => setDetalle(f)}>
                      {cols.map((c) => <td key={c.clave} className={esNumerica(c) ? 'num' : ''}>{c.tipo === 'estado' ? <Estado valor={f[c.clave]} /> : celda(f[c.clave], c)}</td>)}
                    </tr>
                  ))}
                  {filas.length === 0 && <tr><td colSpan={cols.length} className="tenue" style={{ textAlign: 'center', padding: 24 }}>Nada coincide con «{q}».</td></tr>}
                </tbody>
                {hayTotales && filas.length > 0 && (
                  <tfoot>
                    <tr>{totales.map((t, i) => <td key={i} className={t != null ? 'num' : ''}>{i === 0 && t == null ? 'Total' : t ?? ''}</td>)}</tr>
                  </tfoot>
                )}
              </table>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function VistaTabla({ v }: { v: Vista }) {
  const [abierto, setAbierto] = useState(false);
  const filas = v.filas ?? [];
  const mas = filas.length > FILAS_COMPACTAS;
  return (
    <section className="vt" aria-label={v.titulo}>
      <header className="vt-cabeza">
        <div><b>{v.titulo}</b>{v.subtitulo && <small>{v.subtitulo}</small>}</div>
        {filas.length > 0 && <button className="vt-expandir" onClick={() => setAbierto(true)} aria-label={`Abrir ${v.titulo} completa`}><Icono n="expandir" t={18} /></button>}
      </header>
      {filas.length === 0
        ? <p className="tenue" style={{ padding: '4px 16px 14px' }}>Sin filas.</p>
        : <div className="vt-marco"><Tabla v={v} filas={filas.slice(0, FILAS_COMPACTAS)} /></div>}
      {mas && <button className="vt-todo" onClick={() => setAbierto(true)}>Ver las {filas.length} filas<Icono n="derecha" t={16} /></button>}
      <Visor v={v} abierto={abierto} onCerrar={() => setAbierto(false)} />
    </section>
  );
}

function VistaTarjetas({ v }: { v: Vista }) {
  const [abierta, setAbierta] = useState<number | null>(null);
  const t = v.tarjetas ?? [];
  const sel = abierta != null ? t[abierta] : null;
  return (
    <section className="vc" aria-label={v.titulo}>
      {(v.titulo || v.subtitulo) && <div className="vc-titulo"><b>{v.titulo}</b>{v.subtitulo && <small>{v.subtitulo}</small>}</div>}
      <div className="carrusel" role="list">
        {t.map((x, i) => (
          <button key={i} role="listitem" className="tarjeta-dato" onClick={() => setAbierta(i)}>
            {x.etiqueta && <span className="etiqueta-dato">{x.etiqueta}</span>}
            <b className="td-titulo">{x.titulo}</b>
            {x.valor && <span className="td-valor">{x.valor}</span>}
            {x.subtitulo && <small className="td-sub">{x.subtitulo}</small>}
          </button>
        ))}
      </div>
      <Modal abierto={sel != null} onCerrar={() => setAbierta(null)}>
        {sel && (
          <>
            <div className="hoja-cabeza">
              <button className="redondo" onClick={() => setAbierta(null)} aria-label="Cerrar"><Icono n="cerrar" t={22} /></button>
              <h2>{v.titulo}</h2>
              <span />
            </div>
            <div className="td-detalle-cabeza">
              {sel.etiqueta && <span className="etiqueta-dato">{sel.etiqueta}</span>}
              <h3>{sel.titulo}</h3>
              {sel.valor && <p className="td-valor grande">{sel.valor}</p>}
              {sel.subtitulo && <p className="tenue">{sel.subtitulo}</p>}
            </div>
            {sel.detalle && sel.detalle.length > 0 && (
              <div className="grupo">
                {sel.detalle.map((d, i) => (
                  <div key={i} className="fila" aria-disabled="true">
                    <span className="cuerpo"><b>{d.nombre}</b></span>
                    <span className="valor">{d.valor}</span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </Modal>
    </section>
  );
}

function VistaResumen({ v }: { v: Vista }) {
  return (
    <section className="vr" aria-label={v.titulo}>
      <div className="vc-titulo"><b>{v.titulo}</b>{v.subtitulo && <small>{v.subtitulo}</small>}</div>
      <div className="cifras">
        {(v.cifras ?? []).map((c, i) => (
          <div key={i} className="cifra">
            <small>{c.nombre}</small>
            <b>{c.valor}</b>
            {c.nota && <span className="tenue">{c.nota}</span>}
          </div>
        ))}
      </div>
    </section>
  );
}

function VistaArchivo({ v }: { v: Vista }) {
  const seguro = !!v.url && /^https:\/\//i.test(v.url);
  const vence = v.vence ? new Date(v.vence) : null;
  const vencido = !!vence && vence.getTime() < Date.now();
  return (
    <a className={`va${!seguro || vencido ? ' apagado' : ''}`} href={seguro && !vencido ? v.url : undefined} target="_blank" rel="noopener noreferrer" aria-disabled={!seguro || vencido}>
      <span className="va-ico"><Icono n="archivo" t={22} /></span>
      <span className="cuerpo">
        <b>{v.titulo}</b>
        <small>{vencido ? 'El enlace ya venció. Pídelo de nuevo.' : vence ? `Disponible hasta ${vence.toLocaleString('es-HN', { day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit' })}` : 'Archivo'}</small>
      </span>
      {seguro && !vencido && <Icono n="descargar" t={20} />}
    </a>
  );
}

export function VistaEnChat({ v }: { v: Vista }) {
  if (v.tipo === 'tarjetas') return <VistaTarjetas v={v} />;
  if (v.tipo === 'resumen') return <VistaResumen v={v} />;
  if (v.tipo === 'archivo') return <VistaArchivo v={v} />;
  return <VistaTabla v={v} />;
}

export function Sugerencias({ opciones, alElegir, deshabilitado }: { opciones: string[]; alElegir: (s: string) => void; deshabilitado?: boolean }) {
  if (!opciones.length) return null;
  return (
    <div className="pildoras" role="group" aria-label="Respuestas sugeridas">
      {opciones.map((o) => <button key={o} className="pildora" disabled={deshabilitado} onClick={() => alElegir(o)}>{o}</button>)}
    </div>
  );
}
