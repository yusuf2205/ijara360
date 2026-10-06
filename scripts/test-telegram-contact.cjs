// Test transport adapter only. It cannot run against production or use a real bot.
const u=new URL(process.env.DATABASE_URL);
if(process.env.NODE_ENV!=='test'||u.hostname!=='ijara360-test-postgres'||u.pathname!=='/ijara360_test'||process.env.TELEGRAM_BOT_TOKEN!=='test-only')throw Error('Dedicated test environment required');
const {createApp}=require('../apps/api/dist/app');
const {PhoneVerificationService}=require('../apps/api/dist/phone-verification');
const token=process.argv[2],number=process.argv[3];
if(!/^[A-Za-z0-9_-]{32,100}$/.test(token||'')||!/^\+998\d{9}$/.test(number||''))throw Error('Invalid test arguments');
(async()=>{const app=await createApp();await app.init();try{const service=app.get(PhoneVerificationService);service.call=async()=>true;const id=Number(number.slice(-8));await service.handle({update_id:1,message:{from:{id},chat:{id,type:'private'},text:`/start ${token}`}});await service.handle({update_id:2,message:{from:{id},chat:{id,type:'private'},contact:{user_id:id,phone_number:number}}});console.log('TEST CONTACT DELIVERED');}finally{await app.close();}})().catch(()=>{console.error('Test Telegram adapter failed');process.exitCode=1;});
