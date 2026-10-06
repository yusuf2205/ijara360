import {IsBoolean,IsIn,IsInt,IsOptional,IsString,IsUUID,Length,Max,Min} from 'class-validator';
import {UnprocessableEntityException} from '@nestjs/common';
import {CheckInDto} from './residents.dto';

export class StartApplicationDto {
  @IsString() @Length(8,30) phone!:string;
  @IsIn(['WEB','TELEGRAM']) channel!:'WEB'|'TELEGRAM';
}
export class ApplicationVersionDto { @IsInt() @Min(1) version!:number; }
export class DraftDto extends ApplicationVersionDto {
  @IsOptional() @IsString() @Length(0,160) fullName?:string;
  @IsOptional() @IsString() @Length(0,10) dateOfBirth?:string;
  @IsOptional() @IsString() @Length(0,14) pinfl?:string;
  @IsOptional() @IsString() @Length(0,2) passportSeries?:string;
  @IsOptional() @IsString() @Length(0,7) passportNumber?:string;
  @IsOptional() @IsIn(['STUDENT','WORKER','OTHER']) occupationType?:'STUDENT'|'WORKER'|'OTHER';
  @IsOptional() @IsString() @Length(0,200) organization?:string;
  @IsOptional() @IsString() @Length(0,160) faculty?:string;
  @IsOptional() @IsString() @Length(0,2) course?:string;
  @IsOptional() @IsString() @Length(0,160) position?:string;
  @IsOptional() @IsString() @Length(0,10) requestedMoveInDate?:string;
  @IsOptional() @IsString() @Length(0,120) plannedDuration?:string;
  @IsOptional() @IsString() @Length(0,2000) comment?:string;
  @IsOptional() @IsString() @Length(0,160) emergencyName?:string;
  @IsOptional() @IsString() @Length(0,80) emergencyRelationship?:string;
  @IsOptional() @IsString() @Length(0,30) emergencyPhone?:string;
  @IsOptional() @IsBoolean() consent?:boolean;
}
export type ApplicationProfile = Omit<DraftDto,'version'> & {phone:string};
export class ReviewDto extends ApplicationVersionDto {
  @IsIn(['UNDER_REVIEW','NEEDS_INFO','APPROVED','REJECTED']) status!:'UNDER_REVIEW'|'NEEDS_INFO'|'APPROVED'|'REJECTED';
  @IsOptional() @IsString() @Length(1,2000) reason?:string;
  @IsOptional() @IsString() @Length(1,2000) requiredFields?:string;
  @IsOptional() @IsBoolean() identityReviewed?:boolean;
  @IsOptional() @IsBoolean() documentsReviewed?:boolean;
  @IsOptional() @IsBoolean() faceQualityConfirmed?:boolean;
  @IsOptional() @IsString() @Length(1,2000) duplicateReview?:string;
}
export class ConvertDto extends ApplicationVersionDto {
  @IsUUID() bedId!:string;
  @IsString() @Length(10,10) moveInDate!:string;
  @IsString() @Length(1,20) monthlyPrice!:string;
  @IsInt() @Min(1) @Max(31) paymentDay!:number;
  @IsString() @Length(1,20) depositAmount!:string;
  @IsOptional() @IsUUID() existingResidentId?:string;
}
export function validateProfile(profile:ApplicationProfile){
  const p=profile;
  const date=(s:string|undefined)=> Boolean(s&&/^\d{4}-\d{2}-\d{2}$/.test(s)&&Number.isFinite(Date.parse(s))&&new Date(s).toISOString().slice(0,10)===s);
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tashkent',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  if(!p.fullName?.trim()||!date(p.dateOfBirth)||p.dateOfBirth!<'1900-01-01'||p.dateOfBirth!>=today||!/^\d{14}$/.test(p.pinfl||'')||! /^[A-Z]{2}$/.test(p.passportSeries||'')||!/^\d{7}$/.test(p.passportNumber||''))throw new UnprocessableEntityException('Проверьте ФИО, дату рождения, ПИНФЛ (14 цифр) и паспорт (2 латинские буквы и 7 цифр).');
  if(!p.occupationType||p.occupationType!=='OTHER'&&!p.organization?.trim())throw new UnprocessableEntityException('Укажите место учёбы или работы.');
  if(p.course&&!/^([1-9]|1[0-2])$/.test(p.course))throw new UnprocessableEntityException('Проверьте курс обучения.');
  if(!date(p.requestedMoveInDate)||!p.plannedDuration?.trim()||!p.emergencyName?.trim()||!p.emergencyRelationship?.trim()||!/^\+[1-9]\d{7,14}$/.test(p.emergencyPhone||''))throw new UnprocessableEntityException('Заполните срок проживания и контакт для экстренной связи.');
  if(!p.consent)throw new UnprocessableEntityException('Подтвердите согласие на обработку анкеты и документов.');
}
export function conversionCheckIn(dto:ConvertDto,residentId?:string,profile?:ApplicationProfile):CheckInDto {
  if(!/^(0|[1-9]\d{0,11})(\.\d{1,2})?$/.test(dto.monthlyPrice)||! /^(0|[1-9]\d{0,11})(\.\d{1,2})?$/.test(dto.depositAmount))throw new UnprocessableEntityException('Укажите корректные суммы аренды и депозита.');
  return {bedId:dto.bedId,moveInDate:dto.moveInDate,monthlyPrice:dto.monthlyPrice,paymentDay:dto.paymentDay,depositAmount:dto.depositAmount,...(residentId?{residentId}:{resident:{fullName:profile!.fullName!,phone:profile!.phone}})};
}
