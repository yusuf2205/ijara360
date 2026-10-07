-- M5: functions of M1-M3 become grantable permissions.
INSERT INTO permissions(code) VALUES ('ROOMS_MANAGE'),('RESIDENTS_MANAGE'),('FINANCE_VIEW'),('FINANCE_MANAGE');

-- Compatibility: every existing ADMIN keeps exactly what the role allowed before
-- (residents and finance; rooms and property stay owner-only).
INSERT INTO user_permissions(user_id, property_id, permission_code)
SELECT u.id, u.property_id, p.code
FROM users u CROSS JOIN (VALUES ('RESIDENTS_MANAGE'),('FINANCE_VIEW'),('FINANCE_MANAGE')) AS p(code)
WHERE u.role = 'ADMIN'
ON CONFLICT DO NOTHING;
