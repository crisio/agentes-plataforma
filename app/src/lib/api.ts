export class ApiError extends Error {
  status: number;
  data: unknown;
  constructor(status: number, mensaje: string, data?: unknown) {
    super(mensaje);
    this.status = status;
    this.data = data;
  }
  get sellada() {
    return this.status === 423;
  }
}

type Opciones = { metodo?: string; cuerpo?: unknown; sinRedirigir?: boolean };

/** Códigos de error del gateway y de la bóveda (campo `error`) con su texto para la pantalla. */
const MENSAJES: Record<string, string> = {
  codigo_invalido: 'El código no es válido o ya venció.',
  clave_invalida: 'La clave no cumple el mínimo de caracteres.',
  falta_cabecera_x_agentes: 'La petición no es válida. Recarga la página.',
  correo_invalido: 'El correo no es válido.',
  correo_ya_existe: 'Ya existe un usuario con ese correo.',
  nombre_invalido: 'El nombre no es válido.',
  rol_invalido: 'Uno de los roles no es válido.',
  regla_roles: 'Una misma persona no puede ser administrador de la plataforma y de la bóveda a la vez.',
  permiso_invalido: 'Uno de los accesos a agentes no es válido.',
  paises_invalidos: 'Elige al menos un país válido en cada agente.',
  agente_desconocido: 'Uno de los agentes no existe.',
  agente_repetido: 'Un agente está repetido.',
  no_puedes_quitarte_el_acceso: 'No puedes quitarte tu propio acceso de administrador ni desactivar tu cuenta.',
  no_existe: 'No se encontró lo que buscas.',
  sellada: 'La bóveda está sellada. Un custodio debe abrirla con su parte para continuar.',
  no_inicializada: 'La bóveda todavía no está inicializada. Ve a Bóveda.',
  ya_inicializada: 'La bóveda ya estaba inicializada.',
  umbral_o_partes_invalidos: 'Las partes deben ser de 1 a 10 y las necesarias no pueden pasar del total.',
  parte_invalida: 'La parte no tiene el formato correcto.',
  parte_repetida: 'Esa parte ya se había puesto.',
  reconstruccion_invalida: 'Con esas partes no se pudo abrir la bóveda. Se descartaron; vuelve a empezar.',
  ya_existe: 'Ya existe un secreto con ese nombre.',
  tipo_invalido: 'El tipo de secreto no es válido.',
  valor_invalido: 'El valor está vacío o es demasiado grande.',
  descripcion_larga: 'La descripción es demasiado larga (máximo 300).',
  ya_revocado: 'Ese secreto ya estaba revocado.',
  revocado: 'Ese secreto está revocado y no se puede rotar.',
  version_en_conflicto: 'Alguien rotó el secreto al mismo tiempo. Inténtalo otra vez.',
  politicas_invalidas: 'Las políticas no son válidas: vigencia de 1 a 60 minutos y horas completas (ambas o ninguna).',
  boveda_no_disponible: 'La bóveda no responde en este momento.',
  sin_permiso: 'No tienes permiso para hacer esto.',
  sin_sesion: 'La sesión terminó. Entra de nuevo.',
  direccion_invalida: 'Esa no es la dirección de vuelta. Copia la dirección completa de la pestaña que dice que no puede abrir localhost.',
  intento_desconocido: 'Esa dirección no corresponde a tu último intento. Vuelve a abrir el login y usa la dirección nueva.',
  intento_vencido: 'El código de Hilo dura 2 minutos y ya venció. Toca “Abrir otra vez”.',
  acceso_denegado: 'El sistema no autorizó la conexión.',
  reconectar: 'Tu acceso venció o fue revocado. Conéctate otra vez.',
  sin_conexion: 'Todavía no te has conectado.',
  sin_permiso_en_sistema: 'Ese sistema no te da acceso por esta vía. Pídele al administrador que revise tu usuario allá.',
  sistema_no_disponible: 'El sistema del agente no responde ahora.',
  tiempo_agotado: 'El sistema del agente tardó demasiado en responder.',
  sistema_error: 'El sistema del agente devolvió un error.',
  token_rechazado: 'El sistema del agente rechazó el acceso.',
  registro_rechazado: 'El sistema del agente no aceptó registrar la plataforma.',
  ejecutor_no_disponible: 'El ejecutor de la plataforma no está corriendo.',
};

function mensajeDe(status: number, data: unknown): string {
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    const c = d.error;
    if (typeof c === 'string' && MENSAJES[c]) return MENSAJES[c];
    const t = (d.mensaje ?? d.error ?? d.detalle) as unknown;
    if (typeof t === 'string' && t.includes(' ')) return t;
  }
  if (status === 423) return MENSAJES.sellada;
  if (status === 401) return 'La sesión terminó. Entra de nuevo.';
  if (status === 403) return 'No tienes permiso para hacer esto.';
  if (status === 404) return 'No se encontró lo que buscas.';
  if (status === 429) return 'Demasiados intentos. Espera unos minutos.';
  if (status >= 500) return 'El servidor no pudo responder. Inténtalo en un momento.';
  return 'No se pudo completar la acción.';
}

export async function api<T = unknown>(ruta: string, o: Opciones = {}): Promise<T> {
  const metodo = (o.metodo ?? 'GET').toUpperCase();
  const cab: Record<string, string> = { Accept: 'application/json' };
  if (metodo !== 'GET') cab['X-Agentes'] = '1';
  if (o.cuerpo !== undefined) cab['Content-Type'] = 'application/json';
  let r: Response;
  try {
    r = await fetch(`/api${ruta}`, {
      method: metodo,
      headers: cab,
      credentials: 'same-origin',
      body: o.cuerpo !== undefined ? JSON.stringify(o.cuerpo) : undefined,
    });
  } catch {
    throw new ApiError(0, 'No hay conexión con el servidor.');
  }
  let data: unknown = null;
  const txt = await r.text();
  if (txt) {
    try {
      data = JSON.parse(txt);
    } catch {
      data = null;
    }
  }
  if (r.status === 401 && !o.sinRedirigir && typeof window !== 'undefined') {
    window.location.assign('/entrar');
    throw new ApiError(401, mensajeDe(401, data), data);
  }
  if (!r.ok) throw new ApiError(r.status, mensajeDe(r.status, data), data);
  return data as T;
}

export const textoError = (e: unknown) => (e instanceof ApiError ? e.message : 'Algo salió mal. Inténtalo de nuevo.');
