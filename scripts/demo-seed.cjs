// Explicit isolated demo: no residents are created before the occupancy module exists.
const { PrismaClient } = require('@prisma/client');
const { hashPassword, normalizePhone } = require('../apps/api/dist/security');
const db = new PrismaClient();
(async () => {
  if (process.env.NODE_ENV === 'production' || process.env.DEMO_SEED !== 'true' || !new URL(process.env.DATABASE_URL).pathname.endsWith('_demo')) {
    throw new Error('Demo requires DEMO_SEED=true, a database ending in _demo and a non-production environment.');
  }
  if (!process.env.DEMO_OWNER_PASSWORD || process.env.DEMO_OWNER_PASSWORD.length < 15) throw new Error('Set a strong DEMO_OWNER_PASSWORD.');
  const phone = normalizePhone(process.env.DEMO_OWNER_PHONE || '');
  const passwordHash = await hashPassword(process.env.DEMO_OWNER_PASSWORD);
  await db.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(360001)`;
    if (await tx.property.count()) throw new Error('Demo seed requires an empty database; existing data is never overwritten.');
    const property = await tx.property.create({data:{name:'Демонстрационный дом',address:'Тестовые данные'}});
    const owner = await tx.user.create({data:{propertyId:property.id,phone,fullName:'Демо-владелец',passwordHash,role:'OWNER'}});
    for(let i=1;i<=7;i++) {
      const capacity=i<=3?9:8;
      await tx.room.create({data:{propertyId:property.id,number:String(i),capacity,beds:{create:Array.from({length:capacity},(_,n)=>({number:String(n+1)}))}}});
    }
    await tx.auditLog.create({data:{propertyId:property.id,actorId:owner.id,action:'SETUP_COMPLETED',entity:'Property',entityId:property.id,metadata:{demo:true,rooms:7,beds:59}}});
  });
  console.log('Demo created: 7 rooms, 59 beds. No production data changed.');
})().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>db.$disconnect());
