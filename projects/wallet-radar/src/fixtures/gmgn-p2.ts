export const TARGET_MINT = "ALsBjXygNNjdidJQHczNz2Uw7nLqhHNfcQvDyqds5FdV";
export const OTHER_PROJECT_MINT = "8DLVKRxdctbqFxCqZu5BrEnnj9C2XhtCjwraa1EBV8xh";
export const HOLDER_WALLET = "HUJotuby6KuMj8HmZQvfmWz8cY3vTMSpZANZNhtg9g5d";
export const TRADER_WALLET = "HAphk1UUJjej6wwVpuvmxEhAeXU6om6PDWjm6vHhperb";
export const POOL_ADDRESS = "HRsPZd2GAMApGfjNHWa522UiHfG5G8Dn3CKB2A3L95jo";

export const gmgnHoldersFixture = {
  list: [
    { address: POOL_ADDRESS, addr_type: 2, exchange: "pump_amm", balance: 100_000_000 },
    {
      address: HOLDER_WALLET,
      addr_type: 0,
      exchange: "",
      balance: 31_494_010.99,
      amount_percentage: 0.0328,
      usd_value: 5_003.39,
      profit: 974.47,
      realized_profit: 0,
      unrealized_profit: 974.47,
      buy_volume_cur: 3_986.3,
      sell_volume_cur: 0,
      buy_tx_count_cur: 8,
      sell_tx_count_cur: 0
    }
  ]
};

export const gmgnTradersFixture = {
  list: [
    gmgnHoldersFixture.list[1],
    {
      address: TRADER_WALLET,
      addr_type: 0,
      exchange: "",
      balance: 19_488_035.23,
      profit: 3_188.06,
      buy_volume_cur: 11_240.73,
      sell_volume_cur: 11_344.76,
      buy_tx_count_cur: 49,
      sell_tx_count_cur: 20
    }
  ]
};

export const gmgnActivityFixture = {
  activities: [
    {
      wallet: HOLDER_WALLET,
      tx_hash: "shared-signature",
      timestamp: 1_785_640_798,
      event_type: "buy",
      token: { address: TARGET_MINT, symbol: "lemonbob" },
      quote_token: { token_address: "So11111111111111111111111111111111111111112", symbol: "WSOL" }
    },
    {
      wallet: HOLDER_WALLET,
      tx_hash: "other-token-signature",
      timestamp: 1_785_640_700,
      event_type: "buy",
      token: { address: OTHER_PROJECT_MINT, symbol: "OTHER" },
      quote_token: { token_address: "So11111111111111111111111111111111111111112", symbol: "WSOL" }
    }
  ],
  next: null
};

export const gmgnWalletStats7dFixture = {
  wallet_address: HOLDER_WALLET,
  realized_profit: "182.55",
  buy: 23,
  sell: 11,
  pnl_stat: {
    token_num: 4,
    winrate: 0.625
  }
};

export const heliusHistoryFixture = [
  {
    signature: "shared-signature",
    timestamp: 1_785_640_798,
    balanceChanges: [
      { mint: "So11111111111111111111111111111111111111112", amount: -10.02, decimals: 9 },
      { mint: TARGET_MINT, amount: 4_961_521.99, decimals: 6 }
    ]
  }
];
