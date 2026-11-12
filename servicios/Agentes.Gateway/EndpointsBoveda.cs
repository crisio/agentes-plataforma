using System.Net.Http.Headers;
using System.Text;
using Agentes.Comun;

namespace Agentes.Gateway;

/// <summary>Cliente de la bóveda: firma un token de servicio por petición. Nunca registra cuerpos.</summary>
public sealed class ClienteBoveda(HttpClient http, TokenServicio tokens)
{
    public async Task<IResult> LlamarAsync(HttpMethod metodo, string ruta, string? accion, int? usuarioId, string? cuerpoJson, CancellationToken ct)
    {
        using var req = new HttpRequestMessage(metodo, ruta);
        if (accion is not null)
            req.Headers.Authorization = new AuthenticationHeaderValue("Servicio", tokens.Crear("gateway", usuarioId, null, accion));
        if (cuerpoJson is not null) req.Content = new StringContent(cuerpoJson, Encoding.UTF8, "application/json");
        try
        {
            using var res = await http.SendAsync(req, ct);
            var texto = await res.Content.ReadAsStringAsync(ct);
            return Results.Content(texto, "application/json", Encoding.UTF8, (int)res.StatusCode);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException && !ct.IsCancellationRequested)
        {
            return Results.Json(new { error = "boveda_no_disponible" }, statusCode: 503);
        }
    }
}

/// <summary>Proxy hacia la bóveda con permisos de la plataforma. El valor de un secreto entra y nunca sale.</summary>
public static class EndpointsBoveda
{
    static async Task<string> Cuerpo(HttpRequest r, CancellationToken ct)
    {
        using var lector = new StreamReader(r.Body, Encoding.UTF8);
        return await lector.ReadToEndAsync(ct);
    }

    static string Ruta(string ruta) => string.Join('/', ruta.Split('/').Select(Uri.EscapeDataString));

    public static void Mapear(WebApplication app)
    {
        var boveda = app.Services.GetRequiredService<ClienteBoveda>();
        var aud = app.Services.GetRequiredService<Auditoria>();
        _ = aud;

        app.MapGet("/api/boveda/estado", async (HttpContext ctx, CancellationToken ct) => await
            boveda.LlamarAsync(HttpMethod.Get, "/v1/estado", null, null, null, ctx.RequestAborted)).RequiereSesion();

        app.MapPost("/api/boveda/inicializar", async (HttpContext ctx, CancellationToken ct) =>
            await boveda.LlamarAsync(HttpMethod.Post, "/v1/inicializar", "inicializar", ctx.Sesion()!.UsuarioId,
                await Cuerpo(ctx.Request, ctx.RequestAborted), ctx.RequestAborted)).RequiereSesion("admin_boveda");

        app.MapPost("/api/boveda/abrir", async (HttpContext ctx, CancellationToken ct) =>
            await boveda.LlamarAsync(HttpMethod.Post, "/v1/abrir", "abrir", ctx.Sesion()!.UsuarioId,
                await Cuerpo(ctx.Request, ctx.RequestAborted), ctx.RequestAborted)).RequiereSesion("custodio");

        app.MapPost("/api/boveda/sellar", async (HttpContext ctx, CancellationToken ct) => await
            boveda.LlamarAsync(HttpMethod.Post, "/v1/sellar", "sellar", ctx.Sesion()!.UsuarioId, "{}", ctx.RequestAborted)).RequiereSesion("admin_boveda");

        app.MapGet("/api/boveda/secretos", async (HttpContext ctx, CancellationToken ct) => await
            boveda.LlamarAsync(HttpMethod.Get, "/v1/secretos", "listar", ctx.Sesion()!.UsuarioId, null, ctx.RequestAborted)).RequiereSesion("admin_boveda");

        app.MapPost("/api/boveda/secretos", async (HttpContext ctx, CancellationToken ct) =>
            await boveda.LlamarAsync(HttpMethod.Post, "/v1/secretos", "crear", ctx.Sesion()!.UsuarioId,
                await Cuerpo(ctx.Request, ctx.RequestAborted), ctx.RequestAborted)).RequiereSesion("admin_boveda");

        // Los nombres llevan barras («sql/erp-hn/lectura»): la acción es el último segmento.
        app.MapPost("/api/boveda/secretos/{**ruta}", async (HttpContext ctx, string ruta) =>
        {
            var i = ruta.LastIndexOf('/');
            var accion = i > 0 ? ruta[(i + 1)..] : "";
            if (accion is not ("rotar" or "revocar")) return Results.Json(new { error = "ruta" }, statusCode: 404);
            return await boveda.LlamarAsync(HttpMethod.Post, "/v1/secretos/" + Ruta(ruta), accion, ctx.Sesion()!.UsuarioId,
                await Cuerpo(ctx.Request, ctx.RequestAborted), ctx.RequestAborted);
        }).RequiereSesion("admin_boveda");

        app.MapPut("/api/boveda/secretos/{**ruta}", async (HttpContext ctx, string ruta) =>
        {
            if (!ruta.EndsWith("/politicas", StringComparison.Ordinal)) return Results.Json(new { error = "ruta" }, statusCode: 404);
            return await boveda.LlamarAsync(HttpMethod.Put, "/v1/secretos/" + Ruta(ruta), "politica", ctx.Sesion()!.UsuarioId,
                await Cuerpo(ctx.Request, ctx.RequestAborted), ctx.RequestAborted);
        }).RequiereSesion("admin_boveda");
    }
}
