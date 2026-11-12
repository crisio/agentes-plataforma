'use client';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { api, textoError } from '@/lib/api';
import { Agente, nombreRol, PAISES, Permiso, ROLES, ROLES_AGENTE } from '@/lib/tipos';
import Icono from '@/components/Icono';
import Cabecera from '@/components/Cabecera';
import Modal from '@/components/Modal';

type Usuario = {
  id: number | string;
  nombre: string;
  correo: string;
  activo: boolean;
  roles: string[];
  permisos: Permiso[];
};

const vacio = (): Usuario => ({ id: 0, nombre: '', correo: '', activo: true, roles: [], permisos: [] });

export default function Usuarios() {
  const [lista, setLista] = useState<Usuario[] | null>(null);
  const [agentes, setAgentes] = useState<Agente[]>([]);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const [edit, setEdit] = useState<Usuario | null>(null);

  const cargar = useCallback(async () => {
    try {
      const d = await api<Usuario[] | { usuarios: Usuario[] }>('/usuarios');
      setLista((Array.isArray(d) ? d : d.usuarios ?? []).map((x) => ({ ...x, permisos: x.permisos ?? [] })));
    } catch (e) { setError(textoError(e)); }
  }, []);

  useEffect(() => {
    cargar();
    api<Agente[] | { agentes: Agente[] }>('/agentes').then((d) => setAgentes(Array.isArray(d) ? d : d.agentes ?? [])).catch(() => {});
  }, [cargar]);

  return (
    <main className="pagina">
      <Cabecera titulo="Usuarios" acciones={<button className="redondo" onClick={() => setEdit(vacio())} aria-label="Nuevo usuario"><Icono n="mas" t={22} /></button>} />
      {error && <p className="aviso error" style={{ marginBottom: 16 }}>{error}</p>}
      {ok && <p className="aviso ok" role="status" style={{ marginBottom: 16 }}>{ok}</p>}
      {!lista && !error && <div className="cargando" />}
      {lista && lista.length === 0 && <div className="tarjeta vacio"><h3>Sin usuarios</h3><p className="tenue">Da de alta a la primera persona.</p></div>}
      <div className="lista-usuarios">
        {lista?.map((u) => (
          <button key={u.id} className={`tarjeta usuario${u.activo ? '' : ' inactivo'}`} onClick={() => setEdit(u)}>
            <span className="avatar">{u.nombre.charAt(0).toUpperCase()}</span>
            <span style={{ minWidth: 0 }}>
              <b>{u.nombre}</b>
              <span className="tenue" style={{ fontSize: 14 }}>{u.correo}</span>
              <span className="etq">
                {u.roles.map((r) => <span key={r} className="pastilla sin-punto">{nombreRol(r)}</span>)}
                {u.permisos.map((a) => <span key={a.agente} className="pastilla kraft">{a.agente} · {nombreRol(a.rol)}</span>)}
              </span>
            </span>
            <span>{!u.activo && <span className="pastilla alerta">Desactivado</span>}</span>
          </button>
        ))}
      </div>

      <Modal abierto={!!edit} onCerrar={() => setEdit(null)}>
        {edit && <Editor u={edit} agentes={agentes} onCancelar={() => setEdit(null)} onFin={async (m) => { setEdit(null); setOk(m); await cargar(); }} />}
      </Modal>
    </main>
  );
}

function Editor({ u, agentes, onFin, onCancelar }: { u: Usuario; agentes: Agente[]; onFin: (m: string) => void; onCancelar: () => void }) {
  const nuevo = u.id === 0;
  const [v, setV] = useState<Usuario>({ ...u });
  const [error, setError] = useState('');
  const [ocupado, setOcupado] = useState(false);

  const alterna = (lista: string[], x: string) => (lista.includes(x) ? lista.filter((y) => y !== x) : [...lista, x]);
  const permisoDe = (clave: string) => v.permisos.find((a) => a.agente === clave);
  const paisesDe = (clave: string) => (permisoDe(clave)?.paises ?? '').split(',').filter(Boolean);
  const ponAgente = (clave: string, rol: string) =>
    setV({ ...v, permisos: [...v.permisos.filter((a) => a.agente !== clave), ...(rol ? [{ agente: clave, rol, paises: permisoDe(clave)?.paises || 'HN,GT,SV' }] : [])] });
  const ponPaises = (clave: string, p: string) =>
    setV({ ...v, permisos: v.permisos.map((a) => (a.agente === clave ? { ...a, paises: alterna(paisesDe(clave), p).join(',') } : a)) });

  async function guardar(e: FormEvent) {
    e.preventDefault();
    setOcupado(true); setError('');
    const cuerpo = nuevo
      ? { nombre: v.nombre.trim(), correo: v.correo.trim(), roles: v.roles, permisos: v.permisos }
      : { nombre: v.nombre.trim(), activo: v.activo, roles: v.roles, permisos: v.permisos };
    try {
      if (nuevo) await api('/usuarios', { metodo: 'POST', cuerpo });
      else await api(`/usuarios/${u.id}`, { metodo: 'PATCH', cuerpo });
      onFin(nuevo ? 'Usuario creado. Entrará con un código a su correo y creará su clave.' : 'Cambios guardados.');
    } catch (x) { setError(textoError(x)); setOcupado(false); }
  }

  return (
    <form className="form" onSubmit={guardar}>
      <h2>{nuevo ? 'Nuevo usuario' : v.nombre}</h2>
      {nuevo ? (
        <div className="dos">
          <div className="campo"><label htmlFor="u-nombre">Nombre</label><input id="u-nombre" className="entrada" required autoFocus value={v.nombre} onChange={(e) => setV({ ...v, nombre: e.target.value })} /></div>
          <div className="campo"><label htmlFor="u-correo">Correo</label><input id="u-correo" className="entrada" type="email" required value={v.correo} onChange={(e) => setV({ ...v, correo: e.target.value })} /></div>
        </div>
      ) : <p className="tenue">{u.correo}</p>}

      <div className="campo">
        <span className="etiqueta">Roles de la plataforma</span>
        <div className="checks">
          {ROLES.map((r) => (
            <label key={r.clave} className="check">
              <input type="checkbox" checked={v.roles.includes(r.clave)} onChange={() => setV({ ...v, roles: alterna(v.roles, r.clave) })} />
              <span>{r.nombre}<small>{r.nota}</small></span>
            </label>
          ))}
        </div>
      </div>

      <div className="campo">
        <span className="etiqueta">Acceso por agente y países</span>
        {agentes.length === 0 && <p className="mas-tenue">No hay agentes registrados.</p>}
        {agentes.map((a) => (
          <div key={a.clave} style={{ display: 'grid', gap: 8, marginBottom: 12 }}>
            <div className="perm-agente">
              <span>{a.nombre}</span>
              <select className="entrada" aria-label={`Rol en ${a.nombre}`} value={permisoDe(a.clave)?.rol ?? ''} onChange={(e) => ponAgente(a.clave, e.target.value)}>
                <option value="">Sin acceso</option>
                {ROLES_AGENTE.map((r) => <option key={r.clave} value={r.clave}>{r.nombre}</option>)}
              </select>
            </div>
            {permisoDe(a.clave) && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {PAISES.map((p) => (
                  <label key={p.clave} className="check" style={{ padding: '6px 12px', alignItems: 'center' }}>
                    <input type="checkbox" style={{ margin: 0 }} aria-label={`${p.nombre} en ${a.nombre}`} checked={paisesDe(a.clave).includes(p.clave)} onChange={() => ponPaises(a.clave, p.clave)} />
                    {p.nombre}
                  </label>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {!nuevo && (
        <label className="check">
          <input type="checkbox" checked={v.activo} onChange={(e) => setV({ ...v, activo: e.target.checked })} />
          <span>Cuenta activa<small>Si la desactivas, no podrá entrar ni usar agentes.</small></span>
        </label>
      )}

      {error && <p className="aviso error" role="alert">{error}</p>}
      <div className="modal-pie">
        <button type="button" className="btn sec" onClick={onCancelar}>Cancelar</button>
        <button className="btn" disabled={ocupado}>{nuevo ? 'Crear usuario' : 'Guardar'}</button>
      </div>
    </form>
  );
}
