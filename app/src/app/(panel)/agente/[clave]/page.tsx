'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { api, textoError } from '@/lib/api';
import { FAMILIA, nombreRol, type Agente } from '@/lib/tipos';
import type { ConversacionResumen } from '@/lib/chat';
import { horaCorta } from '@/lib/inicio';
import Cara, { colorDe } from '@/components/Cara';
import Cabecera from '@/components/Cabecera';
import Icono from '@/components/Icono';
import Conectar, { type Conexion } from '@/components/Conectar';

const fecha = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('es-HN', { day: 'numeric', month: 'short' }) : '');

/** Perfil del agente: quién es, tu conexión con su sistema, cuántas herramientas tiene y tus conversaciones. */
export default function PerfilAgente() {
  const { clave } = useParams<{ clave: string }>();
  const [info, setInfo] = useState<Agente | null | undefined>(undefined);
  const [cx, setCx] = useState<{ conectables: string[]; conexiones: Conexion[] } | null>(null);
  const [convs, setConvs] = useState<ConversacionResumen[] | null>(null);
  const [errorConvs, setErrorConvs] = useState('');
  const [error, setError] = useState('');
  const [conectar, setConectar] = useState(false);

  const cargarCx = useCallback(() => {
    api<{ conectables: string[]; conexiones: Conexion[] }>('/conexiones').then(setCx).catch(() => setCx({ conectables: [], conexiones: [] }));
  }, []);

  useEffect(() => {
    api<Agente[] | { agentes: Agente[] }>('/agentes')
      .then((d) => setInfo((Array.isArray(d) ? d : d.agentes ?? []).find((a) => a.clave === clave) ?? null))
      .catch((e) => setError(textoError(e)));
    cargarCx();
    api<ConversacionResumen[]>(`/chat/${clave}/conversaciones`).then(setConvs).catch((e) => { setConvs([]); setErrorConvs(textoError(e)); });
  }, [clave, cargarCx]);

  if (info === null) return (
    <main className="pagina"><Cabecera titulo="Agente" /><div className="vacio"><h3>No tienes acceso a este agente</h3><p className="tenue">Pídele a un administrador que te lo asigne.</p></div></main>
  );

  const nombre = info?.nombre ?? '';
  const color = colorDe(clave, info?.color);
  const conectable = !!cx?.conectables.includes(clave);
  const conexion = cx?.conexiones.find((x) => x.agente === clave) ?? null;
  const estadoTexto = !cx ? '' : !conectable ? 'Todavía no disponible' : conexion?.estado === 'conectada' ? 'Conectado' : conexion?.estado === 'reconectar' ? 'Reconectar' : 'Sin conectar';

  return (
    <main className="pagina" style={{ ['--c' as string]: color }}>
      <Cabecera titulo="" />
      {error && <p className="aviso error">{error}</p>}
      {info === undefined && !error && <div className="cargando" style={{ maxWidth: 640, margin: '0 auto', height: 260 }} />}
      {info && (
        <>
          <section className="perfil">
            <div className="cara-grande"><Cara clave={clave} nombre={nombre} color={info.color} etiqueta /></div>
            <h1>{nombre}</h1>
            <p>{info.descripcion ?? FAMILIA[clave]?.descripcion}</p>
            {info.rol && <span className="pastilla sin-punto">{nombreRol(info.rol)}</span>}
            <Link href={`/chat/${clave}`} className="btn" style={{ background: color, color: '#fff' }}><Icono n="conversacion" />Conversar</Link>
          </section>

          <div className="secciones">
            <div className="grupo">
              <button className="fila con-icono" onClick={() => conectable && setConectar(true)} aria-disabled={!conectable}>
                <span className="ico"><Icono n="enchufe" /></span>
                <span className="cuerpo">
                  <b>Conexión</b>
                  {conexion?.estado === 'conectada' && conexion.conectadaUtc && <small>Desde el {fecha(conexion.conectadaUtc)}</small>}
                  {cx && !conectable && <small>Su sistema todavía no está enlazado a la plataforma</small>}
                </span>
                <span className="valor" style={conexion?.estado === 'conectada' ? { color: 'var(--ok)' } : conexion?.estado === 'reconectar' ? { color: 'var(--alerta)' } : undefined}>{estadoTexto}</span>
                {conectable && <span className="flecha"><Icono n="derecha" t={18} /></span>}
              </button>
              {conexion?.estado === 'conectada' && (
                <div className="fila con-icono" aria-disabled="true">
                  <span className="ico"><Icono n="herramienta" /></span>
                  <span className="cuerpo"><b>Herramientas</b><small>El chat usa las de consulta; las que escriben o envían están apagadas por ahora</small></span>
                  <span className="valor">{conexion.herramientas ?? 0}</span>
                </div>
              )}
            </div>

            <p className="grupo-titulo">Tus conversaciones</p>
            {!convs && <div className="cargando" style={{ height: 120 }} />}
            {convs && convs.length === 0 && (
              <div className="grupo"><div className="fila" aria-disabled="true"><span className="cuerpo"><small style={{ whiteSpace: 'normal' }}>{errorConvs || `Todavía no has conversado con ${nombre}.`}</small></span></div></div>
            )}
            {convs && convs.length > 0 && (
              <div className="grupo">
                {convs.map((c) => (
                  <Link key={c.id} href={`/chat/${clave}/${c.id}`} className="fila">
                    <span className="cuerpo">
                      <b style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.titulo || c.ultimo?.texto || 'Conversación'}</b>
                      <small>{horaCorta(c.actualizadaUtc)}</small>
                    </span>
                    <span className="flecha"><Icono n="derecha" t={18} /></span>
                  </Link>
                ))}
              </div>
            )}
          </div>

          {conectable && <Conectar clave={clave} nombre={nombre} conexion={conexion} abierto={conectar} onCerrar={() => setConectar(false)} onCambio={cargarCx} />}
        </>
      )}
    </main>
  );
}
