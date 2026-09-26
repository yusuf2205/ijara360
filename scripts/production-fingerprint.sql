BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SELECT 'properties',count(*),md5(coalesce(string_agg(row_to_json(x)::text,'|' ORDER BY id),'')) FROM properties x
UNION ALL SELECT 'rooms',count(*),md5(coalesce(string_agg(row_to_json(x)::text,'|' ORDER BY id),'')) FROM rooms x
UNION ALL SELECT 'beds',count(*),md5(coalesce(string_agg(row_to_json(x)::text,'|' ORDER BY id),'')) FROM beds x
UNION ALL SELECT 'users',count(*),md5(coalesce(string_agg(row_to_json(x)::text,'|' ORDER BY id),'')) FROM users x
UNION ALL SELECT 'sessions',count(*),md5(coalesce(string_agg(row_to_json(x)::text,'|' ORDER BY id),'')) FROM sessions x
UNION ALL SELECT 'audit_logs',count(*),md5(coalesce(string_agg(row_to_json(x)::text,'|' ORDER BY id),'')) FROM audit_logs x;
COMMIT;
