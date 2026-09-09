import type { AppConfig } from "../config.js";
import { fetchJson, withQuery } from "../lib/http.js";

type JsonFetcher = (url: string, init?: RequestInit, label?: string) => Promise<unknown>;

export type RobinhoodTokenInfo = {
  address: string;
  name?: string;
  symbol?: string;
  decimals?: number;
  totalSupply?: string;
  holdersCount?: number;
  tokenType?: string;
  reputation?: string;
  raw: Record<string, unknown>;
};

export type RobinhoodTokenHolder = {
  address: string;
  value: string;
  isContract: boolean;
  isVerified: boolean;
  isScam: boolean;
  name?: string;
  proxyType?: string;
  raw: Record<string, unknown>;
};

export type RobinhoodTokenTransfer = {
  transactionHash: string;
  blockNumber?: number;
  logIndex?: number;
  timestamp?: string;
  from?: string;
  to?: string;
  value?: string;
  decimals?: number;
  method?: string;
  raw: Record<string, unknown>;
};

export type BlockscoutPage<T> = {
  items: T[];
  rawResponses: Record<string, unknown>[];
  hasMore: boolean;
};

export class RobinhoodBlockscoutProvider {
  private readonly baseUrl: string;

  constructor(
    config: AppConfig,
    private readonly request: JsonFetcher = (url, init, label) => fetchJson(url, init, label)
  ) {
    this.baseUrl = config.robinhoodBlockscoutUrl.replace(/\/+$/, "");
  }

  async health(): Promise<{ indexedBlocks: number; indexedTransactions: number }> {
    const raw = asRecord(await this.request(`${this.baseUrl}/api/v2/stats`, {}, "Robinhood Blockscout stats"));
    return {
      indexedBlocks: firstInteger(raw, ["total_blocks", "blocks_count"]) ?? 0,
      indexedTransactions: firstInteger(raw, ["total_transactions", "transactions_count"]) ?? 0
    };
  }

  async tokenInfo(contract: string): Promise<RobinhoodTokenInfo> {
    const address = assertEvmAddress(contract);
    const raw = asRecord(await this.request(
      `${this.baseUrl}/api/v2/tokens/${address}`,
      {},
      "Robinhood Blockscout token info"
    ));
    return normalizeTokenInfo(raw, address);
  }

  async tokenHolders(contract: string, limit = 100, maxPages = 10): Promise<BlockscoutPage<RobinhoodTokenHolder>> {
    const address = assertEvmAddress(contract);
    return this.collectPages(
      `${this.baseUrl}/api/v2/tokens/${address}/holders`,
      limit,
      maxPages,
      normalizeHolder,
      "Robinhood Blockscout token holders"
    );
  }

  async tokenTransfers(contract: string, limit = 50, maxPages = 10): Promise<BlockscoutPage<RobinhoodTokenTransfer>> {
    const address = assertEvmAddress(contract);
    return this.collectPages(
      `${this.baseUrl}/api/v2/tokens/${address}/transfers`,
      limit,
      maxPages,
      normalizeTransfer,
      "Robinhood Blockscout token transfers"
    );
  }

  private async collectPages<T>(
    baseUrl: string,
    requestedLimit: number,
    requestedMaxPages: number,
    normalize: (row: Record<string, unknown>) => T | undefined,
    label: string
  ): Promise<BlockscoutPage<T>> {
    const limit = boundedInteger(requestedLimit, 1, 1_000, "limit");
    const maxPages = boundedInteger(requestedMaxPages, 1, 100, "maxPages");
    const items: T[] = [];
    const rawResponses: Record<string, unknown>[] = [];
    let cursor: Record<string, string | number | boolean | undefined> = {};
    let hasMore = false;
    let previousCursor = "";

    for (let page = 0; page < maxPages && items.length < limit; page += 1) {
      const raw = asRecord(await this.request(withQuery(baseUrl, cursor), {}, `${label} page ${page + 1}`));
      rawResponses.push(raw);
      for (const row of asRecords(raw.items)) {
        const value = normalize(row);
        if (value !== undefined) items.push(value);
        if (items.length >= limit) break;
      }
      const next = scalarCursor(raw.next_page_params);
      const serialized = JSON.stringify(next);
      hasMore = Object.keys(next).length > 0;
      if (!hasMore || serialized === previousCursor) break;
      previousCursor = serialized;
      cursor = next;
    }

    return { items: items.slice(0, limit), rawResponses, hasMore };
  }
}

export function normalizeTokenInfo(raw: Record<string, unknown>, fallbackAddress: string): RobinhoodTokenInfo {
  return {
    address: firstString(raw, ["address_hash", "address"]) ?? fallbackAddress,
    name: firstString(raw, ["name"]),
    symbol: firstString(raw, ["symbol"]),
    decimals: firstInteger(raw, ["decimals"]),
    totalSupply: firstString(raw, ["total_supply"]),
    holdersCount: firstInteger(raw, ["holders_count", "holder_count"]),
    tokenType: firstString(raw, ["type"]),
    reputation: firstString(raw, ["reputation"]),
    raw
  };
}

function normalizeHolder(row: Record<string, unknown>): RobinhoodTokenHolder | undefined {
  const addressRecord = asRecord(row.address ?? row.address_hash);
  const address = firstString(addressRecord, ["hash"]) ?? firstString(row, ["address_hash"]);
  const value = firstString(row, ["value"]);
  if (!address || !value) return undefined;
  return {
    address,
    value,
    isContract: addressRecord.is_contract === true,
    isVerified: addressRecord.is_verified === true,
    isScam: addressRecord.is_scam === true,
    name: firstString(addressRecord, ["name"]),
    proxyType: firstString(addressRecord, ["proxy_type"]),
    raw: row
  };
}

function normalizeTransfer(row: Record<string, unknown>): RobinhoodTokenTransfer | undefined {
  const transactionHash = firstString(row, ["transaction_hash"]);
  if (!transactionHash) return undefined;
  const total = asRecord(row.total);
  return {
    transactionHash,
    blockNumber: firstInteger(row, ["block_number"]),
    logIndex: firstInteger(row, ["log_index"]),
    timestamp: firstString(row, ["timestamp"]),
    from: firstString(asRecord(row.from), ["hash"]),
    to: firstString(asRecord(row.to), ["hash"]),
    value: firstString(total, ["value"]),
    decimals: firstInteger(total, ["decimals"]),
    method: firstString(row, ["method"]),
    raw: row
  };
}

function assertEvmAddress(value: string): string {
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) throw new Error("Geçerli bir EVM token contract adresi gerekli.");
  return value;
}

function scalarCursor(value: unknown): Record<string, string | number | boolean | undefined> {
  const result: Record<string, string | number | boolean | undefined> = {};
  for (const [key, item] of Object.entries(asRecord(value))) {
    if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") result[key] = item;
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function firstString(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const item = value[key];
    if (typeof item === "string" && item.length > 0) return item;
    if (typeof item === "number" && Number.isFinite(item)) return String(item);
  }
  return undefined;
}

function firstInteger(value: Record<string, unknown>, keys: string[]): number | undefined {
  const item = firstString(value, keys);
  if (item === undefined) return undefined;
  const parsed = Number(item.replaceAll(",", ""));
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} ${minimum}-${maximum} aralığında bir tam sayı olmalı.`);
  }
  return value;
}
