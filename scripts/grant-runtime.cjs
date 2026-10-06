const { PrismaClient } = require('@prisma/client');
async function grantRuntime(db) {
  await db.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO ijara_app');
  for (const table of ['properties', 'users', 'rooms', 'beds', 'residents', 'occupancies']) {
    await db.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE ON TABLE ${table} TO ijara_app`);
  }
  for (const table of ['sessions', 'rate_buckets']) {
    await db.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${table} TO ijara_app`);
  }
  await db.$executeRawUnsafe('GRANT SELECT, INSERT ON TABLE audit_logs TO ijara_app');
  await db.$executeRawUnsafe('GRANT DELETE ON rooms,beds TO ijara_app');
  // Financial projections can only be changed by the trusted database functions.
  await db.$executeRawUnsafe('REVOKE INSERT, UPDATE ON residents FROM ijara_app');
  await db.$executeRawUnsafe('GRANT INSERT (id,property_id,full_name,phone,photo_url,note,created_at,updated_at), UPDATE (full_name,phone,photo_url,note,updated_at) ON residents TO ijara_app');
  await db.$executeRawUnsafe('GRANT SELECT ON charges,payments,payment_allocations TO ijara_app');
  await db.$executeRawUnsafe('GRANT INSERT (id,property_id,resident_id,room_id,bed_id,amount,type,billing_period_start,billing_period_end,due_date,grace_period_days,idempotency_key,created_by_user_id,created_at,updated_at) ON charges TO ijara_app');
  await db.$executeRawUnsafe('GRANT INSERT ON payments TO ijara_app');
  await db.$executeRawUnsafe('GRANT EXECUTE ON FUNCTION finance_refresh_property(uuid) TO ijara_app');
  for (const table of ['rental_applications','applicant_sessions','phone_challenges','application_documents','biometric_enrollment_sources','telegram_cursors']) await db.$executeRawUnsafe(`GRANT SELECT,INSERT,UPDATE ON ${table} TO ijara_app`);
  await db.$executeRawUnsafe('GRANT SELECT ON permissions TO ijara_app');
  await db.$executeRawUnsafe('GRANT SELECT,INSERT,DELETE ON user_permissions TO ijara_app');
  await db.$executeRawUnsafe('GRANT SELECT,INSERT ON application_status_history TO ijara_app');
  console.log('Runtime database privileges applied.');
}
module.exports = { grantRuntime };
if (require.main === module) {
  const db = new PrismaClient();
  grantRuntime(db).catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => db.$disconnect());
}
