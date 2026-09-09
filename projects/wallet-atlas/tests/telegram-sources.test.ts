import assert from "node:assert/strict";
import test from "node:test";
import {
  isVisibleTelegramTransferValue,
  shouldIngestTelegramTransferSource,
  shouldStoreTelegramMessage,
  shouldStoreTelegramTransfer,
} from "../lib/telegram-sources.ts";

test("ignores DEMO-MUTED transfer notifications regardless of casing or spacing", () => {
  assert.equal(shouldIngestTelegramTransferSource("DEMO-MUTED"), false);
  assert.equal(shouldIngestTelegramTransferSource("  demo-muted  "), false);
});

test("keeps enabled Telegram transfer sources", () => {
  assert.equal(shouldIngestTelegramTransferSource("Demo EVM Feed"), true);
  assert.equal(shouldIngestTelegramTransferSource("Demo Chain Feed"), true);
});

test("hides transfers at or below 10 USD only for Robinhood groups", () => {
  assert.equal(shouldStoreTelegramTransfer("Demo Chain Feed", "10"), false);
  assert.equal(shouldStoreTelegramTransfer("demo-low-value", "9,99"), false);
  assert.equal(shouldStoreTelegramTransfer("Demo Chain Feed", "10.01"), true);
  assert.equal(shouldStoreTelegramTransfer("Demo EVM Feed", "10"), true);
  assert.equal(isVisibleTelegramTransferValue("Demo Chain Feed", "10"), false);
  assert.equal(isVisibleTelegramTransferValue("Demo Chain Feed", "10.01"), true);
});

test("keeps only BUY and SELL alerts from Robinhood groups", () => {
  assert.equal(
    shouldStoreTelegramMessage(
      "Demo Chain Feed",
      "🔗 AGGREGATE3 (ROBINHOOD)\n└0.2 ($3.81) GME to 🔹example-contact",
    ),
    false,
  );
  assert.equal(
    shouldStoreTelegramMessage("demo-low-value", "🆗 APPROVE UNIHOOD (ROBINHOOD)"),
    false,
  );
  assert.equal(
    shouldStoreTelegramMessage("Demo Chain Feed", "⚙️ PROCESS (ROBINHOOD)"),
    false,
  );
  assert.equal(
    shouldStoreTelegramMessage(
      "Demo Chain Feed",
      "🟢 BUY GME on Robinhood wallet swapped USDC",
    ),
    true,
  );
  assert.equal(
    shouldStoreTelegramMessage(
      "demo-low-value",
      "🔴 SELL GME on Robinhood wallet swapped GME",
    ),
    true,
  );
  assert.equal(
    shouldStoreTelegramMessage(
      "Demo EVM Feed",
      "🔗 AGGREGATE3 (ROBINHOOD)\n└0.2 ($3.81) GME",
    ),
    true,
  );
});
