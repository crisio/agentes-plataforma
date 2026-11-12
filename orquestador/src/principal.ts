// Orquestador de Agentes GC (127.0.0.1:9943).
// Modelo por AGENTES_MODELO. Por defecto DeepSeek V4.1 Flash (11-nov-2026; tiene proveedores ZDR). Verificado con
// GET https://openrouter.ai/api/v1/models en cuanto exista la llave (y que tenga un proveedor con ZDR).
import { TokenServicio } from '../../ejecutor/src/token-servicio.ts';
import { crearEjecutor, crearLlave } from './dependencias.ts';
import { crearModeloOpenRouter } from './modelo.ts';
import { crearServidor } from './servidor.ts';

const PUERTO = Number(process.env.AGENTES_ORQUESTADOR_PUERTO ?? 9943);
const tokens = TokenServicio.desdeEntorno();
const ejecutor = crearEjecutor(tokens, process.env.AGENTES_EJECUTOR_URL ?? 'http://127.0.0.1:9944');

const deps = {
  llave: crearLlave(tokens, process.env.AGENTES_BOVEDA_URL ?? 'http://127.0.0.1:9945', process.env.AGENTES_LLAVE_MODELO ?? 'modelo/openrouter'),
  herramientas: ejecutor.herramientas,
  llamar: ejecutor.llamar,
  modelo: crearModeloOpenRouter(process.env.AGENTES_OPENROUTER_URL ?? 'https://openrouter.ai/api/v1'),
  nombreModelo: process.env.AGENTES_MODELO ?? 'deepseek/deepseek-v4.1-flash',
};

crearServidor(tokens, deps).listen(PUERTO, '127.0.0.1', () => console.log(`Orquestador escuchando en 127.0.0.1:${PUERTO} · modelo ${deps.nombreModelo}`));
