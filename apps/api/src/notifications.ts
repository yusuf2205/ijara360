import {Body,Controller,Get,HttpCode,Injectable,Logger,Module,OnModuleDestroy,OnModuleInit,Post,Query,Req,UseGuards} from '@nestjs/common';
import {Prisma} from '@prisma/client';
import {Type} from 'class-transformer';
import {ArrayMaxSize,IsArray,IsInt,IsOptional,IsUUID,Max,Min} from 'class-validator';
import {AuthModule,AuthRequest,SessionGuard} from './auth';
import {Database} from './database';
import {PermissionCode} from './permission-policy';
import {Tenant,TenantGuard,TenantModule,TenantRequest} from './tenant';
import {TelegramError,TelegramModule,TelegramService} from './telegram';
import {publish} from './realtime';

const PAGE=30;
const MAX_ATTEMPTS=6;
// 30 s, 2 min, 10 min, 1 h, 6 h between attempts, then the delivery is marked FAILED.
const BACKOFF=[30,120,600,3600,21600].map(s=>s*1000);
class PageQuery{@Type(()=>Number) @IsInt() @Min(1) @Max(100000) page=1;}
class ReadDto{@IsOptional() @IsArray() @ArrayMaxSize(100) @IsUUID('4',{each:true}) ids?:string[];}

type Message={kind:string;title:string;body:string;link?:string;entity?:string;entityId?:string};
type Tx=Prisma.TransactionClient;
const view={id:true,kind:true,title:true,body:true,link:true,readAt:true,createdAt:true} as const;
const sum=(v:Prisma.Decimal|string|number)=>Math.round(Number(v)).toLocaleString('ru-RU').replace(/ /g,' ')+' сум';
const day=(d:Date)=>new Intl.DateTimeFormat('ru-RU',{timeZone:'UTC',day:'numeric',month:'long'}).format(d);
const chargeType:Record<string,string>={RENT:'Аренда',DEPOSIT:'Залог',PENALTY:'Штраф',UTILITIES:'Коммунальные',OTHER:'Начисление'};

/**
 * Notifications are written inside the caller's transaction, so a rolled-back action never notifies.
 * Telegram copies go to an outbox in the same transaction and are sent after commit by the worker below.
 */
@Injectable()
export class NotificationsService implements OnModuleInit,OnModuleDestroy{
  private readonly logger=new Logger(NotificationsService.name);
  private timer?:ReturnType<typeof setInterval>;
  private running?:Promise<number>;
  constructor(private readonly db:Database,private readonly telegram:TelegramService){}
  onModuleInit(){
    // Tests drive delivery explicitly; production polls the outbox.
    if(process.env.NODE_ENV!=='test'){this.timer=setInterval(()=>void this.deliverDue(),10000);this.timer.unref();}
  }
  async onModuleDestroy(){clearInterval(this.timer);await this.running;}

  /** To the resident's app account, if there is an active one; with a Telegram copy when the account is linked. */
  async tenant(tx:Tx,residentId:string,m:Message){
    const a=await tx.tenantAccount.findFirst({where:{residentId,active:true,activatedAt:{not:null}}});
    if(!a)return;
    const n=await tx.notification.create({data:{propertyId:a.propertyId,tenantAccountId:a.id,...m}});
    if(a.telegramUserId)await tx.notificationDelivery.create({data:{notificationId:n.id,chatId:a.telegramUserId}});
    await publish(tx,{p:a.propertyId,topic:'notifications',type:'created',residents:[residentId],staff:false});
  }
  /** To every active staff member who may use any of the given functions (owners always). */
  async staff(tx:Tx,propertyId:string,any:PermissionCode[],m:Message){
    const users=await tx.user.findMany({where:{propertyId,active:true,OR:[{role:{in:['OWNER','SUPER_ADMIN']}},{permissions:{some:{permissionCode:{in:any}}}}]},select:{id:true,telegramUserId:true}});
    if(!users.length)return;
    // Staff who linked Telegram in settings also get a copy there.
    for(const u of users){
      const n=await tx.notification.create({data:{propertyId,userId:u.id,...m}});
      if(u.telegramUserId)await tx.notificationDelivery.create({data:{notificationId:n.id,chatId:u.telegramUserId}});
    }
    await publish(tx,{p:propertyId,topic:'notifications',type:'created',users:users.map(u=>u.id)});
  }

  // Event texts in one place, so wording stays consistent between the feed and Telegram.
  chargeCreated(tx:Tx,c:{id:string;residentId:string;type:string;amount:Prisma.Decimal;dueDate:Date;billingPeriodStart:Date}){
    const what=c.type==='RENT'?`Аренда за ${new Intl.DateTimeFormat('ru-RU',{timeZone:'UTC',month:'long'}).format(c.billingPeriodStart)}`:chargeType[c.type]||'Начисление';
    return this.tenant(tx,c.residentId,{kind:'CHARGE_CREATED',title:'Новое начисление',body:`${what}: ${sum(c.amount)}, оплатить до ${day(c.dueDate)}.`,link:'/app/payments',entity:'Charge',entityId:c.id});
  }
  paymentRecorded(tx:Tx,p:{id:string;residentId:string;amount:Prisma.Decimal;unallocatedAmount:Prisma.Decimal}){
    const extra=p.unallocatedAmount.gt(0)?` ${sum(p.unallocatedAmount)} ушло в аванс.`:'';
    return this.tenant(tx,p.residentId,{kind:'PAYMENT_RECORDED',title:'Оплата зачтена',body:`Получено ${sum(p.amount)}.${extra}`,link:'/app/payments',entity:'Payment',entityId:p.id});
  }

  // Delivery worker.
  deliverDue(){
    if(this.running)return this.running;
    this.running=this.run().catch(()=>{this.logger.error('Notification delivery tick failed; next tick retries.');return 0;}).finally(()=>{this.running=undefined;});
    return this.running;
  }
  private async run(){
    if(!this.telegram.ready())return 0;
    // A worker that died mid-send leaves SENDING rows; give them back after five minutes.
    await this.db.$executeRaw`UPDATE notification_deliveries SET status='PENDING' WHERE status='SENDING' AND locked_at < now() - interval '5 minutes'`;
    const due=await this.db.$queryRaw<{id:string;chat_id:string;attempts:number;title:string;body:string}[]>`
      UPDATE notification_deliveries d SET status='SENDING', attempts=d.attempts+1, locked_at=now()
      FROM notifications n
      WHERE n.id=d.notification_id AND d.id IN (SELECT id FROM notification_deliveries WHERE status='PENDING' AND next_attempt_at<=now() ORDER BY next_attempt_at LIMIT 20 FOR UPDATE SKIP LOCKED)
      RETURNING d.id, d.chat_id, d.attempts, n.title, n.body`;
    for(const d of due){
      try{
        await this.telegram.send(d.chat_id,`${d.title}\n${d.body}`);
        await this.db.notificationDelivery.update({where:{id:d.id},data:{status:'SENT',sentAt:new Date(),lockedAt:null,lastError:null}});
      }catch(e){
        const permanent=e instanceof TelegramError&&e.permanent;
        const last=permanent||d.attempts>=MAX_ATTEMPTS;
        await this.db.notificationDelivery.update({where:{id:d.id},data:{status:last?'FAILED':'PENDING',lockedAt:null,lastError:permanent?'CHAT_UNAVAILABLE':'TELEGRAM_UNAVAILABLE',
          nextAttemptAt:new Date(Date.now()+BACKOFF[Math.min(d.attempts-1,BACKOFF.length-1)])}});
        this.logger.warn(`Telegram delivery ${d.id} ${last?'failed':'will retry'} (attempt ${d.attempts}).`);
      }
    }
    return due.length;
  }

  // Feed reads.
  private async list(where:Prisma.NotificationWhereInput,page:number){
    const [items,total,unread]=await Promise.all([
      this.db.notification.findMany({where,select:view,orderBy:[{createdAt:'desc'},{id:'desc'}],skip:(page-1)*PAGE,take:PAGE}),
      this.db.notification.count({where}),this.db.notification.count({where:{...where,readAt:null}})]);
    return {items,total,unread,page,pageSize:PAGE};
  }
  private async read(where:Prisma.NotificationWhereInput,ids?:string[]){
    const r=await this.db.notification.updateMany({where:{...where,readAt:null,...(ids?{id:{in:ids}}:{})},data:{readAt:new Date()}});
    return {read:r.count};
  }
  forTenant(t:Tenant,page:number){return this.list({tenantAccountId:t.accountId},page);}
  readTenant(t:Tenant,ids?:string[]){return this.read({tenantAccountId:t.accountId},ids);}
  async forStaff(actor:{id:string;propertyId:string},page:number){return this.list({userId:actor.id,propertyId:actor.propertyId},page);}
  readStaff(actor:{id:string;propertyId:string},ids?:string[]){return this.read({userId:actor.id,propertyId:actor.propertyId},ids);}
}

@Controller('tenant/notifications') @UseGuards(TenantGuard)
class TenantNotificationsController{
  constructor(private readonly service:NotificationsService){}
  @Get() list(@Req() req:TenantRequest,@Query() q:PageQuery){return this.service.forTenant(req.tenant,q.page);}
  @Post('read') @HttpCode(200) read(@Req() req:TenantRequest,@Body() dto:ReadDto){return this.service.readTenant(req.tenant,dto.ids);}
}
@Controller('notifications') @UseGuards(SessionGuard)
class StaffNotificationsController{
  constructor(private readonly service:NotificationsService){}
  @Get() list(@Req() req:AuthRequest,@Query() q:PageQuery){return this.service.forStaff(req.actor,q.page);}
  @Post('read') @HttpCode(200) read(@Req() req:AuthRequest,@Body() dto:ReadDto){return this.service.readStaff(req.actor,dto.ids);}
}

@Module({imports:[AuthModule,TenantModule,TelegramModule],providers:[NotificationsService],controllers:[TenantNotificationsController,StaffNotificationsController],exports:[NotificationsService]})
export class NotificationsModule{}
