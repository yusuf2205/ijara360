import { Body, CanActivate, ConflictException, Controller, ExecutionContext, ForbiddenException, Get, Headers, HttpCode, HttpException, Injectable, Module, Post, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Request, Response } from 'express';
import { Database } from './database';
import { LoginDto, PasswordDto, SetupDto } from './dto';
import { digest, hashPassword, makeToken, normalizePhone, safeTokenEqual, verifyPassword } from './security';

export type Actor = { id: string; propertyId: string; fullName: string; phone: string; role: Role };
export type AuthRequest = Request & { actor: Actor; sessionId: string };
export const userSelect = { id: true, propertyId: true, fullName: true, phone: true, role: true, active: true } as const;

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
  async login(dto: LoginDto, ip: string) {
    const phone = normalizePhone(dto.phone);
    await this.rateLimit('login-ip', ip, 40);
    await this.rateLimit('login-phone', phone, 10);
    const user = await this.db.user.findUnique({ where: { phone }, include: { property: true } });
    const valid = await verifyPassword(dto.password, user?.passwordHash || await this.dummyHash);
    if (!valid || !user?.active || !user.property.active) throw new UnauthorizedException('Неверный телефон или пароль.');
    const token = makeToken();
    const expiresAt = new Date(Date.now() + 24 * 3600000);
    await this.db.$transaction(async tx => {
      await tx.session.create({ data: { tokenHash: digest(token), userId: user.id, expiresAt } });
      await tx.auditLog.create({ data: { propertyId: user.propertyId, actorId: user.id, action: 'LOGIN', entity: 'User', entityId: user.id, metadata: {} } });
      await tx.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    });
    return { token, expiresAt, user: { id: user.id, propertyId: user.propertyId, fullName: user.fullName, phone: user.phone, role: user.role } };
  }
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly db: Database) {}
  async canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    const token = req.cookies?.ijara_session;
    if (typeof token !== 'string' || token.length > 200) throw new UnauthorizedException('Войдите в систему.');
    const session = await this.db.session.findUnique({ where: { tokenHash: digest(token) }, include: { user: { include: { property: true } } } });
    if (!session || session.expiresAt <= new Date() || !session.user.active || !session.user.property.active) throw new UnauthorizedException('Сессия завершена. Войдите снова.');
    const { id, propertyId, fullName, phone, role } = session.user;
    req.actor = { id, propertyId, fullName, phone, role };
    req.sessionId = session.id;
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
    const result = await this.auth.login(dto, req.ip || 'unknown');
    res.cookie('ijara_session', result.token, { httpOnly: true, secure: process.env.COOKIE_SECURE !== 'false', sameSite: 'strict', path: '/', expires: result.expiresAt });
    return { user: result.user, expiresAt: result.expiresAt };
  }
  @Get('me') @UseGuards(SessionGuard) me(@Req() req: AuthRequest) { return req.actor; }
  @Post('logout') @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    if (typeof req.cookies?.ijara_session === 'string') {
      await this.db.session.deleteMany({ where: { tokenHash: digest(req.cookies.ijara_session) } });
    }
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
