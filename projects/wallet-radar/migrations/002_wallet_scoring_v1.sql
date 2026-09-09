INSERT INTO score_versions(version, max_points, rules, active)
VALUES (
  'v1',
  43,
  jsonb_build_object(
    'pnl_gt_5x_count', jsonb_build_object('0', 0, '1', 4, '2', 8, '3_plus', 12),
    'pnl_2x_to_5x_count', jsonb_build_object('0', 0, '1', 3, '2', 6, '3_plus', 8),
    'traded_token_count', jsonb_build_object('0', 0, '1_2', 1, '3_4', 3, '5_6', 5, '7_9', 7, '10_plus', 8),
    'average_holding_minutes', jsonb_build_object('under_5', 0, '5_9', 1, '10_14', 2, '15_19', 3, '20_plus', 5),
    'weekly_buy_count', jsonb_build_object('0', 0, '1_20', 5, '21_50', 3, '51_100', 1, 'over_100', 0),
    'native_balance_ratio', jsonb_build_object('0', 0, 'under_50_percent', 1, '50_99_percent', 3, '100_percent_plus', 5),
    'native_balance_references', jsonb_build_object('solana_sol', 0.25, 'robinhood_eth', 0.005)
  ),
  true
)
ON CONFLICT (version) DO UPDATE SET
  max_points = EXCLUDED.max_points,
  rules = EXCLUDED.rules,
  active = EXCLUDED.active;

CREATE OR REPLACE FUNCTION calculate_wallet_score_v1(
  p_pnl_gt_5x_count integer,
  p_pnl_2x_to_5x_count integer,
  p_traded_token_count integer,
  p_average_holding_seconds numeric,
  p_weekly_buy_count integer,
  p_native_balance numeric,
  p_native_balance_reference numeric
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  pnl_gt_5x_points integer := 0;
  pnl_2x_to_5x_points integer := 0;
  token_count_points integer := 0;
  holding_points integer := 0;
  weekly_buy_points integer := 0;
  balance_points integer := 0;
  available_fields integer := 0;
  raw_points integer;
  balance_ratio numeric;
BEGIN
  IF p_pnl_gt_5x_count IS NOT NULL THEN
    available_fields := available_fields + 1;
    pnl_gt_5x_points := CASE
      WHEN p_pnl_gt_5x_count >= 3 THEN 12
      WHEN p_pnl_gt_5x_count = 2 THEN 8
      WHEN p_pnl_gt_5x_count = 1 THEN 4
      ELSE 0
    END;
  END IF;

  IF p_pnl_2x_to_5x_count IS NOT NULL THEN
    available_fields := available_fields + 1;
    pnl_2x_to_5x_points := CASE
      WHEN p_pnl_2x_to_5x_count >= 3 THEN 8
      WHEN p_pnl_2x_to_5x_count = 2 THEN 6
      WHEN p_pnl_2x_to_5x_count = 1 THEN 3
      ELSE 0
    END;
  END IF;

  IF p_traded_token_count IS NOT NULL THEN
    available_fields := available_fields + 1;
    token_count_points := CASE
      WHEN p_traded_token_count >= 10 THEN 8
      WHEN p_traded_token_count >= 7 THEN 7
      WHEN p_traded_token_count >= 5 THEN 5
      WHEN p_traded_token_count >= 3 THEN 3
      WHEN p_traded_token_count >= 1 THEN 1
      ELSE 0
    END;
  END IF;

  IF p_average_holding_seconds IS NOT NULL THEN
    available_fields := available_fields + 1;
    holding_points := CASE
      WHEN p_average_holding_seconds >= 1200 THEN 5
      WHEN p_average_holding_seconds >= 900 THEN 3
      WHEN p_average_holding_seconds >= 600 THEN 2
      WHEN p_average_holding_seconds >= 300 THEN 1
      ELSE 0
    END;
  END IF;

  IF p_weekly_buy_count IS NOT NULL THEN
    available_fields := available_fields + 1;
    weekly_buy_points := CASE
      WHEN p_weekly_buy_count BETWEEN 1 AND 20 THEN 5
      WHEN p_weekly_buy_count BETWEEN 21 AND 50 THEN 3
      WHEN p_weekly_buy_count BETWEEN 51 AND 100 THEN 1
      ELSE 0
    END;
  END IF;

  IF p_native_balance IS NOT NULL AND p_native_balance_reference IS NOT NULL THEN
    available_fields := available_fields + 1;
    balance_ratio := CASE
      WHEN p_native_balance_reference > 0 THEN p_native_balance / p_native_balance_reference
      ELSE 0
    END;
    balance_points := CASE
      WHEN balance_ratio >= 1 THEN 5
      WHEN balance_ratio >= 0.5 THEN 3
      WHEN balance_ratio > 0 THEN 1
      ELSE 0
    END;
  END IF;

  raw_points := pnl_gt_5x_points
    + pnl_2x_to_5x_points
    + token_count_points
    + holding_points
    + weekly_buy_points
    + balance_points;

  RETURN jsonb_build_object(
    'score_version', 'v1',
    'raw_points', raw_points,
    'max_points', 43,
    'normalized_score', round(raw_points * 100.0 / 43, 2),
    'confidence', round(available_fields * 100.0 / 6, 2),
    'breakdown', jsonb_build_object(
      'pnl_gt_5x_count', pnl_gt_5x_points,
      'pnl_2x_to_5x_count', pnl_2x_to_5x_points,
      'traded_token_count', token_count_points,
      'average_holding_seconds', holding_points,
      'weekly_buy_count', weekly_buy_points,
      'native_balance', balance_points
    ),
    'data_present', jsonb_build_object(
      'pnl_gt_5x_count', p_pnl_gt_5x_count IS NOT NULL,
      'pnl_2x_to_5x_count', p_pnl_2x_to_5x_count IS NOT NULL,
      'traded_token_count', p_traded_token_count IS NOT NULL,
      'average_holding_seconds', p_average_holding_seconds IS NOT NULL,
      'weekly_buy_count', p_weekly_buy_count IS NOT NULL,
      'native_balance', p_native_balance IS NOT NULL AND p_native_balance_reference IS NOT NULL
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION refresh_wallet_score_v1(p_metric_id bigint)
RETURNS wallet_scores
LANGUAGE plpgsql
AS $$
DECLARE
  score_result jsonb;
  saved_score wallet_scores;
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

CREATE OR REPLACE FUNCTION sync_wallet_score_v1()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM refresh_wallet_score_v1(NEW.id);
  RETURN NEW;
END;
$$;

CREATE TRIGGER wallet_metrics_sync_score_v1
AFTER INSERT OR UPDATE OF
  pnl_gt_5x_count,
  pnl_2x_to_5x_count,
  traded_token_count,
  average_holding_seconds,
  weekly_buy_count,
  native_balance,
  native_balance_reference
ON wallet_metrics
FOR EACH ROW EXECUTE FUNCTION sync_wallet_score_v1();
