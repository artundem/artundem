import assert from "node:assert/strict";
import test from "node:test";
import type { AppConfig } from "../config.js";
import { deduplicateTransfers, HeliusProvider, normalizeTransfer } from "./helius.js";

const config: AppConfig = {
  heliusApiKey: "test-only-key",
  heliusNetwork: "mainnet-beta",
  gmgnCliPath: "gmgn-cli",
  robinhoodRpcUrl: "https://example.invalid",
  robinhoodBlockscoutUrl: "https://example.invalid",
  databasePath: ":memory:"
};

test("normalizes the documented Wallet API transfer fields", () => {
  const transfer = normalizeTransfer({
    signature: "sig-1",
    timestamp: 1_704_067_200,
    direction: "in",
    counterparty: "counterparty-1",
    mint: "mint-1",
    symbol: "TEST",
    amount: 1.5,
    amountRaw: "1500000",
    decimals: 6
  });

  assert.equal(transfer.counterparty, "counterparty-1");
  assert.equal(transfer.symbol, "TEST");
  assert.equal(transfer.amountRaw, "1500000");
  assert.equal(transfer.decimals, 6);
});

test("uses cursor pagination, preserves raw pages, retries 5xx, and removes repeated transfers", async () => {
  const originalFetch = globalThis.fetch;
  const urls: URL[] = [];
  let call = 0;
  globalThis.fetch = async (input) => {
    urls.push(new URL(String(input)));
    call += 1;
    if (call === 1) {
      return new Response(JSON.stringify({ error: "temporary" }), { status: 502 });
    }
    const first = {
      signature: "sig-1",
      timestamp: 1_704_067_200,
      direction: "in",
      counterparty: "counterparty-1",
      mint: "mint-1",
      amount: 2,
      amountRaw: "2",
      decimals: 0
    };
    if (call === 2) {
      return Response.json({ data: [first], pagination: { hasMore: true, nextCursor: "cursor-1" } });
    }
    return Response.json({
      data: [first, { ...first, signature: "sig-2", counterparty: "counterparty-2" }],
      pagination: { hasMore: false, nextCursor: "cursor-2" }
    });
  };

  try {
    const batch = await new HeliusProvider(config).getTransfersWithRaw("wallet-1", 5);
    assert.equal(batch.rawResponses.length, 2);
    assert.equal(batch.transfers.length, 2);
    assert.equal(urls[1].searchParams.get("cursor"), null);
    assert.equal(urls[2].searchParams.get("cursor"), "cursor-1");
    assert.equal(urls[2].searchParams.has("before"), false);
    assert.equal(urls[2].searchParams.has("tokenAccounts"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("keeps distinct token movements from one signature while removing exact repeats", () => {
  const base = normalizeTransfer({
    signature: "sig-1",
    direction: "in",
    counterparty: "counterparty-1",
    mint: "mint-1",
    amount: 1,
    amountRaw: "1"
  });
  const otherMint = normalizeTransfer({ ...base.raw, mint: "mint-2" });
  assert.equal(deduplicateTransfers([base, base, otherMint]).length, 2);
});
