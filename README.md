# Agentes · plataforma

Una casa para los agentes de IA de una empresa: identidad, permisos por agente, bóveda de credenciales, chat con
herramientas y auditoría encadenada, en un solo lugar. Los agentes trabajan con los datos **adentro**: el modelo nunca
ve secretos ni escribe SQL, y cada acción queda registrada.

## Qué hace

- **Ingreso sin clave**: código de 6 dígitos por correo y, después, llaves de acceso (WebAuthn / passkeys).
- **Bóveda**: cifrado por sobres (AES-256-GCM, una llave de datos por secreto), llave maestra partida con Shamir y
  solo en memoria; arranca sellada. Entrega secretos con políticas por agente y horario.
- **Conexiones por persona**: cada usuario conecta su cuenta con el sistema de un agente por OAuth 2.1 (registro
  dinámico + PKCE) y la plataforma usa su acceso, con sus mismos permisos. El refresh token vive en la bóveda.
- **Chat** con streaming (SSE), herramientas del agente por MCP, vistas de datos (tablas con visor, tarjetas,
  archivos), respuestas sugeridas, modo llamada con la voz del navegador y avisos de «requiere atención».
- **Auditoría** solo de agregar, con hash encadenado (SHA-256) y verificación.
- App **mobile-first** (iPhone y Android), tema oscuro.

## Piezas

```
App (Next.js) ──► Gateway (.NET) ──► Orquestador (TS) ──► OpenRouter (con ZDR)
                    │  sesiones,          │
                    │  permisos, SQL      └──► Ejecutor (TS) ──► MCP de cada sistema
                    └──► Bóveda (.NET, solo localhost)
```

| Pieza | Carpeta | Puerto |
|---|---|---|
| App web | `app/` | 9941 |
| Gateway | `servicios/Agentes.Gateway` | 9942 |
| Orquestador | `orquestador/` | 9943 |
| Ejecutor | `ejecutor/` | 9944 |
| Bóveda | `servicios/Agentes.Boveda` | 9945 |

Todo escucha en `127.0.0.1`; la app se publica detrás de un túnel (p. ej. Cloudflare Tunnel). Los servicios se hablan
con tokens de servicio HMAC de vida corta y uso único.

## Requisitos

- .NET 10, Node 24 (el ejecutor y el orquestador corren TypeScript directo, sin compilar), SQL Server.
- Una cuenta de Resend para los códigos por correo y una llave de OpenRouter (se carga en la bóveda desde la app,
  como secreto `modelo/openrouter`).

## Configuración

Variables de entorno (ver `docs/fase-1-contrato.md` y `docs/fase-2-chat-contrato.md`):

| Variable | Para qué |
|---|---|
| `AGENTES_SQL_HOST/PUERTO/USUARIO/CLAVE/BASE`, `AGENTES_SQL_ESQUEMA` | Base de datos y esquema |
| `AGENTES_CLAVE_SERVICIO` | 32 bytes en base64: firma de los tokens entre servicios |
| `AGENTES_PIMIENTA` | Pimienta de los códigos de acceso |
| `RESEND_API_KEY`, `AGENTES_CORREO_REMITENTE` | Envío de códigos |
| `AGENTES_WEBAUTHN_DOMINIO` | Dominio público de la app (llaves de acceso) |
| `AGENTES_MODELO` | Id del modelo en OpenRouter |
| `AGENTES_HILO_URL_PUBLICA`, `AGENTES_HILO_URL_API` | Sistema del agente de ejemplo (MCP con OAuth) |

Nada de esto va en el repo: `.env.local` está en `.gitignore`.

## Arranque

```powershell
node scripts/aplicar-sql.mjs sql/001-esquema-agentes.sql   # y 002…005 en orden
dotnet run --project servicios/Agentes.Gateway -- --crear-admin tu@correo.com "Tu nombre"
.\deploy\arrancar.ps1            # publica y arranca todo (la bóveda queda sellada)
.\deploy\arrancar.ps1 -SinBoveda # redespliega sin sellar la bóveda
```

Entra a la app, inicializa la bóveda (guarda tu parte fuera de línea), carga `modelo/openrouter` y conecta un agente.

## Pruebas

```powershell
dotnet test servicios/Agentes.Pruebas
cd ejecutor; npm test
cd orquestador; npm test
```

Las pruebas de integración corren solo en el esquema `agentes_prueba`, nunca en el real.
