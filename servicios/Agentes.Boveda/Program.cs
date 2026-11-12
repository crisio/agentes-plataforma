using System.Net;
using System.Security.Cryptography;
using System.Text.Json;
using Agentes.Boveda;
using Agentes.Comun;
using Dapper;
using Microsoft.Data.SqlClient;

var builder = WebApplication.CreateBuilder(args);

var puerto = int.TryParse(Configuracion.Obtener("AGENTES_BOVEDA_PUERTO"), out var pp) ? pp : 9945;
builder.WebHost.ConfigureKestrel(o =>
{
    o.Listen(IPAddress.Loopback, puerto); // nunca 0.0.0.0
    o.AddServerHeader = false;
    o.Limits.MaxRequestBodySize = 256 * 1024;
});

var bd = BaseDatos.DesdeConfiguracion();
var tokens = TokenServicio.DesdeConfiguracion(); // si falta la clave, el servicio no arranca
builder.Services.AddSingleton(bd);
builder.Services.AddSingleton(tokens);
builder.Services.AddSingleton<Auditoria>();
builder.Services.AddSingleton<AlmacenSecretos>();
builder.Services.AddSingleton<EstadoBoveda>();

var app = builder.Build();
var estado = app.Services.GetRequiredService<EstadoBoveda>();
await estado.CargarAsync(bd); // arranca sellada; solo lee si ya se inicializó

var auditoria = app.Services.GetRequiredService<Auditoria>();
var almacen = app.Services.GetRequiredService<AlmacenSecretos>();
var log = app.Logger;
var candadoInicializar = new SemaphoreSlim(1, 1);

// ───── Transversales ─────
app.UseExceptionHandler(e => e.Run(async ctx =>
{
    ctx.Response.StatusCode = 500;
    await ctx.Response.WriteAsJsonAsync(new { error = "interno" });
}));
app.Use(async (ctx, next) =>
{
    var ip = ctx.Connection.RemoteIpAddress;
    if (ip is not null && !IPAddress.IsLoopback(ip)) { ctx.Response.StatusCode = 403; return; }
    ctx.Response.Headers.CacheControl = "no-store";
    ctx.Response.Headers.XContentTypeOptions = "nosniff";
    await next();
});

IResult Err(int codigo, string error) => Results.Json(new { error }, statusCode: codigo);
IResult Sellada() => Err(423, "sellada");

/// Valida el token de servicio de la cabecera. Devuelve los reclamos o la respuesta de rechazo.
(ReclamosServicio? Rec, IResult? Rechazo) Autorizar(HttpContext ctx, string svc, string accion)
{
    var cab = ctx.Request.Headers.Authorization.ToString();
    if (!cab.StartsWith("Servicio ", StringComparison.Ordinal)) return (null, Err(401, "token_requerido"));
    var r = tokens.Validar(cab["Servicio ".Length..].Trim(), svc, accion);
    if (!r.Ok) { log.LogWarning("Token de servicio rechazado: {Motivo}", r.Error); return (null, Err(401, "token_invalido")); }
    return (r.Reclamos, null);
}

async Task AuditarSeguro(string tipo, string res, int? usr, string? objeto, object? detalle, int? agenteId = null)
{
    try { await auditoria.RegistrarAsync("boveda", tipo, res, usr, agenteId, objeto, detalle); }
    catch (Exception e) { log.LogError("No se pudo registrar el evento {Tipo}: {Tipo2}", tipo, e.GetType().Name); }
}

/// Separa «nombre/con/barras/accion» en nombre y acción final.
static bool SepararRuta(string? ruta, out string nombre, out string accion)
{
    nombre = accion = "";
    if (string.IsNullOrEmpty(ruta)) return false;
    var i = ruta.LastIndexOf('/');
    if (i <= 0 || i == ruta.Length - 1) return false;
    nombre = ruta[..i]; accion = ruta[(i + 1)..];
    return true;
}

// ───── Estado ─────
app.MapGet("/v1/estado", () => Results.Ok(estado.Foto()));

// ───── Inicialización ─────
app.MapPost("/v1/inicializar", async (HttpContext ctx, InicializarPeticion body) =>
{
    // Siempre con token del gateway (que ya validó admin_boveda): sin esto, cualquier proceso local que llegara
    // primero podría inicializar la bóveda y quedarse con las partes.
    var (rec, rechazo) = Autorizar(ctx, "gateway", "inicializar");
    if (rechazo is not null) return rechazo;
    int? usr = rec!.Usr;
    if (body.Umbral < 1 || body.Partes < body.Umbral || body.Partes > 10) return Err(400, "umbral_o_partes_invalidos");

    await candadoInicializar.WaitAsync(ctx.RequestAborted);
    byte[]? maestra = null; byte[][]? partes = null;
    try
    {
        if (estado.Inicializada) return Err(409, "ya_inicializada");
        maestra = RandomNumberGenerator.GetBytes(32);
        partes = Shamir.Dividir(maestra, body.Umbral, body.Partes);
        var verificador = Verificador.Crear(maestra);
        try
        {
            await using var c = await bd.AbrirAsync(ctx.RequestAborted);
            await c.ExecuteAsync(new CommandDefinition(
                $"INSERT {bd.E}.BovedaLlave (Id, Verificador, Umbral, Partes) VALUES (1, @verificador, @umbral, @partes)",
                new { verificador, umbral = (byte)body.Umbral, partes = (byte)body.Partes }, cancellationToken: ctx.RequestAborted));
        }
        catch (SqlException e) when (e.Number is 2627 or 2601) { await estado.CargarAsync(bd); return Err(409, "ya_inicializada"); }

        estado.MarcarInicializada(body.Umbral, body.Partes, verificador, maestra);
        var salida = partes.Select(Convert.ToBase64String).ToArray();
        await AuditarSeguro("boveda_inicializada", "ok", usr, null, new { umbral = body.Umbral, cantidad = body.Partes });
        return Results.Ok(new { partes = salida });
    }
    finally
    {
        if (maestra is not null) CryptographicOperations.ZeroMemory(maestra);
        if (partes is not null) foreach (var p in partes) CryptographicOperations.ZeroMemory(p);
        candadoInicializar.Release();
    }
});

// ───── Abrir y sellar ─────
app.MapPost("/v1/abrir", async (HttpContext ctx, AbrirPeticion body) =>
{
    var (rec, rechazo) = Autorizar(ctx, "gateway", "abrir");
    if (rechazo is not null) return rechazo;
    byte[] parte;
    try { parte = Convert.FromBase64String(body.Parte ?? ""); }
    catch (FormatException) { parte = []; }

    var (res, recibidas) = estado.AgregarParte(parte);
    CryptographicOperations.ZeroMemory(parte);
    var foto = estado.Foto();
    switch (res)
    {
        case ResultadoParte.NoInicializada: return Err(409, "no_inicializada");
        case ResultadoParte.YaAbierta: return Results.Ok(new { abierta = true, foto.Umbral, partesRecibidas = 0 });
        case ResultadoParte.Repetida: return Err(409, "parte_repetida");
        case ResultadoParte.Invalida:
            await AuditarSeguro("boveda_parte_rechazada", "rechazado", rec!.Usr, null, new { motivo = "formato" });
            return Err(400, "parte_invalida");
        case ResultadoParte.Rechazada:
            await AuditarSeguro("boveda_parte_rechazada", "rechazado", rec!.Usr, null, new { motivo = "reconstruccion" });
            return Err(422, "reconstruccion_invalida");
        case ResultadoParte.Abierta:
            await AuditarSeguro("boveda_abierta", "ok", rec!.Usr, null, new { umbral = foto.Umbral });
            return Results.Ok(new { abierta = true, foto.Umbral, partesRecibidas = foto.Umbral });
        default:
            return Results.Ok(new { abierta = false, foto.Umbral, partesRecibidas = recibidas });
    }
});

app.MapPost("/v1/sellar", async (HttpContext ctx) =>
{
    var (rec, rechazo) = Autorizar(ctx, "gateway", "sellar");
    if (rechazo is not null) return rechazo;
    if (!estado.Inicializada) return Err(409, "no_inicializada");
    estado.Sellar();
    await AuditarSeguro("boveda_sellada", "ok", rec!.Usr, null, null);
    return Results.Ok(estado.Foto());
});

// ───── Secretos ─────
app.MapGet("/v1/secretos", async (HttpContext ctx) =>
{
    var (_, rechazo) = Autorizar(ctx, "gateway", "listar");
    if (rechazo is not null) return rechazo;
    return Results.Ok(await almacen.ListarAsync(ctx.RequestAborted));
});

app.MapPost("/v1/secretos", async (HttpContext ctx, CrearSecretoPeticion body) =>
{
    var (rec, rechazo) = Autorizar(ctx, "gateway", "crear");
    if (rechazo is not null) return rechazo;
    if (rec!.Usr is null) return Err(400, "usuario_requerido");
    var nombre = body.Nombre; var tipo = body.Tipo; var valorEntrada = body.Valor;
    if (nombre is null || !AlmacenSecretos.NombreValido(nombre)) return Err(400, "nombre_invalido");
    if (tipo is null || !AlmacenSecretos.Tipos.Contains(tipo)) return Err(400, "tipo_invalido");
    if (body.Descripcion is { Length: > 300 }) return Err(400, "descripcion_larga");
    if (string.IsNullOrEmpty(valorEntrada) || System.Text.Encoding.UTF8.GetByteCount(valorEntrada) > AlmacenSecretos.MaxBytesValor) return Err(400, "valor_invalido");
    if (!estado.Foto().Inicializada) return Err(409, "no_inicializada");

    (byte[] V, byte[] L) sobre;
    try { sobre = estado.Usar(m => Sobre.Sellar(m, nombre, 1, valorEntrada)); }
    catch (BovedaSelladaException) { return Sellada(); }

    var r = await almacen.CrearAsync(nombre, tipo, body.Descripcion, sobre.V, sobre.L, rec.Usr.Value, ctx.RequestAborted);
    if (r == Resultado.YaExiste) return Err(409, "ya_existe");
    await AuditarSeguro("secreto_creado", "ok", rec.Usr, nombre, new { version = 1, tipo });
    return Results.Json(new { nombre, version = 1 }, statusCode: 201);
});

app.MapPost("/v1/secretos/{**ruta}", async (HttpContext ctx, string ruta, RotarPeticion? body) =>
{
    if (!SepararRuta(ruta, out var nombre, out var accion) || accion is not ("rotar" or "revocar")) return Err(404, "ruta");
    var (rec, rechazo) = Autorizar(ctx, "gateway", accion);
    if (rechazo is not null) return rechazo;
    if (!AlmacenSecretos.NombreValido(nombre)) return Err(400, "nombre_invalido");

    if (accion == "revocar")
    {
        var rr = await almacen.RevocarAsync(nombre, ctx.RequestAborted);
        if (rr == Resultado.NoExiste) return Err(404, "no_existe");
        if (rr == Resultado.Revocado) return Err(409, "ya_revocado");
        await AuditarSeguro("secreto_revocado", "ok", rec!.Usr, nombre, null);
        return Results.Ok(new { nombre, revocado = true });
    }

    if (rec!.Usr is null) return Err(400, "usuario_requerido");
    if (body is null || string.IsNullOrEmpty(body.Valor) || System.Text.Encoding.UTF8.GetByteCount(body.Valor) > AlmacenSecretos.MaxBytesValor) return Err(400, "valor_invalido");
    if (!estado.Foto().Inicializada) return Err(409, "no_inicializada");
    if (estado.Foto().Sellada) return Sellada();

    var (est, version) = await almacen.ProximaVersionAsync(nombre, ctx.RequestAborted);
    if (est == Resultado.NoExiste) return Err(404, "no_existe");
    if (est == Resultado.Revocado) return Err(409, "revocado");
    (byte[] V, byte[] L) sobre;
    try { sobre = estado.Usar(m => Sobre.Sellar(m, nombre, version, body.Valor)); }
    catch (BovedaSelladaException) { return Sellada(); }
    var r = await almacen.RotarAsync(nombre, version, sobre.V, sobre.L, rec.Usr.Value, ctx.RequestAborted);
    if (r == Resultado.Invalido) return Err(409, "version_en_conflicto");
    if (r == Resultado.NoExiste) return Err(404, "no_existe");
    if (r == Resultado.Revocado) return Err(409, "revocado");
    await AuditarSeguro("secreto_rotado", "ok", rec.Usr, nombre, new { version });
    return Results.Ok(new { nombre, version });
});

app.MapPut("/v1/secretos/{**ruta}", async (HttpContext ctx, string ruta, List<PoliticaEntrada>? body) =>
{
    if (!SepararRuta(ruta, out var nombre, out var accion) || accion != "politicas") return Err(404, "ruta");
    var (rec, rechazo) = Autorizar(ctx, "gateway", "politica");
    if (rechazo is not null) return rechazo;
    if (!AlmacenSecretos.NombreValido(nombre)) return Err(400, "nombre_invalido");
    if (body is null || body.Count > 50) return Err(400, "politicas_invalidas");
    foreach (var p in body)
    {
        if (string.IsNullOrWhiteSpace(p.Agente) || p.TtlSegundos is < 1 or > 3600) return Err(400, "politicas_invalidas");
        if ((p.HoraDesde is null) != (p.HoraHasta is null)) return Err(400, "politicas_invalidas");
        if (p.HoraDesde is < 0 or > 23 || p.HoraHasta is < 0 or > 23) return Err(400, "politicas_invalidas");
    }
    if (body.Select(p => p.Agente).Distinct().Count() != body.Count) return Err(400, "agente_repetido");
    var r = await almacen.ReemplazarPoliticasAsync(nombre, body, ctx.RequestAborted);
    if (r == Resultado.NoExiste) return Err(404, "no_existe");
    if (r == Resultado.Invalido) return Err(400, "agente_desconocido");
    await AuditarSeguro("politica_cambiada", "ok", rec!.Usr, nombre, new { cantidad = body.Count, agentes = body.Select(p => p.Agente) });
    return Results.Ok(new { nombre, politicas = body.Count });
});

// ───── Entrega (solo el ejecutor) ─────
app.MapPost("/v1/entregar", async (HttpContext ctx, EntregarPeticion body) =>
{
    var (rec, rechazo) = Autorizar(ctx, "ejecutor", "entregar");
    if (rechazo is not null) return rechazo;
    if (string.IsNullOrWhiteSpace(body.Secreto) || string.IsNullOrWhiteSpace(body.Agente) || string.IsNullOrWhiteSpace(body.Herramienta))
        return Err(400, "peticion_invalida");

    // Falla cerrado: si no se puede auditar, no se entrega.
    async Task<IResult> Denegar(int codigo, string motivo, int? agenteId = null)
    {
        await auditoria.RegistrarAsync("boveda", "secreto_denegado", "rechazado", rec!.Usr, agenteId, body.Secreto,
            new { motivo, agente = body.Agente, herramienta = body.Herramienta }, ct: ctx.RequestAborted);
        return Err(codigo, motivo);
    }

    if (estado.Foto().Sellada) return await Denegar(423, "sellada");
    var d = await almacen.DatosEntregaAsync(body.Secreto, body.Agente, ctx.RequestAborted);
    if (d is null) return await Denegar(404, "secreto_no_existe");
    if (d.Revocado) return await Denegar(403, "revocado", d.AgenteId);
    if (d.AgenteId is null) return await Denegar(403, "agente_desconocido");
    if (!d.TienePolitica) return await Denegar(403, "sin_politica", d.AgenteId);
    var ahora = DateTimeOffset.UtcNow;
    if (!AlmacenSecretos.HoraPermitida(d.HoraDesde, d.HoraHasta, AlmacenSecretos.HoraHonduras(ahora)))
        return await Denegar(403, "fuera_de_horario", d.AgenteId);

    var v = await almacen.LeerVersionAsync(d.SecretoId, d.Version, ctx.RequestAborted);
    if (v is null) return Err(500, "interno");
    string valor;
    try { valor = estado.Usar(m => Sobre.Abrir(m, d.Nombre, d.Version, v.Value.ValorCifrado, v.Value.LlaveEnvuelta)); }
    catch (BovedaSelladaException) { return await Denegar(423, "sellada", d.AgenteId); }
    catch (CryptographicException) { return await Denegar(500, "descifrado_fallido", d.AgenteId); }

    var vence = ahora.UtcDateTime.AddSeconds(d.TtlSegundos!.Value);
    await auditoria.RegistrarAsync("boveda", "secreto_entregado", "ok", rec!.Usr, d.AgenteId, d.Nombre,
        new { version = d.Version, agente = body.Agente, herramienta = body.Herramienta, ttl = d.TtlSegundos }, ct: ctx.RequestAborted);
    return Results.Ok(new { valor, venceUtc = DateTime.SpecifyKind(vence, DateTimeKind.Utc) });
});

// ───── Conexiones de las personas con otros sistemas (solo el ejecutor; nombres «conexion/…») ─────
// Los tokens OAuth de cada persona con un sistema (p. ej. Hilo) rotan en cada renovación: el ejecutor los guarda y los
// lee aquí, sin políticas por agente, porque solo él los usa y solo bajo el prefijo «conexion/».
static bool NombreConexion(string? n) => n is not null && n.StartsWith("conexion/", StringComparison.Ordinal) && AlmacenSecretos.NombreValido(n);

app.MapPost("/v1/conexion/guardar", async (HttpContext ctx, ConexionGuardarPeticion body) =>
{
    var (rec, rechazo) = Autorizar(ctx, "ejecutor", "conexion_guardar");
    if (rechazo is not null) return rechazo;
    if (rec!.Usr is null) return Err(400, "usuario_requerido");
    var nombre = body.Nombre!;
    if (!NombreConexion(nombre)) return Err(400, "nombre_invalido");
    if (string.IsNullOrEmpty(body.Valor) || System.Text.Encoding.UTF8.GetByteCount(body.Valor) > AlmacenSecretos.MaxBytesValor) return Err(400, "valor_invalido");
    if (!estado.Foto().Inicializada) return Err(409, "no_inicializada");
    if (estado.Foto().Sellada) return Sellada();

    var (est, version) = await almacen.ProximaVersionAsync(nombre, ctx.RequestAborted);
    if (est == Resultado.Revocado)
    {
        await almacen.ReactivarAsync(nombre, ctx.RequestAborted);
        (est, version) = await almacen.ProximaVersionAsync(nombre, ctx.RequestAborted);
    }
    (byte[] V, byte[] L) sobre;
    if (est == Resultado.NoExiste)
    {
        try { sobre = estado.Usar(m => Sobre.Sellar(m, nombre, 1, body.Valor)); }
        catch (BovedaSelladaException) { return Sellada(); }
        var descripcion = body.Descripcion is { Length: <= 300 } ? body.Descripcion : null;
        if (await almacen.CrearAsync(nombre, "token", descripcion, sobre.V, sobre.L, rec.Usr.Value, ctx.RequestAborted) == Resultado.YaExiste)
            return Err(409, "version_en_conflicto");
        version = 1;
    }
    else
    {
        try { sobre = estado.Usar(m => Sobre.Sellar(m, nombre, version, body.Valor)); }
        catch (BovedaSelladaException) { return Sellada(); }
        if (await almacen.RotarAsync(nombre, version, sobre.V, sobre.L, rec.Usr.Value, ctx.RequestAborted) != Resultado.Ok)
            return Err(409, "version_en_conflicto");
    }
    await AuditarSeguro("conexion_guardada", "ok", rec.Usr, nombre, new { version });
    return Results.Ok(new { nombre, version });
});

app.MapPost("/v1/conexion/leer", async (HttpContext ctx, ConexionNombrePeticion body) =>
{
    var (rec, rechazo) = Autorizar(ctx, "ejecutor", "conexion_leer");
    if (rechazo is not null) return rechazo;
    if (!NombreConexion(body.Nombre)) return Err(400, "nombre_invalido");
    if (!estado.Foto().Inicializada) return Err(409, "no_inicializada");
    if (estado.Foto().Sellada) return Sellada();
    var d = await almacen.DatosEntregaAsync(body.Nombre!, "", ctx.RequestAborted);
    if (d is null || d.Revocado) return Err(404, "no_existe");
    var v = await almacen.LeerVersionAsync(d.SecretoId, d.Version, ctx.RequestAborted);
    if (v is null) return Err(500, "interno");
    try { return Results.Ok(new { valor = estado.Usar(m => Sobre.Abrir(m, d.Nombre, d.Version, v.Value.ValorCifrado, v.Value.LlaveEnvuelta)), version = d.Version }); }
    catch (BovedaSelladaException) { return Sellada(); }
    catch (CryptographicException)
    {
        await AuditarSeguro("conexion_ilegible", "error", rec!.Usr, body.Nombre, null);
        return Err(500, "descifrado_fallido");
    }
});

app.MapPost("/v1/conexion/borrar", async (HttpContext ctx, ConexionNombrePeticion body) =>
{
    var (rec, rechazo) = Autorizar(ctx, "ejecutor", "conexion_borrar");
    if (rechazo is not null) return rechazo;
    if (!NombreConexion(body.Nombre)) return Err(400, "nombre_invalido");
    var r = await almacen.RevocarAsync(body.Nombre!, ctx.RequestAborted);
    if (r == Resultado.Ok) await AuditarSeguro("conexion_borrada", "ok", rec!.Usr, body.Nombre, null);
    return Results.Ok(new { nombre = body.Nombre, borrada = r == Resultado.Ok });
});

// ───── Llave del modelo (solo el orquestador; nombres «modelo/…») ─────
// La carga el admin desde la pantalla Bóveda (p. ej. «modelo/openrouter»). Sin políticas por agente: solo el
// orquestador la pide, solo bajo este prefijo, y cada entrega queda auditada.
app.MapPost("/v1/modelo/entregar", async (HttpContext ctx, ConexionNombrePeticion body) =>
{
    var (rec, rechazo) = Autorizar(ctx, "orquestador", "modelo_entregar");
    if (rechazo is not null) return rechazo;
    var nombre = body.Nombre;
    if (nombre is null || !nombre.StartsWith("modelo/", StringComparison.Ordinal) || !AlmacenSecretos.NombreValido(nombre)) return Err(400, "nombre_invalido");
    if (!estado.Foto().Inicializada) return Err(409, "no_inicializada");
    if (estado.Foto().Sellada) return Sellada();
    var d = await almacen.DatosEntregaAsync(nombre, "", ctx.RequestAborted);
    if (d is null || d.Revocado) return Err(404, "no_existe");
    var v = await almacen.LeerVersionAsync(d.SecretoId, d.Version, ctx.RequestAborted);
    if (v is null) return Err(500, "interno");
    string valor;
    try { valor = estado.Usar(m => Sobre.Abrir(m, d.Nombre, d.Version, v.Value.ValorCifrado, v.Value.LlaveEnvuelta)); }
    catch (BovedaSelladaException) { return Sellada(); }
    catch (CryptographicException) { await AuditarSeguro("secreto_denegado", "error", rec!.Usr, nombre, new { motivo = "descifrado_fallido" }); return Err(500, "descifrado_fallido"); }
    // Falla cerrado: si no se puede auditar, no se entrega.
    await auditoria.RegistrarAsync("boveda", "secreto_entregado", "ok", rec!.Usr, null, d.Nombre,
        new { version = d.Version, agente = (string?)null, herramienta = "modelo" }, ct: ctx.RequestAborted);
    return Results.Ok(new { valor, version = d.Version });
});

app.Run();

record InicializarPeticion(int Umbral, int Partes);
record AbrirPeticion(string? Parte);
record CrearSecretoPeticion(string? Nombre, string? Tipo, string? Descripcion, string? Valor);
record RotarPeticion(string? Valor);
record EntregarPeticion(string? Secreto, string? Agente, string? Herramienta);
record ConexionGuardarPeticion(string? Nombre, string? Valor, string? Descripcion);
record ConexionNombrePeticion(string? Nombre);


