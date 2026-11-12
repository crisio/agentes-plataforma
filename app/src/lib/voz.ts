// Voz del modo llamada: dictado con el reconocimiento del navegador y lectura con speechSynthesis (local).
// El dictado lo procesa el sistema del teléfono (Apple/Google), igual que el dictado del teclado.

type Reconocedor = {
  lang: string; continuous: boolean; interimResults: boolean; maxAlternatives: number;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
};

function constructor(): (new () => Reconocedor) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { SpeechRecognition?: new () => Reconocedor; webkitSpeechRecognition?: new () => Reconocedor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const hayVoz = () => !!constructor() && typeof window !== 'undefined' && 'speechSynthesis' in window;

const idioma = () => {
  const n = typeof navigator !== 'undefined' ? navigator.language : '';
  return /^es/i.test(n) ? n : 'es-MX';
};

/**
 * Escucha una frase. Devuelve el texto final o '' si no se oyó nada. `alParcial` recibe lo que va entendiendo.
 * Rechaza con el código del navegador ('not-allowed', 'service-not-allowed', 'audio-capture', 'network'…).
 */
export function escuchar(alParcial: (t: string) => void, senal: AbortSignal): Promise<string> {
  const R = constructor();
  if (!R) return Promise.reject(new Error('sin_voz'));
  return new Promise((resolver, rechazar) => {
    const r = new R();
    r.lang = idioma();
    r.continuous = false;
    r.interimResults = true;
    r.maxAlternatives = 1;
    let final = '';
    let terminado = false;
    const fin = (f: () => void) => { if (!terminado) { terminado = true; senal.removeEventListener('abort', abortar); f(); } };
    const abortar = () => { try { r.abort(); } catch { /* ya terminó */ } fin(() => resolver('')); };
    senal.addEventListener('abort', abortar);
    r.onresult = (e) => {
      let parcial = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (res.isFinal) final += res[0].transcript;
        else parcial += res[0].transcript;
      }
      alParcial((final + ' ' + parcial).trim());
    };
    r.onerror = (e) => fin(() => (e.error === 'no-speech' || e.error === 'aborted' ? resolver(final.trim()) : rechazar(new Error(e.error))));
    r.onend = () => fin(() => resolver(final.trim()));
    try { r.start(); } catch (e) { fin(() => rechazar(e instanceof Error ? e : new Error('no_inicia'))); }
  });
}

/** Quita el markdown y lo que no se lee en voz alta (tablas, enlaces, código). */
export function textoParaLeer(md: string, hayVistas: boolean): string {
  const lineas = md.replace(/\r\n?/g, '\n').split('\n');
  const salida: string[] = [];
  let tabla = false;
  let enCodigo = false;
  for (const l of lineas) {
    if (/^\s*```/.test(l)) { enCodigo = !enCodigo; continue; }
    if (enCodigo) continue;
    if (/^\s*\|/.test(l)) { if (!tabla) { tabla = true; salida.push('Te dejé la tabla en el chat.'); } continue; }
    tabla = false;
    salida.push(l
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, 'el enlace')
      .replace(/^\s{0,3}#{1,6}\s*/, '')
      .replace(/^\s*[-*+]\s+/, '')
      .replace(/^\s*\d+[.)]\s+/, '')
      .replace(/[*_`~]+/g, '')
      .replace(/\s+·\s+/g, ', ')
      .replace(/—/g, ', '));
  }
  let t = salida.join('\n').replace(/\n{2,}/g, '\n').trim();
  if (hayVistas && !/en el chat/.test(t)) t += (t ? '\n' : '') + 'Te dejé los datos en el chat.';
  return t;
}

let vozElegida: SpeechSynthesisVoice | null | undefined;
function voz(): SpeechSynthesisVoice | null {
  if (vozElegida !== undefined) return vozElegida;
  const todas = window.speechSynthesis.getVoices();
  if (!todas.length) return null; // aún no cargan; se intenta en la próxima frase
  const es = todas.filter((v) => /^es/i.test(v.lang));
  vozElegida = es.find((v) => /es-(MX|US|419|HN)/i.test(v.lang) && v.localService) ?? es.find((v) => v.localService) ?? es[0] ?? null;
  return vozElegida;
}

/** iOS solo deja hablar si la primera frase sale de un toque: se «despierta» con una frase vacía. */
export function despertarVoz() {
  try {
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    window.speechSynthesis.speak(u);
  } catch { /* sin voz */ }
}

/** Lee el texto frase por frase (Chrome corta las frases largas). `alHablar` marca cuándo suena cada frase. */
export function leer(texto: string, senal: AbortSignal, alHablar?: (activo: boolean) => void): Promise<void> {
  const s = window.speechSynthesis;
  const frases = texto.split(/(?<=[.!?¿¡:;\n])\s+/).map((f) => f.trim()).filter(Boolean);
  return new Promise((resolver) => {
    let i = 0;
    const cortar = () => { s.cancel(); alHablar?.(false); resolver(); };
    if (senal.aborted) return cortar();
    senal.addEventListener('abort', cortar, { once: true });
    const siguiente = () => {
      if (senal.aborted) return;
      if (i >= frases.length) { senal.removeEventListener('abort', cortar); alHablar?.(false); resolver(); return; }
      const u = new SpeechSynthesisUtterance(frases[i++]);
      const v = voz();
      if (v) u.voice = v;
      u.lang = v?.lang ?? idioma();
      u.rate = 1.04;
      u.onstart = () => alHablar?.(true);
      u.onend = () => { alHablar?.(false); siguiente(); };
      u.onerror = () => { alHablar?.(false); siguiente(); };
      s.speak(u);
    };
    siguiente();
  });
}
