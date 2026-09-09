import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../dist/config.js";
import { GmgnProvider } from "../dist/providers/gmgn.js";

const [wallet, thresholdText = "50000", outputStem = "reports/wallet-bought-tokens"] = process.argv.slice(2);
const threshold = Number(thresholdText);

if (!wallet || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) {
  throw new Error("Geçerli bir Solana wallet adresi gerekli.");
}
if (!Number.isFinite(threshold) || threshold < 0) {
  throw new Error("Market cap eşiği sıfır veya daha büyük olmalı.");
}

const provider = new GmgnProvider(loadConfig());
const activities = [];
let cursor;

for (let page = 0; page < 50; page += 1) {
  const response = await provider.portfolioActivity("sol", wallet, {
    limit: 200,
    cursor,
    types: ["buy"]
  });
  const value = unwrapValue(response);
  const pageActivities = Array.isArray(value?.activities) ? value.activities : [];
  activities.push(...pageActivities);
  const next = firstString(value, ["next", "next_cursor", "cursor"]);
  if (!next || next === cursor) break;
  cursor = next;
}

const buys = dedupeActivities(activities).filter((activity) => {
  const type = firstString(activity, ["event_type", "type"])?.toLowerCase();
  return type === "buy" && tokenAddress(activity);
});
const grouped = new Map();

for (const activity of buys) {
  const address = tokenAddress(activity);
  if (!address) continue;
  const current = grouped.get(address) ?? {
    address,
    activitySymbol: firstString(asRecord(activity.token), ["symbol"]),
    buyCount: 0,
    totalBuyUsd: 0,
    firstBuyAt: null,
    lastBuyAt: null
  };
  const timestamp = normalizeTimestamp(firstNumber(activity, ["timestamp", "block_timestamp", "time"]));
  const costUsd = firstNumber(activity, ["cost_usd"]);
  current.buyCount += 1;
  current.totalBuyUsd += costUsd ?? 0;
  if (timestamp !== null) {
    current.firstBuyAt = current.firstBuyAt === null ? timestamp : Math.min(current.firstBuyAt, timestamp);
    current.lastBuyAt = current.lastBuyAt === null ? timestamp : Math.max(current.lastBuyAt, timestamp);
  }
  grouped.set(address, current);
}

const tokens = [];
const warnings = [];
const candidates = [...grouped.values()];

for (const [index, candidate] of candidates.entries()) {
  process.stderr.write(`[wallet-marketcap] ${index + 1}/${candidates.length} ${candidate.address}\n`);
  try {
    const info = asRecord(await provider.tokenInfo("sol", candidate.address));
    const price = firstNumber(asRecord(info.price), ["price", "price_usd"])
      ?? firstNumber(info, ["price_usd", "price"]);
    const supply = firstNumber(info, ["circulating_supply", "total_supply", "supply"]);
    const explicitMarketCap = firstNumber(info, ["market_cap", "market_cap_usd"]);
    const marketCapUsd = explicitMarketCap ?? (
      price !== undefined && supply !== undefined ? price * supply : undefined
    );
    tokens.push({
      address: candidate.address,
      name: firstString(info, ["name"]) ?? candidate.activitySymbol ?? candidate.address,
      symbol: firstString(info, ["symbol"]) ?? candidate.activitySymbol ?? null,
      currentPriceUsd: price ?? null,
      currentSupply: supply ?? null,
      currentMarketCapUsd: marketCapUsd ?? null,
      liquidityUsd: firstNumber(info, ["liquidity"]) ?? firstNumber(asRecord(info.pool), ["liquidity"]) ?? null,
      buyCount: candidate.buyCount,
      totalBuyUsd: round(candidate.totalBuyUsd),
      firstBuyAt: formatTimestamp(candidate.firstBuyAt),
      lastBuyAt: formatTimestamp(candidate.lastBuyAt),
      gmgnUrl: `https://gmgn.ai/sol/token/${candidate.address}`,
      qualifies: marketCapUsd !== undefined && marketCapUsd >= threshold
    });
  } catch (error) {
    warnings.push({
      address: candidate.address,
      error: error instanceof Error ? error.message.replaceAll(candidate.address, "[token]") : String(error)
    });
  }
}

const qualifying = tokens
  .filter((token) => token.qualifies)
  .sort((left, right) => (right.currentMarketCapUsd ?? 0) - (left.currentMarketCapUsd ?? 0));

await fs.mkdir(path.dirname(outputStem), { recursive: true });
await fs.writeFile(`${outputStem}.json`, `${JSON.stringify({
  wallet,
  thresholdUsd: threshold,
  activityBuys: buys.length,
  distinctTokens: candidates.length,
  qualifying,
  allTokens: tokens,
  warnings
}, null, 2)}\n`);
await fs.writeFile(`${outputStem}.csv`, `${toCsv(qualifying)}\n`);

console.log(JSON.stringify({
  wallet,
  thresholdUsd: threshold,
  activityBuys: buys.length,
  distinctTokens: candidates.length,
  qualifying: qualifying.length,
  warnings: warnings.length,
  csv: `${outputStem}.csv`,
  json: `${outputStem}.json`,
  results: qualifying
}, null, 2));

function unwrapValue(value) {
  let current = value;
  for (let depth = 0; depth < 5; depth += 1) {
    const record = asRecord(current);
    const next = record.data ?? record.result;
    if (next === undefined) break;
    current = next;
  }
  return asRecord(current);
}

function dedupeActivities(rows) {
  const seen = new Set();
  return rows.filter((activity) => {
    const key = [
      firstString(activity, ["tx_hash", "signature"]) ?? "",
      firstString(activity, ["event_type", "type"]) ?? "",
      tokenAddress(activity) ?? "",
      firstString(activity, ["token_amount"]) ?? "",
      firstString(activity, ["cost_usd"]) ?? ""
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function tokenAddress(activity) {
  return firstString(asRecord(activity.token), ["address", "token_address"]);
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function firstString(record, keys) {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function firstNumber(record, keys) {
  for (const key of keys) {
    const value = record?.[key];
    const number = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(number)) return number;
  }
  return undefined;
}

function normalizeTimestamp(value) {
  if (value === undefined) return null;
  return value > 10_000_000_000 ? Math.floor(value / 1_000) : Math.floor(value);
}

function formatTimestamp(value) {
  return value === null ? null : new Date(value * 1_000).toISOString();
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function toCsv(rows) {
  const table = [[
    "rank", "name", "symbol", "contract", "current_market_cap_usd", "current_price_usd",
    "liquidity_usd", "buy_count", "total_buy_usd", "first_buy_at", "last_buy_at", "gmgn_url"
  ]];
  rows.forEach((row, index) => table.push([
    index + 1,
    row.name,
    row.symbol,
    row.address,
    row.currentMarketCapUsd,
    row.currentPriceUsd,
    row.liquidityUsd,
    row.buyCount,
    row.totalBuyUsd,
    row.firstBuyAt,
    row.lastBuyAt,
    row.gmgnUrl
  ]));
  return table.map((row) => row.map(csvCell).join(",")).join("\n");
}

function csvCell(value) {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
