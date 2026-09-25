import 'reflect-metadata';
import { ArgumentsHost, Catch, Controller, ExceptionFilter, Get, HttpException, Module, ServiceUnavailableException, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import cookieParser from 'cookie-parser';
import { json, Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { AuthModule } from './auth';
import { Database, DatabaseModule } from './database';
import { InventoryModule } from './inventory';
import { allowedOrigins } from './origins';

@Controller('health')
class HealthController {
  constructor(private readonly db: Database) {}
  @Get() async health() {
    try { await this.db.$queryRaw`SELECT 1`; return { status: 'ok', version: '0.1.0' }; }
    catch { throw new ServiceUnavailableException('База данных недоступна.'); }
  }
}
@Module({ imports: [DatabaseModule, AuthModule, InventoryModule], controllers: [HealthController] })
export class AppModule {}

@Catch()
class ErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    let status = 500, message: string | string[] = 'Не удалось выполнить запрос. Повторите позже.';
    if (error instanceof HttpException) {
      status = error.getStatus();
      const body = error.getResponse();
      message = typeof body === 'string' ? body : (body as { message: string | string[] }).message;
    } else if (error instanceof Error && 'status' in error && [400, 413].includes(Number(error.status))) {
      status = Number(error.status); message = status === 413 ? 'Запрос слишком большой.' : 'Неверный формат JSON.';
    } else if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      status = 409; message = 'Такой телефон, номер комнаты или места уже существует.';
    }
    if (status === 429) res.setHeader('Retry-After', '900');
    if (status === 500) console.error('Request failed', res.getHeader('X-Request-Id'), error instanceof Error ? error.name : 'UnknownError');
    res.status(status).json({ statusCode: status, message, requestId: res.getHeader('X-Request-Id') });
  }
}

export async function createApp() {
  if (!process.env.APP_ORIGIN || !process.env.SETUP_TOKEN || process.env.SETUP_TOKEN.length < 32) throw new Error('APP_ORIGIN and a random SETUP_TOKEN (32+ characters) are required.');
  if (process.env.NODE_ENV === 'production' && (process.env.COOKIE_SECURE === 'false' || !process.env.APP_ORIGIN.startsWith('https://'))) throw new Error('Production requires HTTPS and secure cookies.');
  const origins = allowedOrigins(process.env.APP_ORIGIN, process.env.ADDITIONAL_APP_ORIGINS, process.env.NODE_ENV === 'production');
  const app = await NestFactory.create(AppModule, { bodyParser: false, logger: ['error', 'warn', 'log'] });
  app.setGlobalPrefix('api');
  app.use(helmet());
  app.use(cookieParser());
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Request-Id', randomUUID());
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (!origins.has(req.headers.origin ?? '') || req.headers['x-ijara-request'] !== '1') {
        res.status(403).json({ statusCode: 403, message: 'Запрос отклонён. Откройте приложение по основному адресу.' }); return;
      }
    }
    next();
  });
  app.use(json({ limit: '32kb' }));
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: true, errorHttpStatusCode: 422 }));
  app.useGlobalFilters(new ErrorFilter());
  app.enableShutdownHooks();
  return app;
}
