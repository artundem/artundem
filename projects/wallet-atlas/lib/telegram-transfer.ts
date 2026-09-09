export type TransferKind = "wallet" | "bridge";

export type TelegramTransfer = {
  transferKind: TransferKind;
  serviceName: string | null;
  network: string;
  walletAddress: string;
  counterpartyAddress: string | null;
  direction: "in" | "out" | "unknown";
  tokenSymbol: string | null;
  tokenAddress: string | null;
  amount: string;
  usdValue: string | null;
  txHash: string | null;
};

export type TelegramTrade = {
  eventType: "buy" | "sell";
  network: string;
  walletAddress: string;
  tokenSymbol: string | null;
  tokenAddress: string | null;
  amount: string;
  usdValue: string | null;
  txHash: string | null;
};

const EVM_ADDRESS = /\b0x[a-fA-F0-9]{40}\b/g;
const SOLANA_ADDRESS = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const SOLANA_TX_HASH = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const BRIDGE_SERVICES = [
  "Relay",
  "Across",
  "Stargate",
  "Orbiter",
  "deBridge",
  "Bungee",
  "LI.FI",
  "Synapse",
] as const;

type ExplorerLinks = {
  accountOccurrences: string[];
  tokenAddresses: string[];
  txHash: string | null;
};

function normalizeNumber(value: string | undefined) {
  if (!value) return null;
  const compact = value.replace(/\s/g, "");
  const comma = compact.lastIndexOf(",");
  const dot = compact.lastIndexOf(".");
  if (comma > dot) {
    return compact.replace(/\./g, "").replace(",", ".");
  }
  return compact.replace(/,/g, "");
}

function unique(values: string[]) {
  return [...new Set(values)];
}

function sameAddress(first: string | null, second: string | null) {
  if (!first || !second) return false;
  return first.toLocaleLowerCase("en-US") === second.toLocaleLowerCase("en-US");
}

function isEvmAddress(value: string) {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function isSolanaAddress(value: string) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

function isLikelyTokenMint(value: string) {
  return value.toLocaleLowerCase("en-US").endsWith("pump");
}

function collapseAdjacent(values: string[]) {
  return values.filter(
    (value, index) => index === 0 || !sameAddress(value, values[index - 1]),
  );
}

function addressPathValue(pathname: string, segmentName: string) {
  const segments = pathname.split("/").filter(Boolean);
  const index = segments.findIndex(
    (segment) => segment.toLocaleLowerCase("en-US") === segmentName,
  );
  if (index === -1 || !segments[index + 1]) return null;
  return decodeURIComponent(segments[index + 1]);
}

function parseExplorerLinks(linkedUrls: string[]): ExplorerLinks {
  const accountOccurrences: string[] = [];
  const tokenAddresses: string[] = [];
  let txHash: string | null = null;

  for (const linkedUrl of linkedUrls) {
    try {
      const url = new URL(linkedUrl);
      const account =
        addressPathValue(url.pathname, "address") ??
        addressPathValue(url.pathname, "account");
      const token = addressPathValue(url.pathname, "token");
      const transaction = addressPathValue(url.pathname, "tx");

      if (account && (isEvmAddress(account) || isSolanaAddress(account))) {
        accountOccurrences.push(account);
      }
      if (token && (isEvmAddress(token) || isSolanaAddress(token))) {
        tokenAddresses.push(token);
      }
      if (
        !txHash &&
        transaction &&
        (/^0x[a-fA-F0-9]{64}$/.test(transaction) ||
          SOLANA_TX_HASH.test(transaction))
      ) {
        txHash = transaction;
      }
    } catch {
      // Telegram may contain non-URL entity values. They are ignored safely.
    }
  }

  if (!txHash) {
    const urls = linkedUrls.join(" ");
    txHash =
      urls.match(/\b0x[a-fA-F0-9]{64}\b/)?.[0] ??
      urls.match(/\b[1-9A-HJ-NP-Za-km-z]{64,88}\b/)?.[0] ??
      null;
  }

  return {
    accountOccurrences,
    tokenAddresses: unique(tokenAddresses),
    txHash,
  };
}

function detectBridgeService(text: string) {
  return (
    BRIDGE_SERVICES.find((service) => {
      const escaped = service.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`\\b${escaped}\\b`, "i").test(text);
    }) ?? null
  );
}

function inferredNetwork(
  explicitNetwork: string | undefined,
  linkedUrls: string[],
  addresses: string[],
) {
  if (explicitNetwork) return explicitNetwork.trim().toUpperCase();
  const linkedNetwork = (
    [
      [/robinhoodchain\.blockscout\.com/i, "ROBINHOOD"],
      [/basescan\.org/i, "BASE"],
      [/bscscan\.com/i, "BSC"],
      [/arbiscan\.io/i, "ARBITRUM"],
      [/optimistic\.etherscan\.io/i, "OPTIMISM"],
      [/polygonscan\.com/i, "POLYGON"],
      [/etherscan\.io/i, "ETHEREUM"],
      [/solscan\.io/i, "SOLANA"],
    ] as const
  ).find(([pattern]) => linkedUrls.some((url) => pattern.test(url)))?.[1];
  if (linkedNetwork) return linkedNetwork;
  if (addresses.some((address) => !address.startsWith("0x"))) {
    return "SOLANA";
  }
  return "UNKNOWN";
}

export function isAmbiguousTelegramTransfer(text: string) {
  if (/\bNFT\s+TRANSFER\b|\bSETAPPROVALFORALL\b/i.test(text)) {
    return true;
  }

  const transferLegs = text.match(/^\s*└/gm)?.length ?? 0;
  return /\bmultiple accounts\b/i.test(text) && transferLegs > 1;
}

export function parseTelegramTransfer(
  text: string,
  linkedUrls: string[] = [],
): TelegramTransfer | null {
  if (
    !/\bTRANSFER\b/i.test(text) ||
    /\b(?:BUY|SELL)\b/i.test(text) ||
    isAmbiguousTelegramTransfer(text)
  ) {
    return null;
  }

  const links = parseExplorerLinks(linkedUrls);
  const tokenAddressFromText =
    text.match(
      /\b(?:token|contract|ca)\s*[:：]\s*(0x[a-fA-F0-9]{40})\b/i,
    )?.[1] ?? null;
  const allTextAddresses = unique([
    ...(text.match(EVM_ADDRESS) ?? []),
    ...(text.match(SOLANA_ADDRESS) ?? []),
  ]);
  const tokenAddresses = unique([
    ...links.tokenAddresses,
    ...(tokenAddressFromText ? [tokenAddressFromText] : []),
    ...allTextAddresses.filter(isLikelyTokenMint),
  ]);
  const textWalletAddresses = allTextAddresses.filter(
    (address) =>
      !tokenAddresses.some((tokenAddress) =>
        sameAddress(address, tokenAddress),
      ),
  );
  const accountSequence = collapseAdjacent(links.accountOccurrences);
  const endpointPair =
    accountSequence.length >= 2 ? accountSequence.slice(-2) : [];
  const serviceName = detectBridgeService(text);
  const body = text.split(/\n\s*\n/).slice(-1)[0] ?? text;

  let senderAddress: string | null = null;
  let recipientAddress: string | null = null;
  if (endpointPair.length === 2) {
    [senderAddress, recipientAddress] = endpointPair;
  } else if (textWalletAddresses.length >= 2) {
    [senderAddress, recipientAddress] = textWalletAddresses;
  }

  let walletAddress: string | null =
    textWalletAddresses[0] ??
    (serviceName && /^\s*\S*relay\b/i.test(body)
      ? recipientAddress
      : senderAddress) ??
    unique(links.accountOccurrences)[0] ??
    null;

  if (
    walletAddress &&
    tokenAddresses.some((tokenAddress) =>
      sameAddress(walletAddress, tokenAddress),
    )
  ) {
    walletAddress = null;
  }
  if (!walletAddress) return null;

  const direction =
    senderAddress && sameAddress(walletAddress, senderAddress)
      ? "out"
      : recipientAddress && sameAddress(walletAddress, recipientAddress)
        ? "in"
        : serviceName &&
            /^\s*(?:🔹\s*)?(?:relay|across|stargate|orbiter|debridge|bungee|li\.fi|synapse)\b/i.test(
              body,
            ) &&
            /\bto\b/i.test(body)
          ? "in"
          : /\b(?:received|got)\b|\bfrom\b/i.test(body)
            ? "in"
            : /\b(?:sent|transferred)\b|\bto\b/i.test(body)
              ? "out"
              : "unknown";

  const counterpartyAddress =
    direction === "out"
      ? recipientAddress &&
        !sameAddress(walletAddress, recipientAddress)
        ? recipientAddress
        : textWalletAddresses.find(
            (address) => !sameAddress(address, walletAddress),
          ) ?? null
      : direction === "in"
        ? senderAddress && !sameAddress(walletAddress, senderAddress)
          ? senderAddress
          : textWalletAddresses.find(
              (address) => !sameAddress(address, walletAddress),
            ) ?? null
        : unique([
            ...textWalletAddresses,
            ...links.accountOccurrences,
          ]).find((address) => !sameAddress(address, walletAddress)) ?? null;

  const amountMatch =
    text.match(
      /\b(?:transferred(?:\s+a\s+total)?|sent|received)\s+([\d.,]+)\s+(?:\(\s*\$[\d.,]+\s*\)\s+)?([A-Z][A-Z0-9._-]{0,14})\b/i,
    ) ??
    text.match(
      /(?:└|→)\s*([\d.,]+)\s+(?:\(\s*\$[\d.,]+\s*\)\s+)?([A-Z][A-Z0-9._-]{0,14})\b/i,
    );
  const usdMatch = text.match(/\(\s*\$([\d.,]+)\s*\)/);

  return {
    transferKind: serviceName ? "bridge" : "wallet",
    serviceName,
    network: inferredNetwork(
      text.match(/\bTRANSFER\s*\(([^)]+)\)/i)?.[1],
      linkedUrls,
      [walletAddress, ...(counterpartyAddress ? [counterpartyAddress] : [])],
    ),
    walletAddress,
    counterpartyAddress,
    direction,
    tokenSymbol: amountMatch?.[2]?.toUpperCase() ?? null,
    tokenAddress: tokenAddresses[0] ?? null,
    amount: normalizeNumber(amountMatch?.[1]) ?? "Bilinmiyor",
    usdValue: normalizeNumber(usdMatch?.[1]),
    txHash: links.txHash,
  };
}

export function parseTelegramTrade(
  text: string,
  linkedUrls: string[] = [],
): TelegramTrade | null {
  const action = text.match(/\b(BUY|SELL)\b/i)?.[1]?.toLowerCase();
  if (action !== "buy" && action !== "sell") return null;

  const header = text.split("\n", 1)[0] ?? "";
  const links = parseExplorerLinks(linkedUrls);
  const allTextAddresses = unique([
    ...(text.match(EVM_ADDRESS) ?? []),
    ...(text.match(SOLANA_ADDRESS) ?? []),
  ]);
  const tokenAddresses = unique([
    ...links.tokenAddresses,
    ...allTextAddresses.filter(isLikelyTokenMint),
  ]);
  const walletAddress =
    allTextAddresses.find(
      (address) =>
        !tokenAddresses.some((tokenAddress) =>
          sameAddress(address, tokenAddress),
        ),
    ) ?? links.accountOccurrences[0] ?? null;
  if (!walletAddress) return null;

  const swapMatch = text.match(
    /\bswapped\s+([\d.,]+)\s+(?:\(\s*\$[\d.,]+\s*\)\s+)?([A-Z][A-Z0-9._-]{0,14})\s+for\s+([\d.,]+)\s+(?:\(\s*\$[\d.,]+\s*\)\s+)?([A-Z][A-Z0-9._-]{0,14})/i,
  );
  const usdMatches = [...text.matchAll(/\(\s*\$(-?[\d.,]+)\s*\)/g)];
  const tokenSymbol =
    text.match(/\b(?:BUY|SELL)\s+([A-Z][A-Z0-9._-]{0,14})\b/i)?.[1] ??
    (action === "buy" ? swapMatch?.[4] : swapMatch?.[2]) ??
    null;
  const amount =
    (action === "buy" ? swapMatch?.[3] : swapMatch?.[1]) ?? "Bilinmiyor";

  return {
    eventType: action,
    network: inferredNetwork(
      header.match(
        /\b(?:BUY|SELL)(?:\s+[A-Z0-9._-]+)?\s*\(([^)]+)\)/i,
      )?.[1],
      linkedUrls,
      [walletAddress],
    ),
    walletAddress,
    tokenSymbol: tokenSymbol?.toUpperCase() ?? null,
    tokenAddress: tokenAddresses[0] ?? null,
    amount: normalizeNumber(amount) ?? "Bilinmiyor",
    usdValue: normalizeNumber(usdMatches[0]?.[1]),
    txHash: links.txHash,
  };
}
