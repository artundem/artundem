import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "./db.js";
import type { HeliusProvider } from "./providers/helius.js";
import { scannerTestUtils, WalletScanner } from "./scanner.js";
import type { TransferRecord } from "./types.js";

test("groups one transfer only once when multiple address fields name the same candidate", () => {
  const transfer: TransferRecord = {
    signature: "sig-1",
    direction: "in",
    counterparty: "candidate-1",
    from: "candidate-1",
    to: "source-1",
    mint: "mint-1",
    amount: 1,
    amountRaw: "1",
    raw: {}
  };

  const candidates = scannerTestUtils.rankCandidates("source-1", [transfer, transfer], null);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].transfers.length, 1);
});

test("turns funded-by exchange evidence into an auditable strong link", () => {
  const funding = {
    funder: "coinbase-wallet",
    funderName: "Coinbase Hot Wallet 8",
    funderType: "Centralized Exchange",
    mint: "So11111111111111111111111111111111111111111",
    symbol: "SOL",
    amount: 2,
    signature: "funding-signature"
  };
  const [candidate] = scannerTestUtils.rankCandidates("source-1", [], funding);
  const link = scannerTestUtils.scoreLink("source-1", candidate.address, 1, candidate, { type: "exchange" });

  assert.ok(link.score >= 45);
  assert.deepEqual(link.reasons, ["initial_funder", "meaningful_transfer_value", "known_exchange_or_deposit_label"]);
  assert.match(link.label ?? "", /Coinbase Hot Wallet 8/);
  assert.deepEqual(link.signatures, ["funding-signature"]);
  assert.deepEqual(link.totalValue, [{
    mint: "So11111111111111111111111111111111111111111",
    symbol: "SOL",
    amount: 2,
    transferCount: 1
  }]);
});

test("does not turn obvious inbound spam or airdrops into wallet candidates", () => {
  const spam: TransferRecord = {
    signature: "spam-signature",
    direction: "in",
    counterparty: "spam-sender",
    mint: "spam-mint",
    amount: 20_000_000,
    amountRaw: "20000000",
    decimals: 0,
    raw: {}
  };
  assert.deepEqual(scannerTestUtils.rankCandidates("source-1", [spam], null), []);
});

test("keeps funded-by evidence when the beta transfers endpoint fails", async () => {
  const provider = {
    getIdentity: async (address: string) => ({ address, type: "unknown" }),
    getFundedBy: async () => ({ funder: "coinbase-wallet", funderName: "Coinbase", funderType: "exchange", amount: 1, symbol: "SOL", signature: "funding-signature" }),
    getTransfersWithRaw: async () => { throw new Error("Helius transfers failed (502)"); }
  } as unknown as HeliusProvider;
  const database = {
    beginScan: () => "scan-1",
    upsertWallet: () => undefined,
    addEvidence: () => undefined,
    saveProviderResponse: () => undefined,
    addWalletLink: () => undefined,
    finishScan: () => undefined
  } as unknown as Database;

  const summary = await new WalletScanner(provider, database).scan("86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY", { maxHops: 1 });
  assert.equal(summary.links.length, 1);
  assert.equal(summary.links[0].candidateAddress, "coinbase-wallet");
  assert.equal(summary.warnings.length, 1);
  assert.match(summary.warnings[0].error, /502/);
});
