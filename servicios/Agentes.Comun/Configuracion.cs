namespace Agentes.Comun;

/// <summary>
/// Lee la configuración: primero las variables de entorno reales y, si no están, el archivo `.env.local`
/// de la raíz del repo (líneas CLAVE=valor).
/// </summary>
public static class Configuracion
{
    static readonly Lazy<Dictionary<string, string>> Archivo = new(CargarEnvLocal);

    public static string? Obtener(string nombre)
    {
        var real = Environment.GetEnvironmentVariable(nombre);
        if (!string.IsNullOrEmpty(real)) return real;
        return Archivo.Value.TryGetValue(nombre, out var v) && v.Length > 0 ? v : null;
    }

    public static string Requerir(string nombre) =>
        Obtener(nombre) ?? throw new InvalidOperationException($"Falta la variable de configuración {nombre}.");

    /// <summary>Parser propio de `.env.local`: ignora vacías y comentarios, quita comillas envolventes.</summary>
    public static Dictionary<string, string> Parsear(string texto)
    {
        var d = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var cruda in texto.Split('\n'))
        {
            var linea = cruda.Trim().TrimStart('﻿');
            if (linea.Length == 0 || linea[0] == '#') continue;
            var i = linea.IndexOf('=');
            if (i <= 0) continue;
            var clave = linea[..i].Trim();
            var valor = linea[(i + 1)..].Trim();
            if (valor.Length >= 2 && ((valor[0] == '"' && valor[^1] == '"') || (valor[0] == '\'' && valor[^1] == '\'')))
                valor = valor[1..^1];
            d[clave] = valor;
        }
        return d;
    }

    static Dictionary<string, string> CargarEnvLocal()
    {
        var explicito = Environment.GetEnvironmentVariable("AGENTES_ENV_LOCAL");
        if (!string.IsNullOrEmpty(explicito) && File.Exists(explicito)) return Parsear(File.ReadAllText(explicito));
        foreach (var inicio in new[] { Directory.GetCurrentDirectory(), AppContext.BaseDirectory })
        {
            for (var dir = new DirectoryInfo(inicio); dir is not null; dir = dir.Parent)
            {
                var ruta = Path.Combine(dir.FullName, ".env.local");
                if (File.Exists(ruta)) return Parsear(File.ReadAllText(ruta));
            }
        }
        return new Dictionary<string, string>();
    }
}
