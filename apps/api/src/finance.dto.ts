import { Type } from 'class-transformer';
import { ChargeStatus, ChargeType, PaymentMethod } from '@prisma/client';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min } from 'class-validator';

export class ChargeDto {
  @IsUUID('4') residentId!: string;
  @IsUUID('4') bedId!: string;
  @IsString() @Matches(/^(0|[1-9]\d{0,7})(\.\d{1,2})?$/, {message:'Сумма: до 99 999 999,99 сум, максимум два знака после точки.'}) amount!: string;
  @IsEnum(ChargeType) type: ChargeType = 'RENT';
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) billingPeriodStart!: string;
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) billingPeriodEnd!: string;
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/) dueDate!: string;
  @IsInt() @Min(0) @Max(365) gracePeriodDays = 0;
  @IsUUID('4') idempotencyKey!: string;
}
export class PaymentDto {
  @IsOptional() @IsUUID('4') chargeId?: string;
  @IsUUID('4') residentId!: string;
  @IsString() @Matches(/^(0|[1-9]\d{0,7})(\.\d{1,2})?$/, {message:'Укажите сумму платежа с точностью до двух знаков.'}) amount!: string;
  @IsEnum(PaymentMethod) method: PaymentMethod = 'CASH';
  @IsOptional() @IsString() @Length(0,2000) comment?: string;
  @IsUUID('4') idempotencyKey!: string;
}
export class FinanceQuery {
  @IsOptional() @IsUUID('4') residentId?: string;
  @IsOptional() @IsEnum(ChargeStatus) status?: ChargeStatus;
  @Type(() => Number) @IsInt() @Min(1) @Max(100000) page = 1;
}
