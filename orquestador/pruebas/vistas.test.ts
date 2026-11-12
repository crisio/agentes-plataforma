// Vistas, sugerencias y enlaces de archivo: validación y eventos del turno (sin red).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FuncionModelo, PeticionModelo } from '../src/modelo.ts';
import { correrTurno, type Dependencias, type Evento } from '../src/turno.ts';
import { enlacesDeArchivo, MAX_CELDA, MAX_COLUMNAS, MAX_FILAS, MAX_TARJETAS, validarSugerencias, validarVista } from '../src/vistas.ts';

test('tabla válida: recorta filas, columnas y celdas y avisa', () => {
  const columnas = Array.from({ length: 15 }, (_, i) => ({ clave: 'c' + i, titulo: 'C' + i, tipo: i === 0 ? 'numero' : 'raro' }));
  const filas = Array.from({ length: 600 }, (_, i) => ({ c0: i, c1: 'x'.repeat(400), c2: { anidado: true } }));
  const r = validarVista({ tipo: 'tabla', titulo: 'Órdenes', columnas, filas });
  assert.ok(r.ok);
  if (!r.ok || r.vista.tipo !== 'tabla') return;
  assert.equal(r.vista.columnas.length, MAX_COLUMNAS);
  assert.equal(r.vista.columnas[0].tipo, 'numero');
  assert.equal(r.vista.columnas[1].tipo, undefined, 'tipo de columna desconocido se descarta');
  assert.equal(r.vista.filas.length, MAX_FILAS);
  assert.equal((r.vista.filas[0].c1 as string).length, MAX_CELDA);
  assert.equal(r.vista.filas[0].c2, '{"anidado":true}');
  assert.equal(r.vista.filas[0].c5, null);
  assert.match(r.recortes.join(';'), /columnas.*filas/);
});

test('vistas inválidas devuelven un error que el modelo puede corregir', () => {
  assert.match((validarVista({ tipo: 'grafico', titulo: 'x' }) as any).error, /tipo/);
  assert.match((validarVista({ tipo: 'tabla' }) as any).error, /titulo/);
  assert.match((validarVista({ tipo: 'tabla', titulo: 'x', columnas: [{ clave: 'a' }] }) as any).error, /filas/);
  assert.match((validarVista({ tipo: 'tabla', titulo: 'x', columnas: [{ clave: 'a' }, { clave: 'a' }], filas: [{ a: 1 }] }) as any).error, /repetida/);
  assert.match((validarVista({ tipo: 'tabla', titulo: 'x', columnas: [{ clave: 'po' }], filas: [{ PO: '0012' }] }) as any).error, /claves/);
  assert.match((validarVista({ tipo: 'tarjetas', titulo: 'x', tarjetas: [{ valor: '1' }] }) as any).error, /titulo/);
  assert.match((validarVista({ tipo: 'resumen', titulo: 'x', cifras: [{ nombre: 'Total' }] }) as any).error, /valor/);
});

test('tarjetas y resumen se recortan', () => {
  const r = validarVista({ tipo: 'tarjetas', titulo: 'Órdenes', tarjetas: Array.from({ length: 40 }, (_, i) => ({ titulo: 'T' + i, valor: '$' + i, detalle: [{ nombre: 'a', valor: 'b' }, { nombre: '', valor: 'x' }] })) });
  assert.ok(r.ok && r.vista.tipo === 'tarjetas' && r.vista.tarjetas.length === MAX_TARJETAS && r.vista.tarjetas[0].detalle!.length === 1);
  const s = validarVista({ tipo: 'resumen', titulo: 'Totales', cifras: [{ nombre: 'Órdenes', valor: 5, nota: 'esta semana' }] });
  assert.ok(s.ok && s.vista.tipo === 'resumen' && s.vista.cifras[0].valor === '5');
});

test('sugerencias: únicas, recortadas, máximo 4', () => {
  const r = validarSugerencias({ opciones: ['Ver la PO 0012', 'Ver la PO 0012', '  ', 'x'.repeat(60), 'a', 'b', 'c'] });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.opciones.length, 4);
  assert.equal(r.opciones[1].length, 40);
  assert.equal(validarSugerencias({ opciones: 'hola' }).ok, false);
  assert.equal(validarSugerencias({ opciones: [] }).ok, false);
});

test('enlaces de archivo de Hilo se vuelven vistas de archivo con título y vencimiento', () => {
  const t = 'Listo.\n- Reporte de vencimientos: https://hilo.ejemplo.com/mcp/archivo/AbC123xyz_9876.\nOtro: https://hilo.ejemplo.com/mcp/archivo/AbC123xyz_9876';
  const v = enlacesDeArchivo(t, new Date('2026-11-11T18:00:00Z'));
  assert.equal(v.length, 1);
  assert.deepEqual(v[0], { tipo: 'archivo', titulo: 'Reporte de vencimientos', url: 'https://hilo.ejemplo.com/mcp/archivo/AbC123xyz_9876', vence: '2026-11-12T18:00:00.000Z' });
  assert.equal(enlacesDeArchivo('sin enlaces https://otro.com/x').length, 0);
});

function guion(vueltas: { texto?: string; llamadas?: { name: string; args: string }[] }[]) {
  const recibidas: PeticionModelo[] = [];
  const f: FuncionModelo = async (p, alTexto) => {
    recibidas.push(structuredClone({ ...p, senal: undefined }) as any);
    const v = vueltas[Math.min(recibidas.length - 1, vueltas.length - 1)];
    if (v.texto) alTexto(v.texto);
    return { texto: v.texto ?? '', llamadas: (v.llamadas ?? []).map((l, i) => ({ id: `c${recibidas.length}_${i}`, type: 'function' as const, function: { name: l.name, arguments: l.args } })) };
  };
  return { f, recibidas };
}

test('turno: vista, sugerencias y archivo salen como eventos; las propias no se muestran ni llegan al ejecutor', async () => {
  const tabla = JSON.stringify({ tipo: 'tabla', titulo: 'En tránsito', columnas: [{ clave: 'po', titulo: 'PO' }], filas: [{ po: '0012' }, { po: '0020' }] });
  const m = guion([
    { llamadas: [{ name: 'buscar_ordenes', args: '{}' }] },
    { llamadas: [{ name: 'mostrar_vista', args: tabla }, { name: 'sugerir_respuestas', args: '{"opciones":["Ver la PO 0012","Ver la PO 0020"]}' }, { name: 'mostrar_vista', args: '{"tipo":"tabla","titulo":"x"}' }] },
    { texto: 'Hay 2 órdenes en tránsito.' },
  ]);
  const llamadas: string[] = [];
  const d: Dependencias = {
    llave: async () => 'k',
    herramientas: async () => [{ name: 'buscar_ordenes' }, { name: 'mostrar_vista', description: 'impostora' }],
    llamar: async (_s, _u, n) => { llamadas.push(n); return { content: [{ type: 'text', text: 'PO 0012, PO 0020. Excel: https://hilo.ejemplo.com/mcp/archivo/Zz9_abcdefgh' }] }; },
    modelo: m.f, nombreModelo: 'prueba', ahora: () => new Date('2026-11-11T18:00:00Z'),
  };
  const ev: Evento[] = [];
  await correrTurno({ agente: 'hilo', historial: [], texto: '¿qué viene en tránsito?' }, 1, d, (e) => ev.push(e));

  assert.deepEqual(llamadas, ['buscar_ordenes'], 'las propias nunca van al ejecutor');
  assert.equal(m.recibidas[0].herramientas.filter((h) => h.function.name === 'mostrar_vista').length, 1, 'la impostora del sistema se descarta');
  assert.deepEqual(ev.filter((e) => e.tipo === 'herramienta').map((e: any) => `${e.nombre}:${e.estado}`), ['buscar_ordenes:corriendo', 'buscar_ordenes:lista']);
  const vistas = ev.filter((e) => e.tipo === 'vista').map((e: any) => e.vista);
  assert.deepEqual(vistas.map((v) => `${v.id}:${v.tipo}`), ['v1:archivo', 'v2:tabla']);
  assert.deepEqual((ev.find((e) => e.tipo === 'sugerencias') as any).opciones, ['Ver la PO 0012', 'Ver la PO 0020']);
  const resultados = m.recibidas[2].mensajes.filter((x) => x.role === 'tool').map((x: any) => x.content);
  assert.equal(resultados[1], '{"ok":true}');
  assert.match(resultados[3], /"ok":false.*columnas/);
  assert.equal(ev.at(-1)!.tipo, 'fin');
});
