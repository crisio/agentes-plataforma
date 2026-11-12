const P: Record<string, React.ReactNode> = {
  agentes: <><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><rect x="14" y="14" width="7" height="7" rx="2" /></>,
  auditoria: <><path d="M5 4h14v16H5z" /><path d="M9 9h6M9 13h6M9 17h3" /></>,
  boveda: <><rect x="4" y="10" width="16" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /><circle cx="12" cy="15.5" r="1.4" /></>,
  usuarios: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5" /><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.8c1.7.7 2.7 2.4 3 5.2" /></>,
  salir: <><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" /><path d="M10 8l-4 4 4 4M6 12h10" /></>,
  copiar: <><rect x="8" y="8" width="12" height="12" rx="2.5" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
  ojo: <><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></>,
  ojoNo: <><path d="M3 3l18 18" /><path d="M10.6 6.1A10 10 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3.2 3.9M6.6 7.6C3.8 9.4 2 12 2 12s3.6 6 10 6c1.5 0 2.8-.3 4-.8" /></>,
  mas: <path d="M12 5v14M5 12h14" />,
  atras: <path d="M15 5l-7 7 7 7" />,
  cerrar: <path d="M6 6l12 12M18 6L6 18" />,
  puntos: <><circle cx="5" cy="12" r="1.3" fill="currentColor" /><circle cx="12" cy="12" r="1.3" fill="currentColor" /><circle cx="19" cy="12" r="1.3" fill="currentColor" /></>,
  enviar: <><path d="M12 19V5" /><path d="M6 11l6-6 6 6" /></>,
  buscar: <><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></>,
  derecha: <path d="M9 5l7 7-7 7" />,
  abajo: <path d="M6 9l6 6 6-6" />,
  llave: <><circle cx="8" cy="8" r="4" /><path d="M2.5 20c.5-3.2 2.7-5 5.5-5 1.2 0 2.3.3 3.2.9" /><circle cx="17.5" cy="13.5" r="2.5" /><path d="M17.5 16v5l1.5-1.2M17.5 18.5l1.5-1" /></>,
  enchufe: <><path d="M9 3v5M15 3v5" /><path d="M6 8h12v3a6 6 0 0 1-12 0z" /><path d="M12 17v4" /></>,
  basura: <><path d="M4 7h16" /><path d="M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13" /><path d="M9 7V4h6v3" /></>,
  nuevo: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></>,
  reloj: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
  herramienta: <><path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3.5 17.5a2 2 0 0 0 3 3l5.8-5.8a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z" /></>,
  ok: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  alerta: <><path d="M12 4l9 16H3z" /><path d="M12 10v4M12 17v.5" /></>,
  conversacion: <><path d="M4 5h16v11H9l-5 4z" /></>,
  expandir: <><path d="M14 4h6v6" /><path d="M10 20H4v-6" /><path d="M20 4l-7 7M4 20l7-7" /></>,
  archivo: <><path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8z" /><path d="M14 3v5h5" /><path d="M9 13h6M9 17h4" /></>,
  descargar: <><path d="M12 4v11" /><path d="M7 10l5 5 5-5" /><path d="M5 20h14" /></>,
  microfono: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0" /><path d="M12 17.5V21" /></>,
  microfonoNo: <><path d="M3 3l18 18" /><path d="M9 9v2a3 3 0 0 0 5.1 2.1M15 10V6a3 3 0 0 0-5.7-1.3" /><path d="M5.5 11a6.5 6.5 0 0 0 10.6 5M18.5 11c0 .8-.1 1.5-.4 2.2" /><path d="M12 17.5V21" /></>,
  llamada: <><path d="M5 4.5c0-.8.7-1.5 1.5-1.5h2.2c.7 0 1.3.5 1.5 1.2l.8 3.2c.1.6-.1 1.2-.6 1.6L9 10.2a12 12 0 0 0 4.8 4.8l1.2-1.4c.4-.5 1-.7 1.6-.6l3.2.8c.7.2 1.2.8 1.2 1.5v2.2c0 .8-.7 1.5-1.5 1.5A15.5 15.5 0 0 1 5 4.5z" /></>,
  colgar: <><path d="M3.2 13.6c-.5-.5-.6-1.4-.1-2A13 13 0 0 1 21 11.6c.5.6.4 1.5-.1 2l-1.6 1.6c-.5.5-1.3.5-1.9.2l-2.6-1.4c-.5-.3-.8-.8-.8-1.4v-1.4a11 11 0 0 0-4 0v1.4c0 .6-.3 1.1-.8 1.4l-2.6 1.4c-.6.3-1.4.3-1.9-.2z" /></>,
};
export default function Icono({ n, t = 20 }: { n: string; t?: number }) {
  return (
    <svg width={t} height={t} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {P[n]}
    </svg>
  );
}
