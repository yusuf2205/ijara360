const { PrismaClient } = require('@prisma/client');
const db = new PrismaClient();
(async () => {
  await db.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO ijara_app');
  for (const table of ['properties', 'users', 'rooms', 'beds']) {
    await db.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE ON TABLE ${table} TO ijara_app`);
  }
  for (const table of ['sessions', 'rate_buckets']) {
    await db.$executeRawUnsafe(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE ${table} TO ijara_app`);
  }
  await db.$executeRawUnsafe('GRANT SELECT, INSERT ON TABLE audit_logs TO ijara_app');
  console.log('Runtime database privileges applied.');
})().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => db.$disconnect());
