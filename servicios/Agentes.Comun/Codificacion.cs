using System.Security.Cryptography;
using System.Text;

namespace Agentes.Comun;

public static class Codificacion
{
    public static string Base64Url(ReadOnlySpan<byte> datos) =>
        Convert.ToBase64String(datos).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public static byte[] DeBase64Url(string texto)
    {
        var s = texto.Replace('-', '+').Replace('_', '/');
        s = s.PadRight(s.Length + (4 - s.Length % 4) % 4, '=');
        return Convert.FromBase64String(s);
    }

    /// <summary>SHA-256 en hexadecimal minúscula (64 caracteres), como lo guarda el esquema.</summary>
    public static string Sha256Hex(string texto) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(texto))).ToLowerInvariant();
}
