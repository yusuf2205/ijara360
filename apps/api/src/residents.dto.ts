import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Length, Matches, Max, Min, ValidateNested } from 'class-validator';

export class ResidentDto {
  @Transform(({value}) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1,160, {message:'Укажите ФИО жильца (до 160 символов).'}) fullName!: string;
  @IsString() @Length(8,30, {message:'Укажите телефон в международном формате.'}) phone!: string;
  @IsOptional() @IsString() @Length(0,2000, {message:'Заметка: максимум 2000 символов.'}) note?: string;
  // Local relative references only; uploading photos is outside M2.
  @IsOptional() @IsString() @Matches(/^\/uploads\/[a-zA-Z0-9/_-]+\.(jpg|jpeg|png|webp)$/, {message:'Некорректный путь фотографии.'}) @Length(1,500) photoUrl?: string;
}
export class CheckInDto {
  @IsOptional() @IsUUID('4', {message:'Выберите жильца.'}) residentId?: string;
  @IsOptional() @ValidateNested() @Type(() => ResidentDto) resident?: ResidentDto;
  @IsUUID('4', {message:'Выберите свободное место.'}) bedId!: string;
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/, {message:'Укажите дату заселения.'}) moveInDate!: string;
  @IsString() @Matches(/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/, {message:'Месячная цена должна быть неотрицательной суммой, до двух знаков после точки.'}) monthlyPrice!: string;
  @IsInt() @Min(1, {message:'День оплаты: от 1 до 31.'}) @Max(31, {message:'День оплаты: от 1 до 31.'}) paymentDay!: number;
  @IsString() @Matches(/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/, {message:'Депозит должен быть неотрицательной суммой, до двух знаков после точки.'}) depositAmount!: string;
}
export class TransferDto {
  @IsUUID('4', {message:'Выберите свободное место.'}) bedId!: string;
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/, {message:'Укажите дату переселения.'}) transferDate!: string;
}
export class CheckOutDto {
  @IsString() @Matches(/^\d{4}-\d{2}-\d{2}$/, {message:'Укажите дату выселения.'}) moveOutDate!: string;
}
