import { Body, ConflictException, Controller, Delete, ForbiddenException, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Query, Req, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthModule, AuthRequest, Actor, SessionGuard, userSelect } from './auth';
import { Database } from './database';
import { DEFAULT_ADMIN_PERMISSIONS, PermissionCode, requireAccess } from './permission-policy';
import { AdminActiveDto, AdminDto, BedDto, MakeOwnerDto, PropertyDto, RoomDto, StaffEditDto, StaffPasswordDto, UpdateRoomDto, RoomVersionDto, RoomArchiveDto } from './dto';
import { hashPassword, normalizePhone } from './security';
import { publish } from './realtime';

const numbered = (n: string) => /^\d{1,6}$/.test(n);
const roomInclude =Prisma.validator<Prisma.RoomInclude>()({ _count: { select: { occupancies: true, charges: true } }, beds: { include: { occupancies: { where: { status: 'ACTIVE' }, include: { resident: { select: { id: true, fullName: true, phone: true, totalDebt: true } } } } } } });

@Injectable()
export class InventoryService {
  constructor(private readonly db: Database) {}
  async write<T>(actor: Actor, action: (tx: Prisma.TransactionClient) => Promise<T>, need: PermissionCode | 'SUPER_ADMIN' = 'ROOMS_MANAGE') {
    return this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM properties WHERE id = ${actor.propertyId}::uuid FOR UPDATE`;
      await requireAccess(tx, actor, need);
      const result = await action(tx);
      await publish(tx, { p: actor.propertyId, topic: 'house', type: 'changed' });
      return result;
    });
  }
  async audit(tx: Prisma.TransactionClient, actor: Actor, action: string, entity: string, entityId: string, metadata: Prisma.InputJsonObject) {
    await tx.auditLog.create({ data: { propertyId: actor.propertyId, actorId: actor.id, action, entity, entityId, metadata } });
  }
  async rooms(actor: Actor, filter = 'active') {
    if (!['active','archived','all'].includes(filter)) throw new UnprocessableEntityException('Некорректный фильтр комнат.');
    const rooms = await this.db.room.findMany({ where: { propertyId: actor.propertyId, ...(filter === 'all' ? {} : {archivedAt: filter === 'archived' ? {not:null} : null}) }, include: roomInclude });
    return rooms.sort((a, b) => a.number.localeCompare(b.number, 'ru', { numeric: true })).map(room => this.roomDto(room));
  }
  roomDto(room: Prisma.RoomGetPayload<{ include: typeof roomInclude }>) {
    const { _count, ...data } = room;
    return { ...data, canDelete: _count.occupancies === 0 && _count.charges === 0, totalBeds: room.beds.length, availableBeds: room.beds.filter(b => !b.occupancies.length).length, occupiedBeds: room.beds.filter(b => b.occupancies.length).length,
      beds: [...room.beds].sort((a, b) => a.number.localeCompare(b.number, 'ru', { numeric: true })).map(b => ({ ...b, occupancy: b.occupancies[0] ?? null, status: b.occupancies.length ? 'OCCUPIED' : 'AVAILABLE', displayNumber: `${room.number}-${b.number}` })) };
  }
  async room(actor: Actor, id: string) {
    const room = await this.db.room.findFirst({ where: { id, propertyId: actor.propertyId }, include: roomInclude });
    if (!room) throw new NotFoundException('Комната не найдена.');
    return this.roomDto(room);
  }
  createRoom(actor: Actor, dto: RoomDto) {
    return this.write(actor, async tx => {
      const count = dto.bedCount ?? dto.capacity;
      if (count > dto.capacity) throw new ConflictException('Количество мест превышает вместимость.');
      const room = await tx.room.create({ data: { propertyId: actor.propertyId, number: dto.number, capacity: dto.capacity,
        beds: { create: Array.from({ length: count }, (_, i) => ({ number: String(i + 1) })) } }, include: roomInclude });
      await this.audit(tx, actor, 'ROOM_CREATED', 'Room', room.id, { number: room.number, capacity: room.capacity, beds: count });
      return this.roomDto(room);
    });
  }
  updateRoom(actor: Actor, id: string, dto: UpdateRoomDto) {
    return this.write(actor, async tx => {
      const room = await tx.room.findFirst({ where: { id, propertyId: actor.propertyId }, include: roomInclude });
      if (!room) throw new NotFoundException('Комната не найдена.');
      if (room.archivedAt) throw new ConflictException('Сначала восстановите комнату из архива.');
      if (room.version !== dto.version) throw new ConflictException('Комнату уже изменили. Обновите страницу.');
      if (dto.capacity < room.beds.length) throw new ConflictException('Вместимость не может быть меньше количества мест.');
      const updated = await tx.room.update({ where: { id }, data: { number: dto.number, capacity: dto.capacity, version: { increment: 1 } }, include: roomInclude });
      await this.audit(tx, actor, 'ROOM_UPDATED', 'Room', id, { before: { number: room.number, capacity: room.capacity }, after: { number: updated.number, capacity: updated.capacity } });
      return this.roomDto(updated);
    });
  }
  lifecycle(actor: Actor, id: string, dto: RoomVersionDto, archived?: boolean) {
    return this.write(actor, async tx => {
      const room = await tx.room.findFirst({where:{id,propertyId:actor.propertyId},include:roomInclude});
      if (!room) throw new NotFoundException('Комната не найдена.');
      if (room.version !== dto.version) throw new ConflictException('Комнату уже изменили. Обновите страницу.');
      if (archived === undefined) {
        if (room._count.occupancies || room._count.charges) throw new ConflictException('У комнаты есть история проживания или начисления. Уберите её в архив.');
        await tx.bed.deleteMany({where:{roomId:id}});
        await tx.room.delete({where:{id}});
        await this.audit(tx,actor,'ROOM_DELETED','Room',id,{number:room.number,beds:room.beds.length});
        await this.renumber(tx,actor);
        return {deleted:true};
      }
      if (Boolean(room.archivedAt) === archived) throw new ConflictException('Состояние комнаты уже изменено. Обновите страницу.');
      if (archived && room.beds.some(b=>b.occupancies.length)) throw new ConflictException('Сначала переселите или выселите всех жильцов комнаты.');
      // A restored numbered room joins the end of the active list, so it never takes a number that is already in use.
      const next = !archived && numbered(room.number) ? String((await this.renumber(tx,actor)) + 1) : room.number;
      const updated = await tx.room.update({where:{id},data:{archivedAt:archived ? new Date() : null,number:next,version:{increment:1}},include:roomInclude});
      await this.audit(tx,actor,archived?'ROOM_ARCHIVED':'ROOM_RESTORED','Room',id,{number:room.number,...(next!==room.number?{newNumber:next}:{})});
      if (archived) await this.renumber(tx,actor);
      return this.roomDto(updated);
    });
  }
  /** Numbers active rooms with plain numeric numbers 1, 2, 3… in their current order; named rooms keep their names. Returns how many numbered rooms are active. */
  async renumber(tx: Prisma.TransactionClient, actor: Actor) {
    const rooms = (await tx.room.findMany({ where: { propertyId: actor.propertyId, archivedAt: null }, select: { id: true, number: true } }))
      .filter(r => numbered(r.number)).sort((a, b) => Number(a.number) - Number(b.number) || a.number.localeCompare(b.number));
    const changes = rooms.map((r, i) => ({ roomId: r.id, from: r.number, to: String(i + 1) })).filter(c => c.from !== c.to);
    // Two passes keep the unique index satisfied while numbers swap places.
    for (const c of changes) await tx.room.update({ where: { id: c.roomId }, data: { number: `~${c.roomId.slice(0, 18).toUpperCase()}` } });
    for (const c of changes) await tx.room.update({ where: { id: c.roomId }, data: { number: c.to, version: { increment: 1 } } });
    if (changes.length) await this.audit(tx, actor, 'ROOMS_RENUMBERED', 'Property', actor.propertyId, { changes });
    return rooms.length;
  }
  createBed(actor: Actor, roomId: string, dto: BedDto) {
    return this.write(actor, async tx => {
      const room = await tx.room.findFirst({ where: { id: roomId, propertyId: actor.propertyId }, include: { _count: { select: { beds: true } } } });
      if (!room) throw new NotFoundException('Комната не найдена.');
      if (room.archivedAt) throw new ConflictException('Сначала восстановите комнату из архива.');
      if (room._count.beds >= room.capacity) throw new ConflictException('В комнате уже созданы все места. Сначала увеличьте вместимость.');
      const bed = await tx.bed.create({ data: { roomId, number: dto.number } });
      await tx.room.update({ where: { id: roomId }, data: { version: { increment: 1 } } });
      await this.audit(tx, actor, 'BED_CREATED', 'Bed', bed.id, { roomNumber: room.number, number: bed.number });
      return { ...bed, status: 'AVAILABLE' };
    });
  }
}

@Controller() @UseGuards(SessionGuard)
class InventoryController {
  constructor(private readonly inventory: InventoryService, private readonly db: Database) {}
  @Get('property') property(@Req() req: AuthRequest) { return this.db.property.findUniqueOrThrow({ where: { id: req.actor.propertyId } }); }
  @Patch('property') propertyUpdate(@Req() req: AuthRequest, @Body() dto: PropertyDto) {
    return this.inventory.write(req.actor, async tx => {
      const before = await tx.property.findUniqueOrThrow({ where: { id: req.actor.propertyId } });
      const property = await tx.property.update({ where: { id: req.actor.propertyId }, data: dto });
      await this.inventory.audit(tx, req.actor, 'PROPERTY_UPDATED', 'Property', property.id, { before: { name: before.name, address: before.address, autoBilling: before.autoBillingEnabled, reminders: before.paymentRemindersEnabled }, after: { name: property.name, address: property.address, autoBilling: property.autoBillingEnabled, reminders: property.paymentRemindersEnabled } });
      return property;
    }, 'SUPER_ADMIN');
  }
  @Get('dashboard') async dashboard(@Req() req: AuthRequest) {
    const rooms = await this.inventory.rooms(req.actor);
    return { roomsCount: rooms.length, bedsCount: rooms.reduce((n, r) => n + r.totalBeds, 0), availableBeds: rooms.reduce((n, r) => n + r.availableBeds, 0),
      capacity: rooms.reduce((n, r) => n + r.capacity, 0), occupiedBeds: rooms.reduce((n,r) => n + r.occupiedBeds,0), currentResidents: rooms.reduce((n,r) => n + r.occupiedBeds,0), phase: 'M3' };
  }
  @Get('rooms') rooms(@Req() req: AuthRequest, @Query('filter') filter?: string) { return this.inventory.rooms(req.actor, filter); }
  @Patch('rooms/:id/archive') archiveRoom(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RoomArchiveDto) { return this.inventory.lifecycle(req.actor,id,dto,dto.archived); }
  @Post('rooms/renumber') renumber(@Req() req: AuthRequest) { return this.inventory.write(req.actor, async tx => ({ numbered: await this.inventory.renumber(tx, req.actor) })); }
  @Delete('rooms/:id') deleteRoom(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: RoomVersionDto) { return this.inventory.lifecycle(req.actor,id,dto); }
  @Get('rooms/:id') room(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.inventory.room(req.actor, id); }
  @Post('rooms') createRoom(@Req() req: AuthRequest, @Body() dto: RoomDto) { return this.inventory.createRoom(req.actor, dto); }
  @Patch('rooms/:id') updateRoom(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRoomDto) { return this.inventory.updateRoom(req.actor, id, dto); }
  @Post('rooms/:id/beds') createBed(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: BedDto) { return this.inventory.createBed(req.actor, id, dto); }
  @Get('audit') async audit(@Req() req: AuthRequest) {
    const actions = ['OWNER','SUPER_ADMIN'].includes(req.actor.role) ? undefined : ['ROOM_CREATED', 'ROOM_UPDATED', 'ROOM_ARCHIVED', 'ROOM_RESTORED', 'ROOM_DELETED', 'ROOMS_RENUMBERED','BED_CREATED', 'PROPERTY_UPDATED', 'RESIDENT_CREATED', 'RESIDENT_UPDATED', 'OCCUPANCY_CHECKED_IN', 'OCCUPANCY_TRANSFERRED', 'OCCUPANCY_CHECKED_OUT'];
    return this.db.auditLog.findMany({ where: { propertyId: req.actor.propertyId, ...(actions ? { action: { in: actions } } : {}) },
      include: { actor: { select: { fullName: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100 });
  }
  @Get('users') async users(@Req() req: AuthRequest) {
    if (!['OWNER','SUPER_ADMIN'].includes(req.actor.role)) throw new ForbiddenException('Только для владельца.');
    return this.db.user.findMany({ where: { propertyId: req.actor.propertyId }, select: userSelect, orderBy: { createdAt: 'asc' } });
  }
  @Post('users') async createAdmin(@Req() req: AuthRequest, @Body() dto: AdminDto) {
    if (!['OWNER','SUPER_ADMIN'].includes(req.actor.role)) throw new ForbiddenException('Только для владельца.');
    const phone = normalizePhone(dto.phone);
    const passwordHash = await hashPassword(dto.password);
    return this.inventory.write(req.actor, async tx => {
      const user = await tx.user.create({ data: { propertyId: req.actor.propertyId, phone, fullName: dto.fullName, passwordHash, role: 'ADMIN' }, select: userSelect });
      await tx.userPermission.createMany({ data: DEFAULT_ADMIN_PERMISSIONS.map(permissionCode => ({ userId: user.id, propertyId: req.actor.propertyId, permissionCode })) });
      await this.inventory.audit(tx, req.actor, 'ADMIN_CREATED', 'User', user.id, { fullName: user.fullName, permissions: DEFAULT_ADMIN_PERMISSIONS });
      return user;
    }, 'SUPER_ADMIN');
  }
  @Patch('users/:id') async adminActive(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminActiveDto) {
    return this.inventory.write(req.actor, async tx => {
      const user = await tx.user.findFirst({ where: { id, propertyId: req.actor.propertyId } });
      if (!user) throw new NotFoundException('Сотрудник не найден.');
      if (['OWNER','SUPER_ADMIN'].includes(user.role)) throw new ConflictException('Нельзя отключить владельца.');
      const updated = await tx.user.update({ where: { id }, data: { active: dto.active }, select: userSelect });
      if (!dto.active) await tx.session.deleteMany({ where: { userId: id } });
      await this.inventory.audit(tx, req.actor, 'ADMIN_ACCESS_CHANGED', 'User', id, { active: dto.active, fullName: user.fullName });
      return updated;
    }, 'SUPER_ADMIN');
  }
  // Only the owner edits a staff member, and never another owner.
  private async staff(tx: Prisma.TransactionClient, actor: Actor, id: string) {
    const user = await tx.user.findFirst({ where: { id, propertyId: actor.propertyId } });
    if (!user) throw new NotFoundException('Сотрудник не найден.');
    if (['OWNER', 'SUPER_ADMIN'].includes(user.role)) throw new ConflictException('Это владелец. Его данные меняет он сам.');
    return user;
  }
  @Post('users/:id/profile') async editStaff(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: StaffEditDto) {
    return this.inventory.write(req.actor, async tx => {
      const user = await this.staff(tx, req.actor, id);
      const phone = dto.phone ? normalizePhone(dto.phone) : user.phone;
      try {
        const updated = await tx.user.update({ where: { id }, data: { phone, fullName: dto.fullName ?? user.fullName }, select: userSelect });
        await this.inventory.audit(tx, req.actor, 'ADMIN_PROFILE_CHANGED', 'User', id, { fullName: updated.fullName, phoneChanged: phone !== user.phone });
        return updated;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new ConflictException('Этот телефон уже используется.');
        throw e;
      }
    }, 'SUPER_ADMIN');
  }
  @Post('users/:id/password') async resetStaffPassword(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: StaffPasswordDto) {
    const passwordHash = await hashPassword(dto.password);
    return this.inventory.write(req.actor, async tx => {
      const user = await this.staff(tx, req.actor, id);
      await tx.user.update({ where: { id }, data: { passwordHash } });
      // The new password ends every open session and forgets trusted devices, like a self password change.
      await tx.session.deleteMany({ where: { userId: id } });
      await tx.trustedDevice.deleteMany({ where: { userId: id } });
      await this.inventory.audit(tx, req.actor, 'ADMIN_PASSWORD_RESET', 'User', id, { fullName: user.fullName });
      return { ok: true };
    }, 'SUPER_ADMIN');
  }
  @Delete('users/:id') async deleteStaff(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.inventory.write(req.actor, async tx => {
      const user = await this.staff(tx, req.actor, id);
      // The journal is append-only, so a member who ever signed in or acted leaves rows that must stay and
      // that the person is still linked to. Such a member is disabled, never deleted; delete is only for a
      // wrong entry that was never used.
      const [acted, checkedIn] = await Promise.all([
        tx.auditLog.count({ where: { actorId: id } }),
        tx.occupancy.count({ where: { createdBy: id } }),
      ]);
      if (acted > 0 || checkedIn > 0) throw new ConflictException('Сотрудник уже входил или работал в системе. Его можно отключить, но не удалить — так сохраняется история.');
      await tx.userPermission.deleteMany({ where: { userId: id } });
      await tx.session.deleteMany({ where: { userId: id } });
      await tx.trustedDevice.deleteMany({ where: { userId: id } });
      await tx.staffTelegramLink.deleteMany({ where: { userId: id } });
      await tx.loginApproval.deleteMany({ where: { userId: id } });
      await tx.user.delete({ where: { id } });
      await this.inventory.audit(tx, req.actor, 'ADMIN_DELETED', 'User', id, { fullName: user.fullName, phone: user.phone });
      return { ok: true };
    }, 'SUPER_ADMIN');
  }
  @Post('users/:id/owner') async makeOwner(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: MakeOwnerDto) {
    if (!dto.confirm) throw new UnprocessableEntityException('Подтвердите назначение владельцем.');
    return this.inventory.write(req.actor, async tx => {
      const user = await this.staff(tx, req.actor, id);
      if (!user.active) throw new ConflictException('Сначала включите доступ сотрудника.');
      // An owner is a super-administrator: they bypass the per-function permissions, so none need to be set.
      const updated = await tx.user.update({ where: { id }, data: { role: 'OWNER' }, select: userSelect });
      await this.inventory.audit(tx, req.actor, 'ADMIN_PROMOTED_TO_OWNER', 'User', id, { fullName: user.fullName });
      return updated;
    }, 'SUPER_ADMIN');
  }
}

@Module({ imports: [AuthModule], providers: [InventoryService], controllers: [InventoryController] })
export class InventoryModule {}
