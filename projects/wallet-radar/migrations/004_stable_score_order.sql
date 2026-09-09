CREATE OR REPLACE VIEW site_wallet_results_v1 AS
SELECT
  retained.*,
  row_number() OVER (
    PARTITION BY retained.token_id
    ORDER BY
      retained.raw_points DESC,
      COALESCE(NULLIF(o.candidate_metrics->>'source_order', '')::integer, 2147483647)
  ) AS score_rank
FROM retained_wallet_results_v1 retained
JOIN wallet_score_policies policy ON policy.score_version = 'v1'
JOIN wallet_token_observations o
  ON o.scan_id = retained.scan_id
 AND o.token_id = retained.token_id
 AND o.wallet_id = retained.wallet_id
WHERE retained.raw_points > policy.site_min_raw_points_exclusive;
