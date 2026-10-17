const {test,before,after,beforeEach}=require('node:test');
const assert=require('node:assert/strict');
const request=require('supertest');
const {PrismaClient}=require('@prisma/client');
const {createApp}=require('../dist/app');
const {TelegramService,TelegramError}=require('../dist/telegram');
const {PhoneVerificationService}=require('../dist/phone-verification');
const {NotificationsService}=require('../dist/notifications');
const {grantRuntime}=require('../../../scripts/grant-runtime.cjs');
if(process.env.NODE_ENV!=='test'||new URL(process.env.DATABASE_URL).pathname!=='/ijara360_test')throw Error('Dedicated test DB only');
process.env.KYC_ENCRYPTION_KEY='7'.repeat(64);
process.env.KYC_STORAGE_PATH='/tmp/ijara360-kyc-test';
process.env.TELEGRAM_BOT_TOKEN='test-only';process.env.TELEGRAM_BOT_USERNAME='ijara_test_bot';
const db=new PrismaClient();const origin=process.env.APP_ORIGIN;const password='Staff access test password 2026';
const OWNER='+998900000001',TG=7711;
let app,server,bot,sent,fail;
const send=(a,m,p)=>a[m]('/api'+p).set('Origin',origin).set('X-Ijara-Request','1');
const internet=(a,m,p)=>send(a,m,p).set('X-Ijara-Channel','public');
const cookieOf=(res,name)=>(res.headers['set-cookie']||[]).find(c=>c.startsWith(name+'='));
const lastMessage=()=>sent.filter(s=>s.method==='sendMessage').at(-1)?.body;
before(async()=>{await grantRuntime(db);app=await createApp();await app.listen(0,'127.0.0.1');server=app.getHttpServer();bot=app.get(PhoneVerificationService);
 app.get(TelegramService).call=async(method,body)=>{if(fail)throw fail();sent.push({method,body});return true;};});
beforeEach(async()=>{sent=[];fail=null;await db.$executeRawUnsafe('TRUNCATE properties,rate_buckets CASCADE');
 await send(request(server),'post','/auth/setup').set('X-Setup-Token',process.env.SETUP_TOKEN).send({phone:OWNER,password,fullName:'Owner',propertyName:'Access',rooms:[{number:'1',capacity:1}]}).expect(201);});
after(async()=>{await db.$executeRawUnsafe('TRUNCATE properties,rate_buckets CASCADE');await app.close();await db.$disconnect();});

/** Links Telegram account TG to the owner through the bot, as a person would. */
async function link(agent,tg=TG,phone=OWNER){
 const {url}=(await send(agent,'post','/auth/telegram/link').expect(201)).body;
 const token=new URL(url).searchParams.get('start');
 await bot.handle({update_id:1,message:{from:{id:tg},chat:{id:tg,type:'private'},text:`/start ${token}`}});
 await bot.handle({update_id:2,message:{from:{id:tg},chat:{id:tg,type:'private'},contact:{user_id:tg,phone_number:phone}}});
}
const homeLogin=async()=>{const a=request.agent(server);await send(a,'post','/auth/login').send({phone:OWNER,password}).expect(200);return a;};

test('LAN or tailnet login trusts the device; the internet asks Telegram for unknown devices and refuses without a link',async()=>{
 const home=request.agent(server);
 const r=await send(home,'post','/auth/login').send({phone:OWNER,password}).expect(200);
 assert.match(cookieOf(r,'ijara_device'),/Path=\/api\/auth; .*HttpOnly/i);
 const app1=(await send(request(server),'post','/auth/login').send({phone:OWNER,password,platform:'ANDROID'}).expect(200)).body;
 assert.ok(app1.deviceToken&&app1.token,'apps get a device token in the body');
 const stranger=await internet(request(server),'post','/auth/login').send({phone:OWNER,password}).expect(403);
 assert.match(stranger.body.message,/привяжите Telegram/);
 assert.equal(cookieOf(stranger,'ijara_session'),undefined);
 await internet(home,'post','/auth/login').send({phone:OWNER,password}).expect(200);
 await internet(request(server),'post','/auth/login').send({phone:OWNER,password,platform:'ANDROID',deviceToken:app1.deviceToken}).expect(200);
 assert.equal((await internet(request(server),'get','/auth/channel').expect(200)).body.internet,true);
 assert.equal((await send(request(server),'get','/auth/channel').expect(200)).body.internet,false);
});

test('linking needs the own contact with the account phone; one Telegram per staff member',async()=>{
 const home=await homeLogin();
 assert.equal((await send(home,'get','/auth/telegram').expect(200)).body.linked,false);
 await link(home,TG,'+998901111111');
 assert.match(lastMessage().text,/не совпадает/);assert.equal((await send(home,'get','/auth/telegram').expect(200)).body.linked,false);
 const {url}=(await send(home,'post','/auth/telegram/link').expect(201)).body;const token=new URL(url).searchParams.get('start');
 await bot.handle({update_id:3,message:{from:{id:TG},chat:{id:TG,type:'private'},text:`/start ${token}`}});
 assert.equal(lastMessage().reply_markup.keyboard[0][0].request_contact,true);
 await bot.handle({update_id:4,message:{from:{id:TG},chat:{id:TG,type:'private'},contact:{user_id:999,phone_number:OWNER}}});
 assert.match(lastMessage().text,/собственный контакт/);
 await bot.handle({update_id:5,message:{from:{id:TG},chat:{id:TG,type:'private'},contact:{user_id:TG,phone_number:OWNER.slice(1)}}});
 assert.match(lastMessage().text,/Telegram привязан/);
 assert.equal((await send(home,'get','/auth/telegram').expect(200)).body.linked,true);
 assert.equal(await db.auditLog.count({where:{action:'TELEGRAM_LINKED'}}),1);
 const u=(await send(home,'post','/users').send({phone:'+998900000002',fullName:'Admin',password}).expect(201)).body;
 const admin=request.agent(server);await send(admin,'post','/auth/login').send({phone:u.phone,password}).expect(200);
 await link(admin,TG,u.phone);
 assert.match(lastMessage().text,/уже привязан к другому/);
});

test('an internet login from a new device waits for the Telegram button and yields exactly one session',async()=>{
 const home=await homeLogin();await link(home);sent=[];
 const away=request.agent(server);
 const pending=await internet(away,'post','/auth/login').send({phone:OWNER,password,remember:true}).expect(202);
 const {id,pollToken}=pending.body.approval;assert.equal(cookieOf(pending,'ijara_session'),undefined);
 const msg=lastMessage();assert.equal(msg.chat_id,String(TG));assert.match(msg.text,/нового устройства/);
 const [yes,no]=msg.reply_markup.inline_keyboard[0];assert.equal(yes.callback_data,`la:${id}`);assert.equal(no.callback_data,`ld:${id}`);
 assert.equal((await send(away,'post','/auth/login/approval').send({id,pollToken}).expect(202)).body.status,'PENDING');
 await send(away,'post','/auth/login/approval').send({id,pollToken:'x'.repeat(43)}).expect(404);
 await bot.handle({update_id:6,callback_query:{id:'q1',from:{id:4242},data:`la:${id}`}});
 assert.equal((await db.loginApproval.findUnique({where:{id}})).status,'PENDING','another Telegram account cannot approve');
 await bot.handle({update_id:7,callback_query:{id:'q2',from:{id:TG},data:`la:${id}`,message:{chat:{id:TG},message_id:5}}});
 assert.ok(sent.some(s=>s.method==='editMessageText'&&/подтверждён/.test(s.body.text)));
 const done=await send(away,'post','/auth/login/approval').send({id,pollToken}).expect(200);
 assert.ok(cookieOf(done,'ijara_session'));assert.ok(cookieOf(done,'ijara_device'));
 await send(away,'get','/auth/me').expect(200);
 await send(away,'post','/auth/login/approval').send({id,pollToken}).expect(410);
 await internet(away,'post','/auth/login').send({phone:OWNER,password}).expect(200);
 const audit=await db.auditLog.findMany({where:{action:{in:['LOGIN_APPROVAL_REQUESTED','LOGIN_APPROVED']}}});assert.equal(audit.length,2);
});

test('denied, expired and undeliverable approvals never create a session; a new password forgets trusted devices',async()=>{
 const home=await homeLogin();await link(home);
 let r=(await internet(request(server),'post','/auth/login').send({phone:OWNER,password}).expect(202)).body.approval;
 await bot.handle({update_id:8,callback_query:{id:'q3',from:{id:TG},data:`ld:${r.id}`}});
 await send(request(server),'post','/auth/login/approval').send({id:r.id,pollToken:r.pollToken}).expect(403);
 r=(await internet(request(server),'post','/auth/login').send({phone:OWNER,password}).expect(202)).body.approval;
 await db.loginApproval.update({where:{id:r.id},data:{expiresAt:new Date(Date.now()-1000)}});
 await bot.handle({update_id:9,callback_query:{id:'q4',from:{id:TG},data:`la:${r.id}`}});
 await send(request(server),'post','/auth/login/approval').send({id:r.id,pollToken:r.pollToken}).expect(410);
 fail=()=>new TelegramError(false);
 await internet(request(server),'post','/auth/login').send({phone:OWNER,password}).expect(503);fail=null;
 assert.equal(await db.loginApproval.count({where:{status:{in:['PENDING','APPROVED']},expiresAt:{gt:new Date()}}}),0,'nothing left that could still become a session');
 await internet(home,'post','/auth/login').send({phone:OWNER,password}).expect(200);
 await send(home,'post','/auth/password').send({currentPassword:password,newPassword:password+'!'}).expect(204);
 assert.equal(await db.trustedDevice.count(),0);
 await internet(home,'post','/auth/login').send({phone:OWNER,password:password+'!'}).expect(202);
 const fresh=await homeLogin2(password+'!');
 await send(fresh,'delete','/auth/telegram').expect(200);
 await internet(request(server),'post','/auth/login').send({phone:OWNER,password:password+'!'}).expect(403);
});
async function homeLogin2(pw){const a=request.agent(server);await send(a,'post','/auth/login').send({phone:OWNER,password:pw}).expect(200);return a;}

test('trusted devices are listed and removable by their owner only; linked staff get notification copies in Telegram',async()=>{
 const home=await homeLogin();await link(home);
 const list=(await send(home,'get','/auth/devices').expect(200)).body;assert.equal(list.length,1);assert.ok(!('tokenHash' in list[0]));
 const u=(await send(home,'post','/users').send({phone:'+998900000002',fullName:'Admin',password}).expect(201)).body;
 const admin=request.agent(server);await send(admin,'post','/auth/login').send({phone:u.phone,password}).expect(200);
 await send(admin,'delete',`/auth/devices/${list[0].id}`).expect(404);
 await send(home,'delete',`/auth/devices/${list[0].id}`).expect(200);
 const owner=await db.user.findUnique({where:{phone:OWNER}});
 await db.$transaction(tx=>app.get(NotificationsService).staff(tx,owner.propertyId,['TICKETS_VIEW'],{kind:'TEST',title:'Новое обращение',body:'Поломка: «Кран»'}));
 const d=await db.notificationDelivery.findMany();assert.equal(d.length,1);assert.equal(d[0].chatId,String(TG));
});

test('another staff member logging in from the internet is confirmed by the owner, never by themselves',async()=>{
 const home=await homeLogin();
 const ADMIN='+998900000002';
 const u=(await send(home,'post','/users').send({phone:ADMIN,password,fullName:'Admin Two'}).expect(201)).body;
 // The owner has no Telegram yet: refused, with the reason.
 const r0=await internet(request(server),'post','/auth/login').send({phone:ADMIN,password}).expect(403);
 assert.match(r0.body.message,/подтверждает владелец/);
 await link(home);
 sent=[];
 const away=request.agent(server);
 const pending=(await internet(away,'post','/auth/login').send({phone:ADMIN,password}).expect(202)).body.approval;
 const {id,pollToken}=pending;assert.equal(pending.confirmBy,'owner');
 const msg=lastMessage();assert.equal(String(msg.chat_id),String(TG));assert.match(msg.text,/Сотрудник Admin Two/);
 assert.equal(msg.reply_markup.inline_keyboard[0][0].text,'Разрешить');
 // Anyone else's Telegram cannot decide.
 await bot.handle({update_id:20,callback_query:{id:'a1',from:{id:5555},data:`la:${id}`}});
 assert.equal((await send(away,'post','/auth/login/approval').send({id,pollToken}).expect(202)).body.status,'PENDING');
 await bot.handle({update_id:21,callback_query:{id:'a2',from:{id:TG},data:`la:${id}`}});
 await send(away,'post','/auth/login/approval').send({id,pollToken}).expect(200);
 const audit=await db.auditLog.findFirst({where:{action:'LOGIN_APPROVED',entityId:u.id}});
 assert.ok(audit&&audit.actorId!==u.id,'the owner is recorded as the one who allowed it');
 // Residents are not affected: their app login has no Telegram step (tenant tests).
});
