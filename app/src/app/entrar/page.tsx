'use client';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError, textoError } from '@/lib/api';
import { entrarConLlave, fueCancelada, guardarLlave, hayAutocompletar, hayLlaves } from '@/lib/llave';

const EQUIPO = [
  { clave: 'hilo', nombre: 'Hilo', rol: 'Importaciones', img: '/marcas/hilo-kot.png' },
  { clave: 'esmy', nombre: 'Esmy', rol: 'Permisos sanitarios', img: '/marcas/esmy-kot.png' },
];

function Portada() {
  return (
    <section className="portada" aria-label="Agentes GC">
      <div className="marca-fila">
        <img src="/icono.svg" width={38} height={38} alt="" />
        <span className="nombre">Agentes GC</span>
      </div>
      <div className="escenario">
        <svg className="hilo-cable" viewBox="0 0 600 200" preserveAspectRatio="none" aria-hidden="true">
          <defs>
            <linearGradient id="cable" x1="0" x2="1">
              <stop offset="0" stopColor="#1B9E73" />
              <stop offset=".5" stopColor="#8f6bff" />
              <stop offset="1" stopColor="#B98B5A" />
            </linearGradient>
          </defs>
          <path d="M60 170 C 150 10, 270 10, 300 120 S 470 10, 540 170" fill="none" stroke="url(#cable)" strokeWidth="2.5" strokeLinecap="round" strokeDasharray="1 11" opacity=".9" />
        </svg>
        <div className="equipo">
          <div className="celda">
            <div className="integrante"><div className="figura"><img src={EQUIPO[0].img} alt="" /></div></div>
            <div className="etiqueta-agente"><b>Hilo</b><span>Importaciones</span></div>
          </div>
          <div className="celda">
            <div className="integrante"><div className="figura"><img src={EQUIPO[1].img} alt="" /></div></div>
            <div className="etiqueta-agente"><b>Esmy</b><span>Permisos sanitarios</span></div>
          </div>
          <div className="celda">
            <div className="integrante">
              <div className="figura">
                <div className="monograma" style={{ ['--c' as string]: '#B98B5A', width: '62%', aspectRatio: '1', height: 'auto' }} role="img" aria-label="Tino">
                  <svg viewBox="0 0 100 100" fill="none" stroke="#fff8ea" strokeWidth="11" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M44 16v52a14 14 0 0 0 14 14h6" />
                    <path d="M22 38h44" />
                  </svg>
                </div>
              </div>
            </div>
            <div className="etiqueta-agente"><b>Tino</b><span>Pedidos</span></div>
          </div>
        </div>
      </div>
      <h1 className="titular">
        Un equipo que <em>trabaja</em> contigo.
      </h1>
    </section>
  );
}

const CLAVE_CORREO = 'agc.correo';
const CLAVE_NO_OFRECER = 'agc.llave.no';
const leer = (k: string) => { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } };
const escribir = (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } };

export default function Entrar() {
  const router = useRouter();
  const [paso, setPaso] = useState<1 | 2 | 3>(1);
  const [correo, setCorreo] = useState('');
  const [codigo, setCodigo] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [ocupado, setOcupado] = useState(false);
  const [conLlaves, setConLlaves] = useState(false);
  const condicional = useRef<AbortController | null>(null);

  // Recuerda el correo y, si el equipo tiene una llave guardada, la ofrece en el mismo campo (sin ventana).
  useEffect(() => {
    setCorreo(leer(CLAVE_CORREO));
    setConLlaves(hayLlaves());
    let vivo = true;
    hayAutocompletar().then((si) => {
      if (!si || !vivo) return;
      const ac = new AbortController();
      condicional.current = ac;
      entrarConLlave(ac.signal, true).then(() => router.replace('/')).catch(() => { /* la persona eligió otro camino */ });
    });
    return () => { vivo = false; condicional.current?.abort(); };
  }, [router]);

  async function conLlave() {
    setError(''); setOcupado(true);
    condicional.current?.abort();
    try { await entrarConLlave(); router.replace('/'); }
    catch (x) {
      setOcupado(false);
      if (!fueCancelada(x)) setError(x instanceof ApiError && x.status === 401 ? 'Esa llave no está registrada aquí. Entra con tu correo y guárdala de nuevo.' : textoError(x));
    }
  }

  async function pedirCodigo(e?: FormEvent) {
    e?.preventDefault();
    setError(''); setInfo(''); setOcupado(true);
    try {
      await api('/acceso/codigo', { metodo: 'POST', cuerpo: { correo: correo.trim() }, sinRedirigir: true });
      escribir(CLAVE_CORREO, correo.trim());
      setCodigo('');
      setPaso(2);
    } catch (x) {
      setError(textoError(x));
    } finally { setOcupado(false); }
  }

  async function verificar(e?: FormEvent, valor = codigo) {
    e?.preventDefault();
    setError('');
    if (valor.length !== 6) { setError('El código tiene 6 dígitos.'); return; }
    setOcupado(true);
    try {
      await api('/acceso/verificar', { metodo: 'POST', cuerpo: { correo: correo.trim(), codigo: valor }, sinRedirigir: true });
      condicional.current?.abort();
      // Ofrecer la llave solo si el equipo la soporta, la persona no tiene ninguna y no dijo «ahora no» hace poco.
      const no = Number(leer(CLAVE_NO_OFRECER) || 0);
      if (hayLlaves() && Date.now() - no > 30 * 86400_000) {
        const llaves = await api<unknown[]>('/llaves').catch(() => [1]);
        if (Array.isArray(llaves) && llaves.length === 0) { setOcupado(false); setPaso(3); return; }
      }
      router.replace('/');
    } catch (x) {
      setError(x instanceof ApiError && x.status < 500 ? 'El código no es válido o ya venció.' : textoError(x));
      setOcupado(false);
    }
  }

  async function guardar() {
    setError(''); setOcupado(true);
    try { await guardarLlave(); router.replace('/'); }
    catch (x) { setOcupado(false); if (!fueCancelada(x)) setError(textoError(x)); }
  }

  return (
    <main className="entrar">
      <Portada />
      <section className="hoja">
        <div className="hoja-interior">
          <div className="pasos" aria-label={`Paso ${paso} de 3`}>
            {[1, 2, 3].map((i) => <i key={i} className={i <= paso ? 'on' : ''} />)}
          </div>

          {paso === 1 && (
            <form className="form" onSubmit={pedirCodigo}>
              <div>
                <h2>Entrar</h2>
                <p className="tenue" style={{ marginTop: 8 }}>Te mandamos un código a tu correo. Sin claves.</p>
              </div>
              <div className="campo">
                <label htmlFor="correo">Correo</label>
                <input id="correo" className="entrada" type="email" inputMode="email" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  autoComplete="username webauthn" required value={correo} onChange={(e) => setCorreo(e.target.value)} />
              </div>
              {error && <p className="aviso error" role="alert">{error}</p>}
              <button className="btn" disabled={ocupado || !correo.includes('@')}>{ocupado ? 'Enviando…' : 'Enviar código'}</button>
              {conLlaves && (
                <>
                  <div className="o-separador"><span>o</span></div>
                  <button type="button" className="btn sec llave" disabled={ocupado} onClick={conLlave}>
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <circle cx="8" cy="8" r="4" /><path d="M2.5 20c.5-3.2 2.7-5 5.5-5 1.2 0 2.3.3 3.2.9" /><circle cx="17.5" cy="13.5" r="2.5" /><path d="M17.5 16v5l1.5-1.2M17.5 18.5l1.5-1" />
                    </svg>
                    Entrar con llave de acceso
                  </button>
                </>
              )}
            </form>
          )}

          {paso === 2 && (
            <form className="form" onSubmit={verificar}>
              <div>
                <h2>Revisa tu correo</h2>
                <p className="tenue" style={{ marginTop: 8 }}>Enviamos un código de 6 dígitos a <b style={{ color: 'var(--tinta)' }}>{correo}</b>.</p>
              </div>
              <div className="campo">
                <label htmlFor="codigo" className="sr">Código</label>
                <input id="codigo" className="entrada codigo" inputMode="numeric" pattern="[0-9]*" autoComplete="one-time-code" maxLength={6} autoFocus placeholder="······"
                  value={codigo} onChange={(e) => { const v = e.target.value.replace(/\D/g, '').slice(0, 6); setCodigo(v); if (v.length === 6 && !ocupado) verificar(undefined, v); }} />
              </div>
              {info && <p className="aviso ok" role="status">{info}</p>}
              {error && <p className="aviso error" role="alert">{error}</p>}
              <button className="btn" disabled={ocupado || codigo.length !== 6}>{ocupado ? 'Verificando…' : 'Entrar'}</button>
              <div className="pie-hoja">
                <button type="button" className="btn texto" onClick={() => { setPaso(1); setError(''); }}>Cambiar correo</button>
                <button type="button" className="btn texto" disabled={ocupado} onClick={async () => { await pedirCodigo(); setInfo('Enviamos otro código.'); }}>Enviar otro código</button>
              </div>
            </form>
          )}

          {paso === 3 && (
            <div className="form">
              <div>
                <h2>La próxima, sin código</h2>
                <p className="tenue" style={{ marginTop: 8 }}>
                  Guarda una llave de acceso en este equipo y entra con Face ID, tu huella o el PIN. Si usas el llavero de iCloud o de Google,
                  también te sirve en tus otros equipos.
                </p>
              </div>
              {error && <p className="aviso error" role="alert">{error}</p>}
              <button className="btn" disabled={ocupado} onClick={guardar}>{ocupado ? 'Esperando al equipo…' : 'Guardar llave de acceso'}</button>
              <div className="pie-hoja">
                <button type="button" className="btn texto" disabled={ocupado} onClick={() => { escribir(CLAVE_NO_OFRECER, String(Date.now())); router.replace('/'); }}>Ahora no</button>
              </div>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
