import {Body,Controller,Get,HttpCode,Injectable,Logger,Module,OnModuleDestroy,OnModuleInit,Post,Query,Req,UseGuards} from '@nestjs/common';
import {Prisma} from '@prisma/client';
import {Type} from 'class-transformer';
import {ArrayMaxSize,IsArray,IsInt,IsOptional,IsString,IsUUID,Length,Max,Min} from 'class-validator';
import {ForbiddenException} from '@nestjs/common';
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
class AnnouncementDto{@IsString() @Length(1,160) title!:string; @IsString() @Length(1,1000) body!:string;}

type Message={kind:string;title:string;body:string;link?:string;entity?:string;entityId?:string};
type Tx=Prisma.TransactionClient;
const view={id:true,kind:true,title:true,body:true,link:true,readAt:true,createdAt:true} as const;
const sum=(v:Prisma.Decimal|string|number)=>Math.round(Number(v)).toLocaleString('ru-RU').replace(/ /g,' ')+' сум';
const day=(d:Date)=>new Intl.DateTimeFormat('ru-RU',{timeZone:'UTC',day:'numeric',month:'long'}).format(d);
const dayYear=(d:Date)=>new Intl.DateTimeFormat('ru-RU',{timeZone:'UTC',day:'numeric',month:'long',year:'numeric'}).format(d);
const chargeType:Record<string,string>={RENT:'Аренда',DEPOSIT:'Залог',PENALTY:'Штраф',UTILITIES:'Коммунальные',OTHER:'Начисление'};
// Uzbek (Latin) for residents who chose it in the app; staff always read Russian.
export type Lang='ru'|'uz';
const uzMonths=['yanvar','fevral','mart','aprel','may','iyun','iyul','avgust','sentabr','oktabr','noyabr','dekabr'];
const dayUz=(d:Date)=>`${d.getUTCDate()}-${uzMonths[d.getUTCMonth()]}`;
const dayYearUz=(d:Date)=>`${d.getUTCFullYear()}-yil ${dayUz(d)}`;
const sumUz=(v:Prisma.Decimal|string|number)=>sum(v).replace('сум','so‘m');
const chargeTypeUz:Record<string,string>={RENT:'Ijara',DEPOSIT:'Garov',PENALTY:'Jarima',UTILITIES:'Kommunal to‘lovlar',OTHER:'Hisob'};
/** "Аренда за ноябрь" / "Noyabr oyi uchun ijara". */
const chargeName=(lang:Lang,c:{type:string;billingPeriodStart:Date})=>{
  if(lang==='uz'){const m=uzMonths[c.billingPeriodStart.getUTCMonth()];return c.type==='RENT'?`${m[0].toUpperCase()}${m.slice(1)} oyi uchun ijara`:chargeTypeUz[c.type]||'Hisob';}
  return c.type==='RENT'?`Аренда за ${new Intl.DateTimeFormat('ru-RU',{timeZone:'UTC',month:'long'}).format(c.billingPeriodStart)}`:chargeType[c.type]||'Начисление';
};

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
  async tenant(tx:Tx,residentId:string,m:Message|((lang:Lang)=>Message)){
    const a=await tx.tenantAccount.findFirst({where:{residentId,active:true,activatedAt:{not:null}}});
    if(!a)return;
    // A message builder gets the resident's language; plain messages (owner announcements) go as written.
    const msg=typeof m==='function'?m(a.lang==='uz'?'uz':'ru'):m;
    const n=await tx.notification.create({data:{propertyId:a.propertyId,tenantAccountId:a.id,...msg}});
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

  // Event texts in one place, so wording stays consistent between the feed and Telegram. Each builds the
  // resident's language: Russian or Uzbek.
  chargeCreated(tx:Tx,c:{id:string;residentId:string;type:string;amount:Prisma.Decimal;dueDate:Date;billingPeriodStart:Date}){
    return this.tenant(tx,c.residentId,lang=>({kind:'CHARGE_CREATED',link:'/app/payments',entity:'Charge',entityId:c.id,...(lang==='uz'
      ?{title:'Yangi hisob',body:`${chargeName(lang,c)}: ${sumUz(c.amount)}, ${dayUz(c.dueDate)} gacha to‘lang.`}
      :{title:'Новое начисление',body:`${chargeName(lang,c)}: ${sum(c.amount)}, оплатить до ${day(c.dueDate)}.`})}));
  }
  paymentRecorded(tx:Tx,p:{id:string;residentId:string;amount:Prisma.Decimal;unallocatedAmount:Prisma.Decimal}){
    return this.tenant(tx,p.residentId,lang=>({kind:'PAYMENT_RECORDED',link:'/app/payments',entity:'Payment',entityId:p.id,...(lang==='uz'
      ?{title:'To‘lov qabul qilindi',body:`${sumUz(p.amount)} qabul qilindi.${p.unallocatedAmount.gt(0)?` ${sumUz(p.unallocatedAmount)} avansga o‘tkazildi.`:''}`}
      :{title:'Оплата зачтена',body:`Получено ${sum(p.amount)}.${p.unallocatedAmount.gt(0)?` ${sum(p.unallocatedAmount)} ушло в аванс.`:''}`})}));
  }
  // A rent reminder: the day before/of the due date, or once the charge is overdue. Sent at most once a day per charge (see FinanceService.remindDue).
  remindPayment(tx:Tx,c:{id:string;residentId:string;type:string;dueAmount:Prisma.Decimal;dueDate:Date;billingPeriodStart:Date},daysLeft:number){
    return this.tenant(tx,c.residentId,lang=>{
      const what=chargeName(lang,c);
      const [title,body]=lang==='uz'
        ? daysLeft<0
          ? ['To‘lov muddati o‘tdi',`${what}: ${-daysLeft} kun kechikdi. To‘lash kerak: ${sumUz(c.dueAmount)}.`]
          : ['To‘lov eslatmasi',`${what}: ${sumUz(c.dueAmount)}. To‘lov muddati: ${daysLeft===0?'bugun':`${dayUz(c.dueDate)} (${daysLeft} kundan keyin)`}.`]
        : daysLeft<0
          ? ['Просрочен платёж',`${what}: просрочен на ${-daysLeft} дн. К оплате ${sum(c.dueAmount)}.`]
          : ['Напоминание об оплате',`${what}: ${sum(c.dueAmount)}. Срок оплаты ${daysLeft===0?'сегодня':`${day(c.dueDate)} (через ${daysLeft} дн.)`}.`];
      return {kind:'PAYMENT_REMINDER',title,body,link:'/app/payments',entity:'Charge',entityId:c.id};
    });
  }
  // End of stay (see ResidentsService.remindStays). The resident: two weeks, three days and the last day.
  stayEnding(tx:Tx,residentId:string,occupancyId:string,end:Date,daysLeft:number){
    return this.tenant(tx,residentId,lang=>({kind:'STAY_ENDING',link:'/app',entity:'Occupancy',entityId:occupancyId,...(lang==='uz'
      ?{title:'Yashash muddati',body:`Shartnoma bo‘yicha yashash muddatingiz ${daysLeft===0?'bugun':`${dayUz(end)} kuni (${daysLeft} kundan keyin)`} tugaydi. Uzaytirmoqchi bo‘lsangiz, ma’muriyatga xabar bering.`}
      :{title:'Срок проживания',body:`Ваше проживание по договору заканчивается ${daysLeft===0?'сегодня':`${day(end)} (через ${daysLeft} дн.)`}. Если хотите продлить, сообщите администрации.`})}));
  }
  // Staff: three days before, on the last day and once the date has passed.
  stayEndingStaff(tx:Tx,propertyId:string,o:{residentId:string;occupancyId:string;fullName:string;room:string;bed:string;end:Date;daysLeft:number}){
    const [title,when]=o.daysLeft<0?['Срок проживания истёк',`истёк ${day(o.end)}`]:['Скоро выезд',o.daysLeft===0?'заканчивается сегодня':`заканчивается ${day(o.end)} (через ${o.daysLeft} дн.)`];
    return this.staff(tx,propertyId,['RESIDENTS_MANAGE'],{kind:'STAY_ENDING',title,body:`${o.fullName}, комната ${o.room}, место ${o.bed}: срок проживания ${when}. Продлите срок или оформите выселение.`,link:`/residents/${o.residentId}`,entity:'Occupancy',entityId:o.occupancyId});
  }
  stayPlanChanged(tx:Tx,residentId:string,occupancyId:string,end:Date|null){
    return this.tenant(tx,residentId,lang=>({kind:'STAY_PLAN_CHANGED',link:'/app',entity:'Occupancy',entityId:occupancyId,...(lang==='uz'
      ?{title:'Yashash muddati',body:end?`Shartnoma bo‘yicha yashash muddatingiz: ${dayYearUz(end)} gacha.`:'Yashash muddatining tugash sanasi olib tashlandi.'}
      :{title:'Срок проживания',body:end?`Ваше проживание по договору — до ${dayYear(end)}.`:'Дата окончания проживания снята.'})}));
  }
  // Tickets: the staff reply and status changes, in the resident's language (the ticket text itself stays as written).
  ticketReplied(tx:Tx,residentId:string,ticket:{id:string;title:string},snippet:string){
    return this.tenant(tx,residentId,lang=>({kind:'TICKET_REPLIED',title:lang==='uz'?'Murojaatingizga javob':'Ответ на обращение',body:`«${ticket.title}»: ${snippet}`,link:`/app/tickets/${ticket.id}`,entity:'Ticket',entityId:ticket.id}));
  }
  ticketStatus(tx:Tx,residentId:string,ticket:{id:string;title:string},status:string){
    const told:Record<Lang,Record<string,string>>={
      ru:{IN_PROGRESS:'Обращение взято в работу',RESOLVED:'Обращение решено',REJECTED:'Обращение отклонено'},
      uz:{IN_PROGRESS:'Murojaatingiz ko‘rib chiqilmoqda',RESOLVED:'Murojaatingiz hal qilindi',REJECTED:'Murojaatingiz rad etildi'}};
    if(!told.ru[status])return;
    return this.tenant(tx,residentId,lang=>({kind:'TICKET_STATUS',title:told[lang][status],body:`«${ticket.title}»`,link:`/app/tickets/${ticket.id}`,entity:'Ticket',entityId:ticket.id}));
  }

  /** An owner's broadcast to every resident who uses the app: one feed item each, with a Telegram copy when linked. */
  async announce(actor:{id:string;propertyId:string},dto:{title:string;body:string}){
    return this.db.$transaction(async tx=>{
      const accounts=await tx.tenantAccount.findMany({where:{propertyId:actor.propertyId,active:true,activatedAt:{not:null}},select:{id:true,telegramUserId:true,residentId:true}});
      for(const a of accounts){
        const n=await tx.notification.create({data:{propertyId:actor.propertyId,tenantAccountId:a.id,kind:'ANNOUNCEMENT',title:dto.title,body:dto.body,link:'/app'}});
        if(a.telegramUserId)await tx.notificationDelivery.create({data:{notificationId:n.id,chatId:a.telegramUserId}});
      }
      await tx.auditLog.create({data:{propertyId:actor.propertyId,actorId:actor.id,action:'ANNOUNCEMENT_SENT',entity:'Property',entityId:actor.propertyId,metadata:{title:dto.title,recipients:accounts.length}}});
      if(accounts.length)await publish(tx,{p:actor.propertyId,topic:'notifications',type:'created',residents:accounts.map(a=>a.residentId),staff:false});
      return {recipients:accounts.length};
    });
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
  @Post('announce') @HttpCode(200) announce(@Req() req:AuthRequest,@Body() dto:AnnouncementDto){
    if(!['OWNER','SUPER_ADMIN'].includes(req.actor.role))throw new ForbiddenException('Это действие доступно владельцу.');
    return this.service.announce(req.actor,dto);
  }
}

@Module({imports:[AuthModule,TenantModule,TelegramModule],providers:[NotificationsService],controllers:[TenantNotificationsController,StaffNotificationsController],exports:[NotificationsService]})
export class NotificationsModule{}
