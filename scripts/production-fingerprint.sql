BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT 'properties',count(*),md5(coalesce(string_agg(row_to_json(x)::text,'|' ORDER BY id),'')) FROM properties x
UNION ALL SELECT 'rooms',count(*),md5(coalesce(string_agg(row_to_json(x)::text,'|' ORDER BY id),'')) FROM rooms x
UNION ALL SELECT 'beds',count(*),md5(coalesce(string_agg(row_to_json(x)::text,'|' ORDER BY id),'')) FROM beds x
UNION ALL SELECT 'users',count(*),md5(coalesce(string_agg(row_to_json(x)::text,'|' ORDER BY id),'')) FROM users x
UNION ALL SELECT 'sessions',count(*),md5(coalesce(string_agg(row_to_json(x)::text,'|' ORDER BY id),'')) FROM sessions x
UNION ALL SELECT 'audit_logs',count(*),md5(coalesce(string_agg(row_to_json(x)::text,'|' ORDER BY id),'')) FROM audit_logs x
UNION ALL SELECT 'occupancies',count(*),md5(coalesce(string_agg(row_to_json(x)::text,'|' ORDER BY id),'')) FROM occupancies x
-- Project the original M2 fields so adding finance columns does not change the fingerprint.
UNION ALL SELECT 'residents',count(*),md5(coalesce(string_agg(row_to_json(x)::text,'|' ORDER BY id),'')) FROM
  (SELECT id,property_id,full_name,phone,photo_url,note,created_at,updated_at FROM residents) x;
SELECT to_regclass('public.charges') IS NOT NULL AS has_finance \gset
\if :has_finance
SELECT 'charges',count(*),md5(coalesce(string_agg((to_jsonb(x)-ARRAY['status','updated_at'])::text,'|' ORDER BY id),'')) FROM charges x
UNION ALL SELECT 'payments',count(*),md5(coalesce(string_agg(row_to_json(x)::text,'|' ORDER BY id),'')) FROM payments x;
\else
SELECT 'charges',0,md5('') UNION ALL SELECT 'payments',0,md5('');
\endif
SELECT to_regclass('public.payment_allocations') IS NOT NULL AS has_allocations \gset
\if :has_allocations
SELECT 'payment_allocations',count(*),md5(coalesce(string_agg(row_to_json(x)::text,'|' ORDER BY id),'')) FROM payment_allocations x;
\else
SELECT 'payment_allocations',0,md5('');
\endif
COMMIT;
