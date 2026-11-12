// Cliente de OpenRouter (chat/completions con stream). Solo el catálogo propio de herramientas; ZDR y sin retención.

export type MensajeModelo =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: LlamadaModelo[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export type LlamadaModelo = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type HerramientaModelo = { type: 'function'; function: { name: string; description: string; parameters: unknown } };

export class ErrorModelo extends Error {
  readonly codigo: string;
  constructor(codigo: string, detalle?: string) { super(detalle ?? codigo); this.codigo = codigo; }
}

/** soloTexto: última vuelta; las herramientas siguen declaradas (el historial las usa) pero el modelo debe contestar. */
export type PeticionModelo = { llave: string; modelo: string; mensajes: MensajeModelo[]; herramientas: HerramientaModelo[]; senal: AbortSignal; soloTexto?: boolean };
export type RespuestaModelo = { texto: string; llamadas: LlamadaModelo[] };

/** Una vuelta del modelo: emite el texto en trozos y devuelve el texto completo y las herramientas pedidas. */
export type FuncionModelo = (p: PeticionModelo, alTexto: (delta: string) => void) => Promise<RespuestaModelo>;

export function crearModeloOpenRouter(base = 'https://openrouter.ai/api/v1', http: typeof fetch = fetch): FuncionModelo {
  return async (p, alTexto) => {
    let res: Response;
    try {
      res = await http(base + '/chat/completions', {
        method: 'POST',
        signal: p.senal,
        headers: { Authorization: 'Bearer ' + p.llave, 'Content-Type': 'application/json', 'X-Title': 'Agentes GC' },
        body: JSON.stringify({
          model: p.modelo,
          stream: true,
          messages: p.mensajes,
          ...(p.herramientas.length ? { tools: p.herramientas, tool_choice: p.soloTexto ? 'none' : 'auto' } : {}),
          provider: { zdr: true, data_collection: 'deny' },
        }),
      });
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError' || (e as { name?: string })?.name === 'TimeoutError') throw new ErrorModelo('tiempo_agotado');
      throw new ErrorModelo('modelo_no_disponible');
    }
    if (res.status === 401 || res.status === 403) throw new ErrorModelo('llave_modelo_rechazada', String(res.status));
    if (res.status === 402) throw new ErrorModelo('modelo_sin_saldo');
    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => '');
      let detalle = String(res.status);
      try { detalle = JSON.parse(t)?.error?.message ?? detalle; } catch { /* texto plano */ }
      throw new ErrorModelo('modelo_no_disponible', detalle.slice(0, 200));
    }

    let texto = '';
    const llamadas: { id: string; name: string; args: string }[] = [];
    const lector = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let resto = '';
    try {
      for (;;) {
        const { value, done } = await lector.read();
        if (done) break;
        resto += value;
        let corte: number;
        while ((corte = resto.indexOf('\n')) >= 0) {
          const linea = resto.slice(0, corte).trim();
          resto = resto.slice(corte + 1);
          if (!linea.startsWith('data:')) continue;          // comentarios «: OPENROUTER PROCESSING»
          const dato = linea.slice(5).trim();
          if (dato === '[DONE]') continue;
          let j: any;
          try { j = JSON.parse(dato); } catch { continue; }
          if (j.error) throw new ErrorModelo('modelo_no_disponible', String(j.error.message ?? j.error.code ?? 'error').slice(0, 200));
          const d = j.choices?.[0]?.delta;
          if (!d) continue;
          if (typeof d.content === 'string' && d.content) { texto += d.content; alTexto(d.content); }
          for (const tc of d.tool_calls ?? []) {
            const i = typeof tc.index === 'number' ? tc.index : llamadas.length;
            llamadas[i] ??= { id: '', name: '', args: '' };
            if (tc.id) llamadas[i].id = tc.id;
            if (tc.function?.name) llamadas[i].name += tc.function.name;
            if (tc.function?.arguments) llamadas[i].args += tc.function.arguments;
          }
        }
      }
    } catch (e) {
      if (e instanceof ErrorModelo) throw e;
      if ((e as { name?: string })?.name === 'AbortError') throw new ErrorModelo('tiempo_agotado');
      throw new ErrorModelo('modelo_no_disponible');
    }
    return {
      texto,
      llamadas: llamadas.filter((l) => l?.name).map((l, i) => ({ id: l.id || `llamada_${i}`, type: 'function', function: { name: l.name, arguments: l.args || '{}' } })),
    };
  };
}
