'use client';
// Vuelta del login de un sistema (p. ej. Hilo) cuando su redirect_uri apunta a este dominio: toma la dirección actual,
// completa la conexión y vuelve al chat. Hoy Hilo todavía devuelve a localhost (falta permitir este dominio en Hilo),
// así que esta página queda lista pero no se usa hasta ese cambio.
import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { api, textoError } from '@/lib/api';
import { textoHerramientas } from '@/components/Conectar';

export default function Vuelta() {
  const { sistema } = useParams<{ sistema: string }>();
  const router = useRouter();
  const [estado, setEstado] = useState<'conectando' | 'listo' | 'error'>('conectando');
  const [mensaje, setMensaje] = useState('');
  const hecho = useRef(false);

  const destino = () => {
    let d = '';
    try { d = sessionStorage.getItem('agc.vuelta') ?? ''; sessionStorage.removeItem('agc.vuelta'); } catch { /* sin almacenamiento */ }
    return d.startsWith('/') && !d.startsWith('//') ? d : `/chat/${encodeURIComponent(sistema)}`;
  };

  useEffect(() => {
    if (hecho.current) return; // React en desarrollo monta dos veces; el código sirve una sola vez
    hecho.current = true;
    const direccion = window.location.href;
    // La dirección lleva el código: se quita de la barra y del historial antes de usarla.
    window.history.replaceState(null, '', window.location.pathname);
    api<{ herramientas: number; nombres?: string[] }>(`/conexiones/${encodeURIComponent(sistema)}/completar`, { metodo: 'POST', cuerpo: { direccion } })
      .then((r) => {
        setEstado('listo');
        setMensaje(textoHerramientas(r.herramientas, r.nombres));
        setTimeout(() => router.replace(destino()), 1400);
      })
      .catch((e) => { setEstado('error'); setMensaje(textoError(e)); });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sistema]);

  const nombre = sistema.charAt(0).toUpperCase() + sistema.slice(1);
  return (
    <main className="vuelta">
      <div className="vuelta-caja">
        {estado === 'conectando' && <><i className="giro-grande" aria-hidden="true" /><h1>Conectando {nombre}…</h1></>}
        {estado === 'listo' && <><span className="vuelta-ok" aria-hidden="true">✓</span><h1>{nombre} quedó conectado</h1><p className="tenue">{mensaje}</p></>}
        {estado === 'error' && (
          <>
            <h1>No se pudo conectar</h1>
            <p className="aviso error">{mensaje}</p>
            <button className="btn" onClick={() => router.replace(destino())}>Volver</button>
          </>
        )}
      </div>
    </main>
  );
}
