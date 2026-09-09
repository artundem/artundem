import assert from "node:assert/strict";
import test from "node:test";
import {
  gmgnActivityFixture,
  gmgnHoldersFixture,
  gmgnTradersFixture,
  gmgnWalletStats7dFixture,
  HOLDER_WALLET,
  OTHER_PROJECT_MINT,
  TARGET_MINT,
  TRADER_WALLET,
  heliusHistoryFixture
} from "./fixtures/gmgn-p2.js";
import { scannerTestUtils } from "./scanner.js";

const cutoff = 1_785_684_800_000 - 7 * 24 * 60 * 60 * 1_000;

test("normalizes live-shaped holder/trader fixtures, removes pools, and deduplicates sources", () => {
  const candidates = new Map();
  const holders = new Set<string>();
  const traders = new Set<string>();
  const holderStats = scannerTestUtils.collectTokenCandidates(gmgnHoldersFixture, "holder", candidates, holders);
  const traderStats = scannerTestUtils.collectTokenCandidates(gmgnTradersFixture, "trader", candidates, traders);

  assert.equal(holderStats.poolsExcluded, 1);
  assert.equal(traderStats.duplicates, 1);
  assert.deepEqual([...candidates.get(HOLDER_WALLET).sources].sort(), ["holder", "trader"]);
  assert.deepEqual(candidates.get(TRADER_WALLET).sources, ["trader"]);
});

test("accepts and deduplicates Robinhood EVM holder/trader addresses", () => {
  const wallet = "0x7B65452153023B29C80689A7c354AdbecaC9A6E8";
  const candidates = new Map();
  const holders = new Set<string>();
  const traders = new Set<string>();

  scannerTestUtils.collectTokenCandidates({ list: [{ address: wallet, addr_type: 0, balance: 10 }] }, "holder", candidates, holders, "robinhood");
  scannerTestUtils.collectTokenCandidates({ list: [{ address: wallet.toLowerCase(), addr_type: 0, profit: 5 }] }, "trader", candidates, traders, "robinhood");

  assert.equal(candidates.size, 1);
  assert.deepEqual([...candidates.values()][0].sources.sort(), ["holder", "trader"]);
});

test("reads GMGN activities and nested token.address fields", () => {
  const events = scannerTestUtils.normalizeGmgnActivity(gmgnActivityFixture, cutoff);
  assert.equal(events.length, 2);
  assert.equal(events[0].mint, TARGET_MINT);
  assert.equal(events[0].signature, "shared-signature");
  assert.equal(events[1].mint, OTHER_PROJECT_MINT);
});

test("normalizes GMGN 7d wallet buy totals separately from token-specific trader counts", () => {
  const stats = scannerTestUtils.normalizeGmgnWalletStats(gmgnWalletStats7dFixture, HOLDER_WALLET);
  assert.deepEqual(stats, {
    weeklyBuyCount: 23,
    weeklySellCount: 11,
    weeklyTokenCount: 4,
    realizedProfit: 182.55,
    winrate: 0.625
  });
});

test("prefers Helius for the same signature and mint instead of double counting", () => {
  const gmgn = scannerTestUtils.normalizeGmgnActivity(gmgnActivityFixture, cutoff);
  const helius = scannerTestUtils.normalizeHeliusHistory(heliusHistoryFixture, cutoff);
  const merged = scannerTestUtils.mergeWalletEvents(gmgn, helius);
  const targetEvents = merged.filter((event) => event.mint === TARGET_MINT);

  assert.equal(targetEvents.length, 1);
  assert.equal(targetEvents[0].provider, "helius");
});

test("enforces the 51 buy cap and excludes SOL, USDC, and USDT from other project tokens", () => {
  const buys = Array.from({ length: 52 }, (_, index) => ({
    signature: `buy-${index}`,
    timestamp: cutoff + index + 1,
    kind: "buy" as const,
    mint: TARGET_MINT,
    provider: "helius" as const
  }));
  const events = [
    ...buys,
    { signature: "sol", timestamp: cutoff + 100, kind: "sell" as const, mint: "So11111111111111111111111111111111111111112", provider: "helius" as const },
    { signature: "usdc", timestamp: cutoff + 101, kind: "buy" as const, mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", provider: "helius" as const },
    { signature: "usdt", timestamp: cutoff + 102, kind: "buy" as const, mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", provider: "helius" as const },
    { signature: "other", timestamp: cutoff + 103, kind: "buy" as const, mint: OTHER_PROJECT_MINT, provider: "helius" as const }
  ];
  const summary = scannerTestUtils.summarizeWalletEvents(events, TARGET_MINT, 51);

  assert.equal(summary.buyCount, 51);
  assert.deepEqual(summary.otherProjectTokens, [OTHER_PROJECT_MINT]);
});

test("uses token-specific lifetime counts only when the token was created inside the lookback window", () => {
  const metrics = { buyTxCount: 8, sellTxCount: 3, rankScore: 0 };
  const recent = scannerTestUtils.reconcileTargetCounts(
    { buyCount: 2, sellCount: 1 }, metrics, cutoff + 1, cutoff, 51
  );
  const old = scannerTestUtils.reconcileTargetCounts(
    { buyCount: 2, sellCount: 1 }, metrics, cutoff - 1, cutoff, 51
  );

  assert.equal(recent.buyCount, 8);
  assert.equal(recent.sellCount, 3);
  assert.deepEqual(recent.countBasis, ["merged-provider-events", "gmgn-token-lifetime-metrics"]);
  assert.equal(old.buyCount, 2);
  assert.equal(old.sellCount, 1);
  assert.deepEqual(old.countBasis, ["merged-provider-events"]);
});

test("keeps target-token counting at 7d while checking other-token activity overall", () => {
  const oldOtherToken = {
    signature: "old-other",
    timestamp: cutoff - 90 * 24 * 60 * 60 * 1_000,
    kind: "buy" as const,
    mint: OTHER_PROJECT_MINT,
    provider: "helius" as const
  };
  const recentTarget = {
    signature: "recent-target",
    timestamp: cutoff + 1,
    kind: "buy" as const,
    mint: TARGET_MINT,
    provider: "helius" as const
  };
  const weekly = scannerTestUtils.summarizeWalletEvents(
    [recentTarget], TARGET_MINT, 51
  );
  const overall = scannerTestUtils.summarizeWalletEvents(
    [recentTarget, oldOtherToken], TARGET_MINT, 51
  );

  assert.equal(weekly.buyCount, 1);
  assert.deepEqual(weekly.otherProjectTokens, []);
  assert.equal(overall.buyCount, 1);
  assert.deepEqual(overall.otherProjectTokens, [OTHER_PROJECT_MINT]);
});
