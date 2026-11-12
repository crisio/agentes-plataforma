// Ejecutor de Agentes GC (127.0.0.1:9944). Hoy: conexiones de las personas con Hilo (OAuth + MCP).
import { ClienteBoveda } from './boveda.ts';
import { ConectorOAuth } from './conector-oauth.ts';
import { crearServidor } from './servidor.ts';
import { TokenServicio } from './token-servicio.ts';

const PUERTO = Number(process.env.AGENTES_EJECUTOR_PUERTO ?? 9944);
const tokens = TokenServicio.desdeEntorno();
const boveda = new ClienteBoveda(process.env.AGENTES_BOVEDA_URL ?? 'http://127.0.0.1:9945', tokens);

const conectores: Record<string, ConectorOAuth> = {
  hilo: new ConectorOAuth({
    clave: 'hilo',
    nombre: 'Agentes GC',
    urlPublica: process.env.AGENTES_HILO_URL_PUBLICA ?? 'https://hilo.ejemplo.com',
    urlApi: process.env.AGENTES_HILO_URL_API ?? 'http://127.0.0.1:9000',
    redireccion: process.env.AGENTES_HILO_REDIRECCION ?? 'http://localhost:9941/conexiones/hilo/vuelta',
    alcance: 'hilo',
  }, boveda),
};

crearServidor(tokens, conectores).listen(PUERTO, '127.0.0.1', () => console.log(`Ejecutor escuchando en 127.0.0.1:${PUERTO}`));
