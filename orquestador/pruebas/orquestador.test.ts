// Pruebas del orquestador con un OpenRouter falso y un ejecutor falso (nunca la red real).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { TokenServicio } from '../../ejecutor/src/token-servicio.ts';
import { crearModeloOpenRouter, type FuncionModelo, type PeticionModelo } from '../src/modelo.ts';
import { correrTurno, ErrorTurno, MAX_RESULTADO, type Dependencias, type Evento } from '../src/turno.ts';
import { crearServidor } from '../src/servidor.ts';

const HERRAMIENTAS = [
  { name: 'buscar_ordenes', description: 'Busca órdenes', inputSchema: { type: 'object', properties: { po: { type: 'string' } } } },
  { name: 'guardar_nota', description: 'Escribe', inputSchema: { type: 'object' } },
  { name: 'mensaje_a_companero', description: 'Manda', inputSchema: { type: 'object' } },
];

/** Modelo guionado: cada vuelta devuelve lo que diga el guion y registra lo que recibió. */
function modeloGuion(vueltas: { texto?: string; llamadas?: { name: string; args: string }[] }[]) {
  const recibidas: PeticionModelo[] = [];
  const f: FuncionModelo = async (p, alTexto) => {
    recibidas.push(structuredClone({ ...p, senal: undefined }) as any);
    const v = vueltas[Math.min(recibidas.length - 1, vueltas.length - 1)];
    if (v.texto) for (const trozo of v.texto.match(/.{1,5}/g) ?? []) alTexto(trozo);
    return { texto: v.texto ?? '', llamadas: (v.llamadas ?? []).map((l, i) => ({ id: `c${recibidas.length}_${i}`, type: 'function' as const, function: { name: l.name, arguments: l.args } })) };
  };
  return { f, recibidas };
}

function deps(modelo: FuncionModelo, extra: Partial<Dependencias> = {}) {
  const llamadas: { nombre: string; args: unknown; u: number }[] = [];
  const d: Dependencias = {
    llave: async () => 'llave-falsa',
    herramientas: async () => HERRAMIENTAS,
    llamar: async (_s, u, nombre, args) => { llamadas.push({ nombre, args, u }); return { content: [{ type: 'text', text: `resultado de ${nombre}` }] }; },
    modelo, nombreModelo: 'x-ai/grok-prueba', ahora: () => new Date('2026-11-11T18:00:00Z'),
    ...extra,
  };
  return { d, llamadas };
}

async function turno(d: Dependencias, texto = 'hola', agente = 'hilo') {
  const ev: Evento[] = [];
  await correrTurno({ agente, historial: [{ rol: 'usuario', texto: 'antes' }, { rol: 'agente', texto: 'respuesta previa' }, { rol: 'sistema', texto: 'x' }], texto }, 7, d, (e) => ev.push(e));
  return ev;
}

test('respuesta solo de texto: emite trozos y fin; el historial y el sistema llegan al modelo', async () => {
  const m = modeloGuion([{ texto: 'Hola, ¿en qué te ayudo?' }]);
  const ev = await turno(deps(m.f).d);
  assert.equal(ev.filter((e) => e.tipo === 'texto').map((e: any) => e.delta).join(''), 'Hola, ¿en qué te ayudo?');
  assert.deepEqual(ev.at(-1), { tipo: 'fin' });
  const msgs = m.recibidas[0].mensajes;
  assert.equal(msgs[0].role, 'system');
  assert.match((msgs[0] as any).content, /Hilo/);
  assert.match((msgs[0] as any).content, /11 nov 2026|nov/);
  assert.deepEqual(msgs.slice(1).map((x) => x.role), ['user', 'assistant', 'user']);   // el rol «sistema» del historial se descarta
});

test('las herramientas de escritura nunca se ofrecen al modelo', async () => {
  const m = modeloGuion([{ texto: 'ok' }]);
  await turno(deps(m.f).d);
  assert.deepEqual(m.recibidas[0].herramientas.map((h) => h.function.name), ['buscar_ordenes', 'mostrar_vista', 'sugerir_respuestas']);
});

test('bucle con herramienta: corre, emite estados y vuelve al modelo con el resultado', async () => {
  const m = modeloGuion([{ llamadas: [{ name: 'buscar_ordenes', args: '{"po":"0023"}' }] }, { texto: 'La PO 0023 viene en camino.' }]);
  const { d, llamadas } = deps(m.f);
  const ev = await turno(d);
  assert.deepEqual(llamadas, [{ nombre: 'buscar_ordenes', args: { po: '0023' }, u: 7 }]);
  const h = ev.filter((e) => e.tipo === 'herramienta') as any[];
  assert.deepEqual(h.map((x) => x.estado), ['corriendo', 'lista']);
  const tool = m.recibidas[1].mensajes.find((x) => x.role === 'tool') as any;
  assert.equal(tool.content, 'resultado de buscar_ordenes');
  assert.deepEqual(ev.at(-1), { tipo: 'fin' });
});

test('herramienta excluida o inventada: no se llama y el modelo recibe el aviso', async () => {
  const m = modeloGuion([{ llamadas: [{ name: 'guardar_nota', args: '{}' }, { name: 'no_existe', args: '{}' }] }, { texto: 'No puedo guardar desde aquí.' }]);
  const { d, llamadas } = deps(m.f);
  const ev = await turno(d);
  assert.equal(llamadas.length, 0);
  assert.deepEqual((ev.filter((e) => e.tipo === 'herramienta') as any[]).filter((x) => x.estado !== 'corriendo').map((x) => x.estado), ['error', 'error']);
});

test('tope de 6 vueltas: la última se pide sin herramientas (tool_choice none) y termina', async () => {
  const m = modeloGuion([{ llamadas: [{ name: 'buscar_ordenes', args: '{}' }] }]);
  const ev = await turno(deps(m.f).d);
  assert.equal(m.recibidas.length, 6);
  assert.equal(m.recibidas[5].soloTexto, true);
  assert.equal(m.recibidas[0].soloTexto, false);
  assert.deepEqual(ev.at(-1), { tipo: 'fin' });
});

test('resultados largos se recortan a 12 000 caracteres', async () => {
  const m = modeloGuion([{ llamadas: [{ name: 'buscar_ordenes', args: '{}' }] }, { texto: 'listo' }]);
  const { d } = deps(m.f, { llamar: async () => ({ content: [{ type: 'text', text: 'x'.repeat(50_000) }] }) });
  await turno(d);
  const tool = m.recibidas[1].mensajes.find((x) => x.role === 'tool') as any;
  assert.ok(tool.content.length < MAX_RESULTADO + 100);
  assert.match(tool.content, /recortado/);
});

test('errores: agente sin conexión, sin llave, conexión vencida', async () => {
  const m = modeloGuion([{ texto: 'x' }]);
  await assert.rejects(turno(deps(m.f).d, 'hola', 'esmy'), (e: ErrorTurno) => e.codigo === 'sin_conexion');
  assert.equal(m.recibidas.length, 0, 'Esmy no llama al modelo');
  await assert.rejects(turno(deps(m.f, { llave: async () => { throw new ErrorTurno('sin_llave_modelo'); } }).d), (e: ErrorTurno) => e.codigo === 'sin_llave_modelo');
  const m2 = modeloGuion([{ llamadas: [{ name: 'buscar_ordenes', args: '{}' }] }]);
  const vencida = deps(m2.f, { llamar: async () => { throw new ErrorTurno('reconectar'); } }).d;
  await assert.rejects(turno(vencida), (e: ErrorTurno) => e.codigo === 'reconectar');
});

// ───── Cliente de OpenRouter contra un servidor falso (stream SSE) ─────

function openRouterFalso(trozos: string[], estado = 200) {
  const cuerpos: any[] = [];
  const http = (async (_u: string | URL, init?: RequestInit) => {
    cuerpos.push(JSON.parse(String(init?.body)));
    if (estado !== 200) return new Response(JSON.stringify({ error: { message: 'No endpoints found matching your data policy' } }), { status: estado });
    const enc = new TextEncoder();
    return new Response(new ReadableStream({ start(c) { for (const t of trozos) c.enqueue(enc.encode(t)); c.close(); } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
  return { http, cuerpos };
}
const linea = (o: object) => `data: ${JSON.stringify(o)}\n\n`;

test('OpenRouter: junta texto y tool_calls partidos en trozos; manda ZDR y sin retención', async () => {
  const sse = [
    ': OPENROUTER PROCESSING\n\n',
    linea({ choices: [{ delta: { content: 'Bus' } }] }),
    linea({ choices: [{ delta: { content: 'co.' } }] }).slice(0, 10), linea({ choices: [{ delta: { content: 'co.' } }] }).slice(10),
    linea({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'buscar_', arguments: '{"po":' } }] } }] }),
    linea({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'ordenes', arguments: '"0023"}' } }] } }] }),
    'data: [DONE]\n\n',
  ];
  const f = openRouterFalso(sse);
  const deltas: string[] = [];
  const r = await crearModeloOpenRouter('http://falso', f.http)({ llave: 'k', modelo: 'm', mensajes: [{ role: 'user', content: 'hola' }], herramientas: [{ type: 'function', function: { name: 'buscar_ordenes', description: '', parameters: {} } }], senal: new AbortController().signal }, (d) => deltas.push(d));
  assert.equal(r.texto, 'Busco.');
  assert.deepEqual(deltas, ['Bus', 'co.']);
  assert.deepEqual(r.llamadas, [{ id: 'call_1', type: 'function', function: { name: 'buscar_ordenes', arguments: '{"po":"0023"}' } }]);
  assert.deepEqual(f.cuerpos[0].provider, { zdr: true, data_collection: 'deny' });
  assert.equal(f.cuerpos[0].stream, true);
  assert.equal(f.cuerpos[0].tool_choice, 'auto');
});

test('OpenRouter: sin proveedor ZDR → modelo_no_disponible con el detalle; error a mitad del stream', async () => {
  const p = { llave: 'k', modelo: 'm', mensajes: [], herramientas: [], senal: new AbortController().signal };
  await assert.rejects(crearModeloOpenRouter('http://falso', openRouterFalso([], 404).http)(p, () => {}),
    (e: any) => e.codigo === 'modelo_no_disponible' && /data policy/.test(e.message));
  await assert.rejects(crearModeloOpenRouter('http://falso', openRouterFalso([linea({ error: { message: 'Rate limited' } })]).http)(p, () => {}),
    (e: any) => e.codigo === 'modelo_no_disponible' && /Rate/.test(e.message));
});

// ───── Servidor: token, SSE ─────

test('servidor: exige token del gateway y responde en SSE', async () => {
  const ts = new TokenServicio(Buffer.alloc(32, 5));
  const m = modeloGuion([{ texto: 'Hola' }]);
  const s = crearServidor(ts, deps(m.f).d);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  try {
    const cuerpo = JSON.stringify({ agente: 'hilo', historial: [], texto: 'hola' });
    let r = await fetch(base + '/v1/turno', { method: 'POST', headers: { Authorization: 'Servicio ' + ts.crear('orquestador', 7, null, 'chat_turno') }, body: cuerpo });
    assert.equal(r.status, 401);
    r = await fetch(base + '/v1/turno', { method: 'POST', headers: { Authorization: 'Servicio ' + ts.crear('gateway', 7, null, 'chat_turno') }, body: cuerpo });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /text\/event-stream/);
    const t = await r.text();
    assert.match(t, /event: texto\ndata: \{"delta":"Hola "\}/);
    assert.match(t, /event: fin\ndata: \{\}/);
    r = await fetch(base + '/v1/turno', { method: 'POST', headers: { Authorization: 'Servicio ' + ts.crear('gateway', 7, null, 'chat_turno') }, body: JSON.stringify({ agente: 'tino', historial: [], texto: 'hola' }) });
    assert.match(await r.text(), /event: error\ndata: \{"codigo":"sin_conexion"/);
  } finally { s.close(); }
});
