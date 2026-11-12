using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Agentes.Comun;
using Dapper;
using Microsoft.AspNetCore.Http.Features;

namespace Agentes.Gateway;

/// <summary>Cliente del orquestador (127.0.0.1:9943): un turno de chat en SSE.</summary>
public sealed class ClienteOrquestador(HttpClient http, TokenServicio tokens)
{
    public async Task<HttpResponseMessage> TurnoAsync(int usuarioId, object cuerpo, CancellationToken ct)
    {
        var req = new HttpRequestMessage(HttpMethod.Post, "/v1/turno");
        req.Headers.Authorization = new AuthenticationHeaderValue("Servicio", tokens.Crear("gateway", usuarioId, null, "chat_turno"));
        req.Content = new StringContent(JsonSerializer.Serialize(cuerpo), Encoding.UTF8, "application/json");
        return await http.SendAsync(req, HttpCompletionOption.ResponseHeadersRead, ct);
    }
}

/// <summary>
/// Chat con los agentes (contrato en docs/fase-2-chat-contrato.md). El gateway valida sesión y permiso, guarda la
/// conversación y reenvía en SSE lo que produce el orquestador. El texto nunca va a la auditoría.
/// </summary>
public static class EndpointsChat
{
    public sealed record PeticionChat(int? ConversacionId, string? Texto);
    sealed record FilaInicio(int AgenteId, string Clave, string Nombre, string? Descripcion, string? Color, string? Rol,
        string? Estado, int? Herramientas, int? ConversacionId, string? Texto, string? MRol, DateTime? Momento,
        int SinLeer, int? ConvSinLeer, int? ConvError);
    sealed record FilaConversacion(int Id, string? Titulo, DateTime ActualizadaUtc, string? Texto, string? MRol, DateTime? Momento);
    sealed record FilaMensaje(long Id, string Rol, string Texto, string? Herramientas, DateTime CreadoUtc, string? Error, string? Vistas, string? Sugerencias);

    static JsonElement? JsonO(string? s)
    {
        if (string.IsNullOrEmpty(s)) return null;
        try { return JsonDocument.Parse(s).RootElement.Clone(); } catch (JsonException) { return null; }
    }

    /// <summary>
    /// «Requiere atención» de un agente para la persona: reconectar &gt; error sin leer &gt; mensajes sin leer.
    /// </summary>
    static object? Atencion(FilaInicio f)
    {
        if (f.Estado == "reconectar") return new { motivo = "reconectar", cantidad = 1, conversacionId = (int?)null };
        if (f.ConvError is int ce) return new { motivo = "error", cantidad = 1, conversacionId = (int?)ce };
        if (f.SinLeer > 0) return new { motivo = "sin_leer", cantidad = f.SinLeer, conversacionId = f.ConvSinLeer };
        return null;
    }
    sealed record FilaDueno(int Id, int UsuarioId, int AgenteId, string Clave, string? Titulo);
    sealed record FilaHistorial(string Rol, string Texto);

    const int MaxHistorial = 30;
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    static DateTime Utc(DateTime d) => DateTime.SpecifyKind(d, DateTimeKind.Utc);
    static DateTime? Utc(DateTime? d) => d is null ? null : Utc(d.Value);

    /// <summary>Id del agente si la persona puede usarlo (permiso explícito o admin de la plataforma).</summary>
    static async Task<int?> AgentePermitido(BaseDatos bd, HttpContext ctx, string clave)
    {
        var s = ctx.Sesion()!;
        await using var c = await bd.AbrirAsync(ctx.RequestAborted);
        return await c.ExecuteScalarAsync<int?>(new CommandDefinition($"""
            SELECT a.Id FROM {bd.E}.Agente a
            LEFT JOIN {bd.E}.PermisoAgente p ON p.AgenteId = a.Id AND p.UsuarioId = @u
            WHERE a.Clave = @clave AND (@todos = 1 OR p.UsuarioId IS NOT NULL)
            """, new { u = s.UsuarioId, clave, todos = s.Tiene("admin_plataforma") }, cancellationToken: ctx.RequestAborted));
    }

    public static void Mapear(WebApplication app)
    {
        var bd = app.Services.GetRequiredService<BaseDatos>();
        var aud = app.Services.GetRequiredService<Auditoria>();
        var orquestador = app.Services.GetRequiredService<ClienteOrquestador>();
        var log = app.Logger;

        // ───── Inicio: agentes con su conexión y el último mensaje ─────
        app.MapGet("/api/inicio", async (HttpContext ctx) =>
        {
            var s = ctx.Sesion()!;
            await using var c = await bd.AbrirAsync(ctx.RequestAborted);
            var filas = await c.QueryAsync<FilaInicio>(new CommandDefinition($"""
                SELECT a.Id AS AgenteId, a.Clave, a.Nombre, a.Descripcion, a.Color, p.Rol, x.Estado, x.Herramientas,
                       u.ConversacionId, u.Texto, u.MRol, u.Momento,
                       ISNULL(sl.SinLeer, 0) AS SinLeer, sl.ConvSinLeer, er.ConvError
                FROM {bd.E}.Agente a
                LEFT JOIN {bd.E}.PermisoAgente p ON p.AgenteId = a.Id AND p.UsuarioId = @u
                LEFT JOIN {bd.E}.Conexion x ON x.AgenteId = a.Id AND x.UsuarioId = @u
                OUTER APPLY (SELECT TOP 1 m.ConversacionId, LEFT(m.Texto, 160) AS Texto, m.Rol AS MRol, m.CreadoUtc AS Momento
                             FROM {bd.E}.Mensaje m JOIN {bd.E}.Conversacion cv ON cv.Id = m.ConversacionId
                             WHERE cv.UsuarioId = @u AND cv.AgenteId = a.Id ORDER BY m.Id DESC) u
                -- Mensajes del agente posteriores a lo leído, y la conversación más reciente que los tiene.
                OUTER APPLY (SELECT COUNT(1) AS SinLeer, MAX(m.ConversacionId) AS ConvSinLeer
                             FROM {bd.E}.Mensaje m JOIN {bd.E}.Conversacion cv ON cv.Id = m.ConversacionId
                             WHERE cv.UsuarioId = @u AND cv.AgenteId = a.Id AND m.Rol = 'agente' AND m.Id > ISNULL(cv.LeidaHastaId, 0)) sl
                -- Último mensaje del agente con error, si la persona todavía no lo vio.
                OUTER APPLY (SELECT TOP 1 CASE WHEN m.Error IS NOT NULL AND m.Id > ISNULL(cv.LeidaHastaId, 0) THEN m.ConversacionId END AS ConvError
                             FROM {bd.E}.Mensaje m JOIN {bd.E}.Conversacion cv ON cv.Id = m.ConversacionId
                             WHERE cv.UsuarioId = @u AND cv.AgenteId = a.Id AND m.Rol = 'agente' ORDER BY m.Id DESC) er
                WHERE @todos = 1 OR p.UsuarioId IS NOT NULL
                ORDER BY CASE WHEN u.Momento IS NULL THEN 1 ELSE 0 END, u.Momento DESC, a.Id
                """, new { u = s.UsuarioId, todos = s.Tiene("admin_plataforma") }, cancellationToken: ctx.RequestAborted));
            var todos = s.Tiene("admin_plataforma");
            var lista = filas.ToList();
            return Results.Ok(new
            {
                atencion = lista.Count(f => Atencion(f) is not null),
                agentes = lista.Select(f => new
                {
                    clave = f.Clave, nombre = f.Nombre, descripcion = f.Descripcion, color = f.Color,
                    rol = f.Rol ?? (todos ? "administrador" : null),
                    conectable = EndpointsConexiones.Conectables.Contains(f.Clave),
                    conexion = f.Estado is null ? null : new { estado = f.Estado, herramientas = f.Herramientas },
                    ultimo = f.ConversacionId is null ? null : new { conversacionId = f.ConversacionId, texto = f.Texto, rol = f.MRol, momentoUtc = Utc(f.Momento) },
                    atencion = Atencion(f),
                }),
            });
        }).RequiereSesion();

        // ───── Conversaciones ─────
        app.MapGet("/api/chat/{agente}/conversaciones", async (HttpContext ctx, string agente) =>
        {
            var s = ctx.Sesion()!;
            var agenteId = await AgentePermitido(bd, ctx, agente);
            if (agenteId is null) return Results.Json(new { error = "sin_permiso" }, statusCode: 403);
            await using var c = await bd.AbrirAsync(ctx.RequestAborted);
            var filas = await c.QueryAsync<FilaConversacion>(new CommandDefinition($"""
                SELECT TOP 50 cv.Id, cv.Titulo, cv.ActualizadaUtc, u.Texto, u.MRol, u.Momento
                FROM {bd.E}.Conversacion cv
                OUTER APPLY (SELECT TOP 1 LEFT(m.Texto, 160) AS Texto, m.Rol AS MRol, m.CreadoUtc AS Momento
                             FROM {bd.E}.Mensaje m WHERE m.ConversacionId = cv.Id ORDER BY m.Id DESC) u
                WHERE cv.UsuarioId = @u AND cv.AgenteId = @a ORDER BY cv.ActualizadaUtc DESC
                """, new { u = s.UsuarioId, a = agenteId }, cancellationToken: ctx.RequestAborted));
            return Results.Ok(filas.Select(f => new
            {
                id = f.Id, titulo = f.Titulo, actualizadaUtc = Utc(f.ActualizadaUtc),
                ultimo = f.Texto is null ? null : new { texto = f.Texto, rol = f.MRol, momentoUtc = Utc(f.Momento) },
            }));
        }).RequiereSesion();

        async Task<FilaDueno?> Dueno(HttpContext ctx, int id)
        {
            await using var c = await bd.AbrirAsync(ctx.RequestAborted);
            var f = await c.QuerySingleOrDefaultAsync<FilaDueno>(new CommandDefinition(
                $"SELECT cv.Id, cv.UsuarioId, cv.AgenteId, a.Clave, cv.Titulo FROM {bd.E}.Conversacion cv JOIN {bd.E}.Agente a ON a.Id = cv.AgenteId WHERE cv.Id = @id",
                new { id }, cancellationToken: ctx.RequestAborted));
            return f is not null && f.UsuarioId == ctx.Sesion()!.UsuarioId ? f : null;
        }

        app.MapGet("/api/chat/conversaciones/{id:int}", async (HttpContext ctx, int id) =>
        {
            var cv = await Dueno(ctx, id);
            if (cv is null) return Results.Json(new { error = "no_existe" }, statusCode: 404);
            await using var c = await bd.AbrirAsync(ctx.RequestAborted);
            var msgs = (await c.QueryAsync<FilaMensaje>(new CommandDefinition(
                $"SELECT TOP 500 Id, Rol, Texto, Herramientas, CreadoUtc, Error, Vistas, Sugerencias FROM {bd.E}.Mensaje WHERE ConversacionId = @id ORDER BY Id DESC",
                new { id }, cancellationToken: ctx.RequestAborted))).Reverse().ToList();
            // Abrirla la deja leída hasta su último mensaje (solo avanza).
            if (msgs.Count > 0)
                await c.ExecuteAsync(new CommandDefinition(
                    $"UPDATE {bd.E}.Conversacion SET LeidaHastaId = @hasta WHERE Id = @id AND ISNULL(LeidaHastaId, 0) < @hasta",
                    new { id, hasta = msgs[^1].Id }, cancellationToken: ctx.RequestAborted));
            return Results.Ok(new
            {
                id = cv.Id, agente = cv.Clave, titulo = cv.Titulo,
                mensajes = msgs.Select(m => new
                {
                    id = m.Id, rol = m.Rol, texto = m.Texto, momentoUtc = Utc(m.CreadoUtc), error = m.Error,
                    herramientas = JsonO(m.Herramientas), vistas = JsonO(m.Vistas), sugerencias = JsonO(m.Sugerencias),
                }),
            });
        }).RequiereSesion();

        app.MapPost("/api/chat/conversaciones/{id:int}/borrar", async (HttpContext ctx, int id) =>
        {
            var cv = await Dueno(ctx, id);
            if (cv is null) return Results.Json(new { error = "no_existe" }, statusCode: 404);
            await using var c = await bd.AbrirAsync(ctx.RequestAborted);
            await c.ExecuteAsync(new CommandDefinition($"DELETE {bd.E}.Conversacion WHERE Id = @id", new { id }, cancellationToken: ctx.RequestAborted));
            var s = ctx.Sesion()!;
            await aud.RegistrarAsync("web", "conversacion_borrada", "ok", s.UsuarioId, cv.AgenteId, cv.Clave, new { conversacionId = id }, ctx.Ip(), ctx.RequestAborted);
            return Results.Ok(new { borrada = true });
        }).RequiereSesion();

        // ───── Un turno de chat (SSE) ─────
        app.MapPost("/api/chat/{agente}", async (HttpContext ctx, string agente, PeticionChat? body) =>
        {
            var s = ctx.Sesion()!;
            var agenteId = await AgentePermitido(bd, ctx, agente);
            if (agenteId is null) { await Results.Json(new { error = "sin_permiso" }, statusCode: 403).ExecuteAsync(ctx); return; }
            var texto = body?.Texto?.Trim() ?? "";
            if (texto.Length is < 1 or > 4000) { await Results.Json(new { error = "texto_invalido" }, statusCode: 400).ExecuteAsync(ctx); return; }

            int conversacionId;
            List<FilaHistorial> historial;
            long mensajeUsuarioId;
            await using (var c = await bd.AbrirAsync(ctx.RequestAborted))
            {
                if (body!.ConversacionId is int pedido)
                {
                    var cv = await Dueno(ctx, pedido);
                    if (cv is null || cv.AgenteId != agenteId) { await Results.Json(new { error = "no_existe" }, statusCode: 404).ExecuteAsync(ctx); return; }
                    conversacionId = cv.Id;
                }
                else
                {
                    var titulo = texto.Length <= 60 ? texto : texto[..60].TrimEnd() + "…";
                    conversacionId = await c.ExecuteScalarAsync<int>(new CommandDefinition(
                        $"INSERT {bd.E}.Conversacion (UsuarioId, AgenteId, Titulo) OUTPUT inserted.Id VALUES (@u, @a, @titulo)",
                        new { u = s.UsuarioId, a = agenteId, titulo }, cancellationToken: ctx.RequestAborted));
                }
                historial = (await c.QueryAsync<FilaHistorial>(new CommandDefinition(
                    $"SELECT TOP {MaxHistorial} Rol, Texto FROM {bd.E}.Mensaje WHERE ConversacionId = @id AND Texto <> N'' ORDER BY Id DESC",
                    new { id = conversacionId }, cancellationToken: ctx.RequestAborted))).Reverse().ToList();
                mensajeUsuarioId = await c.ExecuteScalarAsync<long>(new CommandDefinition($"""
                    INSERT {bd.E}.Mensaje (ConversacionId, Rol, Texto) OUTPUT inserted.Id VALUES (@id, 'usuario', @texto);
                    UPDATE {bd.E}.Conversacion SET ActualizadaUtc = SYSUTCDATETIME() WHERE Id = @id;
                    """, new { id = conversacionId, texto }, cancellationToken: ctx.RequestAborted));
            }

            // SSE: sin buffering ni compresión en el camino (no-transform frena la compresión de Next).
            ctx.Response.StatusCode = 200;
            ctx.Response.ContentType = "text/event-stream; charset=utf-8";
            ctx.Response.Headers.CacheControl = "no-cache, no-transform";
            ctx.Response.Headers["X-Accel-Buffering"] = "no";
            ctx.Features.Get<IHttpResponseBodyFeature>()?.DisableBuffering();
            // El turno NO depende de que la persona siga en la pantalla: se consume el SSE del orquestador hasta el
            // final (con tope) y se guarda completo. Si la persona se fue, solo se deja de reenviar.
            using var tope = new CancellationTokenSource(TimeSpan.FromSeconds(150));
            var ct = tope.Token;
            var clienteVivo = true;
            async Task Enviar(string tipo, string datosJson)
            {
                if (!clienteVivo || ctx.RequestAborted.IsCancellationRequested) { clienteVivo = false; return; }
                try
                {
                    await ctx.Response.WriteAsync($"event: {tipo}\ndata: {datosJson}\n\n", ctx.RequestAborted);
                    await ctx.Response.Body.FlushAsync(ctx.RequestAborted);
                }
                catch (Exception e) when (e is IOException or OperationCanceledException or InvalidOperationException) { clienteVivo = false; }
            }

            var respuesta = new StringBuilder();
            var herramientas = new List<Dictionary<string, object?>>();
            var vistas = new List<JsonElement>();
            string[]? sugerencias = null;
            string? error = null;
            var inicio = DateTime.UtcNow;
            try
            {
                await Enviar("inicio", JsonSerializer.Serialize(new { conversacionId, mensajeUsuarioId }, Json));
                using var res = await orquestador.TurnoAsync(s.UsuarioId, new { agente, historial = historial.Select(h => new { rol = h.Rol, texto = h.Texto }), texto }, ct);
                if (!res.IsSuccessStatusCode)
                {
                    error = res.StatusCode == System.Net.HttpStatusCode.Unauthorized ? "orquestador_rechazo" : "orquestador_error";
                    await Enviar("error", JsonSerializer.Serialize(new { codigo = error }, Json));
                }
                else
                {
                    using var lector = new StreamReader(await res.Content.ReadAsStreamAsync(ct), Encoding.UTF8);
                    string? tipo = null;
                    while (await lector.ReadLineAsync(ct) is { } linea)
                    {
                        if (linea.StartsWith("event: ", StringComparison.Ordinal)) { tipo = linea[7..].Trim(); continue; }
                        if (!linea.StartsWith("data: ", StringComparison.Ordinal) || tipo is null) continue;
                        var datos = linea[6..];
                        using var doc = JsonDocument.Parse(datos);
                        var r = doc.RootElement;
                        switch (tipo)
                        {
                            case "texto":
                                respuesta.Append(r.GetProperty("delta").GetString());
                                await Enviar("texto", datos);
                                break;
                            case "herramienta":
                                var hid = r.GetProperty("id").GetString();
                                var est = r.GetProperty("estado").GetString();
                                if (est != "corriendo")
                                    herramientas.Add(new() { ["nombre"] = r.GetProperty("nombre").GetString(), ["estado"] = est,
                                        ["ms"] = r.TryGetProperty("ms", out var ms) ? ms.GetInt32() : null });
                                await Enviar("herramienta", datos);
                                break;
                            case "vista":
                                if (vistas.Count < 20) vistas.Add(r.Clone());
                                await Enviar("vista", datos);
                                break;
                            case "sugerencias":
                                if (r.TryGetProperty("opciones", out var ops) && ops.ValueKind == JsonValueKind.Array)
                                    sugerencias = ops.EnumerateArray().Where(o => o.ValueKind == JsonValueKind.String).Select(o => o.GetString()!).Take(4).ToArray();
                                await Enviar("sugerencias", datos);
                                break;
                            case "error":
                                error = r.TryGetProperty("codigo", out var cod) ? cod.GetString() : "error";
                                await Enviar("error", datos);
                                break;
                            case "fin":
                                break;   // el fin con el id lo manda el gateway al guardar
                        }
                        tipo = null;
                    }
                }
            }
            catch (OperationCanceledException) when (ct.IsCancellationRequested) { error = "tiempo_agotado"; await Enviar("error", JsonSerializer.Serialize(new { codigo = error }, Json)); }
            catch (HttpRequestException) { error = "orquestador_no_disponible"; await Enviar("error", JsonSerializer.Serialize(new { codigo = error }, Json)); }
            catch (Exception e) when (e is JsonException or IOException)
            {
                log.LogWarning("Turno de chat cortado: {Tipo}", e.GetType().Name);
                error ??= "respuesta_invalida";
                await Enviar("error", JsonSerializer.Serialize(new { codigo = error }, Json));
            }

            // Guardar lo que hubo, aunque la persona haya cerrado la pantalla. Si siguió conectada hasta el final, lo vio:
            // la conversación queda leída hasta este mensaje; si no, cuenta como «sin leer» en el inicio.
            long mensajeId;
            var vio = clienteVivo && !ctx.RequestAborted.IsCancellationRequested;
            await using (var c = await bd.AbrirAsync(CancellationToken.None))
            {
                mensajeId = await c.ExecuteScalarAsync<long>(new CommandDefinition($"""
                    INSERT {bd.E}.Mensaje (ConversacionId, Rol, Texto, Herramientas, Error, Vistas, Sugerencias) OUTPUT inserted.Id
                    VALUES (@id, 'agente', @texto, @herr, @error, @vistas, @sug);
                    """, new
                    {
                        id = conversacionId, texto = respuesta.ToString(), error,
                        herr = herramientas.Count == 0 ? null : JsonSerializer.Serialize(herramientas, Json),
                        vistas = vistas.Count == 0 ? null : JsonSerializer.Serialize(vistas, Json),
                        sug = sugerencias is null || sugerencias.Length == 0 ? null : JsonSerializer.Serialize(sugerencias, Json),
                    }));
                await c.ExecuteAsync(new CommandDefinition($"""
                    UPDATE {bd.E}.Conversacion SET ActualizadaUtc = SYSUTCDATETIME(),
                      LeidaHastaId = CASE WHEN @vio = 1 THEN @mensajeId ELSE LeidaHastaId END
                    WHERE Id = @id
                    """, new { id = conversacionId, mensajeId, vio }));
            }
            try
            {
                await aud.RegistrarAsync("web", "chat_turno", error is null ? "ok" : "error", s.UsuarioId, agenteId, agente,
                    new { conversacionId, herramientas = herramientas.Select(h => h["nombre"]), vistas = vistas.Count, error, vio, ms = (int)(DateTime.UtcNow - inicio).TotalMilliseconds },
                    ctx.Ip(), CancellationToken.None);
            }
            catch (Exception e) { log.LogError("No se pudo auditar el turno: {Tipo}", e.GetType().Name); }
            if (error is null) await Enviar("fin", JsonSerializer.Serialize(new { mensajeId }, Json));
        }).RequiereSesion();
    }
}
