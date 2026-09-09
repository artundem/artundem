CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TABLE tokens (
  id bigserial PRIMARY KEY,
  chain text NOT NULL CHECK (chain IN ('solana', 'robinhood')),
  address text NOT NULL,
  address_key text GENERATED ALWAYS AS (
    CASE WHEN chain = 'robinhood' THEN lower(address) ELSE address END
  ) STORED,
  network text NOT NULL,
  chain_id integer,
  address_format text NOT NULL CHECK (address_format IN ('base58', 'evm-0x')),
  name text,
  symbol text,
  decimals integer CHECK (decimals IS NULL OR decimals >= 0),
  total_supply text,
  holder_count bigint CHECK (holder_count IS NULL OR holder_count >= 0),
  active boolean NOT NULL DEFAULT true,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain, address_key)
);

CREATE TRIGGER tokens_set_updated_at
BEFORE UPDATE ON tokens
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE wallets (
  id bigserial PRIMARY KEY,
  chain text NOT NULL CHECK (chain IN ('solana', 'robinhood')),
  address text NOT NULL,
  address_key text GENERATED ALWAYS AS (
    CASE WHEN chain = 'robinhood' THEN lower(address) ELSE address END
  ) STORED,
  label text,
  category text,
  identity jsonb,
  funded_by jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain, address_key)
);

CREATE TRIGGER wallets_set_updated_at
BEFORE UPDATE ON wallets
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE scans (
  id text PRIMARY KEY,
  kind text NOT NULL,
  chain text NOT NULL CHECK (chain IN ('solana', 'robinhood')),
  input text NOT NULL,
  token_id bigint REFERENCES tokens(id) ON DELETE RESTRICT,
  trigger_type text NOT NULL DEFAULT 'manual' CHECK (trigger_type = 'manual'),
  status text NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
  score_version text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error_message text,
  summary jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CHECK (
    (status = 'running' AND finished_at IS NULL)
    OR (status IN ('completed', 'failed') AND finished_at IS NOT NULL)
  )
);

CREATE TABLE wallet_token_observations (
  id bigserial PRIMARY KEY,
  scan_id text NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  token_id bigint NOT NULL REFERENCES tokens(id) ON DELETE RESTRICT,
  wallet_id bigint NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
  candidate_sources text[] NOT NULL DEFAULT ARRAY[]::text[],
  holder_rank integer CHECK (holder_rank IS NULL OR holder_rank > 0),
  trader_rank integer CHECK (trader_rank IS NULL OR trader_rank > 0),
  holder_balance numeric,
  holder_percentage numeric,
  target_profit numeric,
  target_realized_profit numeric,
  target_unrealized_profit numeric,
  target_buy_count integer CHECK (target_buy_count IS NULL OR target_buy_count >= 0),
  target_sell_count integer CHECK (target_sell_count IS NULL OR target_sell_count >= 0),
  other_project_token_count integer CHECK (other_project_token_count IS NULL OR other_project_token_count >= 0),
  other_project_tokens text[] NOT NULL DEFAULT ARRAY[]::text[],
  first_trade_at timestamptz,
  last_trade_at timestamptz,
  analysis_status text NOT NULL DEFAULT 'complete' CHECK (analysis_status IN ('complete', 'partial', 'failed')),
  legacy_filter_included boolean,
  legacy_exclusion_reasons text[] NOT NULL DEFAULT ARRAY[]::text[],
  candidate_metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_providers text[] NOT NULL DEFAULT ARRAY[]::text[],
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scan_id, token_id, wallet_id)
);

CREATE TABLE wallet_metrics (
  id bigserial PRIMARY KEY,
  observation_id bigint NOT NULL UNIQUE REFERENCES wallet_token_observations(id) ON DELETE CASCADE,
  pnl_gt_5x_count integer CHECK (pnl_gt_5x_count IS NULL OR pnl_gt_5x_count >= 0),
  pnl_2x_to_5x_count integer CHECK (pnl_2x_to_5x_count IS NULL OR pnl_2x_to_5x_count >= 0),
  traded_token_count integer CHECK (traded_token_count IS NULL OR traded_token_count >= 0),
  average_holding_seconds numeric CHECK (average_holding_seconds IS NULL OR average_holding_seconds >= 0),
  weekly_buy_count integer CHECK (weekly_buy_count IS NULL OR weekly_buy_count >= 0),
  weekly_sell_count integer CHECK (weekly_sell_count IS NULL OR weekly_sell_count >= 0),
  native_balance numeric CHECK (native_balance IS NULL OR native_balance >= 0),
  native_balance_symbol text,
  native_balance_reference numeric CHECK (native_balance_reference IS NULL OR native_balance_reference > 0),
  raw_metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  observed_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER wallet_metrics_set_updated_at
BEFORE UPDATE ON wallet_metrics
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE score_versions (
  version text PRIMARY KEY,
  max_points smallint NOT NULL CHECK (max_points > 0),
  rules jsonb NOT NULL,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX score_versions_one_active
ON score_versions (active)
WHERE active;

CREATE TABLE wallet_scores (
  id bigserial PRIMARY KEY,
  metric_id bigint NOT NULL REFERENCES wallet_metrics(id) ON DELETE CASCADE,
  score_version text NOT NULL REFERENCES score_versions(version) ON DELETE RESTRICT,
  raw_points smallint NOT NULL CHECK (raw_points >= 0),
  max_points smallint NOT NULL CHECK (max_points > 0),
  normalized_score numeric(6,2) NOT NULL CHECK (normalized_score BETWEEN 0 AND 100),
  confidence numeric(6,2) NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  breakdown jsonb NOT NULL,
  calculated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (metric_id, score_version),
  CHECK (raw_points <= max_points)
);

CREATE TABLE provider_responses (
  id bigserial PRIMARY KEY,
  scan_id text NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  provider text NOT NULL,
  operation text NOT NULL,
  subject text,
  page_number integer CHECK (page_number IS NULL OR page_number > 0),
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE evidence (
  id bigserial PRIMARY KEY,
  scan_id text NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  chain text NOT NULL CHECK (chain IN ('solana', 'robinhood')),
  subject text NOT NULL,
  kind text NOT NULL,
  provider text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wallet_links (
  id bigserial PRIMARY KEY,
  scan_id text NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  source_wallet_id bigint NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
  candidate_wallet_id bigint NOT NULL REFERENCES wallets(id) ON DELETE RESTRICT,
  hop smallint NOT NULL CHECK (hop BETWEEN 1 AND 2),
  link_score numeric NOT NULL,
  reasons text[] NOT NULL DEFAULT ARRAY[]::text[],
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scan_id, source_wallet_id, candidate_wallet_id, hop)
);

CREATE INDEX scans_token_completed_idx
ON scans (token_id, finished_at DESC)
WHERE status = 'completed';

CREATE INDEX observations_wallet_idx
ON wallet_token_observations (wallet_id, created_at DESC);

CREATE INDEX observations_token_profit_idx
ON wallet_token_observations (token_id, target_profit DESC NULLS LAST);

CREATE INDEX wallet_scores_rank_idx
ON wallet_scores (score_version, normalized_score DESC, confidence DESC);

CREATE INDEX provider_responses_scan_idx
ON provider_responses (scan_id, provider, operation);

CREATE INDEX evidence_subject_idx
ON evidence (chain, subject, created_at DESC);

CREATE VIEW latest_completed_token_scans AS
SELECT DISTINCT ON (token_id)
  id,
  token_id,
  chain,
  input,
  score_version,
  started_at,
  finished_at,
  summary
FROM scans
WHERE status = 'completed' AND token_id IS NOT NULL
ORDER BY token_id, finished_at DESC;

CREATE VIEW wallet_cross_token_summary AS
SELECT
  w.id AS wallet_id,
  w.chain,
  w.address,
  count(DISTINCT o.token_id) AS token_count,
  array_agg(DISTINCT t.symbol) FILTER (WHERE t.symbol IS NOT NULL) AS token_symbols,
  min(o.created_at) AS first_observed_at,
  max(o.created_at) AS last_observed_at
FROM wallets w
JOIN wallet_token_observations o ON o.wallet_id = w.id
JOIN tokens t ON t.id = o.token_id
GROUP BY w.id, w.chain, w.address;
