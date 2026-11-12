using System.Text.RegularExpressions;
using Agentes.Comun;
using Dapper;

namespace Agentes.Gateway;

public sealed record CodigoPeticion(string? Correo, string? Clave);
public sealed record VerificarPeticion(string? Correo, string? Codigo, string? ClaveNueva);

/// <summary>Acceso sin clave: código de 6 dígitos por correo (o llave de acceso, ver EndpointsLlaves) y sesión con cookie.</summary>
public static partial class EndpointsAcceso
{
    sealed record FilaUsuario(int Id, string Correo, string Nombre, string? HashClave, bool Activo);
    sealed record FilaCodigo(long Id, string HashCodigo, string Proposito, DateTime VenceUtc, byte Intentos, DateTime? UsadoUtc);

    [GeneratedRegex(@"^[^@\s]{1,100}@[^@\s]+\.[^@\s]+$")]
    private static partial Regex CorreoRx();

    public static string? NormalizarCorreo(string? c)
    {
        var s = c?.Trim().ToLowerInvariant();
        return s is { Length: <= 200 } && CorreoRx().IsMatch(s) ? s : null;
    }

    public static void Mapear(WebApplication app)
    {
        var bd = app.Services.GetRequiredService<BaseDatos>();
        var aud = app.Services.GetRequiredService<Auditoria>();
        var sesiones = app.Services.GetRequiredService<ServicioSesiones>();
        var limitador = app.Services.GetRequiredService<Limitador>();
        var pimienta = Configuracion.Requerir("AGENTES_PIMIENTA");
        var modoConsola = app.Services.GetRequiredService<ModoCorreo>().Consola;
        var log = app.Logger;
        var ventana = TimeSpan.FromMinutes(CodigoAcceso.VentanaMinutos);

        // Siempre la misma respuesta: no delata si el correo existe.
        IResult Enviado() => Results.Ok(new { enviado = true });
        IResult Invalido() => Results.Json(new { error = "codigo_invalido" }, statusCode: 401);

        app.MapPost("/api/acceso/codigo", async (HttpContext ctx, CodigoPeticion? body) =>
        {
            var ip = ctx.Ip();
            if (!limitador.Permitir("ip:" + ip, CodigoAcceso.MaxPorIp, ventana)) return Enviado();
            var correo = NormalizarCorreo(body?.Correo);
            if (correo is null) return Enviado();
            if (!limitador.Permitir("correo:" + correo, 10, ventana)) return Enviado();

            await using var c = await bd.AbrirAsync(ctx.RequestAborted);
            var u = await c.QuerySingleOrDefaultAsync<FilaUsuario>(new CommandDefinition(
                $"SELECT Id, Correo, Nombre, HashClave, Activo FROM {bd.E}.Usuario WHERE Correo = @correo", new { correo }, cancellationToken: ctx.RequestAborted));
            if (u is null || !u.Activo) return Enviado();
            const string proposito = "ingreso";

            var recientes = await c.ExecuteScalarAsync<int>(new CommandDefinition(
                $"SELECT COUNT(1) FROM {bd.E}.CodigoAcceso WHERE UsuarioId = @id AND CreadoUtc > DATEADD(MINUTE, -{CodigoAcceso.VentanaMinutos}, SYSUTCDATETIME())",
                new { id = u.Id }, cancellationToken: ctx.RequestAborted));
            if (recientes >= CodigoAcceso.MaxPorCorreo)
            {
                await aud.RegistrarAsync("web", "ingreso_rechazado", "rechazado", u.Id, null, u.Correo, new { motivo = "limite_codigos" }, ip, ctx.RequestAborted);
                return Enviado();
            }

            var codigo = CodigoAcceso.Generar();
            await c.ExecuteAsync(new CommandDefinition($"""
                UPDATE {bd.E}.CodigoAcceso SET UsadoUtc = SYSUTCDATETIME() WHERE UsuarioId = @id AND UsadoUtc IS NULL;
                INSERT {bd.E}.CodigoAcceso (UsuarioId, HashCodigo, Proposito, VenceUtc)
                VALUES (@id, @hash, @proposito, DATEADD(MINUTE, {CodigoAcceso.MinutosVigencia}, SYSUTCDATETIME()))
                """, new { id = u.Id, hash = CodigoAcceso.Hash(codigo, u.Id, pimienta), proposito }, cancellationToken: ctx.RequestAborted));

            // En modo consola el código solo se muestra si la petición es local y no viene de un proxy.
            var permitido = !modoConsola || (ctx.ConexionLocal() && !ctx.ViaProxy());
            if (permitido)
            {
                var enviador = ctx.RequestServices.GetRequiredService<IEnviadorCorreo>();
                var (uid, ucorreo, unombre) = (u.Id, u.Correo, u.Nombre);
                // En segundo plano: así el tiempo de respuesta no delata si el correo existe.
                _ = Task.Run(async () =>
                {
                    var ok = false;
                    try { ok = await enviador.EnviarCodigoAsync(ucorreo, unombre, codigo, proposito, CancellationToken.None); }
                    catch (Exception e) { log.LogWarning("Falló el envío del código: {Tipo}", e.GetType().Name); }
                    try { await aud.RegistrarAsync("web", "ingreso_codigo_enviado", ok ? "ok" : "error", uid, null, ucorreo, new { proposito }, ip); }
                    catch (Exception e) { log.LogError("No se pudo auditar el envío: {Tipo}", e.GetType().Name); }
                });
            }
            else log.LogWarning("Código no enviado: el modo consola solo se acepta en loopback.");
            return Enviado();
        });

        app.MapPost("/api/acceso/verificar", async (HttpContext ctx, VerificarPeticion? body) =>
        {
            var ip = ctx.Ip();
            if (!limitador.Permitir("verip:" + ip, 60, ventana)) return Invalido();
            var correo = NormalizarCorreo(body?.Correo);
            var codigo = body?.Codigo?.Trim() ?? "";
            if (correo is null || codigo.Length != 6 || !codigo.All(char.IsAsciiDigit)) return Invalido();

            await using var c = await bd.AbrirAsync(ctx.RequestAborted);
            var u = await c.QuerySingleOrDefaultAsync<FilaUsuario>(new CommandDefinition(
                $"SELECT Id, Correo, Nombre, HashClave, Activo FROM {bd.E}.Usuario WHERE Correo = @correo", new { correo }, cancellationToken: ctx.RequestAborted));
            if (u is null || !u.Activo) return Invalido();

            var fila = await c.QuerySingleOrDefaultAsync<FilaCodigo>(new CommandDefinition(
                $"SELECT TOP 1 Id, HashCodigo, Proposito, VenceUtc, Intentos, UsadoUtc FROM {bd.E}.CodigoAcceso WHERE UsuarioId = @id ORDER BY Id DESC",
                new { id = u.Id }, cancellationToken: ctx.RequestAborted));
            if (fila is null) return Invalido();

            var veredicto = CodigoAcceso.Evaluar(fila.HashCodigo.Trim(), fila.Intentos, fila.VenceUtc, fila.UsadoUtc, DateTime.UtcNow, codigo, u.Id, pimienta);
            if (veredicto is VeredictoCodigo.Usado or VeredictoCodigo.Vencido or VeredictoCodigo.Agotado)
            {
                await aud.RegistrarAsync("web", "ingreso_rechazado", "rechazado", u.Id, null, u.Correo, new { motivo = veredicto.ToString().ToLowerInvariant() }, ip, ctx.RequestAborted);
                return Invalido();
            }
            // Cuenta el intento de forma atómica (también el acertado) antes de decidir.
            var contado = await c.ExecuteAsync(new CommandDefinition($"""
                UPDATE {bd.E}.CodigoAcceso SET Intentos = Intentos + 1
                WHERE Id = @id AND UsadoUtc IS NULL AND Intentos < {CodigoAcceso.MaxIntentos} AND VenceUtc > SYSUTCDATETIME()
                """, new { id = fila.Id }, cancellationToken: ctx.RequestAborted));
            if (contado == 0 || veredicto == VeredictoCodigo.Incorrecto)
            {
                await aud.RegistrarAsync("web", "ingreso_rechazado", "rechazado", u.Id, null, u.Correo, new { motivo = "codigo" }, ip, ctx.RequestAborted);
                return Invalido();
            }

            // Consumir el código: solo uno gana si llegan dos a la vez.
            var usado = await c.ExecuteAsync(new CommandDefinition(
                $"UPDATE {bd.E}.CodigoAcceso SET UsadoUtc = SYSUTCDATETIME() WHERE Id = @id AND UsadoUtc IS NULL", new { id = fila.Id }, cancellationToken: ctx.RequestAborted));
            if (usado == 0) return Invalido();

            await c.ExecuteAsync(new CommandDefinition(
                $"UPDATE {bd.E}.Usuario SET UltimoIngresoUtc = SYSUTCDATETIME() WHERE Id = @id", new { id = u.Id }, cancellationToken: ctx.RequestAborted));
            var token = await sesiones.CrearAsync(u.Id, ip, ctx.Navegador(), ctx.RequestAborted);
            PonerCookie(ctx, token);
            await aud.RegistrarAsync("web", "ingreso_ok", "ok", u.Id, null, u.Correo, new { metodo = "codigo" }, ip, ctx.RequestAborted);
            return Results.Ok(new { id = u.Id, nombre = u.Nombre, correo = u.Correo });
        });

        app.MapPost("/api/acceso/salir", async (HttpContext ctx) =>
        {
            var s = ctx.Sesion()!;
            await sesiones.RevocarAsync(s.SesionId, ctx.RequestAborted);
            QuitarCookie(ctx);
            await aud.RegistrarAsync("web", "sesion_cerrada", "ok", s.UsuarioId, null, s.Correo, null, ctx.Ip(), ctx.RequestAborted);
            return Results.Ok(new { salio = true });
        }).RequiereSesion();

        // Poda periódica de los contadores en memoria.
        app.Lifetime.ApplicationStarted.Register(() => _ = Task.Run(async () =>
        {
            using var t = new PeriodicTimer(TimeSpan.FromMinutes(5));
            while (await t.WaitForNextTickAsync(app.Lifetime.ApplicationStopping)) limitador.Podar(ventana);
        }));
    }

    static CookieOptions OpcionesCookie(HttpContext ctx) => new()
    {
        HttpOnly = true,
        // Secure salvo cuando es una conexión local directa (desarrollo, pruebas).
        Secure = !(ctx.ConexionLocal() && !ctx.ViaProxy()),
        SameSite = SameSiteMode.Strict,
        Path = "/",
    };

    public static void PonerCookie(HttpContext ctx, string token)
    {
        var o = OpcionesCookie(ctx);
        o.MaxAge = TimeSpan.FromDays(ServicioSesiones.DiasTope);
        ctx.Response.Cookies.Append(ServicioSesiones.Cookie, token, o);
    }

    static void QuitarCookie(HttpContext ctx) => ctx.Response.Cookies.Delete(ServicioSesiones.Cookie, OpcionesCookie(ctx));
}
