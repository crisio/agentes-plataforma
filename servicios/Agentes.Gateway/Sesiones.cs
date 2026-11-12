using System.Net;
using System.Security.Cryptography;
using Agentes.Comun;
using Dapper;

namespace Agentes.Gateway;

public sealed record SesionActual(long SesionId, int UsuarioId, string Correo, string Nombre, HashSet<string> Roles)
{
    public bool Tiene(params string[] roles) => roles.Any(Roles.Contains);
}

/// <summary>Sesiones con token aleatorio de 32 bytes; en la base solo vive su hash SHA-256.</summary>
public sealed class ServicioSesiones(BaseDatos bd)
{
    public const string Cookie = "agc_sesion";
    public const int HorasVigencia = 24 * 30;   // te recuerda 30 días desde el último uso…
    public const int DiasTope = 90;             // …y a los 90 días vuelve a pedir el código o la llave

    sealed record FilaSesion(long SesionId, int UsuarioId, string Correo, string Nombre, int SegundosSinUso);

    static DbString Hash(string token) => new() { Value = Codificacion.Sha256Hex(token), IsAnsi = true, IsFixedLength = true, Length = 64 };

    public async Task<string> CrearAsync(int usuarioId, string? ip, string? navegador, CancellationToken ct)
    {
        var token = Codificacion.Base64Url(RandomNumberGenerator.GetBytes(32));
        await using var c = await bd.AbrirAsync(ct);
        await c.ExecuteAsync(new CommandDefinition(
            $"INSERT {bd.E}.Sesion (UsuarioId, HashToken, VenceUtc, Ip, Navegador) VALUES (@usuarioId, @hash, DATEADD(HOUR, {HorasVigencia}, SYSUTCDATETIME()), @ip, @navegador)",
            new { usuarioId, hash = Hash(token), ip = ip is null ? null : new DbString { Value = ip, IsAnsi = true, Length = 45 }, navegador = Recortar(navegador, 300) },
            cancellationToken: ct));
        return token;
    }

    public async Task<SesionActual?> ResolverAsync(string? token, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(token) || token.Length > 100) return null;
        await using var c = await bd.AbrirAsync(ct);
        var f = await c.QuerySingleOrDefaultAsync<FilaSesion>(new CommandDefinition($"""
            SELECT s.Id AS SesionId, s.UsuarioId, u.Correo, u.Nombre, DATEDIFF(SECOND, s.UltimoUsoUtc, SYSUTCDATETIME()) AS SegundosSinUso
            FROM {bd.E}.Sesion s JOIN {bd.E}.Usuario u ON u.Id = s.UsuarioId
            WHERE s.HashToken = @hash AND s.RevocadaUtc IS NULL AND s.VenceUtc > SYSUTCDATETIME()
              AND DATEADD(DAY, {DiasTope}, s.CreadaUtc) > SYSUTCDATETIME() AND u.Activo = 1
            """, new { hash = Hash(token) }, cancellationToken: ct));
        if (f is null) return null;
        var roles = (await c.QueryAsync<string>(new CommandDefinition(
            $"SELECT Rol FROM {bd.E}.RolPlataforma WHERE UsuarioId = @id", new { id = f.UsuarioId }, cancellationToken: ct))).ToHashSet();
        if (f.SegundosSinUso >= 60) // renovación deslizante, con tope desde que se creó
            await c.ExecuteAsync(new CommandDefinition($"""
                UPDATE {bd.E}.Sesion SET UltimoUsoUtc = SYSUTCDATETIME(),
                  VenceUtc = CASE WHEN DATEADD(HOUR, {HorasVigencia}, SYSUTCDATETIME()) < DATEADD(DAY, {DiasTope}, CreadaUtc)
                                  THEN DATEADD(HOUR, {HorasVigencia}, SYSUTCDATETIME()) ELSE DATEADD(DAY, {DiasTope}, CreadaUtc) END
                WHERE Id = @id
                """, new { id = f.SesionId }, cancellationToken: ct));
        return new SesionActual(f.SesionId, f.UsuarioId, f.Correo, f.Nombre, roles);
    }

    public async Task RevocarAsync(long sesionId, CancellationToken ct)
    {
        await using var c = await bd.AbrirAsync(ct);
        await c.ExecuteAsync(new CommandDefinition(
            $"UPDATE {bd.E}.Sesion SET RevocadaUtc = SYSUTCDATETIME() WHERE Id = @sesionId AND RevocadaUtc IS NULL", new { sesionId }, cancellationToken: ct));
    }

    public async Task RevocarDeUsuarioAsync(int usuarioId, CancellationToken ct)
    {
        await using var c = await bd.AbrirAsync(ct);
        await c.ExecuteAsync(new CommandDefinition(
            $"UPDATE {bd.E}.Sesion SET RevocadaUtc = SYSUTCDATETIME() WHERE UsuarioId = @usuarioId AND RevocadaUtc IS NULL", new { usuarioId }, cancellationToken: ct));
    }

    static string? Recortar(string? s, int max) => s is null ? null : s.Length <= max ? s : s[..max];
}

public static class ContextoHttp
{
    public const string ClaveSesion = "agc.sesion";

    public static SesionActual? Sesion(this HttpContext ctx) => ctx.Items.TryGetValue(ClaveSesion, out var s) ? s as SesionActual : null;

    /// <summary>La conexión viene de este mismo equipo (el túnel, la app o una prueba). Sin dirección = servidor de pruebas.</summary>
    public static bool ConexionLocal(this HttpContext ctx) =>
        ctx.Connection.RemoteIpAddress is null || IPAddress.IsLoopback(ctx.Connection.RemoteIpAddress);

    /// <summary>Detrás del túnel la conexión es local pero la petición trae cabeceras del proxy.</summary>
    public static bool ViaProxy(this HttpContext ctx) =>
        ctx.Request.Headers.ContainsKey("CF-Connecting-IP") || ctx.Request.Headers.ContainsKey("X-Forwarded-For")
        || string.Equals(ctx.Request.Headers["X-Forwarded-Proto"], "https", StringComparison.OrdinalIgnoreCase);

    /// <summary>IP del cliente: la real del túnel si viene por ahí; si no, la de la conexión.</summary>
    public static string Ip(this HttpContext ctx)
    {
        if (ctx.ConexionLocal())
        {
            var cf = ctx.Request.Headers["CF-Connecting-IP"].ToString();
            if (cf.Length is > 0 and <= 45) return cf;
            var xff = ctx.Request.Headers["X-Forwarded-For"].ToString().Split(',')[0].Trim();
            if (xff.Length is > 0 and <= 45) return xff;
        }
        return ctx.Connection.RemoteIpAddress?.ToString() ?? "local";
    }

    public static string? Navegador(this HttpContext ctx) => ctx.Request.Headers.UserAgent.ToString() is { Length: > 0 } ua ? ua : null;
}
