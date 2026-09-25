const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { PrismaClient } = require('@prisma/client');
const { createApp } = require('../dist/app');
const { normalizePhone, hashPassword, verifyPassword } = require('../dist/security');

const databaseName = new URL(process.env.DATABASE_URL).pathname;
if (process.env.NODE_ENV !== 'test' || databaseName !== '/ijara360_test') {
  throw new Error('Tests require NODE_ENV=test and a dedicated database named ijara360_test.');
}
const db = new PrismaClient();
let app, server;
const origin = process.env.APP_ORIGIN;
const password = 'Test-only strong passphrase 2026';
const setup = { phone: '+998900000001', password, fullName: 'Тестовый владелец', propertyName: 'Тестовый дом', rooms: [{ number: '1', capacity: 3 }, { number: '2', capacity: 2 }] };
const send = (agent, method, path) => agent[method](`/api${path}`).set('Origin', origin).set('X-Ijara-Request', '1');
async function reset() {
  await db.$executeRawUnsafe('TRUNCATE TABLE audit_logs, sessions, users, beds, rooms, properties, rate_buckets CASCADE');
}
async function owner() {
  await send(request(server), 'post', '/auth/setup').set('X-Setup-Token', process.env.SETUP_TOKEN).send(setup).expect(201);
  const agent = request.agent(server);
  await send(agent, 'post', '/auth/login').send({ phone: setup.phone, password }).expect(200);
  return agent;
}
before(async () => { process.env.ADDITIONAL_APP_ORIGINS = 'https://mynas.tail4bf75c.ts.net:8446'; app = await createApp(); await app.init(); server = app.getHttpServer(); });
beforeEach(reset);
after(async () => { await reset(); await app.close(); await db.$disconnect(); });

test('unit: phone normalization and rejection', () => {
  assert.equal(normalizePhone('+998 (90) 123-45-67'), '+998901234567');
  assert.throws(() => normalizePhone('901234567'));
  assert.throws(() => normalizePhone('+998<script>'));
});
test('unit: salted password hashing and verification', async () => {
  const a = await hashPassword(password), b = await hashPassword(password);
  assert.notEqual(a, b); assert.equal(await verifyPassword(password, a), true);
  assert.equal(await verifyPassword('incorrect', a), false);
});
test('setup requires a secret and creates OWNER, property, rooms and beds atomically', async () => {
  await send(request(server), 'post', '/auth/setup').set('X-Setup-Token', 'bad').send(setup).expect(403);
  assert.equal(await db.user.count(), 0);
  const agent = await owner();
  const me = await send(agent, 'get', '/auth/me').expect(200);
  assert.equal(me.body.role, 'OWNER'); assert.equal(me.body.passwordHash, undefined);
  assert.equal(await db.room.count(), 2); assert.equal(await db.bed.count(), 5);
  await send(request(server), 'post', '/auth/setup').set('X-Setup-Token', process.env.SETUP_TOKEN).send(setup).expect(409);
});
test('concurrent initial setup creates exactly one owner', async () => {
  const results = await Promise.all([1,2].map(() => send(request(server), 'post', '/auth/setup').set('X-Setup-Token', process.env.SETUP_TOKEN).send(setup)));
  assert.deepEqual(results.map(r => r.status).sort(), [201,409]);
  assert.equal(await db.user.count({ where: { role: 'OWNER' } }), 1);
});
test('login rejects incorrect credentials, role injection and cross-origin writes', async () => {
  const agent = await owner();
  await send(request(server), 'post', '/auth/login').send({ phone: setup.phone, password: 'bad' }).expect(401);
  await send(request(server), 'post', '/auth/login').send({ phone: setup.phone, password, role: 'OWNER' }).expect(422);
  await agent.post('/api/rooms').set('Origin', 'https://evil.invalid').set('X-Ijara-Request','1').send({number:'3',capacity:1}).expect(403);
  await agent.post('/api/rooms').set('Origin', origin).send({number:'3',capacity:1}).expect(403);
  await request(server).get('/api/rooms').expect(401);
});
test('remote HTTPS origin can log in while unlisted origins and missing CSRF header fail', async () => {
  await owner();
  const remote = 'https://mynas.tail4bf75c.ts.net:8446';
  const credentials = { phone: setup.phone, password };
  await request(server).post('/api/auth/login').set('Origin', remote).set('X-Ijara-Request', '1').send(credentials).expect(200);
  await request(server).post('/api/auth/login').set('Origin', remote).send(credentials).expect(403);
  await request(server).post('/api/auth/login').set('Origin', 'https://mynas.tail4bf75c.ts.net').set('X-Ijara-Request', '1').send(credentials).expect(403);
});

test('logout and expired sessions lose access', async () => {
  const agent = await owner();
  await send(agent, 'post', '/auth/logout').expect(204);
  await send(agent, 'get', '/rooms').expect(401);
  await send(agent, 'post', '/auth/login').send({ phone: setup.phone, password }).expect(200);
  await db.session.updateMany({ data: { expiresAt: new Date(0) } });
  await send(agent, 'get', '/rooms').expect(401);
});
test('malformed JSON is rejected as a client error', async () => {
  await send(request(server), 'post', '/auth/login').set('Content-Type', 'application/json').send('{broken').expect(400);
});
test('create room, room detail, normalized duplicate number and validation', async () => {
  const agent = await owner();
  const room = await send(agent, 'post', '/rooms').send({ number: ' 3а ', capacity: 9 }).expect(201);
  assert.equal(room.body.number, '3А'); assert.equal(room.body.beds.length, 9);
  assert.equal(room.body.beds[0].status, 'AVAILABLE');
  await send(agent, 'get', `/rooms/${room.body.id}`).expect(200);
  await send(agent, 'post', '/rooms').send({ number: '3А', capacity: 9 }).expect(409);
  await send(agent, 'post', '/rooms').send({ number: '4', capacity: 0 }).expect(422);
  await send(agent, 'post', '/rooms').send({ number: '4', capacity: 2, bedCount: 3 }).expect(409);
  assert.equal(await db.room.count({where:{number:'4'}}), 0);
});
test('create bed, reject duplicate and server-side capacity overflow', async () => {
  const agent = await owner();
  const room = (await send(agent, 'post', '/rooms').send({ number:'3', capacity:2, bedCount:0 }).expect(201)).body;
  await send(agent, 'post', `/rooms/${room.id}/beds`).send({number:'1'}).expect(201);
  await send(agent, 'post', `/rooms/${room.id}/beds`).send({number:'1'}).expect(409);
  await send(agent, 'post', `/rooms/${room.id}/beds`).send({number:'2'}).expect(201);
  await send(agent, 'post', `/rooms/${room.id}/beds`).send({number:'3'}).expect(409);
  assert.equal(await db.bed.count({where:{roomId:room.id}}),2);
});
test('two simultaneous API requests cannot exceed room capacity', async () => {
  const agent = await owner();
  const room = (await send(agent, 'post', '/rooms').send({number:'3',capacity:1,bedCount:0}).expect(201)).body;
  const results = await Promise.all(['1','2'].map(number => send(agent,'post',`/rooms/${room.id}/beds`).send({number})));
  assert.deepEqual(results.map(r=>r.status).sort(), [201,409]);
  assert.equal(await db.bed.count({where:{roomId:room.id}}),1);
});
test('DB constraints reject overflow, wrong phone, capacity shrink and audit mutation', async () => {
  await owner();
  const room = await db.room.findFirst({where:{number:'1'}});
  await assert.rejects(db.bed.create({data:{roomId:room.id,number:'4'}}));
  await assert.rejects(db.room.update({where:{id:room.id},data:{capacity:1}}));
  await assert.rejects(db.auditLog.updateMany({data:{action:'TAMPER'}}));
  await assert.rejects(db.user.updateMany({data:{phone:'bad'}}));
});
test('concurrent direct DB writes also obey the capacity trigger', async () => {
  await owner();
  const property = await db.property.findFirst();
  const room = await db.room.create({data:{propertyId:property.id,number:'3',capacity:1}});
  const results = await Promise.allSettled(['1','2'].map(number=>db.bed.create({data:{roomId:room.id,number}})));
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
  assert.equal(await db.bed.count({where:{roomId:room.id}}),1);
});
test('room edits reject stale versions and increment successful versions', async () => {
  const agent = await owner();
  const room = (await send(agent,'get','/rooms').expect(200)).body[0];
  const updated = await send(agent,'patch',`/rooms/${room.id}`).send({number:'01',capacity:4,version:room.version}).expect(200);
  assert.equal(updated.body.version, room.version+1);
  await send(agent,'patch',`/rooms/${room.id}`).send({number:'01',capacity:5,version:room.version}).expect(409);
});
test('ADMIN permissions, disable access immediately and protect OWNER', async () => {
  const agent = await owner();
  const created = (await send(agent,'post','/users').send({phone:'+998900000002',fullName:'Управляющий',password}).expect(201)).body;
  const admin = request.agent(server);
  await send(admin,'post','/auth/login').send({phone:created.phone,password}).expect(200);
  await send(admin,'get','/rooms').expect(200);
  await send(admin,'post','/rooms').send({number:'3',capacity:2}).expect(403);
  await send(admin,'get','/users').expect(403);
  await send(agent,'patch',`/users/${created.id}`).send({active:false}).expect(200);
  await send(admin,'get','/rooms').expect(401);
  const me=(await send(agent,'get','/auth/me')).body;
  await send(agent,'patch',`/users/${me.id}`).send({active:false}).expect(409);
});
test('property scope hides foreign rooms and audit', async () => {
  const agent = await owner();
  const foreign = await db.property.create({data:{name:'Другой дом'}});
  const room = await db.room.create({data:{propertyId:foreign.id,number:'99',capacity:1}});
  await send(agent,'get',`/rooms/${room.id}`).expect(404);
  await send(agent,'post',`/rooms/${room.id}/beds`).send({number:'1'}).expect(404);
  const result=await send(agent,'get','/rooms'); assert.equal(result.body.some(r=>r.id===room.id),false);
});
test('dashboard reflects persisted room/bed counts and does not invent finance data', async () => {
  const agent = await owner();
  const dashboard=(await send(agent,'get','/dashboard').expect(200)).body;
  assert.equal(dashboard.roomsCount,2); assert.equal(dashboard.bedsCount,5); assert.equal(dashboard.availableBeds,5);
  assert.equal(dashboard.debt,undefined); assert.equal(dashboard.phase,'M2');
});
test('audit failure rolls back the room and beds', async () => {
  const agent=await owner();
  await db.$executeRawUnsafe("CREATE FUNCTION test_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'ROOM_CREATED' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $$");
  await db.$executeRawUnsafe('CREATE TRIGGER test_audit_failure BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION test_audit_failure()');
  try {
    await send(agent,'post','/rooms').send({number:'3',capacity:8}).expect(500);
    assert.equal(await db.room.count({where:{number:'3'}}),0); assert.equal(await db.bed.count(),5);
  } finally {
    await db.$executeRawUnsafe('DROP TRIGGER test_audit_failure ON audit_logs');
    await db.$executeRawUnsafe('DROP FUNCTION test_audit_failure()');
  }
});
test('password change revokes every session and accepts only the new password', async () => {
  const agent=await owner();
  await send(agent,'post','/auth/password').send({currentPassword:password,newPassword:'Another test-only long passphrase'}).expect(204);
  await send(agent,'get','/rooms').expect(401);
  await send(agent,'post','/auth/login').send({phone:setup.phone,password}).expect(401);
  await send(agent,'post','/auth/login').send({phone:setup.phone,password:'Another test-only long passphrase'}).expect(200);
});
test('persistent login rate limit survives multiple requests', async () => {
  for (let i=0;i<10;i++) await send(request(server),'post','/auth/login').send({phone:'+998900000099',password:'wrong'}).expect(401);
  const result=await send(request(server),'post','/auth/login').send({phone:'+998900000099',password:'wrong'}).expect(429);
  assert.equal(result.headers['retry-after'],'900');
});
