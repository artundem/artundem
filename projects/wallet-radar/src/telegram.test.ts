import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { parseTelegramConnection } from "./config.js";
import { TelegramApi, TelegramInbox, mayPair, parseTokenRequest, privateSender, type TelegramUpdate } from "./telegram.js";

const mint = "GMuQjK3KLzdyZTn7fLS99vxD8YGfXeHhLzzb7Dcepump";
const evm = "0x44049c08E9Fe74b871072859841883A46A9f91fd";
const message = (text: string): TelegramUpdate => ({ update_id: 12, message: {
  message_id: 9, date: 1, text, from: { id: 123 }, chat: { id: 123, type: "private" }
} });

test("Telegram yalnız tek geçerli adresi kabul eder ve zincirleri ayrı tutar", () => {
  assert.deepEqual(parseTokenRequest(mint), { chain: "solana", token: mint });
  assert.deepEqual(parseTokenRequest(`/ara robinhood ${evm}`), { chain: "robinhood", token: evm.toLowerCase() });
  assert.equal(parseTokenRequest(`/ara solana ${evm}`), undefined);
  assert.equal(parseTokenRequest(`/ara robinhood ${mint}`), undefined);
  for (const text of [`${mint}; whoami`, `$(touch x)`, `${mint}\n${evm}`, `https://evil.test/${mint}`, "I".repeat(44), "z".repeat(44)]) {
    assert.equal(parseTokenRequest(text), undefined);
  }
});
test("Telegram yalnız gerçek kullanıcıdan gelen birebir özel mesajı kabul eder", () => {
  assert.equal(privateSender(message(mint)), 123);
  const group = message(mint); group.message!.chat.type = "group";
  assert.equal(privateSender(group), undefined);
  const impersonation = message(mint); impersonation.message!.from!.id = 124;
  assert.equal(privateSender(impersonation), undefined);
  const bot = message(mint); bot.message!.from!.is_bot = true;
  assert.equal(privateSender(bot), undefined);
});
test("Telegram eşleştirmesi kod, süre ve sahip kilidini kontrol eder", () => {
  const code = "a".repeat(48);
  const connection = { token: "test", username: "test_bot", pairingHash: createHash("sha256").update(code).digest("hex"), pairingExpiresAt: 1000 };
  assert.equal(mayPair(message(`/start ${code}`), connection, 500), true);
  assert.equal(mayPair(message(`/start ${"b".repeat(48)}`), connection, 500), false);
  assert.equal(mayPair(message(`/start ${code}`), connection, 1001), false);
  assert.equal(mayPair(message(`/start ${code}`), { ...connection, ownerId: 456 }, 500), false);
});
test("Telegram cursor ve iş atomik kaydolur; update ve token tekrarları iş üretmez", () => {
  const inbox = new TelegramInbox(":memory:");
  try {
    const request = parseTokenRequest(mint)!;
    assert.equal(inbox.acknowledge(12,123,request), true);
    assert.equal(inbox.offset(),13);
    assert.equal(inbox.acknowledge(12,123,request), false);
    assert.equal(inbox.acknowledge(13,123,request), false);
    assert.equal(inbox.offset(),14);
    inbox.status(12,"reporting",JSON.stringify({ scanId: "example" }));
    assert.equal(inbox.next()!.status,"reporting");
    inbox.delivered(12,"summary_sent");
    assert.equal(inbox.next()!.summary_sent,1);
    inbox.status(12,"done");
    assert.equal(inbox.acknowledge(14,123,request),false);
    assert.equal(inbox.next(),undefined);
  } finally { inbox.close(); }
});
test("Telegram depolama hatasında cursor ilerlemez", () => {
  const inbox = new TelegramInbox(":memory:");
  try {
    inbox.db.exec("CREATE TRIGGER reject_job BEFORE INSERT ON jobs BEGIN SELECT RAISE(ABORT,'test'); END;");
    assert.throws(() => inbox.acknowledge(20,123,parseTokenRequest(mint)!));
    assert.equal(inbox.offset(),0);
  } finally { inbox.close(); }
});
test("Telegram ağ ve API hataları gizli tokenı hata mesajına taşımaz", async () => {
  const token = "test-sensitive-value";
  const badFetch = (async () => { throw new Error(`https://api.telegram.org/bot${token}/getMe`); }) as typeof fetch;
  await assert.rejects(new TelegramApi(token,badFetch).call("getMe"), error => {
    assert.ok(error instanceof Error); assert.ok(!error.message.includes(token)); assert.equal(error.cause,undefined); return true;
  });
  const badApi = (async () => new Response(JSON.stringify({ ok:false, description:token }), { status:401 })) as typeof fetch;
  await assert.rejects(new TelegramApi(token,badApi).call("getMe"), /HTTP 401/);
});
test("Telegram bozuk bağlantı dosyası veya geçersiz sahip gizli değerleri hataya taşımaz", () => {
  const token = `${123456789}:${"x".repeat(35)}`;
  const connection = { token, username: "test_bot", ownerId: 123 };
  assert.deepEqual(parseTelegramConnection(JSON.stringify(connection)), connection);
  for (const input of [token, "null", JSON.stringify({ ...connection, ownerId: -1 }), JSON.stringify({ ...connection, ownerId: "123" })]) {
    assert.throws(() => parseTelegramConnection(input), error => {
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(token));
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});
