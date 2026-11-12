/* Fase 2 · Adenda 11-nov: vistas de datos y sugerencias por mensaje, y lectura por conversación («Requiere atención»).
   Idempotente. */
IF COL_LENGTH(N'agentes.Mensaje', N'Vistas') IS NULL
  ALTER TABLE agentes.Mensaje ADD Vistas NVARCHAR(MAX) NULL;          -- JSON: [vista]
GO
IF COL_LENGTH(N'agentes.Mensaje', N'Sugerencias') IS NULL
  ALTER TABLE agentes.Mensaje ADD Sugerencias NVARCHAR(MAX) NULL;     -- JSON: string[]
GO
IF COL_LENGTH(N'agentes.Conversacion', N'LeidaHastaId') IS NULL
  ALTER TABLE agentes.Conversacion ADD LeidaHastaId BIGINT NULL;      -- último agentes.Mensaje.Id que la persona vio
GO
