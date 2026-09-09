export type Chain = "solana" | "robinhood";

export type Identity = {
  address?: string;
  type?: string;
  name?: string;
  category?: string;
  tags?: string[];
  domainNames?: string[];
  [key: string]: unknown;
};

export type TransferRecord = {
  signature?: string;
  timestamp?: number;
  from?: string;
  to?: string;
  counterparty?: string;
  direction?: string;
  mint?: string;
  symbol?: string;
  amount?: number;
  amountRaw?: string;
  decimals?: number;
  amountUsd?: number;
  valueUsd?: number;
  raw: Record<string, unknown>;
};

export type TransferValueTotal = {
  mint?: string;
  symbol?: string;
  amount: number;
  transferCount: number;
};

export type WalletLink = {
  sourceAddress: string;
  candidateAddress: string;
  hop: number;
  score: number;
  reasons: string[];
  label?: string;
  signatures: string[];
  totalValue: TransferValueTotal[];
  evidence: Record<string, unknown>;
};

export type WalletScanSummary = {
  scanId: string;
  chain: Chain;
  inputAddress: string;
  links: WalletLink[];
  candidateCountsByHop: Record<string, number>;
  secondHopExpansions: number;
  spamTransfersExcluded: number;
  warnings: Array<{
    address: string;
    provider: string;
    operation: string;
    error: string;
  }>;
};

export type TokenWalletResult = {
  wallet: string;
  chain: Chain;
  token: string;
  candidateSources: Array<"holder" | "trader" | "helius-holder">;
  candidateMetrics: {
    balance?: number;
    amountPercentage?: number;
    usdValue?: number;
    profit?: number;
    realizedProfit?: number;
    unrealizedProfit?: number;
    buyVolume?: number;
    sellVolume?: number;
    buyTxCount?: number;
    sellTxCount?: number;
    holderRank?: number;
    traderRank?: number;
    rankScore: number;
  };
  countBasis: Array<"merged-provider-events" | "gmgn-token-lifetime-metrics" | "gmgn-wallet-7d-stats">;
  buyCount: number;
  sellCount: number;
  weeklyBuyCount?: number;
  weeklySellCount?: number;
  weeklyTokenCount?: number;
  otherProjectTokenCount: number;
  otherProjectTokens: string[];
  firstTradeAt?: string;
  lastTradeAt?: string;
  included: boolean;
  exclusionReasons: string[];
  source: string[];
  raw: Record<string, unknown>;
};

export type TokenScanSummary = {
  scanId: string;
  chain: Chain;
  token: string;
  tokenName?: string;
  tokenSymbol?: string;
  tokenCreatedAt?: string;
  reportedHolderCount?: number;
  holdersConsidered: number;
  tradersConsidered: number;
  duplicateCandidatesRemoved: number;
  poolCandidatesExcluded: number;
  walletsAnalyzed: number;
  walletsIncluded: number;
  warnings: Array<{ provider: string; operation: string; error: string }>;
  wallets: TokenWalletResult[];
};
