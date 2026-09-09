import assert from "node:assert/strict";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH ?? ".env" });

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL bulunamadı.");
}

const url = new URL(process.env.DATABASE_URL);
const local = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: local ? false : { rejectUnauthorized: false }
});

try {
  const version = await pool.query("SHOW server_version");
  const migrations = await pool.query("SELECT id, applied_at FROM schema_migrations ORDER BY id");
  const tables = await pool.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  const score = await pool.query(`
    SELECT calculate_wallet_score_v1(3, 3, 10, 1200, 20, 0.25, 0.25) AS result
  `);
  const scoreV2 = await pool.query(`
    SELECT calculate_wallet_score_v2(0, 0, 2, 0, 1, 0.005, 0.005, true) AS result
  `);

  const result = score.rows[0].result;
  assert.equal(Number(result.raw_points), 43);
  assert.equal(Number(result.normalized_score), 100);
  assert.equal(Number(result.confidence), 100);
  assert.equal(Number(scoreV2.rows[0].result.raw_points), 31);
  assert.equal(Number(scoreV2.rows[0].result.max_points), 63);
  assert.equal(Number(scoreV2.rows[0].result.breakdown.microcap_win), 20);

  const client = await pool.connect();
  let automaticScore;
  try {
    await client.query("BEGIN");
    const token = await client.query(`
      INSERT INTO tokens(chain, address, network, address_format, name, symbol)
      VALUES('solana', 'DbCheckToken1111111111111111111111111111111', 'solana-mainnet', 'base58', 'DB Check', 'DBC')
      RETURNING id
    `);
    const wallet = await client.query(`
      INSERT INTO wallets(chain, address)
      VALUES('solana', 'DbCheckWallet11111111111111111111111111111')
      RETURNING id
    `);
    const scanId = `db-check-${Date.now()}`;
    await client.query(`
      INSERT INTO scans(id, kind, chain, input, token_id, status, score_version, finished_at)
      VALUES($1, 'token-screen', 'solana', 'DbCheckToken1111111111111111111111111111111', $2, 'completed', 'v1', now())
    `, [scanId, token.rows[0].id]);
    const observation = await client.query(`
      INSERT INTO wallet_token_observations(scan_id, token_id, wallet_id, candidate_sources)
      VALUES($1, $2, $3, ARRAY['holder'])
      RETURNING id
    `, [scanId, token.rows[0].id, wallet.rows[0].id]);
    const metric = await client.query(`
      INSERT INTO wallet_metrics(
        observation_id,
        pnl_gt_5x_count,
        pnl_2x_to_5x_count,
        traded_token_count,
        average_holding_seconds,
        weekly_buy_count,
        native_balance,
        native_balance_symbol,
        native_balance_reference
      ) VALUES($1, 3, 3, 10, 1200, 20, 0.25, 'SOL', 0.25)
      RETURNING id
    `, [observation.rows[0].id]);
    const saved = await client.query(`
      SELECT raw_points, normalized_score, confidence
      FROM wallet_scores
      WHERE metric_id = $1 AND score_version = 'v1'
    `, [metric.rows[0].id]);
    assert.equal(saved.rowCount, 1);
    assert.equal(Number(saved.rows[0].raw_points), 43);
    assert.equal(Number(saved.rows[0].normalized_score), 100);
    automaticScore = saved.rows[0];

    const savedV2 = await client.query(`
      SELECT raw_points, max_points, confidence
      FROM wallet_scores
      WHERE metric_id = $1 AND score_version = 'v2'
    `, [metric.rows[0].id]);
    assert.equal(savedV2.rowCount, 1);
    assert.equal(Number(savedV2.rows[0].raw_points), 43);
    assert.equal(Number(savedV2.rows[0].max_points), 63);

    const score4 = await insertBoundaryWallet(client, scanId, token.rows[0].id, "Score04Wallet11111111111111111111111111111", {
      pnlGt5x: 1,
    });
    const score5 = await insertBoundaryWallet(client, scanId, token.rows[0].id, "Score05Wallet11111111111111111111111111111", {
      weeklyBuys: 1,
    });
    const score20 = await insertBoundaryWallet(client, scanId, token.rows[0].id, "Score20Wallet11111111111111111111111111111", {
      pnlGt5x: 3,
      pnl2xTo5x: 3,
    });
    const score21 = await insertBoundaryWallet(client, scanId, token.rows[0].id, "Score21Wallet11111111111111111111111111111", {
      pnlGt5x: 3,
      pnl2xTo5x: 3,
      tokenCount: 1,
    });

    assert.equal(score4, null);
    assert.equal(score5, 5);
    assert.equal(score20, 20);
    assert.equal(score21, 21);

    const retained = await client.query(`
      SELECT wallet_address, raw_points
      FROM retained_wallet_results_v1
      WHERE scan_id = $1
    `, [scanId]);
    const visible = await client.query(`
      SELECT wallet_address, raw_points
      FROM site_wallet_results_v1
      WHERE scan_id = $1
    `, [scanId]);
    const retainedScores = new Set(retained.rows.map((row) => Number(row.raw_points)));
    const visibleScores = new Set(visible.rows.map((row) => Number(row.raw_points)));
    assert.deepEqual([...retainedScores].sort((a, b) => a - b), [5, 20, 21, 43]);
    assert.deepEqual([...visibleScores].sort((a, b) => a - b), [21, 43]);

    automaticScore = {
      ...automaticScore,
      databaseBoundary: ">=5",
      siteBoundary: ">20",
    };
    await client.query("ROLLBACK");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  console.log(JSON.stringify({
    ok: true,
    serverVersion: version.rows[0].server_version,
    migrations: migrations.rows.map((row) => row.id),
    tables: tables.rows.map((row) => row.table_name),
    maxScoreTest: result,
    automaticScoreTriggerTest: automaticScore
  }, null, 2));
} finally {
  await pool.end();
}

async function insertBoundaryWallet(client, scanId, tokenId, address, values) {
  const wallet = await client.query(`
    INSERT INTO wallets(chain, address)
    VALUES('solana', $1)
    RETURNING id
  `, [address]);
  const observation = await client.query(`
    INSERT INTO wallet_token_observations(scan_id, token_id, wallet_id, candidate_sources)
    VALUES($1, $2, $3, ARRAY['holder'])
    RETURNING id
  `, [scanId, tokenId, wallet.rows[0].id]);
  const metric = await client.query(`
    INSERT INTO wallet_metrics(
      observation_id,
      pnl_gt_5x_count,
      pnl_2x_to_5x_count,
      traded_token_count,
      weekly_buy_count
    ) VALUES($1, $2, $3, $4, $5)
    RETURNING id
  `, [
    observation.rows[0].id,
    values.pnlGt5x ?? null,
    values.pnl2xTo5x ?? null,
    values.tokenCount ?? null,
    values.weeklyBuys ?? null,
  ]);
  const score = await client.query(`
    SELECT raw_points
    FROM wallet_scores
    WHERE metric_id = $1 AND score_version = 'v1'
  `, [metric.rows[0].id]);
  return score.rowCount ? Number(score.rows[0].raw_points) : null;
}
