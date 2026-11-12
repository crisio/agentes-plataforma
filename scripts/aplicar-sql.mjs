// Aplica un archivo .sql (separado por GO) contra la base de datos configurada con las credenciales de .env.local.
//   node scripts/aplicar-sql.mjs sql/001-esquema-agentes.sql                       → esquema agentes
//   node scripts/aplicar-sql.mjs sql/001-esquema-agentes.sql --esquema agentes_prueba
//   node scripts/aplicar-sql.mjs --borrar-esquema agentes_prueba                   → solo esquemas *_prueba
// Necesita el paquete mssql: `npm i` en la raíz, o MSSQL_PATH apuntando a uno instalado.
import fs from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const sql = require(process.env.MSSQL_PATH ?? "mssql");

const args = process.argv.slice(2);
const opcion = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const esquema = opcion("--esquema") ?? "agentes";
const borrar = opcion("--borrar-esquema");
const archivo = args.find((a) => a.endsWith(".sql"));
for (const e of [esquema, borrar].filter(Boolean)) if (!/^agentes(_prueba)?$/.test(e)) throw new Error(`Esquema no permitido: ${e}`);

const env = Object.fromEntries(fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8").split(/\r?\n/)
  .filter((l) => /^[A-Z_]+=/.test(l)).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
const pool = await sql.connect({ server: env.AGENTES_SQL_HOST, port: Number(env.AGENTES_SQL_PUERTO), user: env.AGENTES_SQL_USUARIO,
  password: env.AGENTES_SQL_CLAVE, database: env.AGENTES_SQL_BASE, options: { encrypt: true, trustServerCertificate: true } });
if ((await pool.request().query("SELECT DB_NAME() AS db")).recordset[0].db !== env.AGENTES_SQL_BASE) throw new Error(`No es ${env.AGENTES_SQL_BASE}`);

if (borrar) {
  if (borrar !== "agentes_prueba") throw new Error("Solo se borra agentes_prueba");
  // Quita disparadores, procedimientos, FKs y tablas del esquema, y después el esquema.
  await pool.request().batch(`
    DECLARE @s NVARCHAR(MAX) = N'';
    SELECT @s += N'DROP TRIGGER [agentes_prueba].' + QUOTENAME(t.name) + N';' FROM sys.triggers t JOIN sys.objects o ON o.object_id = t.parent_id WHERE o.schema_id = SCHEMA_ID(N'agentes_prueba');
    SELECT @s += N'DROP PROCEDURE [agentes_prueba].' + QUOTENAME(name) + N';' FROM sys.procedures WHERE schema_id = SCHEMA_ID(N'agentes_prueba');
    SELECT @s += N'ALTER TABLE [agentes_prueba].' + QUOTENAME(OBJECT_NAME(parent_object_id)) + N' DROP CONSTRAINT ' + QUOTENAME(name) + N';' FROM sys.foreign_keys WHERE schema_id = SCHEMA_ID(N'agentes_prueba');
    SELECT @s += N'DROP TABLE [agentes_prueba].' + QUOTENAME(name) + N';' FROM sys.tables WHERE schema_id = SCHEMA_ID(N'agentes_prueba');
    EXEC (@s);
    IF SCHEMA_ID(N'agentes_prueba') IS NOT NULL EXEC (N'DROP SCHEMA agentes_prueba');`);
  console.log("Esquema agentes_prueba borrado.");
} else {
  let texto = fs.readFileSync(archivo, "utf8");
  if (esquema !== "agentes") texto = texto.replace(/\bagentes\./g, `${esquema}.`).replace(/N'agentes'/g, `N'${esquema}'`)
    .replace(/CREATE SCHEMA agentes\b/g, `CREATE SCHEMA ${esquema}`);
  const lotes = texto.split(/^\s*GO\s*$/im).map((s) => s.trim()).filter(Boolean);
  for (const [i, lote] of lotes.entries()) {
    try { await pool.request().batch(lote); } catch (e) { console.error(`Lote ${i + 1} falló:\n${lote.slice(0, 300)}\n→ ${e.message}`); process.exit(1); }
  }
  console.log(`${archivo} → esquema ${esquema}: ${lotes.length} lotes aplicados.`);
}
await pool.close();
