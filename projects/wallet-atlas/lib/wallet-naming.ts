export type WalletChain = "solana" | "evm";
export type WalletCategory = "trade" | "funding";

type WalletRole = "trade" | "funding" | "bridge" | "cex" | "linked";

export type WalletCategoryInput = {
  category?: WalletCategory;
  label: string;
  role?: WalletRole;
  status?: string;
  latestTradeAt?: number | null;
  recentTradeCount?: number;
};

export function inferWalletCategory(
  wallet: WalletCategoryInput,
): WalletCategory {
  if (wallet.category) return wallet.category;

  const hasTradeLabel =
    /_(?:ET|T)\d*(?:\s*(?:\([^)]*\))?)?$/i.test(wallet.label.trim());
  const hasTradeEvidence =
    wallet.role === "trade" ||
    wallet.status === "active_trade" ||
    Boolean(wallet.latestTradeAt) ||
    (wallet.recentTradeCount ?? 0) > 0 ||
    hasTradeLabel;

  return hasTradeEvidence ? "trade" : "funding";
}

export function walletSuffix(
  chain: WalletChain,
  category: WalletCategory,
) {
  if (chain === "solana") return category === "trade" ? "T" : "F";
  return category === "trade" ? "ET" : "EF";
}

export function canonicalWalletLabel(
  personName: string,
  chain: WalletChain,
  category: WalletCategory,
  ordinal = 0,
) {
  const base = personName.trim();
  const suffix = walletSuffix(chain, category);
  return `${base}_${suffix}${ordinal > 0 ? ordinal : ""}`;
}

export function nextCanonicalWalletLabel(
  personName: string,
  chain: WalletChain,
  category: WalletCategory,
  existingLabels: Iterable<string>,
) {
  const labels = new Set(
    [...existingLabels].map((label) => label.toLocaleLowerCase("tr")),
  );
  let ordinal = 0;

  while (true) {
    const candidate = canonicalWalletLabel(
      personName,
      chain,
      category,
      ordinal,
    );
    if (!labels.has(candidate.toLocaleLowerCase("tr"))) return candidate;
    ordinal += 1;
  }
}
