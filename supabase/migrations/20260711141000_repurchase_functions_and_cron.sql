-- Módulo 2: função de predição de recompra, métricas do dashboard e pg_cron.
SET search_path TO whatsapp_hub;

-- Predição: intervalo médio por par (cliente, produto) + próxima data prevista.
CREATE OR REPLACE FUNCTION whatsapp_hub.compute_repurchase_predictions()
RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = whatsapp_hub, pg_temp
AS $$
DECLARE
  v_min int;
  v_count int := 0;
BEGIN
  SELECT min_purchases INTO v_min FROM whatsapp_hub.repurchase_config WHERE id = 1;
  v_min := COALESCE(v_min, 3);

  WITH agg AS (
    SELECT
      customer_doc, product_name,
      max(customer_phone) FILTER (WHERE customer_phone IS NOT NULL) AS customer_phone,
      max(customer_name)  FILTER (WHERE customer_name  IS NOT NULL) AS customer_name,
      count(DISTINCT purchase_date) AS purchase_count,
      min(purchase_date) AS first_purchase,
      max(purchase_date) AS last_purchase
    FROM whatsapp_hub.sales_records
    WHERE customer_doc IS NOT NULL
    GROUP BY customer_doc, product_name
    HAVING count(DISTINCT purchase_date) >= v_min
  ),
  calc AS (
    SELECT customer_doc, product_name, customer_phone, customer_name, purchase_count, last_purchase,
      GREATEST(1, round((last_purchase - first_purchase)::numeric / NULLIF(purchase_count - 1, 0)))::int AS avg_interval_days
    FROM agg
  ),
  upsert AS (
    INSERT INTO whatsapp_hub.repurchase_predictions
      (customer_doc, customer_phone, customer_name, product_name, avg_interval_days,
       purchase_count, last_purchase, predicted_next, status, updated_at)
    SELECT customer_doc, COALESCE(customer_phone, ''), customer_name, product_name,
      avg_interval_days, purchase_count, last_purchase, last_purchase + avg_interval_days, 'pending', now()
    FROM calc
    ON CONFLICT (customer_doc, product_name) DO UPDATE SET
      customer_phone = EXCLUDED.customer_phone,
      customer_name = EXCLUDED.customer_name,
      avg_interval_days = EXCLUDED.avg_interval_days,
      purchase_count = EXCLUDED.purchase_count,
      last_purchase = EXCLUDED.last_purchase,
      predicted_next = EXCLUDED.predicted_next,
      status = CASE WHEN EXCLUDED.last_purchase > whatsapp_hub.repurchase_predictions.last_purchase
                    THEN 'pending' ELSE whatsapp_hub.repurchase_predictions.status END,
      updated_at = now()
    RETURNING 1
  )
  SELECT count(*) INTO v_count FROM upsert;
  RETURN v_count;
END;
$$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.compute_repurchase_predictions() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION whatsapp_hub.compute_repurchase_predictions() TO authenticated, service_role;

-- Métricas agregadas do dashboard de vendas.
CREATE OR REPLACE FUNCTION whatsapp_hub.sales_dashboard(p_window_days int DEFAULT 90)
RETURNS jsonb
LANGUAGE sql SECURITY DEFINER SET search_path = whatsapp_hub, pg_temp
AS $$
  WITH base AS (SELECT * FROM whatsapp_hub.sales_records),
  active AS (
    SELECT DISTINCT customer_doc FROM base
    WHERE customer_doc IS NOT NULL AND purchase_date >= (current_date - make_interval(days => p_window_days))
  ),
  per_customer AS (
    SELECT customer_doc, count(DISTINCT product_name) AS produtos
    FROM base WHERE customer_doc IS NOT NULL GROUP BY customer_doc
  ),
  ranking AS (
    SELECT product_name, count(*) AS compras, sum(quantity) AS qtd
    FROM base GROUP BY product_name ORDER BY count(*) DESC LIMIT 5
  ),
  intervals AS (SELECT avg_interval_days FROM whatsapp_hub.repurchase_predictions)
  SELECT jsonb_build_object(
    'total_records', (SELECT count(*) FROM base),
    'active_customers', (SELECT count(*) FROM active),
    'avg_products_per_customer', COALESCE((SELECT round(avg(produtos), 1) FROM per_customer), 0),
    'avg_ticket', COALESCE((SELECT round(avg(amount), 2) FROM base WHERE amount IS NOT NULL), 0),
    'avg_repurchase_interval', COALESCE((SELECT round(avg(avg_interval_days)) FROM intervals), 0),
    'top_products', COALESCE((SELECT jsonb_agg(jsonb_build_object('product', product_name, 'compras', compras, 'qtd', qtd)) FROM ranking), '[]'::jsonb),
    'at_risk_count', (SELECT count(*) FROM whatsapp_hub.repurchase_predictions
                      WHERE status = 'pending'
                        AND predicted_next <= current_date + (SELECT lead_days FROM whatsapp_hub.repurchase_config WHERE id=1))
  );
$$;
REVOKE EXECUTE ON FUNCTION whatsapp_hub.sales_dashboard(int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION whatsapp_hub.sales_dashboard(int) TO authenticated, service_role;

-- pg_cron: roda a predição diariamente às 09h (o disparo real respeita o
-- kill-switch auto_send, DESLIGADO por padrão).
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'repurchase-predictions-daily';
SELECT cron.schedule('repurchase-predictions-daily', '0 9 * * *',
  $$select whatsapp_hub.compute_repurchase_predictions();$$);
