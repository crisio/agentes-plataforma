/* Fase 2 · Conexiones de cada persona con los sistemas de los agentes (Hilo por OAuth + MCP).
   El token vive en la bóveda («conexion/<agente>/u<id>»); aquí solo el estado para mostrarlo. Idempotente. */
IF OBJECT_ID(N'agentes.Conexion') IS NULL
CREATE TABLE agentes.Conexion (
  UsuarioId     INT NOT NULL CONSTRAINT FK_agentes_Conexion_Usuario REFERENCES agentes.Usuario(Id),
  AgenteId      INT NOT NULL CONSTRAINT FK_agentes_Conexion_Agente REFERENCES agentes.Agente(Id),
  Estado        VARCHAR(20) NOT NULL CONSTRAINT CK_agentes_Conexion_Estado CHECK (Estado IN ('conectada','reconectar','desconectada')),
  Herramientas  INT NULL,
  Escrituras    INT NULL,                         -- las que no vienen marcadas como solo lectura
  ConectadaUtc  DATETIME2(3) NULL,
  ProbadaUtc    DATETIME2(3) NULL,
  UltimoError   VARCHAR(60) NULL,
  CONSTRAINT PK_agentes_Conexion PRIMARY KEY (UsuarioId, AgenteId)
);
GO
