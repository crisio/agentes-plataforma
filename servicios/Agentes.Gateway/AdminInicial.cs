using Agentes.Comun;
using Dapper;
using Microsoft.Data.SqlClient;

namespace Agentes.Gateway;

/// <summary>`dotnet run -- --crear-admin correo "Nombre"`: arranque inicial, sin clave (la crea con el código al entrar).</summary>
public static class AdminInicial
{
    public static async Task<int> CrearAsync(BaseDatos bd, Auditoria aud, string correoCrudo, string nombre)
    {
        var correo = EndpointsAcceso.NormalizarCorreo(correoCrudo);
        if (correo is null) { Console.Error.WriteLine("Correo no válido."); return 2; }
        if (string.IsNullOrWhiteSpace(nombre) || nombre.Length > 120) { Console.Error.WriteLine("Nombre no válido."); return 2; }

        await using var c = await bd.AbrirAsync();
        await using var tx = (SqlTransaction)await c.BeginTransactionAsync();
        var id = await c.ExecuteScalarAsync<int?>(new CommandDefinition(
            $"SELECT Id FROM {bd.E}.Usuario WITH (UPDLOCK, HOLDLOCK) WHERE Correo = @correo", new { correo }, tx));
        var nuevo = id is null;
        if (nuevo)
            id = await c.ExecuteScalarAsync<int>(new CommandDefinition(
                $"INSERT {bd.E}.Usuario (Correo, Nombre) OUTPUT inserted.Id VALUES (@correo, @nombre)", new { correo, nombre = nombre.Trim() }, tx));
        foreach (var rol in ReglaRoles.RolesPlataforma)
            await c.ExecuteAsync(new CommandDefinition(
                $"IF NOT EXISTS (SELECT 1 FROM {bd.E}.RolPlataforma WHERE UsuarioId = @id AND Rol = @rol) INSERT {bd.E}.RolPlataforma (UsuarioId, Rol) VALUES (@id, @rol)",
                new { id, rol }, tx));
        await c.ExecuteAsync(new CommandDefinition($"""
            MERGE {bd.E}.PermisoAgente AS d
            USING (SELECT @id AS UsuarioId, Id AS AgenteId FROM {bd.E}.Agente) AS o ON d.UsuarioId = o.UsuarioId AND d.AgenteId = o.AgenteId
            WHEN MATCHED THEN UPDATE SET Rol = 'aprobador_critico'
            WHEN NOT MATCHED THEN INSERT (UsuarioId, AgenteId, Rol) VALUES (o.UsuarioId, o.AgenteId, 'aprobador_critico');
            """, new { id }, tx));
        await tx.CommitAsync();

        await aud.RegistrarAsync("sistema", nuevo ? "usuario_creado" : "usuario_modificado", "ok", id, null, correo,
            new { origen = "crear-admin", roles = ReglaRoles.RolesPlataforma });
        Console.WriteLine(nuevo
            ? $"Administrador creado: {correo}. Entra con un código y crea su clave la primera vez."
            : $"El usuario {correo} ya existía: se completaron sus roles y permisos.");
        return 0;
    }
}
