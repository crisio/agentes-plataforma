using Agentes.Comun;
using Dapper;

namespace Agentes.Gateway;

public static class EndpointsAuditoria
{
    public const int TamanoPagina = 50;

    sealed record FilaEvento(long Id, DateTime MomentoUtc, int? UsuarioId, string? Usuario, int? AgenteId, string Canal, string Tipo,
        string? Objeto, string? Detalle, string Resultado, string? Ip);
    sealed record FilaRota(long Id, string Falla);

    public static void Mapear(WebApplication app)
    {
        var bd = app.Services.GetRequiredService<BaseDatos>();

        app.MapGet("/api/auditoria", async (HttpContext ctx, long? antesDe, string? tipo, int? usuario, int? limite) =>
        {
            var tam = Math.Clamp(limite ?? TamanoPagina, 1, TamanoPagina);
            await using var c = await bd.AbrirAsync(ctx.RequestAborted);
            var filas = (await c.QueryAsync<FilaEvento>(new CommandDefinition($"""
                SELECT TOP (@tope) e.Id, e.MomentoUtc, e.UsuarioId, u.Correo AS Usuario, e.AgenteId, e.Canal, e.Tipo, e.Objeto, e.Detalle, e.Resultado, e.Ip
                FROM {bd.E}.Evento e LEFT JOIN {bd.E}.Usuario u ON u.Id = e.UsuarioId
                WHERE (@antesDe IS NULL OR e.Id < @antesDe) AND (@tipo IS NULL OR e.Tipo = @tipo) AND (@usuario IS NULL OR e.UsuarioId = @usuario)
                ORDER BY e.Id DESC
                """, new { tope = tam + 1, antesDe, tipo = tipo is { Length: > 0 and <= 60 } ? tipo : null, usuario }, cancellationToken: ctx.RequestAborted))).ToList();
            var hayMas = filas.Count > tam;
            if (hayMas) filas.RemoveAt(filas.Count - 1);
            return Results.Ok(new
            {
                eventos = filas.Select(f => new
                {
                    id = f.Id, momentoUtc = DateTime.SpecifyKind(f.MomentoUtc, DateTimeKind.Utc), usuarioId = f.UsuarioId, usuario = f.Usuario,
                    agenteId = f.AgenteId, canal = f.Canal, tipo = f.Tipo, objeto = f.Objeto, detalle = f.Detalle, resultado = f.Resultado, ip = f.Ip,
                }),
                siguiente = hayMas ? filas[^1].Id : (long?)null,
            });
        }).RequiereSesion("admin_plataforma", "auditor");

        app.MapGet("/api/auditoria/verificar", async (HttpContext ctx) =>
        {
            await using var c = await bd.AbrirAsync(ctx.RequestAborted);
            var rota = await c.QuerySingleOrDefaultAsync<FilaRota>(new CommandDefinition(
                $"EXEC {bd.E}.sp_VerificarCadena", commandTimeout: 120, cancellationToken: ctx.RequestAborted));
            return rota is null
                ? Results.Ok(new { sana = true })
                : Results.Ok(new { sana = false, primeraRota = new { id = rota.Id, falla = rota.Falla } });
        }).RequiereSesion("admin_plataforma", "auditor");
    }
}
