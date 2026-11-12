export type Yo = {
  id: number | string;
  nombre: string;
  correo: string;
  roles: string[];
  agentes: { clave: string; nombre: string; rol: string }[];
};

/** Permiso de un usuario sobre un agente, como lo devuelve y lo recibe el gateway (países separados por coma). */
export type Permiso = { agente: string; rol: string; paises: string };

export type Agente = {
  clave: string;
  nombre: string;
  descripcion?: string;
  estado?: string;
  color?: string;
  rol?: string;
};

export const ROLES: { clave: string; nombre: string; nota: string }[] = [
  { clave: 'admin_plataforma', nombre: 'Administrador de la plataforma', nota: 'Usuarios, permisos y auditoría' },
  { clave: 'admin_boveda', nombre: 'Administrador de la bóveda', nota: 'Secretos y políticas' },
  { clave: 'custodio', nombre: 'Custodio', nota: 'Abre la bóveda con su parte' },
  { clave: 'auditor', nombre: 'Auditor', nota: 'Lee la auditoría' },
];

export const ROLES_AGENTE: { clave: string; nombre: string }[] = [
  { clave: 'usuario', nombre: 'Usuario' },
  { clave: 'aprobador', nombre: 'Aprobador' },
  { clave: 'aprobador_critico', nombre: 'Aprobador crítico' },
];

export const nombreRol = (c: string) =>
  (c === 'administrador' ? 'Administrador' : undefined) ??
  ROLES.find((r) => r.clave === c)?.nombre ?? ROLES_AGENTE.find((r) => r.clave === c)?.nombre ?? c.replace(/_/g, ' ');

export const PAISES = [
  { clave: 'HN', nombre: 'Honduras' },
  { clave: 'GT', nombre: 'Guatemala' },
  { clave: 'SV', nombre: 'El Salvador' },
];

/** Ficha fija de cada agente de la familia (texto de la app, no datos del servidor). */
export const FAMILIA: Record<string, { descripcion: string; color: string; kot?: string }> = {
  hilo: { descripcion: 'Sigue cada importación, de la orden al almacén, y responde por Telegram.', color: '#1B9E73', kot: '/marcas/hilo-kot.png' },
  esmy: { descripcion: 'Vigila los permisos sanitarios y avisa antes de que venzan.', color: '#6C3CF0', kot: '/marcas/esmy-kot.png' },
  tino: { descripcion: 'Arma y revisa los pedidos a proveedores con el pronóstico de consumo.', color: '#B98B5A' },
};

export function saludo(d = new Date()): string {
  const h = d.getHours();
  if (h >= 5 && h < 12) return 'Buenos días';
  if (h >= 12 && h < 19) return 'Buenas tardes';
  return 'Buenas noches';
}
