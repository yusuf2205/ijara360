import { Body, ConflictException, Controller, ForbiddenException, Get, Injectable, Logger, Module, NotFoundException, OnModuleDestroy, OnModuleInit, Param, ParseUUIDPipe, Post, Query, Req, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { Actor, AuthModule, AuthRequest, SessionGuard } from './auth';
import { Database } from './database';
import { PermissionCode, requireAccess } from './permission-policy';
import { ChargeDto, FinanceQuery, PaymentDto } from './finance.dto';
import { NotificationsModule, NotificationsService } from './notifications';
import { publish } from './realtime';

export function financeDate(value: string) {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== value || value < '1900-01-01')
    throw new UnprocessableEntityException('Укажите существующую дату в формате ГГГГ-ММ-ДД.');
  return date;
}
const money = (value: string) => {
  const amount = new Prisma.Decimal(value);
  if (amount.lte(0)) throw new UnprocessableEntityException('Сумма должна быть больше нуля.');
  return amount;
};
const chargeInclude = { resident:{select:{id:true,fullName:true}}, bed:{select:{id:true,number:true}}, room:{select:{id:true,number:true}} };
// Today as the house lives it (Tashkent), so the payment-day decision never drifts with the server clock's zone.
function tashkentToday() {
  const iso = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tashkent',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  return { iso, month: iso.slice(0,7), year:+iso.slice(0,4), monthNo:+iso.slice(5,7), day:+iso.slice(8,10) };
}
// A stable UUID per (occupancy, month) so re-running the biller never raises the same month's rent twice.
function billingKey(occupancyId: string, period: string) {
  const b = createHash('sha256').update(`autobill:${occupancyId}:${period}`).digest().subarray(0,16);
  b[6] = (b[6] & 0x0f) | 0x50; b[8] = (b[8] & 0x3f) | 0x80;
  const x = b.toString('hex');
  return `${x.slice(0,8)}-${x.slice(8,12)}-${x.slice(12,16)}-${x.slice(16,20)}-${x.slice(20,32)}`;
}
const paymentInclude = {resident:{select:{id:true,fullName:true}},creator:{select:{id:true,fullName:true}},allocations:{include:{charge:{select:{id:true,type:true,dueDate:true,billingPeriodStart:true,billingPeriodEnd:true}}},orderBy:[{createdAt:'asc' as const},{id:'asc' as const}]}};
function paymentResult<T extends {amount:Prisma.Decimal;allocations:{amount:Prisma.Decimal}[]}>(payment:T) {
  return {...payment,unallocatedAmount:payment.amount.minus(payment.allocations.reduce((sum,a)=>sum.plus(a.amount),new Prisma.Decimal(0)))};
}

@Injectable()
export class FinanceService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private readonly logger = new Logger(FinanceService.name);
  constructor(private readonly db: Database, private readonly notifications: NotificationsService) {}
  onModuleInit() {
    // Tests drive refresh explicitly; production catches up after downtime without a NAS cron dependency.
    if (process.env.NODE_ENV !== 'test') {
      void this.tick();
      this.timer = setInterval(() => void this.tick(), 60000);
      this.timer.unref();
    }
  }
  async onModuleDestroy() { clearInterval(this.timer); await this.running; }
  async tick() {
    if (this.running) return this.running;
    this.running = (async () => {
      for (const property of await this.db.property.findMany({select:{id:true,autoBillingEnabled:true}})) {
        // One house's billing hiccup must not hold up every house's refresh, so isolate it.
        if (property.autoBillingEnabled) try { await this.autobill(property.id); } catch { this.logger.error('Auto-billing failed; next tick retries.'); }
        await this.refresh(property.id);
      }
    })().catch(() => { this.logger.error('Finance refresh failed; next tick and access reads retry.'); }).finally(() => { this.running = undefined; });
    return this.running;
  }
  async refresh(propertyId: string) {
    await this.db.$queryRaw`SELECT finance_refresh_property(${propertyId}::uuid)`;
  }
  /**
   * Raises this month's rent for every active bed once its payment day has arrived. Idempotent (a stable
   * key per occupancy+month, plus a check for an existing rent charge over the month), never backfills past
   * months, and never bills before move-in. The resident is notified exactly as for a hand-entered charge.
   */
  async autobill(propertyId: string) {
    const property = await this.db.property.findUnique({where:{id:propertyId},select:{autoBillingEnabled:true}});
    if (!property?.autoBillingEnabled) return; // the house owner turns this on in Settings
    const t = tashkentToday();
    const lastDay = new Date(Date.UTC(t.year, t.monthNo, 0)).getUTCDate();
    const monthStart = financeDate(`${t.month}-01`), monthEnd = financeDate(`${t.month}-${String(lastDay).padStart(2,'0')}`), todayDate = financeDate(t.iso);
    // Auto-raised charges need an author for the ledger; attribute them to the house owner.
    const creator = await this.db.user.findFirst({where:{propertyId,active:true,role:{in:['OWNER','SUPER_ADMIN']}},orderBy:{createdAt:'asc'},select:{id:true}});
    if (!creator) return;
    const occupancies = await this.db.occupancy.findMany({where:{propertyId,status:'ACTIVE'},select:{id:true,residentId:true,roomId:true,bedId:true,monthlyPrice:true,paymentDay:true,moveInDate:true}});
    const due = occupancies.filter(o => o.monthlyPrice.gt(0) && o.moveInDate <= todayDate && t.day >= Math.min(o.paymentDay, lastDay));
    if (!due.length) return;
    await this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM properties WHERE id = ${propertyId}::uuid FOR UPDATE`;
      for (const o of due) {
        if (await tx.charge.findFirst({where:{propertyId,residentId:o.residentId,bedId:o.bedId,type:'RENT',billingPeriodStart:monthStart}})) continue;
        const dueDate = financeDate(`${t.month}-${String(Math.min(o.paymentDay, lastDay)).padStart(2,'0')}`);
        const charge = await tx.charge.create({data:{propertyId,residentId:o.residentId,roomId:o.roomId,bedId:o.bedId,amount:o.monthlyPrice,type:'RENT',billingPeriodStart:monthStart,billingPeriodEnd:monthEnd,dueDate,gracePeriodDays:0,idempotencyKey:billingKey(o.id,t.month),createdByUserId:creator.id}});
        await tx.auditLog.create({data:{propertyId,actorId:null,action:'CHARGE_AUTO_CREATED',entity:'Charge',entityId:charge.id,metadata:{residentId:o.residentId,occupancyId:o.id,amount:o.monthlyPrice.toFixed(2),period:t.month,type:'RENT',auto:true}}});
        await this.notifications.chargeCreated(tx,charge);
        await publish(tx,{p:propertyId,topic:'finance',type:'charge',id:charge.id,need:['FINANCE_VIEW'],residents:[o.residentId]});
      }
    }, {maxWait:10000,timeout:20000});
  }
  async transaction<T>(actor: Actor, need: PermissionCode, action: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM properties WHERE id = ${actor.propertyId}::uuid FOR UPDATE`;
      await requireAccess(tx,actor,need);
      await tx.$queryRaw`SELECT finance_refresh_property(${actor.propertyId}::uuid)`;
      return action(tx);
    }, {maxWait:10000,timeout:20000});
  }
  async resident(tx: Prisma.TransactionClient, actor: Actor, id: string) {
    const resident = await tx.resident.findFirst({where:{id,propertyId:actor.propertyId}});
    if (!resident) throw new NotFoundException('Жилец не найден.');
    return resident;
  }
  async createCharge(actor: Actor, dto: ChargeDto) {
    const amount = money(dto.amount);
    const billingPeriodStart = financeDate(dto.billingPeriodStart), billingPeriodEnd = financeDate(dto.billingPeriodEnd), dueDate = financeDate(dto.dueDate);
    if (billingPeriodEnd < billingPeriodStart) throw new UnprocessableEntityException('Конец периода не может быть раньше начала.');
    return this.transaction(actor,'FINANCE_MANAGE',async tx => {
      await this.resident(tx,actor,dto.residentId);
      const bed = await tx.bed.findFirst({where:{id:dto.bedId,room:{propertyId:actor.propertyId}}});
      if (!bed) throw new NotFoundException('Место не найдено.');
      const existing = await tx.charge.findUnique({where:{propertyId_idempotencyKey:{propertyId:actor.propertyId,idempotencyKey:dto.idempotencyKey}}});
      if (existing) {
        if (existing.residentId !== dto.residentId || existing.bedId !== dto.bedId || !existing.amount.eq(amount) || existing.type !== dto.type || existing.gracePeriodDays !== dto.gracePeriodDays || existing.billingPeriodStart.getTime() !== billingPeriodStart.getTime() || existing.billingPeriodEnd.getTime() !== billingPeriodEnd.getTime() || existing.dueDate.getTime() !== dueDate.getTime())
          throw new ConflictException('Этот ключ запроса уже использован для другого начисления.');
        return existing;
      }
      const charge = await tx.charge.create({data:{...dto,amount,billingPeriodStart,billingPeriodEnd,dueDate,propertyId:actor.propertyId,roomId:bed.roomId,createdByUserId:actor.id}});
      await tx.auditLog.create({data:{propertyId:actor.propertyId,actorId:actor.id,action:'CHARGE_CREATED',entity:'Charge',entityId:charge.id,metadata:{residentId:dto.residentId,amount:amount.toFixed(2),type:dto.type}}});
      await this.notifications.chargeCreated(tx,charge);
      await publish(tx,{p:actor.propertyId,topic:'finance',type:'charge',id:charge.id,need:['FINANCE_VIEW'],residents:[dto.residentId]});
      // AFTER INSERT may consume existing credit, so re-read the resulting charge.
      return tx.charge.findUniqueOrThrow({where:{id:charge.id}});
    });
  }
  async createPayment(actor: Actor, dto: PaymentDto) {
    const amount = money(dto.amount);
    return this.transaction(actor,'FINANCE_MANAGE',async tx => {
      await this.resident(tx,actor,dto.residentId);
      if (dto.chargeId && !await tx.charge.findFirst({where:{id:dto.chargeId,residentId:dto.residentId,propertyId:actor.propertyId}})) throw new NotFoundException('Начисление не найдено для этого жильца.');
      const existing = await tx.payment.findUnique({where:{propertyId_idempotencyKey:{propertyId:actor.propertyId,idempotencyKey:dto.idempotencyKey}},include:paymentInclude});
      if (existing) {
        if (existing.chargeId !== (dto.chargeId||null) || existing.residentId !== dto.residentId || !existing.amount.eq(amount) || existing.method !== dto.method || (existing.comment || '') !== (dto.comment || '')) throw new ConflictException('Этот ключ запроса уже использован для другого платежа.');
        return paymentResult(existing);
      }
      const payment = await tx.payment.create({data:{...dto,amount,propertyId:actor.propertyId,createdByUserId:actor.id}});
      const result=paymentResult(await tx.payment.findUniqueOrThrow({where:{id:payment.id},include:paymentInclude}));
      await tx.auditLog.create({data:{propertyId:actor.propertyId,actorId:actor.id,action:'PAYMENT_RECORDED',entity:'Payment',entityId:payment.id,metadata:{residentId:dto.residentId,chargeId:dto.chargeId||null,amount:amount.toFixed(2),method:dto.method,unallocatedAmount:result.unallocatedAmount.toFixed(2),allocations:result.allocations.map(a=>({chargeId:a.chargeId,amount:a.amount.toFixed(2)}))}}});
      await this.notifications.paymentRecorded(tx,result);
      await publish(tx,{p:actor.propertyId,topic:'finance',type:'payment',id:payment.id,need:['FINANCE_VIEW'],residents:[dto.residentId]});
      return result;
    });
  }
  snapshot(actor: Actor, query: FinanceQuery) {
    return this.transaction(actor,'FINANCE_VIEW',async tx => {
      if (query.residentId) await this.resident(tx,actor,query.residentId);
      const scope = {propertyId:actor.propertyId,...(query.residentId ? {residentId:query.residentId} : {})};
      const where = {...scope,...(query.status ? {status:query.status} : {})};
      const [totals,overdue,received,charges,chargeCount,payments,paymentCount,residents] = await Promise.all([
        tx.charge.aggregate({where:scope,_sum:{amount:true,paidAmount:true,dueAmount:true}}),
        tx.charge.aggregate({where:{...scope,status:'OVERDUE'},_sum:{dueAmount:true}}),
        tx.payment.aggregate({where:scope,_sum:{amount:true}}),
        tx.charge.findMany({where,include:chargeInclude,orderBy:[{createdAt:'desc'},{id:'desc'}],skip:(query.page-1)*50,take:50}), tx.charge.count({where}),
        tx.payment.findMany({where:scope,include:paymentInclude,orderBy:[{createdAt:'desc'},{id:'desc'}],skip:(query.page-1)*50,take:50}), tx.payment.count({where:scope}),
        tx.resident.findMany({where:{propertyId:actor.propertyId,...(query.residentId?{id:query.residentId}:{})},select:{id:true,fullName:true,totalDebt:true,creditBalance:true,accessGranted:true,accessStatusReason:true,financeCheckedAt:true},orderBy:{fullName:'asc'}})
      ]);
      return {summary:{charged:totals._sum.amount ?? '0',paid:received._sum.amount ?? '0',applied:totals._sum.paidAmount ?? '0',creditBalance:residents.reduce((sum,r)=>sum.plus(r.creditBalance),new Prisma.Decimal(0)),outstanding:totals._sum.dueAmount ?? '0',overdue:overdue._sum.dueAmount ?? '0',blockedResidents:residents.filter(r=>!r.accessGranted).length},charges,payments:payments.map(paymentResult),residents,chargeCount,paymentCount,page:query.page,pageSize:50,asOf:new Date().toISOString()};
    });
  }
  /** Home screen: this month's rent by resident (paid / partly / not paid), money received this month and the last 6 months. */
  month(actor: Actor) {
    return this.transaction(actor,'FINANCE_VIEW',async tx => {
      const today = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tashkent',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
      const start = new Date(`${today.slice(0,7)}-01T00:00:00.000Z`), next = new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+1,1));
      const charges = await tx.charge.findMany({where:{propertyId:actor.propertyId,type:'RENT',billingPeriodStart:{gte:start,lt:next}},select:{residentId:true,status:true,amount:true,dueAmount:true}});
      // A resident counts once, by the worst state of their rent charges for the month.
      const rank = {PAID:0,PARTIALLY_PAID:1,UNPAID:2,OVERDUE:2} as const;
      const byResident = new Map<string,{state:number;amount:Prisma.Decimal;due:Prisma.Decimal}>();
      for (const c of charges) {
        const r = byResident.get(c.residentId) ?? {state:0,amount:new Prisma.Decimal(0),due:new Prisma.Decimal(0)};
        byResident.set(c.residentId,{state:Math.max(r.state,rank[c.status]),amount:r.amount.plus(c.amount),due:r.due.plus(c.dueAmount)});
      }
      const group = (state:number) => { const list=[...byResident.values()].filter(r=>r.state===state); return {residents:list.length,amount:list.reduce((s,r)=>s.plus(state===0?r.amount:r.due),new Prisma.Decimal(0)).toFixed(2)}; };
      // Payments by Tashkent calendar month, this one and the five before it.
      const rows = await tx.$queryRaw<{month:string;received:Prisma.Decimal}[]>`
        SELECT to_char(date_trunc('month', created_at AT TIME ZONE 'Asia/Tashkent'),'YYYY-MM') AS month, sum(amount) AS received
        FROM payments WHERE property_id = ${actor.propertyId}::uuid
          AND created_at >= (date_trunc('month', now() AT TIME ZONE 'Asia/Tashkent') - interval '5 months') AT TIME ZONE 'Asia/Tashkent'
        GROUP BY 1`;
      const months = Array.from({length:6},(_,i)=>{const d=new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()-5+i,1));const key=d.toISOString().slice(0,7);return {month:key,received:(rows.find(r=>r.month===key)?.received ?? new Prisma.Decimal(0)).toFixed(2)};});
      return {month:today.slice(0,7),paid:group(0),partial:group(1),unpaid:group(2),received:months[5].received,months};
    });
  }
  /** Debtors list for the "Должники" screen: residents with debt, their current place, and days overdue. */
  debtors(actor: Actor) {
    return this.transaction(actor,'FINANCE_VIEW',async tx => {
      const today = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tashkent',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
      const now = new Date(`${today}T00:00:00.000Z`);
      const residents = await tx.resident.findMany({where:{propertyId:actor.propertyId,totalDebt:{gt:0}},
        select:{id:true,fullName:true,totalDebt:true,occupancies:{where:{status:'ACTIVE'},select:{room:{select:{number:true}},bed:{select:{number:true}}},take:1}}});
      // Oldest overdue charge per resident gives the worst days-overdue; residents with debt but nothing overdue yet show 0.
      const overdue = await tx.charge.groupBy({by:['residentId'],where:{propertyId:actor.propertyId,status:'OVERDUE',dueAmount:{gt:0}},_min:{dueDate:true}});
      const oldest = new Map(overdue.map(o=>[o.residentId,o._min.dueDate]));
      return residents.map(r=>{
        const due = oldest.get(r.id);
        const daysOverdue = due ? Math.max(0,Math.floor((now.getTime()-new Date(due).getTime())/86400000)) : 0;
        const occ = r.occupancies[0];
        return {residentId:r.id,fullName:r.fullName,room:occ?.room.number??null,bed:occ?.bed.number??null,totalDebt:r.totalDebt,daysOverdue};
      }).sort((a,b)=>b.daysOverdue-a.daysOverdue||Number(b.totalDebt)-Number(a.totalDebt));
    });
  }
  access(actor: Actor, id: string) {
    return this.transaction(actor,'FINANCE_VIEW',async tx => {
      const r = await this.resident(tx,actor,id);
      return {resident_id:r.id,access_granted:r.accessGranted,access_status_reason:r.accessStatusReason,total_debt:r.totalDebt,credit_balance:r.creditBalance,checked_at:r.financeCheckedAt,scope:'FINANCIAL' as const};
    });
  }
}

@Controller('finance') @UseGuards(SessionGuard)
class FinanceController {
  constructor(private readonly service: FinanceService) {}
  @Get() snapshot(@Req() req: AuthRequest,@Query() query: FinanceQuery) {return this.service.snapshot(req.actor,query);}
  @Get('month') month(@Req() req: AuthRequest) {return this.service.month(req.actor);}
  @Get('debtors') debtors(@Req() req: AuthRequest) {return this.service.debtors(req.actor);}
  @Post('charges') charge(@Req() req: AuthRequest,@Body() dto: ChargeDto) {return this.service.createCharge(req.actor,dto);}
  @Post('payments') payment(@Req() req: AuthRequest,@Body() dto: PaymentDto) {return this.service.createPayment(req.actor,dto);}
  @Get('residents/:id/access') access(@Req() req: AuthRequest,@Param('id',ParseUUIDPipe) id: string) {return this.service.access(req.actor,id);}
}
@Module({imports:[AuthModule,NotificationsModule],providers:[FinanceService],controllers:[FinanceController],exports:[FinanceService]})
export class FinanceModule {}
