import assert from "node:assert/strict";
import test from "node:test";
import {
  presentTrackerEvents,
  type StoredTrackerEvent,
  type WalletDirectoryProfile,
} from "../lib/tracker-presentation.ts";

const wallet = "0x87e1aa70f3947b03da668ed1e7b7291fcda22276";

function storedEvent(
  values: Partial<StoredTrackerEvent> &
    Pick<
      StoredTrackerEvent,
      "id" | "network" | "txHash" | "occurredAt" | "rawText"
    >,
): StoredTrackerEvent {
  return {
    transferKind: "wallet",
    serviceName: null,
    direction: "unknown",
    walletAddress: wallet,
    counterpartyAddress: null,
    tokenSymbol: null,
    tokenAddress: null,
    amount: "Bilinmiyor",
    usdValue: null,
    sourceChatTitle: "Demo EVM Feed",
    linkedUrlsJson: "[]",
    matchedPersonName: null,
    ...values,
  };
}

test("pairs Relay legs into one bridge record with an analysis note", () => {
  const events = [
    storedEvent({
      id: "base-in",
      network: "BASE",
      txHash:
        "0xda70ade0430aa1c11b46441a1f54884bdf5a3928f32ec5d62272c19b7c327227",
      occurredAt: "2026-07-30T06:57:45.000Z",
      rawText:
        "💸 TRANSFER (BASE)\n🔹 example-alex\n0x87e1aa70f3947b03da668ed1e7b7291fcda22276\n\nRelay transferred 1.18 ($2,255.82) WETH @$1,904.14 to 🔹example-alex",
    }),
    storedEvent({
      id: "robinhood-out",
      network: "ROBINHOOD",
      txHash:
        "0xe764a3238d2af4b7ec130a2af18e840915afeb7fb804bba37128baddc3440f50",
      occurredAt: "2026-07-30T06:57:39.000Z",
      rawText:
        "💸 TRANSFER (ROBINHOOD)\n🔹 example-alex\n0x87e1aa70f3947b03da668ed1e7b7291fcda22276\n\n🔹example-alex transferred 1.2 ($2,278.49) WETH @$1,898.74 to 0x19...07d6",
    }),
  ];

  const result = presentTrackerEvents(events, new Map());

  assert.equal(result.length, 1);
  assert.equal(result[0].transferKind, "bridge");
  assert.equal(result[0].network, "ROBINHOOD");
  assert.equal(result[0].destinationNetwork, "BASE");
  assert.equal(result[0].amount, "1.2");
  assert.equal(result[0].receivedAmount, "1.18");
  assert.match(result[0].analysisNote, /ROBINHOOD → BASE bridge/);
  assert.match(result[0].analysisNote, /0,02 WETH/);
});

test("explains that a pump suffix is a token mint, not a wallet", () => {
  const sender = "A7RmKqm8EXAKxsAY2oitnvPSoJGSg1Pw86Z2cuCKxu6M";
  const recipient = "HkWEUfTpB5q4g9W281n2tJphV1YHuDJ1TrpNfGWWFNc1";
  const mint = "AJ45sQmmZQtFQxnJ7iJovcnpSiPKsFmpgL85HJK4pump";
  const event = storedEvent({
    id: "sol-transfer",
    network: "SOLANA",
    walletAddress: sender,
    txHash:
      "RaLpdafZrHn111z7VbhhxMiR65HjYNGWHvfuwxkRMDqeNYX378QUrEWpd4i9jk1pwfjyWcE8zHh76SA7Cs53BE1",
    occurredAt: "2026-07-30T05:55:47.000Z",
    rawText:
      "💸 TRANSFER\n🔹 example-sam yan\n🔹 example-sam\n\n🔹example-sam transferred a total 19,518,865.73 ($346.73) croc @$0.0000177 to multiple accounts\n└19,518,865.73 ($346.73) croc @$0.0000177 to 🔹example-sam yan\n\n💊 #croc | Pump\nAJ45sQmmZQtFQxnJ7iJovcnpSiPKsFmpgL85HJK4pump",
    linkedUrlsJson: JSON.stringify([
      `https://solscan.io/account/${recipient}`,
      `https://solscan.io/account/${sender}`,
      `https://solscan.io/account/${sender}`,
      `https://solscan.io/token/${mint}`,
      `https://solscan.io/account/${recipient}`,
    ]),
  });
  const [result] = presentTrackerEvents([event], new Map());

  assert.equal(result.walletAddress, sender);
  assert.equal(result.counterpartyAddress, recipient);
  assert.equal(result.matchedPersonName, "example-sam");
  assert.equal(result.counterpartyPersonName, "example-sam yan");
  assert.match(result.analysisNote, /example-sam, example-sam yan/);
  assert.match(result.analysisNote, /mint adresidir; cüzdan değildir/);
});

test("hides sub-20 USD, zero and unresolved transfer noise", () => {
  const events = [
    storedEvent({
      id: "tiny-token",
      network: "ROBINHOOD",
      txHash: "telegram:tiny",
      occurredAt: "2026-07-30T17:25:55.000Z",
      rawText:
        "💸 TRANSFER (ROBINHOOD)\n🔹 baya iyi\n0xb8f4af5a3f8d02399e6c489e629a9cee6b8071ab\n\n🔹baya iyi transferred 4,066.01 ($0.08) KINGCAT to 0xad099fa4724146725c426c79da9a88f28bb8d617",
    }),
    storedEvent({
      id: "unresolved",
      network: "ETHEREUM",
      txHash: "telegram:unresolved",
      occurredAt: "2026-07-30T17:20:55.000Z",
      rawText:
        "💸 TRANSFER (ETHEREUM)\n🔹 kübrabase\n0x1a6b744544562019106c0817a2ca8cc9290b72b0",
    }),
    storedEvent({
      id: "small-sol",
      network: "SOLANA",
      txHash:
        "4gF24reWJU9KKucThXDdEt75BxrT1NogPrPxvxpwTXD4V7n6qefxZ5EKzfFEjdBya7royP7kyquMwHFT8wunUYz9",
      occurredAt: "2026-07-30T16:52:30.000Z",
      rawText:
        "💸 TRANSFER\n🔹 bibakiserdem\n\nGRQefjiEV2ZDkF7oDG4vfEtakk4CnsnqSBpKWpQrEkci transferred 0.12 SOL to 🔹bibakiserdem\nDy5kUAjzMTVBmUWRw3ucYvvRxsZoHaiyfJXBwH97roa7",
    }),
  ];

  assert.deepEqual(presentTrackerEvents(events, new Map()), []);
});

test("hides regular transfers from Robinhood groups when only trades are allowed", () => {
  const events = [
    storedEvent({
      id: "robinhood-ten",
      sourceChatTitle: "Demo Chain Feed",
      network: "ROBINHOOD",
      direction: "out",
      tokenSymbol: "USDC",
      amount: "10",
      usdValue: "10",
      counterpartyAddress: "0x52a6fd93a4cdf49708466d94774db363b326213e",
      txHash: "telegram:robinhood-ten",
      occurredAt: "2026-07-30T17:25:55.000Z",
      rawText:
        "💸 TRANSFER (ROBINHOOD)\n🔹 example-alex\n0x87e1aa70f3947b03da668ed1e7b7291fcda22276\n\n0x87e1aa70f3947b03da668ed1e7b7291fcda22276 transferred 10 ($10) USDC to 0x52a6fd93a4cdf49708466d94774db363b326213e",
    }),
    storedEvent({
      id: "robinhood-above-ten",
      sourceChatTitle: "demo-low-value",
      network: "ROBINHOOD",
      direction: "out",
      tokenSymbol: "USDC",
      amount: "10.01",
      usdValue: "10.01",
      counterpartyAddress: "0x52a6fd93a4cdf49708466d94774db363b326213e",
      txHash: "telegram:robinhood-above-ten",
      occurredAt: "2026-07-30T17:26:55.000Z",
      rawText:
        "💸 TRANSFER (ROBINHOOD)\n🔹 example-alex\n0x87e1aa70f3947b03da668ed1e7b7291fcda22276\n\n0x87e1aa70f3947b03da668ed1e7b7291fcda22276 transferred 10.01 ($10.01) USDC to 0x52a6fd93a4cdf49708466d94774db363b326213e",
    }),
  ];

  const result = presentTrackerEvents(events, new Map());

  assert.deepEqual(result, []);
});

test("hides low-value AGGREGATE alerts from the tracker view", () => {
  const event = storedEvent({
    id: "robinhood-aggregate-low",
    sourceChatTitle: "Demo Chain Feed",
    network: "ROBINHOOD",
    direction: "out",
    tokenSymbol: "GME",
    amount: "0.2",
    usdValue: null,
    counterpartyAddress: "0x52a6fd93a4cdf49708466d94774db363b326213e",
    txHash: "telegram:robinhood-aggregate-low",
    occurredAt: "2026-09-05T10:00:00.000Z",
    rawText:
      "🔗 AGGREGATE3 (ROBINHOOD)\n🔹 example-contact\n0x61d4b8c29f19b3c8560e5099b0fd4471f3872b81\n\n0x23e90fc427435319dcbe4bab399646b96ad8b559 transferred to multiple accounts\n└0.2 ($3.81) GME @$19.29 to 🔹example-contact 0x61d4b8c29f19b3c8560e5099b0fd4471f3872b81",
  });

  assert.deepEqual(presentTrackerEvents([event], new Map()), []);
});

test("hides APPROVE UNIHOOD alerts from the tracker view", () => {
  const event = storedEvent({
    id: "robinhood-approve-unihood",
    sourceChatTitle: "Demo Chain Feed",
    network: "ROBINHOOD",
    direction: "unknown",
    tokenSymbol: null,
    amount: "Bilinmiyor",
    txHash: "telegram:robinhood-approve-unihood",
    occurredAt: "2026-09-05T10:00:00.000Z",
    rawText: "🆗 APPROVE UNIHOOD (ROBINHOOD)",
  });

  assert.deepEqual(presentTrackerEvents([event], new Map()), []);
});

test("anchors a transfer on the known tracked wallet instead of repeating its name", () => {
  const tracked = "Dy5kUAjzMTVBmUWRw3ucYvvRxsZoHaiyfJXBwH97roa7";
  const sender = "GRQefjiEV2ZDkF7oDG4vfEtakk4CnsnqSBpKWpQrEkci";
  const directory = new Map<string, WalletDirectoryProfile>([
    [
      tracked.toLocaleLowerCase("en-US"),
      {
        personName: "bibakiserdem",
        label: "bibakiserdem_T",
        status: "active_trade",
      },
    ],
  ]);
  const event = storedEvent({
    id: "known-recipient",
    network: "SOLANA",
    walletAddress: sender,
    counterpartyAddress: tracked,
    direction: "out",
    tokenSymbol: "USDC",
    amount: "100",
    usdValue: "100",
    txHash:
      "4gF24reWJU9KKucThXDdEt75BxrT1NogPrPxvxpwTXD4V7n6qefxZ5EKzfFEjdBya7royP7kyquMwHFT8wunUYz9",
    occurredAt: "2026-07-30T16:52:30.000Z",
    rawText:
      "💸 TRANSFER\n🔹 bibakiserdem\n\nGRQefjiEV2ZDkF7oDG4vfEtakk4CnsnqSBpKWpQrEkci transferred 100 ($100) USDC to 🔹bibakiserdem\nDy5kUAjzMTVBmUWRw3ucYvvRxsZoHaiyfJXBwH97roa7",
  });

  const [result] = presentTrackerEvents([event], directory);

  assert.equal(result.walletAddress, tracked);
  assert.equal(result.counterpartyAddress, sender);
  assert.equal(result.direction, "in");
  assert.equal(result.matchedWalletLabel, "bibakiserdem_T");
  assert.notEqual(result.counterpartyPersonName, "bibakiserdem");
  assert.match(result.analysisNote, /takipte kayıtlı değil/);
});
