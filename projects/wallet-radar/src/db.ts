import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Chain, Identity, TokenWalletResult, WalletLink } from "./types.js";

export class Database {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    const absolute = path.resolve(filePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    this.db = new DatabaseSync(absolute);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  beginScan(kind: string, chain: Chain, input: string): string {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    this.db.prepare(
      "INSERT INTO scans(id, kind, chain, input, status, started_at) VALUES(?, ?, ?, ?, 'running', datetime('now'))"
    ).run(id, kind, chain, input);
    return id;
  }

  finishScan(id: string, status: "completed" | "failed", summary: unknown): void {
    this.db.prepare(
      "UPDATE scans SET status=?, finished_at=datetime('now'), summary_json=? WHERE id=?"
    ).run(status, JSON.stringify(summary), id);
  }

  upsertWallet(chain: Chain, address: string, identity: Identity | null, fundedBy: unknown): void {
    this.db.prepare(
      `INSERT INTO wallets(chain, address, label, category, tags_json, identity_json, funded_by_json, updated_at)
       VALUES(?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(chain, address) DO UPDATE SET
         label=excluded.label, category=excluded.category, tags_json=excluded.tags_json,
         identity_json=excluded.identity_json, funded_by_json=excluded.funded_by_json, updated_at=datetime('now')`
    ).run(
      chain,
      address,
      identity?.name ?? null,
      identity?.category ?? null,
      JSON.stringify(identity?.tags ?? []),
      JSON.stringify(identity ?? null),
      JSON.stringify(fundedBy ?? null)
    );
  }

  upsertToken(record: {
    chain: Chain;
    address: string;
    network: string;
    chainId?: number;
    addressFormat: "base58" | "evm-0x";
    evmContract?: string;
    name?: string;
    symbol?: string;
    decimals?: number;
    totalSupply?: string;
    holderCount?: number;
    metadata: unknown;
  }): void {
    this.db.prepare(
      `INSERT INTO tokens(
        chain, address, network, chain_id, address_format, evm_contract, name, symbol,
        decimals, total_supply, holder_count, metadata_json, updated_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(chain, address) DO UPDATE SET
        network=excluded.network, chain_id=excluded.chain_id, address_format=excluded.address_format,
        evm_contract=excluded.evm_contract, name=excluded.name, symbol=excluded.symbol,
        decimals=excluded.decimals, total_supply=excluded.total_supply,
        holder_count=excluded.holder_count, metadata_json=excluded.metadata_json,
        updated_at=datetime('now')`
    ).run(
      record.chain,
      record.address,
      record.network,
      record.chainId ?? null,
      record.addressFormat,
      record.evmContract ?? null,
      record.name ?? null,
      record.symbol ?? null,
      record.decimals ?? null,
      record.totalSupply ?? null,
      record.holderCount ?? null,
      JSON.stringify(record.metadata)
    );
  }

  addWalletLink(scanId: string, link: WalletLink): void {
    this.db.prepare(
      `INSERT INTO wallet_links(scan_id, chain, source_address, candidate_address, hop, score, reasons_json, evidence_json)
       VALUES(?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(scanId, "solana", link.sourceAddress, link.candidateAddress, link.hop, link.score, JSON.stringify(link.reasons), JSON.stringify(link.evidence));
  }

  addEvidence(scanId: string, chain: Chain, subject: string, kind: string, payload: unknown, provider: string): void {
    this.db.prepare(
      "INSERT INTO evidence(scan_id, chain, subject, kind, provider, payload_json, created_at) VALUES(?, ?, ?, ?, ?, ?, datetime('now'))"
    ).run(scanId, chain, subject, kind, provider, JSON.stringify(payload));
  }

  saveTokenSnapshot(scanId: string, result: TokenWalletResult): void {
    this.db.prepare(
      `INSERT INTO wallet_token_snapshots(
        scan_id, chain, token, wallet, buy_count, sell_count, other_project_token_count,
        other_project_tokens_json, first_trade_at, last_trade_at, included, source_json, raw_json
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      scanId,
      result.chain,
      result.token,
      result.wallet,
      result.buyCount,
      result.sellCount,
      result.otherProjectTokenCount,
      JSON.stringify(result.otherProjectTokens),
      result.firstTradeAt ?? null,
      result.lastTradeAt ?? null,
      result.included ? 1 : 0,
      JSON.stringify(result.source),
      JSON.stringify(result.raw)
    );
  }

  saveProviderResponse(scanId: string, provider: string, operation: string, payload: unknown): void {
    this.db.prepare(
      "INSERT INTO provider_responses(scan_id, provider, operation, payload_json, created_at) VALUES(?, ?, ?, ?, datetime('now'))"
    ).run(scanId, provider, operation, JSON.stringify(payload));
  }

  listWalletAppearances(address: string): Array<Record<string, unknown>> {
    return this.db.prepare(
      `SELECT scan_id, chain, token, wallet, buy_count, sell_count, included, first_trade_at, last_trade_at
       FROM wallet_token_snapshots WHERE lower(wallet)=lower(?) ORDER BY created_at DESC`
    ).all(address) as Array<Record<string, unknown>>;
  }

  listRecentScans(limit = 20): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT id, kind, chain, input, status, started_at, finished_at FROM scans ORDER BY started_at DESC LIMIT ?").all(limit) as Array<Record<string, unknown>>;
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scans (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        chain TEXT NOT NULL,
        input TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        summary_json TEXT
      );

      CREATE TABLE IF NOT EXISTS wallets (
        chain TEXT NOT NULL,
        address TEXT NOT NULL,
        label TEXT,
        category TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        identity_json TEXT,
        funded_by_json TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(chain, address)
      );

      CREATE TABLE IF NOT EXISTS tokens (
        chain TEXT NOT NULL,
        address TEXT NOT NULL,
        network TEXT NOT NULL,
        chain_id INTEGER,
        address_format TEXT NOT NULL,
        evm_contract TEXT,
        name TEXT,
        symbol TEXT,
        decimals INTEGER,
        total_supply TEXT,
        holder_count INTEGER,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL,
        PRIMARY KEY(chain, address)
      );

      CREATE TABLE IF NOT EXISTS wallet_links (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scan_id TEXT NOT NULL REFERENCES scans(id),
        chain TEXT NOT NULL,
        source_address TEXT NOT NULL,
        candidate_address TEXT NOT NULL,
        hop INTEGER NOT NULL,
        score REAL NOT NULL,
        reasons_json TEXT NOT NULL,
        evidence_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS wallet_token_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scan_id TEXT NOT NULL REFERENCES scans(id),
        chain TEXT NOT NULL,
        token TEXT NOT NULL,
        wallet TEXT NOT NULL,
        buy_count INTEGER NOT NULL,
        sell_count INTEGER NOT NULL,
        other_project_token_count INTEGER NOT NULL,
        other_project_tokens_json TEXT NOT NULL,
        first_trade_at TEXT,
        last_trade_at TEXT,
        included INTEGER NOT NULL,
        source_json TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scan_id TEXT NOT NULL REFERENCES scans(id),
        chain TEXT NOT NULL,
        subject TEXT NOT NULL,
        kind TEXT NOT NULL,
        provider TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS provider_responses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scan_id TEXT NOT NULL REFERENCES scans(id),
        provider TEXT NOT NULL,
        operation TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_wallet_snapshots_wallet ON wallet_token_snapshots(chain, wallet);
      CREATE INDEX IF NOT EXISTS idx_wallet_snapshots_token ON wallet_token_snapshots(chain, token);
      CREATE INDEX IF NOT EXISTS idx_links_candidate ON wallet_links(chain, candidate_address);
    `);
  }
}
