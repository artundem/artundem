import assert from "node:assert/strict";
import test from "node:test";
import { buildTrackerEventDedupeKey } from "../db/tracker-key.ts";

test("same transaction identity produces one normalized key", () => {
  const first = buildTrackerEventDedupeKey({
    network: " Ethereum ",
    txHash: "0xABC123",
    walletAddress: "0xDEF456",
  });
  const duplicate = buildTrackerEventDedupeKey({
    network: "ethereum",
    txHash: "0xabc123",
    walletAddress: "0xdef456",
  });

  assert.equal(first, duplicate);
});

test("different wallet or transaction stays distinct", () => {
  const base = buildTrackerEventDedupeKey({
    network: "solana",
    txHash: "signature-1",
    walletAddress: "wallet-a",
  });
  const anotherWallet = buildTrackerEventDedupeKey({
    network: "solana",
    txHash: "signature-1",
    walletAddress: "wallet-b",
  });
  const anotherTransaction = buildTrackerEventDedupeKey({
    network: "solana",
    txHash: "signature-2",
    walletAddress: "wallet-a",
  });

  assert.notEqual(base, anotherWallet);
  assert.notEqual(base, anotherTransaction);
});
