import { Body, CanActivate, ConflictException, Controller, Delete, ExecutionContext, ForbiddenException, Get, Headers, HttpCode, HttpException, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Request, Response } from 'express';
import { Database } from './database';
import { LoginDto, PasswordDto, SetupDto } from './dto';
import { digest, hashPassword, makeToken, normalizePhone, safeTokenEqual, verifyPassword } from './security';

export type Actor = { id: string; propertyId: string; fullName: string; phone: string; role: Role };
export type AuthRequest = Request & { actor: Actor; sessionId: string };
export const userSelect = { id: true, propertyId: true, fullName: true, phone: true, role: true, active: true } as const;
const DAY = 24 * 3600000;
const sessionSelect = { id: true, deviceName: true, platform: true, remembered: true, createdAt: true, lastSeenAt: true, expiresAt: true } as const;

/** Browser sessions use the httpOnly cookie; apps send the same token as a bearer header. */
export function sessionToken(req: Request): string | undefined {
  const cookie = req.cookies?.ijara_session;
  if (typeof cookie === 'string') return cookie;
  const header = req.headers.authorization;
  return typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
}
/** A readable device label from the user agent; never stored beyond this summary. */
export function deviceLabel(userAgent: string | undefined) {
  const ua = userAgent || '';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone' : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Устройство';
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return browser ? `${os} · ${browser}` : os;
}

@Injectable()
export class AuthService {
  private dummyHash = hashPassword(makeToken());
  constructor(private readonly db: Database) {}
  async rateLimit(label: string, value: string, maximum: number) {
    const window = Math.floor(Date.now() / 900000);
    const key = digest(`${label}:${window}:${value}`);
    const bucket = await this.db.rateBucket.upsert({ where: { key },
      create: { key, attempts: 1, expiresAt: new Date((window + 1) * 900000) },
      update: { attempts: { increment: 1 } } });
    await this.db.rateBucket.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    if (bucket.attempts > maximum) throw new HttpException('Слишком много попыток. Повторите через 15 минут.', 429);
  }
  async setup(dto: SetupDto, token: string, ip: string) {
    await this.rateLimit('setup', ip, 10);
    const expected = process.env.SETUP_TOKEN || '';
    if (expected.length < 32 || !safeTokenEqual(token || '', expected)) throw new ForbiddenException('Неверный ключ первоначальной настройки.');
    const phone = normalizePhone(dto.phone);
    const passwordHash = await hashPassword(dto.password);
    return this.db.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(360001)`;
      if (await tx.property.count()) throw new ConflictException('Первоначальная настройка уже выполнена.');
      const property = await tx.property.create({ data: { name: dto.propertyName, address: dto.address } });
      const user = await tx.user.create({ data: { propertyId: property.id, fullName: dto.fullName, phone, passwordHash, role: 'OWNER' }, select: userSelect });
      for (const room of dto.rooms) {
        const count = room.bedCount ?? room.capacity;
        if (count > room.capacity) throw new ConflictException('Количество мест превышает вместимость комнаты.');
        await tx.room.create({ data: { propertyId: property.id, number: room.number, capacity: room.capacity,
          beds: { create: Array.from({ length: count }, (_, i) => ({ number: String(i + 1) })) } } });
      }
      await tx.auditLog.create({ data: { propertyId: property.id, actorId: user.id, action: 'SETUP_COMPLETED', entity: 'Property', entityId: property.id,
        metadata: { name: property.name, rooms: dto.rooms.map(r => ({ number: r.number, capacity: r.capacity, bedCount: r.bedCount ?? r.capacity })) } } });
      return { user, property };
    }, { timeout: 20000 });
  }
  async login(dto: LoginDto, ip: string, userAgent?: string) {
    const phone = normalizePhone(dto.phone);
    await this.rateLimit('login-ip', ip, 40);
    await this.rateLimit('login-phone', phone, 10);
    const user = await this.db.user.findUnique({ where: { phone }, include: { property: true } });
    const valid = await verifyPassword(dto.password, user?.passwordHash || await this.dummyHash);
    if (!valid || !user?.active || !user.property.active) throw new UnauthorizedException('Неверный телефон или пароль.');
    const token = makeToken();
    const now = new Date();
    const remembered = Boolean(dto.remember);
    const expiresAt = new Date(now.getTime() + (remembered ? 30 : 1) * DAY);
    const platform = dto.platform ?? 'WEB';
    const deviceName = dto.deviceName || deviceLabel(userAgent);
    await this.db.$transaction(async tx => {
      await tx.session.create({ data: { tokenHash: digest(token), userId: user.id, expiresAt, platform, deviceName, remembered, lastSeenAt: now } });
      await tx.auditLog.create({ data: { propertyId: user.propertyId, actorId: user.id, action: 'LOGIN', entity: 'User', entityId: user.id, metadata: { platform, deviceName, remembered } } });
      await tx.session.deleteMany({ where: { expiresAt: { lt: now } } });
    });
    return { token, expiresAt, platform, user: { id: user.id, propertyId: user.propertyId, fullName: user.fullName, phone: user.phone, role: user.role } };
  }
  async sessions(actor: Actor, currentId: string) {
    const rows = await this.db.session.findMany({ where: { userId: actor.id, expiresAt: { gt: new Date() } }, select: sessionSelect, orderBy: [{ lastSeenAt: 'desc' }, { createdAt: 'desc' }] });
    return rows.map(s => ({ ...s, current: s.id === currentId }));
  }
  async staffSessions(actor: Actor, currentId: string) {
    if (!['OWNER', 'SUPER_ADMIN'].includes(actor.role)) throw new ForbiddenException('Только для владельца.');
    const rows = await this.db.session.findMany({ where: { user: { propertyId: actor.propertyId }, expiresAt: { gt: new Date() } }, select: { ...sessionSelect, user: { select: { id: true, fullName: true, role: true } } }, orderBy: [{ lastSeenAt: 'desc' }, { createdAt: 'desc' }] });
    return rows.map(s => ({ ...s, current: s.id === currentId }));
  }
  /** Users end their own sessions; the owner can also end any staff session of the property. */
  async revoke(actor: Actor, id: string) {
    return this.db.$transaction(async tx => {
      const session = await tx.session.findFirst({ where: { id, user: { propertyId: actor.propertyId } }, include: { user: { select: { id: true, role: true, fullName: true } } } });
      if (!session) throw new NotFoundException('Сессия не найдена или уже завершена.');
      const own = session.userId === actor.id;
      if (!own && !['OWNER', 'SUPER_ADMIN'].includes(actor.role)) throw new ForbiddenException('Завершать чужие сессии может только владелец.');
      await tx.session.delete({ where: { id } });
      await tx.auditLog.create({ data: { propertyId: actor.propertyId, actorId: actor.id, action: 'SESSION_REVOKED', entity: 'User', entityId: session.userId, metadata: { sessionId: id, deviceName: session.deviceName, platform: session.platform, own } } });
      return { revoked: true };
    });
  }
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly db: Database) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    const token = sessionToken(req);
    if (typeof token !== 'string' || !token || token.length > 200) throw new UnauthorizedException('Войдите в систему.');
    const session = await this.db.session.findUnique({ where: { tokenHash: digest(token) }, include: { user: { include: { property: true } } } });
    if (!session || session.expiresAt <= new Date() || !session.user.active || !session.user.property.active) throw new UnauthorizedException('Сессия завершена. Войдите снова.');
    const { id, propertyId, fullName, phone, role } = session.user;
    req.actor = { id, propertyId, fullName, phone, role };
    req.sessionId = session.id;
    // Activity for the device list, written at most once per 5 minutes per session.
    const stale = new Date(Date.now() - 300000);
    if (!session.lastSeenAt || session.lastSeenAt < stale) await this.db.session.updateMany({ where: { id: session.id, OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: stale } }] }, data: { lastSeenAt: new Date() } });
    return true;
  }
}

@Controller('auth')
class AuthController {
  constructor(private readonly auth: AuthService, private readonly db: Database) {}
  @Get('setup-status') async status() { return { configured: (await this.db.property.count()) > 0 }; }
  @Post('setup') setup(@Body() dto: SetupDto, @Headers('x-setup-token') token: string, @Req() req: Request) {
    return this.auth.setup(dto, token, req.ip || 'unknown');
  }
  @Post('login') @HttpCode(200)
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(dto, req.ip || 'unknown', req.headers['user-agent']);
    if (result.platform !== 'WEB') return { token: result.token, user: result.user, expiresAt: result.expiresAt };
    res.cookie('ijara_session', result.token, { httpOnly: true, secure: process.env.COOKIE_SECURE !== 'false', sameSite: 'strict', path: '/', expires: result.expiresAt });
    return { user: result.user, expiresAt: result.expiresAt };
  }
  @Get('me') @UseGuards(SessionGuard) me(@Req() req: AuthRequest) { return req.actor; }
  @Get('sessions') @UseGuards(SessionGuard) sessions(@Req() req: AuthRequest) { return this.auth.sessions(req.actor, req.sessionId); }
  @Get('staff-sessions') @UseGuards(SessionGuard) staffSessions(@Req() req: AuthRequest) { return this.auth.staffSessions(req.actor, req.sessionId); }
  @Delete('sessions/:id') @UseGuards(SessionGuard) revoke(@Req() req: AuthRequest, @Param('id', ParseUUIDPipe) id: string) { return this.auth.revoke(req.actor, id); }
  @Post('logout') @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = sessionToken(req);
    if (token) await this.db.session.deleteMany({ where: { tokenHash: digest(token) } });
    res.clearCookie('ijara_session', { path: '/', httpOnly: true, secure: process.env.COOKIE_SECURE !== 'false', sameSite: 'strict' });
  }
  @Post('password') @HttpCode(204) @UseGuards(SessionGuard)
  async password(@Body() dto: PasswordDto, @Req() req: AuthRequest) {
    await this.auth.rateLimit('password', req.actor.id, 10);
    const user = await this.db.user.findUniqueOrThrow({ where: { id: req.actor.id } });
    if (!await verifyPassword(dto.currentPassword, user.passwordHash)) throw new UnauthorizedException('Текущий пароль неверен.');
    const passwordHash = await hashPassword(dto.newPassword);
    await this.db.$transaction(async tx => {
      const changed = await tx.user.updateMany({ where: { id: user.id, passwordHash: user.passwordHash, active: true }, data: { passwordHash } });
      if (!changed.count) throw new ConflictException('Учётная запись изменилась. Войдите повторно.');
      await tx.session.deleteMany({ where: { userId: user.id } });
      await tx.auditLog.create({ data: { propertyId: user.propertyId, actorId: user.id, action: 'PASSWORD_CHANGED', entity: 'User', entityId: user.id, metadata: {} } });
    });
  }
}

@Module({ providers: [AuthService, SessionGuard], controllers: [AuthController], exports: [SessionGuard, AuthService] })
export class AuthModule {}
