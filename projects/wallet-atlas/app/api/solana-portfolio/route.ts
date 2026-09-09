const SOLANA_RPC = "https://api.mainnet-beta.solana.com";

function isSolanaAddress(value: string) {
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

async function fetchJson(url: string, init?: RequestInit) {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

export async function GET(request: Request) {
  const address = new URL(request.url).searchParams.get("address")?.trim() ?? "";
  if (!isSolanaAddress(address)) {
    return Response.json(
      { error: "Geçerli bir Solana adresi gerekli." },
      { status: 400 },
    );
  }

  try {
    const rpcResults = (await fetchJson(SOLANA_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        {
          jsonrpc: "2.0",
          id: "balance",
          method: "getBalance",
          params: [address, { commitment: "finalized" }],
        },
        {
          jsonrpc: "2.0",
          id: "tokens",
          method: "getTokenAccountsByOwner",
          params: [
            address,
            { programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" },
            { encoding: "jsonParsed", commitment: "finalized" },
          ],
        },
        {
          jsonrpc: "2.0",
          id: "activity",
          method: "getSignaturesForAddress",
          params: [address, { limit: 1, commitment: "finalized" }],
        },
      ]),
    })) as {
      id: string;
      result?: unknown;
    }[];
    const byId = new Map(rpcResults.map((item) => [item.id, item.result]));
    const lamports = Number(byId.get("balance") ?? 0);
    const balanceResult = byId.get("balance") as { value?: number } | undefined;
    const tokenResult = byId.get("tokens") as
      | {
          value?: {
            account?: {
              data?: {
                parsed?: {
                  info?: {
                    mint?: string;
                    tokenAmount?: { uiAmount?: number };
                  };
                };
              };
            };
          }[];
        }
      | undefined;
    const activityResult = byId.get("activity") as
      | { blockTime?: number | null }[]
      | undefined;
    const rawTokens = (tokenResult?.value ?? [])
      .map((row) => ({
        mint: row.account?.data?.parsed?.info?.mint ?? "",
        balance:
          row.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0,
      }))
      .filter((token) => token.mint && token.balance > 0);
    const mints = rawTokens.map((token) => token.mint).slice(0, 100);
    const [solPriceResult, tokenPrices] = await Promise.all([
      fetchJson(
        "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      ).catch(() => ({ solana: { usd: 0 } })),
      mints.length
        ? fetchJson(
            `https://api.coingecko.com/api/v3/simple/token_price/solana?contract_addresses=${encodeURIComponent(mints.join(","))}&vs_currencies=usd`,
          ).catch(() => ({}))
        : Promise.resolve({}),
    ]);
    const solBalance = (balanceResult?.value ?? lamports) / 1_000_000_000;
    const solPrice = Number(solPriceResult.solana?.usd ?? 0);
    const tokens = rawTokens
      .map((token) => {
        const price = Number(tokenPrices[token.mint.toLowerCase()]?.usd ?? 0);
        return {
          mint: token.mint,
          balance: token.balance,
          usdValue: price ? token.balance * price : null,
        };
      })
      .filter((token) => token.usdValue !== null && token.usdValue >= 1)
      .sort((a, b) => (b.usdValue ?? 0) - (a.usdValue ?? 0))
      .slice(0, 12);

    return Response.json({
      address,
      solBalance,
      usdValue:
        solBalance * solPrice +
        tokens.reduce((sum, token) => sum + (token.usdValue ?? 0), 0),
      lastActivityAt: activityResult?.[0]?.blockTime ?? null,
      tokens,
      updatedAt: new Date().toISOString(),
    });
  } catch {
    return Response.json(
      { error: "Canlı Solana portföyü şu anda alınamadı." },
      { status: 502 },
    );
  }
}
