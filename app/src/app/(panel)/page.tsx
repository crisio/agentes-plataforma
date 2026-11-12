'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { textoError } from '@/lib/api';
import { saludo } from '@/lib/tipos';
import { useYo } from '@/lib/yo';
import { useAjustes } from '@/lib/ajustes';
import { cargarInicio, estadoHonesto, horaCorta, motivoAtencion, type AgenteInicio } from '@/lib/inicio';
import Cara, { colorDe } from '@/components/Cara';
import Icono from '@/components/Icono';
import Modal from '@/components/Modal';
import Conectar from '@/components/Conectar';

const sinAcentos = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const CADA_MS = 20_000;

export default function Inicio() {
  const yo = useYo();
  const router = useRouter();
  const { abrir } = useAjustes();
  const [agentes, setAgentes] = useState<AgenteInicio[] | null>(null);
  const [atencion, setAtencion] = useState(0);
  const [error, setError] = useState('');
  const [buscar, setBuscar] = useState('');
  const [verAtencion, setVerAtencion] = useState(false);
  const [conectar, setConectar] = useState<AgenteInicio | null>(null);
  const cargando = useRef(false);

  const refrescar = useCallback(async () => {
    if (cargando.current) return;
    cargando.current = true;
    try {
      const d = await cargarInicio();
      setAgentes(d.agentes);
      setAtencion(d.atencion);
      setError('');
    } catch (e) {
      setAgentes((a) => { if (!a) setError(textoError(e)); return a; });
    } finally { cargando.current = false; }
  }, []);

  // Los turnos siguen corriendo en el servidor aunque se cierre el chat: al volver se refresca, y cada 20 s mientras se vea.
  useEffect(() => {
    refrescar();
    let t: ReturnType<typeof setInterval> | null = null;
    const arrancar = () => { if (!t) t = setInterval(refrescar, CADA_MS); };
    const parar = () => { if (t) { clearInterval(t); t = null; } };
    const alCambiar = () => { if (document.visibilityState === 'visible') { refrescar(); arrancar(); } else parar(); };
    if (document.visibilityState === 'visible') arrancar();
    document.addEventListener('visibilitychange', alCambiar);
    window.addEventListener('focus', refrescar);
    return () => { parar(); document.removeEventListener('visibilitychange', alCambiar); window.removeEventListener('focus', refrescar); };
  }, [refrescar]);

  const hoy = new Date().toLocaleDateString('es-HN', { weekday: 'long', day: 'numeric', month: 'long' }).replace(/^./, (x) => x.toUpperCase());
  const primero = yo.nombre.trim().split(/\s+/)[0];
  const ini = yo.nombre.trim().charAt(0).toUpperCase();

  const visibles = useMemo(() => {
    if (!agentes) return null;
    const q = sinAcentos(buscar.trim());
    if (!q) return agentes;
    return agentes.filter((a) => sinAcentos(`${a.nombre} ${a.descripcion ?? ''} ${a.ultimo?.texto ?? ''}`).includes(q));
  }, [agentes, buscar]);

  const pendientes = (agentes ?? []).filter((a) => a.atencion);
  const conBuscador = !!agentes && agentes.length > 2;

  function atender(a: AgenteInicio) {
    setVerAtencion(false);
    if (a.atencion?.motivo === 'reconectar' && a.conectable) { setConectar(a); return; }
    const id = a.atencion?.conversacionId ?? a.ultimo?.conversacionId;
    router.push(id ? `/chat/${a.clave}/${id}` : `/chat/${a.clave}`);
  }

  return (
    <main className={`inicio${conBuscador ? ' con-buscador' : ''}`}>
      <div className="inicio-barra">
        <button className="avatar-yo" onClick={() => abrir()} aria-label="Abrir ajustes">{ini}</button>
      </div>
      <div className="saludo">
        <p className="fecha">{hoy}</p>
        <h1>{saludo()}, {primero}</h1>
      </div>

      {error && <p className="aviso error" style={{ margin: '0 18px' }}>{error}</p>}
      {!visibles && !error && <div style={{ display: 'grid', gap: 12, padding: '0 18px' }}>{[0, 1, 2].map((i) => <div key={i} className="cargando" style={{ height: 76 }} />)}</div>}
      {visibles && agentes!.length === 0 && (
        <div className="vacio"><h3>Aún no tienes agentes</h3><p className="tenue">Cuando un administrador te dé acceso a uno, aparecerá aquí.</p></div>
      )}
      {visibles && agentes!.length > 0 && visibles.length === 0 && (
        <div className="vacio"><p className="tenue">Nada coincide con «{buscar}».</p></div>
      )}

      {visibles && visibles.length > 0 && (
        <nav className="lista-agentes" aria-label="Agentes">
          {visibles.map((a) => {
            const color = colorDe(a.clave, a.color);
            const est = estadoHonesto(a);
            const sinLeer = a.atencion?.motivo === 'sin_leer' ? Math.max(1, a.atencion.cantidad ?? 1) : 0;
            const destino = a.atencion?.conversacionId ?? a.ultimo?.conversacionId;
            return (
              <Link key={a.clave} href={destino ? `/chat/${a.clave}/${destino}` : `/chat/${a.clave}`} className={`conv${sinLeer ? ' sin-leer' : ''}`} style={{ ['--c' as string]: color }}
                aria-label={sinLeer ? `${a.nombre}, ${motivoAtencion(a)}` : undefined}>
                <span className="cara"><Cara clave={a.clave} nombre={a.nombre} color={a.color} /></span>
                <span style={{ minWidth: 0, display: 'grid', gap: 2 }}>
                  <span className="linea1">
                    <span className="nombre">{a.nombre}</span>
                    {a.ultimo && <span className="hora">{horaCorta(a.ultimo.momentoUtc)}</span>}
                  </span>
                  <span className="linea2">
                    {a.ultimo
                      ? <span className="vista">{a.ultimo.rol === 'usuario' ? 'Tú: ' : ''}{a.ultimo.texto}</span>
                      : <span className={`vista${est.apagado ? ' apagada' : ''}`}>{!est.apagado && <i className="punto" />}{est.texto}</span>}
                    {sinLeer > 0 && <span className="insignia" aria-hidden="true">{sinLeer > 9 ? '9+' : sinLeer}</span>}
                    {a.atencion && a.atencion.motivo !== 'sin_leer' && <span className="insignia alerta" aria-hidden="true">!</span>}
                  </span>
                </span>
              </Link>
            );
          })}
        </nav>
      )}

      {atencion > 0 && pendientes.length > 0 && (
        <button className="pildora-atencion" onClick={() => setVerAtencion(true)} aria-haspopup="dialog">
          Requiere atención<Icono n="abajo" t={18} />
        </button>
      )}

      {conBuscador && (
        <label className="buscador">
          <Icono n="buscar" t={22} />
          <span className="sr">Buscar agente o conversación</span>
          <input type="search" placeholder="Buscar" value={buscar} onChange={(e) => setBuscar(e.target.value)} enterKeyHint="search" />
          {buscar && <button type="button" onClick={() => setBuscar('')} aria-label="Borrar búsqueda"><Icono n="cerrar" t={18} /></button>}
        </label>
      )}

      <Modal abierto={verAtencion} onCerrar={() => setVerAtencion(false)}>
        <div className="hoja-cabeza">
          <button className="redondo" onClick={() => setVerAtencion(false)} aria-label="Cerrar"><Icono n="cerrar" t={22} /></button>
          <h2>Requiere atención</h2>
          <span />
        </div>
        <div className="grupo">
          {pendientes.map((a) => (
            <button key={a.clave} className="fila" onClick={() => atender(a)} style={{ ['--c' as string]: colorDe(a.clave, a.color) }}>
              <span className="cara-mini"><Cara clave={a.clave} nombre={a.nombre} color={a.color} /></span>
              <span className="cuerpo"><b>{a.nombre}</b><small className={a.atencion?.motivo === 'sin_leer' ? '' : 'motivo-alerta'}>{motivoAtencion(a)}</small></span>
              <span className="flecha"><Icono n="derecha" t={18} /></span>
            </button>
          ))}
        </div>
      </Modal>

      {conectar && (
        <Conectar clave={conectar.clave} nombre={conectar.nombre} abierto={!!conectar} onCerrar={() => setConectar(null)} onCambio={refrescar}
          conexion={conectar.conexion ? { agente: conectar.clave, estado: conectar.conexion.estado, herramientas: conectar.conexion.herramientas, escrituras: null, conectadaUtc: null, probadaUtc: null, ultimoError: null } : null} />
      )}
    </main>
  );
}
