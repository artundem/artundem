import { loadConfig, hasSecret } from "./config.js";
import { Database } from "./db.js";
import { GmgnProvider } from "./providers/gmgn.js";
import { HeliusProvider } from "./providers/helius.js";
import { RobinhoodBlockscoutProvider } from "./providers/robinhood-blockscout.js";
import { RobinhoodProvider } from "./providers/robinhood.js";
import { TokenScanner, WalletScanner } from "./scanner.js";
import { ScoredTokenScanner } from "./scored-token-scanner.js";

const config = loadConfig();

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--") argv.shift();
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help") {
    printHelp();
    return;
  }

  if (command === "scan-token-scored") {
    const token = args[0];
    if (!token) throw new Error("Kullanım: pnpm start -- scan-token-scored <TOKEN_ADDRESS> --chain solana|robinhood");
    const scanner = new ScoredTokenScanner(config);
    try {
      console.log(JSON.stringify(await scanner.scan(token, readChain(args), {
        tradersOnly: args.includes("--traders-only")
      }), null, 2));
    } finally {
      await scanner.close();
    }
    return;
  }

  const db = new Database(config.databasePath);
  try {
    if (command === "check") {
      await checkConnections();
      return;
    }
    if (command === "scan-wallet") {
      const address = args[0];
      if (!address) throw new Error("Kullanım: pnpm start -- scan-wallet <SOLANA_ADDRESS> [--hops 2] [--pages 5] [--candidates 25]");
      const hops = readNumberFlag(args, "--hops", 2);
      const scanner = new WalletScanner(new HeliusProvider(config), db);
      console.log(JSON.stringify(await scanner.scan(address, {
        maxHops: hops,
        transferPages: readNumberFlag(args, "--pages", 5),
        candidateLimit: readNumberFlag(args, "--candidates", 25)
      }), null, 2));
      return;
    }
    if (command === "scan-token") {
      const token = args[0];
      if (!token) throw new Error("Kullanım: pnpm start -- scan-token <TOKEN_ADDRESS> [--chain solana] [--holder-limit 100] [--trader-limit 50]");
      const chain = readChain(args);
      const scanner = new TokenScanner(config, new HeliusProvider(config), db);
      console.log(JSON.stringify(await scanner.scan(token, chain, {
        stopAtBuys: readNumberFlag(args, "--stop-at-buys", 51),
        weeklyMinBuys: readNumberFlag(args, "--weekly-min-buys", 1),
        candidateLimit: readNumberFlag(args, "--limit", 150),
        holderLimit: readNumberFlag(args, "--holder-limit", 100),
        traderLimit: readNumberFlag(args, "--trader-limit", 50),
        activityLimit: readNumberFlag(args, "--activity-limit", 200),
        activityPages: readNumberFlag(args, "--activity-pages", 25),
        historyPages: readNumberFlag(args, "--history-pages", 2),
        overallHistoryPages: readNumberFlag(args, "--overall-history-pages", 1_000),
        concurrency: readNumberFlag(args, "--concurrency", 3)
      }), null, 2));
      return;
    }
    if (command === "token-info") {
      const token = args[0];
      if (!token) throw new Error("Kullanım: pnpm start -- token-info <TOKEN_ADDRESS> [--chain solana|robinhood]");
      const chain = readChain(args);
      if (chain === "solana") {
        console.log(JSON.stringify(await new GmgnProvider(config).tokenInfo("sol", token), null, 2));
      } else {
        const info = await new RobinhoodBlockscoutProvider(config).tokenInfo(token);
        db.upsertToken({
          chain,
          address: info.address,
          network: "robinhood-mainnet",
          chainId: 4663,
          addressFormat: "evm-0x",
          evmContract: info.address,
          name: info.name,
          symbol: info.symbol,
          decimals: info.decimals,
          totalSupply: info.totalSupply,
          holderCount: info.holdersCount,
          metadata: info.raw
        });
        console.log(JSON.stringify({ ...info, raw: undefined }, null, 2));
      }
      return;
    }
    if (command === "token-holders") {
      const token = args[0];
      if (!token) throw new Error("Kullanım: pnpm start -- token-holders <TOKEN_ADDRESS> --chain robinhood [--limit 100]");
      const chain = readChain(args);
      const limit = readNumberFlag(args, "--limit", 100);
      if (chain === "solana") {
        console.log(JSON.stringify(await new GmgnProvider(config).tokenHolders("sol", token, limit), null, 2));
      } else {
        const page = await new RobinhoodBlockscoutProvider(config).tokenHolders(token, limit);
        console.log(JSON.stringify({
          chain,
          token,
          pagesRead: page.rawResponses.length,
          hasMore: page.hasMore,
          holders: page.items.map(({ raw: _raw, ...holder }) => holder)
        }, null, 2));
      }
      return;
    }
    if (command === "wallet-appearances") {
      const address = args[0];
      if (!address) throw new Error("Kullanım: npm start -- wallet-appearances <ADDRESS>");
      console.log(JSON.stringify(db.listWalletAppearances(address), null, 2));
      return;
    }
    if (command === "recent-scans") {
      console.log(JSON.stringify(db.listRecentScans(readNumberFlag(args, "--limit", 20)), null, 2));
      return;
    }
    throw new Error(`Bilinmeyen komut: ${command}`);
  } finally {
    db.close();
  }
}

async function checkConnections(): Promise<void> {
  console.log(JSON.stringify({
    configuration: {
      heliusApiKey: hasSecret(config.heliusApiKey),
      gmgnApiKey: hasSecret(config.gmgnApiKey),
      robinhoodRpcUrl: config.robinhoodRpcUrl,
      postgresConfigured: hasSecret(config.databaseUrl),
      databasePath: config.databasePath
    }
  }, null, 2));

  if (config.heliusApiKey) {
    try {
      const health = await new HeliusProvider(config).health();
      console.log(JSON.stringify({ helius: { ok: true, health } }, null, 2));
    } catch (error) {
      console.log(JSON.stringify({ helius: { ok: false, error: errorMessage(error) } }, null, 2));
    }
  }
  try {
    const robinhood = await new RobinhoodProvider(config).health();
    console.log(JSON.stringify({ robinhood: { ok: true, ...robinhood } }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ robinhood: { ok: false, error: errorMessage(error) } }, null, 2));
  }
  try {
    const blockscout = await new RobinhoodBlockscoutProvider(config).health();
    console.log(JSON.stringify({ robinhoodBlockscout: { ok: true, ...blockscout } }, null, 2));
  } catch (error) {
    console.log(JSON.stringify({ robinhoodBlockscout: { ok: false, error: errorMessage(error) } }, null, 2));
  }
}

function readChain(args: string[]): "solana" | "robinhood" {
  const value = readStringFlag(args, "--chain", "solana");
  if (value === "sol" || value === "solana") return "solana";
  if (value === "robinhood") return "robinhood";
  throw new Error("--chain yalnızca solana veya robinhood olabilir.");
}

function readStringFlag(args: string[], flag: string, fallback: string): string {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
}

function readNumberFlag(args: string[], flag: string, fallback: number): number {
  const value = Number(readStringFlag(args, flag, String(fallback)));
  return Number.isFinite(value) ? value : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function printHelp(): void {
  console.log(`
Solana Token Monitor — read-only MVP

Kurulum:
  pnpm install
  pnpm build

Kontrol:
  pnpm start -- check

Aşama 1 — bağlı cüzdan taraması:
  pnpm start -- scan-wallet <SOLANA_ADDRESS> --hops 2 [--pages 5] [--candidates 25]

Aşama 2 — token holder/trader taraması:
  pnpm start -- scan-token <TOKEN_MINT> --chain solana [--holder-limit 100] [--trader-limit 50] [--limit 150]

Yeni puan sistemi — PostgreSQL'e manuel tarama:
  pnpm start -- scan-token-scored <TOKEN_ADDRESS> --chain solana|robinhood
  # Yalnızca hedef coin profit-desc ilk 50 traderını kullan:
  pnpm start -- scan-token-scored <TOKEN_ADDRESS> --chain solana|robinhood --traders-only

Robinhood Chain — indexed read-only token verisi:
  pnpm start -- token-info <EVM_CONTRACT> --chain robinhood
  pnpm start -- token-holders <EVM_CONTRACT> --chain robinhood [--limit 100]
    # Hedef coin 7 gün; başka project-token kontrolü overall history
    # Gerekirse overall taramanın güvenlik üst sınırı değiştirilebilir:
  pnpm start -- scan-token <TOKEN_MINT> --overall-history-pages 1000

Aşama 3 — database sorguları:
  pnpm start -- wallet-appearances <ADDRESS>
  pnpm start -- recent-scans --limit 20

Güvenlik: Bu sürüm swap, order, cooking veya private key ile işlem göndermez.
`);
}

main().catch((error) => {
  console.error(`Hata: ${errorMessage(error)}`);
  process.exitCode = 1;
});
