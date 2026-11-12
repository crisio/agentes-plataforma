using System.Security.Cryptography;
using Agentes.Comun;
using Dapper;

namespace Agentes.Boveda;

public sealed class BovedaSelladaException : Exception
{
    public BovedaSelladaException() : base("La bóveda está sellada.") { }
}

public enum ResultadoParte { Aceptada, Abierta, Rechazada, Invalida, Repetida, YaAbierta, NoInicializada }

public sealed record FotoBoveda(bool Inicializada, bool Sellada, int Umbral, int Partes, int PartesRecibidas);

sealed record FilaLlave(byte[] Verificador, byte Umbral, byte Partes);

/// <summary>
/// Estado en memoria de la bóveda. La maestra (32 bytes) vive solo aquí; al sellar se borra.
/// Todo acceso a la maestra pasa por <see cref="Usar{T}"/>, que la presta bajo candado.
/// </summary>
public sealed class EstadoBoveda
{
    readonly object _l = new();
    byte[]? _maestra;
    byte[]? _verificador;
    int _umbral, _partes;
    bool _inicializada;
    readonly List<byte[]> _recibidas = [];

    /// <summary>Si existe `BovedaLlave` es que ya se inicializó. Arranca siempre sellada.</summary>
    public async Task CargarAsync(BaseDatos bd, CancellationToken ct = default)
    {
        await using var c = await bd.AbrirAsync(ct);
        var fila = await c.QuerySingleOrDefaultAsync<FilaLlave>(new CommandDefinition(
            $"SELECT Verificador, Umbral, Partes FROM {bd.E}.BovedaLlave WHERE Id = 1", cancellationToken: ct));
        lock (_l)
        {
            if (fila is null) { _inicializada = false; return; }
            _inicializada = true; _verificador = fila.Verificador; _umbral = fila.Umbral; _partes = fila.Partes;
        }
    }

    public void MarcarInicializada(int umbral, int partes, byte[] verificador, byte[] maestra)
    {
        lock (_l)
        {
            _inicializada = true; _umbral = umbral; _partes = partes; _verificador = verificador;
            Borrar(ref _maestra);
            _maestra = (byte[])maestra.Clone(); // queda abierta
            LimpiarRecibidas();
        }
    }

    public FotoBoveda Foto()
    {
        lock (_l) return new FotoBoveda(_inicializada, _maestra is null, _umbral, _partes, _recibidas.Count);
    }

    public bool Inicializada { get { lock (_l) return _inicializada; } }

    /// <summary>Presta la maestra a <paramref name="f"/>. Lanza <see cref="BovedaSelladaException"/> si está sellada.</summary>
    public T Usar<T>(Func<byte[], T> f)
    {
        lock (_l)
        {
            if (_maestra is null) throw new BovedaSelladaException();
            return f(_maestra);
        }
    }

    /// <summary>Suma una parte. Al llegar al umbral reconstruye y verifica; si falla, descarta todas las partes.</summary>
    public (ResultadoParte Resultado, int Recibidas) AgregarParte(byte[] parte)
    {
        lock (_l)
        {
            if (!_inicializada) return (ResultadoParte.NoInicializada, 0);
            if (_maestra is not null) return (ResultadoParte.YaAbierta, 0);
            if (parte.Length != 33 || parte[0] == 0) return (ResultadoParte.Invalida, _recibidas.Count);
            if (_recibidas.Any(p => p[0] == parte[0])) return (ResultadoParte.Repetida, _recibidas.Count);
            _recibidas.Add(parte);
            if (_recibidas.Count < _umbral) return (ResultadoParte.Aceptada, _recibidas.Count);

            byte[]? candidata = null;
            try
            {
                candidata = Shamir.Combinar(_recibidas);
                if (candidata.Length == 32 && Verificador.Comprobar(candidata, _verificador!))
                {
                    _maestra = candidata; candidata = null;
                    LimpiarRecibidas();
                    return (ResultadoParte.Abierta, 0);
                }
                LimpiarRecibidas();
                return (ResultadoParte.Rechazada, 0);
            }
            finally { if (candidata is not null) CryptographicOperations.ZeroMemory(candidata); }
        }
    }

    /// <summary>Borra la maestra y las partes recibidas. Devuelve false si ya estaba sellada.</summary>
    public bool Sellar()
    {
        lock (_l)
        {
            var estabaAbierta = _maestra is not null;
            Borrar(ref _maestra);
            LimpiarRecibidas();
            return estabaAbierta;
        }
    }

    void LimpiarRecibidas()
    {
        foreach (var p in _recibidas) CryptographicOperations.ZeroMemory(p);
        _recibidas.Clear();
    }

    static void Borrar(ref byte[]? b)
    {
        if (b is not null) CryptographicOperations.ZeroMemory(b);
        b = null;
    }
}
