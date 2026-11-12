# Fase 1 — Contrato: bóveda, acceso y auditoría

Este es el contrato que siguen los tres componentes de la fase 1. Si algo de aquí no se puede cumplir, se cambia este
documento primero.

## Estructura del repo

```
sql/                       migraciones idempotentes 
scripts/aplicar-sql.mjs    aplica un .sql contra la base de datos configurada con .env.local
servicios/
  Agentes.Comun/           .NET 10 class library: conexión SQL, auditoría, tokens de servicio, cripto
  Agentes.Boveda/          .NET 10 minimal API — 127.0.0.1:9945
  Agentes.Gateway/         .NET 10 minimal API — 127.0.0.1:9942 (sale por el túnel junto con la app)
  Agentes.Pruebas/         xUnit
  Agentes.sln
app/                       Next.js 15 (App Router, TS) — 0.0.0.0:9941; reescribe /api/* → 127.0.0.1:9942
```

## Configuración (variables de entorno, nunca en el repo)

| Variable | Quién la usa | Qué es |
|---|---|---|
| `AGENTES_SQL_HOST/PUERTO/USUARIO/CLAVE/BASE` | gateway, bóveda | la base de datos configurada. Se cargan de `.env.local` en la raíz del repo si existe |
| `AGENTES_CLAVE_SERVICIO` | gateway, bóveda (y el ejecutor en la fase 2) | 32 bytes base64. Firma los tokens de servicio. Si falta, el servicio no arranca |
| `AGENTES_PIMIENTA` | gateway | 32 bytes base64, se mezcla con los códigos de acceso antes del hash |
| `RESEND_API_KEY` (respaldo: `Mcp__Resend__ApiKey`) | gateway | Resend |
| `AGENTES_CORREO_REMITENTE` | gateway | Por defecto `Agentes GC <acceso@ejemplo.com>` |
| `AGENTES_SQL_ESQUEMA` | gateway, bóveda | Por defecto `agentes`. Las pruebas de integración usan `agentes_prueba`: se crea con `scripts/aplicar-sql.mjs --esquema agentes_prueba` y se borra al terminar (`--borrar-esquema agentes_prueba`). Todo el SQL del código usa el esquema configurado, nunca `agentes.` fijo |
| `AGENTES_CORREO_MODO` | gateway | `resend` o `consola`. En `consola` el código se escribe en el log y **solo** se acepta si el host es loopback |

`.env.local` se lee con un parser propio (líneas `CLAVE=valor`). Las variables de entorno reales tienen prioridad.

## Base: esquema `agentes` (ver `sql/001-esquema-agentes.sql`)

- Collation **CS_AS**: los nombres se escriben exactamente como en el SQL.
- Toda escritura de auditoría pasa por `EXEC agentes.sp_RegistrarEvento`; nunca hay un `INSERT` directo a `Evento`.
- `Detalle` es JSON enmascarado: nunca lleva valores de secretos, claves, códigos ni tokens.
- El SQL siempre va parametrizado.

## Auditoría: tipos de evento

`ingreso_codigo_enviado`, `ingreso_ok`, `ingreso_rechazado`, `clave_creada`, `sesion_cerrada`, `usuario_creado`,
`usuario_modificado`, `rol_cambiado`, `permiso_agente_cambiado`, `boveda_inicializada`, `boveda_abierta`,
`boveda_parte_rechazada`, `boveda_sellada`, `secreto_creado`, `secreto_rotado`, `secreto_revocado`,
`politica_cambiada`, `secreto_entregado`, `secreto_denegado`, `esquema_aplicado`.

## Token de servicio (gateway → bóveda, ejecutor → bóveda)

Formato: `base64url(json) + "." + base64url(HMAC-SHA256(AGENTES_CLAVE_SERVICIO, base64url(json)))`.

El JSON trae `{ "svc": "gateway"|"ejecutor", "usr": <UsuarioId|null>, "agt": <AgenteId|null>, "acc": "<acción>",
"exp": <unix s>, "jti": "<guid>" }`.

Reglas de validación:
- La firma se compara en tiempo constante.
- `exp` no puede pasar de 60 s en el futuro y no puede estar vencido.
- `jti` no se acepta dos veces mientras no venza (caché en memoria).
- Viaja en la cabecera `Authorization: Servicio <token>`.

## Bóveda (`127.0.0.1:9945`, nunca en 0.0.0.0)

**Estado:** arranca **sellada**. La maestra (32 bytes) vive solo en memoria. Si existe `agentes.BovedaLlave` es que
ya se inicializó.

**Cripto:**
- Shamir sobre GF(256), por byte, con umbral `k` de `n`. Cada parte es `[x(1 byte)] || 32 bytes`, en base64.
- Cifrado por sobres:
  1. Por cada versión se genera una llave de datos aleatoria (32 bytes).
  2. `ValorCifrado = nonce12 || AES-256-GCM(llaveDatos, valor UTF-8) || tag16`, con AAD = `nombre|version`.
  3. `LlaveEnvuelta = nonce12 || AES-256-GCM(maestra, llaveDatos) || tag16`, con AAD = `nombre|version`.
- Verificador: AES-GCM con la maestra del texto fijo `agentes-gc/verificador/v1`.
- Todo buffer con material secreto se borra con `CryptographicOperations.ZeroMemory` al terminar.

**Endpoints:** todos JSON y todos con token de servicio, salvo `estado` e `inicializar`.

| Método y ruta | Acción del token | Quién lo pide | Hace |
|---|---|---|---|
| `GET /v1/estado` | — | cualquiera en loopback | `{ inicializada, sellada, umbral, partes, partesRecibidas }` |
| `POST /v1/inicializar` `{umbral, partes}` | — (solo si no hay fila en `BovedaLlave`) | gateway en nombre de un admin_boveda | Genera la maestra, guarda el verificador y devuelve `{ partes: [base64…] }` **una sola vez**. Queda abierta |
| `POST /v1/abrir` `{parte}` | `abrir` | custodio | Junta partes. Al llegar al umbral reconstruye y verifica: si falla, descarta todas y registra `boveda_parte_rechazada` |
| `POST /v1/sellar` | `sellar` | admin_boveda | Borra la maestra de memoria |
| `GET /v1/secretos` | `listar` | admin_boveda | Solo metadatos: nombre, tipo, descripción, versión, revocado, políticas |
| `POST /v1/secretos` `{nombre, tipo, descripcion, valor}` | `crear` | admin_boveda | Versión 1 |
| `POST /v1/secretos/{nombre}/rotar` `{valor}` | `rotar` | admin_boveda | Versión +1 |
| `POST /v1/secretos/{nombre}/revocar` | `revocar` | admin_boveda | Marca `RevocadoUtc`; ya no se entrega |
| `PUT /v1/secretos/{nombre}/politicas` `[{agente, ttlSegundos, horaDesde, horaHasta}]` | `politica` | admin_boveda | Reemplaza las políticas |
| `POST /v1/entregar` `{secreto, agente, herramienta}` | `entregar` (svc **ejecutor** únicamente) | ejecutor | Valida que no esté sellada ni revocada, la política del agente y la hora de Honduras (UTC-6). Devuelve `{ valor, venceUtc }` y registra `secreto_entregado` (o `secreto_denegado`) |

Si está sellada responde **423** con `{ error: "sellada" }`. Nunca se registra ni se loguea un valor.

## Gateway (`127.0.0.1:9942`)

**Sesión:**
- Al pasar el código se emite un token aleatorio de 32 bytes, guardado como hash en `agentes.Sesion`.
- Cookie `agc_sesion`: HttpOnly, Secure (salvo en loopback), SameSite=Strict, Path=/.
- Dura 12 h, con renovación deslizante y tope de 7 días.
- Las peticiones que cambian algo exigen además la cabecera `X-Agentes: 1` (anti-CSRF simple).

**Contraseña:**
- PBKDF2-SHA256 con 310 000 iteraciones y sal de 16 bytes, en el formato `pbkdf2$iter$sal$hash`.
- Mínimo 12 caracteres.

**Código de acceso:**
- 6 dígitos, vence en 10 min, 5 intentos.
- Como máximo 3 códigos por correo cada 15 min y 20 pedidos por IP cada 15 min.

**Respuestas que no delatan:** `codigo` siempre dice `{ enviado: true }` aunque el correo no exista o la clave esté mal.
Solo se manda el correo si todo es correcto.

| Método y ruta | Permiso | Hace |
|---|---|---|
| `POST /api/acceso/codigo` `{correo, clave?}` | público | Si el usuario no tiene clave: código `crear_clave`. Si tiene y la clave es correcta: código `ingreso` |
| `POST /api/acceso/verificar` `{correo, codigo, claveNueva?}` | público | `ingreso` → sesión. `crear_clave` exige `claveNueva`, la guarda y abre sesión |
| `POST /api/acceso/salir` | sesión | Revoca la sesión |
| `GET /api/yo` | sesión | `{ id, nombre, correo, roles[], agentes:[{clave,nombre,rol}] }` |
| `GET /api/agentes` | sesión | Roster: los agentes que puede usar (todos si es admin_plataforma), con estado y color |
| `GET /api/auditoria?antesDe=&tipo=&usuario=&limite=` | admin_plataforma o auditor | Páginas de 50, más nuevas primero |
| `GET /api/auditoria/verificar` | admin_plataforma o auditor | `{ sana: bool, primeraRota?: {id, falla} }` |
| `GET/POST /api/usuarios`, `PATCH /api/usuarios/{id}` | admin_plataforma | Alta, activar o desactivar, roles de plataforma, permisos por agente y países |
| `GET /api/boveda/estado` | sesión | Proxy |
| `POST /api/boveda/inicializar`, `/abrir`, `/sellar` | admin_boveda (abrir: custodio) | Proxy con token de servicio |
| `GET/POST /api/boveda/secretos…` | admin_boveda | Proxy. El valor entra y nunca sale |

**Regla de roles:** la API no permite que una misma persona sea `admin_plataforma` y `admin_boveda`, **salvo** si
`AGENTES_EXCEPCION_ADMIN_UNICO=1`. Es una excepción temporal para instalaciones con un solo administrador.

**Arranque inicial:** `dotnet run -- --crear-admin <correo> "<nombre>"` crea el usuario sin clave, con todos los roles
de plataforma y `aprobador_critico` en los tres agentes. La primera vez que entra, crea su clave con el código.

## App (`app/`, puerto 9941)

Next.js 15 con App Router y TypeScript. Sin librerías de UI pesadas: CSS propio con tokens.

`next.config` reescribe `/api/:path*` → `http://127.0.0.1:9942/api/:path*`, así que todo va por el mismo origen y la
cookie funciona tal cual.

**Pantallas:**
1. `/entrar`: portada a la izquierda (la familia de agentes: Hilo, Esmy y Tino con sus colores y logos de
   `../marcas-agentes`, si existen; si no, monogramas) y hoja a la derecha. Tiene 3 pasos: correo y clave, código, y
   crear clave la primera vez. En el teléfono la portada se reduce a una franja.
2. `/`: roster. Una tarjeta por agente con su nombre, qué hace, estado («por conectar» o «activo») y el rol de la
   persona. Saludo con el nombre y la hora del día.
3. `/auditoria`: tabla con filtros y paginación, más un indicador «cadena íntegra» que llama a verificar.
4. `/boveda`:
   - Estado (sellada o abierta) y botón para abrir con la parte.
   - Lista de secretos (solo metadatos), crear, rotar, revocar y políticas.
   - Primera vez: inicializar, mostrar las partes **una sola vez** y pedir confirmación de que se guardaron.
5. `/usuarios`: alta, roles y permisos por agente.

**Reglas de la interfaz:**
- Español.
- Pantallas limpias, sin rótulos DEMO ni datos de ejemplo.
- Estados vacíos honestos.
- Modo oscuro.
- Que funcione en el teléfono (PWA: manifest e íconos).

## Pruebas mínimas

- **Bóveda:**
  - Shamir: reconstruye con `k` partes cualesquiera y falla con `k-1`.
  - Ida y vuelta del sobre.
  - AAD equivocado → falla.
  - Token de servicio: vencido, firma mala, `jti` repetido o `svc` equivocado → rechazado.
- **Gateway:**
  - Hash de la clave.
  - El código vence y se agotan los intentos.
  - `codigo` responde igual exista o no el correo.
  - La regla de roles.
- **Integración** contra la base de datos configurada, **siempre en el esquema `agentes_prueba`** y nunca en `agentes`. La bóveda real
  la inicializa el custodio desde la app: sus partes no las puede ver nadie más.
  - Crear admin, entrar con código en modo consola, ver el roster, inicializar la bóveda 1 de 1, crear un secreto,
    sellar, abrir, auditoría íntegra.
  - Al terminar, se borra el esquema `agentes_prueba` completo.
