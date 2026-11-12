'use client';
// El chat vive en el layout para que la conversación (y la respuesta que se está escribiendo) sobreviva cuando la
// dirección pasa de /chat/hilo a /chat/hilo/<id> al crearse la conversación.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams, usePathname, useRouter } from 'next/navigation';
import { api, textoError } from '@/lib/api';
import type { Agente } from '@/lib/tipos';
import { FAMILIA } from '@/lib/tipos';
import { tiene, useYo } from '@/lib/yo';
import { arregloDe, enviar, etiquetaHerramienta, herramientasDe, textoErrorChat, type Conversacion, type ConversacionResumen, type Mensaje, type Vista } from '@/lib/chat';
import { hayVoz } from '@/lib/voz';
import { Sugerencias, VistaEnChat } from '@/components/Vistas';
import Llamada, { type RespuestaLlamada } from '@/components/Llamada';
import { horaCorta } from '@/lib/inicio';
import Cara, { colorDe } from '@/components/Cara';
import Icono from '@/components/Icono';
import Markdown from '@/components/Markdown';
import Modal from '@/components/Modal';
import Conectar, { type Conexion } from '@/components/Conectar';

/** Preguntas que Hilo sabe contestar con sus herramientas de lectura (tracking, pagos, vencimientos). */
const SUGERENCIAS: Record<string, string[]> = {
  hilo: [
    '¿Qué importaciones vienen en camino esta semana?',
    '¿Qué vencimientos tengo en los próximos 15 días?',
    '¿Qué pagos de logística están programados?',
  ],
};

let contador = 0;
const nuevaClave = () => `m${Date.now()}-${contador++}`;

export default function ChatLayout({ children }: { children: React.ReactNode }) {
  const { agente } = useParams<{ agente: string }>();
  const ruta = usePathname();
  const router = useRouter();
  const yo = useYo();
  const idEnRuta = Number(ruta.split('/')[3]) || null;

  const [info, setInfo] = useState<Agente | null>(null);
  const [cx, setCx] = useState<{ conectables: string[]; conexiones: Conexion[] } | null>(null);
  const [mensajes, setMensajes] = useState<Mensaje[]>([]);
  const [cargandoConv, setCargandoConv] = useState(false);
  const [errorConv, setErrorConv] = useState('');
  const [texto, setTexto] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [menu, setMenu] = useState(false);
  const [anteriores, setAnteriores] = useState<ConversacionResumen[] | null>(null);
  const [verAnteriores, setVerAnteriores] = useState(false);
  const [confirmarBorrar, setConfirmarBorrar] = useState(false);
  const [conectar, setConectar] = useState(false);
  const [llamada, setLlamada] = useState(false);
  const [conVoz, setConVoz] = useState(false);
  useEffect(() => setConVoz(hayVoz()), []);
  const conv = useRef<number | null>(null);
  const lista = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const pegado = useRef(true);
  const cancelar = useRef<AbortController | null>(null);

  const nombre = info?.nombre ?? agente.charAt(0).toUpperCase() + agente.slice(1);
  const color = colorDe(agente, info?.color);
  const conectable = !!cx?.conectables.includes(agente);
  const conexion = cx?.conexiones.find((x) => x.agente === agente) ?? null;
  const listo = conectable && conexion?.estado === 'conectada';

  const cargarConexiones = useCallback(() => {
    api<{ conectables: string[]; conexiones: Conexion[] }>('/conexiones').then(setCx).catch(() => setCx({ conectables: [], conexiones: [] }));
  }, []);

  useEffect(() => {
    api<Agente[] | { agentes: Agente[] }>('/agentes')
      .then((d) => setInfo((Array.isArray(d) ? d : d.agentes ?? []).find((a) => a.clave === agente) ?? null))
      .catch(() => {});
    cargarConexiones();
  }, [agente, cargarConexiones]);

  // Cambió la conversación en la dirección (atrás, conversaciones anteriores, nueva): cargarla o empezar vacía.
  useEffect(() => {
    if (idEnRuta === conv.current) return;
    cancelar.current?.abort();
    conv.current = idEnRuta;
    setErrorConv('');
    setMenu(false);
    if (!idEnRuta) { setMensajes([]); return; }
    setCargandoConv(true);
    setMensajes([]);
    api<Conversacion>(`/chat/conversaciones/${idEnRuta}`)
      .then((c) => {
        if (conv.current !== idEnRuta) return;
        setMensajes(c.mensajes.map((m) => ({ id: m.id, clave: `s${m.id}`, rol: m.rol, texto: m.texto, herramientas: herramientasDe(m.herramientas), vistas: arregloDe<Vista>(m.vistas), sugerencias: arregloDe<string>(m.sugerencias), error: m.error, momentoUtc: m.momentoUtc })));
        pegado.current = true;
      })
      .catch((e) => setErrorConv(textoError(e)))
      .finally(() => setCargandoConv(false));
  }, [idEnRuta]);

  // Pegado al final mientras la persona no haya subido a leer.
  useLayoutEffect(() => {
    const el = lista.current;
    if (el && pegado.current) el.scrollTop = el.scrollHeight;
  }, [mensajes]);
  const alDesplazar = () => {
    const el = lista.current;
    if (el) pegado.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };

  // La caja de escribir crece con el texto.
  useLayoutEffect(() => {
    const t = area.current;
    if (!t) return;
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 168) + 'px';
  }, [texto]);

  const mandar = useCallback(async (contenido: string): Promise<RespuestaLlamada> => {
    const limpio = contenido.trim();
    const res: RespuestaLlamada = { texto: '', vistas: 0 };
    if (!limpio || enviando) return { ...res, error: 'ocupado', textoError: 'Espera a que termine la respuesta anterior.' };
    setTexto('');
    setEnviando(true);
    pegado.current = true;
    const claveAgente = nuevaClave();
    setMensajes((m) => [...m, { clave: nuevaClave(), rol: 'usuario', texto: limpio, herramientas: [], vistas: [], sugerencias: [] }, { clave: claveAgente, rol: 'agente', texto: '', herramientas: [], vistas: [], sugerencias: [] }]);
    const cambiar = (f: (m: Mensaje) => Mensaje) => setMensajes((ms) => ms.map((m) => (m.clave === claveAgente ? f(m) : m)));
    const ac = new AbortController();
    cancelar.current = ac;
    try {
      await enviar(agente, { conversacionId: conv.current ?? undefined, texto: limpio }, (e) => {
        if (e.tipo === 'inicio') {
          if (!conv.current && e.conversacionId) {
            conv.current = e.conversacionId;
            router.replace(`/chat/${agente}/${e.conversacionId}`, { scroll: false });
          }
        } else if (e.tipo === 'texto') { res.texto += e.delta; cambiar((m) => ({ ...m, texto: m.texto + e.delta })); }
        else if (e.tipo === 'vista') {
          res.vistas++;
          cambiar((m) => ({ ...m, vistas: [...m.vistas, e.vista] }));
        }
        else if (e.tipo === 'sugerencias') cambiar((m) => ({ ...m, sugerencias: Array.isArray(e.opciones) ? e.opciones.slice(0, 4) : [] }));
        else if (e.tipo === 'herramienta') cambiar((m) => {
          const i = m.herramientas.findIndex((h) => (e.id ? h.id === e.id : h.nombre === e.nombre && h.estado === 'corriendo'));
          const h = { id: e.id, nombre: e.nombre, estado: e.estado, ms: e.ms };
          return { ...m, herramientas: i >= 0 ? m.herramientas.map((x, j) => (j === i ? h : x)) : [...m.herramientas, h] };
        });
        else if (e.tipo === 'fin') cambiar((m) => ({ ...m, id: e.mensajeId }));
        else if (e.tipo === 'error') {
          res.error = e.codigo;
          res.textoError = textoErrorChat(e.codigo, info?.nombre ?? agente);
          cambiar((m) => ({ ...m, error: e.codigo }));
          if (e.codigo === 'sin_conexion' || e.codigo === 'reconectar') cargarConexiones();
        }
      }, ac.signal);
    } catch (e) {
      if ((e as { name?: string })?.name !== 'AbortError') {
        cambiar((m) => ({ ...m, error: 'error' }));
        res.error = 'error';
        res.textoError = textoErrorChat('error', info?.nombre ?? agente);
      }
    } finally {
      if (cancelar.current === ac) cancelar.current = null;
      setEnviando(false);
    }
    return res;
  }, [agente, enviando, router, cargarConexiones, info?.nombre]);

  const escritorio = () => typeof window !== 'undefined' && window.matchMedia('(hover: hover) and (pointer: fine)').matches;

  async function abrirAnteriores() {
    setMenu(false);
    setVerAnteriores(true);
    setAnteriores(null);
    try { setAnteriores(await api<ConversacionResumen[]>(`/chat/${agente}/conversaciones`)); } catch { setAnteriores([]); }
  }

  async function borrar() {
    if (!conv.current) return;
    try {
      await api(`/chat/conversaciones/${conv.current}/borrar`, { metodo: 'POST', cuerpo: {} });
      setConfirmarBorrar(false);
      router.replace(`/chat/${agente}`);
    } catch (e) { setErrorConv(textoError(e)); setConfirmarBorrar(false); }
  }

  const sugerencias = listo ? SUGERENCIAS[agente] ?? [] : [];
  const vacio = !cargandoConv && mensajes.length === 0 && !errorConv;

  return (
    <div className="chat" style={{ ['--c' as string]: color }}>
      <header className="chat-cabeza">
        <Link href="/" className="redondo" aria-label="Volver al inicio"><Icono n="atras" t={22} /></Link>
        <Link href={`/agente/${agente}`} className="chat-pildora" aria-label={`Perfil de ${nombre}`}>
          <span className="mini"><Cara clave={agente} nombre={nombre} color={info?.color} /></span>
          <span>{nombre}</span>
        </Link>
        <button className="redondo" onClick={() => setMenu((v) => !v)} aria-label="Más opciones" aria-expanded={menu}><Icono n="puntos" t={22} /></button>
      </header>

      {menu && (
        <>
          <div className="menu-velo" onClick={() => setMenu(false)} />
          <div className="menu-flotante" role="menu">
            <button role="menuitem" onClick={() => { setMenu(false); if (idEnRuta) router.push(`/chat/${agente}`); else { cancelar.current?.abort(); conv.current = null; setMensajes([]); } }}><Icono n="nuevo" />Nueva conversación</button>
            <button role="menuitem" onClick={abrirAnteriores}><Icono n="reloj" />Conversaciones anteriores</button>
            <Link role="menuitem" href={`/agente/${agente}`} onClick={() => setMenu(false)}><Icono n="conversacion" />Ver a {nombre}</Link>
            {idEnRuta && <button role="menuitem" className="peligro" onClick={() => { setMenu(false); setConfirmarBorrar(true); }}><Icono n="basura" />Borrar esta conversación</button>}
          </div>
        </>
      )}

      <div className="mensajes" ref={lista} onScroll={alDesplazar} aria-live="polite">
        {cargandoConv && <div className="cargando" style={{ height: 90, marginTop: 10 }} />}
        {errorConv && <p className="aviso error">{errorConv}</p>}

        {vacio && (
          <div className="chat-vacio">
            <div className="cara-grande"><Cara clave={agente} nombre={nombre} color={info?.color} etiqueta /></div>
            <h2>{nombre}</h2>
            <p>{info?.descripcion ?? FAMILIA[agente]?.descripcion ?? ''}</p>
            {sugerencias.length > 0 && (
              <div className="sugerencias">
                {sugerencias.map((s) => <button key={s} className="sugerencia" onClick={() => mandar(s)}>{s}</button>)}
              </div>
            )}
          </div>
        )}

        {mensajes.map((m, idx) => m.rol === 'usuario'
          ? <div key={m.clave} className="msg-yo">{m.texto}</div>
          : (
            <div key={m.clave} className={`msg-agente${m.error ? ' con-error' : ''}`}>
              {m.herramientas.length > 0 && (
                <div className="herramientas">
                  {m.herramientas.map((h, i) => (
                    <span key={h.id ?? i} className={`chip-herr ${h.estado}`}>
                      {h.estado === 'corriendo' ? <i className="giro" /> : h.estado === 'lista' ? <Icono n="ok" t={14} /> : <Icono n="alerta" t={14} />}
                      {etiquetaHerramienta(h.nombre, h.estado === 'corriendo')}
                      {h.estado !== 'corriendo' && h.ms != null && <span className="mas-tenue">· {(h.ms / 1000).toFixed(1)} s</span>}
                    </span>
                  ))}
                </div>
              )}
              {m.texto ? <Markdown texto={m.texto} /> : !m.error && enviando && !m.herramientas.some((h) => h.estado === 'corriendo') && <span className="escribiendo" aria-label={`${nombre} está escribiendo`}><i /><i /><i /></span>}
              {m.vistas.length > 0 && <div className="vistas">{m.vistas.map((v, i) => <VistaEnChat key={v.id ?? i} v={v} />)}</div>}
              {idx === mensajes.length - 1 && !enviando && !m.error && (
                <Sugerencias opciones={m.sugerencias} alElegir={(s) => { mandar(s); }} deshabilitado={!listo} />
              )}
              {m.error && (
                <div className="msg-error" role="alert">
                  <Icono n="alerta" t={18} />
                  <div>
                    {textoErrorChat(m.error, nombre)}
                    {(m.error === 'sin_conexion' || m.error === 'reconectar') && conectable && (
                      <div><button className="btn chico" onClick={() => setConectar(true)}>Conectar {nombre}</button></div>
                    )}
                    {m.error === 'sin_llave_modelo' && tiene(yo, 'admin_boveda') && (
                      <div><Link className="btn chico" href="/boveda">Ir a la Bóveda</Link></div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
      </div>

      <div className="compositor">
        {cx && !conectable && (
          <div className="aviso-chat"><b>{nombre} todavía no está conectado a la plataforma.</b><span className="tenue">Cuando su sistema quede enlazado, aquí mismo vas a poder conversar.</span></div>
        )}
        {cx && conectable && !listo && (
          <div className="aviso-chat">
            <b>{conexion?.estado === 'reconectar' ? `Tu acceso a ${nombre} venció.` : `Conecta tu cuenta de ${nombre} para conversar.`}</b>
            <button className="btn chico" onClick={() => setConectar(true)}>{conexion?.estado === 'reconectar' ? 'Reconectar' : 'Conectar'}</button>
          </div>
        )}
        <form className={`compositor-caja${conVoz && listo ? ' con-llamada' : ''}`} onSubmit={(e) => { e.preventDefault(); mandar(texto); }}>
          {conVoz && listo && (
            <button type="button" className="boton-llamada" onClick={() => setLlamada(true)} disabled={enviando} aria-label={`Llamar a ${nombre}`}>
              <Icono n="llamada" t={21} />
            </button>
          )}
          <label htmlFor="escribir" className="sr">Mensaje para {nombre}</label>
          <textarea id="escribir" ref={area} rows={1} value={texto} maxLength={4000} disabled={!listo}
            placeholder={listo ? `Preguntar a ${nombre}` : `${nombre} no está disponible`} enterKeyHint="send"
            onChange={(e) => setTexto(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && escritorio()) { e.preventDefault(); mandar(texto); } }} />
          <button className="enviar" disabled={!listo || enviando || !texto.trim()} aria-label="Enviar">
            {enviando ? <i className="giro" /> : <Icono n="enviar" t={22} />}
          </button>
        </form>
      </div>

      <Modal abierto={verAnteriores} onCerrar={() => setVerAnteriores(false)}>
        <div className="hoja-cabeza">
          <button className="redondo" onClick={() => setVerAnteriores(false)} aria-label="Cerrar"><Icono n="cerrar" t={22} /></button>
          <h2>Conversaciones</h2>
          <span />
        </div>
        {!anteriores && <div className="cargando" style={{ height: 160 }} />}
        {anteriores && anteriores.length === 0 && <p className="tenue" style={{ textAlign: 'center', padding: '20px 0' }}>Todavía no hay conversaciones con {nombre}.</p>}
        {anteriores && anteriores.length > 0 && (
          <div className="grupo">
            {anteriores.map((c) => (
              <Link key={c.id} href={`/chat/${agente}/${c.id}`} className="fila" onClick={() => setVerAnteriores(false)} aria-current={c.id === idEnRuta ? 'page' : undefined}>
                <span className="cuerpo">
                  <b>{c.titulo || c.ultimo?.texto || 'Conversación'}</b>
                  <small>{horaCorta(c.actualizadaUtc)}{c.ultimo && c.titulo ? ` · ${c.ultimo.texto}` : ''}</small>
                </span>
                <span className="flecha"><Icono n="derecha" t={18} /></span>
              </Link>
            ))}
          </div>
        )}
      </Modal>

      <Modal abierto={confirmarBorrar} onCerrar={() => setConfirmarBorrar(false)}>
        <div>
          <h2>¿Borrar esta conversación?</h2>
          <p className="tenue" style={{ marginTop: 8 }}>Se quita de tu lista. Lo que {nombre} consultó queda en la auditoría.</p>
        </div>
        <div className="modal-pie">
          <button className="btn sec" onClick={() => setConfirmarBorrar(false)}>Cancelar</button>
          <button className="btn peligro" onClick={borrar}>Borrar</button>
        </div>
      </Modal>

      {conectable && (
        <Conectar clave={agente} nombre={nombre} conexion={conexion} abierto={conectar} onCerrar={() => setConectar(false)} onCambio={cargarConexiones} />
      )}
      <Llamada clave={agente} nombre={nombre} color={info?.color ?? color} abierta={llamada} onCerrar={() => setLlamada(false)} preguntar={mandar} />
      {children}
    </div>
  );
}
