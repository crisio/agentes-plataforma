'use client';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api, ApiError, textoError } from '@/lib/api';
import { Agente } from '@/lib/tipos';
import { tiene, useYo } from '@/lib/yo';
import Icono from '@/components/Icono';
import Cabecera from '@/components/Cabecera';
import Modal from '@/components/Modal';

type Estado = { inicializada: boolean; sellada: boolean; umbral?: number; partes?: number; partesRecibidas?: number };
type Politica = { agente: string; ttlSegundos: number; horaDesde: number | null; horaHasta: number | null };
type Secreto = { nombre: string; tipo: string; descripcion?: string; version: number; revocado?: boolean; politicas?: Politica[] };

const TIPOS = [['password', 'Contraseña'], ['api_key', 'Llave de API'], ['connection_string', 'Cadena de conexión'], ['certificado', 'Certificado'], ['token', 'Token']];
/** El nombre lleva barras: se codifica por segmento para no romper la ruta del gateway. */
const rutaSecreto = (n: string) => n.split('/').map(encodeURIComponent).join('/');
const tipoNombre = (t: string) => TIPOS.find(([k]) => k === t)?.[1] ?? t;

function Candado({ abierta }: { abierta: boolean }) {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="10" width="16" height="11" rx="3" />
      <path d={abierta ? 'M8 10V7a4 4 0 0 1 7.6-1.7' : 'M8 10V7a4 4 0 0 1 8 0v3'} />
      <circle cx="12" cy="15.5" r="1.4" />
    </svg>
  );
}

/** navigator.clipboard solo existe en contexto seguro (https o localhost); por http en la red interna cae al método viejo. */
async function copiar(texto: string, dentro?: Element | null): Promise<boolean> {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(texto); return true; } } catch { /* sigue al respaldo */ }
  const t = document.createElement('textarea');
  t.value = texto; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
  (dentro ?? document.body).appendChild(t); t.select();   // con showModal() el body queda inerte: va dentro del diálogo t.setSelectionRange(0, texto.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  t.remove();
  return ok;
}

export default function Boveda() {
  const [copiada, setCopiada] = useState<number | null>(null);
  const yo = useYo();
  const admin = tiene(yo, 'admin_boveda');
  const custodio = tiene(yo, 'custodio');
  const [est, setEst] = useState<Estado | null>(null);
  const [secretos, setSecretos] = useState<Secreto[] | null>(null);
  const [agentes, setAgentes] = useState<Agente[]>([]);
  const [error, setError] = useState('');
  const [bloqueada, setBloqueada] = useState(false);
  const [ok, setOk] = useState('');

  const [parte, setParte] = useState('');
  const [ocupado, setOcupado] = useState(false);

  const [init, setInit] = useState({ umbral: 1, partes: 1 });
  const [partesNuevas, setPartesNuevas] = useState<string[] | null>(null);
  const [guardadas, setGuardadas] = useState(false);

  const [modal, setModal] = useState<null | { t: 'crear' } | { t: 'rotar'; s: Secreto } | { t: 'revocar'; s: Secreto } | { t: 'politicas'; s: Secreto }>(null);

  const cargarSecretos = useCallback(async () => {
    if (!admin) return;
    try {
      const d = await api<Secreto[] | { secretos: Secreto[] }>('/boveda/secretos');
      setSecretos(Array.isArray(d) ? d : d.secretos ?? []);
      setBloqueada(false);
    } catch (e) {
      setSecretos([]);
      if (e instanceof ApiError && e.sellada) setBloqueada(true); else setError(textoError(e));
    }
  }, [admin]);

  const cargar = useCallback(async () => {
    setError('');
    try {
      const e = await api<Estado>('/boveda/estado');
      setEst(e);
      if (e.inicializada && !e.sellada) await cargarSecretos(); else setSecretos([]);
    } catch (e) { setError(textoError(e)); }
  }, [cargarSecretos]);

  useEffect(() => {
    cargar();
    api<Agente[] | { agentes: Agente[] }>('/agentes').then((d) => setAgentes(Array.isArray(d) ? d : d.agentes ?? [])).catch(() => {});
  }, [cargar]);

  useEffect(() => {
    if (!partesNuevas || guardadas) return;
    const f = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', f);
    return () => window.removeEventListener('beforeunload', f);
  }, [partesNuevas, guardadas]);

  async function abrir(e: FormEvent) {
    e.preventDefault();
    setOcupado(true); setError(''); setOk('');
    try {
      await api('/boveda/abrir', { metodo: 'POST', cuerpo: { parte: parte.trim() } });
      setParte('');
      await cargar();
    } catch (x) { setError(textoError(x)); }
    finally { setOcupado(false); }
  }

  async function sellar() {
    setOcupado(true); setError('');
    try { await api('/boveda/sellar', { metodo: 'POST' }); setOk('La bóveda quedó sellada.'); await cargar(); }
    catch (x) { setError(textoError(x)); }
    finally { setOcupado(false); }
  }

  async function inicializar(e: FormEvent) {
    e.preventDefault();
    setOcupado(true); setError('');
    try {
      const r = await api<{ partes: string[] }>('/boveda/inicializar', { metodo: 'POST', cuerpo: init });
      setPartesNuevas(r.partes); setGuardadas(false);
    } catch (x) { setError(textoError(x)); }
    finally { setOcupado(false); }
  }

  const cerrarModal = () => setModal(null);
  const tras = async (m: string) => { setModal(null); setOk(m); await cargar(); };

  const abierta = !!est?.inicializada && !est.sellada;
  const falta = (est?.umbral ?? 0) - (est?.partesRecibidas ?? 0);

  return (
    <main className="pagina">
      <Cabecera titulo="Bóveda" acciones={admin && abierta && <button className="redondo" onClick={() => setModal({ t: 'crear' })} aria-label="Nuevo secreto"><Icono n="mas" t={22} /></button>} />

      {error && <p className="aviso error" role="alert" style={{ marginBottom: 18 }}>{error}</p>}
      {ok && <p className="aviso ok" role="status" style={{ marginBottom: 18 }}>{ok}</p>}
      {!est && !error && <div className="cargando" />}

      {est && !est.inicializada && (
        <div className="tarjeta estado-boveda" style={{ display: 'block' }}>
          <h2 style={{ fontSize: 26 }}>Todavía no está inicializada</h2>
          {admin ? (
            <form className="form" onSubmit={inicializar} style={{ marginTop: 18, maxWidth: 460 }}>
              <div className="dos">
                <div className="campo"><label htmlFor="i-partes">Partes</label>
                  <input id="i-partes" className="entrada" type="number" min={1} max={10} value={init.partes} onChange={(e) => setInit({ ...init, partes: +e.target.value })} /></div>
                <div className="campo"><label htmlFor="i-umbral">Se necesitan</label>
                  <input id="i-umbral" className="entrada" type="number" min={1} max={init.partes} value={init.umbral} onChange={(e) => setInit({ ...init, umbral: +e.target.value })} /></div>
              </div>
              <p className="tenue" style={{ fontSize: 14 }}>La maestra se divide en {init.partes} partes y bastan {init.umbral} para abrirla. Se muestran una sola vez.</p>
              <div><button className="btn" disabled={ocupado || init.umbral > init.partes || init.umbral < 1}>Inicializar bóveda</button></div>
            </form>
          ) : <p className="tenue" style={{ marginTop: 8 }}>Un administrador de la bóveda debe inicializarla.</p>}
        </div>
      )}

      {est?.inicializada && (
        <div className="tarjeta estado-boveda">
          <div className={`sello${abierta ? ' abierta' : ''}`}><Candado abierta={abierta} /></div>
          <div>
            <h2>{abierta ? 'Abierta' : 'Sellada'}</h2>
            {abierta ? (
              <p className="tenue">Entrega secretos a los agentes que tienen política.</p>
            ) : (
              <>
                <p className="tenue">Ningún secreto sale hasta que se junten {est.umbral} partes.</p>
                <div className="progreso" aria-label={`${est.partesRecibidas ?? 0} de ${est.umbral} partes`}>
                  {Array.from({ length: est.umbral ?? 0 }, (_, i) => <i key={i} className={i < (est.partesRecibidas ?? 0) ? 'on' : ''} />)}
                </div>
                {custodio && (
                  <form className="abrir-fila" onSubmit={abrir}>
                    <input className="entrada mono" aria-label="Parte de la llave" placeholder={falta > 0 ? `Pega tu parte (faltan ${falta})` : 'Pega tu parte'} value={parte} onChange={(e) => setParte(e.target.value)} autoComplete="off" spellCheck={false} type="password" />
                    <button className="btn" disabled={ocupado || !parte.trim()}>Abrir</button>
                  </form>
                )}
              </>
            )}
          </div>
          <div>{abierta && admin && <button className="btn sec" onClick={sellar} disabled={ocupado}>Sellar</button>}</div>
        </div>
      )}

      {abierta && admin && (
        <>
          {bloqueada && <p className="aviso error">La bóveda está sellada. Un custodio debe abrirla con su parte para continuar.</p>}
          {secretos === null && <div className="cargando" />}
          {secretos && secretos.length === 0 && !bloqueada && (
            <div className="tarjeta vacio"><h3>Sin secretos</h3><p className="tenue">Crea el primero para que un agente pueda usarlo.</p></div>
          )}
          <div className="secretos">
            {secretos?.map((s) => (
              <article key={s.nombre} className={`tarjeta secreto${s.revocado ? ' revocado' : ''}`}>
                <div>
                  <h3>{s.nombre}</h3>
                  {s.descripcion && <p className="tenue" style={{ fontSize: 14, marginTop: 2 }}>{s.descripcion}</p>}
                  <div className="meta">
                    <span className="pastilla sin-punto">{tipoNombre(s.tipo)}</span>
                    <span className="pastilla sin-punto mono">v{s.version}</span>
                    {s.revocado
                      ? <span className="pastilla alerta">Revocado</span>
                      : (s.politicas?.length ?? 0) > 0
                        ? <span className="pastilla ok">{s.politicas!.map((p) => p.agente).join(', ')}</span>
                        : <span className="pastilla kraft">Sin política</span>}
                  </div>
                </div>
                {!s.revocado && (
                  <div className="acciones">
                    <button className="btn sec chico" onClick={() => setModal({ t: 'politicas', s })}>Políticas</button>
                    <button className="btn sec chico" onClick={() => setModal({ t: 'rotar', s })}>Rotar</button>
                    <button className="btn peligro chico" onClick={() => setModal({ t: 'revocar', s })}>Revocar</button>
                  </div>
                )}
              </article>
            ))}
          </div>
        </>
      )}

      <Modal abierto={!!partesNuevas} onCerrar={() => {}} bloqueado>
        {partesNuevas && (
          <>
            <div>
              <h2>Guarda las partes</h2>
              <p className="tenue" style={{ marginTop: 8 }}>Se muestran solo ahora. Repártelas entre los custodios; sin {init.umbral} de ellas no hay forma de abrir la bóveda.</p>
            </div>
            <div className="partes">
              {partesNuevas.map((p, i) => (
                <div key={i} className="parte">
                  <span className="n">{i + 1}</span>
                  <code>{p}</code>
                  <button className="btn sec chico" onClick={async (e) => { if (await copiar(p, e.currentTarget.closest("dialog"))) { setCopiada(i); setTimeout(() => setCopiada((c) => (c === i ? null : c)), 2000); } }} aria-label={`Copiar parte ${i + 1}`}><Icono n="copiar" t={16} />{copiada === i ? 'Copiada' : 'Copiar'}</button>
                </div>
              ))}
            </div>
            <label className="check">
              <input type="checkbox" checked={guardadas} onChange={(e) => setGuardadas(e.target.checked)} />
              <span>Ya guardé cada parte en un lugar seguro</span>
            </label>
            <div className="modal-pie">
              <button className="btn" disabled={!guardadas} onClick={async () => { setPartesNuevas(null); await cargar(); }}>Listo</button>
            </div>
          </>
        )}
      </Modal>

      <Modal abierto={modal?.t === 'crear'} onCerrar={cerrarModal}>
        {modal?.t === 'crear' && <FormSecreto onFin={() => tras('Secreto creado.')} onCancelar={cerrarModal} />}
      </Modal>
      <Modal abierto={modal?.t === 'rotar'} onCerrar={cerrarModal}>
        {modal?.t === 'rotar' && <FormRotar s={modal.s} onFin={() => tras('Secreto rotado.')} onCancelar={cerrarModal} />}
      </Modal>
      <Modal abierto={modal?.t === 'revocar'} onCerrar={cerrarModal}>
        {modal?.t === 'revocar' && <Revocar s={modal.s} onFin={() => tras('Secreto revocado.')} onCancelar={cerrarModal} />}
      </Modal>
      <Modal abierto={modal?.t === 'politicas'} onCerrar={cerrarModal}>
        {modal?.t === 'politicas' && <Politicas s={modal.s} agentes={agentes} onFin={() => tras('Políticas guardadas.')} onCancelar={cerrarModal} />}
      </Modal>
    </main>
  );
}

function useEnvio(fin: () => void) {
  const [error, setError] = useState('');
  const [ocupado, setOcupado] = useState(false);
  async function ir(fn: () => Promise<unknown>) {
    setOcupado(true); setError('');
    try { await fn(); fin(); } catch (x) { setError(textoError(x)); setOcupado(false); }
  }
  return { error, ocupado, ir };
}

function FormSecreto({ onFin, onCancelar }: { onFin: () => void; onCancelar: () => void }) {
  const [v, setV] = useState({ nombre: '', tipo: 'password', descripcion: '', valor: '' });
  const { error, ocupado, ir } = useEnvio(onFin);
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); ir(() => api('/boveda/secretos', { metodo: 'POST', cuerpo: v })); }}>
      <h2>Nuevo secreto</h2>
      <div className="dos">
        <div className="campo"><label htmlFor="s-nombre">Nombre</label>
          <input id="s-nombre" className="entrada mono" required pattern="[A-Za-z0-9][A-Za-z0-9_.\/:\-]{0,119}" title="Letras, números y . _ / : - (hasta 120). Ejemplo: sql/erp-hn/lectura" autoFocus value={v.nombre} onChange={(e) => setV({ ...v, nombre: e.target.value })} /></div>
        <div className="campo"><label htmlFor="s-tipo">Tipo</label>
          <select id="s-tipo" className="entrada" value={v.tipo} onChange={(e) => setV({ ...v, tipo: e.target.value })}>{TIPOS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></div>
      </div>
      <div className="campo"><label htmlFor="s-desc">Descripción</label>
        <input id="s-desc" className="entrada" value={v.descripcion} onChange={(e) => setV({ ...v, descripcion: e.target.value })} /></div>
      <div className="campo"><label htmlFor="s-valor">Valor</label>
        <textarea id="s-valor" className="entrada mono" rows={3} required autoComplete="off" spellCheck={false} value={v.valor} onChange={(e) => setV({ ...v, valor: e.target.value })} /></div>
      {error && <p className="aviso error" role="alert">{error}</p>}
      <div className="modal-pie"><button type="button" className="btn sec" onClick={onCancelar}>Cancelar</button><button className="btn" disabled={ocupado}>Guardar</button></div>
    </form>
  );
}

function FormRotar({ s, onFin, onCancelar }: { s: Secreto; onFin: () => void; onCancelar: () => void }) {
  const [valor, setValor] = useState('');
  const { error, ocupado, ir } = useEnvio(onFin);
  return (
    <form className="form" onSubmit={(e) => { e.preventDefault(); ir(() => api(`/boveda/secretos/${rutaSecreto(s.nombre)}/rotar`, { metodo: 'POST', cuerpo: { valor } })); }}>
      <div><h2>Rotar</h2><p className="mono tenue" style={{ marginTop: 6 }}>{s.nombre} · pasará a la versión {s.version + 1}</p></div>
      <div className="campo"><label htmlFor="r-valor">Valor nuevo</label>
        <textarea id="r-valor" className="entrada mono" rows={3} required autoFocus autoComplete="off" spellCheck={false} value={valor} onChange={(e) => setValor(e.target.value)} /></div>
      {error && <p className="aviso error" role="alert">{error}</p>}
      <div className="modal-pie"><button type="button" className="btn sec" onClick={onCancelar}>Cancelar</button><button className="btn" disabled={ocupado || !valor}>Rotar</button></div>
    </form>
  );
}

function Revocar({ s, onFin, onCancelar }: { s: Secreto; onFin: () => void; onCancelar: () => void }) {
  const { error, ocupado, ir } = useEnvio(onFin);
  return (
    <div className="form">
      <div><h2>Revocar secreto</h2><p className="tenue" style={{ marginTop: 8 }}><span className="mono">{s.nombre}</span> dejará de entregarse a los agentes. No se puede deshacer.</p></div>
      {error && <p className="aviso error" role="alert">{error}</p>}
      <div className="modal-pie"><button className="btn sec" onClick={onCancelar}>Cancelar</button>
        <button className="btn peligro" disabled={ocupado} onClick={() => ir(() => api(`/boveda/secretos/${rutaSecreto(s.nombre)}/revocar`, { metodo: 'POST' }))}>Revocar</button></div>
    </div>
  );
}

const HORAS = [<option key="" value="">Siempre</option>, ...Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)];

function Politicas({ s, agentes, onFin, onCancelar }: { s: Secreto; agentes: Agente[]; onFin: () => void; onCancelar: () => void }) {
  type Fila = { agente: string; minutos: number; desde: string; hasta: string };
  const [filas, setFilas] = useState<Fila[]>((s.politicas ?? []).map((p) => ({ agente: p.agente, minutos: Math.max(1, Math.round(p.ttlSegundos / 60)), desde: p.horaDesde === null ? '' : String(p.horaDesde), hasta: p.horaHasta === null ? '' : String(p.horaHasta) })));
  const { error, ocupado, ir } = useEnvio(onFin);
  const [local, setLocal] = useState('');
  const cambia = (i: number, c: Partial<Fila>) => setFilas(filas.map((f, j) => (j === i ? { ...f, ...c } : f)));
  const guardar = (e: FormEvent) => {
    e.preventDefault();
    if (filas.some((f) => (f.desde === '') !== (f.hasta === ''))) { setLocal('Pon la hora de inicio y la de fin, o deja las dos en «Siempre».'); return; }
    setLocal('');
    ir(() => api(`/boveda/secretos/${rutaSecreto(s.nombre)}/politicas`, {
      metodo: 'PUT',
      cuerpo: filas.map((f) => ({ agente: f.agente, ttlSegundos: f.minutos * 60, horaDesde: f.desde === '' ? null : +f.desde, horaHasta: f.hasta === '' ? null : +f.hasta })),
    }));
  };
  return (
    <form className="form" onSubmit={guardar}>
      <div><h2>Políticas</h2><p className="mono tenue" style={{ marginTop: 6 }}>{s.nombre}</p></div>
      {filas.length === 0 && <p className="tenue">Ningún agente puede usar este secreto todavía.</p>}
      {filas.map((f, i) => (
        <div key={i} className="fila-politica">
          <div className="campo"><label>Agente</label>
            <input className="entrada" list="lista-agentes" required value={f.agente} onChange={(e) => cambia(i, { agente: e.target.value })} /></div>
          <div className="campo"><label>Vigencia (min)</label>
            <input className="entrada" type="number" min={1} max={60} required value={f.minutos} onChange={(e) => cambia(i, { minutos: +e.target.value })} /></div>
          <div className="campo"><label>Desde</label><select className="entrada" value={f.desde} onChange={(e) => cambia(i, { desde: e.target.value })}>{HORAS}</select></div>
          <div className="campo"><label>Hasta</label><select className="entrada" value={f.hasta} onChange={(e) => cambia(i, { hasta: e.target.value })}>{HORAS}</select></div>
          <button type="button" className="btn peligro chico" onClick={() => setFilas(filas.filter((_, j) => j !== i))} aria-label="Quitar">Quitar</button>
        </div>
      ))}
      <datalist id="lista-agentes">{agentes.map((a) => <option key={a.clave} value={a.clave}>{a.nombre}</option>)}</datalist>
      <div><button type="button" className="btn sec chico" onClick={() => setFilas([...filas, { agente: '', minutos: 5, desde: '', hasta: '' }])}><Icono n="mas" t={16} />Agente</button></div>
      <p className="mas-tenue" style={{ fontSize: 13 }}>Horas de Honduras. Sin horas, el agente puede pedirlo a cualquier hora.</p>
      {(local || error) && <p className="aviso error" role="alert">{local || error}</p>}
      <div className="modal-pie"><button type="button" className="btn sec" onClick={onCancelar}>Cancelar</button><button className="btn" disabled={ocupado}>Guardar</button></div>
    </form>
  );
}
