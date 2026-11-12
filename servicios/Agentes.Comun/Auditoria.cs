using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Dapper;

namespace Agentes.Comun;

public sealed record EventoRegistrado(long Id, string Hash);

/// <summary>
/// Escribe en la cadena de auditoría. Toda escritura pasa por `sp_RegistrarEvento`; nunca hay un INSERT directo.
/// El detalle se enmascara: las llaves que parecen secretos se reemplazan por «***».
/// </summary>
public sealed partial class Auditoria(BaseDatos bd)
{
    public async Task<EventoRegistrado> RegistrarAsync(string canal, string tipo, string resultado, int? usuarioId = null,
        int? agenteId = null, string? objeto = null, object? detalle = null, string? ip = null, CancellationToken ct = default)
    {
        await using var c = await bd.AbrirAsync(ct);
        return await c.QuerySingleAsync<EventoRegistrado>(new CommandDefinition(
            $"EXEC {bd.E}.sp_RegistrarEvento @UsuarioId, @AgenteId, @Canal, @Tipo, @Objeto, @Detalle, @Resultado, @Ip",
            new
            {
                UsuarioId = usuarioId,
                AgenteId = agenteId,
                Canal = canal,
                Tipo = tipo,
                Objeto = Recortar(objeto, 200),
                Detalle = EnmascararDetalle(detalle),
                Resultado = resultado,
                Ip = Recortar(ip, 45),
            }, cancellationToken: ct));
    }

    static string? Recortar(string? s, int max) => s is null ? null : s.Length <= max ? s : s[..max];

    /// <summary>Serializa a JSON y enmascara valores de llaves sensibles. Si no cabe en 2000 caracteres, lo reemplaza por un aviso.</summary>
    public static string? EnmascararDetalle(object? detalle)
    {
        if (detalle is null) return null;
        var nodo = JsonSerializer.SerializeToNode(detalle, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        Enmascarar(nodo);
        var s = nodo?.ToJsonString() ?? "null";
        return s.Length <= 2000 ? s : "{\"truncado\":true}";
    }

    static void Enmascarar(JsonNode? n)
    {
        switch (n)
        {
            case JsonObject o:
                foreach (var kv in o.ToList())
                {
                    if (Sensible().IsMatch(kv.Key)) o[kv.Key] = "***";
                    else Enmascarar(kv.Value);
                }
                break;
            case JsonArray a:
                foreach (var e in a) Enmascarar(e);
                break;
        }
    }

    [GeneratedRegex("clave|secret|valor|token|codigo|password|contrasena|partes?$|llave|pimienta|hash", RegexOptions.IgnoreCase)]
    private static partial Regex Sensible();
}
