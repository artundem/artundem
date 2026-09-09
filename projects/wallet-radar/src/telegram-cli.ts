import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadConfig, loadTelegramConnection, type TelegramConnection } from "./config.js";
import { TelegramApi, TelegramInbox, mayPair, parseTokenRequest, privateSender, type Job, type TelegramUpdate } from "./telegram.js";
import { ScoredTokenScanner, type ScoredTokenScanSummary } from "./scored-token-scanner.js";
import { HeliusProvider } from "./providers/helius.js";
import { RobinhoodProvider } from "./providers/robinhood.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);
const connectionFile = "data/telegram-connection.json";
const help = "Wallet Radar özel araştırma sohbeti.\nSolana minti veya Robinhood contractı gönder; araştırma sırayla başlar.\n/ara solana <MINT>\n/ara robinhood <CONTRACT>\n/durum: kuyruk durumu\nİşlem: yalnız zincir verilerini okuma ve cüzdan puanlama.";

export async function saveConnection(connection: TelegramConnection): Promise<void> {
  await fs.mkdir("data", { recursive: true });
  await fs.writeFile(`${connectionFile}.tmp`, JSON.stringify(connection), { mode: 0o600 });
  await fs.rename(`${connectionFile}.tmp`, connectionFile);
  await fs.chmod(connectionFile, 0o600);
}

async function ingest(api: TelegramApi, inbox: TelegramInbox, connection: TelegramConnection): Promise<number> {
  const updates = await api.call<TelegramUpdate[]>("getUpdates", {
    offset: inbox.offset(), limit: 100, timeout: 0, allowed_updates: ["message"]
  });
  let accepted = 0;
  for (const update of updates.sort((a,b) => a.update_id - b.update_id)) {
    if (update.update_id < inbox.offset()) continue;
    const sender = privateSender(update);
    if (mayPair(update, connection)) {
      connection.ownerId = sender;
      delete connection.pairingHash;
      delete connection.pairingExpiresAt;
      await saveConnection(connection);
      await api.send(sender!, `Bağlantı tamam. Bu bot yalnız senin özel mesajlarını kabul eder.\n${help}`);
      inbox.acknowledge(update.update_id);
      continue;
    }
    if (!connection.ownerId || sender !== connection.ownerId) {
      inbox.acknowledge(update.update_id);
      continue;
    }
    const text = update.message!.text ?? "";
    if (/^\/(?:start|help|yardim)(?:\s.*)?$/.test(text)) {
      await api.send(sender, help);
      inbox.acknowledge(update.update_id);
    } else if (text === "/durum") {
      await api.send(sender, inbox.counts());
      inbox.acknowledge(update.update_id);
    } else {
      const request = parseTokenRequest(text);
      const inserted = inbox.acknowledge(update.update_id, sender, request);
      if (inserted) accepted++;
      // The durable job is saved before any network acknowledgement.
      await api.send(sender, !request ? "Tek bir Solana minti veya Robinhood contractı gönder. Örnek: /ara robinhood 0x…"
        : inserted ? `${request.chain}: ${request.token}\nAraştırma sıraya alındı. Sonuç burada paylaşılacak.`
        : "Bu adres zaten sırada veya araştırılmış; ikinci araştırma başlatılmadı.").catch(() => undefined);
    }
  }
  return accepted;
}

function compactSummary(s: ScoredTokenScanSummary) {
  return {
    scanId: s.scanId, chain: s.chain, token: s.token,
    tokenName: s.tokenName, tokenSymbol: s.tokenSymbol, candidates: s.candidates,
    databaseRetained: s.databaseRetained, siteVisible: s.siteVisible,
    microcapWins: s.microcap?.wins ?? 0, warningCount: s.warnings?.length ?? 0,
    coverageTruncated: s.holderRule?.coverageTruncated ?? false
  };
}

async function processOne(api: TelegramApi, inbox: TelegramInbox): Promise<boolean> {
  let job = inbox.next();
  if (!job) return false;
  const config = loadConfig();
  if (!config.databaseUrl || !config.gmgnApiKey) throw new Error("Database/GMGN yapılandırması eksik.");
  const url = new URL(config.databaseUrl);
  const pool = new pg.Pool({ connectionString: config.databaseUrl,
    ssl: ["localhost","127.0.0.1","::1"].includes(url.hostname) ? false : { rejectUnauthorized: true },
    connectionTimeoutMillis: 5000 });
  const client = await pool.connect().catch(async () => { await pool.end(); throw new Error("PostgreSQL kapalı veya erişilemiyor. pnpm db:local:start çalıştır."); });
  try {
    // Another heartbeat process must not work on the same queue concurrently.
    const lock = await client.query("SELECT pg_try_advisory_lock(hashtext('wallet-radar-telegram-worker')) AS locked");
    if (!lock.rows[0].locked) return false;
    if (job.status !== "reporting") {
      const previous = await client.query(`SELECT s.status,s.summary FROM scans s JOIN tokens t ON t.id=s.token_id
        WHERE t.chain=$1 AND t.address_key=$2 AND s.kind='token-wallet-score'
        AND s.status IN ('running','completed') ORDER BY s.started_at DESC LIMIT 1`, [job.chain, job.token]);
      const scan = previous.rows[0];
      if (scan?.status === "completed") {
        inbox.status(job.id, "reporting", JSON.stringify(compactSummary(scan.summary)));
      } else if (scan?.status === "running" || job.status === "running") {
        await api.send(job.chat_id, `${job.token}\nBu adres için süren veya yarıda kalmış araştırma bulundu. İkinci tarama açılmadı; durum burada kontrol edilmeli.`);
        inbox.status(job.id, "failed");
        return true;
      } else {
        // Read-only checks before a live scan; token validation itself uses GMGN.
        if (job.chain === "solana") await new HeliusProvider(config).health();
        else await new RobinhoodProvider(config).health();
        await api.send(job.chat_id, `Araştırma başladı: ${job.chain}\n${job.token}\nHolderlar, traderlar ve 7 günlük cüzdan performansı inceleniyor.`);
        inbox.status(job.id, "running");
        const scanner = new ScoredTokenScanner(config);
        try {
          const summary = await scanner.scan(job.token, job.chain);
          inbox.status(job.id, "reporting", JSON.stringify(compactSummary(summary)));
        } catch {
          // Do not send raw provider errors (they can contain secrets).
          inbox.status(job.id, "failed");
          await api.send(job.chat_id, `${job.token}\nAraştırma tamamlanamadı: token doğrulaması, duplicate kontrolü veya sağlayıcı bağlantısı başarısız. /durum ile kuyruğu görebilirsin.`);
          return true;
        } finally { await scanner.close(); }
      }
      job = inbox.next()!;
    }
    await deliver(api, inbox, job, client);
    return true;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('wallet-radar-telegram-worker'))").catch(() => undefined);
    client.release(); await pool.end();
  }
}

async function deliver(api: TelegramApi, inbox: TelegramInbox, job: Job, client: pg.PoolClient): Promise<void> {
  const s = JSON.parse(job.result!) as ReturnType<typeof compactSummary>;
  if (!job.summary_sent) {
    await api.send(job.chat_id, `Araştırma tamamlandı: ${s.tokenName ?? s.tokenSymbol ?? s.token}\nZincir: ${s.chain}\nAdres: ${s.token}\nİncelenen aday: ${s.candidates}\nSaklanan cüzdan: ${s.databaseRetained}\n21+ puanlı cüzdan: ${s.siteVisible}\nMicrocap bonusu: ${s.microcapWins}\nUyarı: ${s.warningCount}${s.coverageTruncated ? "\nGMGN holder kapsamı 100 ile sınırlı." : ""}\nScan: ${s.scanId}`);
    inbox.delivered(job.id, "summary_sent");
  }
  if (!job.document_sent) {
    const wallets = await client.query(`SELECT w.address, ws.raw_points FROM wallet_token_observations o
      JOIN wallets w ON w.id=o.wallet_id JOIN wallet_metrics m ON m.observation_id=o.id
      JOIN wallet_scores ws ON ws.metric_id=m.id JOIN scans s ON s.id=o.scan_id AND ws.score_version=s.score_version
      WHERE o.scan_id=$1 ORDER BY ws.raw_points DESC,(o.candidate_metrics->>'source_order')::int ASC NULLS LAST,o.id`, [s.scanId]);
    const content = wallets.rows.map(w => w.address).join("\n") + "\n";
    const filename = `${s.chain}-${s.scanId}-wallets.txt`;
    await fs.mkdir("reports", { recursive: true });
    await fs.writeFile(path.join("reports", filename), content);
    await api.document(job.chat_id, filename, content);
    inbox.delivered(job.id, "document_sent");
  }
  inbox.status(job.id, "done");
  console.log(JSON.stringify({ completed: true, ...s }));
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "check";
  if (!["check","poll","run-once"].includes(command)) throw new Error("Kullanım: telegram check|poll|run-once");
  const connection = loadTelegramConnection();
  if (!connection) throw new Error("Telegram bağlı değil. pnpm telegram:setup çalıştır.");
  const api = new TelegramApi(connection.token);
  const me = await api.call<{ username: string; is_bot: boolean }>("getMe");
  const webhook = await api.call<{ url: string }>("getWebhookInfo");
  if (!me.is_bot || webhook.url) throw new Error("Bot doğrulanamadı veya başka webhook kullanılıyor. Mevcut bağlantı değiştirilmedi.");
  if (command === "check") {
    console.log(JSON.stringify({ ok: true, bot: me.username, paired: Boolean(connection.ownerId) })); return;
  }
  await fs.mkdir("data", { recursive: true });
  const lockPath = "data/telegram-worker.lock";
  // A PID lock also serializes pairing and offset updates before PostgreSQL opens.
  if (existsSync(lockPath)) {
    const pid = Number(await fs.readFile(lockPath, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Telegram kilidi kontrol edilmeli.");
    let alive = true;
    try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
    if (alive) { console.log(JSON.stringify({ busy: true })); return; }
    await fs.unlink(lockPath);
  }
  const lock = await fs.open(lockPath, "wx", 0o600);
  await lock.writeFile(String(process.pid));
  const inbox = new TelegramInbox("data/telegram-inbox.db");
  try {
    const accepted = await ingest(api, inbox, connection);
    const processed = command === "run-once" && connection.ownerId ? await processOne(api, inbox) : false;
    console.log(JSON.stringify({ ok: true, accepted, processed, paired: Boolean(connection.ownerId), pending: Boolean(inbox.next()) }));
  } finally {
    inbox.close(); await lock.close(); await fs.unlink(lockPath);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    console.error("Telegram işlemi tamamlanamadı. Bot bağlantısını ve PostgreSQL/sağlayıcı sağlık kontrolünü inceleyin; gizli hata ayrıntıları bastırıldı.");
    process.exitCode = 1;
  });
}
