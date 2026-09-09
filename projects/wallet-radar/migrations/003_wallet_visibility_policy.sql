CREATE TABLE wallet_score_policies (
  score_version text PRIMARY KEY REFERENCES score_versions(version) ON DELETE CASCADE,
  database_min_raw_points smallint NOT NULL CHECK (database_min_raw_points >= 0),
  site_min_raw_points_exclusive smallint NOT NULL CHECK (site_min_raw_points_exclusive >= database_min_raw_points),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO wallet_score_policies(
  score_version,
  database_min_raw_points,
  site_min_raw_points_exclusive
)
VALUES ('v1', 5, 20)
ON CONFLICT (score_version) DO UPDATE SET
  database_min_raw_points = EXCLUDED.database_min_raw_points,
  site_min_raw_points_exclusive = EXCLUDED.site_min_raw_points_exclusive,
  updated_at = now();

DELETE FROM wallet_scores
WHERE score_version = 'v1' AND raw_points < 5;

ALTER TABLE wallet_scores
ADD CONSTRAINT wallet_scores_v1_database_minimum
CHECK (score_version <> 'v1' OR raw_points >= 5);

CREATE OR REPLACE FUNCTION refresh_wallet_score_v1(p_metric_id bigint)
RETURNS wallet_scores
LANGUAGE plpgsql
AS $$
DECLARE
  score_result jsonb;
  saved_score wallet_scores;
  database_minimum smallint;
BEGIN
  SELECT calculate_wallet_score_v1(
    m.pnl_gt_5x_count,
    m.pnl_2x_to_5x_count,
    m.traded_token_count,
    m.average_holding_seconds,
    m.weekly_buy_count,
    m.native_balance,
    m.native_balance_reference
  )
  INTO score_result
  FROM wallet_metrics m
  WHERE m.id = p_metric_id;

  IF score_result IS NULL THEN
    RAISE EXCEPTION 'wallet_metrics id % bulunamadı', p_metric_id;
  END IF;

  SELECT database_min_raw_points
  INTO database_minimum
  FROM wallet_score_policies
  WHERE score_version = 'v1';

  IF (score_result->>'raw_points')::smallint < database_minimum THEN
    DELETE FROM wallet_scores
    WHERE metric_id = p_metric_id AND score_version = 'v1';
    RETURN NULL;
  END IF;

  INSERT INTO wallet_scores(
    metric_id,
    score_version,
    raw_points,
    max_points,
    normalized_score,
    confidence,
    breakdown,
    calculated_at
  ) VALUES (
    p_metric_id,
    score_result->>'score_version',
    (score_result->>'raw_points')::smallint,
    (score_result->>'max_points')::smallint,
    (score_result->>'normalized_score')::numeric,
    (score_result->>'confidence')::numeric,
    score_result,
    now()
  )
  ON CONFLICT (metric_id, score_version) DO UPDATE SET
    raw_points = EXCLUDED.raw_points,
    max_points = EXCLUDED.max_points,
    normalized_score = EXCLUDED.normalized_score,
    confidence = EXCLUDED.confidence,
    breakdown = EXCLUDED.breakdown,
    calculated_at = now()
  RETURNING * INTO saved_score;

  RETURN saved_score;
END;
$$;

CREATE VIEW retained_wallet_results_v1 AS
SELECT
  latest.id AS scan_id,
  latest.finished_at,
  t.id AS token_id,
  t.chain,
  t.address AS token_address,
  t.name AS token_name,
  t.symbol AS token_symbol,
  w.id AS wallet_id,
  w.address AS wallet_address,
  o.holder_rank,
  o.trader_rank,
  o.holder_percentage,
  o.target_profit,
  ws.raw_points,
  ws.max_points,
  ws.normalized_score,
  ws.confidence,
  ws.breakdown,
  ws.calculated_at
FROM latest_completed_token_scans latest
JOIN tokens t ON t.id = latest.token_id
JOIN wallet_token_observations o ON o.scan_id = latest.id AND o.token_id = t.id
JOIN wallets w ON w.id = o.wallet_id
JOIN wallet_metrics m ON m.observation_id = o.id
JOIN wallet_scores ws ON ws.metric_id = m.id AND ws.score_version = 'v1'
JOIN wallet_score_policies policy ON policy.score_version = ws.score_version
WHERE ws.raw_points >= policy.database_min_raw_points;

CREATE VIEW site_wallet_results_v1 AS
SELECT
  retained.*,
  row_number() OVER (
    PARTITION BY retained.token_id
    ORDER BY retained.raw_points DESC, retained.target_profit DESC NULLS LAST, retained.wallet_address
  ) AS score_rank
FROM retained_wallet_results_v1 retained
JOIN wallet_score_policies policy ON policy.score_version = 'v1'
WHERE retained.raw_points > policy.site_min_raw_points_exclusive;
