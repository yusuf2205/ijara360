import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Length, Max, Min, ValidateNested, IsUUID } from 'class-validator';

export class LoginDto {
  @IsString() @Length(8, 30) phone!: string;
  @IsString() @Length(1, 128) password!: string;
  // Remembered devices keep the session for 30 days instead of 24 hours.
  @IsOptional() @IsBoolean() remember?: boolean;
  // Apps receive a bearer token in the body; browsers get the httpOnly cookie.
  @IsOptional() @IsIn(['WEB','ANDROID','IOS','WINDOWS']) platform?: 'WEB'|'ANDROID'|'IOS'|'WINDOWS';
  @IsOptional() @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 120) deviceName?: string;
  // Apps send back the device token they received after their first login; browsers keep it in a cookie.
  @IsOptional() @IsString() @Length(32, 100) deviceToken?: string;
}
export class RoomDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toUpperCase() : value)
  @IsString() @Length(1, 20) number!: string;
  @IsInt() @Min(1) @Max(100) capacity!: number;
  @IsOptional() @IsInt() @Min(0) @Max(100) bedCount?: number;
}
export class UpdateRoomDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toUpperCase() : value)
  @IsString() @Length(1, 20) number!: string;
  @IsInt() @Min(1) @Max(100) capacity!: number;
  @IsInt() @Min(1) version!: number;
}
export class BedDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim().toUpperCase() : value)
  @IsString() @Length(1, 20) number!: string;
}
export class RoomVersionDto { @IsInt() @Min(1) version!: number; }
export class RoomArchiveDto extends RoomVersionDto { @IsBoolean() archived!: boolean; }
export class SetupDto {
  @IsString() @Length(8, 30) phone!: string;
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 160) fullName!: string;
  @IsString() @Length(8, 128, { message: 'Пароль: от 8 до 128 символов.' }) password!: string;
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 120) propertyName!: string;
  @IsOptional() @IsString() @Length(0, 500) address?: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(30)
  @ValidateNested({ each: true }) @Type(() => RoomDto) rooms!: RoomDto[];
}
export class AdminDto {
  @IsString() @Length(8, 30) phone!: string;
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 160) fullName!: string;
  @IsString() @Length(8, 128, { message: 'Пароль: от 8 до 128 символов.' }) password!: string;
}
export class AdminActiveDto { @IsBoolean() active!: boolean; }
export class StaffEditDto {
  @IsOptional() @IsString() @Length(8, 30) phone?: string;
  @IsOptional() @Transform(({ value }) => typeof value === 'string' ? value.trim() : value) @IsString() @Length(1, 160) fullName?: string;
}
export class StaffPasswordDto {
  @IsString() @Length(8, 128, { message: 'Пароль: от 8 до 128 символов.' }) password!: string;
}
export class MakeOwnerDto { @IsBoolean() confirm!: boolean; }
export class PasswordDto {
  @IsString() @Length(1, 128) currentPassword!: string;
  @IsString() @Length(8, 128, { message: 'Новый пароль: от 8 до 128 символов.' }) newPassword!: string;
}
export class PropertyDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 120) name!: string;
  @IsOptional() @IsString() @Length(0, 500) address?: string;
}

export class LoginApprovalDto {
  @IsUUID('4') id!: string;
  @IsString() @Length(32, 100) pollToken!: string;
  @IsOptional() @IsString() @Length(32, 100) deviceToken?: string;
}
