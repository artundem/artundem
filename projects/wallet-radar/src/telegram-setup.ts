import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { loadTelegramConnection } from "./config.js";
import { TelegramApi } from "./telegram.js";
import { saveConnection } from "./telegram-cli.js";

// One-time loopback form: keeps bot tokens out of chat, argv and shell history.
const key = randomBytes(24).toString("hex");
const code = randomBytes(24).toString("hex");
let complete = false;
let saving = false;
const existing = loadTelegramConnection();
if (existing?.ownerId) throw new Error("Telegram zaten eşleştirilmiş; mevcut bağlantı değiştirilmedi.");
const server = createServer(async (req,res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (req.url !== `/${key}` || complete) { res.writeHead(404); res.end(); return; }
  if (req.method === "GET") {
    res.end(`<!doctype html><html lang="tr"><meta charset="utf-8"><title>Wallet Radar Telegram bağlantısı</title><style>body{font:18px system-ui;max-width:620px;margin:80px auto;padding:24px;line-height:1.6}input,button{font:inherit;padding:12px;margin-top:16px}input{width:90%}</style><h1>Özel araştırma sohbeti</h1><p>Telegram'da doğrulanmış @BotFather'a /newbot gönder. Botun adı Wallet Radar, kullanıcı adı örneğin artundem_wallet_radar_bot olsun.</p><p>BotFather'ın verdiği anahtarı aşağıya yapıştır. Anahtar yalnız bu bilgisayarda saklanır; GitHub'a veya sohbetimize gönderilmez.</p><form method="POST"><label>Bot anahtarı<input name="token" type="password" autocomplete="off" required></label><button>Telegram'ı bağla</button></form></html>`); return;
  }
  const address = server.address();
  const origin = address && typeof address === "object" ? `http://127.0.0.1:${address.port}` : "";
  if (req.method !== "POST" || req.headers.origin !== origin || saving) { res.writeHead(403); res.end(); return; }
  saving = true;
  try {
    let body = "";
    for await (const chunk of req) { body += chunk; if (body.length > 4096) throw new Error("large"); }
    const token = new URLSearchParams(body).get("token")?.trim() ?? "";
    if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) throw new Error("invalid");
    const api = new TelegramApi(token);
    const me = await api.call<{ is_bot: boolean; username: string }>("getMe");
    const webhook = await api.call<{ url: string }>("getWebhookInfo");
    if (!me.is_bot || !/^[A-Za-z0-9_]+$/.test(me.username) || webhook.url) throw new Error("invalid");
    await saveConnection({ token, username: me.username,
      pairingHash: createHash("sha256").update(code).digest("hex"), pairingExpiresAt: Date.now() + 30*60*1000 });
    complete = true;
    res.end(`<html lang="tr"><meta charset="utf-8"><title>Telegram hazır</title><h1>Son adım</h1><p><a href="https://t.me/${me.username}?start=${code}">Özel araştırma sohbetini aç</a> ve Telegram'da Başlat'a bas.</p><p>Yalnız bu bağlantıyla eşleştirdiğin hesap araştırma başlatabilecek. Bilgisayar ve uygulama açıkken mesajlar otomatik kontrol edilir.</p></html>`);
    console.log(JSON.stringify({ configured: true, bot: me.username, pairingPending: true }));
    server.close();
  } catch { res.writeHead(400); res.end("Bağlantı doğrulanamadı. Bot anahtarını kontrol edip sayfayı yenile. Mevcut webhook varsa değiştirilmedi."); }
  finally { saving = false; }
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address === "object") console.log(`Kurulum: http://127.0.0.1:${address.port}/${key}`);
});
setTimeout(() => server.close(), 30*60*1000).unref();
