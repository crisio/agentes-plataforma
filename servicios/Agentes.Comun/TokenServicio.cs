using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Agentes.Comun;

public sealed record ReclamosServicio(string Svc, int? Usr, int? Agt, string Acc, long Exp, string Jti);

public sealed record ResultadoToken(bool Ok, string? Error, ReclamosServicio? Reclamos)
{
    public static ResultadoToken Falla(string error) => new(false, error, null);
}

/// <summary>
/// Token de servicio: base64url(json) + "." + base64url(HMAC-SHA256(clave, base64url(json))).
/// Vence en ≤ 60 s y cada jti sirve una sola vez mientras no venza.
/// </summary>
public sealed class TokenServicio
{
    public const int VigenciaMaximaSegundos = 60;
    public const int VigenciaPorDefectoSegundos = 30;

    readonly byte[] _clave;
    readonly Func<DateTimeOffset> _reloj;
    readonly ConcurrentDictionary<string, long> _vistos = new();
    long _ultimaLimpieza;

    public TokenServicio(byte[] clave, Func<DateTimeOffset>? reloj = null)
    {
        if (clave.Length < 32) throw new ArgumentException("La clave de servicio debe tener al menos 32 bytes.");
        _clave = clave;
        _reloj = reloj ?? (() => DateTimeOffset.UtcNow);
    }

    /// <summary>Lee AGENTES_CLAVE_SERVICIO (32 bytes en base64). Si falta o no sirve, lanza: el servicio no arranca.</summary>
    public static TokenServicio DesdeConfiguracion()
    {
        var b64 = Configuracion.Obtener("AGENTES_CLAVE_SERVICIO")
            ?? throw new InvalidOperationException("Falta AGENTES_CLAVE_SERVICIO (32 bytes en base64). El servicio no arranca sin ella.");
        byte[] clave;
        try { clave = Convert.FromBase64String(b64); }
        catch (FormatException) { throw new InvalidOperationException("AGENTES_CLAVE_SERVICIO no es base64 válido."); }
        if (clave.Length < 32) throw new InvalidOperationException("AGENTES_CLAVE_SERVICIO debe ser de 32 bytes.");
        return new TokenServicio(clave);
    }

    public string Crear(string svc, int? usr, int? agt, string acc, int vigenciaSegundos = VigenciaPorDefectoSegundos)
    {
        var rec = new ReclamosServicio(svc, usr, agt, acc, _reloj().ToUnixTimeSeconds() + vigenciaSegundos, Guid.NewGuid().ToString("N"));
        return Firmar(rec);
    }

    public string Firmar(ReclamosServicio rec)
    {
        var json = Codificacion.Base64Url(JsonSerializer.SerializeToUtf8Bytes(rec, Opciones));
        var mac = HMACSHA256.HashData(_clave, Encoding.ASCII.GetBytes(json));
        return json + "." + Codificacion.Base64Url(mac);
    }

    /// <summary>Valida firma (tiempo constante), vencimiento, servicio, acción y que el jti no se repita.</summary>
    public ResultadoToken Validar(string? token, string svcEsperado, string? accionEsperada = null)
    {
        if (string.IsNullOrEmpty(token) || token.Length > 2048) return ResultadoToken.Falla("formato");
        var punto = token.IndexOf('.');
        if (punto <= 0 || punto == token.Length - 1 || token.IndexOf('.', punto + 1) >= 0) return ResultadoToken.Falla("formato");
        var cuerpo = token[..punto];
        byte[] firma;
        try { firma = Codificacion.DeBase64Url(token[(punto + 1)..]); }
        catch (FormatException) { return ResultadoToken.Falla("formato"); }
        var esperada = HMACSHA256.HashData(_clave, Encoding.ASCII.GetBytes(cuerpo));
        if (!CryptographicOperations.FixedTimeEquals(firma, esperada)) return ResultadoToken.Falla("firma");

        ReclamosServicio? rec;
        try { rec = JsonSerializer.Deserialize<ReclamosServicio>(Codificacion.DeBase64Url(cuerpo), Opciones); }
        catch (Exception e) when (e is JsonException or FormatException) { return ResultadoToken.Falla("formato"); }
        if (rec is null || string.IsNullOrEmpty(rec.Jti) || string.IsNullOrEmpty(rec.Svc) || string.IsNullOrEmpty(rec.Acc))
            return ResultadoToken.Falla("formato");

        var ahora = _reloj().ToUnixTimeSeconds();
        if (rec.Exp <= ahora) return ResultadoToken.Falla("vencido");
        if (rec.Exp > ahora + VigenciaMaximaSegundos) return ResultadoToken.Falla("vigencia_excesiva");
        if (!string.Equals(rec.Svc, svcEsperado, StringComparison.Ordinal)) return ResultadoToken.Falla("servicio");
        if (accionEsperada is not null && !string.Equals(rec.Acc, accionEsperada, StringComparison.Ordinal))
            return ResultadoToken.Falla("accion");

        Limpiar(ahora);
        if (!_vistos.TryAdd(rec.Jti, rec.Exp)) return ResultadoToken.Falla("repetido");
        return new ResultadoToken(true, null, rec);
    }

    void Limpiar(long ahora)
    {
        if (ahora - Interlocked.Read(ref _ultimaLimpieza) < 10) return;
        Interlocked.Exchange(ref _ultimaLimpieza, ahora);
        foreach (var kv in _vistos) if (kv.Value <= ahora) _vistos.TryRemove(kv.Key, out _);
    }

    static readonly JsonSerializerOptions Opciones = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };
}
