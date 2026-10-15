import 'reflect-metadata';
import { ArgumentsHost, Catch, Controller, ExceptionFilter, Get, HttpException, Module, ServiceUnavailableException, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import cookieParser from 'cookie-parser';
import { json, raw, Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { AuthModule } from './auth';
import { Database, DatabaseModule } from './database';
import { InventoryModule } from './inventory';
import { allowedOrigins } from './origins';
import { ResidentsModule } from './residents';
import { FinanceModule } from './finance';
import { ApplicationsModule } from './applications';
import { RealtimeHub, RealtimeModule } from './realtime';
import { TenantModule } from './tenant';
import { TenantFinanceModule } from './tenant-finance';
import { TicketsModule } from './tickets';
import { NotificationsModule } from './notifications';
import { SystemModule } from './system';
import { LocationModule, LocationService } from './location';

@Controller('health')
class HealthController {
  constructor(private readonly db: Database, private readonly realtime: RealtimeHub, private readonly location: LocationService) {}
  @Get() async health() {
    try { await this.db.$queryRaw`SELECT 1`; }
    catch { throw new ServiceUnavailableException('База данных недоступна.'); }
    // Private listeners only (the public one answers 404 here). Seconds since each worker last finished.
    const age = (d: Date | null) => d ? Math.round((Date.now() - d.getTime()) / 1000) : null;
    return { status: 'ok', version: '0.1.0', realtime: this.realtime.listening,
      location: { statusWorker: age(this.location.beats.status), retentionWorker: age(this.location.beats.retention), lastUpload: age(this.location.beats.ingest), mapConfigured: Boolean(process.env.YANDEX_MAPS_API_KEY), mapKey: this.location.mapKey } };
  }
}
@Module({ imports: [DatabaseModule, RealtimeModule, AuthModule, InventoryModule, ResidentsModule, FinanceModule, ApplicationsModule, TenantModule, TenantFinanceModule, TicketsModule, NotificationsModule, SystemModule, LocationModule], controllers: [HealthController] })
export class AppModule {}

@Catch()
class ErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    let status = 500, message: string | string[] = 'Не удалось выполнить запрос. Повторите позже.', code: string | undefined;
    if (error instanceof HttpException) {
      status = error.getStatus();
      const body = error.getResponse();
      message = typeof body === 'string' ? body : (body as { message: string | string[] }).message;
      // Machine-readable reason for apps (M7: NOT_PRIMARY, NOT_RESIDENT, SHARING_OFF); never free text.
      const c = typeof body === 'object' ? (body as { code?: unknown }).code : undefined;
      if (typeof c === 'string' && /^[A-Z_]{2,40}$/.test(c)) code = c;
    } else if (error instanceof Error && 'status' in error && [400, 413].includes(Number(error.status))) {
      status = Number(error.status); message = status === 413 ? 'Запрос слишком большой.' : 'Неверный формат JSON.';
    } else if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      status = 409; message = 'Такой телефон, номер комнаты или места уже существует.';
    }
    if (status === 429) res.setHeader('Retry-After', '900');
    if (status === 500) console.error('Request failed', res.getHeader('X-Request-Id'), error instanceof Error ? error.name : 'UnknownError');
    res.status(status).json({ statusCode: status, message, ...(code ? { code } : {}), requestId: res.getHeader('X-Request-Id') });
  }
}

export async function createApp() {
  if (!process.env.APP_ORIGIN || !process.env.SETUP_TOKEN || process.env.SETUP_TOKEN.length < 32) throw new Error('APP_ORIGIN and a random SETUP_TOKEN (32+ characters) are required.');
  if (process.env.NODE_ENV === 'production' && (process.env.COOKIE_SECURE === 'false' || !process.env.APP_ORIGIN.startsWith('https://'))) throw new Error('Production requires HTTPS and secure cookies.');
  const origins = allowedOrigins(process.env.APP_ORIGIN, process.env.ADDITIONAL_APP_ORIGINS, process.env.NODE_ENV === 'production');
  const app = await NestFactory.create(AppModule, { bodyParser: false, logger: ['error', 'warn', 'log'] });
  app.setGlobalPrefix('api');
  // Only the gateway (private Docker network) is trusted. It overwrites X-Forwarded-For from
  // direct LAN clients and keeps the value Tailscale Serve/Funnel sets, so rate limits see the real client.
  app.getHttpAdapter().getInstance().set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.use(helmet());
  app.use(cookieParser());
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Request-Id', randomUUID());
    res.setHeader('Cache-Control', 'no-store');
    // App requests carry a bearer token that a foreign page cannot attach (no CORS), so CSRF checks
    // apply only to cookie-authenticated browser requests.
    // Native apps send no Origin at all (browsers always do on POST); they still send the custom header.
    const noCookie = !/(^|;\s*)ijara_(session|tenant|applicant)=/.test(req.headers.cookie || '');
    const bearerOnly = typeof req.headers.authorization === 'string' && req.headers.authorization.startsWith('Bearer ') && noCookie;
    const nativeApp = !req.headers.origin && req.headers['x-ijara-request'] === '1' && noCookie;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !bearerOnly && !nativeApp && !(req.method === 'POST' && req.path === '/api/telegram/webhook')) {
      if (!origins.has(req.headers.origin ?? '') || req.headers['x-ijara-request'] !== '1') {
        res.status(403).json({ statusCode: 403, message: 'Запрос отклонён. Откройте приложение по основному адресу.' }); return;
      }
    }
    next();
  });
  app.use('/api/public/applications/documents', raw({type:['image/jpeg','image/png','image/webp'],limit:'8mb'}));
  app.use(json({ limit: '32kb' }));
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, errorHttpStatusCode: 422 }));
  app.useGlobalFilters(new ErrorFilter());
  app.get(RealtimeHub).attach(app.getHttpServer());
  app.enableShutdownHooks();
  return app;
}
