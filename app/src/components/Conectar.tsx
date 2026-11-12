'use client';
import { useState } from 'react';
import { api, textoError } from '@/lib/api';
import Modal from '@/components/Modal';
import Icono from '@/components/Icono';

export type Conexion = {
  agente: string; estado: 'conectada' | 'reconectar' | 'desconectada'; herramientas: number | null; escrituras: number | null;
  conectadaUtc: string | null; probadaUtc: string | null; ultimoError: string | null;
};

/** Las que escriben o mandan algo: el chat no se las ofrece al modelo hasta tener aprobaciones (contrato fase 2). */
export const APAGADAS = ['programar_envio', 'mensaje_a_companero', 'pasar_archivo_a_companero', 'solicitar_al_admin', 'corregir_pago',
  'permiso_no_requiere', 'guardar_nota', 'borrar_nota', 'guardar_como_trabajo', 'guardar_herramienta', 'borrar_herramienta',
  'guardar_vista', 'armar_documento', 'memoria_hilo', 'preguntar_a_hilo', 'sql_solo_lectura'];

/** «77 herramientas: el chat usa 61 de consulta» si llegan los nombres; si no, sin inventar la cuenta. */
export function textoHerramientas(total: number, nombres?: string[]): string {
  if (nombres?.length) {
    const apagadas = nombres.filter((n) => APAGADAS.includes(n)).length;
    return `Te dio acceso a ${total} herramientas. El chat usa las ${total - apagadas} de consulta; las ${apagadas} que escriben o mandan algo (notas, mensajes a compañeros, envíos programados…) quedan apagadas por ahora.`;
  }
  return `Te dio acceso a ${total} herramientas. El chat usa las de consulta; las que escriben o mandan algo (notas, mensajes a compañeros, envíos programados…) quedan apagadas por ahora.`;
}

const CLAVE_VUELTA = 'agc.vuelta';
const esStandalone = () => typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true);

const fecha = (iso: string | null) => (iso ? new Date(iso).toLocaleString('es-HN', { day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit' }) : '');

/**
 * Conectar a la persona con el sistema de un agente por OAuth, sin tocar ese sistema: el login vuelve a «localhost»,
 * que el navegador no puede abrir, y la persona pega esa dirección aquí. El token lo guarda el ejecutor en la bóveda.
 */
export default function Conectar({ clave, nombre, conexion, abierto, onCerrar, onCambio }: {
  clave: string; nombre: string; conexion: Conexion | null; abierto: boolean; onCerrar: () => void; onCambio: () => void;
}) {
  const [paso, setPaso] = useState<'inicio' | 'pegar' | 'listo'>('inicio');
  const [direccion, setDireccion] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState('');
  const [aviso, setAviso] = useState('');
  const [resultado, setResultado] = useState<{ herramientas: number; escrituras: number; nombres?: string[] } | null>(null);
  const conectada = conexion?.estado === 'conectada';

  const cerrar = () => { setPaso('inicio'); setDireccion(''); setError(''); setAviso(''); setResultado(null); onCerrar(); };

  async function abrirLogin() {
    setError(''); setOcupado(true);
    // La pestaña se abre ya (en el clic) para que el navegador no la bloquee; la dirección llega después.
    // En la app instalada (iOS/Android) no hay pestañas: va en la misma.
    const pestana = esStandalone() ? null : window.open('', '_blank');
    try {
      const r = await api<{ url: string }>(`/conexiones/${clave}/iniciar`, { metodo: 'POST', cuerpo: {} });
      // Si el sistema ya devuelve a este dominio, la misma pestaña es lo mejor: /conexiones/<sistema>/vuelta termina sola.
      let vuelveAqui = false;
      try { vuelveAqui = new URL(new URL(r.url).searchParams.get('redirect_uri') ?? '').origin === window.location.origin; } catch { /* dirección rara */ }
      if (vuelveAqui || !pestana) {
        pestana?.close();
        try { sessionStorage.setItem(CLAVE_VUELTA, window.location.pathname); } catch { /* sin almacenamiento */ }
        window.location.assign(r.url);
        return;
      }
      pestana.location.href = r.url;
      setPaso('pegar');
    } catch (e) { pestana?.close(); setError(textoError(e)); }
    finally { setOcupado(false); }
  }

  async function completar() {
    setError(''); setOcupado(true);
    try {
      const r = await api<{ herramientas: number; escrituras: number; nombres?: string[] }>(`/conexiones/${clave}/completar`, { metodo: 'POST', cuerpo: { direccion } });
      setResultado(r); setPaso('listo'); onCambio();
    } catch (e) { setError(textoError(e)); }
    finally { setOcupado(false); }
  }

  async function probar() {
    setError(''); setAviso(''); setOcupado(true);
    try {
      const r = await api<{ herramientas: number }>(`/conexiones/${clave}/probar`, { metodo: 'POST', cuerpo: {} });
      setAviso(`Responde bien: ${r.herramientas} herramientas disponibles.`); onCambio();
    } catch (e) { setError(textoError(e)); onCambio(); }
    finally { setOcupado(false); }
  }

  async function desconectar() {
    setError(''); setOcupado(true);
    try { await api(`/conexiones/${clave}/desconectar`, { metodo: 'POST', cuerpo: {} }); onCambio(); cerrar(); }
    catch (e) { setError(textoError(e)); }
    finally { setOcupado(false); }
  }

  return (
    <Modal abierto={abierto} onCerrar={cerrar}>
      <div className="hoja-cabeza">
        <button className="redondo" onClick={cerrar} aria-label="Cerrar"><Icono n="cerrar" t={22} /></button>
        <h2>Conexión</h2>
        <span />
      </div>
      {paso === 'listo' && resultado ? (
        <>
          <div>
            <h2>{nombre} quedó conectado</h2>
            <p className="tenue" style={{ marginTop: 8 }}>
              {textoHerramientas(resultado.herramientas, resultado.nombres)}
            </p>
          </div>
          <p className="aviso">Tu acceso quedó guardado en la bóveda. Dura 30 días mientras lo uses; si vence, aquí mismo te pedirá reconectar.</p>
          <div className="modal-pie"><button className="btn" onClick={cerrar}>Listo</button></div>
        </>
      ) : conectada && paso === 'inicio' ? (
        <>
          <div>
            <h2>{nombre}</h2>
            <p className="tenue" style={{ marginTop: 8 }}>
              Conectado desde {fecha(conexion!.conectadaUtc)} · {conexion!.herramientas ?? 0} herramientas.
              {conexion!.probadaUtc && ` Última prueba: ${fecha(conexion!.probadaUtc)}.`}
            </p>
          </div>
          {aviso && <p className="aviso ok">{aviso}</p>}
          {error && <p className="aviso error">{error}</p>}
          <div className="modal-pie">
            <button className="btn peligro" disabled={ocupado} onClick={desconectar}>Desconectar</button>
            <button className="btn sec" disabled={ocupado} onClick={abrirLogin}>Reconectar</button>
            <button className="btn" disabled={ocupado} onClick={probar}>{ocupado ? 'Probando…' : 'Probar conexión'}</button>
          </div>
        </>
      ) : (
        <>
          <div>
            <h2>Conectar {nombre}</h2>
            <p className="tenue" style={{ marginTop: 8 }}>
              {conexion?.estado === 'reconectar' ? `Tu acceso a ${nombre} venció. ` : ''}
              Entras a {nombre} con tu correo una sola vez y la plataforma usa tu acceso, con tus mismos permisos.
            </p>
          </div>
          <ol className="pasos-conectar">
            <li className={paso === 'inicio' ? 'activo' : 'hecho'}>
              <b>Entra a {nombre}</b>
              <span className="tenue">Se abre en otra pestaña. Pon tu correo y el código que te llega.</span>
              <button className={`btn chico ${paso === 'inicio' ? '' : 'sec'}`} disabled={ocupado} onClick={abrirLogin}>
                {paso === 'inicio' ? `Abrir ${nombre}` : 'Abrir otra vez'}
              </button>
            </li>
            <li className={paso === 'pegar' ? 'activo' : ''}>
              <b>Pega la dirección de vuelta</b>
              <span className="tenue">Al terminar, esa pestaña dirá que no puede abrir <code>localhost</code>. Es lo esperado: copia la dirección completa (botón Compartir → Copiar) y pégala aquí. Tienes 2 minutos.</span>
              <textarea className="entrada" rows={3} placeholder="http://localhost:9941/conexiones/…" value={direccion}
                onChange={(e) => setDireccion(e.target.value)} disabled={paso !== 'pegar' || ocupado} spellCheck={false} />
            </li>
          </ol>
          {error && <p className="aviso error">{error}</p>}
          <div className="modal-pie">
            <button className="btn sec" onClick={cerrar}>Cancelar</button>
            <button className="btn" disabled={paso !== 'pegar' || !direccion.trim().startsWith('http') || ocupado} onClick={completar}>
              {ocupado && paso === 'pegar' ? 'Conectando…' : 'Conectar'}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
