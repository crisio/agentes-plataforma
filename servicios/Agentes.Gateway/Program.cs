using System.Net;
using Agentes.Comun;
using Agentes.Gateway;

// Arranque inicial: crear el primer administrador y salir.
if (args.Length >= 1 && args[0] == "--crear-admin")
{
    if (args.Length < 3) { Console.Error.WriteLine("Uso: dotnet run -- --crear-admin <correo> \"<nombre>\""); return 2; }
    var bdAdmin = BaseDatos.DesdeConfiguracion();
    return await AdminInicial.CrearAsync(bdAdmin, new Auditoria(bdAdmin), args[1], args[2]);
}

var builder = WebApplication.CreateBuilder(args);

var puerto = int.TryParse(Configuracion.Obtener("AGENTES_GATEWAY_PUERTO"), out var pp) ? pp : 9942;
builder.WebHost.ConfigureKestrel(o =>
{
    o.Listen(IPAddress.Loopback, puerto); // 127.0.0.1: sale por el túnel junto con la app
    o.AddServerHeader = false;
    o.Limits.MaxRequestBodySize = 256 * 1024;
});

var modoCorreo = (Configuracion.Obtener("AGENTES_CORREO_MODO") ?? "resend").ToLowerInvariant();
if (modoCorreo is not ("resend" or "consola")) throw new InvalidOperationException("AGENTES_CORREO_MODO debe ser «resend» o «consola».");

var bd = BaseDatos.DesdeConfiguracion();
var tokens = TokenServicio.DesdeConfiguracion();      // sin AGENTES_CLAVE_SERVICIO no arranca
_ = Configuracion.Requerir("AGENTES_PIMIENTA");       // sin pimienta tampoco

builder.Services.AddSingleton(bd);
builder.Services.AddSingleton(tokens);
builder.Services.AddSingleton<Auditoria>();
builder.Services.AddSingleton<ServicioSesiones>();
builder.Services.AddSingleton<Limitador>();
builder.Services.AddSingleton(new ModoCorreo(modoCorreo == "consola"));
if (modoCorreo == "consola") builder.Services.AddSingleton<IEnviadorCorreo, EnviadorConsola>();
else
{
    builder.Services.AddHttpClient<EnviadorResend>(h => h.Timeout = TimeSpan.FromSeconds(10));
    builder.Services.AddSingleton<IEnviadorCorreo>(sp => sp.GetRequiredService<EnviadorResend>());
}
builder.Services.AddHttpClient<ClienteBoveda>(h =>
{
    h.BaseAddress = new Uri(Configuracion.Obtener("AGENTES_BOVEDA_URL") ?? "http://127.0.0.1:9945");
    h.Timeout = TimeSpan.FromSeconds(15);
});

builder.Services.AddHttpClient<ClienteEjecutor>(h =>
{
    h.BaseAddress = new Uri(Configuracion.Obtener("AGENTES_EJECUTOR_URL") ?? "http://127.0.0.1:9944");
    h.Timeout = TimeSpan.FromSeconds(90);
});
builder.Services.AddHttpClient<ClienteOrquestador>(h =>
{
    h.BaseAddress = new Uri(Configuracion.Obtener("AGENTES_ORQUESTADOR_URL") ?? "http://127.0.0.1:9943");
    h.Timeout = TimeSpan.FromSeconds(150);   // el turno tiene tope de 120 s en el orquestador
});

var app = builder.Build();

// Cada petición pasa por aquí: red local, cabeceras seguras, anti-CSRF y resolución de la sesión.
app.UseExceptionHandler(e => e.Run(async ctx =>
{
    ctx.Response.StatusCode = 500;
    await ctx.Response.WriteAsJsonAsync(new { error = "interno" });
}));
app.Use(async (ctx, next) =>
{
    if (!ctx.ConexionLocal()) { ctx.Response.StatusCode = 403; return; }
    ctx.Response.Headers.CacheControl = "no-store";
    ctx.Response.Headers.XContentTypeOptions = "nosniff";
    ctx.Response.Headers["Referrer-Policy"] = "no-referrer";

    var metodo = ctx.Request.Method;
    var cambia = !(HttpMethods.IsGet(metodo) || HttpMethods.IsHead(metodo) || HttpMethods.IsOptions(metodo));
    if (cambia && ctx.Request.Headers["X-Agentes"] != "1")
    {
        ctx.Response.StatusCode = 403;
        await ctx.Response.WriteAsJsonAsync(new { error = "falta_cabecera_x_agentes" });
        return;
    }
    if (ctx.Request.Cookies.TryGetValue(ServicioSesiones.Cookie, out var token))
    {
        var s = await ctx.RequestServices.GetRequiredService<ServicioSesiones>().ResolverAsync(token, ctx.RequestAborted);
        if (s is not null) ctx.Items[ContextoHttp.ClaveSesion] = s;
    }
    await next();
});

EndpointsAcceso.Mapear(app);
EndpointsPerfil.Mapear(app);
EndpointsAuditoria.Mapear(app);
EndpointsUsuarios.Mapear(app);
EndpointsBoveda.Mapear(app);
EndpointsConexiones.Mapear(app);
EndpointsLlaves.Mapear(app);
EndpointsChat.Mapear(app);

app.Run();
return 0;

public sealed record ModoCorreo(bool Consola);

/// <summary>Marca el ensamblado del gateway para las pruebas de integración.</summary>
public sealed class GatewayMarcador;
