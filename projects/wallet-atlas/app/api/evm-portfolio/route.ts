type TokenBalance = {
  symbol: string;
  name: string;
  balance: number;
  usdValue: number | null;
};

type NetworkStatus = "available" | "partial" | "unavailable";

type NetworkResult = {
  id: string;
  name: string;
  nativeSymbol: string;
  nativeBalance: number;
  usdValue: number;
  lastActivityAt: number | null;
  explorerUrl: string;
  tokens: TokenBalance[];
  status: NetworkStatus;
};

type NetworkConfig = {
  id: string;
  name: string;
  nativeSymbol: string;
  rpcUrl: string;
  explorerUrl: string;
  blockscoutUrl?: string;
  priceId: "ethereum" | "binancecoin" | "polygon-ecosystem-token";
};

const NETWORKS: NetworkConfig[] = [
  {
    id: "ethereum",
    name: "Ethereum",
    nativeSymbol: "ETH",
    rpcUrl: "https://ethereum-rpc.publicnode.com",
    explorerUrl: "https://eth.blockscout.com",
    blockscoutUrl: "https://eth.blockscout.com",
    priceId: "ethereum",
  },
  {
    id: "robinhood",
    name: "Robinhood",
    nativeSymbol: "ETH",
    rpcUrl: "https://rpc.mainnet.chain.robinhood.com",
    explorerUrl: "https://robinhoodchain.blockscout.com",
    blockscoutUrl: "https://robinhoodchain.blockscout.com",
    priceId: "ethereum",
  },
  {
    id: "bnb",
    name: "BNB Chain",
    nativeSymbol: "BNB",
    rpcUrl: "https://bsc-dataseed.binance.org",
    explorerUrl: "https://bscscan.com",
    priceId: "binancecoin",
  },
  {
    id: "base",
    name: "Base",
    nativeSymbol: "ETH",
    rpcUrl: "https://mainnet.base.org",
    explorerUrl: "https://base.blockscout.com",
    blockscoutUrl: "https://base.blockscout.com",
    priceId: "ethereum",
  },
  {
    id: "arbitrum",
    name: "Arbitrum",
    nativeSymbol: "ETH",
    rpcUrl: "https://arb1.arbitrum.io/rpc",
    explorerUrl: "https://arbitrum.blockscout.com",
    blockscoutUrl: "https://arbitrum.blockscout.com",
    priceId: "ethereum",
  },
  {
    id: "optimism",
    name: "Optimism",
    nativeSymbol: "ETH",
    rpcUrl: "https://mainnet.optimism.io",
    explorerUrl: "https://explorer.optimism.io",
    blockscoutUrl: "https://optimism.blockscout.com",
    priceId: "ethereum",
  },
  {
    id: "polygon",
    name: "Polygon",
    nativeSymbol: "POL",
    rpcUrl: "https://polygon.drpc.org",
    explorerUrl: "https://polygonscan.com",
    blockscoutUrl: "https://polygon.blockscout.com",
    priceId: "polygon-ecosystem-token",
  },
];

function isAddress(value: string) {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

function decimalAmount(value: string | null | undefined, decimals = 18) {
  if (!value) return 0;
  return Number(value) / 10 ** decimals;
}

function hexAmount(value: string | null | undefined) {
  if (!value || !/^0x[a-fA-F0-9]+$/.test(value)) return 0;
  return Number(BigInt(value)) / 1e18;
}

async function fetchJson(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    ...init,
    headers: { accept: "application/json", ...init?.headers },
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

async function rpcBalance(address: string, rpcUrl: string) {
  const payload = await fetchJson(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_getBalance",
      params: [address, "latest"],
    }),
  });
  if (payload.error || typeof payload.result !== "string") {
    throw new Error(payload.error?.message ?? "RPC bakiyesi alınamadı.");
  }
  return hexAmount(payload.result);
}

async function blockscoutDetails(address: string, baseUrl: string) {
  const encoded = encodeURIComponent(address);
  const [accountResult, tokenResult, transactionResult] =
    await Promise.allSettled([
      fetchJson(`${baseUrl}/api/v2/addresses/${encoded}`),
      fetchJson(`${baseUrl}/api/v2/addresses/${encoded}/token-balances`),
      fetchJson(
        `${baseUrl}/api/v2/addresses/${encoded}/transactions?items_count=1`,
      ),
    ]);

  const account =
    accountResult.status === "fulfilled" ? accountResult.value : null;
  const tokenRows =
    tokenResult.status === "fulfilled" && Array.isArray(tokenResult.value)
      ? tokenResult.value
      : [];
  const transactions =
    transactionResult.status === "fulfilled"
      ? transactionResult.value
      : { items: [] };
  const tokens = tokenRows
    .filter(
      (row) =>
        row?.token?.type === "ERC-20" &&
        row?.token?.reputation !== "spam" &&
        row?.token?.exchange_rate,
    )
    .map((row) => {
      const balance = decimalAmount(
        row.value,
        Number(row.token.decimals ?? 18),
      );
      const usdValue = balance * Number(row.token.exchange_rate);
      return {
        symbol: row.token.symbol || "TOKEN",
        name: row.token.name || row.token.symbol || "Token",
        balance,
        usdValue,
      };
    })
    .filter((token) => token.usdValue >= 1)
    .sort((a, b) => b.usdValue - a.usdValue)
    .slice(0, 12);
  const timestamp = transactions?.items?.[0]?.timestamp;

  return {
    nativePrice: Number(account?.exchange_rate ?? 0),
    tokens,
    lastActivityAt: timestamp
      ? Math.floor(new Date(timestamp).getTime() / 1000)
      : null,
    detailsAvailable:
      accountResult.status === "fulfilled" ||
      tokenResult.status === "fulfilled" ||
      transactionResult.status === "fulfilled",
  };
}

async function fetchNativePrices() {
  try {
    const prices = await fetchJson(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum,binancecoin,polygon-ecosystem-token&vs_currencies=usd",
    );
    return {
      ethereum: Number(prices.ethereum?.usd ?? 0),
      binancecoin: Number(prices.binancecoin?.usd ?? 0),
      "polygon-ecosystem-token": Number(
        prices["polygon-ecosystem-token"]?.usd ?? 0,
      ),
    };
  } catch {
    return {
      ethereum: 0,
      binancecoin: 0,
      "polygon-ecosystem-token": 0,
    };
  }
}

async function networkPortfolio(
  address: string,
  config: NetworkConfig,
  prices: Awaited<ReturnType<typeof fetchNativePrices>>,
): Promise<NetworkResult> {
  const explorerUrl = `${config.explorerUrl}/address/${address}`;
  try {
    const [nativeBalance, details] = await Promise.all([
      rpcBalance(address, config.rpcUrl),
      config.blockscoutUrl
        ? blockscoutDetails(address, config.blockscoutUrl)
        : Promise.resolve({
            nativePrice: 0,
            tokens: [] as TokenBalance[],
            lastActivityAt: null,
            detailsAvailable: false,
          }),
    ]);
    const nativePrice = details.nativePrice || prices[config.priceId];
    return {
      id: config.id,
      name: config.name,
      nativeSymbol: config.nativeSymbol,
      nativeBalance,
      usdValue:
        nativeBalance * nativePrice +
        details.tokens.reduce(
          (sum, token) => sum + (token.usdValue ?? 0),
          0,
        ),
      lastActivityAt: details.lastActivityAt,
      explorerUrl,
      tokens: details.tokens,
      status: details.detailsAvailable ? "available" : "partial",
    };
  } catch {
    return {
      id: config.id,
      name: config.name,
      nativeSymbol: config.nativeSymbol,
      nativeBalance: 0,
      usdValue: 0,
      lastActivityAt: null,
      explorerUrl,
      tokens: [],
      status: "unavailable",
    };
  }
}

export async function GET(request: Request) {
  const address = new URL(request.url).searchParams.get("address")?.trim() ?? "";
  if (!isAddress(address)) {
    return Response.json(
      { error: "Geçerli bir EVM adresi gerekli." },
      { status: 400 },
    );
  }

  const prices = await fetchNativePrices();
  const results = await Promise.all(
    NETWORKS.map((network) => networkPortfolio(address, network, prices)),
  );

  return Response.json({
    address,
    updatedAt: new Date().toISOString(),
    networks: results.slice(0, 4),
    otherNetworks: results.slice(4),
  });
}
