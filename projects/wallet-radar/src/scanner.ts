import type { AppConfig } from "./config.js";
import { Database } from "./db.js";
import { GmgnProvider } from "./providers/gmgn.js";
import { HeliusProvider } from "./providers/helius.js";
import type { Chain, Identity, TokenWalletResult, TransferRecord, TransferValueTotal, WalletLink, WalletScanSummary, TokenScanSummary } from "./types.js";

const SOL_MINT = "So11111111111111111111111111111111111111112";
const QUOTE_MINTS = new Set([
  SOL_MINT,
  "So11111111111111111111111111111111111111111",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" // USDT
]);
const ROBINHOOD_QUOTE_TOKENS = new Set([
  "0x0bd7d308f8e1639fab988df18a8011f41eacad73" // WETH
]);

export class WalletScanner {
  constructor(private readonly helius: HeliusProvider, private readonly db: Database) {}

  async scan(
    inputAddress: string,
    options: number | { maxHops?: number; transferPages?: number; candidateLimit?: number } = 2
  ): Promise<WalletScanSummary> {
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(inputAddress)) {
      throw new Error("Geçerli bir Solana base58 cüzdan adresi gerekli.");
    }
    const scanOptions = typeof options === "number" ? { maxHops: options } : options;
    const maxHops = boundedInteger(scanOptions.maxHops ?? 2, 0, 2, "--hops");
    const transferPages = boundedInteger(scanOptions.transferPages ?? 5, 1, 10, "--pages");
    const candidateLimit = boundedInteger(scanOptions.candidateLimit ?? 25, 1, 100, "--candidates");
    const scanId = this.db.beginScan("wallet-links", "solana", inputAddress);
    const links: WalletLink[] = [];
    const candidateCountsByHop: Record<string, number> = {};
    const queue: Array<{ address: string; hop: number }> = [{ address: inputAddress, hop: 0 }];
    const visited = new Set<string>();
    const scheduled = new Set<string>([inputAddress]);
    const identityCache = new Map<string, Identity | null>();
    let secondHopExpansions = 0;
    let spamTransfersExcluded = 0;
    const warnings: WalletScanSummary["warnings"] = [];
    const getIdentity = async (address: string): Promise<Identity | null> => {
      if (identityCache.has(address)) return identityCache.get(address) ?? null;
      const identity = await this.helius.getIdentity(address);
      identityCache.set(address, identity);
      return identity;
    };
    try {
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current.address) || current.hop > maxHops) continue;
        visited.add(current.address);

        const [identity, fundedBy, transferResult] = await Promise.all([
          getIdentity(current.address),
          this.helius.getFundedBy(current.address),
          this.helius.getTransfersWithRaw(current.address, current.hop === 0 ? transferPages : Math.min(2, transferPages))
            .then((value) => ({ value }))
            .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }))
        ]);
        const transferBatch = "value" in transferResult
          ? transferResult.value
          : { transfers: [], rawResponses: [] };
        if ("error" in transferResult) {
          const warning = { address: current.address, provider: "helius", operation: "wallet-transfers", error: transferResult.error };
          warnings.push(warning);
          this.db.addEvidence(scanId, "solana", current.address, "provider-warning", warning, "helius");
          this.db.saveProviderResponse(scanId, "helius", `wallet-transfers:${current.address}:error`, warning);
        }
        spamTransfersExcluded += transferBatch.transfers.filter(isPossibleSpamOrAirdrop).length;
        this.db.upsertWallet("solana", current.address, identity, fundedBy);
        this.db.addEvidence(scanId, "solana", current.address, "wallet-profile", { identity, fundedBy }, "helius");
        this.db.addEvidence(scanId, "solana", current.address, "transfers", transferBatch.transfers, "helius");
        this.db.saveProviderResponse(scanId, "helius", `wallet-identity:${current.address}`, identity);
        this.db.saveProviderResponse(scanId, "helius", `wallet-funded-by:${current.address}`, fundedBy);
        transferBatch.rawResponses.forEach((response, index) => {
          this.db.saveProviderResponse(scanId, "helius", `wallet-transfers:${current.address}:page-${index + 1}`, response);
        });

        if (current.hop >= maxHops) continue;

        const candidates = rankCandidates(current.address, transferBatch.transfers, fundedBy);
        const limit = current.hop === 0 ? candidateLimit : Math.min(10, candidateLimit);
        for (const candidate of candidates.slice(0, limit)) {
          const candidateIdentity = await getIdentity(candidate.address);
          const link = scoreLink(current.address, candidate.address, current.hop + 1, candidate, candidateIdentity);
          links.push(link);
          candidateCountsByHop[String(link.hop)] = (candidateCountsByHop[String(link.hop)] ?? 0) + 1;
          this.db.upsertWallet("solana", candidate.address, candidateIdentity, null);
          this.db.addWalletLink(scanId, link);
          this.db.addEvidence(scanId, "solana", candidate.address, "link", link, "helius");
          if (current.hop + 1 < maxHops && link.score >= 45 && !scheduled.has(candidate.address)) {
            scheduled.add(candidate.address);
            queue.push({ address: candidate.address, hop: current.hop + 1 });
            if (current.hop === 0) secondHopExpansions += 1;
          }
        }
      }
      const summary = {
        scanId,
        chain: "solana" as const,
        inputAddress,
        links,
        candidateCountsByHop,
        secondHopExpansions,
        spamTransfersExcluded,
        warnings
      };
      this.db.finishScan(scanId, "completed", summary);
      return summary;
    } catch (error) {
      this.db.finishScan(scanId, "failed", { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
}

type TokenCandidateSource = "holder" | "trader" | "helius-holder";

type TokenCandidate = {
  address: string;
  sources: TokenCandidateSource[];
  metrics: TokenWalletResult["candidateMetrics"];
  raw: Record<string, unknown>;
};

type CandidateBatch = {
  candidates: TokenCandidate[];
  holdersConsidered: number;
  tradersConsidered: number;
  duplicateCandidatesRemoved: number;
  poolCandidatesExcluded: number;
  warnings: Array<{ provider: string; operation: string; error: string }>;
};

type NormalizedWalletEvent = {
  signature?: string;
  timestamp: number;
  kind: "buy" | "sell";
  mint: string;
  symbol?: string;
  provider: "gmgn" | "helius";
};

type TokenScanOptions = {
  stopAtBuys?: number;
  candidateLimit?: number;
  sourceLimit?: number;
  holderLimit?: number;
  traderLimit?: number;
  weeklyMinBuys?: number;
  activityLimit?: number;
  activityPages?: number;
  historyPages?: number;
  overallHistoryPages?: number;
  concurrency?: number;
};

type GmgnWalletStats = {
  weeklyBuyCount?: number;
  weeklySellCount?: number;
  weeklyTokenCount?: number;
  realizedProfit?: number;
  winrate?: number;
};

export class TokenScanner {
  private readonly gmgn: GmgnProvider;

  constructor(private readonly config: AppConfig, private readonly helius: HeliusProvider, db: Database) {
    this.gmgn = new GmgnProvider(config);
    this.db = db;
  }

  private readonly db: Database;

  async scan(token: string, chain: Chain = "solana", options: TokenScanOptions = {}): Promise<TokenScanSummary> {
    if (chain === "solana" && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(token)) {
      throw new Error("Geçerli bir Solana token mint adresi gerekli.");
    }
    if (chain === "robinhood" && !/^0x[a-fA-F0-9]{40}$/.test(token)) {
      throw new Error("Geçerli bir Robinhood EVM token contract adresi gerekli.");
    }
    const stopAtBuys = boundedInteger(options.stopAtBuys ?? 51, 2, 1_000, "--stop-at-buys");
    const weeklyMinBuys = boundedInteger(options.weeklyMinBuys ?? 1, 0, stopAtBuys - 1, "--weekly-min-buys");
    const candidateLimit = boundedInteger(options.candidateLimit ?? 150, 1, 150, "--limit");
    const legacySourceLimit = options.sourceLimit === undefined
      ? undefined
      : boundedInteger(options.sourceLimit, 1, 100, "--source-limit");
    const holderLimit = boundedInteger(options.holderLimit ?? legacySourceLimit ?? 100, 1, 100, "--holder-limit");
    const traderLimit = boundedInteger(options.traderLimit ?? legacySourceLimit ?? 50, 1, 100, "--trader-limit");
    const activityLimit = boundedInteger(options.activityLimit ?? 200, 1, 500, "--activity-limit");
    const activityPages = boundedInteger(options.activityPages ?? 25, 1, 100, "--activity-pages");
    const historyPages = boundedInteger(options.historyPages ?? 10, 1, 10, "--history-pages");
    const overallHistoryPages = boundedInteger(options.overallHistoryPages ?? 1_000, 1, 10_000, "--overall-history-pages");
    const concurrency = boundedInteger(options.concurrency ?? 3, 1, 6, "--concurrency");
    const scanId = this.db.beginScan("token-holder-analysis", chain, token);
    const warnings: TokenScanSummary["warnings"] = [];
    let tokenName: string | undefined;
    let tokenSymbol: string | undefined;
    let tokenCreatedAtMs: number | undefined;
    let reportedHolderCount: number | undefined;
    try {
      try {
        const tokenInfo = await this.gmgn.tokenInfo(chain === "solana" ? "sol" : "robinhood", token);
        this.db.saveProviderResponse(scanId, "gmgn", `token-info:${token}`, tokenInfo);
        const info = asRecord(tokenInfo);
        tokenName = firstString(info, ["name"]);
        tokenSymbol = firstString(info, ["symbol"]);
        tokenCreatedAtMs = toTimestamp(firstValue(info, ["creation_timestamp", "open_timestamp"]));
        reportedHolderCount = firstNumber(info, ["holder_count"]) ?? firstNumber(asRecord(info.stat), ["holder_count"]);
      } catch (error) {
        warnings.push({ provider: "gmgn", operation: "token-info", error: errorMessage(error) });
      }
      const candidateBatch = await this.getCandidates(token, chain, holderLimit, traderLimit, scanId);
      warnings.push(...candidateBatch.warnings);
      const results = await mapWithConcurrency(candidateBatch.candidates.slice(0, candidateLimit), concurrency, async (candidate) => {
        const result = await this.analyzeWallet(
          token,
          candidate,
          chain,
          weeklyMinBuys,
          stopAtBuys,
          activityLimit,
          activityPages,
          historyPages,
          overallHistoryPages,
          scanId
        );
        this.db.saveTokenSnapshot(scanId, result);
        this.db.addEvidence(scanId, chain, candidate.address, "token-wallet-analysis", result, result.source.join(",") || "none");
        return result;
      });
      const included = results.filter((item) => item.included);
      const summary: TokenScanSummary = {
        scanId,
        chain,
        token,
        tokenName,
        tokenSymbol,
        tokenCreatedAt: tokenCreatedAtMs ? new Date(tokenCreatedAtMs).toISOString() : undefined,
        reportedHolderCount,
        holdersConsidered: candidateBatch.holdersConsidered,
        tradersConsidered: candidateBatch.tradersConsidered,
        duplicateCandidatesRemoved: candidateBatch.duplicateCandidatesRemoved,
        poolCandidatesExcluded: candidateBatch.poolCandidatesExcluded,
        walletsAnalyzed: results.length,
        walletsIncluded: included.length,
        warnings,
        wallets: results
      };
      this.db.finishScan(scanId, "completed", summary);
      return summary;
    } catch (error) {
      this.db.finishScan(scanId, "failed", { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  private async getCandidates(
    token: string,
    chain: Chain,
    holderLimit: number,
    traderLimit: number,
    scanId: string
  ): Promise<CandidateBatch> {
    const gmgnChain = chain === "solana" ? "sol" : "robinhood";
    const candidates = new Map<string, TokenCandidate>();
    const holderAddresses = new Set<string>();
    const traderAddresses = new Set<string>();
    const warnings: CandidateBatch["warnings"] = [];
    let duplicateCandidatesRemoved = 0;
    let poolCandidatesExcluded = 0;
    try {
      const holders = await this.gmgn.tokenHolders(gmgnChain, token, holderLimit);
      this.db.saveProviderResponse(scanId, "gmgn", `token-holders:${token}`, holders);
      const stats = collectTokenCandidates(holders, "holder", candidates, holderAddresses, chain);
      duplicateCandidatesRemoved += stats.duplicates;
      poolCandidatesExcluded += stats.poolsExcluded;
    } catch (error) {
      warnings.push({ provider: "gmgn", operation: "token-holders", error: errorMessage(error) });
    }
    try {
      const traders = await this.gmgn.tokenTraders(gmgnChain, token, traderLimit, "profit", "desc");
      this.db.saveProviderResponse(scanId, "gmgn", `token-traders:${token}`, traders);
      const stats = collectTokenCandidates(traders, "trader", candidates, traderAddresses, chain);
      duplicateCandidatesRemoved += stats.duplicates;
      poolCandidatesExcluded += stats.poolsExcluded;
    } catch (error) {
      warnings.push({ provider: "gmgn", operation: "token-traders", error: errorMessage(error) });
    }
    if (candidates.size === 0 && chain === "solana") {
      const tokenAccounts = await this.helius.getTokenAccountsByMint(token, false, 1, holderLimit);
      this.db.saveProviderResponse(scanId, "helius", `token-accounts:${token}`, tokenAccounts);
      for (const item of tokenAccounts.slice(0, holderLimit)) {
        const owner = firstString(item, ["owner", "address"]);
        if (!owner || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(owner)) continue;
        holderAddresses.add(owner);
        candidates.set(owner, {
          address: owner,
          sources: ["helius-holder"],
          metrics: { balance: firstNumber(item, ["amount", "balance"]), rankScore: 0 },
          raw: { "helius-holder": item }
        });
      }
    }
    if (candidates.size === 0) {
      throw new Error(`GMGN ${chain} holder/trader aday listesi boş döndü.`);
    }
    const sorted = [...candidates.values()]
      .map((candidate) => ({ ...candidate, metrics: { ...candidate.metrics, rankScore: candidateRankScore(candidate.metrics) } }))
      .sort((a, b) => Number(b.sources.includes("holder")) - Number(a.sources.includes("holder")) || b.metrics.rankScore - a.metrics.rankScore);
    return {
      candidates: sorted,
      holdersConsidered: holderAddresses.size,
      tradersConsidered: traderAddresses.size,
      duplicateCandidatesRemoved,
      poolCandidatesExcluded,
      warnings
    };
  }

  private async analyzeWallet(
    token: string,
    candidate: TokenCandidate,
    chain: Chain,
    weeklyMinBuys: number,
    weeklyMaxBuysExclusive: number,
    activityLimit: number,
    activityPages: number,
    historyPages: number,
    overallHistoryPages: number,
    scanId: string
  ): Promise<TokenWalletResult> {
    const source: string[] = [];
    const providerWarnings: Array<{ provider: string; error: string }> = [];
    let stats: GmgnWalletStats = {};
    let rawStats: unknown = null;
    try {
      rawStats = await this.gmgn.portfolioStats(chain === "solana" ? "sol" : "robinhood", candidate.address, "7d");
      stats = normalizeGmgnWalletStats(rawStats, candidate.address);
      source.push("gmgn");
      this.db.saveProviderResponse(scanId, "gmgn", `portfolio-stats-7d:${candidate.address}`, rawStats);
    } catch (error) {
      const detail = errorMessage(error);
      providerWarnings.push({ provider: "gmgn", error: detail });
      this.db.saveProviderResponse(scanId, "gmgn", `portfolio-stats-7d:${candidate.address}:error`, { error: detail });
    }

    const weeklyBuyCount = stats.weeklyBuyCount;
    const weeklySellCount = stats.weeklySellCount;
    const exclusionReasons: string[] = [];
    if (weeklyBuyCount === undefined) exclusionReasons.push("weekly_buy_count_unavailable");
    if (weeklyBuyCount !== undefined && weeklyBuyCount < weeklyMinBuys) exclusionReasons.push("weekly_buy_count_below_minimum");
    if (weeklyBuyCount !== undefined && weeklyBuyCount >= weeklyMaxBuysExclusive) exclusionReasons.push("weekly_buy_count_51_or_more");

    const otherTokenEvidence: Array<{
      mint: string;
      symbol?: string;
      signature?: string;
      timestamp: string;
      kind: "buy" | "sell";
    }> = [];
    let activityPagesScanned = 0;
    let activityExhausted = false;
    let activityProviderError = false;
    let nextCursor: string | undefined;
    let overallCoverage: "not-checked" | "found" | "complete" | "safety-limit" | "provider-error" = "not-checked";
    if (exclusionReasons.length === 0) {
      let cursor: string | undefined;
      for (let page = 0; page < activityPages; page += 1) {
        try {
          const activity = await this.gmgn.portfolioActivity(chain === "solana" ? "sol" : "robinhood", candidate.address, {
            limit: activityLimit,
            cursor,
            types: ["buy", "sell"]
          });
          source.push("gmgn");
          activityPagesScanned += 1;
          this.db.saveProviderResponse(scanId, "gmgn", `portfolio-activity:${candidate.address}:page-${page + 1}`, activity);
          const events = normalizeGmgnActivity(activity, 0);
          for (const event of events) {
            if (sameToken(event.mint, token, chain) || isQuoteToken(event.mint, chain)) continue;
            if (otherTokenEvidence.some((item) => item.mint === event.mint && item.signature === event.signature)) continue;
            otherTokenEvidence.push({
              mint: event.mint,
              symbol: event.symbol,
              signature: event.signature,
              timestamp: new Date(event.timestamp).toISOString(),
              kind: event.kind
            });
          }
          if (otherTokenEvidence.length > 0) break;
          const next = extractNextCursor(activity);
          nextCursor = next;
          if (!next || next === cursor || events.length === 0) {
            activityExhausted = true;
            break;
          }
          cursor = next;
        } catch (error) {
          activityProviderError = true;
          const detail = errorMessage(error);
          providerWarnings.push({ provider: "gmgn", error: detail });
          this.db.saveProviderResponse(scanId, "gmgn", `portfolio-activity:${candidate.address}:page-${page + 1}:error`, { error: detail });
          break;
        }
      }
      if (otherTokenEvidence.length > 0) overallCoverage = "found";
      else if (activityExhausted) overallCoverage = "complete";
      else if (activityProviderError) overallCoverage = "provider-error";
      else if (activityPagesScanned >= activityPages) overallCoverage = "safety-limit";
    }

    let heliusVerification: Record<string, unknown> = { status: "not-needed" };
    let overallHistoryPagesScanned = 0;
    if (chain === "solana" && exclusionReasons.length === 0 && otherTokenEvidence.length === 0) {
      let before: string | undefined;
      try {
        for (let pageNumber = 0; pageNumber < overallHistoryPages; pageNumber += 1) {
          const page = await this.helius.getHistoryPage(candidate.address, { type: "SWAP", limit: 100, before });
          overallHistoryPagesScanned += 1;
          this.db.saveProviderResponse(scanId, "helius", `wallet-history-overall:${candidate.address}:page-${pageNumber + 1}`, page.raw);
          const heliusEvents = normalizeHeliusHistory(page.data, 0);
          const newEvidence = heliusEvents.filter((event) => event.mint !== token && !QUOTE_MINTS.has(event.mint));
          for (const event of newEvidence) {
            if (otherTokenEvidence.some((item) => item.mint === event.mint && item.signature === event.signature)) continue;
            otherTokenEvidence.push({
              mint: event.mint,
              signature: event.signature,
              timestamp: new Date(event.timestamp).toISOString(),
              kind: event.kind
            });
          }
          if (newEvidence.length > 0) {
            overallCoverage = "found";
            heliusVerification = {
              status: "other-project-token-found-in-overall-history",
              historyEventsChecked: heliusEvents.length,
              overallHistoryPagesScanned
            };
            break;
          }
          if (!page.nextCursor || page.data.length === 0 || page.hasMore === false) {
            overallCoverage = "complete";
            heliusVerification = {
              status: "overall-history-exhausted-without-other-project-token",
              historyEventsChecked: heliusEvents.length,
              overallHistoryPagesScanned
            };
            break;
          }
          before = page.nextCursor;
        }
        if (overallCoverage === "not-checked") {
          overallCoverage = "safety-limit";
          heliusVerification = {
            status: "overall-history-safety-limit-reached",
            overallHistoryPagesScanned,
            maxPages: overallHistoryPages
          };
        }
        source.push("helius");
      } catch (error) {
        const detail = errorMessage(error);
        providerWarnings.push({ provider: "helius", error: detail });
        this.db.saveProviderResponse(scanId, "helius", `wallet-history-overall:${candidate.address}:error`, { error: detail });
        overallCoverage = "provider-error";
        heliusVerification = { status: "overall-history-unavailable", error: detail, overallHistoryPagesScanned };
      }
    } else if (chain === "solana" && otherTokenEvidence.length > 0) {
      try {
        const history = await this.helius.getHistory(candidate.address, { type: "SWAP", maxPages: historyPages, limit: 100 });
        source.push("helius");
        this.db.saveProviderResponse(scanId, "helius", `wallet-history-verification:${candidate.address}`, history);
        const heliusEvents = normalizeHeliusHistory(history, 0);
        const evidenceSignatures = new Set(otherTokenEvidence.map((item) => item.signature).filter(Boolean));
        const evidenceMints = new Set(otherTokenEvidence.map((item) => item.mint));
        const signatureMatches = heliusEvents.filter((event) => event.signature && evidenceSignatures.has(event.signature)).length;
        const mintMatches = heliusEvents.filter((event) => evidenceMints.has(event.mint)).length;
        heliusVerification = {
          status: signatureMatches > 0 ? "signature-matched" : mintMatches > 0 ? "mint-seen-in-history-window" : "not-seen-in-verification-window",
          signatureMatches,
          mintMatches,
          historyEventsChecked: heliusEvents.length
        };
      } catch (error) {
        const detail = errorMessage(error);
        providerWarnings.push({ provider: "helius", error: detail });
        this.db.saveProviderResponse(scanId, "helius", `wallet-history:${candidate.address}:error`, { error: detail });
        heliusVerification = { status: "unavailable", error: detail };
      }
    }
    if (exclusionReasons.length === 0 && otherTokenEvidence.length === 0) {
      exclusionReasons.push(overallCoverage === "complete" ? "no_other_project_token_overall" : "other_project_token_overall_incomplete");
    }
    const otherTokens = [...new Set(otherTokenEvidence.map((item) => item.mint))];
    const evidenceTimes = otherTokenEvidence.map((item) => Date.parse(item.timestamp)).filter(Number.isFinite);
    return {
      wallet: candidate.address,
      chain,
      token,
      candidateSources: candidate.sources,
      candidateMetrics: candidate.metrics,
      countBasis: ["gmgn-wallet-7d-stats"],
      buyCount: weeklyBuyCount ?? 0,
      sellCount: weeklySellCount ?? 0,
      weeklyBuyCount,
      weeklySellCount,
      weeklyTokenCount: stats.weeklyTokenCount,
      otherProjectTokenCount: otherTokens.length,
      otherProjectTokens: otherTokens,
      firstTradeAt: evidenceTimes.length > 0 ? new Date(Math.min(...evidenceTimes)).toISOString() : undefined,
      lastTradeAt: evidenceTimes.length > 0 ? new Date(Math.max(...evidenceTimes)).toISOString() : undefined,
      included: exclusionReasons.length === 0 && otherTokens.length > 0,
      exclusionReasons,
      source: [...new Set(source)],
      raw: {
        rule: {
          weeklyBuyMinimum: weeklyMinBuys,
          weeklyBuyMaximumExclusive: weeklyMaxBuysExclusive,
          otherProjectTokenWindow: "overall"
        },
        normalizedStats: stats,
        activityCoverage: {
          pagesScanned: activityPagesScanned,
          exhausted: activityExhausted,
          nextCursorAvailable: Boolean(nextCursor)
        },
        overallHistoryCoverage: {
          status: overallCoverage,
          pagesScanned: overallHistoryPagesScanned,
          maxPages: overallHistoryPages
        },
        otherTokenEvidence,
        heliusVerification,
        providerWarnings
      }
    };
  }
}

type RankedCandidate = {
  address: string;
  transfers: TransferRecord[];
  funding?: Record<string, unknown>;
};

function rankCandidates(source: string, transfers: TransferRecord[], fundedBy: Record<string, unknown> | null): RankedCandidate[] {
  const grouped = new Map<string, Map<string, TransferRecord>>();
  for (const transfer of transfers) {
    const addresses = new Set(
      [transfer.counterparty, transfer.from, transfer.to].filter((item): item is string => Boolean(item && item !== source))
    );
    for (const address of addresses) {
      const rows = grouped.get(address) ?? new Map<string, TransferRecord>();
      rows.set(transferIdentity(transfer), transfer);
      grouped.set(address, rows);
    }
  }
  const candidates = new Map<string, RankedCandidate>(
    [...grouped.entries()].map(([address, rows]) => [address, { address, transfers: [...rows.values()] }])
  );
  const funder = fundedBy ? firstString(fundedBy, ["funder", "address", "source"]) : undefined;
  if (funder && funder !== source) {
    const candidate = candidates.get(funder) ?? { address: funder, transfers: [] };
    candidate.funding = fundedBy ?? undefined;
    candidates.set(funder, candidate);
  }
  return [...candidates.values()]
    .filter((candidate) => Boolean(candidate.funding) || candidate.transfers.some((transfer) => !isPossibleSpamOrAirdrop(transfer)))
    .sort((a, b) => scoreCandidate(b) - scoreCandidate(a));
}

function scoreCandidate(candidate: RankedCandidate): number {
  let score = candidate.transfers.filter((transfer) => !isPossibleSpamOrAirdrop(transfer)).length * 2;
  if (candidate.funding) score += 25;
  if (hasMeaningfulValue(candidate.transfers, candidate.funding)) score += 15;
  if (/centralized exchange|exchange|binance|coinbase|kraken|okx|bybit/i.test(fundingLabel(candidate.funding))) score += 30;
  return score;
}

function scoreLink(source: string, candidate: string, hop: number, candidateTransfer: RankedCandidate, identity: Identity | null): WalletLink {
  const reasons: string[] = [];
  const meaningfulTransfers = candidateTransfer.transfers.filter((transfer) => !isPossibleSpamOrAirdrop(transfer));
  let score = Math.min(30, meaningfulTransfers.length * 4);
  if (candidateTransfer.funding) {
    score += 25;
    reasons.push("initial_funder");
  }
  if (hasMeaningfulValue(meaningfulTransfers, candidateTransfer.funding)) {
    score += 15;
    reasons.push("meaningful_transfer_value");
  }
  const label = candidateLabel(identity, candidateTransfer.funding);
  if (/centralized exchange|exchange|binance|coinbase|kraken|okx|bybit/i.test(label ?? "")) {
    score += 45;
    reasons.push("known_exchange_or_deposit_label");
  }
  if (/deposit/i.test(label ?? "")) {
    score += 20;
    reasons.push("deposit_address_label");
  }
  if (hop === 2) score -= 5;
  if (reasons.length === 0) reasons.push("transfer_counterparty");
  const signatures = [...new Set([
    ...meaningfulTransfers.map((transfer) => transfer.signature),
    candidateTransfer.funding ? firstString(candidateTransfer.funding, ["signature"]) : undefined
  ].filter((item): item is string => Boolean(item)))];
  const totalValue = aggregateTransferValues(meaningfulTransfers, candidateTransfer.funding);
  return {
    sourceAddress: source,
    candidateAddress: candidate,
    hop,
    score: Math.max(0, Math.min(100, score)),
    reasons,
    label,
    signatures,
    totalValue,
    evidence: { identity, funding: candidateTransfer.funding ?? null, transfers: meaningfulTransfers, totalValue }
  };
}

function candidateLabel(identity: Identity | null, funding?: Record<string, unknown>): string | undefined {
  const parts = [
    identity?.name,
    identity?.type,
    identity?.category,
    ...(identity?.tags ?? []),
    funding ? firstString(funding, ["funderName", "name", "label"]) : undefined,
    funding ? firstString(funding, ["funderType", "type", "category"]) : undefined
  ].filter((item): item is string => Boolean(item && !/^unknown$/i.test(item)));
  return [...new Set(parts)].join(" | ") || undefined;
}

function fundingLabel(funding?: Record<string, unknown>): string {
  if (!funding) return "";
  return [
    firstString(funding, ["funderName", "name", "label"]),
    firstString(funding, ["funderType", "type", "category"])
  ].filter(Boolean).join(" ");
}

function aggregateTransferValues(transfers: TransferRecord[], funding?: Record<string, unknown>): TransferValueTotal[] {
  const totals = new Map<string, TransferValueTotal>();
  const rows: Array<{ mint?: string; symbol?: string; amount?: number }> = transfers.map((transfer) => ({
    mint: transfer.mint,
    symbol: transfer.symbol,
    amount: transfer.amount
  }));
  if (funding) {
    rows.push({
      mint: firstString(funding, ["mint", "tokenMint"]),
      symbol: firstString(funding, ["symbol", "tokenSymbol"]),
      amount: firstNumber(funding, ["amount", "tokenAmount"])
    });
  }
  for (const row of rows) {
    if (row.amount === undefined) continue;
    const key = row.mint ?? row.symbol ?? "unknown";
    const existing = totals.get(key) ?? { mint: row.mint, symbol: row.symbol, amount: 0, transferCount: 0 };
    existing.amount += row.amount;
    existing.transferCount += 1;
    totals.set(key, existing);
  }
  return [...totals.values()];
}

function hasMeaningfulValue(transfers: TransferRecord[], funding?: Record<string, unknown>): boolean {
  if (transfers.some(isMeaningfulTransfer)) return true;
  if (!funding) return false;
  return isMeaningfulTransfer({
    mint: firstString(funding, ["mint", "tokenMint"]),
    symbol: firstString(funding, ["symbol", "tokenSymbol"]),
    amount: firstNumber(funding, ["amount", "tokenAmount"]),
    raw: funding
  });
}

function isMeaningfulTransfer(transfer: TransferRecord): boolean {
  const usd = transfer.amountUsd ?? transfer.valueUsd;
  if (usd !== undefined && usd >= 50) return true;
  if (transfer.amount === undefined) return false;
  if (transfer.mint === SOL_MINT || transfer.mint === "So11111111111111111111111111111111111111111" || transfer.symbol === "SOL") {
    return transfer.amount >= 0.1;
  }
  if (transfer.mint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" || transfer.mint === "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB") {
    return transfer.amount >= 50;
  }
  return false;
}

function isPossibleSpamOrAirdrop(transfer: TransferRecord): boolean {
  return transfer.direction === "in"
    && !transfer.symbol
    && transfer.decimals === 0
    && (transfer.amount ?? 0) >= 1_000_000;
}

function transferIdentity(transfer: TransferRecord): string {
  return [
    transfer.signature ?? "",
    transfer.direction ?? "",
    transfer.counterparty ?? transfer.from ?? transfer.to ?? "",
    transfer.mint ?? "",
    transfer.amountRaw ?? transfer.amount ?? ""
  ].join("|");
}

function isWalletAddress(address: string, chain: Chain): boolean {
  return chain === "robinhood"
    ? /^0x[a-fA-F0-9]{40}$/.test(address)
    : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

function sameToken(left: string, right: string, chain: Chain): boolean {
  return chain === "robinhood" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isQuoteToken(token: string, chain: Chain): boolean {
  return chain === "robinhood"
    ? ROBINHOOD_QUOTE_TOKENS.has(token.toLowerCase())
    : QUOTE_MINTS.has(token);
}

function collectTokenCandidates(
  value: unknown,
  source: "holder" | "trader",
  result: Map<string, TokenCandidate>,
  sourceAddresses: Set<string>,
  chain: Chain = "solana"
): { duplicates: number; poolsExcluded: number } {
  let duplicates = 0;
  let poolsExcluded = 0;
  const rows = flattenRecords(value);
  for (const [index, row] of rows.entries()) {
    const address = firstString(row, ["address", "wallet", "owner", "holder", "user_address", "wallet_address"]);
    if (!address || !isWalletAddress(address, chain)) continue;
    const exchange = firstString(row, ["exchange", "dex", "platform"]) ?? "";
    const addressType = firstNumber(row, ["addr_type", "address_type"]);
    if (addressType === 2 || /(^|[_ -])(amm|pool|liquidity)($|[_ -])/i.test(exchange)) {
      poolsExcluded += 1;
      continue;
    }
    const normalizedAddress = chain === "robinhood" ? address.toLowerCase() : address;
    sourceAddresses.add(normalizedAddress);
    const incoming = extractCandidateMetrics(row);
    if (source === "holder") incoming.holderRank = index + 1;
    if (source === "trader") incoming.traderRank = index + 1;
    const existing = result.get(normalizedAddress);
    if (existing) {
      duplicates += 1;
      if (!existing.sources.includes(source)) existing.sources.push(source);
      existing.metrics = mergeCandidateMetrics(existing.metrics, incoming);
      existing.raw[source] = row;
    } else {
      result.set(normalizedAddress, { address: normalizedAddress, sources: [source], metrics: incoming, raw: { [source]: row } });
    }
  }
  return { duplicates, poolsExcluded };
}

function extractCandidateMetrics(row: Record<string, unknown>): TokenWalletResult["candidateMetrics"] {
  return {
    balance: firstNumber(row, ["balance", "amount_cur", "amount"]),
    amountPercentage: firstNumber(row, ["amount_percentage", "holder_percentage", "percentage"]),
    usdValue: firstNumber(row, ["usd_value", "value_usd"]),
    profit: firstNumber(row, ["profit", "pnl"]),
    realizedProfit: firstNumber(row, ["realized_profit"]),
    unrealizedProfit: firstNumber(row, ["unrealized_profit"]),
    buyVolume: firstNumber(row, ["buy_volume_cur", "buy_volume"]),
    sellVolume: firstNumber(row, ["sell_volume_cur", "sell_volume"]),
    buyTxCount: firstNumber(row, ["buy_tx_count_cur", "buy_tx_count"]),
    sellTxCount: firstNumber(row, ["sell_tx_count_cur", "sell_tx_count"]),
    rankScore: 0
  };
}

function mergeCandidateMetrics(
  current: TokenWalletResult["candidateMetrics"],
  incoming: TokenWalletResult["candidateMetrics"]
): TokenWalletResult["candidateMetrics"] {
  const merged = { ...current };
  for (const key of [
    "balance", "amountPercentage", "usdValue", "profit", "realizedProfit", "unrealizedProfit",
    "buyVolume", "sellVolume", "buyTxCount", "sellTxCount"
  ] as const) {
    const next = incoming[key];
    if (next !== undefined && (merged[key] === undefined || Math.abs(next) > Math.abs(merged[key] ?? 0))) merged[key] = next;
  }
  for (const key of ["holderRank", "traderRank"] as const) {
    const next = incoming[key];
    if (next !== undefined && (merged[key] === undefined || next < merged[key]!)) merged[key] = next;
  }
  return merged;
}

function candidateRankScore(metrics: TokenWalletResult["candidateMetrics"]): number {
  const profit = Math.max(0, metrics.profit ?? ((metrics.realizedProfit ?? 0) + (metrics.unrealizedProfit ?? 0)));
  const volume = Math.max(0, (metrics.buyVolume ?? 0) + (metrics.sellVolume ?? 0));
  const transactions = Math.max(0, (metrics.buyTxCount ?? 0) + (metrics.sellTxCount ?? 0));
  return Math.round((Math.log10(1 + profit) * 30 + Math.log10(1 + volume) * 30 + Math.min(30, transactions * 0.5)) * 100) / 100;
}

function normalizeHeliusHistory(history: Record<string, unknown>[], cutoff: number): NormalizedWalletEvent[] {
  const events: NormalizedWalletEvent[] = [];
  for (const transaction of history) {
    const timestamp = toTimestamp(transaction.timestamp);
    if (!timestamp || timestamp < cutoff) continue;
    const signature = firstString(transaction, ["signature", "transactionSignature"]);
    const changes = Array.isArray(transaction.balanceChanges) ? transaction.balanceChanges : [];
    const totals = new Map<string, number>();
    for (const change of changes) {
      const row = asRecord(change);
      const mint = firstString(row, ["mint", "tokenMint"]);
      const amount = firstNumber(row, ["amount", "uiAmount", "value"]);
      if (!mint || amount === undefined || amount === 0) continue;
      totals.set(mint, (totals.get(mint) ?? 0) + amount);
    }
    for (const [mint, amount] of totals) {
      if (amount === 0) continue;
      events.push({ signature, timestamp, kind: amount > 0 ? "buy" : "sell", mint, provider: "helius" });
    }
  }
  return events;
}

function normalizeGmgnActivity(activity: unknown, cutoff: number): NormalizedWalletEvent[] {
  const events: NormalizedWalletEvent[] = [];
  for (const row of flattenRecords(activity)) {
    const timestamp = toTimestamp(firstValue(row, ["timestamp", "time", "block_time", "created_at"]));
    if (!timestamp || timestamp < cutoff) continue;
    const token = asRecord(row.token);
    const mint = firstString(row, ["token_address", "tokenAddress", "mint", "address", "base_token"])
      ?? firstString(token, ["address", "token_address", "mint"]);
    const side = String(firstValue(row, ["side", "type", "event_type", "action"]) ?? "").toLowerCase();
    const kind = /buy|in|receive|purchase/.test(side) ? "buy" : /sell|out|send/.test(side) ? "sell" : undefined;
    if (!kind || !mint) continue;
    events.push({
      signature: firstString(row, ["tx_hash", "signature", "transaction_hash"]),
      timestamp,
      kind,
      mint,
      symbol: firstString(row, ["token_symbol", "symbol"]) ?? firstString(token, ["symbol"]),
      provider: "gmgn"
    });
  }
  return events;
}

function normalizeGmgnWalletStats(value: unknown, wallet: string): GmgnWalletStats {
  const rows = flattenRecords(value);
  const row = rows.find((item) => firstString(item, ["wallet_address", "wallet", "address"]) === wallet) ?? rows[0] ?? {};
  const pnlStat = asRecord(row.pnl_stat);
  return {
    weeklyBuyCount: firstNumber(row, ["buy", "buy_count", "buyCount"]),
    weeklySellCount: firstNumber(row, ["sell", "sell_count", "sellCount"]),
    weeklyTokenCount: firstNumber(pnlStat, ["token_num", "token_count"]) ?? firstNumber(row, ["token_num", "token_count"]),
    realizedProfit: firstNumber(row, ["realized_profit", "profit"]),
    winrate: firstNumber(pnlStat, ["winrate"]) ?? firstNumber(row, ["winrate"])
  };
}

function extractNextCursor(value: unknown): string | undefined {
  const row = asRecord(value);
  const data = asRecord(row.data);
  return firstString(row, ["next", "next_cursor", "nextCursor", "cursor"])
    ?? firstString(data, ["next", "next_cursor", "nextCursor", "cursor"]);
}

function mergeWalletEvents(gmgnEvents: NormalizedWalletEvent[], heliusEvents: NormalizedWalletEvent[]): NormalizedWalletEvent[] {
  const merged = new Map<string, NormalizedWalletEvent>();
  for (const event of [...gmgnEvents, ...heliusEvents]) {
    const key = event.signature ? `${event.signature}|${event.mint}` : `${event.timestamp}|${event.mint}|${event.kind}`;
    merged.set(key, event);
  }
  return [...merged.values()];
}

function summarizeWalletEvents(events: NormalizedWalletEvent[], target: string, stopAtBuys: number): {
  buyCount: number;
  sellCount: number;
  otherProjectTokens: string[];
  firstTradeAt?: string;
  lastTradeAt?: string;
} {
  const targetEvents = events.filter((event) => event.mint === target);
  const timestamps = targetEvents.map((event) => event.timestamp).filter(Number.isFinite);
  return {
    buyCount: Math.min(stopAtBuys, targetEvents.filter((event) => event.kind === "buy").length),
    sellCount: targetEvents.filter((event) => event.kind === "sell").length,
    otherProjectTokens: [...new Set(events.filter((event) => event.mint !== target && !QUOTE_MINTS.has(event.mint)).map((event) => event.mint))],
    firstTradeAt: timestamps.length > 0 ? new Date(Math.min(...timestamps)).toISOString() : undefined,
    lastTradeAt: timestamps.length > 0 ? new Date(Math.max(...timestamps)).toISOString() : undefined
  };
}

function reconcileTargetCounts(
  eventSummary: { buyCount: number; sellCount: number },
  metrics: TokenWalletResult["candidateMetrics"],
  tokenCreatedAtMs: number | undefined,
  cutoff: number,
  stopAtBuys: number
): { buyCount: number; sellCount: number; countBasis: TokenWalletResult["countBasis"] } {
  const countBasis: TokenWalletResult["countBasis"] = ["merged-provider-events"];
  let buyCount = eventSummary.buyCount;
  let sellCount = eventSummary.sellCount;
  if (tokenCreatedAtMs !== undefined && tokenCreatedAtMs >= cutoff) {
    buyCount = Math.min(stopAtBuys, Math.max(buyCount, metrics.buyTxCount ?? 0));
    sellCount = Math.max(sellCount, metrics.sellTxCount ?? 0);
    countBasis.push("gmgn-token-lifetime-metrics");
  }
  return { buyCount, sellCount, countBasis };
}

function flattenRecords(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap((item) => flattenRecords(item));
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const nested = [record.data, record.list, record.items, record.rows, record.result, record.activities].filter(Boolean);
  if (nested.length > 0) return nested.flatMap((item) => flattenRecords(item));
  return [record];
}

function firstString(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) if (typeof value[key] === "string" && value[key]) return value[key] as string;
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

function firstValue(value: Record<string, unknown>, keys: string[]): unknown {
  return keys.map((key) => value[key]).find((item) => item !== undefined && item !== null);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function toTimestamp(value: unknown): number | undefined {
  if (typeof value === "number") return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === "string" && value) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return asNumber < 10_000_000_000 ? asNumber * 1000 : asNumber;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function boundedInteger(value: number, minimum: number, maximum: number, flag: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${flag} ${minimum}-${maximum} arasında bir tam sayı olmalı.`);
  }
  return value;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]!, index);
    }
  });
  await Promise.all(runners);
  return results;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const scannerTestUtils = {
  rankCandidates,
  scoreLink,
  collectTokenCandidates,
  normalizeGmgnWalletStats,
  normalizeGmgnActivity,
  normalizeHeliusHistory,
  mergeWalletEvents,
  summarizeWalletEvents,
  reconcileTargetCounts
};
