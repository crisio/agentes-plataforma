'use client';
// Modo llamada: hablas, el agente responde en voz y vuelve a escuchar. Lo que se dice queda también en el chat.
import { useCallback, useEffect, useRef, useState } from 'react';
import Cara from '@/components/Cara';
import Icono from '@/components/Icono';
import { despertarVoz, escuchar, leer, textoParaLeer } from '@/lib/voz';

export type RespuestaLlamada = { texto: string; vistas: number; error?: string | null; textoError?: string };
type Estado = 'escuchando' | 'pensando' | 'hablando' | 'silenciado' | 'tocar' | 'sin_permiso';

const TEXTO: Record<Estado, string> = {
  escuchando: 'Te escucho…',
  pensando: 'Pensando…',
  hablando: 'Hablando',
  silenciado: 'Micrófono silenciado',
  tocar: 'Toca para hablar',
  sin_permiso: 'Permite el micrófono para este sitio en los ajustes del navegador.',
};

export default function Llamada({ clave, nombre, color, abierta, onCerrar, preguntar }: {
  clave: string; nombre: string; color?: string | null; abierta: boolean; onCerrar: () => void;
  preguntar: (texto: string) => Promise<RespuestaLlamada>;
}) {
  const [estado, setEstado] = useState<Estado>('tocar');
  const [parcial, setParcial] = useState('');
  const [ultimo, setUltimo] = useState('');
  const [sonando, setSonando] = useState(false);
  const activa = useRef(false);
  const silenciado = useRef(false);
  const corte = useRef<AbortController | null>(null);
  const corriendo = useRef(false);
  const preguntarRef = useRef(preguntar);
  preguntarRef.current = preguntar;

  const ciclo = useCallback(async () => {
    if (corriendo.current) return;
    corriendo.current = true;
    let vacios = 0;
    try {
      while (activa.current && !silenciado.current) {
        const ac = new AbortController();
        corte.current = ac;
        setEstado('escuchando');
        setParcial('');
        let dicho = '';
        try { dicho = await escuchar(setParcial, ac.signal); }
        catch (e) {
          const c = (e as Error).message;
          setEstado(c === 'not-allowed' || c === 'service-not-allowed' ? 'sin_permiso' : 'tocar');
          return;
        }
        if (!activa.current || silenciado.current || ac.signal.aborted) return;
        if (!dicho) {
          // Safari corta el dictado solo; dos silencios seguidos y se espera un toque.
          if (++vacios >= 2) { setEstado('tocar'); return; }
          continue;
        }
        vacios = 0;
        setUltimo(dicho);
        setParcial('');
        setEstado('pensando');
        const r = await preguntarRef.current(dicho);
        if (!activa.current) return;
        const decir = r.error ? (r.textoError ?? 'No pude responder.') : textoParaLeer(r.texto, r.vistas > 0) || 'Listo.';
        setEstado('hablando');
        const lectura = new AbortController();
        corte.current = lectura;
        await leer(decir, lectura.signal, setSonando);
        if (r.error) { setEstado('tocar'); return; }
      }
      if (silenciado.current) setEstado('silenciado');
    } finally {
      corriendo.current = false;
    }
  }, []);

  // Abrir: viene de un toque (gesto), así iOS deja usar el micrófono y la voz.
  useEffect(() => {
    if (!abierta) return;
    activa.current = true;
    silenciado.current = false;
    setUltimo('');
    despertarVoz();
    ciclo();
    return () => {
      activa.current = false;
      corte.current?.abort();
      try { window.speechSynthesis.cancel(); } catch { /* sin voz */ }
    };
  }, [abierta, ciclo]);

  const colgar = () => {
    activa.current = false;
    corte.current?.abort();
    try { window.speechSynthesis.cancel(); } catch { /* sin voz */ }
    onCerrar();
  };

  const alternarSilencio = () => {
    silenciado.current = !silenciado.current;
    if (silenciado.current) { corte.current?.abort(); setEstado('silenciado'); }
    else ciclo();
  };

  // Tocar la cara: si está hablando, la interrumpe; si está esperando, vuelve a escuchar.
  const tocar = () => {
    if (estado === 'hablando') { corte.current?.abort(); return; }
    if (estado === 'tocar' || estado === 'silenciado') { silenciado.current = false; ciclo(); }
  };

  useEffect(() => {
    if (!abierta) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') colgar(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  });

  if (!abierta) return null;
  const escuchando = estado === 'escuchando';
  return (
    <div className={`llamada est-${estado}${sonando ? ' sonando' : ''}`} role="dialog" aria-modal="true" aria-label={`Llamada con ${nombre}`} style={{ ['--c' as string]: color ?? undefined }}>
      <div className="llamada-fondo" aria-hidden="true" />
      <header className="llamada-cabeza">
        <span className="llamada-nombre">{nombre}</span>
        <span className="llamada-estado" aria-live="polite">{TEXTO[estado]}</span>
      </header>
      <button className="llamada-cara" onClick={tocar} aria-label={estado === 'hablando' ? 'Interrumpir' : 'Hablar'}>
        <span className="aura" aria-hidden="true" />
        <span className="aura dos" aria-hidden="true" />
        <span className="cara"><Cara clave={clave} nombre={nombre} color={color} /></span>
      </button>
      <p className="llamada-texto" aria-live="polite">{escuchando && parcial ? parcial : estado === 'pensando' || estado === 'hablando' ? ultimo : ''}</p>
      <div className="llamada-acciones">
        <button className={`llamada-boton${estado === 'silenciado' ? ' activo' : ''}`} onClick={alternarSilencio} aria-pressed={estado === 'silenciado'} aria-label={estado === 'silenciado' ? 'Activar micrófono' : 'Silenciar'}>
          <Icono n={estado === 'silenciado' ? 'microfonoNo' : 'microfono'} t={26} />
        </button>
        <button className="llamada-boton colgar" onClick={colgar} aria-label="Colgar"><Icono n="colgar" t={28} /></button>
      </div>
      <p className="llamada-nota">Lo que hablen queda escrito en el chat.</p>
    </div>
  );
}
