import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTelegramTrade,
  parseTelegramTransfer,
} from "../lib/telegram-transfer.ts";

test("parses an outgoing EVM tracker transfer", () => {
  const result = parseTelegramTransfer(
    "💸 TRANSFER (BASE) 🔹 stable 0x37ea4ae2f4c0706749e4a29ceda7169bed4dc774 transferred 1,250.50 USDC to 0x52a6fd93a4cdf49708466d94774db363b326213e ($1,250.50)",
    ["https://basescan.org/tx/0x14f64c9c411c4d9831fcf67a45fe4fcf067c595a75b1e53585e3be12e8b09b69"],
  );

  assert.equal(result?.network, "BASE");
  assert.equal(result?.direction, "out");
  assert.equal(result?.amount, "1250.50");
  assert.equal(result?.tokenSymbol, "USDC");
  assert.equal(result?.usdValue, "1250.50");
  assert.equal(
    result?.counterpartyAddress,
    "0x52a6fd93a4cdf49708466d94774db363b326213e",
  );
});

test("ignores buy and sell alerts", () => {
  assert.equal(
    parseTelegramTransfer("🟢 BUY KOSPI on Terminal wallet swapped USDC"),
    null,
  );
});

test("parses BUY alerts as trade evidence", () => {
  const result = parseTelegramTrade(
    "🆕 🟢 BUY KOSPI on Terminal\n2USvLoD3mn3CRrchjHwJGFnuBYkmJk29CsnAK4Cj7Td5 (example-jordan)\n\n🔹 example-jordan swapped 99.25 ($99.25) USDC for 24,055,267.04 ($99.25) KOSPI",
    [
      "https://solscan.io/account/2USvLoD3mn3CRrchjHwJGFnuBYkmJk29CsnAK4Cj7Td5",
      "https://solscan.io/token/7Lob7rg43kWwmreuxfSTuohun2atBHCXBUkW6KSfpump",
      "https://solscan.io/tx/2MYgM5mqUuWQRhcApQV43Q7NrHgCTfE7FK9sx1bxnVmxL3H3kRbyCvh6kM7KWRCogMnuiERMQR5Zx5qYr1aPLovL",
    ],
  );

  assert.equal(result?.eventType, "buy");
  assert.equal(
    result?.walletAddress,
    "2USvLoD3mn3CRrchjHwJGFnuBYkmJk29CsnAK4Cj7Td5",
  );
  assert.equal(result?.network, "SOLANA");
  assert.equal(result?.tokenSymbol, "KOSPI");
  assert.equal(result?.amount, "24055267.04");
});

test("recognizes and fully parses a Relay bridge exit", () => {
  const result = parseTelegramTransfer(
    "💸 TRANSFER (ROBINHOOD)\n🔹 example-alex\n0x87e1aa70f3947b03da668ed1e7b7291fcda22276\n\n🔹example-alex transferred 1.2 ($2,278.49) WETH @$1,898.74 to 0x19...07d6",
    [
      "https://robinhoodchain.blockscout.com/tx/0xe764a3238d2af4b7ec130a2af18e840915afeb7fb804bba37128baddc3440f50",
      "https://robinhoodchain.blockscout.com/address/0x87e1aa70f3947b03da668ed1e7b7291fcda22276",
      "https://robinhoodchain.blockscout.com/address/0x87e1aa70f3947b03da668ed1e7b7291fcda22276",
      "https://robinhoodchain.blockscout.com/token/0x42126dd0f307629685c1ca96cbd09c7924f6b3ea",
      "https://robinhoodchain.blockscout.com/address/0xc63fb7117bd11d06a622a6093895c487e28ce003",
    ],
  );

  assert.equal(result?.transferKind, "wallet");
  assert.equal(result?.serviceName, null);
  assert.equal(result?.direction, "out");
  assert.equal(result?.amount, "1.2");
  assert.equal(result?.tokenSymbol, "WETH");
  assert.equal(
    result?.counterpartyAddress,
    "0xc63fb7117bd11d06a622a6093895c487e28ce003",
  );
});

test("recognizes the destination leg of a Relay bridge as incoming", () => {
  const result = parseTelegramTransfer(
    "💸 TRANSFER (BASE)\n🔹 example-alex\n0x87e1aa70f3947b03da668ed1e7b7291fcda22276\n\nRelay transferred 1.18 ($2,255.82) WETH @$1,904.14 to 🔹example-alex",
    [
      "https://basescan.org/tx/0xda70ade0430aa1c11b46441a1f54884bdf5a3928f32ec5d62272c19b7c327227",
      "https://basescan.org/address/0x87e1aa70f3947b03da668ed1e7b7291fcda22276",
      "https://basescan.org/address/0x03e127e3d1197333de2af7d58450e318b53719d2",
      "https://basescan.org/token/0x21d24ddfb4071a4fd294ad2f7c4f5eabc2d88ba1",
      "https://basescan.org/address/0x87e1aa70f3947b03da668ed1e7b7291fcda22276",
    ],
  );

  assert.equal(result?.transferKind, "bridge");
  assert.equal(result?.direction, "in");
  assert.equal(result?.amount, "1.18");
  assert.equal(
    result?.counterpartyAddress,
    "0x03e127e3d1197333de2af7d58450e318b53719d2",
  );
});

test("uses Solscan account links as wallets and pump address as token mint", () => {
  const result = parseTelegramTransfer(
    "💸 TRANSFER\n🔹 example-sam yan\n🔹 example-sam\n\n🔹example-sam transferred a total 19,518,865.73 ($346.73) croc @$0.0000177 to multiple accounts\n└19,518,865.73 ($346.73) croc @$0.0000177 to 🔹example-sam yan\n\n💊 #croc | MC: $17.76K | Pump\nAJ45sQmmZQtFQxnJ7iJovcnpSiPKsFmpgL85HJK4pump",
    [
      "https://solscan.io/tx/2MYgM5mqUuWQRhcApQV43Q7NrHgCTfE7FK9sx1bxnVmxL3H3kRbyCvh6kM7KWRCogMnuiERMQR5Zx5qYr1aPLovL",
      "https://solscan.io/account/HkWEUfTpB5q4g9W281n2tJphV1YHuDJ1TrpNfGWWFNc1",
      "https://solscan.io/account/A7RmKqm8EXAKxsAY2oitnvPSoJGSg1Pw86Z2cuCKxu6M",
      "https://solscan.io/account/A7RmKqm8EXAKxsAY2oitnvPSoJGSg1Pw86Z2cuCKxu6M",
      "https://solscan.io/token/AJ45sQmmZQtFQxnJ7iJovcnpSiPKsFmpgL85HJK4pump",
      "https://solscan.io/account/HkWEUfTpB5q4g9W281n2tJphV1YHuDJ1TrpNfGWWFNc1",
    ],
  );

  assert.equal(result?.network, "SOLANA");
  assert.equal(
    result?.walletAddress,
    "A7RmKqm8EXAKxsAY2oitnvPSoJGSg1Pw86Z2cuCKxu6M",
  );
  assert.equal(
    result?.counterpartyAddress,
    "HkWEUfTpB5q4g9W281n2tJphV1YHuDJ1TrpNfGWWFNc1",
  );
  assert.equal(result?.tokenSymbol, "CROC");
  assert.equal(
    result?.tokenAddress,
    "AJ45sQmmZQtFQxnJ7iJovcnpSiPKsFmpgL85HJK4pump",
  );
});

test("infers an omitted EVM network from explorer links", () => {
  const result = parseTelegramTransfer(
    "💸 TRANSFER\n🔹 example-alex\n0x87e1aa70f3947b03da668ed1e7b7291fcda22276\n\n0xf3137d849e16e1e32af5a40ec4f2198770a739ca transferred 1.63 ($934.40) WBNB to 🔹example-alex",
    [
      "https://bscscan.com/tx/0x80a581a7987833537033e9c6c16290a07ed60ebf96a9284a6978b61aea6a7516",
      "https://bscscan.com/address/0xf3137d849e16e1e32af5a40ec4f2198770a739ca",
      "https://bscscan.com/address/0x87e1aa70f3947b03da668ed1e7b7291fcda22276",
    ],
  );

  assert.equal(result?.network, "BSC");
});

test("ignores ambiguous multi-account and NFT transfer alerts", () => {
  assert.equal(
    parseTelegramTransfer(
      "💸 TRANSFER (ETHEREUM)\n🔹 kübrabase\n0x1a6b744544562019106c0817a2ca8cc9290b72b0\n\n0x2cc6045281588108715851b886da0f3f2bad4399 transferred to multiple accounts\n└0 TOKEN from 0xf7...4e65 to 🔹kübrabase\n└0.23 ($438.59) WETH from 0x00...b395 to 🔹kübrabase",
    ),
    null,
  );
  assert.equal(
    parseTelegramTransfer(
      "🔗 NFT TRANSFER (ETHEREUM)\n🔹 akali\n0x1a7eab10bec9d562ca0fe52880f103730caa9002",
    ),
    null,
  );
});
