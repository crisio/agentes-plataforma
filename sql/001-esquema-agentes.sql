/*
  Agentes GC — fase 1: esquema `agentes` en la base de datos configurada.
  Idempotente: se puede correr varias veces. Collation de la base de datos configurada: SQL_Latin1_General_CP1_CS_AS (sensible a
  mayúsculas), así que los nombres se escriben siempre igual que aquí.
*/
SET XACT_ABORT ON;
GO
IF SCHEMA_ID(N'agentes') IS NULL EXEC(N'CREATE SCHEMA agentes AUTHORIZATION dbo');
GO

/* ───────────── Identidad ───────────── */
IF OBJECT_ID(N'agentes.Usuario') IS NULL
CREATE TABLE agentes.Usuario (
  Id              INT IDENTITY(1,1) CONSTRAINT PK_agentes_Usuario PRIMARY KEY,
  Correo          NVARCHAR(200) NOT NULL,          -- siempre en minúsculas
  Nombre          NVARCHAR(120) NOT NULL,
  HashClave       VARCHAR(200)  NULL,              -- PBKDF2-SHA256 «pbkdf2$iter$salB64$hashB64»; NULL = debe crearla
  Activo          BIT NOT NULL CONSTRAINT DF_agentes_Usuario_Activo DEFAULT 1,
  TelegramId      BIGINT NULL,
  CreadoUtc       DATETIME2(3) NOT NULL CONSTRAINT DF_agentes_Usuario_Creado DEFAULT SYSUTCDATETIME(),
  UltimoIngresoUtc DATETIME2(3) NULL,
  CONSTRAINT UQ_agentes_Usuario_Correo UNIQUE (Correo)
);
GO
IF OBJECT_ID(N'agentes.CodigoAcceso') IS NULL
CREATE TABLE agentes.CodigoAcceso (
  Id          BIGINT IDENTITY(1,1) CONSTRAINT PK_agentes_CodigoAcceso PRIMARY KEY,
  UsuarioId   INT NOT NULL CONSTRAINT FK_agentes_CodigoAcceso_Usuario REFERENCES agentes.Usuario(Id),
  HashCodigo  CHAR(64) NOT NULL,                   -- SHA-256 hex del código de 6 dígitos + pimienta
  Proposito   VARCHAR(20) NOT NULL,                -- 'ingreso' | 'crear_clave'
  VenceUtc    DATETIME2(3) NOT NULL,
  Intentos    TINYINT NOT NULL CONSTRAINT DF_agentes_CodigoAcceso_Intentos DEFAULT 0,
  UsadoUtc    DATETIME2(3) NULL,
  CreadoUtc   DATETIME2(3) NOT NULL CONSTRAINT DF_agentes_CodigoAcceso_Creado DEFAULT SYSUTCDATETIME()
);
GO
IF OBJECT_ID(N'agentes.Sesion') IS NULL
CREATE TABLE agentes.Sesion (
  Id          BIGINT IDENTITY(1,1) CONSTRAINT PK_agentes_Sesion PRIMARY KEY,
  UsuarioId   INT NOT NULL CONSTRAINT FK_agentes_Sesion_Usuario REFERENCES agentes.Usuario(Id),
  HashToken   CHAR(64) NOT NULL,                   -- SHA-256 hex del token; el token nunca se guarda
  CreadaUtc   DATETIME2(3) NOT NULL CONSTRAINT DF_agentes_Sesion_Creada DEFAULT SYSUTCDATETIME(),
  VenceUtc    DATETIME2(3) NOT NULL,
  UltimoUsoUtc DATETIME2(3) NOT NULL CONSTRAINT DF_agentes_Sesion_Uso DEFAULT SYSUTCDATETIME(),
  RevocadaUtc DATETIME2(3) NULL,
  Ip          VARCHAR(45) NULL,
  Navegador   NVARCHAR(300) NULL,
  CONSTRAINT UQ_agentes_Sesion_Hash UNIQUE (HashToken)
);
GO

/* ───────────── Roles y agentes ───────────── */
IF OBJECT_ID(N'agentes.RolPlataforma') IS NULL
CREATE TABLE agentes.RolPlataforma (
  UsuarioId INT NOT NULL CONSTRAINT FK_agentes_RolPlataforma_Usuario REFERENCES agentes.Usuario(Id),
  Rol       VARCHAR(30) NOT NULL CONSTRAINT CK_agentes_RolPlataforma_Rol
            CHECK (Rol IN ('admin_plataforma','admin_boveda','custodio','auditor')),
  CONSTRAINT PK_agentes_RolPlataforma PRIMARY KEY (UsuarioId, Rol)
);
GO
IF OBJECT_ID(N'agentes.Agente') IS NULL
CREATE TABLE agentes.Agente (
  Id            INT IDENTITY(1,1) CONSTRAINT PK_agentes_Agente PRIMARY KEY,
  Clave         VARCHAR(40) NOT NULL,              -- 'hilo', 'esmy', 'tino'
  Nombre        NVARCHAR(60) NOT NULL,
  Descripcion   NVARCHAR(300) NOT NULL,
  Color         CHAR(7) NOT NULL,                  -- #RRGGBB de la marca
  Modelo        VARCHAR(120) NULL,                 -- id de OpenRouter
  Instrucciones NVARCHAR(MAX) NULL,
  McpUrl        VARCHAR(300) NULL,                 -- servidor MCP del sistema dueño
  SecretoMcp    VARCHAR(120) NULL,                 -- nombre del secreto en la bóveda para entrar a ese MCP
  Estado        VARCHAR(20) NOT NULL CONSTRAINT DF_agentes_Agente_Estado DEFAULT 'por_conectar'
                CONSTRAINT CK_agentes_Agente_Estado CHECK (Estado IN ('por_conectar','activo','pausado')),
  CreadoUtc     DATETIME2(3) NOT NULL CONSTRAINT DF_agentes_Agente_Creado DEFAULT SYSUTCDATETIME(),
  CONSTRAINT UQ_agentes_Agente_Clave UNIQUE (Clave)
);
GO
IF OBJECT_ID(N'agentes.PermisoAgente') IS NULL
CREATE TABLE agentes.PermisoAgente (
  UsuarioId INT NOT NULL CONSTRAINT FK_agentes_PermisoAgente_Usuario REFERENCES agentes.Usuario(Id),
  AgenteId  INT NOT NULL CONSTRAINT FK_agentes_PermisoAgente_Agente REFERENCES agentes.Agente(Id),
  Rol       VARCHAR(20) NOT NULL CONSTRAINT CK_agentes_PermisoAgente_Rol
            CHECK (Rol IN ('usuario','aprobador','aprobador_critico')),
  Paises    VARCHAR(20) NOT NULL CONSTRAINT DF_agentes_PermisoAgente_Paises DEFAULT 'HN,GT,SV',
  CONSTRAINT PK_agentes_PermisoAgente PRIMARY KEY (UsuarioId, AgenteId)
);
GO

/* ───────────── Bóveda ───────────── */
IF OBJECT_ID(N'agentes.BovedaLlave') IS NULL
CREATE TABLE agentes.BovedaLlave (
  Id             TINYINT NOT NULL CONSTRAINT PK_agentes_BovedaLlave PRIMARY KEY CONSTRAINT CK_agentes_BovedaLlave_Uno CHECK (Id = 1),
  Verificador    VARBINARY(200) NOT NULL,          -- AES-GCM de un texto fijo con la maestra: prueba el unseal
  Umbral         TINYINT NOT NULL,
  Partes         TINYINT NOT NULL,
  CreadaUtc      DATETIME2(3) NOT NULL CONSTRAINT DF_agentes_BovedaLlave_Creada DEFAULT SYSUTCDATETIME()
);
GO
IF OBJECT_ID(N'agentes.Secreto') IS NULL
CREATE TABLE agentes.Secreto (
  Id             INT IDENTITY(1,1) CONSTRAINT PK_agentes_Secreto PRIMARY KEY,
  Nombre         VARCHAR(120) NOT NULL,            -- p. ej. 'sql/erp-hn/lectura'
  Tipo           VARCHAR(30) NOT NULL CONSTRAINT CK_agentes_Secreto_Tipo
                 CHECK (Tipo IN ('password','api_key','connection_string','certificado','token')),
  Descripcion    NVARCHAR(300) NULL,
  VersionActual  INT NOT NULL CONSTRAINT DF_agentes_Secreto_Version DEFAULT 0,
  RevocadoUtc    DATETIME2(3) NULL,
  CreadoUtc      DATETIME2(3) NOT NULL CONSTRAINT DF_agentes_Secreto_Creado DEFAULT SYSUTCDATETIME(),
  CreadoPor      INT NOT NULL CONSTRAINT FK_agentes_Secreto_Usuario REFERENCES agentes.Usuario(Id),
  CONSTRAINT UQ_agentes_Secreto_Nombre UNIQUE (Nombre)
);
GO
IF OBJECT_ID(N'agentes.SecretoVersion') IS NULL
CREATE TABLE agentes.SecretoVersion (
  SecretoId      INT NOT NULL CONSTRAINT FK_agentes_SecretoVersion_Secreto REFERENCES agentes.Secreto(Id),
  Version        INT NOT NULL,
  ValorCifrado   VARBINARY(MAX) NOT NULL,          -- nonce(12) || cifrado || tag(16), con la llave de datos
  LlaveEnvuelta  VARBINARY(200) NOT NULL,          -- nonce(12) || llave de datos cifrada || tag(16), con la maestra
  CreadaUtc      DATETIME2(3) NOT NULL CONSTRAINT DF_agentes_SecretoVersion_Creada DEFAULT SYSUTCDATETIME(),
  CreadaPor      INT NOT NULL CONSTRAINT FK_agentes_SecretoVersion_Usuario REFERENCES agentes.Usuario(Id),
  CONSTRAINT PK_agentes_SecretoVersion PRIMARY KEY (SecretoId, Version)
);
GO
IF OBJECT_ID(N'agentes.PoliticaSecreto') IS NULL
CREATE TABLE agentes.PoliticaSecreto (
  Id          INT IDENTITY(1,1) CONSTRAINT PK_agentes_PoliticaSecreto PRIMARY KEY,
  SecretoId   INT NOT NULL CONSTRAINT FK_agentes_PoliticaSecreto_Secreto REFERENCES agentes.Secreto(Id),
  AgenteId    INT NOT NULL CONSTRAINT FK_agentes_PoliticaSecreto_Agente REFERENCES agentes.Agente(Id),
  TtlSegundos INT NOT NULL CONSTRAINT DF_agentes_PoliticaSecreto_Ttl DEFAULT 30,
  HoraDesde   TINYINT NULL,                        -- hora de Honduras; NULL = todo el día
  HoraHasta   TINYINT NULL,
  CONSTRAINT UQ_agentes_PoliticaSecreto UNIQUE (SecretoId, AgenteId)
);
GO

/* ───────────── Auditoría: solo agregar, hash encadenado ───────────── */
IF OBJECT_ID(N'agentes.Evento') IS NULL
CREATE TABLE agentes.Evento (
  Id          BIGINT IDENTITY(1,1) CONSTRAINT PK_agentes_Evento PRIMARY KEY,
  MomentoUtc  DATETIME2(3) NOT NULL,
  UsuarioId   INT NULL,
  AgenteId    INT NULL,
  Canal       VARCHAR(20) NOT NULL,                -- 'web' | 'telegram' | 'sistema' | 'boveda'
  Tipo        VARCHAR(60) NOT NULL,                -- 'ingreso_ok', 'secreto_entregado', 'herramienta', ...
  Objeto      NVARCHAR(200) NULL,                  -- herramienta, nombre de secreto, etc. (nunca un valor secreto)
  Detalle     NVARCHAR(2000) NULL,                 -- JSON enmascarado
  Resultado   VARCHAR(20) NOT NULL,                -- 'ok' | 'rechazado' | 'error'
  Ip          VARCHAR(45) NULL,
  HashAnterior CHAR(64) NOT NULL,
  Hash        CHAR(64) NOT NULL
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_agentes_Evento_Momento' AND object_id = OBJECT_ID(N'agentes.Evento'))
  CREATE INDEX IX_agentes_Evento_Momento ON agentes.Evento (MomentoUtc DESC);
GO
/* Candado: Evento no se modifica ni se borra. */
IF OBJECT_ID(N'agentes.TR_Evento_SoloAgregar') IS NULL
EXEC(N'CREATE TRIGGER agentes.TR_Evento_SoloAgregar ON agentes.Evento INSTEAD OF UPDATE, DELETE AS
BEGIN
  RAISERROR(N''agentes.Evento es de solo agregar.'', 16, 1);
  ROLLBACK TRANSACTION;
END');
GO

/* ───────────── Datos base: la familia ───────────── */
MERGE agentes.Agente AS d
USING (VALUES
  ('hilo', N'Hilo', N'Tracking de importaciones de Honduras, Guatemala y El Salvador', '#1B9E73'),
  ('esmy', N'Esmy', N'Permisos sanitarios ARSA de productos importados', '#6C3CF0'),
  ('tino', N'Tino', N'Gestor de Pedidos y Forecast', '#B08A5A')
) AS o (Clave, Nombre, Descripcion, Color)
ON d.Clave = o.Clave
WHEN NOT MATCHED THEN INSERT (Clave, Nombre, Descripcion, Color) VALUES (o.Clave, o.Nombre, o.Descripcion, o.Color);
GO

/* Única puerta de escritura a Evento: serializa con un candado de aplicación y calcula el hash en SQL,
   así la cadena es la misma sin importar qué servicio registre. Devuelve el Id y el Hash. */
CREATE OR ALTER PROCEDURE agentes.sp_RegistrarEvento
  @UsuarioId INT = NULL, @AgenteId INT = NULL, @Canal VARCHAR(20), @Tipo VARCHAR(60),
  @Objeto NVARCHAR(200) = NULL, @Detalle NVARCHAR(2000) = NULL, @Resultado VARCHAR(20), @Ip VARCHAR(45) = NULL
AS
BEGIN
  SET NOCOUNT ON; SET XACT_ABORT ON;
  BEGIN TRAN;
    EXEC sp_getapplock @Resource = N'agentes.Evento', @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 10000;
    DECLARE @momento DATETIME2(3) = SYSUTCDATETIME();
    DECLARE @anterior CHAR(64) = ISNULL((SELECT TOP 1 Hash FROM agentes.Evento ORDER BY Id DESC), REPLICATE('0', 64));
    DECLARE @fila NVARCHAR(MAX) = CONCAT(@anterior, N'|', CONVERT(VARCHAR(30), @momento, 126), N'|', @UsuarioId, N'|', @AgenteId,
      N'|', @Canal, N'|', @Tipo, N'|', @Objeto, N'|', @Detalle, N'|', @Resultado, N'|', @Ip);
    DECLARE @hash CHAR(64) = LOWER(CONVERT(CHAR(64), HASHBYTES('SHA2_256', CONVERT(VARBINARY(MAX), @fila)), 2));
    INSERT agentes.Evento (MomentoUtc, UsuarioId, AgenteId, Canal, Tipo, Objeto, Detalle, Resultado, Ip, HashAnterior, Hash)
    VALUES (@momento, @UsuarioId, @AgenteId, @Canal, @Tipo, @Objeto, @Detalle, @Resultado, @Ip, @anterior, @hash);
    SELECT CAST(SCOPE_IDENTITY() AS BIGINT) AS Id, @hash AS Hash;
  COMMIT;
END
GO

/* Recorre la cadena y devuelve la primera fila rota (o nada si está sana). */
CREATE OR ALTER PROCEDURE agentes.sp_VerificarCadena
AS
BEGIN
  SET NOCOUNT ON;
  WITH c AS (
    SELECT Id, Hash, HashAnterior,
      LAG(Hash, 1, REPLICATE('0', 64)) OVER (ORDER BY Id) AS HashPrevio,
      LOWER(CONVERT(CHAR(64), HASHBYTES('SHA2_256', CONVERT(VARBINARY(MAX), CONCAT(HashAnterior, N'|', CONVERT(VARCHAR(30), MomentoUtc, 126),
        N'|', UsuarioId, N'|', AgenteId, N'|', Canal, N'|', Tipo, N'|', Objeto, N'|', Detalle, N'|', Resultado, N'|', Ip))), 2)) AS Recalculado
    FROM agentes.Evento)
  SELECT TOP 1 Id, CASE WHEN HashAnterior <> HashPrevio THEN 'eslabon' ELSE 'contenido' END AS Falla
  FROM c WHERE HashAnterior <> HashPrevio OR Hash <> Recalculado ORDER BY Id;
END
GO
