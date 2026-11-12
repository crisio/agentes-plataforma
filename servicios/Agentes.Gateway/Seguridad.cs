using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using Agentes.Comun;

namespace Agentes.Gateway;

/// <summary>Contraseña: PBKDF2-SHA256, 310 000 iteraciones, sal de 16 bytes, formato «pbkdf2$iter$sal$hash» (base64).</summary>
public static class HashClave
{
    public const int Iteraciones = 310_000;
    public const int LargoMinimo = 12;
    public const int LargoMaximo = 128;

    public static string Crear(string clave)
    {
        var sal = RandomNumberGenerator.GetBytes(16);
        var h = Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(clave), sal, Iteraciones, HashAlgorithmName.SHA256, 32);
        return $"pbkdf2${Iteraciones}${Convert.ToBase64String(sal)}${Convert.ToBase64String(h)}";
    }

    public static bool Verificar(string clave, string? guardado)
    {
        if (guardado is null) return false;
        var p = guardado.Split('$');
        if (p.Length != 4 || p[0] != "pbkdf2" || !int.TryParse(p[1], out var iter) || iter < 1000) return false;
        try
        {
            var sal = Convert.FromBase64String(p[2]);
            var esperado = Convert.FromBase64String(p[3]);
            var h = Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(clave), sal, iter, HashAlgorithmName.SHA256, esperado.Length);
            return CryptographicOperations.FixedTimeEquals(h, esperado);
        }
        catch (FormatException) { return false; }
    }

    /// <summary>Gasta el mismo tiempo que una verificación real, para no delatar si el correo existe.</summary>
    public static void Simular(string clave) =>
        Verificar(clave, DummyHash.Value);

    static class DummyHash { public static readonly string Value = Crear("simulacion-para-igualar-tiempos"); }

    public static bool Aceptable(string? clave) => clave is not null && clave.Length >= LargoMinimo && clave.Length <= LargoMaximo;
}

public enum VeredictoCodigo { Ok, Usado, Vencido, Agotado, Incorrecto }

/// <summary>Código de acceso de 6 dígitos: vence en 10 min, 5 intentos. El hash lleva pimienta y el usuario.</summary>
public static class CodigoAcceso
{
    public const int MinutosVigencia = 10;
    public const int MaxIntentos = 5;
    public const int MaxPorCorreo = 3;
    public const int VentanaMinutos = 15;
    public const int MaxPorIp = 20;

    public static string Generar() => RandomNumberGenerator.GetInt32(0, 1_000_000).ToString("D6");

    public static string Hash(string codigo, int usuarioId, string pimienta)
    {
        var mac = HMACSHA256.HashData(Encoding.UTF8.GetBytes(pimienta), Encoding.UTF8.GetBytes($"{usuarioId}:{codigo}"));
        return Convert.ToHexString(mac).ToLowerInvariant();
    }

    /// <summary>Decide sobre un código guardado. No toca la base: recibe el estado y el momento.</summary>
    public static VeredictoCodigo Evaluar(string hashGuardado, int intentosPrevios, DateTime venceUtc, DateTime? usadoUtc,
        DateTime ahoraUtc, string codigoIngresado, int usuarioId, string pimienta)
    {
        if (usadoUtc is not null) return VeredictoCodigo.Usado;
        if (ahoraUtc >= venceUtc) return VeredictoCodigo.Vencido;
        if (intentosPrevios >= MaxIntentos) return VeredictoCodigo.Agotado;
        var h = Hash(codigoIngresado, usuarioId, pimienta);
        return CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(h), Encoding.ASCII.GetBytes(hashGuardado))
            ? VeredictoCodigo.Ok : VeredictoCodigo.Incorrecto;
    }
}

/// <summary>Una misma persona no puede ser admin_plataforma y admin_boveda, salvo la excepción temporal.</summary>
public static class ReglaRoles
{
    public static readonly string[] RolesPlataforma = ["admin_plataforma", "admin_boveda", "custodio", "auditor"];
    public static readonly string[] RolesAgente = ["usuario", "aprobador", "aprobador_critico"];

    public static bool ExcepcionAdminUnico =>
        string.Equals(Configuracion.Obtener("AGENTES_EXCEPCION_ADMIN_UNICO"), "1", StringComparison.Ordinal);

    public static bool Permitido(IEnumerable<string> roles, bool excepcion)
    {
        var s = roles.ToHashSet();
        return excepcion || !(s.Contains("admin_plataforma") && s.Contains("admin_boveda"));
    }
}

/// <summary>Ventana deslizante en memoria: máximo N eventos por clave dentro de la ventana.</summary>
public sealed class Limitador(Func<DateTime>? reloj = null)
{
    readonly Func<DateTime> _reloj = reloj ?? (() => DateTime.UtcNow);
    readonly ConcurrentDictionary<string, Queue<DateTime>> _cubos = new();

    /// <summary>Registra el intento y dice si cabe. Si no cabe, no lo cuenta.</summary>
    public bool Permitir(string clave, int max, TimeSpan ventana)
    {
        var ahora = _reloj();
        var q = _cubos.GetOrAdd(clave, _ => new Queue<DateTime>());
        lock (q)
        {
            while (q.Count > 0 && ahora - q.Peek() > ventana) q.Dequeue();
            if (q.Count >= max) return false;
            q.Enqueue(ahora);
            return true;
        }
    }

    public void Podar(TimeSpan ventana)
    {
        var ahora = _reloj();
        foreach (var kv in _cubos)
            lock (kv.Value)
            {
                while (kv.Value.Count > 0 && ahora - kv.Value.Peek() > ventana) kv.Value.Dequeue();
                if (kv.Value.Count == 0) _cubos.TryRemove(kv.Key, out _);
            }
    }
}
