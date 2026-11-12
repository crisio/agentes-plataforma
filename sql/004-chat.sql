/* Fase 2 · Chat con los agentes: conversaciones y mensajes por persona. El texto de las herramientas no se guarda,
   solo su nombre, estado y duración. Idempotente. */
IF OBJECT_ID(N'agentes.Conversacion') IS NULL
CREATE TABLE agentes.Conversacion (
  Id              INT IDENTITY(1,1) CONSTRAINT PK_agentes_Conversacion PRIMARY KEY,
  UsuarioId       INT NOT NULL CONSTRAINT FK_agentes_Conversacion_Usuario REFERENCES agentes.Usuario(Id),
  AgenteId        INT NOT NULL CONSTRAINT FK_agentes_Conversacion_Agente REFERENCES agentes.Agente(Id),
  Titulo          NVARCHAR(120) NULL,
  CreadaUtc       DATETIME2(3) NOT NULL CONSTRAINT DF_agentes_Conversacion_Creada DEFAULT SYSUTCDATETIME(),
  ActualizadaUtc  DATETIME2(3) NOT NULL CONSTRAINT DF_agentes_Conversacion_Act DEFAULT SYSUTCDATETIME()
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_agentes_Conversacion_Usuario' AND object_id = OBJECT_ID(N'agentes.Conversacion'))
CREATE INDEX IX_agentes_Conversacion_Usuario ON agentes.Conversacion (UsuarioId, AgenteId, ActualizadaUtc DESC);
GO
IF OBJECT_ID(N'agentes.Mensaje') IS NULL
CREATE TABLE agentes.Mensaje (
  Id              BIGINT IDENTITY(1,1) CONSTRAINT PK_agentes_Mensaje PRIMARY KEY,
  ConversacionId  INT NOT NULL CONSTRAINT FK_agentes_Mensaje_Conversacion REFERENCES agentes.Conversacion(Id) ON DELETE CASCADE,
  Rol             VARCHAR(12) NOT NULL CONSTRAINT CK_agentes_Mensaje_Rol CHECK (Rol IN ('usuario','agente')),
  Texto           NVARCHAR(MAX) NOT NULL,
  Herramientas    NVARCHAR(MAX) NULL,               -- JSON: [{nombre, estado, ms}]
  CreadoUtc       DATETIME2(3) NOT NULL CONSTRAINT DF_agentes_Mensaje_Creado DEFAULT SYSUTCDATETIME(),
  Error           VARCHAR(60) NULL
);
GO
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_agentes_Mensaje_Conversacion' AND object_id = OBJECT_ID(N'agentes.Mensaje'))
CREATE INDEX IX_agentes_Mensaje_Conversacion ON agentes.Mensaje (ConversacionId, Id);
GO
