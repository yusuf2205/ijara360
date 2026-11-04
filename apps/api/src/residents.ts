import { Delete, Body, ConflictException, Controller, ForbiddenException, Get, Injectable, Logger, Module, NotFoundException, OnModuleDestroy, OnModuleInit, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { publish } from './realtime';
import { Prisma } from '@prisma/client';
import { Actor, AuthModule, AuthRequest, SessionGuard } from './auth';
import { Database } from './database';
import { requireAccess } from './permission-policy';
import { normalizePhone } from './security';
import { CheckInDto, CheckOutDto, PlanDto, ResidentDto, TransferDto } from './residents.dto';
import { FinanceModule, FinanceService } from './finance';
import { NotificationsModule, NotificationsService } from './notifications';

const history = { include: { room: {select:{id:true,number:true}}, bed: {select:{id:true,number:true}}, plan: {select:{plannedEndDate:true}} }, orderBy: [{moveInDate:'desc' as const},{createdAt:'desc' as const},{id:'desc' as const}] };
export function businessDate(value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  const today = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Tashkent',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== value || value < '1900-01-01' || value > today) {
    throw new UnprocessableEntityException('Укажите существующую дату не позднее сегодняшней.');
  }
  return date;
}
const tashkentIso = () => new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Tashkent',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
/** A planned end of stay: after move-in and at most 10 years ahead. Unlike businessDate, it may be in the future. */
export function plannedEnd(value: string, moveIn: Date): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== value) throw new UnprocessableEntityException('Укажите существующую дату окончания проживания.');
  if (date <= moveIn) throw new UnprocessableEntityException('Дата окончания должна быть позже даты заселения.');
  if (date.getTime() - moveIn.getTime() > 3653 * 86400000) throw new UnprocessableEntityException('Срок проживания — не более 10 лет.');
  return date;
}
/** Reminder stage for the days left: 1 two weeks, 2 three days, 3 the last day, 4 overdue (0: none yet). */
export const stayStage = (daysLeft: number) => daysLeft < 0 ? 4 : daysLeft === 0 ? 3 : daysLeft <= 3 ? 2 : daysLeft <= 14 ? 1 : 0;

@Injectable()
export class ResidentsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ResidentsService.name);
  private timer?: ReturnType<typeof setInterval>;
  constructor(private readonly db: Database, private readonly finance: FinanceService, private readonly notifications: NotificationsService) {}
  onModuleInit() {
    // Hourly, but reminders go out only in the daytime (Tashkent); tests call remindStays directly.
    if (process.env.NODE_ENV !== 'test') {
      this.timer = setInterval(() => {
        const hour = Number(new Intl.DateTimeFormat('en-GB', {timeZone:'Asia/Tashkent',hour:'2-digit',hour12:false}).format(new Date()));
        if (hour >= 10 && hour < 20) void this.remindStays().catch(() => this.logger.error('End-of-stay reminders failed; next hour retries.'));
      }, 3600000);
      this.timer.unref();
    }
  }
  onModuleDestroy() { clearInterval(this.timer); }
  async write<T>(actor: Actor, action: (tx: Prisma.TransactionClient) => Promise<T>) {
    try {
      return await this.db.$transaction(async tx => {
        // Same property lock as room edits; recheck access after waiting for the lock.
        await tx.$queryRaw`SELECT id FROM properties WHERE id = ${actor.propertyId}::uuid FOR UPDATE`;
        await requireAccess(tx,actor,'RESIDENTS_MANAGE');
        const result = await action(tx);
        await publish(tx,{p:actor.propertyId,topic:'house',type:'changed'});
        return result;
      }, {maxWait:10000,timeout:15000});
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const target = JSON.stringify(e.meta?.target ?? '');
        if (/phone/.test(target)) throw new ConflictException('Жилец с таким телефоном уже существует. Выберите его из списка.');
        if (/resident/.test(target)) throw new ConflictException('Жилец уже проживает в доме');
        throw new ConflictException('Это место уже занято');
      }
      throw e;
    }
  }
  async audit(tx: Prisma.TransactionClient, actor: Actor, action: string, residentId: string, metadata: Prisma.InputJsonObject = {}) {
    await tx.auditLog.create({data:{propertyId:actor.propertyId,actorId:actor.id,action,entity:'Resident',entityId:residentId,metadata:{residentId,...metadata}}});
  }
  /** Home screen: check-ins and check-outs dated today (Tashkent). */
  async today(actor: Actor) {
    const day = businessDate(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tashkent',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()));
    const [started,ended] = await Promise.all([
      this.db.occupancy.findMany({where:{propertyId:actor.propertyId,moveInDate:day},select:{residentId:true}}),
      this.db.occupancy.findMany({where:{propertyId:actor.propertyId,moveOutDate:day,status:'CLOSED'},select:{residentId:true}})]);
    // A transfer closes one stay and opens another on the same day: it is neither a check-in nor a check-out.
    const a = new Set(started.map(o=>o.residentId)), b = new Set(ended.map(o=>o.residentId));
    return {movedIn:[...a].filter(id=>!b.has(id)).length,movedOut:[...b].filter(id=>!a.has(id)).length};
  }
  async list(actor: Actor, q = '', filter = 'all') {
    if (q.length > 160 || !['all','active','closed'].includes(filter)) throw new UnprocessableEntityException('Некорректный фильтр жильцов.');
    const digits = q.replace(/\D/g,'');
    await this.finance.refresh(actor.propertyId);
    return this.db.resident.findMany({where:{propertyId:actor.propertyId,
      ...(q ? {OR:[{fullName:{contains:q.trim(),mode:'insensitive' as const}}, {phone:{contains:digits || q}}]} : {}),
      ...(filter === 'active' ? {occupancies:{some:{status:'ACTIVE'}}} : filter === 'closed' ? {AND:[{occupancies:{some:{status:'CLOSED'}}},{occupancies:{none:{status:'ACTIVE'}}}]} : {})},
      include:{occupancies:history},orderBy:[{fullName:'asc'},{id:'asc'}]});
  }
  async detail(actor: Actor, id: string) {
    await this.finance.refresh(actor.propertyId);
    const resident = await this.db.resident.findFirst({where:{id,propertyId:actor.propertyId},include:{occupancies:history}});
    if (!resident) throw new NotFoundException('Жилец не найден.');
    return resident;
  }
  async insert(tx: Prisma.TransactionClient, actor: Actor, dto: ResidentDto) {
    const phone = normalizePhone(dto.phone);
    if (await tx.resident.findUnique({where:{propertyId_phone:{propertyId:actor.propertyId,phone}}})) throw new ConflictException('Жилец с таким телефоном уже существует. Выберите его из списка.');
    const resident = await tx.resident.create({data:{...dto,phone,propertyId:actor.propertyId}});
    await this.audit(tx,actor,'RESIDENT_CREATED',resident.id);
    return resident;
  }
  create(actor: Actor, dto: ResidentDto) { return this.write(actor,tx => this.insert(tx,actor,dto)); }
  update(actor: Actor, id: string, dto: ResidentDto) {
    return this.write(actor,async tx => {
      if (!await tx.resident.findFirst({where:{id,propertyId:actor.propertyId}})) throw new NotFoundException('Жилец не найден.');
      const resident = await tx.resident.update({where:{id},data:{...dto,phone:normalizePhone(dto.phone)}});
      await this.audit(tx,actor,'RESIDENT_UPDATED',id);
      return resident;
    });
  }
  // Delete only a resident with no stay and no money on record; anyone who ever lived or paid is kept (checkout).
  deleteResident(actor: Actor, id: string) {
    return this.write(actor,async tx => {
      const resident = await tx.resident.findFirst({where:{id,propertyId:actor.propertyId}});
      if (!resident) throw new NotFoundException('Жилец не найден.');
      const [stays, charges, payments] = await Promise.all([
        tx.occupancy.count({where:{residentId:id}}),
        tx.charge.count({where:{residentId:id}}),
        tx.payment.count({where:{residentId:id}}),
      ]);
      if (stays > 0 || charges > 0 || payments > 0) throw new ConflictException('У жильца есть история проживания или платежей. Его можно выселить, но не удалить — так сохраняется учёт.');
      await this.audit(tx,actor,'RESIDENT_DELETED',id,{fullName:resident.fullName,phone:resident.phone});
      try {
        await tx.resident.delete({where:{id}});
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003') throw new ConflictException('У жильца есть связанные записи (например, заявка или аккаунт приложения). Его можно выселить, но не удалить.');
        throw e;
      }
      return { ok: true };
    });
  }
  async freeBed(tx: Prisma.TransactionClient, actor: Actor, bedId: string, date: Date) {
    const bed = await tx.bed.findFirst({where:{id:bedId,room:{propertyId:actor.propertyId,archivedAt:null}}});
    if (!bed) throw new NotFoundException('Место не найдено.');
    if (await tx.occupancy.findFirst({where:{bedId,status:'ACTIVE'}})) throw new ConflictException('Это место уже занято');
    if (await tx.occupancy.findFirst({where:{bedId,moveOutDate:{gt:date}}})) throw new ConflictException('На выбранную дату место ещё не было свободно.');
    return bed;
  }
  checkIn(actor: Actor, dto: CheckInDto) {
    return this.write(actor,tx=>this.checkInTransaction(tx,actor,dto));
  }
  async checkInTransaction(tx:Prisma.TransactionClient,actor:Actor,dto:CheckInDto) {
    await publish(tx,{p:actor.propertyId,topic:'house',type:'changed'});
    const date = businessDate(dto.moveInDate);
    if (Boolean(dto.residentId) === Boolean(dto.resident)) throw new UnprocessableEntityException('Выберите существующего жильца или заполните данные нового.');
      const resident = dto.residentId ? await tx.resident.findFirst({where:{id:dto.residentId,propertyId:actor.propertyId}}) : await this.insert(tx,actor,dto.resident!);
      if (!resident) throw new NotFoundException('Жилец не найден.');
      if (await tx.occupancy.findFirst({where:{residentId:resident.id,status:'ACTIVE'}})) throw new ConflictException('Жилец уже проживает в доме');
      if (await tx.occupancy.findFirst({where:{residentId:resident.id,moveOutDate:{gt:date}}})) throw new ConflictException('Дата пересекается с предыдущим проживанием жильца.');
      const bed = await this.freeBed(tx,actor,dto.bedId,date);
      const end = dto.plannedEndDate ? plannedEnd(dto.plannedEndDate,date) : null;
      const occupancy = await tx.occupancy.create({data:{propertyId:actor.propertyId,residentId:resident.id,roomId:bed.roomId,bedId:bed.id,moveInDate:date,monthlyPrice:dto.monthlyPrice,paymentDay:dto.paymentDay,depositAmount:dto.depositAmount,createdBy:actor.id}});
      if (end) await tx.occupancyPlan.create({data:{occupancyId:occupancy.id,propertyId:actor.propertyId,plannedEndDate:end}});
      await this.audit(tx,actor,'OCCUPANCY_CHECKED_IN',resident.id,{occupancyId:occupancy.id,newRoomId:bed.roomId,newBedId:bed.id,plannedEndDate:end?dto.plannedEndDate!:null});
      return occupancy;
  }
  async active(tx: Prisma.TransactionClient, actor: Actor, id: string, date: Date) {
    const occupancy = await tx.occupancy.findFirst({where:{id,propertyId:actor.propertyId}});
    if (!occupancy) throw new NotFoundException('Проживание не найдено.');
    if (occupancy.status !== 'ACTIVE') throw new ConflictException('Жилец уже выселен');
    if (date < occupancy.moveInDate) throw new UnprocessableEntityException('Дата не может быть раньше заселения.');
    return occupancy;
  }
  transfer(actor: Actor, id: string, dto: TransferDto) {
    const date = businessDate(dto.transferDate);
    return this.write(actor,async tx => {
      const old = await this.active(tx,actor,id,date);
      if (old.bedId === dto.bedId) throw new ConflictException('Выберите другое свободное место.');
      const bed = await this.freeBed(tx,actor,dto.bedId,date);
      await tx.occupancy.update({where:{id:old.id},data:{status:'CLOSED',moveOutDate:date}});
      const current = await tx.occupancy.create({data:{propertyId:actor.propertyId,residentId:old.residentId,roomId:bed.roomId,bedId:bed.id,moveInDate:date,monthlyPrice:old.monthlyPrice,paymentDay:old.paymentDay,depositAmount:old.depositAmount,createdBy:actor.id}});
      // A move to another bed keeps the agreed end of stay and the reminders already sent.
      const plan = await tx.occupancyPlan.findUnique({where:{occupancyId:old.id}});
      if (plan) await tx.occupancyPlan.create({data:{occupancyId:current.id,propertyId:actor.propertyId,plannedEndDate:plan.plannedEndDate,reminderStage:plan.reminderStage}});
      await this.audit(tx,actor,'OCCUPANCY_TRANSFERRED',old.residentId,{oldOccupancyId:old.id,newOccupancyId:current.id,oldRoomId:old.roomId,oldBedId:old.bedId,newRoomId:bed.roomId,newBedId:bed.id});
      return current;
    });
  }
  checkOut(actor: Actor, id: string, dto: CheckOutDto) {
    const date = businessDate(dto.moveOutDate);
    return this.write(actor,async tx => {
      const old = await this.active(tx,actor,id,date);
      const closed = await tx.occupancy.update({where:{id},data:{status:'CLOSED',moveOutDate:date}});
      await this.audit(tx,actor,'OCCUPANCY_CHECKED_OUT',old.residentId,{occupancyId:id,oldRoomId:old.roomId,oldBedId:old.bedId});
      // M5: a resident who no longer lives here loses app access in the same transaction.
      const account=await tx.tenantAccount.findUnique({where:{residentId:old.residentId}});
      if(account?.active&&!await tx.occupancy.count({where:{residentId:old.residentId,status:'ACTIVE'}})){
        await tx.tenantAccount.update({where:{id:account.id},data:{active:false}});
        await tx.tenantSession.deleteMany({where:{accountId:account.id}});
        await tx.tenantInvite.updateMany({where:{accountId:account.id,consumedAt:null},data:{consumedAt:new Date()}});
        await this.audit(tx,actor,'TENANT_ACCOUNT_DISABLED',old.residentId,{accountId:account.id,reason:'CHECKED_OUT'});
      }
      return closed;
    });
  }
  /** Sets, extends or removes the planned end of an active stay; the resident is told about the new date. */
  setPlan(actor: Actor, id: string, dto: PlanDto) {
    return this.write(actor,async tx => {
      const occupancy = await this.active(tx,actor,id,businessDate(tashkentIso()));
      const before = await tx.occupancyPlan.findUnique({where:{occupancyId:id}});
      const end = dto.plannedEndDate ? plannedEnd(dto.plannedEndDate,occupancy.moveInDate) : null;
      const iso = (d?: Date | null) => d ? d.toISOString().slice(0,10) : null;
      const changed = iso(before?.plannedEndDate) !== iso(end);
      if (end) await tx.occupancyPlan.upsert({where:{occupancyId:id},create:{occupancyId:id,propertyId:actor.propertyId,plannedEndDate:end},update:{plannedEndDate:end,...(changed?{reminderStage:0}:{})}});
      else await tx.occupancyPlan.deleteMany({where:{occupancyId:id}});
      if (changed) {
        await this.audit(tx,actor,'OCCUPANCY_PLAN_SET',occupancy.residentId,{occupancyId:id,from:iso(before?.plannedEndDate),to:iso(end)});
        await this.notifications.stayPlanChanged(tx,occupancy.residentId,id,end);
      }
      return {occupancyId:id,plannedEndDate:end};
    });
  }
  /** Active stays whose planned end is within 30 days or already passed, soonest first. */
  async ending(actor: Actor) {
    const today = businessDate(tashkentIso());
    const plans = await this.db.occupancyPlan.findMany({where:{propertyId:actor.propertyId,plannedEndDate:{lte:new Date(today.getTime() + 30 * 86400000)},occupancy:{status:'ACTIVE'}},
      include:{occupancy:{include:{resident:{select:{fullName:true}},room:{select:{number:true}},bed:{select:{number:true}}}}},orderBy:[{plannedEndDate:'asc'},{occupancyId:'asc'}]});
    return plans.map(p => ({occupancyId:p.occupancyId,residentId:p.occupancy.residentId,fullName:p.occupancy.resident.fullName,room:p.occupancy.room.number,bed:p.occupancy.bed.number,
      plannedEndDate:p.plannedEndDate,daysLeft:Math.round((p.plannedEndDate.getTime() - today.getTime()) / 86400000)}));
  }
  /**
   * Sends each end-of-stay reminder once per planned date: the resident two weeks before, three days before
   * and on the last day; staff three days before and once the date has passed. Nobody is checked out automatically.
   */
  async remindStays() {
    const today = businessDate(tashkentIso());
    const plans = await this.db.occupancyPlan.findMany({where:{reminderStage:{lt:4},occupancy:{status:'ACTIVE'}},
      include:{occupancy:{include:{resident:{select:{fullName:true}},room:{select:{number:true}},bed:{select:{number:true}}}}}});
    let sent = 0;
    for (const p of plans) {
      const daysLeft = Math.round((p.plannedEndDate.getTime() - today.getTime()) / 86400000), stage = stayStage(daysLeft);
      if (stage <= p.reminderStage) continue;
      await this.db.$transaction(async tx => {
        // Claim the stage first: a concurrent run, or a date changed meanwhile, finds nothing to claim.
        const claimed = await tx.occupancyPlan.updateMany({where:{occupancyId:p.occupancyId,plannedEndDate:p.plannedEndDate,reminderStage:{lt:stage}},data:{reminderStage:stage}});
        if (!claimed.count) return;
        const o = p.occupancy;
        if (stage <= 3) await this.notifications.stayEnding(tx,o.residentId,o.id,p.plannedEndDate,daysLeft);
        if (stage >= 2) await this.notifications.stayEndingStaff(tx,p.propertyId,{residentId:o.residentId,occupancyId:o.id,fullName:o.resident.fullName,room:o.room.number,bed:o.bed.number,end:p.plannedEndDate,daysLeft});
        sent++;
      }, {maxWait:10000,timeout:20000});
    }
    return sent;
  }
}

@Controller() @UseGuards(SessionGuard)
class ResidentsController {
  constructor(private readonly service: ResidentsService) {}
  @Get('occupancies/today') today(@Req() req: AuthRequest) { return this.service.today(req.actor); }
  @Get('occupancies/ending') ending(@Req() req: AuthRequest) { return this.service.ending(req.actor); }
  @Get('residents') list(@Req() req: AuthRequest,@Query('q') q?: string,@Query('filter') filter?: string) { return this.service.list(req.actor,q,filter); }
  @Get('residents/:id') detail(@Req() req: AuthRequest,@Param('id',ParseUUIDPipe) id: string) { return this.service.detail(req.actor,id); }
  @Post('residents') create(@Req() req: AuthRequest,@Body() dto: ResidentDto) { return this.service.create(req.actor,dto); }
  @Patch('residents/:id') update(@Req() req: AuthRequest,@Param('id',ParseUUIDPipe) id: string,@Body() dto: ResidentDto) { return this.service.update(req.actor,id,dto); }
  @Delete('residents/:id') deleteResident(@Req() req: AuthRequest,@Param('id',ParseUUIDPipe) id: string) { return this.service.deleteResident(req.actor,id); }
  @Post('occupancies/check-in') checkIn(@Req() req: AuthRequest,@Body() dto: CheckInDto) { return this.service.checkIn(req.actor,dto); }
  @Post('occupancies/:id/transfer') transfer(@Req() req: AuthRequest,@Param('id',ParseUUIDPipe) id: string,@Body() dto: TransferDto) { return this.service.transfer(req.actor,id,dto); }
  @Put('occupancies/:id/plan') setPlan(@Req() req: AuthRequest,@Param('id',ParseUUIDPipe) id: string,@Body() dto: PlanDto) { return this.service.setPlan(req.actor,id,dto); }
  @Post('occupancies/:id/check-out') checkOut(@Req() req: AuthRequest,@Param('id',ParseUUIDPipe) id: string,@Body() dto: CheckOutDto) { return this.service.checkOut(req.actor,id,dto); }
}
@Module({imports:[AuthModule,FinanceModule,NotificationsModule],providers:[ResidentsService],controllers:[ResidentsController],exports:[ResidentsService]})
export class ResidentsModule {}
