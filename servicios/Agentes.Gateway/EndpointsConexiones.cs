using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Agentes.Comun;
using Dapper;

namespace Agentes.Gateway;

/// <summary>Cliente del ejecutor (127.0.0.1:9944): firma un token de servicio por petición.</summary>
public sealed class ClienteEjecutor(HttpClient http, TokenServicio tokens)
{
    public async Task<(int Estado, JsonElement Json)> LlamarAsync(string ruta, string accion, int usuarioId, object cuerpo, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(HttpMethod.Post, ruta);
        req.Headers.Authorization = new AuthenticationHeaderValue("Servicio", tokens.Crear("gateway", usuarioId, null, accion));
        req.Content = new StringContent(JsonSerializer.Serialize(cuerpo), Encoding.UTF8, "application/json");
        try
        {
            using var res = await http.SendAsync(req, ct);
            var texto = await res.Content.ReadAsStringAsync(ct);
            JsonElement json;
            try { json = JsonDocument.Parse(string.IsNullOrWhiteSpace(texto) ? "{}" : texto).RootElement.Clone(); }
            catch (JsonException) { json = JsonDocument.Parse("{}").RootElement.Clone(); }
            return ((int)res.StatusCode, json);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            return (503, JsonDocument.Parse("{\"error\":\"ejecutor_no_disponible\"}").RootElement.Clone());
        }
    }
}

/// <summary>
/// Conexiones de cada persona con el sistema de un agente (hoy Hilo, por OAuth + MCP). El token nunca pasa por aquí:
/// lo guarda el ejecutor en la bóveda. Aquí se valida el permiso sobre el agente, se audita y se guarda el estado.
/// </summary>
public static class EndpointsConexiones
{
    public static readonly string[] Conectables = ["hilo"];

    sealed record FilaConexion(string Clave, string Estado, int? Herramientas, int? Escrituras, DateTime? ConectadaUtc, DateTime? ProbadaUtc, string? UltimoError);
    public sealed record PeticionCompletar(string? Direccion);

    static string Codigo(JsonElement j) => j.TryGetProperty("error", out var e) && e.ValueKind == JsonValueKind.String ? e.GetString()! : "error";

    public static void Mapear(WebApplication app)
    {
        var bd = app.Services.GetRequiredService<BaseDatos>();
        var aud = app.Services.GetRequiredService<Auditoria>();
        var ejecutor = app.Services.GetRequiredService<ClienteEjecutor>();

        // Id del agente si la persona puede usarlo (permiso explícito o admin de la plataforma); null si no.
        async Task<int?> AgentePermitido(HttpContext ctx, string clave)
        {
            if (!Conectables.Contains(clave)) return null;
            var s = ctx.Sesion()!;
            await using var c = await bd.AbrirAsync(ctx.RequestAborted);
            return await c.ExecuteScalarAsync<int?>(new CommandDefinition($"""
                SELECT a.Id FROM {bd.E}.Agente a
                LEFT JOIN {bd.E}.PermisoAgente p ON p.AgenteId = a.Id AND p.UsuarioId = @u
                WHERE a.Clave = @clave AND (@todos = 1 OR p.UsuarioId IS NOT NULL)
                """, new { u = s.UsuarioId, clave, todos = s.Tiene("admin_plataforma") }, cancellationToken: ctx.RequestAborted));
        }

        async Task Guardar(int usuarioId, int agenteId, string estado, int? herramientas, int? escrituras, bool conectada, string? error, CancellationToken ct)
        {
            await using var c = await bd.AbrirAsync(ct);
            await c.ExecuteAsync(new CommandDefinition($"""
                MERGE {bd.E}.Conexion WITH (HOLDLOCK) AS t
                USING (SELECT @usuarioId AS UsuarioId, @agenteId AS AgenteId) AS s ON t.UsuarioId = s.UsuarioId AND t.AgenteId = s.AgenteId
                WHEN MATCHED THEN UPDATE SET Estado = @estado, Herramientas = COALESCE(@herramientas, t.Herramientas),
                    Escrituras = COALESCE(@escrituras, t.Escrituras), ConectadaUtc = CASE WHEN @conectada = 1 THEN SYSUTCDATETIME() ELSE t.ConectadaUtc END,
                    ProbadaUtc = SYSUTCDATETIME(), UltimoError = @error
                WHEN NOT MATCHED THEN INSERT (UsuarioId, AgenteId, Estado, Herramientas, Escrituras, ConectadaUtc, ProbadaUtc, UltimoError)
                    VALUES (@usuarioId, @agenteId, @estado, @herramientas, @escrituras, CASE WHEN @conectada = 1 THEN SYSUTCDATETIME() END, SYSUTCDATETIME(), @error);
                """, new { usuarioId, agenteId, estado, herramientas, escrituras, conectada, error }, cancellationToken: ct));
        }

        static string[] Nombres(JsonElement j) =>
            j.TryGetProperty("herramientas", out var hs) && hs.ValueKind == JsonValueKind.Array
                ? hs.EnumerateArray().Select(h => h.TryGetProperty("nombre", out var n) ? n.GetString() ?? "" : "").Where(n => n.Length > 0).ToArray()
                : [];

        static (int Total, int Escrituras) Contar(JsonElement j)
        {
            if (!j.TryGetProperty("herramientas", out var hs) || hs.ValueKind != JsonValueKind.Array) return (0, 0);
            var total = hs.GetArrayLength();
            var lectura = hs.EnumerateArray().Count(h => h.TryGetProperty("soloLectura", out var l) && l.ValueKind == JsonValueKind.True);
            return (total, total - lectura);
        }

        app.MapGet("/api/conexiones", async (HttpContext ctx) =>
        {
            var s = ctx.Sesion()!;
            await using var c = await bd.AbrirAsync(ctx.RequestAborted);
            var filas = await c.QueryAsync<FilaConexion>(new CommandDefinition($"""
                SELECT a.Clave, x.Estado, x.Herramientas, x.Escrituras, x.ConectadaUtc, x.ProbadaUtc, x.UltimoError
                FROM {bd.E}.Conexion x JOIN {bd.E}.Agente a ON a.Id = x.AgenteId WHERE x.UsuarioId = @u
                """, new { u = s.UsuarioId }, cancellationToken: ctx.RequestAborted));
            return Results.Ok(new
            {
                conectables = Conectables,
                conexiones = filas.Select(f => new
                {
                    agente = f.Clave, estado = f.Estado, herramientas = f.Herramientas, escrituras = f.Escrituras,
                    conectadaUtc = f.ConectadaUtc is null ? (DateTime?)null : DateTime.SpecifyKind(f.ConectadaUtc.Value, DateTimeKind.Utc),
                    probadaUtc = f.ProbadaUtc is null ? (DateTime?)null : DateTime.SpecifyKind(f.ProbadaUtc.Value, DateTimeKind.Utc),
                    ultimoError = f.UltimoError,
                }),
            });
        }).RequiereSesion();

        app.MapPost("/api/conexiones/{agente}/iniciar", async (HttpContext ctx, string agente) =>
        {
            var s = ctx.Sesion()!;
            var agenteId = await AgentePermitido(ctx, agente);
            if (agenteId is null) return Results.Json(new { error = "sin_permiso" }, statusCode: 403);
            var (estado, j) = await ejecutor.LlamarAsync($"/v1/conexiones/{agente}/iniciar", "conexion_iniciar", s.UsuarioId, new { }, ctx.RequestAborted);
            if (estado != 200) return Results.Json(new { error = Codigo(j) }, statusCode: estado);
            await aud.RegistrarAsync("web", "conexion_iniciada", "ok", s.UsuarioId, agenteId, agente, null, ctx.Ip(), ctx.RequestAborted);
            return Results.Json(j);
        }).RequiereSesion();

        app.MapPost("/api/conexiones/{agente}/completar", async (HttpContext ctx, string agente, PeticionCompletar? body) =>
        {
            var s = ctx.Sesion()!;
            var agenteId = await AgentePermitido(ctx, agente);
            if (agenteId is null) return Results.Json(new { error = "sin_permiso" }, statusCode: 403);
            if (string.IsNullOrWhiteSpace(body?.Direccion) || body.Direccion.Length > 4000) return Results.Json(new { error = "direccion_invalida" }, statusCode: 400);
            var (estado, j) = await ejecutor.LlamarAsync($"/v1/conexiones/{agente}/completar", "conexion_completar", s.UsuarioId, new { direccion = body.Direccion }, ctx.RequestAborted);
            if (estado != 200)
            {
                await aud.RegistrarAsync("web", "conexion_fallida", "rechazado", s.UsuarioId, agenteId, agente, new { motivo = Codigo(j) }, ctx.Ip(), ctx.RequestAborted);
                return Results.Json(new { error = Codigo(j) }, statusCode: estado);
            }
            var (total, escrituras) = Contar(j);
            await Guardar(s.UsuarioId, agenteId.Value, "conectada", total, escrituras, true, null, ctx.RequestAborted);
            await aud.RegistrarAsync("web", "conexion_establecida", "ok", s.UsuarioId, agenteId, agente, new { herramientas = total }, ctx.Ip(), ctx.RequestAborted);
            return Results.Ok(new { estado = "conectada", herramientas = total, escrituras, nombres = Nombres(j) });
        }).RequiereSesion();

        app.MapPost("/api/conexiones/{agente}/probar", async (HttpContext ctx, string agente) =>
        {
            var s = ctx.Sesion()!;
            var agenteId = await AgentePermitido(ctx, agente);
            if (agenteId is null) return Results.Json(new { error = "sin_permiso" }, statusCode: 403);
            var (estado, j) = await ejecutor.LlamarAsync($"/v1/conexiones/{agente}/probar", "conexion_probar", s.UsuarioId, new { }, ctx.RequestAborted);
            if (estado == 200)
            {
                var (total, escrituras) = Contar(j);
                await Guardar(s.UsuarioId, agenteId.Value, "conectada", total, escrituras, false, null, ctx.RequestAborted);
                return Results.Ok(new { estado = "conectada", herramientas = total, escrituras, nombres = Nombres(j) });
            }
            var codigo = Codigo(j);
            if (codigo is "reconectar" or "sin_conexion")
                await Guardar(s.UsuarioId, agenteId.Value, "reconectar", null, null, false, codigo, ctx.RequestAborted);
            return Results.Json(new { error = codigo }, statusCode: estado);
        }).RequiereSesion();

        app.MapPost("/api/conexiones/{agente}/desconectar", async (HttpContext ctx, string agente) =>
        {
            var s = ctx.Sesion()!;
            var agenteId = await AgentePermitido(ctx, agente);
            if (agenteId is null) return Results.Json(new { error = "sin_permiso" }, statusCode: 403);
            var (estado, j) = await ejecutor.LlamarAsync($"/v1/conexiones/{agente}/desconectar", "conexion_desconectar", s.UsuarioId, new { }, ctx.RequestAborted);
            if (estado != 200) return Results.Json(new { error = Codigo(j) }, statusCode: estado);
            await Guardar(s.UsuarioId, agenteId.Value, "desconectada", null, null, false, null, ctx.RequestAborted);
            await aud.RegistrarAsync("web", "conexion_cerrada", "ok", s.UsuarioId, agenteId, agente, null, ctx.Ip(), ctx.RequestAborted);
            return Results.Ok(new { estado = "desconectada" });
        }).RequiereSesion();
    }
}
