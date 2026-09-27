import { Body, ConflictException, Controller, ForbiddenException, Get, Injectable, Logger, Module, NotFoundException, OnModuleDestroy, OnModuleInit, Param, ParseUUIDPipe, Post, Query, Req, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Actor, AuthModule, AuthRequest, SessionGuard } from './auth';
import { Database } from './database';
import { ChargeDto, FinanceQuery, PaymentDto } from './finance.dto';

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
const paymentInclude = {resident:{select:{id:true,fullName:true}},creator:{select:{id:true,fullName:true}},allocations:{include:{charge:{select:{id:true,type:true,dueDate:true,billingPeriodStart:true,billingPeriodEnd:true}}},orderBy:[{createdAt:'asc' as const},{id:'asc' as const}]}};
function paymentResult<T extends {amount:Prisma.Decimal;allocations:{amount:Prisma.Decimal}[]}>(payment:T) {
  return {...payment,unallocatedAmount:payment.amount.minus(payment.allocations.reduce((sum,a)=>sum.plus(a.amount),new Prisma.Decimal(0)))};
}

@Injectable()
export class FinanceService implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private readonly logger = new Logger(FinanceService.name);
  constructor(private readonly db: Database) {}
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
      for (const property of await this.db.property.findMany({select:{id:true}})) await this.refresh(property.id);
    })().catch(() => { this.logger.error('Finance refresh failed; next tick and access reads retry.'); }).finally(() => { this.running = undefined; });
    return this.running;
  }
  async refresh(propertyId: string) {
    await this.db.$queryRaw`SELECT finance_refresh_property(${propertyId}::uuid)`;
  }
  async transaction<T>(actor: Actor, action: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM properties WHERE id = ${actor.propertyId}::uuid FOR UPDATE`;
      if (!await tx.user.findFirst({where:{id:actor.id,propertyId:actor.propertyId,active:true,role:{in:['OWNER','ADMIN']},property:{active:true}}})) throw new ForbiddenException('Доступ к дому отключён.');
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
    return this.transaction(actor,async tx => {
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
      // AFTER INSERT may consume existing credit, so re-read the resulting charge.
      return tx.charge.findUniqueOrThrow({where:{id:charge.id}});
    });
  }
  async createPayment(actor: Actor, dto: PaymentDto) {
    const amount = money(dto.amount);
    return this.transaction(actor,async tx => {
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
      return result;
    });
  }
  snapshot(actor: Actor, query: FinanceQuery) {
    return this.transaction(actor,async tx => {
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
  access(actor: Actor, id: string) {
    return this.transaction(actor,async tx => {
      const r = await this.resident(tx,actor,id);
      return {resident_id:r.id,access_granted:r.accessGranted,access_status_reason:r.accessStatusReason,total_debt:r.totalDebt,credit_balance:r.creditBalance,checked_at:r.financeCheckedAt,scope:'FINANCIAL' as const};
    });
  }
}

@Controller('finance') @UseGuards(SessionGuard)
class FinanceController {
  constructor(private readonly service: FinanceService) {}
  @Get() snapshot(@Req() req: AuthRequest,@Query() query: FinanceQuery) {return this.service.snapshot(req.actor,query);}
  @Post('charges') charge(@Req() req: AuthRequest,@Body() dto: ChargeDto) {return this.service.createCharge(req.actor,dto);}
  @Post('payments') payment(@Req() req: AuthRequest,@Body() dto: PaymentDto) {return this.service.createPayment(req.actor,dto);}
  @Get('residents/:id/access') access(@Req() req: AuthRequest,@Param('id',ParseUUIDPipe) id: string) {return this.service.access(req.actor,id);}
}
@Module({imports:[AuthModule],providers:[FinanceService],controllers:[FinanceController],exports:[FinanceService]})
export class FinanceModule {}
