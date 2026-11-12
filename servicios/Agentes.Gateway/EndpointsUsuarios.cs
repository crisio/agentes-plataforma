using Agentes.Comun;
using Dapper;
using Microsoft.Data.SqlClient;

namespace Agentes.Gateway;

public sealed record PermisoEntrada(string? Agente, string? Rol, string? Paises);
public sealed record UsuarioNuevo(string? Correo, string? Nombre, string[]? Roles, PermisoEntrada[]? Permisos);
public sealed record UsuarioCambio(string? Nombre, bool? Activo, string[]? Roles, PermisoEntrada[]? Permisos);

/// <summary>Alta y administración de usuarios: solo admin_plataforma.</summary>
public static class EndpointsUsuarios
{
    static readonly string[] PaisesValidos = ["HN", "GT", "SV"];

    sealed record FilaUsuario(int Id, string Correo, string Nombre, bool Activo, bool TieneClave, DateTime CreadoUtc, DateTime? UltimoIngresoUtc);
    sealed record FilaRol(int UsuarioId, string Rol);
    sealed record FilaPermiso(int UsuarioId, string Agente, string Rol, string Paises);

    public static void Mapear(WebApplication app)
    {
        var bd = app.Services.GetRequiredService<BaseDatos>();
        var aud = app.Services.GetRequiredService<Auditoria>();
        var sesiones = app.Services.GetRequiredService<ServicioSesiones>();

        IResult Err(int codigo, string error) => Results.Json(new { error }, statusCode: codigo);

        async Task<List<object>> Cargar(SqlConnection c, int? id, CancellationToken ct)
        {
            var us = (await c.QueryAsync<FilaUsuario>(new CommandDefinition($"""
                SELECT Id, Correo, Nombre, Activo, CAST(CASE WHEN HashClave IS NULL THEN 0 ELSE 1 END AS BIT) AS TieneClave, CreadoUtc, UltimoIngresoUtc
                FROM {bd.E}.Usuario WHERE @id IS NULL OR Id = @id ORDER BY Id
                """, new { id }, cancellationToken: ct))).ToList();
            var roles = (await c.QueryAsync<FilaRol>(new CommandDefinition(
                $"SELECT UsuarioId, Rol FROM {bd.E}.RolPlataforma WHERE @id IS NULL OR UsuarioId = @id", new { id }, cancellationToken: ct))).ToLookup(r => r.UsuarioId);
            var permisos = (await c.QueryAsync<FilaPermiso>(new CommandDefinition($"""
                SELECT p.UsuarioId, a.Clave AS Agente, p.Rol, p.Paises FROM {bd.E}.PermisoAgente p JOIN {bd.E}.Agente a ON a.Id = p.AgenteId
                WHERE @id IS NULL OR p.UsuarioId = @id ORDER BY a.Id
                """, new { id }, cancellationToken: ct))).ToLookup(p => p.UsuarioId);
            return us.Select(u => (object)new
            {
                id = u.Id, correo = u.Correo, nombre = u.Nombre, activo = u.Activo, tieneClave = u.TieneClave,
                creadoUtc = DateTime.SpecifyKind(u.CreadoUtc, DateTimeKind.Utc),
                ultimoIngresoUtc = u.UltimoIngresoUtc is null ? (DateTime?)null : DateTime.SpecifyKind(u.UltimoIngresoUtc.Value, DateTimeKind.Utc),
                roles = roles[u.Id].Select(r => r.Rol).Order().ToArray(),
                permisos = permisos[u.Id].Select(p => new { agente = p.Agente, rol = p.Rol, paises = p.Paises }).ToArray(),
            }).ToList();
        }

        /// Valida y normaliza roles y permisos. Devuelve el error o null.
        async Task<(string? Error, string[] Roles, List<(int AgenteId, string Agente, string Rol, string Paises)> Permisos)> Validar(
            SqlConnection c, SqlTransaction? tx, string[]? roles, PermisoEntrada[]? permisos, CancellationToken ct)
        {
            var rolesOk = (roles ?? []).Distinct().ToArray();
            if (rolesOk.Any(r => !ReglaRoles.RolesPlataforma.Contains(r))) return ("rol_invalido", [], []);
            if (!ReglaRoles.Permitido(rolesOk, ReglaRoles.ExcepcionAdminUnico)) return ("regla_roles", [], []);
            var lista = new List<(int, string, string, string)>();
            foreach (var p in permisos ?? [])
            {
                if (string.IsNullOrWhiteSpace(p.Agente) || p.Rol is null || !ReglaRoles.RolesAgente.Contains(p.Rol)) return ("permiso_invalido", [], []);
                var paises = (p.Paises ?? "HN,GT,SV").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                    .Select(x => x.ToUpperInvariant()).Distinct().ToArray();
                if (paises.Length == 0 || paises.Any(x => !PaisesValidos.Contains(x))) return ("paises_invalidos", [], []);
                var agenteId = await c.ExecuteScalarAsync<int?>(new CommandDefinition(
                    $"SELECT Id FROM {bd.E}.Agente WHERE Clave = @agente", new { agente = p.Agente }, tx, cancellationToken: ct));
                if (agenteId is null) return ("agente_desconocido", [], []);
                if (lista.Any(x => x.Item1 == agenteId)) return ("agente_repetido", [], []);
                lista.Add((agenteId.Value, p.Agente!, p.Rol, string.Join(',', paises)));
            }
            return (null, rolesOk, lista);
        }

        async Task GuardarRoles(SqlConnection c, SqlTransaction tx, int id, string[] roles, CancellationToken ct)
        {
            await c.ExecuteAsync(new CommandDefinition($"DELETE {bd.E}.RolPlataforma WHERE UsuarioId = @id", new { id }, tx, cancellationToken: ct));
            foreach (var rol in roles)
                await c.ExecuteAsync(new CommandDefinition($"INSERT {bd.E}.RolPlataforma (UsuarioId, Rol) VALUES (@id, @rol)", new { id, rol }, tx, cancellationToken: ct));
        }

        async Task GuardarPermisos(SqlConnection c, SqlTransaction tx, int id, List<(int AgenteId, string Agente, string Rol, string Paises)> permisos, CancellationToken ct)
        {
            await c.ExecuteAsync(new CommandDefinition($"DELETE {bd.E}.PermisoAgente WHERE UsuarioId = @id", new { id }, tx, cancellationToken: ct));
            foreach (var p in permisos)
                await c.ExecuteAsync(new CommandDefinition(
                    $"INSERT {bd.E}.PermisoAgente (UsuarioId, AgenteId, Rol, Paises) VALUES (@id, @agenteId, @rol, @paises)",
                    new { id, agenteId = p.AgenteId, rol = p.Rol, paises = p.Paises }, tx, cancellationToken: ct));
        }

        app.MapGet("/api/usuarios", async (HttpContext ctx) =>
        {
            await using var c = await bd.AbrirAsync(ctx.RequestAborted);
            return Results.Ok(await Cargar(c, null, ctx.RequestAborted));
        }).RequiereSesion("admin_plataforma");

        app.MapPost("/api/usuarios", async (HttpContext ctx, UsuarioNuevo? body) =>
        {
            var s = ctx.Sesion()!;
            var correo = EndpointsAcceso.NormalizarCorreo(body?.Correo);
            var nombre = body?.Nombre?.Trim();
            if (correo is null) return Err(400, "correo_invalido");
            if (string.IsNullOrEmpty(nombre) || nombre.Length > 120) return Err(400, "nombre_invalido");

            await using var c = await bd.AbrirAsync(ctx.RequestAborted);
            await using var tx = (SqlTransaction)await c.BeginTransactionAsync(ctx.RequestAborted);
            var (error, roles, permisos) = await Validar(c, tx, body!.Roles, body.Permisos, ctx.RequestAborted);
            if (error is not null) return Err(error == "regla_roles" ? 409 : 400, error);
            int id;
            try
            {
                id = await c.ExecuteScalarAsync<int>(new CommandDefinition(
                    $"INSERT {bd.E}.Usuario (Correo, Nombre) OUTPUT inserted.Id VALUES (@correo, @nombre)", new { correo, nombre }, tx, cancellationToken: ctx.RequestAborted));
            }
            catch (SqlException e) when (e.Number is 2627 or 2601) { return Err(409, "correo_ya_existe"); }
            await GuardarRoles(c, tx, id, roles, ctx.RequestAborted);
            await GuardarPermisos(c, tx, id, permisos, ctx.RequestAborted);
            await tx.CommitAsync(ctx.RequestAborted);

            var ip = ctx.Ip();
            await aud.RegistrarAsync("web", "usuario_creado", "ok", s.UsuarioId, null, correo, new { roles, permisos = permisos.Count }, ip, ctx.RequestAborted);
            await using var c2 = await bd.AbrirAsync(ctx.RequestAborted);
            return Results.Json((await Cargar(c2, id, ctx.RequestAborted))[0], statusCode: 201);
        }).RequiereSesion("admin_plataforma");

        app.MapPatch("/api/usuarios/{id:int}", async (HttpContext ctx, int id, UsuarioCambio? body) =>
        {
            var s = ctx.Sesion()!;
            if (body is null) return Err(400, "peticion_invalida");
            if (id == s.UsuarioId && (body.Activo == false || (body.Roles is not null && !body.Roles.Contains("admin_plataforma"))))
                return Err(400, "no_puedes_quitarte_el_acceso");
            var nombre = body.Nombre?.Trim();
            if (body.Nombre is not null && (string.IsNullOrEmpty(nombre) || nombre.Length > 120)) return Err(400, "nombre_invalido");

            await using var c = await bd.AbrirAsync(ctx.RequestAborted);
            await using var tx = (SqlTransaction)await c.BeginTransactionAsync(ctx.RequestAborted);
            var actual = await c.QuerySingleOrDefaultAsync<FilaUsuario>(new CommandDefinition($"""
                SELECT Id, Correo, Nombre, Activo, CAST(0 AS BIT) AS TieneClave, CreadoUtc, UltimoIngresoUtc FROM {bd.E}.Usuario WITH (UPDLOCK) WHERE Id = @id
                """, new { id }, tx, cancellationToken: ctx.RequestAborted));
            if (actual is null) return Err(404, "no_existe");

            var (error, roles, permisos) = await Validar(c, tx, body.Roles, body.Permisos, ctx.RequestAborted);
            if (error is not null) return Err(error == "regla_roles" ? 409 : 400, error);

            string[]? rolesAntes = null;
            string? permisosAntes = null;
            if (body.Roles is not null)
            {
                rolesAntes = (await c.QueryAsync<string>(new CommandDefinition(
                    $"SELECT Rol FROM {bd.E}.RolPlataforma WHERE UsuarioId = @id ORDER BY Rol", new { id }, tx, cancellationToken: ctx.RequestAborted))).ToArray();
                await GuardarRoles(c, tx, id, roles, ctx.RequestAborted);
            }
            if (body.Permisos is not null)
            {
                permisosAntes = string.Join(';', (await c.QueryAsync<string>(new CommandDefinition(
                    $"SELECT a.Clave + ':' + p.Rol FROM {bd.E}.PermisoAgente p JOIN {bd.E}.Agente a ON a.Id = p.AgenteId WHERE p.UsuarioId = @id ORDER BY a.Clave",
                    new { id }, tx, cancellationToken: ctx.RequestAborted))));
                await GuardarPermisos(c, tx, id, permisos, ctx.RequestAborted);
            }
            if (nombre is not null || body.Activo is not null)
                await c.ExecuteAsync(new CommandDefinition(
                    $"UPDATE {bd.E}.Usuario SET Nombre = COALESCE(@nombre, Nombre), Activo = COALESCE(@activo, Activo) WHERE Id = @id",
                    new { nombre, activo = body.Activo, id }, tx, cancellationToken: ctx.RequestAborted));
            await tx.CommitAsync(ctx.RequestAborted);

            var ip = ctx.Ip();
            if (nombre is not null || body.Activo is not null)
                await aud.RegistrarAsync("web", "usuario_modificado", "ok", s.UsuarioId, null, actual.Correo,
                    new { nombre = nombre is not null, activo = body.Activo }, ip, ctx.RequestAborted);
            if (rolesAntes is not null)
                await aud.RegistrarAsync("web", "rol_cambiado", "ok", s.UsuarioId, null, actual.Correo,
                    new { antes = rolesAntes, despues = roles.Order().ToArray() }, ip, ctx.RequestAborted);
            if (permisosAntes is not null)
                await aud.RegistrarAsync("web", "permiso_agente_cambiado", "ok", s.UsuarioId, null, actual.Correo,
                    new { antes = permisosAntes, despues = string.Join(';', permisos.OrderBy(p => p.Agente).Select(p => p.Agente + ":" + p.Rol)) }, ip, ctx.RequestAborted);
            if (body.Activo == false) await sesiones.RevocarDeUsuarioAsync(id, ctx.RequestAborted);

            await using var c2 = await bd.AbrirAsync(ctx.RequestAborted);
            return Results.Ok((await Cargar(c2, id, ctx.RequestAborted))[0]);
        }).RequiereSesion("admin_plataforma");
    }
}
