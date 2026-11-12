using Agentes.Comun;
using Dapper;

namespace Agentes.Gateway;

public static class FiltrosSesion
{
    /// <summary>Exige sesión y, si se pasan roles, que tenga al menos uno de ellos.</summary>
    public static RouteHandlerBuilder RequiereSesion(this RouteHandlerBuilder b, params string[] rolesCualquiera) =>
        b.AddEndpointFilter(async (ctx, next) =>
        {
            var s = ctx.HttpContext.Sesion();
            if (s is null) return Results.Json(new { error = "sin_sesion" }, statusCode: 401);
            if (rolesCualquiera.Length > 0 && !s.Tiene(rolesCualquiera)) return Results.Json(new { error = "sin_permiso" }, statusCode: 403);
            return await next(ctx);
        });
}

/// <summary>Quién soy y qué agentes puedo usar.</summary>
public static class EndpointsPerfil
{
    sealed record FilaPermiso(string Clave, string Nombre, string Rol);
    sealed record FilaAgente(string Clave, string Nombre, string Descripcion, string Color, string Estado, string? Rol);

    public static void Mapear(WebApplication app)
    {
        var bd = app.Services.GetRequiredService<BaseDatos>();

        app.MapGet("/api/yo", async (HttpContext ctx) =>
        {
            var s = ctx.Sesion()!;
            await using var c = await bd.AbrirAsync(ctx.RequestAborted);
            var agentes = await c.QueryAsync<FilaPermiso>(new CommandDefinition($"""
                SELECT a.Clave, a.Nombre, p.Rol FROM {bd.E}.PermisoAgente p JOIN {bd.E}.Agente a ON a.Id = p.AgenteId
                WHERE p.UsuarioId = @id ORDER BY a.Id
                """, new { id = s.UsuarioId }, cancellationToken: ctx.RequestAborted));
            return Results.Ok(new
            {
                id = s.UsuarioId,
                nombre = s.Nombre,
                correo = s.Correo,
                roles = s.Roles.Order().ToArray(),
                agentes = agentes.Select(a => new { clave = a.Clave, nombre = a.Nombre, rol = a.Rol }),
            });
        }).RequiereSesion();

        app.MapGet("/api/agentes", async (HttpContext ctx) =>
        {
            var s = ctx.Sesion()!;
            var todos = s.Tiene("admin_plataforma");
            await using var c = await bd.AbrirAsync(ctx.RequestAborted);
            var filas = await c.QueryAsync<FilaAgente>(new CommandDefinition($"""
                SELECT a.Clave, a.Nombre, a.Descripcion, a.Color, a.Estado, p.Rol
                FROM {bd.E}.Agente a LEFT JOIN {bd.E}.PermisoAgente p ON p.AgenteId = a.Id AND p.UsuarioId = @id
                WHERE @todos = 1 OR p.UsuarioId IS NOT NULL ORDER BY a.Id
                """, new { id = s.UsuarioId, todos }, cancellationToken: ctx.RequestAborted));
            return Results.Ok(filas.Select(f => new
            {
                clave = f.Clave, nombre = f.Nombre, descripcion = f.Descripcion, color = f.Color, estado = f.Estado,
                rol = f.Rol ?? (todos ? "administrador" : null),
            }));
        }).RequiereSesion();
    }
}
