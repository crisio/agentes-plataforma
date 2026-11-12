using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text.Json;
using Agentes.Comun;
using Dapper;
using Fido2NetLib;
using Fido2NetLib.Objects;

namespace Agentes.Gateway;

/// <summary>
/// Llaves de acceso (WebAuthn / passkeys): después del primer ingreso con correo + código, la persona guarda una llave
/// en su teléfono o computadora y entra con Face ID, huella o el PIN del equipo. Sin clave.
/// </summary>
public static class EndpointsLlaves
{
    public sealed record PeticionRespuesta(string? Id, JsonElement Respuesta, string? Nombre);
    sealed record FilaLlave(int Id, int UsuarioId, byte[] CredencialId, byte[] LlavePublica, long Contador);
    sealed record FilaLista(int Id, string Nombre, bool Respaldada, DateTime CreadaUtc, DateTime? UltimoUsoUtc);
    sealed record FilaUsuario(int Id, string Correo, string Nombre, bool Activo);

    /// <summary>Retos pendientes en memoria (un solo gateway): vencen en 5 minutos y sirven una sola vez.</summary>
    sealed record Reto(string OpcionesJson, int? UsuarioId, DateTime VenceUtc);
    static readonly ConcurrentDictionary<string, Reto> Retos = new();

    static string NuevoReto(string json, int? usuarioId)
    {
        var ahora = DateTime.UtcNow;
        foreach (var (k, r) in Retos) if (r.VenceUtc < ahora) Retos.TryRemove(k, out _);
        var id = Codificacion.Base64Url(RandomNumberGenerator.GetBytes(18));
        Retos[id] = new Reto(json, usuarioId, ahora.AddMinutes(5));
        return id;
    }

    static Reto? TomarReto(string? id) =>
        id is not null && Retos.TryRemove(id, out var r) && r.VenceUtc > DateTime.UtcNow ? r : null;

    static DbString HashCred(byte[] id) => new() { Value = Convert.ToHexString(SHA256.HashData(id)).ToLowerInvariant(), IsAnsi = true, IsFixedLength = true, Length = 64 };

    static string NombrePorDefecto(string? navegador)
    {
        var n = navegador ?? "";
        if (n.Contains("iPhone")) return "iPhone";
        if (n.Contains("iPad")) return "iPad";
        if (n.Contains("Android")) return "Android";
        if (n.Contains("Mac OS")) return "Mac";
        if (n.Contains("Windows")) return "Windows";
        return "Llave de acceso";
    }

    public static void Mapear(WebApplication app)
    {
        var bd = app.Services.GetRequiredService<BaseDatos>();
        var aud = app.Services.GetRequiredService<Auditoria>();
        var sesiones = app.Services.GetRequiredService<ServicioSesiones>();
        var limitador = app.Services.GetRequiredService<Limitador>();
        var log = app.Logger;

        var dominio = (Configuracion.Obtener("AGENTES_WEBAUTHN_DOMINIO") ?? "agentes.ejemplo.com").ToLowerInvariant();
        var origenes = (Configuracion.Obtener("AGENTES_WEBAUTHN_ORIGENES") ?? $"https://{dominio}")
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var fido = new Fido2(new Fido2Configuration { ServerDomain = dominio, ServerName = "Agentes GC", Origins = origenes });

        IResult Error(int codigo, string error) => Results.Json(new { error }, statusCode: codigo);

        // ───── Registrar una llave (con sesión) ─────
        app.MapPost("/api/llaves/opciones", async (HttpContext ctx) =>
        {
            var s = ctx.Sesion()!;
            await using var c = await bd.AbrirAsync(ctx.RequestAborted);
            var existentes = (await c.QueryAsync<byte[]>(new CommandDefinition(
                $"SELECT CredencialId FROM {bd.E}.LlaveAcceso WHERE UsuarioId = @u", new { u = s.UsuarioId }, cancellationToken: ctx.RequestAborted)))
                .Select(id => new PublicKeyCredentialDescriptor(id)).ToList();
            var opciones = fido.RequestNewCredential(new RequestNewCredentialParams
            {
                User = new Fido2User { Id = BitConverter.GetBytes(s.UsuarioId), Name = s.Correo, DisplayName = s.Nombre },
                ExcludeCredentials = existentes,
                AuthenticatorSelection = new AuthenticatorSelection
                {
                    ResidentKey = ResidentKeyRequirement.Required,          // llave «descubrible»: entra sin escribir el correo
                    UserVerification = UserVerificationRequirement.Required, // Face ID, huella o PIN
                },
                AttestationPreference = AttestationConveyancePreference.None,
            });
            return Results.Ok(new { id = NuevoReto(opciones.ToJson(), s.UsuarioId), opciones = JsonDocument.Parse(opciones.ToJson()).RootElement });
        }).RequiereSesion();

        app.MapPost("/api/llaves/registrar", async (HttpContext ctx, PeticionRespuesta body) =>
        {
            var s = ctx.Sesion()!;
            var reto = TomarReto(body.Id);
            if (reto is null || reto.UsuarioId != s.UsuarioId) return Error(400, "reto_vencido");
            RegisteredPublicKeyCredential cred;
            try
            {
                var respuesta = body.Respuesta.Deserialize<AuthenticatorAttestationRawResponse>()!;
                cred = await fido.MakeNewCredentialAsync(new MakeNewCredentialParams
                {
                    AttestationResponse = respuesta,
                    OriginalOptions = CredentialCreateOptions.FromJson(reto.OpcionesJson),
                    IsCredentialIdUniqueToUserCallback = async (p, ct) =>
                    {
                        await using var c2 = await bd.AbrirAsync(ct);
                        return await c2.ExecuteScalarAsync<int>(new CommandDefinition(
                            $"SELECT COUNT(1) FROM {bd.E}.LlaveAcceso WHERE HashCredencial = @h", new { h = HashCred(p.CredentialId) }, cancellationToken: ct)) == 0;
                    },
                }, ctx.RequestAborted);
            }
            catch (Exception e) when (e is Fido2VerificationException or JsonException or ArgumentException or InvalidOperationException)
            {
                log.LogWarning("Registro de llave rechazado: {Motivo}", e.Message);
                await aud.RegistrarAsync("web", "llave_rechazada", "rechazado", s.UsuarioId, null, s.Correo, new { paso = "registro" }, ctx.Ip(), ctx.RequestAborted);
                return Error(400, "llave_invalida");
            }
            var nombre = string.IsNullOrWhiteSpace(body.Nombre) ? NombrePorDefecto(ctx.Navegador()) : body.Nombre.Trim();
            if (nombre.Length > 100) nombre = nombre[..100];
            await using var c = await bd.AbrirAsync(ctx.RequestAborted);
            await c.ExecuteAsync(new CommandDefinition($"""
                INSERT {bd.E}.LlaveAcceso (UsuarioId, CredencialId, HashCredencial, LlavePublica, Contador, Nombre, Respaldada)
                VALUES (@u, @id, @h, @pk, @n, @nombre, @resp)
                """, new { u = s.UsuarioId, id = cred.Id, h = HashCred(cred.Id), pk = cred.PublicKey, n = (long)cred.SignCount, nombre, resp = cred.IsBackedUp },
                cancellationToken: ctx.RequestAborted));
            await aud.RegistrarAsync("web", "llave_registrada", "ok", s.UsuarioId, null, s.Correo, new { nombre, sincronizada = cred.IsBackedUp }, ctx.Ip(), ctx.RequestAborted);
            return Results.Ok(new { registrada = true, nombre });
        }).RequiereSesion();

        app.MapGet("/api/llaves", async (HttpContext ctx) =>
        {
            var s = ctx.Sesion()!;
            await using var c = await bd.AbrirAsync(ctx.RequestAborted);
            var filas = await c.QueryAsync<FilaLista>(new CommandDefinition(
                $"SELECT Id, Nombre, Respaldada, CreadaUtc, UltimoUsoUtc FROM {bd.E}.LlaveAcceso WHERE UsuarioId = @u ORDER BY Id",
                new { u = s.UsuarioId }, cancellationToken: ctx.RequestAborted));
            return Results.Ok(filas.Select(f => new
            {
                id = f.Id, nombre = f.Nombre, sincronizada = f.Respaldada,
                creadaUtc = DateTime.SpecifyKind(f.CreadaUtc, DateTimeKind.Utc),
                ultimoUsoUtc = f.UltimoUsoUtc is null ? (DateTime?)null : DateTime.SpecifyKind(f.UltimoUsoUtc.Value, DateTimeKind.Utc),
            }));
        }).RequiereSesion();

        app.MapPost("/api/llaves/{id:int}/borrar", async (HttpContext ctx, int id) =>
        {
            var s = ctx.Sesion()!;
            await using var c = await bd.AbrirAsync(ctx.RequestAborted);
            var n = await c.ExecuteAsync(new CommandDefinition(
                $"DELETE {bd.E}.LlaveAcceso WHERE Id = @id AND UsuarioId = @u", new { id, u = s.UsuarioId }, cancellationToken: ctx.RequestAborted));
            if (n == 0) return Error(404, "no_existe");
            await aud.RegistrarAsync("web", "llave_borrada", "ok", s.UsuarioId, null, s.Correo, new { id }, ctx.Ip(), ctx.RequestAborted);
            return Results.Ok(new { borrada = true });
        }).RequiereSesion();

        // ───── Entrar con una llave (sin sesión) ─────
        app.MapPost("/api/acceso/llave/opciones", (HttpContext ctx) =>
        {
            if (!limitador.Permitir("llave:" + ctx.Ip(), 60, TimeSpan.FromMinutes(15))) return Error(429, "demasiados_intentos");
            var opciones = fido.GetAssertionOptions(new GetAssertionOptionsParams
            {
                AllowedCredentials = [],                         // vacía: el equipo ofrece las llaves que tenga para este sitio
                UserVerification = UserVerificationRequirement.Required,
            });
            return Results.Ok(new { id = NuevoReto(opciones.ToJson(), null), opciones = JsonDocument.Parse(opciones.ToJson()).RootElement });
        });

        app.MapPost("/api/acceso/llave", async (HttpContext ctx, PeticionRespuesta body) =>
        {
            var ip = ctx.Ip();
            var reto = TomarReto(body.Id);
            if (reto is null || reto.UsuarioId is not null) return Error(400, "reto_vencido");
            AuthenticatorAssertionRawResponse respuesta;
            try { respuesta = body.Respuesta.Deserialize<AuthenticatorAssertionRawResponse>()!; }
            catch (JsonException) { return Error(400, "llave_invalida"); }

            await using var c = await bd.AbrirAsync(ctx.RequestAborted);
            var llave = await c.QuerySingleOrDefaultAsync<FilaLlave>(new CommandDefinition(
                $"SELECT Id, UsuarioId, CredencialId, LlavePublica, Contador FROM {bd.E}.LlaveAcceso WHERE HashCredencial = @h",
                new { h = HashCred(respuesta.RawId) }, cancellationToken: ctx.RequestAborted));
            if (llave is null) return Error(401, "llave_desconocida");
            var u = await c.QuerySingleOrDefaultAsync<FilaUsuario>(new CommandDefinition(
                $"SELECT Id, Correo, Nombre, Activo FROM {bd.E}.Usuario WHERE Id = @id", new { id = llave.UsuarioId }, cancellationToken: ctx.RequestAborted));
            if (u is null || !u.Activo) return Error(401, "llave_desconocida");

            VerifyAssertionResult r;
            try
            {
                r = await fido.MakeAssertionAsync(new MakeAssertionParams
                {
                    AssertionResponse = respuesta,
                    OriginalOptions = AssertionOptions.FromJson(reto.OpcionesJson),
                    StoredPublicKey = llave.LlavePublica,
                    StoredSignatureCounter = (uint)llave.Contador,
                    IsUserHandleOwnerOfCredentialIdCallback = (p, _) =>
                        Task.FromResult(p.UserHandle.SequenceEqual(BitConverter.GetBytes(llave.UsuarioId)) && p.CredentialId.SequenceEqual(llave.CredencialId)),
                }, ctx.RequestAborted);
            }
            catch (Exception e) when (e is Fido2VerificationException or ArgumentException or InvalidOperationException)
            {
                log.LogWarning("Ingreso con llave rechazado: {Motivo}", e.Message);
                await aud.RegistrarAsync("web", "ingreso_rechazado", "rechazado", u.Id, null, u.Correo, new { motivo = "llave" }, ip, ctx.RequestAborted);
                return Error(401, "llave_invalida");
            }

            await c.ExecuteAsync(new CommandDefinition($"""
                UPDATE {bd.E}.LlaveAcceso SET Contador = @n, UltimoUsoUtc = SYSUTCDATETIME() WHERE Id = @id;
                UPDATE {bd.E}.Usuario SET UltimoIngresoUtc = SYSUTCDATETIME() WHERE Id = @u;
                """, new { n = (long)r.SignCount, id = llave.Id, u = u.Id }, cancellationToken: ctx.RequestAborted));
            var token = await sesiones.CrearAsync(u.Id, ip, ctx.Navegador(), ctx.RequestAborted);
            EndpointsAcceso.PonerCookie(ctx, token);
            await aud.RegistrarAsync("web", "ingreso_ok", "ok", u.Id, null, u.Correo, new { metodo = "llave" }, ip, ctx.RequestAborted);
            return Results.Ok(new { id = u.Id, nombre = u.Nombre, correo = u.Correo });
        });
    }
}
