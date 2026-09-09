import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { AppConfig } from "../config.js";

const execFileAsync = promisify(execFile);
const WALLET_STATS_MIN_INTERVAL_MS = 2_300;
const TOKEN_REQUEST_MIN_INTERVAL_MS = 10_000;

export class GmgnProvider {
  private requestQueue: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;

  constructor(private readonly config: AppConfig) {}

  async tokenInfo(chain: string, address: string): Promise<unknown> {
    return this.run(["token", "info", "--chain", chain, "--address", address, "--raw"]);
  }

  async tokenSecurity(chain: string, address: string): Promise<unknown> {
    return this.run(["token", "security", "--chain", chain, "--address", address, "--raw"]);
  }

  async tokenPool(chain: string, address: string): Promise<unknown> {
    return this.run(["token", "pool", "--chain", chain, "--address", address, "--raw"]);
  }

  async tokenHolders(chain: string, address: string, limit = 100): Promise<unknown> {
    return this.run(["token", "holders", "--chain", chain, "--address", address, "--limit", String(limit), "--raw"]);
  }

  async tokenTraders(
    chain: string,
    address: string,
    limit = 100,
    orderBy: "amount_percentage" | "profit" | "unrealized_profit" | "buy_volume_cur" | "sell_volume_cur" = "amount_percentage",
    direction: "asc" | "desc" = "desc"
  ): Promise<unknown> {
    return this.run([
      "token", "traders", "--chain", chain, "--address", address, "--limit", String(limit),
      "--order-by", orderBy, "--direction", direction, "--raw"
    ]);
  }

  async portfolioActivity(
    chain: string,
    wallet: string,
    options: number | { limit?: number; cursor?: string; types?: Array<"buy" | "sell" | "transferIn" | "transferOut" | "add" | "remove"> } = 200
  ): Promise<unknown> {
    const normalized = typeof options === "number" ? { limit: options } : options;
    const args = [
      "portfolio", "activity", "--chain", chain, "--wallet", wallet,
      "--limit", String(normalized.limit ?? 200)
    ];
    if (normalized.cursor) args.push("--cursor", normalized.cursor);
    for (const type of normalized.types ?? []) args.push("--type", type);
    args.push("--raw");
    return this.run(args);
  }

  async portfolioStats(chain: string, wallet: string, period = "7d"): Promise<unknown> {
    return this.run(["portfolio", "stats", "--chain", chain, "--wallet", wallet, "--period", period, "--raw"]);
  }

  async portfolioStatsBatch(chain: string, wallets: string[], period = "7d"): Promise<unknown> {
    if (wallets.length === 0) return [];
    const walletArgs = wallets.flatMap((wallet) => ["--wallet", wallet]);
    return this.run([
      "portfolio", "stats", "--chain", chain, ...walletArgs,
      "--period", period, "--raw"
    ]);
  }

  private async run(args: string[]): Promise<unknown> {
    const minimumInterval = args[0] === "token"
      ? TOKEN_REQUEST_MIN_INTERVAL_MS
      : WALLET_STATS_MIN_INTERVAL_MS;
    const task = this.requestQueue.then(async () => {
      const waitMs = Math.max(0, this.nextRequestAt - Date.now());
      if (waitMs > 0) await delay(waitMs);
      try {
        return await this.runWithRetry(args);
      } finally {
        this.nextRequestAt = Date.now() + minimumInterval;
      }
    });
    this.requestQueue = task.then(() => undefined, () => undefined);
    return task;
  }

  private async runWithRetry(args: string[]): Promise<unknown> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return await this.runOnce(args);
      } catch (error) {
        lastError = error;
        const detail = error instanceof Error ? error.message : String(error);
        if (attempt >= 3 || !/(?:429|5\d\d|timed?\s*out|ECONNRESET|EAI_AGAIN|ENETUNREACH)/i.test(detail)) throw error;
        const bannedSeconds = rateLimitBanSeconds(detail);
        await delay(bannedSeconds === undefined
          ? 500 * 2 ** (attempt - 1)
          : (bannedSeconds + 10) * 1_000);
      }
    }
    throw lastError;
  }

  private async runOnce(args: string[]): Promise<unknown> {
    const env = {
      ...process.env,
      PATH: `${path.dirname(process.execPath)}${process.env.PATH ? `:${process.env.PATH}` : ""}`,
      ...(this.config.gmgnApiKey ? { GMGN_API_KEY: this.config.gmgnApiKey } : {})
    };
    const localBinary = path.join(process.cwd(), "node_modules", ".bin", "gmgn-cli");
    const command = this.config.gmgnCliPath === "gmgn-cli" && process.platform !== "win32" && !process.env.GMGN_CLI_PATH
      ? localBinary
      : this.config.gmgnCliPath;
    try {
      const result = await execFileAsync(command, args, { env, timeout: 45_000, maxBuffer: 8 * 1024 * 1024 });
      return parseCliJson(result.stdout || result.stderr);
    } catch (error) {
      const code = error as NodeJS.ErrnoException;
      if (code.code === "ENOENT" && command !== "npx") {
        const result = await execFileAsync("npx", ["--yes", "gmgn-cli", ...args], {
          env,
          timeout: 90_000,
          maxBuffer: 8 * 1024 * 1024
        });
        return parseCliJson(result.stdout || result.stderr);
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`GMGN komutu başarısız (${args.join(" ")}): ${detail}`);
    }
  }
}

function rateLimitBanSeconds(detail: string): number | undefined {
  if (!/RATE_LIMIT_BANNED/i.test(detail)) return undefined;
  const match = detail.match(/~(\d+)s remaining/i);
  if (!match) return undefined;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? Math.min(305, Math.max(1, seconds)) : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCliJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    for (const line of trimmed.split(/\r?\n/).reverse()) {
      try {
        return JSON.parse(line.trim());
      } catch {
        // Continue searching for the JSON line after CLI logs.
      }
    }
  }
  throw new Error(`GMGN CLI JSON çıktı üretmedi: ${trimmed.slice(0, 500)}`);
}
