using System.Security.Cryptography;
using System.Text;
using Agentes.Boveda;
using Agentes.Comun;

namespace Agentes.Pruebas;

public class ShamirPruebas
{
    static IEnumerable<int[]> Combinaciones(int n, int k)
    {
        var idx = Enumerable.Range(0, k).ToArray();
        while (true)
        {
            yield return (int[])idx.Clone();
            var i = k - 1;
            while (i >= 0 && idx[i] == n - k + i) i--;
            if (i < 0) yield break;
            idx[i]++;
            for (var j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
        }
    }

    [Theory]
    [InlineData(2, 3)]
    [InlineData(3, 5)]
    [InlineData(5, 7)]
    public void ReconstruyeConCualquierSubconjuntoDeKPartes(int k, int n)
    {
        var secreto = RandomNumberGenerator.GetBytes(32);
        var partes = Shamir.Dividir(secreto, k, n);
        Assert.Equal(n, partes.Length);
        Assert.All(partes, p => Assert.Equal(33, p.Length));
        var probadas = 0;
        foreach (var c in Combinaciones(n, k))
        {
            var recuperado = Shamir.Combinar(c.Select(i => partes[i]).ToList());
            Assert.Equal(secreto, recuperado);
            probadas++;
        }
        Assert.True(probadas > 0);
    }

    [Theory]
    [InlineData(2, 3)]
    [InlineData(3, 5)]
    [InlineData(5, 7)]
    public void FallaConMenosDeKPartes(int k, int n)
    {
        var secreto = RandomNumberGenerator.GetBytes(32);
        var partes = Shamir.Dividir(secreto, k, n);
        foreach (var c in Combinaciones(n, k - 1))
            Assert.NotEqual(secreto, Shamir.Combinar(c.Select(i => partes[i]).ToList()));
    }

    [Fact]
    public void UnaDeUnaFunciona()
    {
        var secreto = RandomNumberGenerator.GetBytes(32);
        var partes = Shamir.Dividir(secreto, 1, 1);
        Assert.Equal(secreto, Shamir.Combinar(partes));
    }

    [Fact]
    public void PartesRepetidasOMalFormadasSeRechazan()
    {
        var partes = Shamir.Dividir(RandomNumberGenerator.GetBytes(32), 2, 3);
        Assert.Throws<ArgumentException>(() => Shamir.Combinar([partes[0], partes[0]]));
        Assert.Throws<ArgumentException>(() => Shamir.Combinar([partes[0], partes[1][..10]]));
        Assert.Throws<ArgumentException>(() => Shamir.Dividir(new byte[32], 4, 3));
    }
}

public class SobrePruebas
{
    [Fact]
    public void IdaYVuelta()
    {
        var maestra = RandomNumberGenerator.GetBytes(32);
        var (v, l) = Sobre.Sellar(maestra, "sql/erp-hn/lectura", 1, "clave-ñandú-€");
        Assert.Equal("clave-ñandú-€", Sobre.Abrir(maestra, "sql/erp-hn/lectura", 1, v, l));
        Assert.True(l.Length <= 200);
    }

    [Fact]
    public void ElValorCifradoNoContieneElTextoClaro()
    {
        var maestra = RandomNumberGenerator.GetBytes(32);
        var (v, _) = Sobre.Sellar(maestra, "a", 1, "textoSecretoDeLaPrueba");
        Assert.DoesNotContain("textoSecretoDeLaPrueba", Encoding.UTF8.GetString(v));
    }

    [Fact]
    public void AadEquivocadoFalla()
    {
        var maestra = RandomNumberGenerator.GetBytes(32);
        var (v, l) = Sobre.Sellar(maestra, "secreto-a", 1, "valor");
        Assert.ThrowsAny<CryptographicException>(() => Sobre.Abrir(maestra, "secreto-b", 1, v, l));
        Assert.ThrowsAny<CryptographicException>(() => Sobre.Abrir(maestra, "secreto-a", 2, v, l));
    }

    [Fact]
    public void MaestraEquivocadaOCifradoAlteradoFalla()
    {
        var maestra = RandomNumberGenerator.GetBytes(32);
        var (v, l) = Sobre.Sellar(maestra, "s", 1, "valor");
        Assert.ThrowsAny<CryptographicException>(() => Sobre.Abrir(RandomNumberGenerator.GetBytes(32), "s", 1, v, l));
        v[^1] ^= 1;
        Assert.ThrowsAny<CryptographicException>(() => Sobre.Abrir(maestra, "s", 1, v, l));
    }

    [Fact]
    public void VerificadorDistingueLaMaestra()
    {
        var m = RandomNumberGenerator.GetBytes(32);
        var ver = Verificador.Crear(m);
        Assert.True(Verificador.Comprobar(m, ver));
        Assert.False(Verificador.Comprobar(RandomNumberGenerator.GetBytes(32), ver));
        Assert.True(ver.Length <= 200);
    }
}

public class TokenServicioPruebas
{
    static readonly byte[] Clave = RandomNumberGenerator.GetBytes(32);
    DateTimeOffset _ahora = new(2026, 11, 10, 12, 0, 0, TimeSpan.Zero);
    TokenServicio Nuevo(byte[]? clave = null) => new(clave ?? Clave, () => _ahora);

    [Fact]
    public void TokenValidoPasaUnaSolaVez()
    {
        var t = Nuevo();
        var token = t.Crear("gateway", 7, null, "abrir");
        var r = t.Validar(token, "gateway", "abrir");
        Assert.True(r.Ok);
        Assert.Equal(7, r.Reclamos!.Usr);
        var otra = t.Validar(token, "gateway", "abrir");
        Assert.False(otra.Ok);
        Assert.Equal("repetido", otra.Error);
    }

    [Fact]
    public void TokenVencidoSeRechaza()
    {
        var t = Nuevo();
        var token = t.Crear("gateway", 1, null, "listar", 30);
        _ahora = _ahora.AddSeconds(31);
        Assert.Equal("vencido", t.Validar(token, "gateway").Error);
    }

    [Fact]
    public void FirmaMalaSeRechaza()
    {
        var t = Nuevo();
        var token = t.Crear("gateway", 1, null, "listar");
        var ajeno = Nuevo(RandomNumberGenerator.GetBytes(32)).Crear("gateway", 1, null, "listar");
        Assert.Equal("firma", t.Validar(ajeno, "gateway").Error);
        var alterado = token[..^2] + (token[^2] == 'A' ? "B" : "A") + token[^1];
        Assert.False(t.Validar(alterado, "gateway").Ok);
        var partes = token.Split('.');
        var cuerpoOtro = Codificacion.Base64Url(Encoding.UTF8.GetBytes("{\"svc\":\"ejecutor\",\"acc\":\"entregar\",\"exp\":9999999999,\"jti\":\"x\"}"));
        Assert.False(t.Validar(cuerpoOtro + "." + partes[1], "ejecutor").Ok);
        Assert.False(t.Validar("basura", "gateway").Ok);
        Assert.False(t.Validar(null, "gateway").Ok);
    }

    [Fact]
    public void ServicioEquivocadoSeRechaza()
    {
        var t = Nuevo();
        Assert.Equal("servicio", t.Validar(t.Crear("gateway", 1, null, "entregar"), "ejecutor", "entregar").Error);
        Assert.Equal("servicio", t.Validar(t.Crear("ejecutor", 1, 2, "entregar"), "gateway", "entregar").Error);
    }

    [Fact]
    public void AccionEquivocadaSeRechaza()
    {
        var t = Nuevo();
        Assert.Equal("accion", t.Validar(t.Crear("gateway", 1, null, "listar"), "gateway", "crear").Error);
    }

    [Fact]
    public void VigenciaMayorA60SegundosSeRechaza()
    {
        var t = Nuevo();
        Assert.Equal("vigencia_excesiva", t.Validar(t.Crear("gateway", 1, null, "listar", 120), "gateway").Error);
    }

    [Fact]
    public void LaClaveCortaNoSirve() => Assert.Throws<ArgumentException>(() => new TokenServicio(new byte[16]));
}

public class VariosComunPruebas
{
    [Fact]
    public void LectorEnvLocal()
    {
        var d = Configuracion.Parsear("# comentario\r\nA=1\r\n\r\nB = \"dos palabras\"\nC='x'\nVACIA=\nSIN_IGUAL\nD=a=b\n");
        Assert.Equal("1", d["A"]);
        Assert.Equal("dos palabras", d["B"]);
        Assert.Equal("x", d["C"]);
        Assert.Equal("", d["VACIA"]);
        Assert.Equal("a=b", d["D"]);
        Assert.False(d.ContainsKey("SIN_IGUAL"));
    }

    [Fact]
    public void ElDetalleDeAuditoriaEnmascaraSecretos()
    {
        var json = Auditoria.EnmascararDetalle(new { version = 2, valor = "mi-clave", token = "t", anidado = new { codigo = "123456", ok = 1 }, partes = new[] { "x" } })!;
        Assert.DoesNotContain("mi-clave", json);
        Assert.DoesNotContain("123456", json);
        Assert.Contains("\"version\":2", json);
        Assert.Contains("***", json);
        Assert.Null(Auditoria.EnmascararDetalle(null));
    }

    [Fact]
    public void EsquemaInvalidoSeRechaza()
    {
        Assert.Throws<ArgumentException>(() => new BaseDatos("Server=x", "agentes; DROP TABLE x"));
        Assert.Equal("[agentes_prueba]", new BaseDatos("Server=x", "agentes_prueba").E);
    }

    [Theory]
    [InlineData(null, null, 3, true)]
    [InlineData(8, 18, 8, true)]
    [InlineData(8, 18, 18, false)]
    [InlineData(8, 18, 7, false)]
    [InlineData(22, 6, 23, true)]
    [InlineData(22, 6, 5, true)]
    [InlineData(22, 6, 12, false)]
    public void VentanaHoraria(int? desde, int? hasta, int hora, bool esperado) =>
        Assert.Equal(esperado, AlmacenSecretos.HoraPermitida(desde, hasta, hora));

    [Fact]
    public void HoraDeHondurasEsUtcMenos6() =>
        Assert.Equal(18, AlmacenSecretos.HoraHonduras(new DateTimeOffset(2026, 11, 11, 0, 30, 0, TimeSpan.Zero)));

    [Theory]
    [InlineData("sql/erp-hn/lectura", true)]
    [InlineData("a", true)]
    [InlineData("", false)]
    [InlineData("../x", false)]
    [InlineData("con espacio", false)]
    public void NombresDeSecreto(string n, bool ok) => Assert.Equal(ok, AlmacenSecretos.NombreValido(n));

    [Fact]
    public void LaBovedaAbreConLasPartesYSellaBorrandoLaMaestra()
    {
        var maestra = RandomNumberGenerator.GetBytes(32);
        var partes = Shamir.Dividir(maestra, 2, 3);
        var e = new EstadoBoveda();
        e.MarcarInicializada(2, 3, Verificador.Crear(maestra), maestra);
        Assert.True(e.Sellar());
        Assert.True(e.Foto().Sellada);
        Assert.Throws<BovedaSelladaException>(() => e.Usar(m => m.Length));
        Assert.Equal(ResultadoParte.Aceptada, e.AgregarParte(partes[0]).Resultado);
        Assert.Equal(ResultadoParte.Repetida, e.AgregarParte(partes[0]).Resultado);
        Assert.Equal(ResultadoParte.Abierta, e.AgregarParte(partes[2]).Resultado);
        Assert.Equal(32, e.Usar(m => m.Length));
    }

    [Fact]
    public void UnaParteFalsaAlLlegarAlUmbralDescartaTodas()
    {
        var maestra = RandomNumberGenerator.GetBytes(32);
        var partes = Shamir.Dividir(maestra, 2, 3);
        var e = new EstadoBoveda();
        e.MarcarInicializada(2, 3, Verificador.Crear(maestra), maestra);
        e.Sellar();
        var falsa = (byte[])partes[1].Clone(); falsa[5] ^= 0x55;
        e.AgregarParte(partes[0]);
        Assert.Equal(ResultadoParte.Rechazada, e.AgregarParte(falsa).Resultado);
        Assert.Equal(0, e.Foto().PartesRecibidas);
        Assert.True(e.Foto().Sellada);
    }
}
