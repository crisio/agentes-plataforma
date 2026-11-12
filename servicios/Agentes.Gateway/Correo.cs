using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using Agentes.Comun;

namespace Agentes.Gateway;

public interface IEnviadorCorreo
{
    /// <summary>Manda el código de acceso. Devuelve false si no se pudo enviar. Nunca registra el código.</summary>
    Task<bool> EnviarCodigoAsync(string correo, string nombre, string codigo, string proposito, CancellationToken ct);
}

/// <summary>Resend: el único correo que sale de la plataforma son los códigos de acceso.</summary>
public sealed class EnviadorResend(HttpClient http, ILogger<EnviadorResend> log) : IEnviadorCorreo
{
    readonly string _clave = Configuracion.Obtener("RESEND_API_KEY") ?? Configuracion.Obtener("Mcp__Resend__ApiKey")
        ?? throw new InvalidOperationException("Falta RESEND_API_KEY (o Mcp__Resend__ApiKey) con AGENTES_CORREO_MODO=resend.");
    readonly string _remitente = Configuracion.Obtener("AGENTES_CORREO_REMITENTE") ?? "Agentes GC <acceso@ejemplo.com>";

    public async Task<bool> EnviarCodigoAsync(string correo, string nombre, string codigo, string proposito, CancellationToken ct)
    {
        var asunto = proposito == "crear_clave" ? "Tu código para crear tu clave de Agentes GC" : "Tu código de acceso a Agentes GC";
        var intro = proposito == "crear_clave" ? "Usa este código para crear tu clave" : "Usa este código para entrar";
        var html = $"""
            <div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:420px;margin:auto;padding:24px;color:#1b1b1f">
              <p>Hola {WebUtility.HtmlEncode(nombre)},</p>
              <p>{intro}. Vence en {CodigoAcceso.MinutosVigencia} minutos.</p>
              <p style="font-size:34px;letter-spacing:8px;font-weight:700;margin:20px 0">{codigo}</p>
              <p style="color:#666;font-size:13px">Si no fuiste tú, ignora este mensaje. Nadie de la empresa te pedirá este código.</p>
            </div>
            """;
        using var req = new HttpRequestMessage(HttpMethod.Post, "https://api.resend.com/emails");
        req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _clave);
        req.Content = new StringContent(JsonSerializer.Serialize(new { from = _remitente, to = new[] { correo }, subject = asunto, html }),
            Encoding.UTF8, "application/json");
        try
        {
            using var res = await http.SendAsync(req, ct);
            if (res.IsSuccessStatusCode) return true;
            log.LogWarning("Resend respondió {Estado} al enviar un código.", (int)res.StatusCode);
            return false;
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
        {
            log.LogWarning("No se pudo contactar a Resend: {Tipo}", e.GetType().Name);
            return false;
        }
    }
}

/// <summary>Modo consola: escribe el código en la salida estándar. Solo para desarrollo en loopback.</summary>
public sealed class EnviadorConsola : IEnviadorCorreo
{
    public Task<bool> EnviarCodigoAsync(string correo, string nombre, string codigo, string proposito, CancellationToken ct)
    {
        Console.WriteLine($"[CODIGO-CONSOLA] correo={correo} proposito={proposito} codigo={codigo}");
        return Task.FromResult(true);
    }
}
