import { FAMILIA } from '@/lib/tipos';

/** "t" de Tino: trazo monolínea de puntas redondas, como el resto de la familia. */
function TinoT() {
  return (
    <svg viewBox="0 0 100 100" fill="none" stroke="#fff8ea" strokeWidth="11" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M44 16v52a14 14 0 0 0 14 14h6" />
      <path d="M22 38h44" />
    </svg>
  );
}

export const colorDe = (clave: string, color?: string | null) => color || FAMILIA[clave]?.color || '#8a8274';

/** La cara del agente: su Kot si lo tiene, si no el monograma con su color. Decorativa salvo que se pida etiqueta. */
export default function Cara({ clave, nombre, color, etiqueta }: { clave: string; nombre: string; color?: string | null; etiqueta?: boolean }) {
  const f = FAMILIA[clave];
  if (f?.kot) return <img src={f.kot} alt={etiqueta ? `Kot de ${nombre}` : ''} width={512} height={512} draggable={false} />;
  return (
    <div className="monograma" style={{ ['--c' as string]: colorDe(clave, color) }} role={etiqueta ? 'img' : undefined} aria-label={etiqueta ? nombre : undefined} aria-hidden={etiqueta ? undefined : true}>
      {clave === 'tino' ? <TinoT /> : <span style={{ fontFamily: 'var(--f-titulo)', fontSize: '2.2em', color: '#fff8ea' }}>{nombre.charAt(0).toLowerCase()}</span>}
    </div>
  );
}
