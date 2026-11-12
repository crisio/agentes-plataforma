using System.Collections.Concurrent;
using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using Agentes.Comun;
using Agentes.Gateway;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;

namespace Agentes.Pruebas;

/// <summary>Solo corre con AGENTES_PRUEBAS_INTEGRACION=1 y siempre contra el esquema agentes_prueba (nunca agentes).</summary>
public sealed class FactIntegracionAttribute : FactAttribute
{
    public FactIntegracionAttribute()
    {
        if (Environment.GetEnvironmentVariable("AGENTES_PRUEBAS_INTEGRACION") != "1")
            Skip = "Integración desactivada (AGENTES_PRUEBAS_INTEGRACION=1 y esquema agentes_prueba creado).";
    }
}

public sealed class CapturaCorreo : IEnviadorCorreo
{
    readonly ConcurrentDictionary<string, ConcurrentQueue<string>> _porCorreo = new();
    public Task<bool> EnviarCodigoAsync(string correo, string nombre, string codigo, string proposito, CancellationToken ct)
    {
        _porCorreo.GetOrAdd(correo, _ => new()).Enqueue(codigo);
        return Task.FromResult(true);
    }

    public async Task<string?> EsperarAsync(string correo, int milisegundos = 5000)
    {
        var tope = DateTime.UtcNow.AddMilliseconds(milisegundos);
        while (DateTime.UtcNow < tope)
        {
            if (_porCorreo.TryGetValue(correo, out var q) && q.TryDequeue(out var c)) return c;
            await Task.Delay(50);
        }
        return null;
    }
}

public sealed class FabricaGateway : WebApplicationFactory<GatewayMarcador>
{
    public CapturaCorreo Correos { get; } = new();

    static FabricaGateway()
    {
        // Fuerza el esquema de prueba: estas pruebas nunca tocan «agentes».
        Environment.SetEnvironmentVariable("AGENTES_SQL_ESQUEMA", "agentes_prueba");
        Environment.SetEnvironmentVariable("AGENTES_CLAVE_SERVICIO", Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)));
        Environment.SetEnvironmentVariable("AGENTES_PIMIENTA", Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)));
        Environment.SetEnvironmentVariable("AGENTES_CORREO_MODO", "consola");
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder) =>
        builder.ConfigureServices(s =>
        {
            s.RemoveAll<IEnviadorCorreo>();
            s.AddSingleton<IEnviadorCorreo>(Correos);
        });

    public HttpClient Cliente()
    {
        var c = CreateClient();
        c.DefaultRequestHeaders.Add("X-Agentes", "1");
        return c;
    }

    public async Task CrearUsuarioAsync(string correo)
    {
        var bd = BaseDatos.DesdeConfiguracion();
        Assert.Equal("agentes_prueba", bd.Esquema);
        Assert.Equal(0, await AdminInicial.CrearAsync(bd, new Auditoria(bd), correo, "Persona de Prueba"));
    }
}

public class IntegracionGatewayPruebas(FabricaGateway f) : IClassFixture<FabricaGateway>
{
    static async Task<string> Texto(HttpResponseMessage r) => $"{(int)r.StatusCode}|{await r.Content.ReadAsStringAsync()}";

    [FactIntegracion]
    public async Task CodigoRespondeIgualExistaONoElCorreo()
    {
        await f.CrearUsuarioAsync("existe1@prueba.test");
        var c = f.Cliente();
        var a = await Texto(await c.PostAsJsonAsync("/api/acceso/codigo", new { correo = "existe1@prueba.test" }));
        var b = await Texto(await c.PostAsJsonAsync("/api/acceso/codigo", new { correo = "noexiste@prueba.test" }));
        var d = await Texto(await c.PostAsJsonAsync("/api/acceso/codigo", new { correo = "existe1@prueba.test", clave = "equivocada-equivocada" }));
        var e = await Texto(await c.PostAsJsonAsync("/api/acceso/codigo", new { correo = "esto no es un correo" }));
        Assert.Equal("200|{\"enviado\":true}", a);
        Assert.Equal(a, b);
        Assert.Equal(a, d);
        Assert.Equal(a, e);
        Assert.NotNull(await f.Correos.EsperarAsync("existe1@prueba.test"));
        Assert.Null(await f.Correos.EsperarAsync("noexiste@prueba.test", 300));
    }

    [FactIntegracion]
    public async Task SinCabeceraAntiCsrfSeRechazaElPost()
    {
        var c = f.CreateClient();
        var r = await c.PostAsJsonAsync("/api/acceso/codigo", new { correo = "x@y.test" });
        Assert.Equal(HttpStatusCode.Forbidden, r.StatusCode);
    }

    [FactIntegracion]
    public async Task FlujoCompletoCrearClaveSalirYVolverAEntrar()
    {
        const string correo = "flujo@prueba.test";
        await f.CrearUsuarioAsync(correo);
        var c = f.Cliente();

        Assert.Equal(HttpStatusCode.Unauthorized, (await c.GetAsync("/api/yo")).StatusCode);
        await c.PostAsJsonAsync("/api/acceso/codigo", new { correo });
        var codigo = await f.Correos.EsperarAsync(correo);
        Assert.NotNull(codigo);

        // Sin clave nueva no deja crear.
        var sinClave = await c.PostAsJsonAsync("/api/acceso/verificar", new { correo, codigo });
        Assert.Equal(HttpStatusCode.BadRequest, sinClave.StatusCode);
        var ok = await c.PostAsJsonAsync("/api/acceso/verificar", new { correo, codigo, claveNueva = "una-clave-muy-larga-1" });
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
        Assert.Contains(ok.Headers, h => h.Key == "Set-Cookie" && h.Value.Any(v => v.Contains("agc_sesion=") && v.Contains("httponly", StringComparison.OrdinalIgnoreCase)));

        var yo = await c.GetFromJsonAsync<JsonElement>("/api/yo");
        Assert.Equal(correo, yo.GetProperty("correo").GetString());
        Assert.Equal(4, yo.GetProperty("roles").GetArrayLength());
        Assert.Equal(3, (await c.GetFromJsonAsync<JsonElement>("/api/agentes")).GetArrayLength());

        // El mismo código no sirve dos veces.
        var otro = f.Cliente();
        Assert.Equal(HttpStatusCode.Unauthorized, (await otro.PostAsJsonAsync("/api/acceso/verificar", new { correo, codigo })).StatusCode);

        Assert.Equal(HttpStatusCode.OK, (await c.PostAsync("/api/acceso/salir", null)).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.GetAsync("/api/yo")).StatusCode);

        // Con clave mala no sale código; con clave buena sí.
        await c.PostAsJsonAsync("/api/acceso/codigo", new { correo, clave = "clave-mala-clave-mala" });
        Assert.Null(await f.Correos.EsperarAsync(correo, 400));
        await c.PostAsJsonAsync("/api/acceso/codigo", new { correo, clave = "una-clave-muy-larga-1" });
        var codigo2 = await f.Correos.EsperarAsync(correo);
        Assert.NotNull(codigo2);
        Assert.Equal(HttpStatusCode.OK, (await c.PostAsJsonAsync("/api/acceso/verificar", new { correo, codigo = codigo2 })).StatusCode);
    }

    [FactIntegracion]
    public async Task TrasCincoCodigosMalosElBuenoYaNoSirve()
    {
        const string correo = "intentos@prueba.test";
        await f.CrearUsuarioAsync(correo);
        var c = f.Cliente();
        await c.PostAsJsonAsync("/api/acceso/codigo", new { correo });
        var bueno = (await f.Correos.EsperarAsync(correo))!;
        var malo = bueno == "000000" ? "000001" : "000000";
        for (var i = 0; i < 5; i++)
            Assert.Equal(HttpStatusCode.Unauthorized, (await c.PostAsJsonAsync("/api/acceso/verificar", new { correo, codigo = malo, claveNueva = "una-clave-muy-larga-1" })).StatusCode);
        Assert.Equal(HttpStatusCode.Unauthorized, (await c.PostAsJsonAsync("/api/acceso/verificar", new { correo, codigo = bueno, claveNueva = "una-clave-muy-larga-1" })).StatusCode);
    }

    [FactIntegracion]
    public async Task ElEnvioDeCodigosSeLimitaATresPorCorreo()
    {
        const string correo = "limite@prueba.test";
        await f.CrearUsuarioAsync(correo);
        var c = f.Cliente();
        for (var i = 0; i < 5; i++) Assert.Equal("200|{\"enviado\":true}", await Texto(await c.PostAsJsonAsync("/api/acceso/codigo", new { correo })));
        var recibidos = 0;
        while (await f.Correos.EsperarAsync(correo, 500) is not null) recibidos++;
        Assert.Equal(CodigoAcceso.MaxPorCorreo, recibidos);
    }
}
