CREATE TABLE IF NOT EXISTS public.app_settings (
  key text PRIMARY KEY,
  value_encrypted text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public._bootstrap_state (
  step text PRIMARY KEY,
  completed_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb
);

ALTER TABLE public._bootstrap_state ENABLE ROW LEVEL SECURITY;
