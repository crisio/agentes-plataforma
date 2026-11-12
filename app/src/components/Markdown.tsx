import { Fragment, type ReactNode } from 'react';

/**
 * Markdown básico y seguro para las respuestas de los agentes: párrafos, títulos, listas, tablas, código, negritas,
 * cursivas y enlaces http(s). Todo se arma como elementos de React: nunca se inyecta HTML.
 */
export default function Markdown({ texto }: { texto: string }) {
  return <div className="md">{bloques(texto)}</div>;
}

const ENLACE_SEGURO = /^(https?:\/\/|mailto:)/i;
const ES_NUMERO = /^[-+]?[\d.,\s]+(%|\s?[A-Z]{3})?$/;

function bloques(texto: string): ReactNode[] {
  const lineas = texto.replace(/\r\n?/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  let k = 0;
  while (i < lineas.length) {
    const l = lineas[i];
    if (!l.trim()) { i++; continue; }

    // ```código```
    if (/^\s*```/.test(l)) {
      const cuerpo: string[] = [];
      i++;
      while (i < lineas.length && !/^\s*```/.test(lineas[i])) cuerpo.push(lineas[i++]);
      i++;
      out.push(<pre key={k++}>{cuerpo.join('\n')}</pre>);
      continue;
    }

    // ### títulos
    const h = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(l);
    if (h) { out.push(h[1].length <= 2 ? <h3 key={k++}>{enLinea(h[2])}</h3> : <h4 key={k++}>{enLinea(h[2])}</h4>); i++; continue; }

    // | tabla |
    if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lineas.length && /^\s*\|?\s*:?-{2,}/.test(lineas[i + 1])) {
      const celdas = (s: string) => s.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const cab = celdas(l);
      i += 2;
      const filas: string[][] = [];
      while (i < lineas.length && /^\s*\|.*\|\s*$/.test(lineas[i])) filas.push(celdas(lineas[i++]));
      const numerica = cab.map((_, c) => filas.length > 0 && filas.every((f) => !f[c] || ES_NUMERO.test(f[c])));
      out.push(
        <div className="tabla-md" key={k++}>
          <table>
            <thead><tr>{cab.map((c, j) => <th key={j} className={numerica[j] ? 'num' : undefined}>{enLinea(c)}</th>)}</tr></thead>
            <tbody>{filas.map((f, r) => <tr key={r}>{cab.map((_, j) => <td key={j} className={numerica[j] ? 'num' : undefined}>{enLinea(f[j] ?? '')}</td>)}</tr>)}</tbody>
          </table>
        </div>,
      );
      continue;
    }

    // - listas / 1. listas
    const ul = /^\s*[-*•]\s+/;
    const ol = /^\s*\d+[.)]\s+/;
    if (ul.test(l) || ol.test(l)) {
      const ordenada = ol.test(l);
      const re = ordenada ? ol : ul;
      const items: string[] = [];
      while (i < lineas.length && re.test(lineas[i])) {
        let item = lineas[i++].replace(re, '');
        while (i < lineas.length && /^\s{2,}\S/.test(lineas[i]) && !ul.test(lineas[i]) && !ol.test(lineas[i])) item += ' ' + lineas[i++].trim();
        items.push(item);
      }
      const lis = items.map((it, j) => <li key={j}>{enLinea(it)}</li>);
      out.push(ordenada ? <ol key={k++}>{lis}</ol> : <ul key={k++}>{lis}</ul>);
      continue;
    }

    // párrafo (hasta línea en blanco o bloque nuevo)
    const par: string[] = [];
    while (i < lineas.length && lineas[i].trim() && !/^\s*```/.test(lineas[i]) && !/^\s{0,3}#{1,6}\s/.test(lineas[i]) && !ul.test(lineas[i]) && !ol.test(lineas[i]) && !/^\s*\|.*\|\s*$/.test(lineas[i])) par.push(lineas[i++]);
    if (par.length === 0) { out.push(<p key={k++}>{enLinea(lineas[i++])}</p>); continue; }
    out.push(<p key={k++}>{par.map((p, j) => <Fragment key={j}>{j > 0 && <br />}{enLinea(p)}</Fragment>)}</p>);
  }
  return out;
}

/** `código`, **negrita**, *cursiva* / _cursiva_, [texto](url) y direcciones sueltas. */
function enLinea(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s)]+)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let ultimo = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(s))) {
    if (m.index > ultimo) out.push(s.slice(ultimo, m.index));
    const t = m[0];
    if (m[1]) out.push(<code key={k++}>{t.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k++}>{enLinea(t.slice(2, -2))}</strong>);
    else if (m[3]) {
      const mm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(t)!;
      out.push(ENLACE_SEGURO.test(mm[2]) ? <a key={k++} href={mm[2]} target="_blank" rel="noopener noreferrer">{mm[1]}</a> : mm[1]);
    } else if (m[4]) {
      const url = t.replace(/[.,;:]+$/, '');
      out.push(<a key={k++} href={url} target="_blank" rel="noopener noreferrer">{url}</a>);
      if (url.length < t.length) out.push(t.slice(url.length));
    } else if (m[5]) out.push(<em key={k++}>{t.slice(1, -1)}</em>);
    ultimo = m.index + t.length;
  }
  if (ultimo < s.length) out.push(s.slice(ultimo));
  return out;
}
