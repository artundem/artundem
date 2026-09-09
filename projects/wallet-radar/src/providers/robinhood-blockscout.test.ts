import assert from "node:assert/strict";
import test from "node:test";
import type { AppConfig } from "../config.js";
import { normalizeTokenInfo, RobinhoodBlockscoutProvider } from "./robinhood-blockscout.js";

const config: AppConfig = {
  heliusNetwork: "mainnet-beta",
  gmgnCliPath: "gmgn-cli",
  robinhoodRpcUrl: "https://rpc.mainnet.chain.robinhood.com",
  robinhoodBlockscoutUrl: "https://example.blockscout.test",
  databasePath: ":memory:"
};

const contract = "0x9f773d0fa2578303a69e6a94f117b4b418867777";

test("normalizes Robinhood Blockscout token metadata without converting raw supply to a number", () => {
  const info = normalizeTokenInfo({
    address_hash: contract,
    name: "Stonk Broker Strategy",
    symbol: "SBS",
    decimals: "18",
    total_supply: "1000000000000000000000000000",
    holders_count: "398",
    type: "ERC-20"
  }, contract);

  assert.equal(info.address, contract);
  assert.equal(info.decimals, 18);
  assert.equal(info.totalSupply, "1000000000000000000000000000");
  assert.equal(info.holdersCount, 398);
});

test("paginates Robinhood holders with Blockscout cursor fields and preserves contract flags", async () => {
  const calls: string[] = [];
  const responses = [
    {
      items: [
        { address: { hash: "0x000000000000000000000000000000000000dEaD", is_contract: false, is_verified: false, is_scam: false }, value: "50" },
        { address: { hash: "0x2AA83f7216a60bA5657A67D9D3adc3fADab7c75b", is_contract: true, is_verified: true, is_scam: false, name: "UniswapV2Pair" }, value: "40" }
      ],
      next_page_params: { value: "40", address_hash: "0x2aa83f7216a60ba5657a67d9d3adc3fadab7c75b", items_count: 2 }
    },
    {
      items: [
        { address: { hash: "0xb8c9Dee7897AA5EB6514a954f267700E4f5dbD71", is_contract: false, is_verified: false, is_scam: false }, value: "30" }
      ],
      next_page_params: null
    }
  ];
  const provider = new RobinhoodBlockscoutProvider(config, async (url) => {
    calls.push(url);
    return responses[calls.length - 1];
  });

  const result = await provider.tokenHolders(contract, 3);

  assert.equal(result.items.length, 3);
  assert.equal(result.items[1].isContract, true);
  assert.equal(result.items[1].name, "UniswapV2Pair");
  assert.equal(result.rawResponses.length, 2);
  assert.match(calls[1], /address_hash=0x2aa83f/);
  assert.equal(result.hasMore, false);
});

test("normalizes indexed token transfer evidence", async () => {
  const provider = new RobinhoodBlockscoutProvider(config, async () => ({
    items: [{
      transaction_hash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      block_number: 123,
      log_index: 7,
      timestamp: "2026-08-02T18:34:28.000000Z",
      from: { hash: "0x2AA83f7216a60bA5657A67D9D3adc3fADab7c75b" },
      to: { hash: "0xb8c9Dee7897AA5EB6514a954f267700E4f5dbD71" },
      total: { decimals: "18", value: "36378090939016926512269" },
      method: "execute"
    }],
    next_page_params: null
  }));

  const result = await provider.tokenTransfers(contract, 1);

  assert.equal(result.items[0].blockNumber, 123);
  assert.equal(result.items[0].decimals, 18);
  assert.equal(result.items[0].value, "36378090939016926512269");
});
