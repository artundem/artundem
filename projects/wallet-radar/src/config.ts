import dotenv from "dotenv";
import fs from "node:fs";

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH ?? ".env" });

export type AppConfig = {
  heliusApiKey?: string;
  heliusNetwork: "mainnet-beta" | "devnet";
  gmgnApiKey?: string;
  gmgnCliPath: string;
  robinhoodRpcUrl: string;
  robinhoodBlockscoutUrl: string;
  alchemyApiKey?: string;
  databaseUrl?: string;
  databasePath: string;
};

export function loadConfig(): AppConfig {
  const heliusNetwork = process.env.HELIUS_NETWORK === "devnet" ? "devnet" : "mainnet-beta";
  return {
    heliusApiKey: clean(process.env.HELIUS_API_KEY),
    heliusNetwork,
    gmgnApiKey: clean(process.env.GMGN_API_KEY),
    gmgnCliPath: clean(process.env.GMGN_CLI_PATH) ?? "gmgn-cli",
    robinhoodRpcUrl: clean(process.env.ROBINHOOD_RPC_URL) ?? "https://rpc.mainnet.chain.robinhood.com",
    robinhoodBlockscoutUrl: clean(process.env.ROBINHOOD_BLOCKSCOUT_URL) ?? "https://robinhoodchain.blockscout.com",
    alchemyApiKey: clean(process.env.ALCHEMY_API_KEY),
    databaseUrl: clean(process.env.DATABASE_URL),
    databasePath: clean(process.env.DATABASE_PATH) ?? "data/monitor.db"
  };
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function requireHelius(config: AppConfig): string {
  if (!config.heliusApiKey) {
    throw new Error("HELIUS_API_KEY .env dosyasında bulunamadı.");
  }
  return config.heliusApiKey;
}

export function hasSecret(value: string | undefined): boolean {
  return Boolean(value && value.trim());
}

export type TelegramConnection = {
  token: string;
  username: string;
  ownerId?: number;
  pairingHash?: string;
  pairingExpiresAt?: number;
};

// Local credentials never enter the repo, logs, or research reports.
export function loadTelegramConnection(): TelegramConnection | undefined {
  const file = "data/telegram-connection.json";
  if (!fs.existsSync(file)) return undefined;
  return parseTelegramConnection(fs.readFileSync(file, "utf8"));
}

export function parseTelegramConnection(contents: string): TelegramConnection {
  try {
    const connection = JSON.parse(contents) as TelegramConnection;
    if (!connection || typeof connection.token !== "string" || !/^\d+:[A-Za-z0-9_-]{30,}$/.test(connection.token)
      || typeof connection.username !== "string" || !/^[A-Za-z0-9_]+$/.test(connection.username)
      || (connection.ownerId !== undefined && (!Number.isSafeInteger(connection.ownerId) || connection.ownerId <= 0))) {
      throw new Error("invalid");
    }
    return connection;
  } catch {
    // JSON parser errors may contain fragments of a credential-bearing file.
    throw new Error("Telegram bağlantısı geçersiz; telegram:setup çalıştır.");
  }
}
