import { Body, ConflictException, Controller, ForbiddenException, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthModule, AuthRequest, Actor, SessionGuard, userSelect } from './auth';
import { Database } from './database';
import { AdminActiveDto, AdminDto, BedDto, PropertyDto, RoomDto, UpdateRoomDto } from './dto';
import { hashPassword, normalizePhone } from './security';

const roomInclude = Prisma.validator<Prisma.RoomInclude>()({ beds: { include: { occupancies: { where: { status: 'ACTIVE' }, include: { resident: { select: { id: true, fullName: true, phone: true } } } } } } });

@Injectable()
export class InventoryService {
  constructor(private readonly db: Database) {}
  async write<T>(actor: Actor, action: (tx: Prisma.TransactionClient) => Promise<T>) {
    return this.db.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM properties WHERE id = ${actor.propertyId}::uuid FOR UPDATE`;
      const user = await tx.user.findFirst({ where: { id: actor.id, propertyId: actor.propertyId, active: true, role: 'OWNER', property: { active: true } } });
      if (!user) throw new ForbiddenException('Это действие доступно владельцу.');
      return action(tx);
    });
  }
  async audit(tx: Prisma.TransactionClient, actor: Actor, action: string, entity: string, entityId: string, metadata: Prisma.InputJsonObject) {
    await tx.auditLog.create({ data: { propertyId: actor.propertyId, actorId: actor.id, action, entity, entityId, metadata } });
  }
  async rooms(actor: Actor) {
    const rooms = await this.db.room.findMany({ where: { propertyId: actor.propertyId }, include: roomInclude });
    return rooms.sort((a, b) => a.number.localeCompare(b.number, 'ru', { numeric: true })).map(room => this.roomDto(room));
  }
  roomDto(room: Prisma.RoomGetPayload<{ include: typeof roomInclude }>) {
    return { ...room, totalBeds: room.beds.length, availableBeds: room.beds.filter(b => !b.occupancies.length).length, occupiedBeds: room.beds.filter(b => b.occupancies.length).length,
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
      if (room.version !== dto.version) throw new ConflictException('Комнату уже изменили. Обновите страницу.');
      if (dto.capacity < room.beds.length) throw new ConflictException('Вместимость не может быть меньше количества мест.');
      const updated = await tx.room.update({ where: { id }, data: { number: dto.number, capacity: dto.capacity, version: { increment: 1 } }, include: roomInclude });
      await this.audit(tx, actor, 'ROOM_UPDATED', 'Room', id, { before: { number: room.number, capacity: room.capacity }, after: { number: updated.number, capacity: updated.capacity } });
      return this.roomDto(updated);
    });
  }
  createBed(actor: Actor, roomId: string, dto: BedDto) {
    return this.write(actor, async tx => {
      const room = await tx.room.findFirst({ where: { id: roomId, propertyId: actor.propertyId }, include: { _count: { select: { beds: true } } } });
      if (!room) throw new NotFoundException('Комната не найдена.');
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
      await this.inventory.audit(tx, req.actor, 'PROPERTY_UPDATED', 'Property', property.id, { before: { name: before.name, address: before.address }, after: { name: property.name, address: property.address } });
      return property;
    });
  }
  @Get('dashboard') async dashboard(@Req() req: AuthRequest) {
    const rooms = await this.inventory.rooms(req.actor);
    return { roomsCount: rooms.length, bedsCount: rooms.reduce((n, r) => n + r.totalBeds, 0), availableBeds: rooms.reduce((n, r) => n + r.availableBeds, 0),
      capacity: rooms.reduce((n, r) => n + r.capacity, 0), occupiedBeds: rooms.reduce((n,r) => n + r.occupiedBeds,0), currentResidents: rooms.reduce((n,r) => n + r.occupiedBeds,0), phase: 'M2' };
  }
  @Get('rooms') rooms(@Req() req: AuthRequest) { return this.inventory.rooms(req.actor); }
  @Get('rooms/:id') room(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.inventory.room(req.actor, id); }
  @Post('rooms') createRoom(@Req() req: AuthRequest, @Body() dto: RoomDto) { return this.inventory.createRoom(req.actor, dto); }
  @Patch('rooms/:id') updateRoom(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateRoomDto) { return this.inventory.updateRoom(req.actor, id, dto); }
  @Post('rooms/:id/beds') createBed(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: BedDto) { return this.inventory.createBed(req.actor, id, dto); }
  @Get('audit') async audit(@Req() req: AuthRequest) {
    const actions = req.actor.role === 'OWNER' ? undefined : ['ROOM_CREATED', 'ROOM_UPDATED', 'BED_CREATED', 'PROPERTY_UPDATED', 'RESIDENT_CREATED', 'RESIDENT_UPDATED', 'OCCUPANCY_CHECKED_IN', 'OCCUPANCY_TRANSFERRED', 'OCCUPANCY_CHECKED_OUT'];
    return this.db.auditLog.findMany({ where: { propertyId: req.actor.propertyId, ...(actions ? { action: { in: actions } } : {}) },
      include: { actor: { select: { fullName: true } } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 100 });
  }
  @Get('users') async users(@Req() req: AuthRequest) {
    if (req.actor.role !== 'OWNER') throw new ForbiddenException('Только для владельца.');
    return this.db.user.findMany({ where: { propertyId: req.actor.propertyId }, select: userSelect, orderBy: { createdAt: 'asc' } });
  }
  @Post('users') async createAdmin(@Req() req: AuthRequest, @Body() dto: AdminDto) {
    if (req.actor.role !== 'OWNER') throw new ForbiddenException('Только для владельца.');
    const phone = normalizePhone(dto.phone);
    const passwordHash = await hashPassword(dto.password);
    return this.inventory.write(req.actor, async tx => {
      const user = await tx.user.create({ data: { propertyId: req.actor.propertyId, phone, fullName: dto.fullName, passwordHash, role: 'ADMIN' }, select: userSelect });
      await this.inventory.audit(tx, req.actor, 'ADMIN_CREATED', 'User', user.id, { fullName: user.fullName });
      return user;
    });
  }
  @Patch('users/:id') async adminActive(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string, @Body() dto: AdminActiveDto) {
    return this.inventory.write(req.actor, async tx => {
      const user = await tx.user.findFirst({ where: { id, propertyId: req.actor.propertyId } });
      if (!user) throw new NotFoundException('Сотрудник не найден.');
      if (user.role === 'OWNER') throw new ConflictException('Нельзя отключить владельца.');
      const updated = await tx.user.update({ where: { id }, data: { active: dto.active }, select: userSelect });
      if (!dto.active) await tx.session.deleteMany({ where: { userId: id } });
      await this.inventory.audit(tx, req.actor, 'ADMIN_ACCESS_CHANGED', 'User', id, { active: dto.active, fullName: user.fullName });
      return updated;
    });
  }
}

@Module({ imports: [AuthModule], providers: [InventoryService], controllers: [InventoryController] })
export class InventoryModule {}
