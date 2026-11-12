/* Ingreso sin clave: correo + código, y después llaves de acceso (WebAuthn / passkeys). Idempotente. */
IF OBJECT_ID(N'agentes.LlaveAcceso') IS NULL
CREATE TABLE agentes.LlaveAcceso (
  Id            INT IDENTITY(1,1) CONSTRAINT PK_agentes_LlaveAcceso PRIMARY KEY,
  UsuarioId     INT NOT NULL CONSTRAINT FK_agentes_LlaveAcceso_Usuario REFERENCES agentes.Usuario(Id),
  CredencialId  VARBINARY(1024) NOT NULL,
  HashCredencial CHAR(64) NOT NULL,                 -- SHA-256 hex de CredencialId, para el índice único
  LlavePublica  VARBINARY(2048) NOT NULL,           -- COSE; es pública, no es secreto
  Contador      BIGINT NOT NULL CONSTRAINT DF_agentes_LlaveAcceso_Contador DEFAULT 0,
  Nombre        NVARCHAR(100) NOT NULL,
  Respaldada    BIT NOT NULL CONSTRAINT DF_agentes_LlaveAcceso_Resp DEFAULT 0,  -- sincronizada (iCloud, Google…)
  CreadaUtc     DATETIME2(3) NOT NULL CONSTRAINT DF_agentes_LlaveAcceso_Creada DEFAULT SYSUTCDATETIME(),
  UltimoUsoUtc  DATETIME2(3) NULL,
  CONSTRAINT UQ_agentes_LlaveAcceso_Cred UNIQUE (HashCredencial)
);
GO
