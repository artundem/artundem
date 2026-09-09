import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import dotenv from "dotenv";
import pg from "pg";

const [scanId, outputStem] = process.argv.slice(2);
if (!scanId || !outputStem) {
  throw new Error("Kullanım: node scripts/export-token-scan.mjs <SCAN_ID> <OUTPUT_STEM>");
}

const legacySummary = readLegacySummary(scanId);
if (legacySummary) {
  exportLegacyScan(legacySummary, scanId, outputStem);
} else {
  await exportScoredScan(scanId, outputStem);
}

function readLegacySummary(id) {
  const db = new DatabaseSync("data/monitor.db", { readOnly: true });
  try {
    const row = db.prepare("SELECT summary_json FROM scans WHERE id=?").get(id);
    return row?.summary_json ? JSON.parse(row.summary_json) : null;
  } finally {
    db.close();
  }
}

function exportLegacyScan(summary, id, stem) {
  const wallets = summary.wallets
    .filter((wallet) => wallet.included)
    .sort((left, right) =>
      (right.candidateMetrics.profit ?? Number.NEGATIVE_INFINITY) -
      (left.candidateMetrics.profit ?? Number.NEGATIVE_INFINITY)
    );

  const chainPath = summary.chain === "robinhood" ? "robinhood" : "sol";
  const csvRows = [[
    "rank",
    "wallet",
    "gmgn_url",
    "profit",
    "realized_profit",
    "unrealized_profit",
    "weekly_buy_count",
    "weekly_sell_count",
    "other_project_token_count",
    "holder_rank",
    "trader_rank",
    "candidate_sources"
  ]];

  for (const [index, wallet] of wallets.entries()) {
    csvRows.push([
      index + 1,
      wallet.wallet,
      `https://gmgn.ai/${chainPath}/address/${wallet.wallet}`,
      wallet.candidateMetrics.profit,
      wallet.candidateMetrics.realizedProfit,
      wallet.candidateMetrics.unrealizedProfit,
      wallet.weeklyBuyCount,
      wallet.weeklySellCount,
      wallet.otherProjectTokenCount,
      wallet.candidateMetrics.holderRank,
      wallet.candidateMetrics.traderRank,
      wallet.candidateSources.join("+")
    ]);
  }

  writeReports(stem, csvRows, wallets.map((wallet) => wallet.wallet));
  console.log(JSON.stringify({
    scanId: id,
    token: summary.token,
    analyzed: summary.walletsAnalyzed,
    included: wallets.length,
    csv: `${stem}.csv`,
    wallets: `${stem}-wallets.txt`,
    source: "legacy-sqlite"
  }, null, 2));
}

async function exportScoredScan(id, stem) {
  dotenv.config({ path: process.env.DOTENV_CONFIG_PATH ?? ".env" });
  if (!process.env.DATABASE_URL) {
    throw new Error(`Scan bulunamadı ve DATABASE_URL tanımlı değil: ${id}`);
  }

  const url = new URL(process.env.DATABASE_URL);
  const local = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: local ? false : { rejectUnauthorized: false }
  });

  try {
    const scan = await pool.query(`
      SELECT s.id, s.chain, s.input, s.status, s.summary, s.score_version, t.name, t.symbol
      FROM scans s
      JOIN tokens t ON t.id = s.token_id
      WHERE s.id = $1 AND s.kind = 'token-wallet-score'
    `, [id]);
    if (scan.rowCount !== 1) throw new Error(`Scan bulunamadı: ${id}`);
    if (scan.rows[0].status !== "completed") {
      throw new Error(`Scan tamamlanmamış: ${id} (${scan.rows[0].status})`);
    }

    const result = await pool.query(`
      SELECT
        w.address AS wallet_address,
        w.label AS wallet_label,
        w.category AS wallet_category,
        o.candidate_sources,
        o.holder_rank,
        o.trader_rank,
        o.target_profit,
        o.target_realized_profit,
        o.target_unrealized_profit,
        o.other_project_token_count,
        m.weekly_buy_count,
        m.weekly_sell_count,
        m.microcap_win,
        m.microcap_evidence,
        ws.raw_points,
        ws.confidence
      FROM wallet_token_observations o
      JOIN wallets w ON w.id = o.wallet_id
      JOIN wallet_metrics m ON m.observation_id = o.id
      JOIN wallet_scores ws ON ws.metric_id = m.id AND ws.score_version = $2
      WHERE o.scan_id = $1
      ORDER BY ws.raw_points DESC, o.target_profit DESC NULLS LAST, w.address
    `, [id, scan.rows[0].score_version ?? "v1"]);

    const chainPath = scan.rows[0].chain === "robinhood" ? "robinhood" : "sol";
    const csvRows = [[
      "rank",
      "wallet",
      "wallet_label",
      "wallet_category",
      "gmgn_url",
      "raw_score",
      "base_score",
      "microcap_bonus",
      "microcap_evidence",
      "confidence",
      "profit",
      "realized_profit",
      "unrealized_profit",
      "weekly_buy_count",
      "weekly_sell_count",
      "other_project_token_count",
      "holder_rank",
      "trader_rank",
      "candidate_sources"
    ]];

    for (const [index, wallet] of result.rows.entries()) {
      csvRows.push([
        index + 1,
        wallet.wallet_address,
        wallet.wallet_label,
        wallet.wallet_category,
        `https://gmgn.ai/${chainPath}/address/${wallet.wallet_address}`,
        wallet.raw_points,
        Number(wallet.raw_points) - (wallet.microcap_win ? 20 : 0),
        wallet.microcap_win ? 20 : 0,
        wallet.microcap_win ? JSON.stringify(wallet.microcap_evidence ?? {}) : "",
        wallet.confidence,
        wallet.target_profit,
        wallet.target_realized_profit,
        wallet.target_unrealized_profit,
        wallet.weekly_buy_count,
        wallet.weekly_sell_count,
        wallet.other_project_token_count,
        wallet.holder_rank,
        wallet.trader_rank,
        Array.isArray(wallet.candidate_sources) ? wallet.candidate_sources.join("+") : ""
      ]);
    }

    const addresses = result.rows.map((wallet) => wallet.wallet_address);
    writeReports(stem, csvRows, addresses);
    console.log(JSON.stringify({
      scanId: id,
      token: scan.rows[0].input,
      tokenName: scan.rows[0].name,
      tokenSymbol: scan.rows[0].symbol,
      analyzed: scan.rows[0].summary?.candidates ?? null,
      included: addresses.length,
      csv: `${stem}.csv`,
      wallets: `${stem}-wallets.txt`,
      source: "scored-postgresql"
    }, null, 2));
  } finally {
    await pool.end();
  }
}

function writeReports(stem, csvRows, walletAddresses) {
  fs.mkdirSync(path.dirname(stem), { recursive: true });
  fs.writeFileSync(`${stem}.csv`, `${csvRows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`);
  fs.writeFileSync(`${stem}-wallets.txt`, `${walletAddresses.join("\n")}\n`);
}

function csvCell(value) {
  if (value === undefined || value === null) return "";
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
