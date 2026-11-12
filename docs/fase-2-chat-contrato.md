# Fase 2 · Chat con los agentes — contrato

Lo comparten el frontend (`app/`) y el backend (`servicios/`, `ejecutor/`, `orquestador/`). Si algo cambia, se cambia
aquí primero.

## Piezas

```
App (Next, 127.0.0.1:9941) ──/api/chat/*──► Gateway (9942) ──► Orquestador (TS, 127.0.0.1:9943) ──► OpenRouter (Grok, ZDR)
                                              │  guarda conversaciones          │
                                              │  y mensajes en SQL              └──► Ejecutor (9944) ──► Hilo /mcp (por persona)
                                              └─ valida sesión y permiso por agente
```

- **Orquestador sin estado ni SQL**: el gateway le manda el historial; el orquestador corre el bucle del modelo
  (máximo 6 vueltas de herramientas, 120 s) y devuelve eventos. El gateway los reenvía a la app (SSE) y al final
  guarda el mensaje del agente.
- **Llave del modelo**: secreto `modelo/openrouter` en la bóveda (lo carga el admin desde la pantalla Bóveda). El
  orquestador lo pide a `/v1/modelo/entregar` (svc `orquestador`, solo nombres que empiezan con `modelo/`), lo usa y no
  lo guarda más de 5 minutos en memoria.
- **Modelo**: `AGENTES_MODELO` = `deepseek/deepseek-v4.1-flash` (decisión del 11-nov-2026; tiene proveedores ZDR en OpenRouter),
  con `provider: { zdr: true, data_collection: "deny" }`. Sin herramientas propias del proveedor.
- **Herramientas de Hilo**: solo las de lectura. Las que escriben o mandan algo quedan fuera hasta tener aprobaciones:
  `programar_envio, mensaje_a_companero, pasar_archivo_a_companero, solicitar_al_admin, corregir_pago,
  permiso_no_requiere, guardar_nota, borrar_nota, guardar_como_trabajo, guardar_herramienta, borrar_herramienta,
  guardar_vista, armar_documento, memoria_hilo, preguntar_a_hilo, sql_solo_lectura`.
- **El modelo nunca ve secretos.** Los resultados de herramientas se recortan (máx. 12 000 caracteres por resultado).

## SQL (`sql/004-chat.sql`)

- `agentes.Conversacion (Id INT IDENTITY, UsuarioId, AgenteId, Titulo NVARCHAR(120) NULL, CreadaUtc, ActualizadaUtc)`
- `agentes.Mensaje (Id BIGINT IDENTITY, ConversacionId, Rol VARCHAR(12) CHECK IN ('usuario','agente'),
  Texto NVARCHAR(MAX), Herramientas NVARCHAR(MAX) NULL /* JSON: [{nombre, estado, ms}] */, CreadoUtc, Error VARCHAR(60) NULL)`

## API del gateway (con sesión; permiso por agente igual que conexiones)

| Método | Ruta | Respuesta |
|---|---|---|
| GET | `/api/inicio` | `{ agentes: [{ clave, nombre, descripcion, color, rol, conectable, conexion: {estado, herramientas} \| null, ultimo: { conversacionId, texto, rol, momentoUtc } \| null }] }` ordenado por último mensaje |
| GET | `/api/chat/{agente}/conversaciones` | `[{ id, titulo, actualizadaUtc, ultimo }]` (máx. 50) |
| GET | `/api/chat/conversaciones/{id}` | `{ id, agente, titulo, mensajes: [{ id, rol, texto, herramientas, momentoUtc, error }] }` (solo del dueño) |
| POST | `/api/chat/{agente}` body `{ conversacionId?: number, texto: string (1–4000) }` | **SSE** (`text/event-stream`), eventos abajo |
| POST | `/api/chat/conversaciones/{id}/borrar` | `{ borrada: true }` |

### Eventos SSE (`event: <tipo>` + `data: <json>`)

| Tipo | Datos |
|---|---|
| `inicio` | `{ conversacionId, mensajeUsuarioId }` |
| `texto` | `{ delta }` — trozos del texto del agente, en orden |
| `herramienta` | `{ id, nombre, estado: 'corriendo' \| 'lista' \| 'error', ms? }` |
| `fin` | `{ mensajeId }` |
| `error` | `{ codigo, detalle? }` — p. ej. `sin_llave_modelo`, `sellada`, `sin_conexion`, `reconectar`, `modelo_no_disponible`, `tiempo_agotado` |

Si llega `error` después de `texto`, el gateway guarda lo que hubo con `Error` puesto.

## Agentes sin conexión

Esmy y Tino todavía no tienen herramientas: el chat responde con el error `sin_conexion` y la app muestra el estado
honesto («Todavía no está conectado»). Hilo sin conexión de la persona: `sin_conexion` y la app ofrece conectar.

## Adenda 11-nov · Vistas de datos, sugerencias y modo llamada

### Herramientas propias de la plataforma (no salen del servidor)

El orquestador ofrece al modelo, además de las de Hilo, dos herramientas que no llaman a nadie: solo producen eventos.

- `mostrar_vista` — el modelo arma una vista con datos que **ya trajo** de una herramienta (nunca inventados):
  `{ tipo: 'tabla' | 'tarjetas' | 'resumen', titulo, subtitulo?, columnas?: [{ clave, titulo, tipo?: 'texto'|'numero'|'moneda'|'fecha'|'estado' }], filas?: object[] (máx. 500), tarjetas?: [{ titulo, subtitulo?, valor?, etiqueta?, detalle?: [{ nombre, valor }] }] (máx. 30), cifras?: [{ nombre, valor, nota? }] (para 'resumen') }`
- `sugerir_respuestas` — `{ opciones: string[] (máx. 4, ≤ 40 caracteres) }`: botones de respuesta rápida bajo el mensaje.

Las dos devuelven al modelo `{ ok: true }` y el orquestador emite:

| Tipo SSE | Datos |
|---|---|
| `vista` | `{ id, ...la vista validada }` |
| `sugerencias` | `{ opciones }` |

El gateway las guarda con el mensaje del agente: columna `Vistas NVARCHAR(MAX) NULL` (JSON `[vista]`) y
`Sugerencias NVARCHAR(MAX) NULL` (JSON `string[]`) en `agentes.Mensaje` (`sql/005-vistas.sql`), y las devuelve en
`GET /api/chat/conversaciones/{id}` como `vistas` y `sugerencias` de cada mensaje.

Además, si una herramienta de Hilo devuelve enlaces de archivo (`/mcp/archivo/...`), el orquestador emite
`vista` con `tipo: 'archivo'` `{ titulo, url, vence? }` para mostrarlo como tarjeta.

### App

- Tarjetas en carrusel horizontal (como las de la referencia), tabla compacta (primeras 6 filas) con botón
  «Ver todo» que abre el **visor** a pantalla completa: búsqueda, ordenar por columna, filas tocables con detalle;
  totales en columnas numéricas. Sin exportar (es una acción sensible: va con aprobaciones después).
- Sugerencias como píldoras bajo el último mensaje del agente; tocar una la envía.
- **Modo llamada**: botón en la barra de escribir. Pantalla completa con el Kot animado; escucha con el
  reconocimiento de voz del navegador (`SpeechRecognition`/`webkitSpeechRecognition`, es-HN), manda el turno al
  terminar de hablar, lee la respuesta con `speechSynthesis` (voz en español) y vuelve a escuchar. Botones: silenciar,
  colgar. En la llamada se lee el texto, no las tablas («te dejé la tabla en el chat»). Si el navegador no tiene
  reconocimiento de voz, el botón no aparece. Nota de datos: el dictado lo procesa el sistema del teléfono (Apple/Google),
  igual que el dictado del teclado; la voz que lee es local.

### Requiere atención (inicio)

- **El turno no se corta si la persona cierra la pantalla.** El gateway sigue leyendo el SSE del orquestador hasta el
  final (tope 150 s) y guarda el mensaje completo; solo deja de reenviarlo. Ya no existe el error `cancelado`
  (si se pasa del tope: `tiempo_agotado`).
- **Lectura:** `agentes.Conversacion.LeidaHastaId` (`sql/005-vistas.sql`). `GET /api/chat/conversaciones/{id}` la deja
  leída hasta su último mensaje. Un turno en vivo la deja leída si la persona siguió conectada hasta el final
  (`fin` o `error`).
- **`GET /api/inicio`** agrega:
  - arriba, `atencion: number` — cuántos agentes requieren atención;
  - en cada agente, `atencion: { motivo: 'sin_leer' | 'reconectar' | 'error', cantidad: number, conversacionId: number | null } | null`.
    Prioridad: `reconectar` (la conexión de la persona quedó en estado reconectar; `cantidad` 1, sin conversación) >
    `error` (el último mensaje del agente tiene `Error` **y todavía no se leyó**; `cantidad` 1) > `sin_leer`
    (mensajes del agente posteriores a `LeidaHastaId`; `conversacionId` = la más reciente con mensajes sin leer).
    Un error que la persona ya vio en vivo no queda pidiendo atención.
