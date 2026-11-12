// Llaves de acceso (WebAuthn): convierte entre el JSON del gateway (base64url) y lo que pide el navegador.
import { api } from '@/lib/api';

const aBuf = (s: string) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  return Uint8Array.from(b, (c) => c.charCodeAt(0)).buffer;
};
const aB64 = (b: ArrayBuffer | null) => {
  if (!b) return null;
  let s = '';
  new Uint8Array(b).forEach((x) => (s += String.fromCharCode(x)));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

export const hayLlaves = () => typeof window !== 'undefined' && !!window.PublicKeyCredential && window.isSecureContext;

/** Autocompletar de llaves en el campo de correo (iPhone, Android, Chrome, Safari). */
export async function hayAutocompletar(): Promise<boolean> {
  try { return hayLlaves() && !!(await PublicKeyCredential.isConditionalMediationAvailable?.()); } catch { return false; }
}

type Opciones = { id: string; opciones: any };

/** Entra con una llave. `condicional`: la ofrece el teclado o el autocompletar del correo sin abrir ventana. */
export async function entrarConLlave(senal?: AbortSignal, condicional = false) {
  const { id, opciones: o } = await api<Opciones>('/acceso/llave/opciones', { metodo: 'POST', cuerpo: {}, sinRedirigir: true });
  const cred = (await navigator.credentials.get({
    signal: senal,
    ...(condicional ? { mediation: 'conditional' as CredentialMediationRequirement } : {}),
    publicKey: {
      challenge: aBuf(o.challenge), rpId: o.rpId, timeout: o.timeout, userVerification: o.userVerification,
      allowCredentials: (o.allowCredentials ?? []).map((c: any) => ({ ...c, id: aBuf(c.id) })),
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('cancelada');
  const r = cred.response as AuthenticatorAssertionResponse;
  return api('/acceso/llave', {
    metodo: 'POST', sinRedirigir: true,
    cuerpo: { id, respuesta: {
      id: cred.id, rawId: aB64(cred.rawId), type: cred.type, extensions: cred.getClientExtensionResults?.() ?? {},
      response: { authenticatorData: aB64(r.authenticatorData), clientDataJSON: aB64(r.clientDataJSON), signature: aB64(r.signature), userHandle: aB64(r.userHandle) },
    } },
  });
}

/** Guarda una llave nueva para la persona con sesión. */
export async function guardarLlave(nombre?: string) {
  const { id, opciones: o } = await api<Opciones>('/llaves/opciones', { metodo: 'POST', cuerpo: {} });
  const cred = (await navigator.credentials.create({
    publicKey: {
      ...o,
      challenge: aBuf(o.challenge),
      user: { ...o.user, id: aBuf(o.user.id) },
      excludeCredentials: (o.excludeCredentials ?? []).map((c: any) => ({ ...c, id: aBuf(c.id) })),
    },
  })) as PublicKeyCredential | null;
  if (!cred) throw new Error('cancelada');
  const r = cred.response as AuthenticatorAttestationResponse;
  return api<{ registrada: boolean; nombre: string }>('/llaves/registrar', {
    metodo: 'POST',
    cuerpo: { id, nombre, respuesta: {
      id: cred.id, rawId: aB64(cred.rawId), type: cred.type, extensions: cred.getClientExtensionResults?.() ?? {},
      response: { attestationObject: aB64(r.attestationObject), clientDataJSON: aB64(r.clientDataJSON), transports: r.getTransports?.() ?? [] },
    } },
  });
}

/** El navegador cancela con NotAllowedError/AbortError cuando la persona cierra la ventana: no es un error que mostrar. */
export const fueCancelada = (e: unknown) => {
  const n = (e as { name?: string })?.name;
  return n === 'NotAllowedError' || n === 'AbortError' || (e as Error)?.message === 'cancelada';
};
