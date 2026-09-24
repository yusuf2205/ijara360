import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsInt, IsOptional, IsString, Length, Max, Min, ValidateNested } from 'class-validator';

export class LoginDto {
  @IsString() @Length(8, 30) phone!: string;
  @IsString() @Length(1, 128) password!: string;
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
export class SetupDto {
  @IsString() @Length(8, 30) phone!: string;
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 160) fullName!: string;
  @IsString() @Length(15, 128) password!: string;
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
  @IsString() @Length(15, 128) password!: string;
}
export class AdminActiveDto { @IsBoolean() active!: boolean; }
export class PasswordDto {
  @IsString() @Length(1, 128) currentPassword!: string;
  @IsString() @Length(15, 128) newPassword!: string;
}
export class PropertyDto {
  @Transform(({ value }) => typeof value === 'string' ? value.trim() : value)
  @IsString() @Length(1, 120) name!: string;
  @IsOptional() @IsString() @Length(0, 500) address?: string;
}
