import type { AppConfig } from "../config.js";
import { requireHelius } from "../config.js";
import { fetchJson, withQuery } from "../lib/http.js";
import type { Identity, TransferRecord } from "../types.js";

type HeliusRpcResponse<T> = { result?: T; error?: { code?: number; message?: string } };

export type HeliusTransferBatch = {
  transfers: TransferRecord[];
  rawResponses: Record<string, unknown>[];
};

export type HeliusHistoryPage = {
  data: Record<string, unknown>[];
  nextCursor?: string;
  hasMore?: boolean;
  raw: Record<string, unknown>;
};

export class HeliusProvider {
  private readonly apiKey: string;
  private readonly rpcUrl: string;

  constructor(private readonly config: AppConfig) {
    this.apiKey = requireHelius(config);
    const host = config.heliusNetwork === "devnet" ? "devnet.helius-rpc.com" : "mainnet.helius-rpc.com";
    this.rpcUrl = `https://${host}/?api-key=${encodeURIComponent(this.apiKey)}`;
  }

  async health(): Promise<unknown> {
    return this.rpc("getHealth", []);
  }

  async getAsset(id: string): Promise<Record<string, unknown>> {
    return this.rpc("getAsset", { id });
  }

  async getTokenAccountsByMint(
    mint: string,
    showZeroBalance = false,
    maxPages = 100,
    pageSize = 100
  ): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const params: Record<string, unknown> = {
        mint,
        limit: Math.max(1, Math.min(100, Math.trunc(pageSize))),
        options: { showZeroBalance }
      };
      if (cursor) params.cursor = cursor;
      const response = await this.rpc<{ token_accounts?: Record<string, unknown>[]; cursor?: string }>("getTokenAccounts", params);
      rows.push(...(response.token_accounts ?? []));
      if (!response.cursor || response.cursor === cursor || (response.token_accounts ?? []).length === 0) break;
      cursor = response.cursor;
    }
    return rows;
  }

  async getIdentity(address: string): Promise<Identity | null> {
    const url = withQuery(`https://api.helius.xyz/v1/wallet/${encodeURIComponent(address)}/identity`, { "api-key": this.apiKey });
    try {
      return await fetchJson<Identity>(url, {}, "Helius identity");
    } catch (error) {
      if (error instanceof Error && /\(404\)/.test(error.message)) return null;
      throw error;
    }
  }

  async getFundedBy(address: string): Promise<Record<string, unknown> | null> {
    const url = withQuery(`https://api.helius.xyz/v1/wallet/${encodeURIComponent(address)}/funded-by`, { "api-key": this.apiKey });
    try {
      return await fetchJson<Record<string, unknown>>(url, {}, "Helius funded-by");
    } catch (error) {
      if (error instanceof Error && /\(404\)/.test(error.message)) return null;
      throw error;
    }
  }

  async getTransfers(address: string, maxPages = 5): Promise<TransferRecord[]> {
    return (await this.getTransfersWithRaw(address, maxPages)).transfers;
  }

  async getTransfersWithRaw(address: string, maxPages = 5): Promise<HeliusTransferBatch> {
    const rows: TransferRecord[] = [];
    const rawResponses: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page += 1) {
      const url = withQuery(`https://api.helius.xyz/v1/wallet/${encodeURIComponent(address)}/transfers`, {
        "api-key": this.apiKey,
        limit: 100,
        cursor
      });
      const response = await fetchJson<Record<string, unknown>>(url, {}, "Helius transfers");
      rawResponses.push(response);
      const data = Array.isArray(response.data) ? response.data : [];
      rows.push(...data.map((item) => normalizeTransfer(item as Record<string, unknown>)));
      const pagination = asRecord(response.pagination);
      const next = asString(pagination?.nextCursor) ?? asString(response.nextCursor);
      if (!next || next === cursor || data.length === 0 || pagination?.hasMore === false) break;
      cursor = next;
    }
    return { transfers: deduplicateTransfers(rows), rawResponses };
  }

  async getHistory(
    address: string,
    options: { type?: string; maxPages?: number; limit?: number } = {}
  ): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    let before: string | undefined;
    const maxPages = options.maxPages ?? 10;
    for (let page = 0; page < maxPages; page += 1) {
      const response = await this.getHistoryPage(address, { type: options.type, limit: options.limit, before });
      rows.push(...response.data);
      if (!response.nextCursor || response.nextCursor === before || response.data.length === 0 || response.hasMore === false) break;
      before = response.nextCursor;
    }
    return rows;
  }

  async getHistoryPage(
    address: string,
    options: { type?: string; limit?: number; before?: string } = {}
  ): Promise<HeliusHistoryPage> {
    const url = withQuery(`https://api.helius.xyz/v1/wallet/${encodeURIComponent(address)}/history`, {
      "api-key": this.apiKey,
      limit: options.limit ?? 100,
      before: options.before,
      type: options.type,
      tokenAccounts: "balanceChanged"
    });
    const raw = await fetchJson<Record<string, unknown>>(url, {}, "Helius wallet history");
    const data = Array.isArray(raw.data) ? raw.data.map((item) => item as Record<string, unknown>) : [];
    const pagination = asRecord(raw.pagination);
    return {
      data,
      nextCursor: asString(pagination?.nextCursor) ?? asString(raw.nextCursor),
      hasMore: pagination?.hasMore === false ? false : undefined,
      raw
    };
  }

  private async rpc<T>(method: string, params: unknown): Promise<T> {
    const response = await fetchJson<HeliusRpcResponse<T>>(this.rpcUrl, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params })
    }, `Helius ${method}`);
    if (response.error) throw new Error(`Helius ${method}: ${response.error.message ?? "RPC error"}`);
    if (response.result === undefined) throw new Error(`Helius ${method}: response result missing`);
    return response.result;
  }
}

export function normalizeTransfer(raw: Record<string, unknown>): TransferRecord {
  const from = firstString(raw, ["fromUserAccount", "from", "source", "sender"]);
  const to = firstString(raw, ["toUserAccount", "to", "destination", "recipient"]);
  const counterparty = firstString(raw, ["counterparty", "counterpartyAddress"]) ?? undefined;
  const amountUsd = firstNumber(raw, ["amountUsd", "amount_usd", "valueUsd", "value_usd"]);
  return {
    signature: firstString(raw, ["signature", "transactionSignature"]),
    timestamp: firstNumber(raw, ["timestamp", "time"]),
    from,
    to,
    counterparty,
    direction: firstString(raw, ["direction", "flow"]),
    mint: firstString(raw, ["mint", "tokenMint"]),
    symbol: firstString(raw, ["symbol", "tokenSymbol"]),
    amount: firstNumber(raw, ["amount", "tokenAmount"]),
    amountRaw: firstString(raw, ["amountRaw", "amount_raw"]),
    decimals: firstNumber(raw, ["decimals"]),
    amountUsd,
    valueUsd: amountUsd,
    raw
  };
}

export function deduplicateTransfers(transfers: TransferRecord[]): TransferRecord[] {
  const seen = new Set<string>();
  const result: TransferRecord[] = [];
  for (const transfer of transfers) {
    const key = [
      transfer.signature ?? "",
      transfer.direction ?? "",
      transfer.counterparty ?? transfer.from ?? transfer.to ?? "",
      transfer.mint ?? "",
      transfer.amountRaw ?? transfer.amount ?? ""
    ].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(transfer);
  }
  return result;
}

function firstString(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key]) return value[key] as string;
  }
  return undefined;
}

function firstNumber(value: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const item = value[key];
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (typeof item === "string" && item.trim() && Number.isFinite(Number(item))) return Number(item);
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
