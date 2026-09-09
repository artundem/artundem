import dotenv from "dotenv";
import pg from "pg";

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH ?? ".env" });

const scanId = process.argv[2];
const weeklyBuyMaximum = Number(process.argv[3] ?? 71);
if (!scanId) throw new Error("Kullanım: node scripts/simulate-score-gate.mjs <SCAN_ID> [HAFTALIK_BUY_MAKSIMUM=71]");
if (!Number.isInteger(weeklyBuyMaximum) || weeklyBuyMaximum < 1) {
  throw new Error("HAFTALIK_BUY_MAKSIMUM pozitif bir tam sayı olmalıdır.");
}
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL bulunamadı.");

const url = new URL(process.env.DATABASE_URL);
const local = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: local ? false : { rejectUnauthorized: false }
});

try {
  const result = await pool.query(`
    WITH classified AS (
      SELECT
        CASE
          WHEN m.weekly_buy_count IS NULL OR m.traded_token_count IS NULL THEN 'missing_gate_data'
          WHEN m.weekly_buy_count < 1 OR m.weekly_buy_count > $2 THEN 'weekly_buy_out_of_range'
          WHEN m.traded_token_count < 2 THEN 'no_other_token_in_7d'
          ELSE 'eligible'
        END AS gate,
        (calculate_wallet_score_v1(
          m.pnl_gt_5x_count,
          m.pnl_2x_to_5x_count,
          m.traded_token_count,
          m.average_holding_seconds,
          m.weekly_buy_count,
          m.native_balance,
          m.native_balance_reference
        )->>'raw_points')::integer AS raw_points
      FROM wallet_token_observations o
      JOIN wallet_metrics m ON m.observation_id = o.id
      WHERE o.scan_id = $1
    )
    SELECT
      count(*)::integer AS total,
      count(*) FILTER (WHERE gate = 'weekly_buy_out_of_range')::integer AS weekly_buy_rejected,
      count(*) FILTER (WHERE gate = 'no_other_token_in_7d')::integer AS no_other_token_rejected,
      count(*) FILTER (WHERE gate = 'missing_gate_data')::integer AS missing_gate_data_rejected,
      count(*) FILTER (WHERE gate = 'eligible')::integer AS eligibility_passed,
      count(*) FILTER (WHERE gate = 'eligible' AND raw_points < 5)::integer AS score_below_database_minimum,
      count(*) FILTER (WHERE gate = 'eligible' AND raw_points >= 5)::integer AS database_wallets,
      count(*) FILTER (WHERE gate = 'eligible' AND raw_points > 20)::integer AS site_wallets
    FROM classified
  `, [scanId, weeklyBuyMaximum]);
  console.log(JSON.stringify({ scanId, weeklyBuyMaximum, ...result.rows[0] }, null, 2));
} finally {
  await pool.end();
}
