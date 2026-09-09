import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalWalletLabel,
  inferWalletCategory,
  nextCanonicalWalletLabel,
  walletSuffix,
} from "../lib/wallet-naming.ts";

test("uses the requested chain and category suffixes", () => {
  assert.equal(walletSuffix("solana", "trade"), "T");
  assert.equal(walletSuffix("solana", "funding"), "F");
  assert.equal(walletSuffix("evm", "trade"), "ET");
  assert.equal(walletSuffix("evm", "funding"), "EF");
});

test("numbers additional wallets after the unnumbered canonical label", () => {
  assert.equal(canonicalWalletLabel("example-jordan", "solana", "trade"), "example-jordan_T");
  assert.equal(
    canonicalWalletLabel("example-jordan", "solana", "trade", 2),
    "example-jordan_T2",
  );
  assert.equal(
    nextCanonicalWalletLabel("example-jordan", "evm", "trade", [
      "example-jordan_ET",
      "example-jordan_ET1",
    ]),
    "example-jordan_ET2",
  );
});

test("preserves explicit categories and recognizes legacy trade labels", () => {
  assert.equal(
    inferWalletCategory({
      category: "funding",
      label: "legacy_T",
      status: "active_trade",
    }),
    "funding",
  );
  assert.equal(inferWalletCategory({ label: "legacy_T3" }), "trade");
  assert.equal(inferWalletCategory({ label: "legacy_ET2" }), "trade");
  assert.equal(inferWalletCategory({ label: "legacy_F" }), "funding");
});

test("synthetic wallets follow the canonical person, chain and category order", () => {
  const data = {
    groups: [{
      group: "Example",
      wallets: [
        { label: "Example_T", chain: "solana" as const, category: "trade" as const },
        { label: "Example_T1", chain: "solana" as const, category: "trade" as const },
        { label: "Example_EF", chain: "evm" as const, category: "funding" as const },
      ],
    }],
  };

  let walletCount = 0;
  for (const group of data.groups) {
    const ordinals = new Map<string, number>();
    for (const wallet of group.wallets) {
      const counterKey = `${wallet.chain}:${wallet.category}`;
      const ordinal = ordinals.get(counterKey) ?? 0;
      assert.equal(
        wallet.label,
        canonicalWalletLabel(
          group.group,
          wallet.chain,
          wallet.category,
          ordinal,
        ),
      );
      ordinals.set(counterKey, ordinal + 1);
      walletCount += 1;
    }
  }

  assert.equal(walletCount, 3);
});
