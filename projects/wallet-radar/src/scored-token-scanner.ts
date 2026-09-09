import { randomUUID } from "node:crypto";
import pg from "pg";
import type { AppConfig } from "./config.js";
import type { Chain } from "./types.js";
import { GmgnProvider } from "./providers/gmgn.js";

const HOLDER_SHARE_MINIMUM = 0.001;
const HOLDER_RULE_CAP = 500;
const GMGN_HOLDER_API_CAP = 100;
const TRADER_LIMIT = 50;
const GMGN_FOLLOW_COUNT_MAXIMUM = 200;
const ROBINHOOD_CHAIN_ID = 4663;
const SCORE_VERSION = "v2";
const MICROCAP_ACTIVITY_PERIOD_SECONDS = 7 * 24 * 60 * 60;
const MICROCAP_ACTIVITY_PAGE_SIZE = 200;
const MICROCAP_ACTIVITY_MAX_PAGES = 20;
const MICROCAP_ENTRY_MARKET_CAP_USD = 20_000;
const MICROCAP_RETURN_PERCENT_MINIMUM = 300;
const MICROCAP_BONUS_POINTS = 20;
const SOLANA_QUOTE_TOKEN_ADDRESSES = new Set([
  "So11111111111111111111111111111111111111111",
  "So11111111111111111111111111111111111111112",
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
]);
const ROBINHOOD_QUOTE_TOKEN_ADDRESSES = new Set([
  "0x0bd7d308f8e1639fab988df18a8011f41eacad73"
]);

type JsonRecord = Record<string, unknown>;

type Candidate = {
  address: string;
  sources: Array<"holder" | "trader">;
  sourceOrder: number;
  holderRank?: number;
  traderRank?: number;
  holderBalance?: number;
  holderPercentage?: number;
  targetProfit?: number;
  targetRealizedProfit?: number;
  targetUnrealizedProfit?: number;
  targetBuyCount?: number;
  targetSellCount?: number;
  raw: { holder?: JsonRecord; trader?: JsonRecord };
};

type WalletMetrics = {
  pnlGt5xCount?: number;
  pnl2xTo5xCount?: number;
  tradedTokenCount?: number;
  averageHoldingSeconds?: number;
  weeklyBuyCount?: number;
  weeklySellCount?: number;
  gmgnFollowCount?: number;
  nativeBalance?: number;
  nativeBalanceSymbol: "SOL" | "ETH";
  nativeBalanceReference: number;
  microcapWin?: boolean;
  microcapWinEvidence?: MicrocapWinEvidence;
  common: JsonRecord;
};

export type MicrocapWinEvidence = {
  tokenAddress: string;
  tokenSymbol?: string;
  buyMarketCapUsd: number;
  returnPercent: number;
  buyTimestamp: number;
  sellTimestamp: number;
  buyTxHash?: string;
  sellTxHash?: string;
};

export type ScoredTokenScanSummary = {
  scanId: string;
  chain: Chain;
  token: string;
  tokenName?: string;
  tokenSymbol?: string;
  candidateSourceMode: "holders-and-traders" | "traders-only";
  reportedHolderCount?: number;
  holderRule: {
    minimumShare: number;
    requestedCap: number;
    providerCap: number;
    returned: number;
    qualifyingReturned: number;
    coverageTruncated: boolean;
  };
  tradersReturned: number;
  candidates: number;
  duplicateCandidatesRemoved: number;
  poolCandidatesExcluded: number;
  walletStatsCompleted: number;
  walletStatsPartial: number;
  eligibility: {
    weeklyBuyMinimum: number;
    weeklyBuyMaximum: number;
    minimumTradedTokenCount: number;
    gmgnFollowCountMaximum: number;
    passed: number;
    weeklyBuyRejected: number;
    noOtherTokenRejected: number;
    gmgnFollowCountRejected: number;
    missingGateDataRejected: number;
    scoreBelowDatabaseMinimum: number;
  };
  microcap: {
    activityCompleted: number;
    activityPartial: number;
    wins: number;
    entryMarketCapMaximumUsd: number;
    returnMinimumPercent: number;
    bonusPoints: number;
  };
  databaseRetained: number;
  siteVisible: number;
  scoreDistribution: Record<string, number>;
  warnings: Array<{ provider: string; operation: string; subject?: string; error: string }>;
};

export type ScoredTokenScanOptions = {
  tradersOnly?: boolean;
};

export class ScoredTokenScanner {
  private readonly gmgn: GmgnProvider;
  private readonly pool: pg.Pool;

  constructor(private readonly config: AppConfig) {
    if (!config.databaseUrl) throw new Error("DATABASE_URL bulunamadı.");
    this.gmgn = new GmgnProvider(config);
    this.pool = new pg.Pool(connectionOptions(config.databaseUrl));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async scan(tokenInput: string, chain: Chain, options: ScoredTokenScanOptions = {}): Promise<ScoredTokenScanSummary> {
    validateToken(tokenInput, chain);
    const token = chain === "robinhood" ? tokenInput.toLowerCase() : tokenInput;
    const gmgnChain = chain === "solana" ? "sol" : "robinhood";
    const candidateSourceMode = options.tradersOnly ? "traders-only" : "holders-and-traders";
    const warnings: ScoredTokenScanSummary["warnings"] = [];
    let scanId: string | undefined;

    try {
      const tokenInfoRaw = await this.gmgn.tokenInfo(gmgnChain, token);
      const tokenInfo = unwrapRecord(tokenInfoRaw);
      validateTokenInfo(tokenInfo, token, chain);
      await this.assertNoDuplicateScan(chain, token);
      const tokenId = await this.upsertToken(chain, token, tokenInfo);
      scanId = randomUUID();
      await this.beginScan(scanId, chain, token, tokenId, candidateSourceMode);
      await this.saveProviderResponse(scanId, "token-info", token, tokenInfoRaw);

      const holdersRaw = options.tradersOnly
        ? { list: [] }
        : await this.gmgn.tokenHolders(gmgnChain, token, HOLDER_RULE_CAP);
      const tradersRaw = await this.gmgn.tokenTraders(gmgnChain, token, TRADER_LIMIT, "profit", "desc");

      const candidateBatch = buildCandidates(holdersRaw, tradersRaw, chain, options);
      const returnedHolders = extractList(holdersRaw).length;
      const reportedHolderCount = firstNumber(tokenInfo, ["holder_count"])
        ?? firstNumber(asRecord(tokenInfo.stat), ["holder_count"]);
      const lastReturnedShare = candidateBatch.lastReturnedHolderShare;
      const coverageTruncated = returnedHolders >= GMGN_HOLDER_API_CAP
        && (lastReturnedShare ?? 0) >= HOLDER_SHARE_MINIMUM;

      let walletStatsCompleted = 0;
      let walletStatsPartial = 0;
      let eligibilityPassed = 0;
      let weeklyBuyRejected = 0;
      let noOtherTokenRejected = 0;
      let gmgnFollowCountRejected = 0;
      let missingGateDataRejected = 0;
      let scoreBelowDatabaseMinimum = 0;
      let microcapActivityCompleted = 0;
      let microcapActivityPartial = 0;
      let microcapWins = 0;

      for (const [index, candidate] of candidateBatch.candidates.entries()) {
        let statsRaw: unknown = null;
        let statsError: string | undefined;
        try {
          statsRaw = await this.gmgn.portfolioStats(gmgnChain, candidate.address, "7d");
          walletStatsCompleted += 1;
        } catch (error) {
          statsError = errorMessage(error).replaceAll(candidate.address, "[wallet]");
          walletStatsPartial += 1;
          warnings.push({ provider: "gmgn", operation: "wallet-stats-7d", error: statsError });
        }

        const metrics = normalizeWalletMetrics(statsRaw, candidate, chain);
        const gate = evaluateEligibility(metrics);
        if (gate === "missing_gate_data") {
          missingGateDataRejected += 1;
        } else if (gate === "weekly_buy_out_of_range") {
          weeklyBuyRejected += 1;
        } else if (gate === "no_other_token_in_7d") {
          noOtherTokenRejected += 1;
        } else if (gate === "gmgn_follow_count_over_limit") {
          gmgnFollowCountRejected += 1;
        } else {
          eligibilityPassed += 1;
          let activityResponses: unknown[] = [];
          let activityError: string | undefined;
          try {
            const activity = await this.fetchMicrocapActivity(gmgnChain, candidate.address);
            activityResponses = activity.responses;
            microcapActivityCompleted += 1;
            metrics.microcapWinEvidence = findMicrocapWin(activity.activities);
            metrics.microcapWin = metrics.microcapWinEvidence !== undefined;
            if (metrics.microcapWin) microcapWins += 1;
          } catch (error) {
            microcapActivityPartial += 1;
            activityError = errorMessage(error).replaceAll(candidate.address, "[wallet]");
            warnings.push({ provider: "gmgn", operation: "wallet-activity-7d", error: activityError });
          }

          const rawScore = calculateRawScore(metrics);
          if (rawScore < 5) {
            scoreBelowDatabaseMinimum += 1;
          } else {
            await this.saveProviderResponse(scanId, "wallet-stats-7d", candidate.address, statsRaw);
            for (const activityResponse of activityResponses) {
              await this.saveProviderResponse(scanId, "wallet-activity-7d", candidate.address, activityResponse);
            }
            await this.saveCandidate(
              scanId,
              tokenId,
              chain,
              candidate,
              metrics,
              statsRaw,
              statsError,
              activityResponses,
              activityError
            );
          }
        }

        const completed = index + 1;
        if (completed === 1 || completed % 10 === 0 || completed === candidateBatch.candidates.length) {
          console.error(`[scored-scan] ${completed}/${candidateBatch.candidates.length} wallet işlendi`);
        }
      }

      const resultCounts = await this.resultCounts(scanId);
      const summary: ScoredTokenScanSummary = {
        scanId,
        chain,
        token,
        tokenName: firstString(tokenInfo, ["name"]),
        tokenSymbol: firstString(tokenInfo, ["symbol"]),
        candidateSourceMode,
        reportedHolderCount,
        holderRule: {
          minimumShare: HOLDER_SHARE_MINIMUM,
          requestedCap: HOLDER_RULE_CAP,
          providerCap: GMGN_HOLDER_API_CAP,
          returned: returnedHolders,
          qualifyingReturned: candidateBatch.qualifyingHolders,
          coverageTruncated: options.tradersOnly ? false : coverageTruncated
        },
        tradersReturned: extractList(tradersRaw).length,
        candidates: candidateBatch.candidates.length,
        duplicateCandidatesRemoved: candidateBatch.duplicates,
        poolCandidatesExcluded: candidateBatch.poolsExcluded,
        walletStatsCompleted,
        walletStatsPartial,
        eligibility: {
          weeklyBuyMinimum: 1,
          weeklyBuyMaximum: 71,
          minimumTradedTokenCount: 2,
          gmgnFollowCountMaximum: GMGN_FOLLOW_COUNT_MAXIMUM,
          passed: eligibilityPassed,
          weeklyBuyRejected,
          noOtherTokenRejected,
          gmgnFollowCountRejected,
          missingGateDataRejected,
          scoreBelowDatabaseMinimum
        },
        microcap: {
          activityCompleted: microcapActivityCompleted,
          activityPartial: microcapActivityPartial,
          wins: microcapWins,
          entryMarketCapMaximumUsd: MICROCAP_ENTRY_MARKET_CAP_USD,
          returnMinimumPercent: MICROCAP_RETURN_PERCENT_MINIMUM,
          bonusPoints: MICROCAP_BONUS_POINTS
        },
        databaseRetained: resultCounts.databaseRetained,
        siteVisible: resultCounts.siteVisible,
        scoreDistribution: resultCounts.scoreDistribution,
        warnings
      };
      await this.finishScan(scanId, "completed", summary);
      return summary;
    } catch (error) {
      if (scanId) {
        await this.finishScan(scanId, "failed", { error: errorMessage(error), warnings }).catch(() => undefined);
      }
      throw error;
    }
  }

  private async upsertToken(chain: Chain, address: string, info: JsonRecord): Promise<number> {
    const result = await this.pool.query(`
      INSERT INTO tokens(
        chain, address, network, chain_id, address_format, name, symbol,
        decimals, total_supply, holder_count, metadata
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      ON CONFLICT (chain, address_key) DO UPDATE SET
        name = EXCLUDED.name,
        symbol = EXCLUDED.symbol,
        decimals = EXCLUDED.decimals,
        total_supply = EXCLUDED.total_supply,
        holder_count = EXCLUDED.holder_count,
        metadata = EXCLUDED.metadata,
        updated_at = now()
      RETURNING id
    `, [
      chain,
      address,
      chain === "robinhood" ? "robinhood-mainnet" : "solana-mainnet-beta",
      chain === "robinhood" ? 4663 : null,
      chain === "robinhood" ? "evm-0x" : "base58",
      firstString(info, ["name"]),
      firstString(info, ["symbol"]),
      firstInteger(info, ["decimals"]),
      firstString(info, ["total_supply", "supply"]),
      firstInteger(info, ["holder_count"]),
      info
    ]);
    return Number(result.rows[0].id);
  }

  private async assertNoDuplicateScan(chain: Chain, token: string): Promise<void> {
    const result = await this.pool.query(`
      SELECT s.id, s.status
      FROM scans s
      JOIN tokens t ON t.id = s.token_id
      WHERE t.chain = $1
        AND t.address_key = $2
        AND s.status IN ('running', 'completed')
      ORDER BY CASE WHEN s.status = 'running' THEN 0 ELSE 1 END, s.started_at DESC
      LIMIT 1
    `, [chain, token]);
    const duplicate = result.rows[0];
    if (duplicate) {
      throw new Error(
        `Bu token için ${duplicate.status} bir scored tarama zaten var (${duplicate.id}); yeni tarama başlatılmadı.`
      );
    }
  }

  private async beginScan(
    scanId: string,
    chain: Chain,
    token: string,
    tokenId: number,
    candidateSourceMode: ScoredTokenScanSummary["candidateSourceMode"]
  ): Promise<void> {
    await this.pool.query(`
      INSERT INTO scans(id, kind, chain, input, token_id, trigger_type, status, score_version, metadata)
      VALUES($1, 'token-wallet-score', $2, $3, $4, 'manual', 'running', $5, $6)
    `, [scanId, chain, token, tokenId, SCORE_VERSION, {
      score_version: SCORE_VERSION,
      candidate_source_mode: candidateSourceMode,
      holder_minimum_share: HOLDER_SHARE_MINIMUM,
      holder_rule_cap: HOLDER_RULE_CAP,
      gmgn_holder_api_cap: GMGN_HOLDER_API_CAP,
      trader_limit: TRADER_LIMIT,
      wallet_stats_period: "7d",
      eligibility_gate: {
        weekly_buy_minimum: 1,
        weekly_buy_maximum: 71,
        minimum_traded_token_count: 2,
        gmgn_follow_count_maximum: GMGN_FOLLOW_COUNT_MAXIMUM,
        gmgn_follow_count_source: "common.follow_count",
        rejected_wallet_persistence: "none"
      },
      microcap_bonus: {
        entry_market_cap_maximum_usd: MICROCAP_ENTRY_MARKET_CAP_USD,
        return_minimum_percent: MICROCAP_RETURN_PERCENT_MINIMUM,
        points: MICROCAP_BONUS_POINTS,
        activity_period: "7d"
      }
    }]);
  }

  private async saveProviderResponse(scanId: string, operation: string, subject: string, payload: unknown): Promise<void> {
    await this.pool.query(`
      INSERT INTO provider_responses(scan_id, provider, operation, subject, payload)
      VALUES($1, 'gmgn', $2, $3, $4)
    `, [scanId, operation, subject, payload ?? null]);
  }

  private async saveCandidate(
    scanId: string,
    tokenId: number,
    chain: Chain,
    candidate: Candidate,
    metrics: WalletMetrics,
    statsRaw: unknown,
    statsError?: string,
    activityResponses: unknown[] = [],
    activityError?: string
  ): Promise<void> {
    const common = metrics.common;
    const identity = Object.keys(common).length > 0 ? common : null;
    const walletResult = await this.pool.query(`
      INSERT INTO wallets(chain, address, label, category, identity, funded_by, metadata, last_seen_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,now())
      ON CONFLICT (chain, address_key) DO UPDATE SET
        label = COALESCE(EXCLUDED.label, wallets.label),
        category = COALESCE(EXCLUDED.category, wallets.category),
        identity = COALESCE(EXCLUDED.identity, wallets.identity),
        funded_by = COALESCE(EXCLUDED.funded_by, wallets.funded_by),
        metadata = wallets.metadata || EXCLUDED.metadata,
        last_seen_at = now(),
        updated_at = now()
      RETURNING id
    `, [
      chain,
      candidate.address,
      firstString(common, ["name", "twitter_name", "twitter_username"]),
      firstString(common, ["tag"]),
      identity,
      candidate.raw.holder?.native_transfer ?? candidate.raw.trader?.native_transfer ?? null,
      { tags: common.tags ?? [], score_source: "gmgn-wallet-stats-7d" }
    ]);
    const walletId = Number(walletResult.rows[0].id);
    const analysisStatus = statsError || activityError || countPresentMetrics(metrics) < 6 ? "partial" : "complete";
    const observation = await this.pool.query(`
      INSERT INTO wallet_token_observations(
        scan_id, token_id, wallet_id, candidate_sources, holder_rank, trader_rank,
        holder_balance, holder_percentage, target_profit, target_realized_profit,
        target_unrealized_profit, target_buy_count, target_sell_count, analysis_status,
        candidate_metrics, source_providers, raw_data
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      RETURNING id
    `, [
      scanId,
      tokenId,
      walletId,
      candidate.sources,
      candidate.holderRank,
      candidate.traderRank,
      candidate.holderBalance,
      candidate.holderPercentage,
      candidate.targetProfit,
      candidate.targetRealizedProfit,
      candidate.targetUnrealizedProfit,
      candidate.targetBuyCount,
      candidate.targetSellCount,
      analysisStatus,
      { source_order: candidate.sourceOrder },
      ["gmgn"],
      {
        ...candidate.raw,
        wallet_stats_7d: statsRaw,
        wallet_activity_7d: activityResponses,
        stats_error: statsError,
        activity_error: activityError
      }
    ]);
    const observationId = Number(observation.rows[0].id);

    await this.pool.query(`
      INSERT INTO wallet_metrics(
        observation_id, pnl_gt_5x_count, pnl_2x_to_5x_count, traded_token_count,
        average_holding_seconds, weekly_buy_count, weekly_sell_count,
        native_balance, native_balance_symbol, native_balance_reference,
        microcap_win, microcap_evidence, raw_metrics
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    `, [
      observationId,
      metrics.pnlGt5xCount,
      metrics.pnl2xTo5xCount,
      metrics.tradedTokenCount,
      metrics.averageHoldingSeconds,
      metrics.weeklyBuyCount,
      metrics.weeklySellCount,
      metrics.nativeBalance,
      metrics.nativeBalanceSymbol,
      metrics.nativeBalanceReference,
      metrics.microcapWin,
      metrics.microcapWinEvidence ?? {},
      { period: "7d", stats: statsRaw, normalized: metrics }
    ]);

    await this.pool.query(`
      INSERT INTO evidence(scan_id, chain, subject, kind, provider, payload)
      VALUES($1,$2,$3,'wallet-score-input','gmgn',$4)
    `, [scanId, chain, candidate.address, {
      candidate_sources: candidate.sources,
      source_order: candidate.sourceOrder,
      metrics,
      analysis_status: analysisStatus,
      microcap_win: metrics.microcapWinEvidence ?? null
    }]);
  }

  private async fetchMicrocapActivity(chain: string, wallet: string): Promise<{
    activities: JsonRecord[];
    responses: unknown[];
  }> {
    const cutoff = Math.floor(Date.now() / 1_000) - MICROCAP_ACTIVITY_PERIOD_SECONDS;
    const activities: JsonRecord[] = [];
    const responses: unknown[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < MICROCAP_ACTIVITY_MAX_PAGES; page += 1) {
      const response = await this.gmgn.portfolioActivity(chain, wallet, {
        limit: MICROCAP_ACTIVITY_PAGE_SIZE,
        cursor,
        types: ["buy", "sell"]
      });
      responses.push(response);
      const pageActivities = extractActivities(response);
      activities.push(...pageActivities.filter((activity) => {
        const timestamp = activityTimestamp(activity);
        return timestamp === undefined || timestamp >= cutoff;
      }));

      const oldestTimestamp = pageActivities
        .map(activityTimestamp)
        .filter((timestamp): timestamp is number => timestamp !== undefined)
        .sort((left, right) => left - right)[0];
      const next = nextActivityCursor(response);
      if (!next || (oldestTimestamp !== undefined && oldestTimestamp < cutoff)) break;
      cursor = next;
    }

    return { activities: dedupeActivities(activities), responses };
  }

  private async resultCounts(scanId: string): Promise<{
    databaseRetained: number;
    siteVisible: number;
    scoreDistribution: Record<string, number>;
  }> {
    const counts = await this.pool.query(`
      SELECT
        count(*) FILTER (WHERE ws.raw_points >= 5) AS database_retained,
        count(*) FILTER (WHERE ws.raw_points > 20) AS site_visible
      FROM wallet_token_observations o
      JOIN wallet_metrics m ON m.observation_id = o.id
      LEFT JOIN wallet_scores ws ON ws.metric_id = m.id AND ws.score_version = $2
      WHERE o.scan_id = $1
    `, [scanId, SCORE_VERSION]);
    const distributionRows = await this.pool.query(`
      SELECT ws.raw_points, count(*)::integer AS wallets
      FROM wallet_token_observations o
      JOIN wallet_metrics m ON m.observation_id = o.id
      JOIN wallet_scores ws ON ws.metric_id = m.id AND ws.score_version = $2
      WHERE o.scan_id = $1
      GROUP BY ws.raw_points
      ORDER BY ws.raw_points DESC
    `, [scanId, SCORE_VERSION]);
    return {
      databaseRetained: Number(counts.rows[0].database_retained),
      siteVisible: Number(counts.rows[0].site_visible),
      scoreDistribution: Object.fromEntries(distributionRows.rows.map((row) => [String(row.raw_points), Number(row.wallets)]))
    };
  }

  private async finishScan(scanId: string, status: "completed" | "failed", summary: unknown): Promise<void> {
    await this.pool.query(`
      UPDATE scans
      SET status = $2, finished_at = now(), summary = $3, error_message = $4
      WHERE id = $1
    `, [scanId, status, summary, status === "failed" ? asRecord(summary).error ?? "Tarama başarısız" : null]);
  }
}

function buildCandidates(
  holdersRaw: unknown,
  tradersRaw: unknown,
  chain: Chain,
  options: ScoredTokenScanOptions = {}
): {
  candidates: Candidate[];
  qualifyingHolders: number;
  duplicates: number;
  poolsExcluded: number;
  lastReturnedHolderShare?: number;
} {
  const holders = options.tradersOnly ? [] : extractList(holdersRaw)
    .map((row, index) => ({ row, originalRank: index + 1 }))
    .sort((left, right) => (firstNumber(right.row, ["amount_percentage"]) ?? -Infinity)
      - (firstNumber(left.row, ["amount_percentage"]) ?? -Infinity));
  const traders = extractList(tradersRaw)
    .map((row, index) => ({ row, originalRank: index + 1 }))
    .sort((left, right) => (firstNumber(right.row, ["profit"]) ?? -Infinity)
      - (firstNumber(left.row, ["profit"]) ?? -Infinity))
    .slice(0, TRADER_LIMIT);
  const byAddress = new Map<string, Candidate>();
  let duplicates = 0;
  let poolsExcluded = 0;
  let sourceOrder = 0;
  let qualifyingHolders = 0;

  const add = (row: JsonRecord, source: "holder" | "trader", rank: number) => {
    const rawAddress = firstString(row, ["address", "wallet_address", "wallet", "owner"]);
    if (!rawAddress || !isWalletAddress(rawAddress, chain)) return;
    if (isPool(row)) {
      poolsExcluded += 1;
      return;
    }
    const address = chain === "robinhood" ? rawAddress.toLowerCase() : rawAddress;
    const existing = byAddress.get(address);
    if (existing) {
      duplicates += 1;
      if (!existing.sources.includes(source)) existing.sources.push(source);
      if (source === "holder") {
        existing.holderRank = rank;
        existing.holderBalance = firstNumber(row, ["balance", "amount_cur", "amount"]);
        existing.holderPercentage = firstNumber(row, ["amount_percentage"]);
        existing.raw.holder = row;
      } else {
        applyTraderFields(existing, row, rank);
      }
      return;
    }
    const candidate: Candidate = {
      address,
      sources: [source],
      sourceOrder: ++sourceOrder,
      raw: source === "holder" ? { holder: row } : { trader: row }
    };
    if (source === "holder") {
      candidate.holderRank = rank;
      candidate.holderBalance = firstNumber(row, ["balance", "amount_cur", "amount"]);
      candidate.holderPercentage = firstNumber(row, ["amount_percentage"]);
      applyTargetFields(candidate, row);
    } else {
      applyTraderFields(candidate, row, rank);
    }
    byAddress.set(address, candidate);
  };

  if (!options.tradersOnly) {
    for (const { row, originalRank } of holders) {
      const share = firstNumber(row, ["amount_percentage"]);
      if (share === undefined || share < HOLDER_SHARE_MINIMUM) continue;
      qualifyingHolders += 1;
      if (qualifyingHolders <= HOLDER_RULE_CAP) add(row, "holder", originalRank);
    }
  }
  for (const { row, originalRank } of traders) add(row, "trader", originalRank);

  return {
    candidates: [...byAddress.values()],
    qualifyingHolders,
    duplicates,
    poolsExcluded,
    lastReturnedHolderShare: firstNumber(holders.at(-1)?.row ?? {}, ["amount_percentage"])
  };
}

function applyTraderFields(candidate: Candidate, row: JsonRecord, rank: number): void {
  candidate.traderRank = rank;
  candidate.raw.trader = row;
  applyTargetFields(candidate, row);
}

function applyTargetFields(candidate: Candidate, row: JsonRecord): void {
  candidate.targetProfit = firstNumber(row, ["profit"]);
  candidate.targetRealizedProfit = firstNumber(row, ["realized_profit"]);
  candidate.targetUnrealizedProfit = firstNumber(row, ["unrealized_profit"]);
  candidate.targetBuyCount = firstInteger(row, ["buy_tx_count_cur", "buy_tx_count"]);
  candidate.targetSellCount = firstInteger(row, ["sell_tx_count_cur", "sell_tx_count"]);
}

function normalizeWalletMetrics(value: unknown, candidate: Candidate, chain: Chain): WalletMetrics {
  const row = unwrapRecord(value);
  const pnl = asRecord(row.pnl_stat);
  const common = asRecord(row.common);
  return {
    pnlGt5xCount: firstInteger(pnl, ["pnl_gt_5x_num"]),
    pnl2xTo5xCount: firstInteger(pnl, ["pnl_2x_5x_num"]),
    tradedTokenCount: firstInteger(pnl, ["token_num"]),
    averageHoldingSeconds: firstNumber(pnl, ["avg_holding_period"]),
    weeklyBuyCount: firstInteger(row, ["buy", "buy_count"]),
    weeklySellCount: firstInteger(row, ["sell", "sell_count"]),
    gmgnFollowCount: firstInteger(common, ["follow_count"]),
    nativeBalance: firstNumber(row, ["native_balance"]) ?? fallbackNativeBalance(candidate, chain),
    nativeBalanceSymbol: chain === "robinhood" ? "ETH" : "SOL",
    nativeBalanceReference: chain === "robinhood" ? 0.005 : 0.25,
    common
  };
}

type EligibilityGate =
  | "eligible"
  | "missing_gate_data"
  | "weekly_buy_out_of_range"
  | "no_other_token_in_7d"
  | "gmgn_follow_count_over_limit";

function evaluateEligibility(metrics: WalletMetrics): EligibilityGate {
  if (metrics.weeklyBuyCount === undefined || metrics.tradedTokenCount === undefined) return "missing_gate_data";
  if (metrics.weeklyBuyCount < 1 || metrics.weeklyBuyCount > 71) return "weekly_buy_out_of_range";
  if (metrics.tradedTokenCount < 2) return "no_other_token_in_7d";
  if (metrics.gmgnFollowCount !== undefined && metrics.gmgnFollowCount > GMGN_FOLLOW_COUNT_MAXIMUM) {
    return "gmgn_follow_count_over_limit";
  }
  return "eligible";
}

function calculateRawScore(metrics: WalletMetrics): number {
  const gt5x = metrics.pnlGt5xCount === undefined ? 0
    : metrics.pnlGt5xCount >= 3 ? 12
      : metrics.pnlGt5xCount === 2 ? 8
        : metrics.pnlGt5xCount === 1 ? 4 : 0;
  const between2x5x = metrics.pnl2xTo5xCount === undefined ? 0
    : metrics.pnl2xTo5xCount >= 3 ? 8
      : metrics.pnl2xTo5xCount === 2 ? 6
        : metrics.pnl2xTo5xCount === 1 ? 3 : 0;
  const tokens = metrics.tradedTokenCount === undefined ? 0
    : metrics.tradedTokenCount >= 10 ? 8
      : metrics.tradedTokenCount >= 7 ? 7
        : metrics.tradedTokenCount >= 5 ? 5
          : metrics.tradedTokenCount >= 3 ? 3
            : metrics.tradedTokenCount >= 1 ? 1 : 0;
  const holding = metrics.averageHoldingSeconds === undefined ? 0
    : metrics.averageHoldingSeconds >= 1200 ? 5
      : metrics.averageHoldingSeconds >= 900 ? 3
        : metrics.averageHoldingSeconds >= 600 ? 2
          : metrics.averageHoldingSeconds >= 300 ? 1 : 0;
  const buys = metrics.weeklyBuyCount === undefined ? 0
    : metrics.weeklyBuyCount >= 1 && metrics.weeklyBuyCount <= 20 ? 5
      : metrics.weeklyBuyCount <= 50 ? 3
        : metrics.weeklyBuyCount <= 100 ? 1 : 0;
  const balanceRatio = metrics.nativeBalance === undefined || metrics.nativeBalanceReference <= 0
    ? undefined
    : metrics.nativeBalance / metrics.nativeBalanceReference;
  const balance = balanceRatio === undefined ? 0
    : balanceRatio >= 1 ? 5
      : balanceRatio >= 0.5 ? 3
        : balanceRatio > 0 ? 1 : 0;
  const microcap = metrics.microcapWin === true ? MICROCAP_BONUS_POINTS : 0;
  return gt5x + between2x5x + tokens + holding + buys + balance + microcap;
}

function findMicrocapWin(activities: JsonRecord[]): MicrocapWinEvidence | undefined {
  const buysByToken = new Map<string, Array<{ timestamp: number; marketCapUsd: number; txHash?: string }>>();
  const sells = activities
    .filter((activity) => activityType(activity) === "sell")
    .map((activity) => ({ activity, timestamp: activityTimestamp(activity) }))
    .filter((entry): entry is { activity: JsonRecord; timestamp: number } => entry.timestamp !== undefined)
    .sort((left, right) => left.timestamp - right.timestamp);

  for (const activity of activities) {
    if (activityType(activity) !== "buy") continue;
    const token = activityToken(activity);
    const timestamp = activityTimestamp(activity);
    const priceUsd = firstNumber(activity, ["price_usd"]);
    const totalSupply = firstNumber(token, ["total_supply", "supply"]);
    if (!tokenAddress(token) || timestamp === undefined || priceUsd === undefined || totalSupply === undefined) continue;
    const marketCapUsd = priceUsd * totalSupply;
    if (!Number.isFinite(marketCapUsd) || marketCapUsd <= 0 || marketCapUsd >= MICROCAP_ENTRY_MARKET_CAP_USD) continue;
    const address = tokenAddress(token)!.toLowerCase();
    const existing = buysByToken.get(address) ?? [];
    existing.push({ timestamp, marketCapUsd, txHash: firstString(activity, ["tx_hash", "signature"]) });
    buysByToken.set(address, existing);
  }

  for (const { activity: sell, timestamp: sellTimestamp } of sells) {
    const token = activityToken(sell);
    const address = tokenAddress(token)?.toLowerCase();
    if (!address) continue;
    const buyCost = firstNumber(sell, ["buy_cost_usd"]);
    const saleIncome = firstNumber(sell, ["cost_usd"]);
    if (buyCost === undefined || saleIncome === undefined || buyCost <= 0 || saleIncome <= buyCost) continue;
    const returnPercent = (saleIncome / buyCost - 1) * 100;
    if (!Number.isFinite(returnPercent) || returnPercent < MICROCAP_RETURN_PERCENT_MINIMUM) continue;
    const entry = (buysByToken.get(address) ?? [])
      .filter((buy) => buy.timestamp <= sellTimestamp)
      .sort((left, right) => left.timestamp - right.timestamp)[0];
    if (!entry) continue;
    return {
      tokenAddress: tokenAddress(token)!,
      tokenSymbol: firstString(token, ["symbol"]),
      buyMarketCapUsd: roundEvidenceNumber(entry.marketCapUsd),
      returnPercent: roundEvidenceNumber(returnPercent),
      buyTimestamp: entry.timestamp,
      sellTimestamp,
      buyTxHash: entry.txHash,
      sellTxHash: firstString(sell, ["tx_hash", "signature"])
    };
  }
  return undefined;
}

function extractActivities(value: unknown): JsonRecord[] {
  const record = asRecord(unwrapValue(value));
  return Array.isArray(record.activities)
    ? record.activities.map(asRecord).filter((activity) => Object.keys(activity).length > 0)
    : [];
}

function dedupeActivities(activities: JsonRecord[]): JsonRecord[] {
  const seen = new Set<string>();
  return activities.filter((activity) => {
    const token = tokenAddress(activityToken(activity)) ?? "";
    const key = [
      firstString(activity, ["tx_hash", "signature"]) ?? "",
      activityType(activity),
      token,
      firstString(activity, ["token_amount"]),
      firstString(activity, ["quote_amount"]),
      firstString(activity, ["cost_usd"]),
      firstString(activity, ["buy_cost_usd"])
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function nextActivityCursor(value: unknown): string | undefined {
  const record = asRecord(unwrapValue(value));
  return firstString(record, ["next", "next_cursor", "cursor"]);
}

function activityType(activity: JsonRecord): string {
  return (firstString(activity, ["event_type", "type"]) ?? "").toLowerCase();
}

function activityTimestamp(activity: JsonRecord): number | undefined {
  const timestamp = firstNumber(activity, ["timestamp", "block_timestamp", "time"]);
  if (timestamp === undefined) return undefined;
  return timestamp > 10_000_000_000 ? Math.floor(timestamp / 1_000) : Math.floor(timestamp);
}

function activityToken(activity: JsonRecord): JsonRecord {
  return asRecord(activity.token);
}

function tokenAddress(token: JsonRecord): string | undefined {
  return firstString(token, ["address", "token_address"]);
}

function roundEvidenceNumber(value: number): number {
  return Math.round(value * 100) / 100;
}

function fallbackNativeBalance(candidate: Candidate, chain: Chain): number | undefined {
  const raw = candidate.raw.holder?.native_balance ?? candidate.raw.trader?.native_balance;
  const numeric = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  const smallestUnit = chain === "robinhood" ? 1e18 : 1e9;
  return Number.isFinite(numeric) && numeric >= 0 ? numeric / smallestUnit : undefined;
}

function countPresentMetrics(metrics: WalletMetrics): number {
  return [
    metrics.pnlGt5xCount,
    metrics.pnl2xTo5xCount,
    metrics.tradedTokenCount,
    metrics.averageHoldingSeconds,
    metrics.weeklyBuyCount,
    metrics.nativeBalance
  ].filter((value) => value !== undefined).length;
}

function isPool(row: JsonRecord): boolean {
  const addressType = firstInteger(row, ["addr_type", "address_type"]);
  const exchange = firstString(row, ["exchange", "dex", "platform"]) ?? "";
  return addressType === 2 || /(?:^|[_ -])(?:amm|pool|liquidity|uniswap|raydium)(?:$|[_ -])/i.test(exchange);
}

function extractList(value: unknown): JsonRecord[] {
  const unwrapped = unwrapValue(value);
  if (Array.isArray(unwrapped)) return unwrapped.map(asRecord).filter((row) => Object.keys(row).length > 0);
  const record = asRecord(unwrapped);
  for (const key of ["list", "items", "rows", "holders", "traders"]) {
    if (Array.isArray(record[key])) return (record[key] as unknown[]).map(asRecord).filter((row) => Object.keys(row).length > 0);
  }
  return [];
}

function unwrapRecord(value: unknown): JsonRecord {
  return asRecord(unwrapValue(value));
}

function unwrapValue(value: unknown): unknown {
  let current = value;
  for (let depth = 0; depth < 5; depth += 1) {
    const record = asRecord(current);
    const next = record.data ?? record.result;
    if (next === undefined) break;
    current = next;
  }
  return current;
}

function firstString(record: JsonRecord, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function firstNumber(record: JsonRecord, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function firstInteger(record: JsonRecord, keys: string[]): number | undefined {
  const value = firstNumber(record, keys);
  return value === undefined ? undefined : Math.max(0, Math.trunc(value));
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

function isWalletAddress(address: string, chain: Chain): boolean {
  return chain === "robinhood"
    ? /^0x[a-fA-F0-9]{40}$/.test(address)
    : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
}

function validateToken(token: string, chain: Chain): void {
  if (!isWalletAddress(token, chain)) {
    throw new Error(chain === "robinhood" ? "Geçerli bir Robinhood EVM contract adresi gerekli." : "Geçerli bir Solana mint adresi gerekli.");
  }
}

function validateTokenInfo(info: JsonRecord, token: string, chain: Chain): void {
  if (Object.keys(info).length === 0) {
    throw new Error("GMGN token kaydı bulunamadı; tarama başlatılmadı.");
  }

  const providerAddress = firstString(info, ["address", "contract_address", "mint", "token_address"]);
  if (!providerAddress || normalizeTokenAddress(providerAddress, chain) !== normalizeTokenAddress(token, chain)) {
    throw new Error("GMGN token kaydı verilen zincir/adresle eşleşmiyor; tarama başlatılmadı.");
  }

  const declaredChains = ["chain", "network", "blockchain", "chain_name", "chainName"]
    .flatMap((key) => stringValues(info[key]))
    .map((value) => value.toLowerCase());
  const declaredText = declaredChains.join(" ");
  if (chain === "robinhood" && /solana|\bsol\b/.test(declaredText)) {
    throw new Error("GMGN token kaydı Solana zincirine ait; Robinhood taraması başlatılmadı.");
  }
  if (chain === "solana" && /robinhood|\bevm\b/.test(declaredText)) {
    throw new Error("GMGN token kaydı Robinhood/EVM zincirine ait; Solana taraması başlatılmadı.");
  }

  const declaredChainId = firstInteger(info, ["chain_id", "chainId"]);
  if (chain === "robinhood" && declaredChainId !== undefined && declaredChainId !== ROBINHOOD_CHAIN_ID) {
    throw new Error("GMGN token kaydı Robinhood Chain ID 4663 ile eşleşmiyor; tarama başlatılmadı.");
  }

  if (isUnsupportedToken(info, token, chain)) {
    throw new Error("Stable/wrapped/quote veya LP/pool tokenları taranmaz; tarama başlatılmadı.");
  }
}

function isUnsupportedToken(info: JsonRecord, token: string, chain: Chain): boolean {
  const normalized = normalizeTokenAddress(token, chain);
  const knownQuoteAddresses = chain === "robinhood"
    ? ROBINHOOD_QUOTE_TOKEN_ADDRESSES
    : SOLANA_QUOTE_TOKEN_ADDRESSES;
  if (knownQuoteAddresses.has(normalized)) return true;

  if (firstInteger(info, ["addr_type", "address_type"]) === 2) return true;
  if ([
    "is_pool", "isPool", "is_amm", "isAmm", "is_lp", "isLp",
    "is_liquidity_pool", "isLiquidityPool", "is_pair", "isPair"
  ].some((key) => isTruthy(info[key]))) return true;

  const classificationValues = [
    ...["type", "token_type", "tokenType", "asset_type", "assetType", "category", "kind", "address_type"]
      .flatMap((key) => stringValues(info[key])),
    ...["tags", "labels", "flags"].flatMap((key) => stringValues(info[key]))
  ];
  if (classificationValues.some((value) => /(?:^|[\s_:-])(?:lp|amm|pool|liquidity(?:_pool)?|stable(?:coin)?|wrapped|quote)(?:$|[\s_:-])/i.test(value))) {
    return true;
  }

  const symbolOrName = [firstString(info, ["symbol"]), firstString(info, ["name"])].filter(Boolean).join(" ");
  return /(?:^|[\s_:-])(?:usdc|usdt|weth|wsol|wrapped\s+sol|wrapped\s+ether|usd\s*coin|tether)(?:$|[\s_:-])/i.test(symbolOrName);
}

function normalizeTokenAddress(address: string, chain: Chain): string {
  return chain === "robinhood" ? address.toLowerCase() : address;
}

function stringValues(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (Array.isArray(value)) return value
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
  return [];
}

function isTruthy(value: unknown): boolean {
  return value === true || value === 1 || (typeof value === "string" && /^(?:true|1|yes)$/i.test(value.trim()));
}

function connectionOptions(databaseUrl: string): pg.PoolConfig {
  const url = new URL(databaseUrl);
  const local = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  return { connectionString: databaseUrl, ssl: local ? false : { rejectUnauthorized: false } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const scoredScannerTestUtils = {
  buildCandidates,
  normalizeWalletMetrics,
  evaluateEligibility,
  calculateRawScore,
  findMicrocapWin,
  validateTokenInfo
};
