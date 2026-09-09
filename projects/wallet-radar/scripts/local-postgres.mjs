import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import EmbeddedPostgres from "embedded-postgres";
import { runMigrations } from "./db-migrate.mjs";

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH ?? ".env" });

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultDatabaseUrl = "postgresql://wallet_radar:wallet_radar_local@127.0.0.1:55432/wallet_radar";
const databaseUrl = process.env.DATABASE_URL ?? defaultDatabaseUrl;
const url = new URL(databaseUrl);

if (!["127.0.0.1", "localhost"].includes(url.hostname)) {
  throw new Error("Local PostgreSQL komutu yalnız localhost DATABASE_URL ile çalışır.");
}

const databaseName = decodeURIComponent(url.pathname.replace(/^\//, ""));
const username = decodeURIComponent(url.username);
const password = decodeURIComponent(url.password);
const port = Number(url.port || 5432);

if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(databaseName)) {
  throw new Error("Local database adı yalnız harf, rakam ve alt çizgi içerebilir.");
}

const localPostgres = new EmbeddedPostgres({
  databaseDir: path.join(projectRoot, "data", "postgres-17"),
  port,
  user: username,
  password,
  authMethod: "scram-sha-256",
  persistent: true,
  onLog: () => undefined,
  onError: (error) => console.error(error)
});

async function initialiseIfNeeded() {
  const versionFile = path.join(projectRoot, "data", "postgres-17", "PG_VERSION");
  try {
    await fs.access(versionFile);
  } catch {
    console.log("Local PostgreSQL 17 veri klasörü hazırlanıyor...");
    await localPostgres.initialise();
  }
}

async function ensureDatabase() {
  const client = localPostgres.getPgClient("postgres", url.hostname);
  await client.connect();
  try {
    const result = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [databaseName]);
    if (!result.rowCount) {
      await localPostgres.createDatabase(databaseName);
    }
  } finally {
    await client.end();
  }
}

async function prepare() {
  await initialiseIfNeeded();
  await localPostgres.start();
  await ensureDatabase();
  const migrationResult = await runMigrations(databaseUrl);
  return migrationResult;
}

async function setup() {
  try {
    const result = await prepare();
    console.log(JSON.stringify({
      ok: true,
      postgresVersion: 17,
      database: databaseName,
      migrationsApplied: result.applied
    }, null, 2));
  } finally {
    await localPostgres.stop();
  }
}

async function start() {
  const result = await prepare();
  console.log(JSON.stringify({
    ok: true,
    database: databaseName,
    port,
    migrationsApplied: result.applied,
    message: "Local PostgreSQL çalışıyor. Durdurmak için Ctrl+C."
  }, null, 2));

  await new Promise((resolve, reject) => {
    let stopping = false;
    const stop = async () => {
      if (stopping) return;
      stopping = true;
      try {
        await localPostgres.stop();
        resolve();
      } catch (error) {
        reject(error);
      }
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

const command = process.argv[2] ?? "setup";

try {
  if (command === "setup") await setup();
  else if (command === "start") await start();
  else throw new Error("Kullanım: pnpm db:local:setup veya pnpm db:local:start");
} catch (error) {
  console.error(`Local PostgreSQL hatası: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
