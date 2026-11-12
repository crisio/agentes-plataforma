using System.Security.Cryptography;
using System.Text;

namespace Agentes.Comun;

/// <summary>Compartición de secretos de Shamir sobre GF(256) (polinomio de AES, 0x11B), byte por byte.</summary>
public static class Shamir
{
    static readonly byte[] Exp = new byte[510];
    static readonly byte[] Log = new byte[256];

    static Shamir()
    {
        var x = 1;
        for (var i = 0; i < 255; i++)
        {
            Exp[i] = (byte)x;
            Log[x] = (byte)i;
            var t = x << 1;                 // x * 2
            if ((t & 0x100) != 0) t ^= 0x11B;
            x = (t ^ x) & 0xFF;             // x * 3 (3 es generador del grupo multiplicativo)
        }
        for (var i = 255; i < 510; i++) Exp[i] = Exp[i - 255];
    }

    static byte Mul(byte a, byte b) => a == 0 || b == 0 ? (byte)0 : Exp[Log[a] + Log[b]];
    static byte Div(byte a, byte b)
    {
        if (b == 0) throw new DivideByZeroException();
        return a == 0 ? (byte)0 : Exp[Log[a] + 255 - Log[b]];
    }

    /// <summary>Parte el secreto en <paramref name="partes"/> pedazos; bastan <paramref name="umbral"/> para reconstruirlo. Cada parte: [x] || y.</summary>
    public static byte[][] Dividir(ReadOnlySpan<byte> secreto, int umbral, int partes)
    {
        if (umbral < 1 || partes < umbral || partes > 255) throw new ArgumentException("Umbral o cantidad de partes no válidos.");
        var res = new byte[partes][];
        for (var i = 0; i < partes; i++) { res[i] = new byte[secreto.Length + 1]; res[i][0] = (byte)(i + 1); }
        var coef = new byte[umbral];
        try
        {
            for (var j = 0; j < secreto.Length; j++)
            {
                RandomNumberGenerator.Fill(coef);
                coef[0] = secreto[j];
                for (var i = 0; i < partes; i++)
                {
                    var x = res[i][0];
                    byte y = 0;
                    for (var c = umbral - 1; c >= 0; c--) y = (byte)(Mul(y, x) ^ coef[c]); // Horner
                    res[i][j + 1] = y;
                }
            }
        }
        finally { CryptographicOperations.ZeroMemory(coef); }
        return res;
    }

    /// <summary>Reconstruye por interpolación de Lagrange en x = 0. Con menos partes que el umbral devuelve un valor sin sentido.</summary>
    public static byte[] Combinar(IReadOnlyList<byte[]> partes)
    {
        if (partes.Count == 0) throw new ArgumentException("No hay partes.");
        var largo = partes[0].Length;
        if (largo < 2) throw new ArgumentException("Parte no válida.");
        var xs = new byte[partes.Count];
        for (var i = 0; i < partes.Count; i++)
        {
            if (partes[i].Length != largo) throw new ArgumentException("Las partes no son del mismo tamaño.");
            xs[i] = partes[i][0];
            if (xs[i] == 0) throw new ArgumentException("Parte no válida.");
            for (var k = 0; k < i; k++) if (xs[k] == xs[i]) throw new ArgumentException("Parte repetida.");
        }
        var peso = new byte[partes.Count];
        for (var i = 0; i < partes.Count; i++)
        {
            byte p = 1;
            for (var j = 0; j < partes.Count; j++)
                if (j != i) p = Mul(p, Div(xs[j], (byte)(xs[i] ^ xs[j])));
            peso[i] = p;
        }
        var secreto = new byte[largo - 1];
        for (var b = 0; b < secreto.Length; b++)
        {
            byte acc = 0;
            for (var i = 0; i < partes.Count; i++) acc ^= Mul(partes[i][b + 1], peso[i]);
            secreto[b] = acc;
        }
        return secreto;
    }
}

/// <summary>Cifrado por sobres con AES-256-GCM: cada versión lleva su propia llave de datos, envuelta por la maestra.</summary>
public static class Sobre
{
    const int Nonce = 12, Tag = 16;

    public static byte[] AadDe(string nombre, int version) => Encoding.UTF8.GetBytes($"{nombre}|{version}");

    /// <summary>nonce(12) || cifrado || tag(16).</summary>
    public static byte[] Cifrar(byte[] llave, ReadOnlySpan<byte> claro, ReadOnlySpan<byte> aad)
    {
        var res = new byte[Nonce + claro.Length + Tag];
        RandomNumberGenerator.Fill(res.AsSpan(0, Nonce));
        using var aes = new AesGcm(llave, Tag);
        aes.Encrypt(res.AsSpan(0, Nonce), claro, res.AsSpan(Nonce, claro.Length), res.AsSpan(Nonce + claro.Length, Tag), aad);
        return res;
    }

    /// <summary>Lanza <see cref="CryptographicException"/> si la llave, la AAD o los datos no coinciden.</summary>
    public static byte[] Descifrar(byte[] llave, ReadOnlySpan<byte> datos, ReadOnlySpan<byte> aad)
    {
        if (datos.Length < Nonce + Tag) throw new CryptographicException("Datos cifrados demasiado cortos.");
        var claro = new byte[datos.Length - Nonce - Tag];
        using var aes = new AesGcm(llave, Tag);
        aes.Decrypt(datos[..Nonce], datos.Slice(Nonce, claro.Length), datos.Slice(Nonce + claro.Length, Tag), claro, aad);
        return claro;
    }

    /// <summary>Devuelve (ValorCifrado, LlaveEnvuelta). AAD = «nombre|version» en ambos.</summary>
    public static (byte[] ValorCifrado, byte[] LlaveEnvuelta) Sellar(byte[] maestra, string nombre, int version, string valor)
    {
        var aad = AadDe(nombre, version);
        var llaveDatos = RandomNumberGenerator.GetBytes(32);
        var claro = Encoding.UTF8.GetBytes(valor);
        try { return (Cifrar(llaveDatos, claro, aad), Cifrar(maestra, llaveDatos, aad)); }
        finally { CryptographicOperations.ZeroMemory(llaveDatos); CryptographicOperations.ZeroMemory(claro); }
    }

    public static string Abrir(byte[] maestra, string nombre, int version, byte[] valorCifrado, byte[] llaveEnvuelta)
    {
        var aad = AadDe(nombre, version);
        var llaveDatos = Descifrar(maestra, llaveEnvuelta, aad);
        byte[]? claro = null;
        try { claro = Descifrar(llaveDatos, valorCifrado, aad); return Encoding.UTF8.GetString(claro); }
        finally { CryptographicOperations.ZeroMemory(llaveDatos); if (claro is not null) CryptographicOperations.ZeroMemory(claro); }
    }
}

/// <summary>Prueba de que una maestra reconstruida es la correcta: AES-GCM de un texto fijo.</summary>
public static class Verificador
{
    static readonly byte[] Texto = Encoding.UTF8.GetBytes("agentes-gc/verificador/v1");

    public static byte[] Crear(byte[] maestra) => Sobre.Cifrar(maestra, Texto, ReadOnlySpan<byte>.Empty);

    public static bool Comprobar(byte[] maestra, byte[] verificador)
    {
        try
        {
            var claro = Sobre.Descifrar(maestra, verificador, ReadOnlySpan<byte>.Empty);
            var ok = CryptographicOperations.FixedTimeEquals(claro, Texto);
            CryptographicOperations.ZeroMemory(claro);
            return ok;
        }
        catch (CryptographicException) { return false; }
    }
}
