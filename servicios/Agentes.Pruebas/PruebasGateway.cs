using Agentes.Gateway;

namespace Agentes.Pruebas;

public class HashClavePruebas
{
    [Fact]
    public void FormatoYVerificacion()
    {
        var h = HashClave.Crear("una clave bien larga 123");
        var p = h.Split('$');
        Assert.Equal(4, p.Length);
        Assert.Equal("pbkdf2", p[0]);
        Assert.Equal("310000", p[1]);
        Assert.Equal(16, Convert.FromBase64String(p[2]).Length);
        Assert.True(HashClave.Verificar("una clave bien larga 123", h));
        Assert.False(HashClave.Verificar("una clave bien larga 124", h));
        Assert.False(HashClave.Verificar("x", null));
        Assert.False(HashClave.Verificar("x", "pbkdf2$mal"));
    }

    [Fact]
    public void LaSalHaceDistintosLosHashes() =>
        Assert.NotEqual(HashClave.Crear("misma-clave-123456"), HashClave.Crear("misma-clave-123456"));

    [Theory]
    [InlineData("12345678901", false)]
    [InlineData("123456789012", true)]
    [InlineData(null, false)]
    public void MinimoDe12Caracteres(string? clave, bool ok) => Assert.Equal(ok, HashClave.Aceptable(clave));
}

public class CodigoAccesoPruebas
{
    const string Pimienta = "pimienta-de-prueba";
    static readonly DateTime T0 = new(2026, 11, 10, 12, 0, 0, DateTimeKind.Utc);

    static VeredictoCodigo Evaluar(string codigo, int intentos = 0, DateTime? ahora = null, DateTime? usado = null, string guardado = "123456") =>
        CodigoAcceso.Evaluar(CodigoAcceso.Hash(guardado, 9, Pimienta), intentos, T0.AddMinutes(10), usado, ahora ?? T0.AddMinutes(1), codigo, 9, Pimienta);

    [Fact] public void CodigoCorrecto() => Assert.Equal(VeredictoCodigo.Ok, Evaluar("123456"));
    [Fact] public void CodigoIncorrecto() => Assert.Equal(VeredictoCodigo.Incorrecto, Evaluar("654321"));
    [Fact] public void VenceALos10Minutos()
    {
        Assert.Equal(VeredictoCodigo.Ok, Evaluar("123456", ahora: T0.AddMinutes(9).AddSeconds(59)));
        Assert.Equal(VeredictoCodigo.Vencido, Evaluar("123456", ahora: T0.AddMinutes(10)));
    }
    [Fact] public void SeAgotanLosCincoIntentos()
    {
        Assert.Equal(VeredictoCodigo.Ok, Evaluar("123456", intentos: 4));
        Assert.Equal(VeredictoCodigo.Agotado, Evaluar("123456", intentos: 5));
    }
    [Fact] public void UnCodigoUsadoNoSirve() => Assert.Equal(VeredictoCodigo.Usado, Evaluar("123456", usado: T0));

    [Fact]
    public void ElHashDependeDelUsuarioYLaPimienta()
    {
        Assert.NotEqual(CodigoAcceso.Hash("123456", 1, Pimienta), CodigoAcceso.Hash("123456", 2, Pimienta));
        Assert.NotEqual(CodigoAcceso.Hash("123456", 1, Pimienta), CodigoAcceso.Hash("123456", 1, "otra"));
        Assert.Equal(64, CodigoAcceso.Hash("123456", 1, Pimienta).Length);
    }

    [Fact]
    public void ElCodigoGeneradoTieneSeisDigitos()
    {
        for (var i = 0; i < 200; i++) Assert.Matches("^[0-9]{6}$", CodigoAcceso.Generar());
    }
}

public class ReglaRolesPruebas
{
    [Fact]
    public void AdminPlataformaYAdminBovedaNoVanJuntos()
    {
        Assert.False(ReglaRoles.Permitido(["admin_plataforma", "admin_boveda"], false));
        Assert.True(ReglaRoles.Permitido(["admin_plataforma", "auditor"], false));
        Assert.True(ReglaRoles.Permitido(["admin_boveda", "custodio"], false));
        Assert.True(ReglaRoles.Permitido([], false));
    }

    [Fact]
    public void LaExcepcionTemporalLoPermite() =>
        Assert.True(ReglaRoles.Permitido(["admin_plataforma", "admin_boveda"], true));
}

public class LimitadorPruebas
{
    [Fact]
    public void TresPorVentanaYLuegoSeLibera()
    {
        var ahora = new DateTime(2026, 11, 10, 12, 0, 0, DateTimeKind.Utc);
        var l = new Limitador(() => ahora);
        var v = TimeSpan.FromMinutes(15);
        Assert.True(l.Permitir("a", 3, v));
        Assert.True(l.Permitir("a", 3, v));
        Assert.True(l.Permitir("a", 3, v));
        Assert.False(l.Permitir("a", 3, v));
        Assert.True(l.Permitir("b", 3, v));
        ahora = ahora.AddMinutes(16);
        Assert.True(l.Permitir("a", 3, v));
    }
}
