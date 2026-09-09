ALTER TABLE wallet_metrics
  ADD COLUMN IF NOT EXISTS microcap_win boolean,
  ADD COLUMN IF NOT EXISTS microcap_evidence jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE score_versions SET active = false WHERE active;

INSERT INTO score_versions(version, max_points, rules, active)
VALUES (
  'v2',
  63,
  jsonb_build_object(
    'base_score_version', 'v1',
    'microcap_win', jsonb_build_object(
      'entry_market_cap_maximum_usd', 20000,
      'return_minimum_percent', 300,
      'points', 20,
      'activity_period', '7d'
    )
  ),
  true
)
ON CONFLICT (version) DO UPDATE SET
  max_points = EXCLUDED.max_points,
  rules = EXCLUDED.rules,
  active = EXCLUDED.active;

INSERT INTO wallet_score_policies(
  score_version,
  database_min_raw_points,
  site_min_raw_points_exclusive
)
VALUES ('v2', 5, 20)
ON CONFLICT (score_version) DO UPDATE SET
  database_min_raw_points = EXCLUDED.database_min_raw_points,
  site_min_raw_points_exclusive = EXCLUDED.site_min_raw_points_exclusive,
  updated_at = now();

CREATE OR REPLACE FUNCTION calculate_wallet_score_v2(
  p_pnl_gt_5x_count integer,
  p_pnl_2x_to_5x_count integer,
  p_traded_token_count integer,
  p_average_holding_seconds numeric,
  p_weekly_buy_count integer,
  p_native_balance numeric,
  p_native_balance_reference numeric,
  p_microcap_win boolean
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  base_result jsonb;
  raw_points integer;
  microcap_points integer := CASE WHEN p_microcap_win IS TRUE THEN 20 ELSE 0 END;
  available_fields integer := 0;
BEGIN
  base_result := calculate_wallet_score_v1(
    p_pnl_gt_5x_count,
    p_pnl_2x_to_5x_count,
    p_traded_token_count,
    p_average_holding_seconds,
    p_weekly_buy_count,
    p_native_balance,
    p_native_balance_reference
  );
  raw_points := (base_result->>'raw_points')::integer + microcap_points;

  SELECT count(*) INTO available_fields
  FROM jsonb_each_text(base_result->'data_present') AS fields(key, value)
  WHERE fields.value = 'true';
  IF p_microcap_win IS NOT NULL THEN available_fields := available_fields + 1; END IF;

  RETURN jsonb_build_object(
    'score_version', 'v2',
    'raw_points', raw_points,
    'max_points', 63,
    'normalized_score', round(raw_points * 100.0 / 63, 2),
    'confidence', round(available_fields * 100.0 / 7, 2),
    'breakdown', (base_result->'breakdown') || jsonb_build_object('microcap_win', microcap_points),
    'data_present', (base_result->'data_present') || jsonb_build_object('microcap_win', p_microcap_win IS NOT NULL)
  );
END;
$$;

CREATE OR REPLACE FUNCTION refresh_wallet_score_v2(p_metric_id bigint)
RETURNS wallet_scores
LANGUAGE plpgsql
AS $$
DECLARE
  score_result jsonb;
  saved_score wallet_scores;
  database_minimum smallint;
BEGIN
  SELECT calculate_wallet_score_v2(
    m.pnl_gt_5x_count,
    m.pnl_2x_to_5x_count,
    m.traded_token_count,
    m.average_holding_seconds,
    m.weekly_buy_count,
    m.native_balance,
    m.native_balance_reference,
    m.microcap_win
  )
  INTO score_result
  FROM wallet_metrics m
  WHERE m.id = p_metric_id;

  IF score_result IS NULL THEN
    RAISE EXCEPTION 'wallet_metrics id % bulunamadı', p_metric_id;
  END IF;

  SELECT database_min_raw_points INTO database_minimum
  FROM wallet_score_policies WHERE score_version = 'v2';

  IF (score_result->>'raw_points')::smallint < database_minimum THEN
    DELETE FROM wallet_scores WHERE metric_id = p_metric_id AND score_version = 'v2';
    RETURN NULL;
  END IF;

  INSERT INTO wallet_scores(
    metric_id, score_version, raw_points, max_points, normalized_score,
    confidence, breakdown, calculated_at
  ) VALUES (
    p_metric_id,
    'v2',
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

CREATE OR REPLACE FUNCTION sync_wallet_score_v2()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM refresh_wallet_score_v2(NEW.id);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS wallet_metrics_sync_score_v2 ON wallet_metrics;
CREATE TRIGGER wallet_metrics_sync_score_v2
AFTER INSERT OR UPDATE OF
  pnl_gt_5x_count,
  pnl_2x_to_5x_count,
  traded_token_count,
  average_holding_seconds,
  weekly_buy_count,
  native_balance,
  native_balance_reference,
  microcap_win
ON wallet_metrics
FOR EACH ROW EXECUTE FUNCTION sync_wallet_score_v2();

DROP VIEW IF EXISTS site_wallet_results_v1;
DROP VIEW IF EXISTS retained_wallet_results_v1;

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
JOIN wallet_scores ws ON ws.metric_id = m.id AND ws.score_version = latest.score_version
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
JOIN wallet_score_policies policy ON policy.score_version = (
  SELECT latest.score_version FROM latest_completed_token_scans latest WHERE latest.id = retained.scan_id
)
WHERE retained.raw_points > policy.site_min_raw_points_exclusive;
