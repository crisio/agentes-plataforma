'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, textoError } from '@/lib/api';
import { tiene, useYo } from '@/lib/yo';
import { fueCancelada, guardarLlave, hayLlaves } from '@/lib/llave';
import type { Agente } from '@/lib/tipos';
import Modal from '@/components/Modal';
import Icono from '@/components/Icono';
import Cara from '@/components/Cara';
import Conectar, { type Conexion } from '@/components/Conectar';
import paquete from '../../package.json';

type Vista = 'inicio' | 'apps' | 'llaves';
type Llave = { id: number; nombre: string; sincronizada: boolean; creadaUtc: string; ultimoUsoUtc: string | null };

const fecha = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('es-HN', { day: 'numeric', month: 'short', year: 'numeric' }) : '');

/** Hoja de ajustes: tu cuenta, la bóveda, conexiones, llaves de acceso y, si te toca, la administración. */
export default function Ajustes({ abierto, vistaInicial, onCerrar }: { abierto: boolean; vistaInicial: Vista; onCerrar: () => void }) {
  const yo = useYo();
  const router = useRouter();
  const [vista, setVista] = useState<Vista>(vistaInicial);
  useEffect(() => { if (abierto) setVista(vistaInicial); }, [abierto, vistaInicial]);

  const ini = yo.nombre.trim().charAt(0).toUpperCase();
  const verBoveda = tiene(yo, 'admin_boveda', 'custodio', 'admin_plataforma');
  const admin = tiene(yo, 'admin_plataforma');
  const auditor = tiene(yo, 'admin_plataforma', 'auditor');

  async function salir() {
    try { await api('/acceso/salir', { metodo: 'POST', sinRedirigir: true }); } catch { /* igual salimos */ }
    router.replace('/entrar');
  }

  const titulo = vista === 'apps' ? 'Conectar aplicaciones' : vista === 'llaves' ? 'Llaves de acceso' : 'Ajustes';

  return (
    <Modal abierto={abierto} onCerrar={onCerrar}>
      <div className="hoja-cabeza">
        {vista === 'inicio'
          ? <button className="redondo" onClick={onCerrar} aria-label="Cerrar"><Icono n="cerrar" t={22} /></button>
          : <button className="redondo" onClick={() => setVista('inicio')} aria-label="Volver a ajustes"><Icono n="atras" t={22} /></button>}
        <h2>{titulo}</h2>
        <span />
      </div>

      {vista === 'inicio' && (
        <div className="ajustes">
          <div className="grupo">
            <div className="yo-tarjeta">
              <span className="avatar-yo" aria-hidden="true">{ini}</span>
              <div style={{ minWidth: 0 }}><b>{yo.nombre}</b><span>{yo.correo}</span></div>
            </div>
          </div>

          <div className="grupo">
            {verBoveda && (
              <Link href="/boveda" className="fila con-icono" onClick={onCerrar}>
                <span className="ico"><Icono n="boveda" /></span>
                <span className="cuerpo"><b>Bóveda</b><small>Credenciales que usan los agentes</small></span>
                <span className="flecha"><Icono n="derecha" t={18} /></span>
              </Link>
            )}
            <button className="fila con-icono" onClick={() => setVista('apps')}>
              <span className="ico"><Icono n="enchufe" /></span>
              <span className="cuerpo"><b>Conectar aplicaciones</b><small>Tu acceso a los sistemas de cada agente</small></span>
              <span className="flecha"><Icono n="derecha" t={18} /></span>
            </button>
            <button className="fila con-icono" onClick={() => setVista('llaves')}>
              <span className="ico"><Icono n="llave" /></span>
              <span className="cuerpo"><b>Llaves de acceso</b><small>Entrar con Face ID, huella o PIN</small></span>
              <span className="flecha"><Icono n="derecha" t={18} /></span>
            </button>
          </div>

          {(admin || auditor) && (
            <>
              <p className="grupo-titulo">Administración</p>
              <div className="grupo">
                {admin && (
                  <Link href="/usuarios" className="fila con-icono" onClick={onCerrar}>
                    <span className="ico"><Icono n="usuarios" /></span>
                    <span className="cuerpo"><b>Usuarios</b><small>Personas, roles y acceso a agentes</small></span>
                    <span className="flecha"><Icono n="derecha" t={18} /></span>
                  </Link>
                )}
                {auditor && (
                  <Link href="/auditoria" className="fila con-icono" onClick={onCerrar}>
                    <span className="ico"><Icono n="auditoria" /></span>
                    <span className="cuerpo"><b>Auditoría</b><small>Todo lo que pasa, con cadena verificable</small></span>
                    <span className="flecha"><Icono n="derecha" t={18} /></span>
                  </Link>
                )}
              </div>
            </>
          )}

          <div className="grupo">
            <button className="fila peligro" onClick={salir}><span className="cuerpo"><b>Cerrar sesión</b></span></button>
          </div>

          <p className="version"><b>Agentes GC</b>Versión {paquete.version}</p>
        </div>
      )}

      {vista === 'apps' && <Apps />}
      {vista === 'llaves' && <Llaves />}
    </Modal>
  );
}

function Apps() {
  const [agentes, setAgentes] = useState<Agente[] | null>(null);
  const [cx, setCx] = useState<{ conectables: string[]; conexiones: Conexion[] }>({ conectables: [], conexiones: [] });
  const [abierta, setAbierta] = useState<string | null>(null);
  const [error, setError] = useState('');

  const cargar = useCallback(() => {
    api<{ conectables: string[]; conexiones: Conexion[] }>('/conexiones').then(setCx).catch((e) => setError(textoError(e)));
  }, []);
  useEffect(() => {
    api<Agente[] | { agentes: Agente[] }>('/agentes').then((d) => setAgentes(Array.isArray(d) ? d : d.agentes ?? [])).catch((e) => setError(textoError(e)));
    cargar();
  }, [cargar]);

  const de = (clave: string) => cx.conexiones.find((x) => x.agente === clave) ?? null;

  return (
    <div className="ajustes">
      <p className="tenue" style={{ padding: '0 4px' }}>Cada agente trabaja con tu propio acceso al sistema que conoce, con tus mismos permisos allá.</p>
      {error && <p className="aviso error">{error}</p>}
      {!agentes && !error && <div className="cargando" style={{ height: 180 }} />}
      {agentes && (
        <div className="grupo">
          {agentes.map((a) => {
            const conectable = cx.conectables.includes(a.clave);
            const c = de(a.clave);
            return (
              <div key={a.clave} className="fila" aria-disabled="true">
                <CaraMini clave={a.clave} nombre={a.nombre} color={a.color} />
                <span className="cuerpo">
                  <b>{a.nombre}</b>
                  <small>{!conectable ? 'Todavía no se puede conectar' : c?.estado === 'conectada' ? `${c.herramientas ?? 0} herramientas` : c?.estado === 'reconectar' ? 'Tu acceso venció' : 'Sin conectar'}</small>
                </span>
                {conectable && (
                  <button className={`btn chico ${c?.estado === 'conectada' ? 'sec' : ''}`} onClick={() => setAbierta(a.clave)}>
                    {c?.estado === 'conectada' ? 'Conectado' : c?.estado === 'reconectar' ? 'Reconectar' : 'Conectar'}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      {agentes?.filter((a) => cx.conectables.includes(a.clave)).map((a) => (
        <Conectar key={a.clave} clave={a.clave} nombre={a.nombre} conexion={de(a.clave)} abierto={abierta === a.clave} onCerrar={() => setAbierta(null)} onCambio={cargar} />
      ))}
    </div>
  );
}

function CaraMini({ clave, nombre, color }: { clave: string; nombre: string; color?: string }) {
  return <span className="cara-mini"><Cara clave={clave} nombre={nombre} color={color} /></span>;
}

function Llaves() {
  const [llaves, setLlaves] = useState<Llave[] | null>(null);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [puede, setPuede] = useState(false);

  const cargar = useCallback(() => { api<Llave[]>('/llaves').then(setLlaves).catch((e) => setError(textoError(e))); }, []);
  useEffect(() => { setPuede(hayLlaves()); cargar(); }, [cargar]);

  async function agregar() {
    setError(''); setOk(''); setOcupado(true);
    try { const r = await guardarLlave(); setOk(`Listo: guardaste la llave «${r.nombre}».`); cargar(); }
    catch (e) { if (!fueCancelada(e)) setError(textoError(e)); }
    finally { setOcupado(false); }
  }

  async function borrar(l: Llave) {
    setError(''); setOk('');
    try { await api(`/llaves/${l.id}/borrar`, { metodo: 'POST', cuerpo: {} }); setOk(`Se borró «${l.nombre}». Bórrala también del llavero del equipo si ya no la quieres ver.`); cargar(); }
    catch (e) { setError(textoError(e)); }
  }

  return (
    <div className="ajustes">
      <p className="tenue" style={{ padding: '0 4px' }}>Con una llave entras sin código: Face ID, tu huella o el PIN del equipo. Si usas el llavero de iCloud o de Google, te sirve en tus otros equipos.</p>
      {error && <p className="aviso error">{error}</p>}
      {ok && <p className="aviso ok" role="status">{ok}</p>}
      {!llaves && !error && <div className="cargando" style={{ height: 120 }} />}
      {llaves && llaves.length > 0 && (
        <div className="grupo">
          {llaves.map((l) => (
            <div key={l.id} className="fila con-icono" aria-disabled="true">
              <span className="ico"><Icono n="llave" /></span>
              <span className="cuerpo">
                <b>{l.nombre}</b>
                <small>{l.sincronizada ? 'Sincronizada · ' : ''}Creada el {fecha(l.creadaUtc)}{l.ultimoUsoUtc ? ` · usada el ${fecha(l.ultimoUsoUtc)}` : ''}</small>
              </span>
              <button className="redondo" style={{ width: 40, height: 40 }} onClick={() => borrar(l)} aria-label={`Borrar la llave ${l.nombre}`}><Icono n="basura" t={18} /></button>
            </div>
          ))}
        </div>
      )}
      {llaves && llaves.length === 0 && <div className="grupo"><div className="fila" aria-disabled="true"><span className="cuerpo"><small style={{ whiteSpace: 'normal' }}>Todavía no tienes llaves. Entras con el código que te llega al correo.</small></span></div></div>}
      {puede
        ? <button className="btn ancho" disabled={ocupado} onClick={agregar}><Icono n="mas" />{ocupado ? 'Esperando al equipo…' : 'Agregar llave en este equipo'}</button>
        : <p className="aviso">Este navegador no permite llaves de acceso aquí. Ábrelo desde la dirección segura (https) en Safari o Chrome.</p>}
    </div>
  );
}
