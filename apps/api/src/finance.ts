import { Body, ConflictException, Controller, ForbiddenException, Get, Injectable, Logger, Module, NotFoundException, OnModuleDestroy, OnModuleInit, Param, ParseUUIDPipe, Post, Query, Req, Res, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { Response } from 'express';
import { Actor, AuthModule, AuthRequest, SessionGuard } from './auth';
import { Database } from './database';
import { PermissionCode, requireAccess } from './permission-policy';
import { ChargeDto, FinanceQuery, MonthQuery, PaymentDto, ReportQuery } from './finance.dto';
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
// Excel-friendly CSV: a text cell is quoted and escaped; a money cell is a comma-decimal number Excel can sum.
const csvText = (v: string | null | undefined) => `"${(v ?? '').replace(/"/g,'""')}"`;
const csvMoney = (v: Prisma.Decimal | string) => new Prisma.Decimal(v).toFixed(2).replace('.',',');
const csvDate = (d: Date, tz = 'UTC') => new Intl.DateTimeFormat('ru-RU',{timeZone:tz,day:'2-digit',month:'2-digit',year:'numeric'}).format(d);
const chargeTypeRu: Record<string,string> = {RENT:'Аренда',DEPOSIT:'Залог',PENALTY:'Штраф',UTILITIES:'Коммунальные',OTHER:'Другое'};
const chargeStatusRu: Record<string,string> = {UNPAID:'Не оплачено',PARTIALLY_PAID:'Частично',PAID:'Оплачено',OVERDUE:'Просрочено'};
const methodRu: Record<string,string> = {CASH:'Наличные',CARD_TRANSFER:'Перевод на карту',BANK_TRANSFER:'Банковский перевод',OTHER:'Другое'};
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
const zero = () => new Prisma.Decimal(0);

/**
 * The receipt for one payment: what the house gives a resident as proof that money (cash or a transfer)
 * was accepted. Not a fiscal cheque. Payments are an append-only ledger, so the receipt number, the
 * payment's place in the house's sequence of payments, never changes; neither does the balance right
 * after it, computed from charges and payments recorded up to that moment.
 */
export async function paymentReceipt(tx: Prisma.TransactionClient, propertyId: string, paymentId: string, residentId?: string) {
  const p = await tx.payment.findFirst({where:{id:paymentId,propertyId,...(residentId?{residentId}:{})},
    include:{property:{select:{name:true,address:true}},resident:{select:{id:true,fullName:true}},creator:{select:{fullName:true}},
      allocations:{include:{charge:{select:{type:true,billingPeriodStart:true,billingPeriodEnd:true,room:{select:{number:true}},bed:{select:{number:true}}}}},orderBy:[{createdAt:'asc'},{id:'asc'}]}}});
  if (!p) throw new NotFoundException('Платёж не найден.');
  const [[seq],[charged],[paid]] = await Promise.all([
    tx.$queryRaw<{n:bigint}[]>`SELECT count(*) AS n FROM payments WHERE property_id = ${propertyId}::uuid AND (created_at, id) <= (${p.createdAt}, ${p.id}::uuid)`,
    tx.$queryRaw<{s:Prisma.Decimal|null}[]>`SELECT sum(amount) AS s FROM charges WHERE resident_id = ${p.residentId}::uuid AND property_id = ${propertyId}::uuid AND created_at <= ${p.createdAt}`,
    tx.$queryRaw<{s:Prisma.Decimal|null}[]>`SELECT sum(amount) AS s FROM payments WHERE resident_id = ${p.residentId}::uuid AND property_id = ${propertyId}::uuid AND (created_at, id) <= (${p.createdAt}, ${p.id}::uuid)`,
  ]);
  const balance = new Prisma.Decimal(charged.s ?? 0).minus(new Prisma.Decimal(paid.s ?? 0));
  const allocated = p.allocations.reduce((s,a)=>s.plus(a.amount),zero());
  // The place on the receipt: the bed the money went to, or (an advance) the resident's latest bed.
  const place = p.allocations[0]?.charge ?? await tx.occupancy.findFirst({where:{residentId:p.residentId,propertyId,moveInDate:{lte:p.createdAt}},orderBy:[{moveInDate:'desc'},{createdAt:'desc'}],select:{room:{select:{number:true}},bed:{select:{number:true}}}});
  return {
    id:p.id, number:Number(seq.n), createdAt:p.createdAt, amount:p.amount, method:p.method,
    property:{name:p.property.name,address:p.property.address},
    resident:{id:p.resident.id,fullName:p.resident.fullName,room:place?.room.number ?? null,bed:place?.bed.number ?? null},
    acceptedBy:p.creator.fullName,
    items:p.allocations.map(a=>({type:a.charge.type,billingPeriodStart:a.charge.billingPeriodStart,billingPeriodEnd:a.charge.billingPeriodEnd,amount:a.amount})),
    toCredit:p.amount.minus(allocated),
    after:{debt:balance.gt(0)?balance:zero(),credit:balance.lt(0)?balance.neg():zero()},
  };
}
/** Receipt numbers for a page of payments (their place in the house's payment sequence). */
export async function receiptNumbers(tx: Prisma.TransactionClient, propertyId: string, ids: string[]) {
  if (!ids.length) return new Map<string,number>();
  const rows = await tx.$queryRaw<{id:string;n:bigint}[]>`
    SELECT id, n FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM payments WHERE property_id = ${propertyId}::uuid) x
    WHERE id = ANY(${ids}::uuid[])`;
  return new Map(rows.map(r=>[r.id,Number(r.n)]));
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
      for (const property of await this.db.property.findMany({select:{id:true,autoBillingEnabled:true,paymentRemindersEnabled:true}})) {
        // One house's billing or reminder hiccup must not hold up every house's refresh, so isolate each.
        if (property.autoBillingEnabled) try { await this.autobill(property.id); } catch { this.logger.error('Auto-billing failed; next tick retries.'); }
        if (property.paymentRemindersEnabled) try { await this.remindDue(property.id); } catch { this.logger.error('Payment reminders failed; next tick retries.'); }
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
  /**
   * Reminds residents who use the app about rent due within three days or already overdue, at most once a
   * day per charge (deduplicated against today's reminder notifications). Self-guards on the house switch.
   */
  async remindDue(propertyId: string) {
    const property = await this.db.property.findUnique({where:{id:propertyId},select:{paymentRemindersEnabled:true}});
    if (!property?.paymentRemindersEnabled) return;
    const t = tashkentToday();
    const today = financeDate(t.iso);
    const horizon = new Date(today.getTime() + 3 * 86400000); // start reminding three days before the due date
    const dayStart = new Date(`${t.iso}T00:00:00+05:00`); // the Tashkent day's start, for once-a-day dedup
    const charges = await this.db.charge.findMany({where:{propertyId,dueAmount:{gt:0},status:{not:'PAID'},dueDate:{lte:horizon}},
      select:{id:true,residentId:true,type:true,dueAmount:true,dueDate:true,billingPeriodStart:true}});
    if (!charges.length) return;
    const [accounts, remindedToday] = await Promise.all([
      this.db.tenantAccount.findMany({where:{propertyId,active:true,activatedAt:{not:null}},select:{residentId:true}}),
      this.db.notification.findMany({where:{propertyId,kind:'PAYMENT_REMINDER',createdAt:{gte:dayStart}},select:{entityId:true}}),
    ]);
    const hasApp = new Set(accounts.map(a => a.residentId)), done = new Set(remindedToday.map(n => n.entityId));
    const due = charges.filter(c => hasApp.has(c.residentId) && !done.has(c.id));
    if (!due.length) return;
    await this.db.$transaction(async tx => {
      for (const c of due) await this.notifications.remindPayment(tx, c, Math.round((c.dueDate.getTime() - today.getTime()) / 86400000));
    }, {maxWait:10000,timeout:20000});
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
      const numbers = await receiptNumbers(tx,actor.propertyId,payments.map(p=>p.id));
      return {summary:{charged:totals._sum.amount ?? '0',paid:received._sum.amount ?? '0',applied:totals._sum.paidAmount ?? '0',creditBalance:residents.reduce((sum,r)=>sum.plus(r.creditBalance),new Prisma.Decimal(0)),outstanding:totals._sum.dueAmount ?? '0',overdue:overdue._sum.dueAmount ?? '0',blockedResidents:residents.filter(r=>!r.accessGranted).length},charges,payments:payments.map(p=>({...paymentResult(p),receiptNumber:numbers.get(p.id)})),residents,chargeCount,paymentCount,page:query.page,pageSize:50,asOf:new Date().toISOString()};
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
  /**
   * The month's report for staff (app and web): what was charged for the month, what came in during it
   * (by method and by who accepted it, so cash can be reconciled per person), the month's rent by resident,
   * today's debt, and every payment with its receipt number. Months are Tashkent calendar months.
   */
  monthReport(actor: Actor, month?: string) {
    return this.transaction(actor,'FINANCE_VIEW',async tx => {
      const t = tashkentToday();
      const m = month ?? t.month;
      if (m > t.month) throw new UnprocessableEntityException('Отчёт за будущий месяц пока пуст.');
      const start = financeDate(`${m}-01`), next = new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+1,1));
      const nextIso = next.toISOString().slice(0,10);
      const startAt = new Date(`${m}-01T00:00:00+05:00`), endAt = new Date(`${nextIso}T00:00:00+05:00`);
      const [charges, payments, now] = await Promise.all([
        tx.charge.findMany({where:{propertyId:actor.propertyId,billingPeriodStart:{gte:start,lt:next}},select:{residentId:true,type:true,status:true,amount:true,paidAmount:true,dueAmount:true}}),
        tx.payment.findMany({where:{propertyId:actor.propertyId,createdAt:{gte:startAt,lt:endAt}},orderBy:[{createdAt:'asc'},{id:'asc'}],
          select:{id:true,amount:true,method:true,createdAt:true,resident:{select:{id:true,fullName:true}},creator:{select:{id:true,fullName:true}}}}),
        tx.resident.aggregate({where:{propertyId:actor.propertyId},_sum:{totalDebt:true}}),
      ]);
      const overdueNow = await tx.charge.aggregate({where:{propertyId:actor.propertyId,status:'OVERDUE'},_sum:{dueAmount:true}});
      const byType: Record<string,Prisma.Decimal> = {};
      let charged = zero(), chargedPaid = zero(), chargedDue = zero();
      for (const c of charges) { byType[c.type] = (byType[c.type] ?? zero()).plus(c.amount); charged = charged.plus(c.amount); chargedPaid = chargedPaid.plus(c.paidAmount); chargedDue = chargedDue.plus(c.dueAmount); }
      // Rent by resident, once each, by the worst state of the month's rent (as on the home screen).
      const rank = {PAID:0,PARTIALLY_PAID:1,UNPAID:2,OVERDUE:2} as const;
      const rent = new Map<string,{state:number;amount:Prisma.Decimal;due:Prisma.Decimal}>();
      for (const c of charges.filter(c=>c.type==='RENT')) {
        const r = rent.get(c.residentId) ?? {state:0,amount:zero(),due:zero()};
        rent.set(c.residentId,{state:Math.max(r.state,rank[c.status]),amount:r.amount.plus(c.amount),due:r.due.plus(c.dueAmount)});
      }
      const group = (state:number) => { const l=[...rent.values()].filter(r=>r.state===state); return {residents:l.length,amount:l.reduce((s,r)=>s.plus(state===0?r.amount:r.due),zero())}; };
      const byMethod: Record<string,Prisma.Decimal> = {};
      const byStaff = new Map<string,{name:string;total:Prisma.Decimal;cash:Prisma.Decimal;count:number}>();
      let received = zero();
      for (const p of payments) {
        received = received.plus(p.amount);
        byMethod[p.method] = (byMethod[p.method] ?? zero()).plus(p.amount);
        const s = byStaff.get(p.creator.id) ?? {name:p.creator.fullName,total:zero(),cash:zero(),count:0};
        byStaff.set(p.creator.id,{...s,total:s.total.plus(p.amount),cash:p.method==='CASH'?s.cash.plus(p.amount):s.cash,count:s.count+1});
      }
      const numbers = await receiptNumbers(tx,actor.propertyId,payments.map(p=>p.id));
      return {
        month:m, current:m===t.month,
        charged:{total:charged,paid:chargedPaid,due:chargedDue,byType},
        received:{total:received,count:payments.length,byMethod,byStaff:[...byStaff.values()].sort((a,b)=>Number(b.total)-Number(a.total))},
        rent:{paid:group(0),partial:group(1),unpaid:group(2)},
        now:{debt:now._sum.totalDebt ?? zero(),overdue:overdueNow._sum.dueAmount ?? zero()},
        payments:payments.map(p=>({id:p.id,receiptNumber:numbers.get(p.id),createdAt:p.createdAt,amount:p.amount,method:p.method,resident:p.resident,acceptedBy:p.creator.fullName})).reverse(),
      };
    });
  }
  receipt(actor: Actor, id: string) {
    return this.transaction(actor,'FINANCE_VIEW',tx => paymentReceipt(tx,actor.propertyId,id));
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
  /** An Excel-openable CSV of payments, charges or debtors; the period defaults to the current Tashkent month. */
  report(actor: Actor, q: ReportQuery) {
    return this.transaction(actor,'FINANCE_VIEW',async tx => {
      const todayIso = new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tashkent',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
      const fromIso = q.from ?? `${todayIso.slice(0,7)}-01`;
      const fromDate = financeDate(fromIso);
      const lastDay = new Date(Date.UTC(fromDate.getUTCFullYear(), fromDate.getUTCMonth()+1, 0)).getUTCDate();
      const toIso = q.to ?? `${fromIso.slice(0,7)}-${String(lastDay).padStart(2,'0')}`;
      const toDate = financeDate(toIso);
      if (toDate < fromDate) throw new UnprocessableEntityException('Конец периода не может быть раньше начала.');
      const rows: string[] = [];
      let filename: string;
      if (q.type === 'debtors') {
        filename = `ijara360-debtors-${todayIso}.csv`;
        rows.push(['Жилец','Телефон','Комната','Место','Долг, сум','Дней просрочки'].map(csvText).join(';'));
        const residents = await tx.resident.findMany({where:{propertyId:actor.propertyId,totalDebt:{gt:0}},
          select:{id:true,fullName:true,phone:true,totalDebt:true,occupancies:{where:{status:'ACTIVE'},select:{room:{select:{number:true}},bed:{select:{number:true}}},take:1}}});
        const overdue = await tx.charge.groupBy({by:['residentId'],where:{propertyId:actor.propertyId,status:'OVERDUE',dueAmount:{gt:0}},_min:{dueDate:true}});
        const oldest = new Map(overdue.map(o=>[o.residentId,o._min.dueDate]));
        const now = financeDate(todayIso);
        const list = residents.map(r => {
          const due = oldest.get(r.id);
          const days = due ? Math.max(0,Math.floor((now.getTime()-new Date(due).getTime())/86400000)) : 0;
          return {fullName:r.fullName,phone:r.phone,room:r.occupancies[0]?.room.number ?? '',bed:r.occupancies[0]?.bed.number ?? '',debt:r.totalDebt,days};
        }).sort((a,b)=>b.days-a.days || Number(b.debt)-Number(a.debt));
        for (const d of list) rows.push([csvText(d.fullName),csvText(d.phone),csvText(d.room),csvText(d.bed),csvMoney(d.debt),String(d.days)].join(';'));
      } else if (q.type === 'charges') {
        filename = `ijara360-charges-${fromIso}_${toIso}.csv`;
        rows.push(['Период с','Период по','Срок оплаты','Жилец','Комната','Место','Тип','Начислено','Оплачено','Остаток','Статус'].map(csvText).join(';'));
        const charges = await tx.charge.findMany({where:{propertyId:actor.propertyId,billingPeriodStart:{gte:fromDate,lte:toDate}},include:chargeInclude,orderBy:[{billingPeriodStart:'asc'},{id:'asc'}]});
        let total = new Prisma.Decimal(0);
        for (const c of charges) {
          total = total.plus(c.amount);
          rows.push([csvText(csvDate(c.billingPeriodStart)),csvText(csvDate(c.billingPeriodEnd)),csvText(csvDate(c.dueDate)),csvText(c.resident.fullName),csvText(c.room.number),csvText(c.bed.number),csvText(chargeTypeRu[c.type]||c.type),csvMoney(c.amount),csvMoney(c.paidAmount),csvMoney(c.dueAmount),csvText(chargeStatusRu[c.status]||c.status)].join(';'));
        }
        rows.push([csvText('Итого'),'','','','','','',csvMoney(total),'','',''].join(';'));
      } else {
        filename = `ijara360-payments-${fromIso}_${toIso}.csv`;
        rows.push(['Дата','Жилец','Телефон','Сумма','Способ','Комментарий','Записал'].map(csvText).join(';'));
        const startAt = new Date(`${fromIso}T00:00:00+05:00`), endAt = new Date(new Date(`${toIso}T00:00:00+05:00`).getTime()+86400000);
        const payments = await tx.payment.findMany({where:{propertyId:actor.propertyId,createdAt:{gte:startAt,lt:endAt}},include:{resident:{select:{fullName:true,phone:true}},creator:{select:{fullName:true}}},orderBy:[{createdAt:'asc'},{id:'asc'}]});
        let total = new Prisma.Decimal(0);
        for (const p of payments) {
          total = total.plus(p.amount);
          rows.push([csvText(csvDate(p.createdAt,'Asia/Tashkent')),csvText(p.resident.fullName),csvText(p.resident.phone),csvMoney(p.amount),csvText(methodRu[p.method]||p.method),csvText(p.comment),csvText(p.creator.fullName)].join(';'));
        }
        rows.push([csvText('Итого'),'','',csvMoney(total),'','',''].join(';'));
      }
      return {filename, csv: rows.join('\r\n')};
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
  @Get('month-report') monthReport(@Req() req: AuthRequest, @Query() q: MonthQuery) {return this.service.monthReport(req.actor, q.month);}
  @Get('payments/:id/receipt') receipt(@Req() req: AuthRequest, @Param('id',ParseUUIDPipe) id: string) {return this.service.receipt(req.actor, id);}
  @Get('report') async report(@Req() req: AuthRequest, @Query() q: ReportQuery, @Res() res: Response) {
    const {filename, csv} = await this.service.report(req.actor, q);
    res.setHeader('Content-Type','text/csv; charset=utf-8');
    res.setHeader('Content-Disposition',`attachment; filename="${filename}"`);
    res.send('﻿'+csv); // BOM so Excel reads UTF-8
  }
  @Post('charges') charge(@Req() req: AuthRequest,@Body() dto: ChargeDto) {return this.service.createCharge(req.actor,dto);}
  @Post('payments') payment(@Req() req: AuthRequest,@Body() dto: PaymentDto) {return this.service.createPayment(req.actor,dto);}
  @Get('residents/:id/access') access(@Req() req: AuthRequest,@Param('id',ParseUUIDPipe) id: string) {return this.service.access(req.actor,id);}
}
@Module({imports:[AuthModule,NotificationsModule],providers:[FinanceService],controllers:[FinanceController],exports:[FinanceService]})
export class FinanceModule {}
