import { Body, ConflictException, Controller, ForbiddenException, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Actor, AuthModule, AuthRequest, SessionGuard } from './auth';
import { Database } from './database';
import { normalizePhone } from './security';
import { CheckInDto, CheckOutDto, ResidentDto, TransferDto } from './residents.dto';

const history = { include: { room: {select:{id:true,number:true}}, bed: {select:{id:true,number:true}} }, orderBy: [{moveInDate:'desc' as const},{createdAt:'desc' as const},{id:'desc' as const}] };
export function businessDate(value: string): Date {
  const date = new Date(`${value}T00:00:00.000Z`);
  const today = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Tashkent',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0,10) !== value || value < '1900-01-01' || value > today) {
    throw new UnprocessableEntityException('Укажите существующую дату не позднее сегодняшней.');
  }
  return date;
}

@Injectable()
export class ResidentsService {
  constructor(private readonly db: Database) {}
  async write<T>(actor: Actor, action: (tx: Prisma.TransactionClient) => Promise<T>) {
    try {
      return await this.db.$transaction(async tx => {
        // Same property lock as room edits; recheck access after waiting for the lock.
        await tx.$queryRaw`SELECT id FROM properties WHERE id = ${actor.propertyId}::uuid FOR UPDATE`;
        const allowed = await tx.user.findFirst({where:{id:actor.id,propertyId:actor.propertyId,active:true,role:{in:['OWNER','ADMIN']},property:{active:true}}});
        if (!allowed) throw new ForbiddenException('Доступ к дому отключён.');
        return action(tx);
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
  list(actor: Actor, q = '', filter = 'all') {
    if (q.length > 160 || !['all','active','closed'].includes(filter)) throw new UnprocessableEntityException('Некорректный фильтр жильцов.');
    const digits = q.replace(/\D/g,'');
    return this.db.resident.findMany({where:{propertyId:actor.propertyId,
      ...(q ? {OR:[{fullName:{contains:q.trim(),mode:'insensitive' as const}}, {phone:{contains:digits || q}}]} : {}),
      ...(filter === 'active' ? {occupancies:{some:{status:'ACTIVE'}}} : filter === 'closed' ? {AND:[{occupancies:{some:{status:'CLOSED'}}},{occupancies:{none:{status:'ACTIVE'}}}]} : {})},
      include:{occupancies:history},orderBy:[{fullName:'asc'},{id:'asc'}]});
  }
  async detail(actor: Actor, id: string) {
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
  async freeBed(tx: Prisma.TransactionClient, actor: Actor, bedId: string, date: Date) {
    const bed = await tx.bed.findFirst({where:{id:bedId,room:{propertyId:actor.propertyId}}});
    if (!bed) throw new NotFoundException('Место не найдено.');
    if (await tx.occupancy.findFirst({where:{bedId,status:'ACTIVE'}})) throw new ConflictException('Это место уже занято');
    if (await tx.occupancy.findFirst({where:{bedId,moveOutDate:{gt:date}}})) throw new ConflictException('На выбранную дату место ещё не было свободно.');
    return bed;
  }
  checkIn(actor: Actor, dto: CheckInDto) {
    const date = businessDate(dto.moveInDate);
    if (Boolean(dto.residentId) === Boolean(dto.resident)) throw new UnprocessableEntityException('Выберите существующего жильца или заполните данные нового.');
    return this.write(actor,async tx => {
      const resident = dto.residentId ? await tx.resident.findFirst({where:{id:dto.residentId,propertyId:actor.propertyId}}) : await this.insert(tx,actor,dto.resident!);
      if (!resident) throw new NotFoundException('Жилец не найден.');
      if (await tx.occupancy.findFirst({where:{residentId:resident.id,status:'ACTIVE'}})) throw new ConflictException('Жилец уже проживает в доме');
      if (await tx.occupancy.findFirst({where:{residentId:resident.id,moveOutDate:{gt:date}}})) throw new ConflictException('Дата пересекается с предыдущим проживанием жильца.');
      const bed = await this.freeBed(tx,actor,dto.bedId,date);
      const occupancy = await tx.occupancy.create({data:{propertyId:actor.propertyId,residentId:resident.id,roomId:bed.roomId,bedId:bed.id,moveInDate:date,monthlyPrice:dto.monthlyPrice,paymentDay:dto.paymentDay,depositAmount:dto.depositAmount,createdBy:actor.id}});
      await this.audit(tx,actor,'OCCUPANCY_CHECKED_IN',resident.id,{occupancyId:occupancy.id,newRoomId:bed.roomId,newBedId:bed.id});
      return occupancy;
    });
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
      return closed;
    });
  }
}

@Controller() @UseGuards(SessionGuard)
class ResidentsController {
  constructor(private readonly service: ResidentsService) {}
  @Get('residents') list(@Req() req: AuthRequest,@Query('q') q?: string,@Query('filter') filter?: string) { return this.service.list(req.actor,q,filter); }
  @Get('residents/:id') detail(@Req() req: AuthRequest,@Param('id',ParseUUIDPipe) id: string) { return this.service.detail(req.actor,id); }
  @Post('residents') create(@Req() req: AuthRequest,@Body() dto: ResidentDto) { return this.service.create(req.actor,dto); }
  @Patch('residents/:id') update(@Req() req: AuthRequest,@Param('id',ParseUUIDPipe) id: string,@Body() dto: ResidentDto) { return this.service.update(req.actor,id,dto); }
  @Post('occupancies/check-in') checkIn(@Req() req: AuthRequest,@Body() dto: CheckInDto) { return this.service.checkIn(req.actor,dto); }
  @Post('occupancies/:id/transfer') transfer(@Req() req: AuthRequest,@Param('id',ParseUUIDPipe) id: string,@Body() dto: TransferDto) { return this.service.transfer(req.actor,id,dto); }
  @Post('occupancies/:id/check-out') checkOut(@Req() req: AuthRequest,@Param('id',ParseUUIDPipe) id: string,@Body() dto: CheckOutDto) { return this.service.checkOut(req.actor,id,dto); }
}
@Module({imports:[AuthModule],providers:[ResidentsService],controllers:[ResidentsController]})
export class ResidentsModule {}
