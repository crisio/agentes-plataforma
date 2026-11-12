using System.Text.RegularExpressions;
using Agentes.Comun;
using Dapper;
using Microsoft.Data.SqlClient;

namespace Agentes.Boveda;

public sealed record PoliticaEntrada(string Agente, int TtlSegundos, int? HoraDesde, int? HoraHasta);
public sealed record PoliticaSalida(string Agente, int TtlSegundos, int? HoraDesde, int? HoraHasta);
public sealed record SecretoMeta(string Nombre, string Tipo, string? Descripcion, int Version, bool Revocado, IReadOnlyList<PoliticaSalida> Politicas);
public sealed record Valor(string ValorSecreto, DateTime VenceUtc);

public enum Resultado { Ok, NoExiste, YaExiste, Revocado, Invalido }

/// <summary>Acceso a datos de secretos, versiones y políticas. Nunca registra ni devuelve valores en claro salvo en <see cref="LeerVersionAsync"/>.</summary>
public sealed partial class AlmacenSecretos(BaseDatos bd)
{
    public static readonly string[] Tipos = ["password", "api_key", "connection_string", "certificado", "token"];
    public const int MaxBytesValor = 64 * 1024;

    public static bool NombreValido(string? n) => n is not null && NombreRx().IsMatch(n);

    [GeneratedRegex("^[A-Za-z0-9][A-Za-z0-9_./:-]{0,119}$")]
    private static partial Regex NombreRx();

    sealed record FilaSecreto(int Id, string Nombre, string Tipo, string? Descripcion, int VersionActual, DateTime? RevocadoUtc);
    sealed record FilaPol(int Ttl, byte? Desde, byte? Hasta);
    sealed record FilaVer(byte[] V, byte[] L);
    sealed record FilaPolitica(int SecretoId, string Agente, int TtlSegundos, byte? HoraDesde, byte? HoraHasta);

    public async Task<IReadOnlyList<SecretoMeta>> ListarAsync(CancellationToken ct)
    {
        await using var c = await bd.AbrirAsync(ct);
        var secretos = (await c.QueryAsync<FilaSecreto>(new CommandDefinition(
            $"SELECT Id, Nombre, Tipo, Descripcion, VersionActual, RevocadoUtc FROM {bd.E}.Secreto ORDER BY Nombre", cancellationToken: ct))).ToList();
        var politicas = (await c.QueryAsync<FilaPolitica>(new CommandDefinition(
            $"SELECT p.SecretoId, a.Clave AS Agente, p.TtlSegundos, p.HoraDesde, p.HoraHasta FROM {bd.E}.PoliticaSecreto p JOIN {bd.E}.Agente a ON a.Id = p.AgenteId ORDER BY a.Clave",
            cancellationToken: ct))).ToLookup(p => p.SecretoId);
        return secretos.Select(s => new SecretoMeta(s.Nombre, s.Tipo, s.Descripcion, s.VersionActual, s.RevocadoUtc is not null,
            politicas[s.Id].Select(p => new PoliticaSalida(p.Agente, p.TtlSegundos, p.HoraDesde, p.HoraHasta)).ToList())).ToList();
    }

    /// <summary>Crea el secreto con su versión 1. Devuelve YaExiste si el nombre está tomado.</summary>
    public async Task<Resultado> CrearAsync(string nombre, string tipo, string? descripcion, byte[] valorCifrado, byte[] llaveEnvuelta, int usuarioId, CancellationToken ct)
    {
        await using var c = await bd.AbrirAsync(ct);
        await using var tx = (SqlTransaction)await c.BeginTransactionAsync(ct);
        var existe = await c.ExecuteScalarAsync<int>(new CommandDefinition(
            $"SELECT COUNT(1) FROM {bd.E}.Secreto WITH (UPDLOCK, HOLDLOCK) WHERE Nombre = @nombre", new { nombre }, tx, cancellationToken: ct));
        if (existe > 0) return Resultado.YaExiste;
        var id = await c.ExecuteScalarAsync<int>(new CommandDefinition(
            $"INSERT {bd.E}.Secreto (Nombre, Tipo, Descripcion, VersionActual, CreadoPor) OUTPUT inserted.Id VALUES (@nombre, @tipo, @descripcion, 1, @usuarioId)",
            new { nombre, tipo, descripcion, usuarioId }, tx, cancellationToken: ct));
        await c.ExecuteAsync(new CommandDefinition(
            $"INSERT {bd.E}.SecretoVersion (SecretoId, Version, ValorCifrado, LlaveEnvuelta, CreadaPor) VALUES (@id, 1, @valorCifrado, @llaveEnvuelta, @usuarioId)",
            new { id, valorCifrado, llaveEnvuelta, usuarioId }, tx, cancellationToken: ct));
        await tx.CommitAsync(ct);
        return Resultado.Ok;
    }

    /// <summary>Versión que tendría la próxima rotación (para cifrar con el AAD correcto), o null si no existe / está revocado.</summary>
    public async Task<(Resultado Estado, int ProximaVersion)> ProximaVersionAsync(string nombre, CancellationToken ct)
    {
        await using var c = await bd.AbrirAsync(ct);
        var f = await c.QuerySingleOrDefaultAsync<FilaSecreto>(new CommandDefinition(
            $"SELECT Id, Nombre, Tipo, Descripcion, VersionActual, RevocadoUtc FROM {bd.E}.Secreto WHERE Nombre = @nombre", new { nombre }, cancellationToken: ct));
        if (f is null) return (Resultado.NoExiste, 0);
        if (f.RevocadoUtc is not null) return (Resultado.Revocado, 0);
        return (Resultado.Ok, f.VersionActual + 1);
    }

    /// <summary>Guarda la versión <paramref name="version"/>; falla si alguien rotó en medio (la versión ya no es la siguiente).</summary>
    public async Task<Resultado> RotarAsync(string nombre, int version, byte[] valorCifrado, byte[] llaveEnvuelta, int usuarioId, CancellationToken ct)
    {
        await using var c = await bd.AbrirAsync(ct);
        await using var tx = (SqlTransaction)await c.BeginTransactionAsync(ct);
        var f = await c.QuerySingleOrDefaultAsync<FilaSecreto>(new CommandDefinition(
            $"SELECT Id, Nombre, Tipo, Descripcion, VersionActual, RevocadoUtc FROM {bd.E}.Secreto WITH (UPDLOCK, HOLDLOCK) WHERE Nombre = @nombre",
            new { nombre }, tx, cancellationToken: ct));
        if (f is null) return Resultado.NoExiste;
        if (f.RevocadoUtc is not null) return Resultado.Revocado;
        if (f.VersionActual + 1 != version) return Resultado.Invalido;
        await c.ExecuteAsync(new CommandDefinition(
            $"INSERT {bd.E}.SecretoVersion (SecretoId, Version, ValorCifrado, LlaveEnvuelta, CreadaPor) VALUES (@id, @version, @valorCifrado, @llaveEnvuelta, @usuarioId); " +
            $"UPDATE {bd.E}.Secreto SET VersionActual = @version WHERE Id = @id",
            new { id = f.Id, version, valorCifrado, llaveEnvuelta, usuarioId }, tx, cancellationToken: ct));
        await tx.CommitAsync(ct);
        return Resultado.Ok;
    }

    /// <summary>Quita la revocación (solo para conexiones que la persona vuelve a conectar).</summary>
    public async Task ReactivarAsync(string nombre, CancellationToken ct)
    {
        await using var c = await bd.AbrirAsync(ct);
        await c.ExecuteAsync(new CommandDefinition(
            $"UPDATE {bd.E}.Secreto SET RevocadoUtc = NULL WHERE Nombre = @nombre", new { nombre }, cancellationToken: ct));
    }

    public async Task<Resultado> RevocarAsync(string nombre, CancellationToken ct)
    {
        await using var c = await bd.AbrirAsync(ct);
        var filas = await c.ExecuteAsync(new CommandDefinition(
            $"UPDATE {bd.E}.Secreto SET RevocadoUtc = SYSUTCDATETIME() WHERE Nombre = @nombre AND RevocadoUtc IS NULL", new { nombre }, cancellationToken: ct));
        if (filas > 0) return Resultado.Ok;
        var existe = await c.ExecuteScalarAsync<int>(new CommandDefinition(
            $"SELECT COUNT(1) FROM {bd.E}.Secreto WHERE Nombre = @nombre", new { nombre }, cancellationToken: ct));
        return existe > 0 ? Resultado.Revocado : Resultado.NoExiste;
    }

    /// <summary>Reemplaza las políticas del secreto. Devuelve Invalido si algún agente no existe.</summary>
    public async Task<Resultado> ReemplazarPoliticasAsync(string nombre, IReadOnlyList<PoliticaEntrada> politicas, CancellationToken ct)
    {
        await using var c = await bd.AbrirAsync(ct);
        await using var tx = (SqlTransaction)await c.BeginTransactionAsync(ct);
        var id = await c.ExecuteScalarAsync<int?>(new CommandDefinition(
            $"SELECT Id FROM {bd.E}.Secreto WITH (UPDLOCK, HOLDLOCK) WHERE Nombre = @nombre", new { nombre }, tx, cancellationToken: ct));
        if (id is null) return Resultado.NoExiste;
        var filas = new List<(int AgenteId, PoliticaEntrada P)>();
        foreach (var p in politicas)
        {
            var agenteId = await c.ExecuteScalarAsync<int?>(new CommandDefinition(
                $"SELECT Id FROM {bd.E}.Agente WHERE Clave = @agente", new { agente = p.Agente }, tx, cancellationToken: ct));
            if (agenteId is null) return Resultado.Invalido;
            filas.Add((agenteId.Value, p));
        }
        await c.ExecuteAsync(new CommandDefinition($"DELETE {bd.E}.PoliticaSecreto WHERE SecretoId = @id", new { id }, tx, cancellationToken: ct));
        foreach (var (agenteId, p) in filas)
            await c.ExecuteAsync(new CommandDefinition(
                $"INSERT {bd.E}.PoliticaSecreto (SecretoId, AgenteId, TtlSegundos, HoraDesde, HoraHasta) VALUES (@id, @agenteId, @ttl, @desde, @hasta)",
                new { id, agenteId, ttl = p.TtlSegundos, desde = (byte?)p.HoraDesde, hasta = (byte?)p.HoraHasta }, tx, cancellationToken: ct));
        await tx.CommitAsync(ct);
        return Resultado.Ok;
    }

    public sealed record DatosEntrega(int SecretoId, string Nombre, int Version, bool Revocado, int? AgenteId,
        int? TtlSegundos, byte? HoraDesde, byte? HoraHasta, bool TienePolitica);

    /// <summary>Todo lo que hace falta para decidir una entrega, sin tocar el valor.</summary>
    public async Task<DatosEntrega?> DatosEntregaAsync(string nombre, string agente, CancellationToken ct)
    {
        await using var c = await bd.AbrirAsync(ct);
        var s = await c.QuerySingleOrDefaultAsync<FilaSecreto>(new CommandDefinition(
            $"SELECT Id, Nombre, Tipo, Descripcion, VersionActual, RevocadoUtc FROM {bd.E}.Secreto WHERE Nombre = @nombre", new { nombre }, cancellationToken: ct));
        if (s is null) return null;
        var agenteId = await c.ExecuteScalarAsync<int?>(new CommandDefinition(
            $"SELECT Id FROM {bd.E}.Agente WHERE Clave = @agente", new { agente }, cancellationToken: ct));
        var pol = agenteId is null ? null : await c.QuerySingleOrDefaultAsync<FilaPol>(new CommandDefinition(
            $"SELECT TtlSegundos AS Ttl, HoraDesde AS Desde, HoraHasta AS Hasta FROM {bd.E}.PoliticaSecreto WHERE SecretoId = @id AND AgenteId = @agenteId",
            new { id = s.Id, agenteId }, cancellationToken: ct));
        return new DatosEntrega(s.Id, s.Nombre, s.VersionActual, s.RevocadoUtc is not null, agenteId,
            pol?.Ttl, pol?.Desde, pol?.Hasta, pol is not null);
    }

    public async Task<(byte[] ValorCifrado, byte[] LlaveEnvuelta)?> LeerVersionAsync(int secretoId, int version, CancellationToken ct)
    {
        await using var c = await bd.AbrirAsync(ct);
        var f = await c.QuerySingleOrDefaultAsync<FilaVer>(new CommandDefinition(
            $"SELECT ValorCifrado AS V, LlaveEnvuelta AS L FROM {bd.E}.SecretoVersion WHERE SecretoId = @secretoId AND Version = @version",
            new { secretoId, version }, cancellationToken: ct));
        return f is null ? null : (f.V, f.L);
    }

    /// <summary>
    /// Ventana horaria en hora de Honduras (UTC-6) como [desde, hasta). Si desde &gt; hasta cruza la medianoche.
    /// Sin límites = todo el día.
    /// </summary>
    public static bool HoraPermitida(int? desde, int? hasta, int horaHonduras)
    {
        if (desde is null || hasta is null) return true;
        if (desde == hasta) return true;
        return desde < hasta ? horaHonduras >= desde && horaHonduras < hasta : horaHonduras >= desde || horaHonduras < hasta;
    }

    public static int HoraHonduras(DateTimeOffset utc) => utc.UtcDateTime.AddHours(-6).Hour;
}
