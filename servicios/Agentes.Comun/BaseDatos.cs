using System.Text.RegularExpressions;
using Microsoft.Data.SqlClient;

namespace Agentes.Comun;

/// <summary>Conexión a la base de datos configurada y esquema configurable. Todo el SQL del código usa <see cref="E"/>, nunca «agentes.» fijo.</summary>
public sealed partial class BaseDatos
{
    readonly string _cadena;

    /// <summary>Nombre del esquema, ya validado.</summary>
    public string Esquema { get; }

    /// <summary>Esquema listo para concatenar al SQL, entre corchetes: [agentes].</summary>
    public string E => $"[{Esquema}]";

    public BaseDatos(string cadenaConexion, string esquema)
    {
        if (!EsquemaValido().IsMatch(esquema)) throw new ArgumentException("Nombre de esquema no válido.", nameof(esquema));
        _cadena = cadenaConexion;
        Esquema = esquema;
    }

    public static BaseDatos DesdeConfiguracion()
    {
        var cb = new SqlConnectionStringBuilder
        {
            DataSource = $"{Configuracion.Requerir("AGENTES_SQL_HOST")},{Configuracion.Requerir("AGENTES_SQL_PUERTO")}",
            InitialCatalog = Configuracion.Requerir("AGENTES_SQL_BASE"),
            UserID = Configuracion.Requerir("AGENTES_SQL_USUARIO"),
            Password = Configuracion.Requerir("AGENTES_SQL_CLAVE"),
            Encrypt = SqlConnectionEncryptOption.Mandatory,
            TrustServerCertificate = true,
            ConnectTimeout = 15,
            ApplicationName = "AgentesGC",
            Pooling = true,
            MaxPoolSize = 20,
        };
        return new BaseDatos(cb.ConnectionString, Configuracion.Obtener("AGENTES_SQL_ESQUEMA") ?? "agentes");
    }

    public async Task<SqlConnection> AbrirAsync(CancellationToken ct = default)
    {
        var c = new SqlConnection(_cadena);
        try { await c.OpenAsync(ct); return c; }
        catch { await c.DisposeAsync(); throw; }
    }

    [GeneratedRegex("^[A-Za-z_][A-Za-z0-9_]{0,40}$")]
    private static partial Regex EsquemaValido();
}
