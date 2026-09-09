import assert from "node:assert/strict";
import test from "node:test";
import { scoredScannerTestUtils } from "./scored-token-scanner.js";

test("holder payı eşiğini, pool elemesini, trader birleşimini ve kaynak sırasını uygular", () => {
  const batch = scoredScannerTestUtils.buildCandidates({ list: [
    { address: "0x1111111111111111111111111111111111111111", addr_type: 2, exchange: "uniswap_v3", amount_percentage: 0.2 },
    { address: "0x2222222222222222222222222222222222222222", addr_type: 0, amount_percentage: 0.01, balance: 10 },
    { address: "0x3333333333333333333333333333333333333333", addr_type: 0, amount_percentage: 0.0009, balance: 9 }
  ] }, { list: [
    { address: "0x2222222222222222222222222222222222222222", addr_type: 0, profit: 20 },
    { address: "0x4444444444444444444444444444444444444444", addr_type: 0, profit: 10 }
  ] }, "robinhood");

  assert.equal(batch.qualifyingHolders, 2);
  assert.equal(batch.poolsExcluded, 1);
  assert.equal(batch.duplicates, 1);
  assert.deepEqual(batch.candidates.map((item) => item.address), [
    "0x2222222222222222222222222222222222222222",
    "0x4444444444444444444444444444444444444444"
  ]);
  assert.deepEqual(batch.candidates[0]?.sources, ["holder", "trader"]);
  assert.deepEqual(batch.candidates.map((item) => item.sourceOrder), [1, 2]);
});

test("trader-only modu holder listesini tamamen dışarıda bırakır", () => {
  const batch = scoredScannerTestUtils.buildCandidates({ list: [
    { address: "0x1111111111111111111111111111111111111111", amount_percentage: 0.5 }
  ] }, { list: [
    { address: "0x1111111111111111111111111111111111111111", profit: 20 },
    { address: "0x2222222222222222222222222222222222222222", profit: 10 }
  ] }, "robinhood", { tradersOnly: true });

  assert.equal(batch.qualifyingHolders, 0);
  assert.equal(batch.duplicates, 0);
  assert.deepEqual(batch.candidates.map((item) => item.address), [
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222"
  ]);
  assert.deepEqual(batch.candidates.map((item) => item.sources), [["trader"], ["trader"]]);
});

test("GMGN 7d wallet stats alanlarını puan metriklerine dönüştürür", () => {
  const metrics = scoredScannerTestUtils.normalizeWalletMetrics({
    wallet_address: "0x2222222222222222222222222222222222222222",
    native_balance: "0.006",
    buy: 17,
    sell: 4,
    pnl_stat: {
      pnl_gt_5x_num: 3,
      pnl_2x_5x_num: 2,
      token_num: 11,
      avg_holding_period: 1300
    },
    common: { tags: ["smart_money"], follow_count: "200", followers_count: 500_000 }
  }, {
    address: "0x2222222222222222222222222222222222222222",
    sources: ["holder"],
    sourceOrder: 1,
    raw: {}
  }, "robinhood");

  assert.equal(metrics.pnlGt5xCount, 3);
  assert.equal(metrics.pnl2xTo5xCount, 2);
  assert.equal(metrics.tradedTokenCount, 11);
  assert.equal(metrics.averageHoldingSeconds, 1300);
  assert.equal(metrics.weeklyBuyCount, 17);
  assert.equal(metrics.gmgnFollowCount, 200);
  assert.equal(metrics.nativeBalance, 0.006);
  assert.equal(metrics.nativeBalanceReference, 0.005);
  assert.equal(scoredScannerTestUtils.evaluateEligibility(metrics), "eligible");
  assert.equal(scoredScannerTestUtils.calculateRawScore(metrics), 41);
});

test("sert kapı yalnız 1-71 buy ve en az iki farklı coin kabul eder", () => {
  const base = {
    nativeBalanceSymbol: "ETH" as const,
    nativeBalanceReference: 0.005,
    common: {}
  };
  assert.equal(scoredScannerTestUtils.evaluateEligibility({ ...base, weeklyBuyCount: 1, tradedTokenCount: 2 }), "eligible");
  assert.equal(scoredScannerTestUtils.evaluateEligibility({ ...base, weeklyBuyCount: 71, tradedTokenCount: 2 }), "eligible");
  assert.equal(scoredScannerTestUtils.evaluateEligibility({ ...base, weeklyBuyCount: 0, tradedTokenCount: 2 }), "weekly_buy_out_of_range");
  assert.equal(scoredScannerTestUtils.evaluateEligibility({ ...base, weeklyBuyCount: 72, tradedTokenCount: 2 }), "weekly_buy_out_of_range");
  assert.equal(scoredScannerTestUtils.evaluateEligibility({ ...base, weeklyBuyCount: 20, tradedTokenCount: 1 }), "no_other_token_in_7d");
  assert.equal(scoredScannerTestUtils.evaluateEligibility({ ...base, tradedTokenCount: 3 }), "missing_gate_data");
});

test("GMGN follow_count 200 dahil kabul edilir, 201 ve üzeri sert reddedilir", () => {
  const base = {
    weeklyBuyCount: 20,
    tradedTokenCount: 3,
    nativeBalanceSymbol: "ETH" as const,
    nativeBalanceReference: 0.005,
    common: {}
  };
  assert.equal(scoredScannerTestUtils.evaluateEligibility(base), "eligible");
  assert.equal(scoredScannerTestUtils.evaluateEligibility({ ...base, gmgnFollowCount: 200 }), "eligible");
  assert.equal(
    scoredScannerTestUtils.evaluateEligibility({ ...base, gmgnFollowCount: 201 }),
    "gmgn_follow_count_over_limit"
  );
});

test("20 puanlık microcap bonusu yalnız kanıtlı %300+ kazançta eklenir", () => {
  const base = {
    pnlGt5xCount: 0,
    pnl2xTo5xCount: 0,
    tradedTokenCount: 2,
    averageHoldingSeconds: 0,
    weeklyBuyCount: 1,
    nativeBalance: 0,
    nativeBalanceSymbol: "ETH" as const,
    nativeBalanceReference: 0.005,
    common: {}
  };
  const withoutBonus = scoredScannerTestUtils.calculateRawScore(base);
  const withBonus = scoredScannerTestUtils.calculateRawScore({ ...base, microcapWin: true });
  assert.equal(withoutBonus, 6);
  assert.equal(withBonus, 26);
});

test("microcap kanıtı alım market capini ve satış getirisini eşleştirir", () => {
  const evidence = scoredScannerTestUtils.findMicrocapWin([
    {
      event_type: "buy",
      timestamp: 1_000,
      tx_hash: "buy-1",
      price_usd: "0.00001",
      token: { address: "0xabc", symbol: "TEST", total_supply: "1000000000" }
    },
    {
      event_type: "sell",
      timestamp: 2_000,
      tx_hash: "sell-1",
      cost_usd: "40",
      buy_cost_usd: "10",
      token: { address: "0xabc", symbol: "TEST", total_supply: "1000000000" }
    }
  ]);
  assert.deepEqual(evidence, {
    tokenAddress: "0xabc",
    tokenSymbol: "TEST",
    buyMarketCapUsd: 10000,
    returnPercent: 300,
    buyTimestamp: 1000,
    sellTimestamp: 2000,
    buyTxHash: "buy-1",
    sellTxHash: "sell-1"
  });
});

test("manuel token preflight doğru zincir ve normal token kaydını zorunlu kılar", () => {
  const validateTokenInfo = scoredScannerTestUtils.validateTokenInfo;
  const solanaMint = "GMuQjK3KLzdyZTn7fLS99vxD8YGfXeHhLzzb7Dcepump";
  assert.doesNotThrow(() => validateTokenInfo({ address: solanaMint, symbol: "GINNAN", chain: "solana" }, solanaMint, "solana"));
  assert.throws(
    () => validateTokenInfo({ address: solanaMint, symbol: "GINNAN", chain: "robinhood" }, solanaMint, "solana"),
    /Robinhood\/EVM/
  );
  assert.throws(
    () => validateTokenInfo({ address: solanaMint, symbol: "USDC", chain: "solana" }, solanaMint, "solana"),
    /Stable\/wrapped\/quote/
  );
  assert.throws(
    () => validateTokenInfo({ address: solanaMint, addr_type: 2, chain: "solana" }, solanaMint, "solana"),
    /Stable\/wrapped\/quote/
  );
  assert.throws(
    () => validateTokenInfo({ address: "0x2222222222222222222222222222222222222222", chain_id: 1 }, "0x2222222222222222222222222222222222222222", "robinhood"),
    /Chain ID 4663/
  );
  assert.throws(
    () => validateTokenInfo({}, solanaMint, "solana"),
    /token kaydı bulunamadı/
  );
});
