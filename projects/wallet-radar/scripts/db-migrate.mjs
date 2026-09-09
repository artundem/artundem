import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH ?? ".env" });

const { Pool } = pg;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDirectory = path.join(projectRoot, "migrations");

export async function runMigrations(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL bulunamadı. Önce .env içine PostgreSQL bağlantısını ekle.");
  }

  const pool = new Pool(connectionOptions(databaseUrl));
  const client = await pool.connect();
  const applied = [];

  try {
    await client.query("SELECT pg_advisory_lock(hashtext('wallet_radar_migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const files = (await fs.readdir(migrationsDirectory))
      .filter((file) => /^\d+_.+\.sql$/.test(file))
      .sort();

    for (const file of files) {
      const alreadyApplied = await client.query(
        "SELECT 1 FROM schema_migrations WHERE id = $1",
        [file]
      );
      if (alreadyApplied.rowCount) continue;

      const sql = await fs.readFile(path.join(migrationsDirectory, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(id) VALUES($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    return { applied, database: safeDatabaseName(databaseUrl) };
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('wallet_radar_migrations'))").catch(() => undefined);
    client.release();
    await pool.end();
  }
}

function connectionOptions(databaseUrl) {
  const url = new URL(databaseUrl);
  const local = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  return {
    connectionString: databaseUrl,
    ssl: local ? false : { rejectUnauthorized: false }
  };
}

function safeDatabaseName(databaseUrl) {
  const name = decodeURIComponent(new URL(databaseUrl).pathname.replace(/^\//, ""));
  return name || "postgres";
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  runMigrations()
    .then((result) => console.log(JSON.stringify({ ok: true, ...result }, null, 2)))
    .catch((error) => {
      console.error(`Migration hatası: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
