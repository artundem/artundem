import { createHash, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Chain } from "./types.js";
import type { TelegramConnection } from "./config.js";

export type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    date: number;
    text?: string;
    from?: { id: number; is_bot?: boolean };
    chat: { id: number; type: string };
  };
};
export type TokenRequest = { chain: Chain; token: string };
export type Job = TokenRequest & {
  id: number; chat_id: number; status: string; result: string | null;
  summary_sent: number; document_sent: number; created_at: string;
};

export function parseTokenRequest(text: string): TokenRequest | undefined {
  // Exact address or explicit command only. No shell, arbitrary prose, or links.
  const match = text.trim().match(/^(?:\/ara(?:stir|ştır)?\s+)?(?:(solana|sol|robinhood)\s+)?([1-9A-HJ-NP-Za-km-z]{32,44}|0x[0-9a-fA-F]{40})$/i);
  if (!match) return undefined;
  const token = match[2];
  const chain: Chain = /^0x[0-9a-fA-F]{40}$/.test(token) ? "robinhood" : "solana";
  if (match[1] && (match[1].toLowerCase() === "robinhood") !== (chain === "robinhood")) return undefined;
  if (chain === "solana") {
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let number = 0n;
    for (const c of token) {
      const digit = alphabet.indexOf(c);
      if (digit < 0) return undefined;
      number = number * 58n + BigInt(digit);
    }
    let bytes = 0;
    while (number > 0n) { bytes++; number >>= 8n; }
    bytes += token.match(/^1*/)?.[0].length ?? 0;
    if (bytes !== 32) return undefined;
  }
  return { chain, token: chain === "robinhood" ? token.toLowerCase() : token };
}

export function privateSender(update: TelegramUpdate): number | undefined {
  const m = update.message;
  return m?.chat.type === "private" && m.from && !m.from.is_bot
    && Number.isSafeInteger(m.from.id) && m.from.id > 0 && m.chat.id === m.from.id
    ? m.from.id : undefined;
}

export function mayPair(update: TelegramUpdate, connection: TelegramConnection, now = Date.now()): boolean {
  if (connection.ownerId || !privateSender(update) || !connection.pairingHash
    || !connection.pairingExpiresAt || now > connection.pairingExpiresAt) return false;
  const code = update.message?.text?.match(/^\/start ([a-f0-9]{48})$/)?.[1];
  if (!code) return false;
  const expected = Buffer.from(connection.pairingHash, "hex");
  const actual = createHash("sha256").update(code).digest();
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export class TelegramApi {
  constructor(private readonly token: string, private readonly fetcher: typeof fetch = fetch) {}

  async call<T>(method: "getMe" | "getWebhookInfo" | "getUpdates" | "sendMessage" | "sendDocument", body: Record<string, unknown> | FormData = {}): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(45_000),
        ...(body instanceof FormData ? { body } : {
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
        })
      });
    } catch {
      // Network errors can embed credential-bearing URLs. Never expose the cause.
      throw new Error(`Telegram ${method}: bağlantı kurulamadı.`);
    }
    let payload: { ok: boolean; result: T };
    try { payload = await response.json() as typeof payload; }
    catch { throw new Error(`Telegram ${method}: geçersiz yanıt.`); }
    if (!response.ok || !payload.ok) throw new Error(`Telegram ${method}: HTTP ${response.status}.`);
    return payload.result;
  }

  async send(chatId: number, text: string): Promise<void> {
    await this.call("sendMessage", { chat_id: chatId, text: text.slice(0,4000), link_preview_options: { is_disabled: true } });
  }
  async document(chatId: number, name: string, contents: string): Promise<void> {
    const form = new FormData();
    form.set("chat_id", String(chatId));
    form.set("document", new Blob([contents], { type: "text/plain" }), name);
    await this.call("sendDocument", form);
  }
}

export class TelegramInbox {
  readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS cursor (id INTEGER PRIMARY KEY CHECK(id=1), offset INTEGER NOT NULL);
      INSERT OR IGNORE INTO cursor VALUES(1,0);
      CREATE TABLE IF NOT EXISTS jobs (
        id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, chain TEXT NOT NULL, token TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', result TEXT,
        summary_sent INTEGER NOT NULL DEFAULT 0, document_sent INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );`);
  }
  close(): void { this.db.close(); }
  offset(): number { return Number(this.db.prepare("SELECT offset FROM cursor WHERE id=1").get()!.offset); }
  acknowledge(updateId: number, chatId?: number, request?: TokenRequest): boolean {
    let inserted = false;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (updateId < this.offset()) { this.db.exec("COMMIT"); return false; }
      if (request && chatId) {
        const duplicate = this.db.prepare("SELECT 1 FROM jobs WHERE chain=? AND token=? AND status IN ('pending','running','reporting','done')").get(request.chain, request.token);
        if (!duplicate) inserted = this.db.prepare("INSERT OR IGNORE INTO jobs(id,chat_id,chain,token) VALUES(?,?,?,?)")
          .run(updateId, chatId, request.chain, request.token).changes > 0;
      }
      this.db.prepare("UPDATE cursor SET offset=MAX(offset,?) WHERE id=1").run(updateId + 1);
      this.db.exec("COMMIT");
      return inserted;
    } catch(error) { this.db.exec("ROLLBACK"); throw error; }
  }
  next(): Job | undefined {
    return this.db.prepare("SELECT * FROM jobs WHERE status IN ('running','reporting','pending') ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'reporting' THEN 1 ELSE 2 END,id LIMIT 1").get() as Job | undefined;
  }
  status(id: number, status: string, result?: string): void {
    this.db.prepare("UPDATE jobs SET status=?,result=COALESCE(?,result) WHERE id=?").run(status, result ?? null, id);
  }
  delivered(id: number, part: "summary_sent" | "document_sent"): void {
    this.db.prepare(`UPDATE jobs SET ${part}=1 WHERE id=?`).run(id);
  }
  counts(): string {
    const rows = this.db.prepare("SELECT status,COUNT(*) AS n FROM jobs GROUP BY status").all();
    return rows.map(r => `${r.status}: ${r.n}`).join("\n") || "Sırada araştırma yok. Mint/contract gönderebilirsin.";
  }
}
