import {ConflictException,ForbiddenException,Injectable,NotFoundException,ServiceUnavailableException,UnauthorizedException,UnprocessableEntityException} from '@nestjs/common';
import {DocumentKind,Prisma,RentalApplication} from '@prisma/client';
import {randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {Actor,AuthService} from './auth';
import {Database} from './database';
import {PermissionService} from './permissions';
import {PermissionCode} from './permission-policy';
import {PrivateStorage} from './private-storage';
import {ApplicationEvents} from './application-events';
import {ApplicationProfile,ConvertDto,DraftDto,ReviewDto,StartApplicationDto,conversionCheckIn,validateProfile} from './applications.dto';
import {digest,makeToken,normalizePhone} from './security';
import {ResidentsService} from './residents';

const documentSelect={id:true,kind:true,width:true,height:true,size:true,createdAt:true} as const;
const mutable=(a:RentalApplication)=>{if(!['DRAFT','NEEDS_INFO'].includes(a.status))throw new ConflictException('Заявка уже отправлена. Дождитесь рассмотрения.');};
const version=(a:RentalApplication,v:number)=>{if(a.version!==v)throw new ConflictException('Заявка уже была изменена. Откройте её заново.');};
@Injectable()
export class ApplicationService {
  constructor(private readonly db:Database,private readonly storage:PrivateStorage,private readonly permissions:PermissionService,private readonly events:ApplicationEvents,private readonly residents:ResidentsService,private readonly auth:AuthService){}
  profile(a:RentalApplication){return this.storage.open<ApplicationProfile>(a.profileCipher,`application:${a.id}`);}
  async config(){
    const property=process.env.APPLICATION_PROPERTY_ID?await this.db.property.findFirst({where:{id:process.env.APPLICATION_PROPERTY_ID,active:true}}):await this.db.property.findFirst({where:{active:true},orderBy:{createdAt:'asc'}});
    return {enabled:Boolean(property&&this.storage.ready()),propertyName:property?.name||'Ijara360',phoneProvider:process.env.TELEGRAM_BOT_TOKEN&&process.env.TELEGRAM_BOT_USERNAME?'TELEGRAM':'NOT_CONFIGURED'};
  }
  async session(raw:unknown){
    if(typeof raw!=='string'||raw.length>200)throw new UnauthorizedException('Откройте свою анкету или начните новую.');
    const session=await this.db.applicantSession.findUnique({where:{tokenHash:digest(raw)},include:{application:{include:{property:{select:{active:true}}}}}});
    if(!session||session.expiresAt<=new Date()||!session.application.property.active)throw new UnauthorizedException('Срок доступа к анкете истёк. Обратитесь к администрации.');
    return session.application;
  }
  async locked<T>(a:RentalApplication,work:(tx:Prisma.TransactionClient,current:RentalApplication)=>Promise<T>){
    return this.db.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM properties WHERE id=${a.propertyId}::uuid FOR UPDATE`;
      const current=await tx.rentalApplication.findFirst({where:{id:a.id,propertyId:a.propertyId,property:{active:true}}});
      if(!current)throw new NotFoundException('Заявка не найдена.');
      return work(tx,current);
    },{maxWait:10000,timeout:20000});
  }
  async audit(tx:Prisma.TransactionClient,a:RentalApplication,action:string,actorId:string|null=null,metadata:Prisma.InputJsonObject={}){
    await tx.auditLog.create({data:{propertyId:a.propertyId,actorId,action,entity:'Application',entityId:a.id,metadata}});
  }
  async event(a:RentalApplication,type:string){await this.events.emit(a.propertyId,`application.${type}`,a.id);}
  async start(dto:StartApplicationDto,ip:string){
    if(!(await this.config()).enabled)throw new ServiceUnavailableException('Приём заявок ещё не настроен.');
    await this.auth.rateLimit('application-start-ip',ip,10);
    const phone=normalizePhone(dto.phone);await this.auth.rateLimit('application-start-phone',this.storage.hash(phone),3);
    const property=process.env.APPLICATION_PROPERTY_ID?await this.db.property.findFirstOrThrow({where:{id:process.env.APPLICATION_PROPERTY_ID,active:true}}):await this.db.property.findFirstOrThrow({where:{active:true},orderBy:{createdAt:'asc'}});
    const token=makeToken();const id=randomUUID();const expiresAt=new Date(Date.now()+30*86400000);
    const app=await this.db.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM properties WHERE id=${property.id}::uuid FOR UPDATE`;
      const a=await tx.rentalApplication.create({data:{id,propertyId:property.id,channel:dto.channel,phoneHash:this.storage.hash(phone),profileCipher:this.storage.seal({phone},`application:${id}`)}});
      await tx.applicantSession.create({data:{applicationId:id,tokenHash:digest(token),expiresAt}});
      await tx.applicationStatusHistory.create({data:{applicationId:id,toStatus:'DRAFT'}});
      await this.audit(tx,a,'APPLICATION_CREATED');return a;
    });
    await this.event(app,'created');return {token,expiresAt};
  }
  async own(a:RentalApplication){
    const current=await this.db.rentalApplication.findUniqueOrThrow({where:{id:a.id},include:{documents:{select:documentSelect}}});
    return {id:current.id,status:current.status,version:current.version,profile:this.profile(current),phoneVerified:Boolean(current.phoneVerifiedAt),documents:current.documents,feedback:current.feedbackCipher?this.storage.open(current.feedbackCipher,`feedback:${current.id}`):null};
  }
  async save(a:RentalApplication,dto:DraftDto){
    const updated=await this.locked(a,async(tx,current)=>{
      mutable(current);version(current,dto.version);
      const {version:_,...patch}=dto;
      const profile={...this.profile(current),...patch};
      const next=await tx.rentalApplication.update({where:{id:a.id},data:{profileCipher:this.storage.seal(profile,`application:${a.id}`),pinflHash:profile.pinfl?this.storage.hash(`pinfl:${profile.pinfl}`):null,passportHash:profile.passportSeries&&profile.passportNumber?this.storage.hash(`passport:${profile.passportSeries.toUpperCase()}${profile.passportNumber}`):null,version:{increment:1}}});
      await this.audit(tx,current,'APPLICATION_UPDATED');return next;
    });
    await this.event(updated,'updated');return this.own(updated);
  }
  async upload(a:RentalApplication,kind:DocumentKind,data:Buffer){
    mutable(a);if(!a.phoneVerifiedAt)throw new ForbiddenException('Сначала подтвердите телефон.');
    await this.auth.rateLimit('application-upload',a.id,30);
    const dimensions=await this.storage.image(data,kind==='FACE');
    const hash=this.storage.hash(data.toString('base64'));
    const result=await this.locked(a,async(tx,current)=>{
      mutable(current);if(!current.phoneVerifiedAt)throw new ForbiddenException('Сначала подтвердите телефон.');
      const old=await tx.applicationDocument.findUnique({where:{applicationId_kind:{applicationId:a.id,kind}}});
      if(old?.contentHash===hash)return old;
      const storageKey=await this.storage.put(a.id,kind,data);
      const doc=await tx.applicationDocument.upsert({where:{applicationId_kind:{applicationId:a.id,kind}},create:{applicationId:a.id,kind,storageKey,contentHash:hash,size:data.length,...dimensions},update:{storageKey,contentHash:hash,size:data.length,...dimensions,createdAt:new Date()}});
      if(kind==='FACE')await tx.biometricEnrollmentSource.upsert({where:{applicationId:a.id},create:{applicationId:a.id,documentId:doc.id},update:{documentId:doc.id,qualityReview:'MANUAL_REQUIRED'}});
      await tx.rentalApplication.update({where:{id:a.id},data:{version:{increment:1}}});
      await this.audit(tx,current,'APPLICATION_DOCUMENT_UPLOADED',null,{kind,documentId:doc.id});return doc;
    });
    await this.event(a,'updated');return {id:result.id,kind:result.kind};
  }
  async submit(a:RentalApplication,v:number){
    const updated=await this.locked(a,async(tx,current)=>{
      mutable(current);version(current,v);if(!current.phoneVerifiedAt)throw new UnprocessableEntityException('Подтвердите телефон через Telegram.');
      validateProfile(this.profile(current));
      const docs=await tx.applicationDocument.findMany({where:{applicationId:a.id}});
      if(!['PASSPORT_FRONT','PASSPORT_BACK','FACE'].every(k=>docs.some(d=>d.kind===k)))throw new UnprocessableEntityException('Загрузите обе стороны паспорта и фотографию лица.');
      const duplicate=await tx.rentalApplication.findFirst({where:{id:{not:a.id},propertyId:a.propertyId,phoneHash:current.phoneHash,status:{in:['SUBMITTED','UNDER_REVIEW','NEEDS_INFO','APPROVED']}}});
      if(duplicate)throw new ConflictException('На этот телефон уже подана заявка. Обратитесь к администрации.');
      await tx.applicationStatusHistory.create({data:{applicationId:a.id,fromStatus:current.status,toStatus:'SUBMITTED'}});
      const next=await tx.rentalApplication.update({where:{id:a.id},data:{status:'SUBMITTED',submittedAt:new Date(),version:{increment:1}}});
      await this.audit(tx,current,'APPLICATION_SUBMITTED');return next;
    });await this.event(updated,'submitted');return this.own(updated);
  }
  async cancel(a:RentalApplication,v:number){
    const updated=await this.locked(a,async(tx,current)=>{
      version(current,v);if(!['DRAFT','SUBMITTED','UNDER_REVIEW','NEEDS_INFO'].includes(current.status))throw new ConflictException('Эту заявку уже нельзя отменить.');
      await tx.applicationStatusHistory.create({data:{applicationId:a.id,fromStatus:current.status,toStatus:'CANCELLED'}});
      await this.audit(tx,current,'APPLICATION_CANCELLED');return tx.rentalApplication.update({where:{id:a.id},data:{status:'CANCELLED',version:{increment:1}}});
    });await this.event(updated,'updated');return this.own(updated);
  }
  async staffApp(actor:Actor,id:string,permission:PermissionCode='APPLICATION_VIEW'){
    await this.permissions.require(actor,permission);
    const a=await this.db.rentalApplication.findFirst({where:{id,propertyId:actor.propertyId}});
    if(!a)throw new NotFoundException('Заявка не найдена.');return a;
  }
  async list(actor:Actor,status='SUBMITTED',page=1,onlyToday=false){
    await this.permissions.require(actor,'APPLICATION_VIEW');
    if(!['SUBMITTED','UNDER_REVIEW','NEEDS_INFO','APPROVED','REJECTED','CANCELLED','CONVERTED_TO_RESIDENT'].includes(status)||!Number.isInteger(page)||page<1||page>10000)throw new UnprocessableEntityException('Некорректный фильтр заявок.');
    const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tashkent',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const since=new Date(`${today}T00:00:00+05:00`);
    // "Approved today" counts approvals since midnight Tashkent, including ones already converted.
    const where:Prisma.RentalApplicationWhereInput=onlyToday&&status==='APPROVED'?{propertyId:actor.propertyId,approvedAt:{gte:since}}:{propertyId:actor.propertyId,status:status as RentalApplication['status']};
    const [items,total,counts]=await Promise.all([this.db.rentalApplication.findMany({where,orderBy:[{createdAt:'desc'},{id:'desc'}],take:30,skip:(page-1)*30}),this.db.rentalApplication.count({where}),this.db.rentalApplication.groupBy({by:['status'],where:{propertyId:actor.propertyId},_count:true})]);
    const approvedToday=await this.db.rentalApplication.count({where:{propertyId:actor.propertyId,approvedAt:{gte:since}}});
    return {items:items.map(a=>{const p=this.profile(a);return {id:a.id,status:a.status,version:a.version,fullName:p.fullName,phone:p.phone,occupationType:p.occupationType,organization:p.organization,requestedMoveInDate:p.requestedMoveInDate,submittedAt:a.submittedAt};}),total,page,counts:Object.fromEntries(counts.map(c=>[c.status,c._count])),approvedToday};
  }
  async duplicates(tx:Prisma.TransactionClient,a:RentalApplication){
    const OR:Prisma.RentalApplicationWhereInput[]=[{phoneHash:a.phoneHash}];if(a.pinflHash)OR.push({pinflHash:a.pinflHash});if(a.passportHash)OR.push({passportHash:a.passportHash});
    const apps=await tx.rentalApplication.findMany({where:{propertyId:a.propertyId,id:{not:a.id},phoneVerifiedAt:{not:null},OR},select:{id:true,status:true},take:20});
    const resident=await tx.resident.findUnique({where:{propertyId_phone:{propertyId:a.propertyId,phone:this.profile(a).phone}},select:{id:true,fullName:true}});
    return {applications:apps,resident};
  }
  async detail(actor:Actor,id:string){
    const a=await this.staffApp(actor,id);
    return this.locked(a,async(tx,current)=>{
      const rights=await this.permissions.require(actor,'APPLICATION_VIEW',tx);const p=this.profile(current);
      const basic=rights.includes('KYC_VIEW_BASIC');const passport=rights.includes('KYC_VIEW_PASSPORT');
      if(basic||passport)await this.audit(tx,current,'APPLICATION_VIEWED_SENSITIVE_DATA',actor.id,{sections:[...(basic?['basic']:[]),...(passport?['passport']:[])]});
      const documents=await tx.applicationDocument.findMany({where:{applicationId:id},select:documentSelect});
      return {id,status:current.status,version:current.version,phoneVerified:Boolean(current.phoneVerifiedAt),fullName:p.fullName,phone:p.phone,profile:{occupationType:p.occupationType,organization:p.organization,requestedMoveInDate:p.requestedMoveInDate,plannedDuration:p.plannedDuration,...(basic?{dateOfBirth:p.dateOfBirth,faculty:p.faculty,course:p.course,position:p.position,comment:p.comment,emergencyName:p.emergencyName,emergencyRelationship:p.emergencyRelationship,emergencyPhone:p.emergencyPhone}:{}),...(passport?{pinfl:p.pinfl,passportSeries:p.passportSeries,passportNumber:p.passportNumber}:{})},documents:documents.filter(d=>d.kind==='FACE'?rights.includes('KYC_VIEW_BIOMETRIC_SOURCE'):rights.includes('KYC_VIEW_DOCUMENTS')&&rights.includes('KYC_VIEW_PASSPORT')),duplicates:await this.duplicates(tx,current),feedback:current.feedbackCipher?this.storage.open(current.feedbackCipher,`feedback:${id}`):null,history:await tx.applicationStatusHistory.findMany({where:{applicationId:id},orderBy:{createdAt:'asc'},select:{fromStatus:true,toStatus:true,createdAt:true}}),residentId:current.residentId};
    });
  }
  async review(actor:Actor,id:string,dto:ReviewDto){
    const a=await this.staffApp(actor,id);const required:PermissionCode=dto.status==='APPROVED'?'APPLICATION_APPROVE':dto.status==='REJECTED'?'APPLICATION_REJECT':'APPLICATION_REVIEW';
    const updated=await this.locked(a,async(tx,current)=>{
      await this.permissions.require(actor,'APPLICATION_VIEW',tx);await this.permissions.require(actor,required,tx);version(current,dto.version);
      if(dto.status==='UNDER_REVIEW'?current.status!=='SUBMITTED':current.status!=='UNDER_REVIEW')throw new ConflictException('Заявка уже была обработана. Обновите карточку.');
      if(['REJECTED','NEEDS_INFO'].includes(dto.status)&&!dto.reason?.trim())throw new UnprocessableEntityException('Укажите причину или комментарий для заявителя.');
      if(dto.status==='NEEDS_INFO'&&!dto.requiredFields?.trim())throw new UnprocessableEntityException('Укажите, какие данные необходимо дополнить.');
      if(dto.status==='APPROVED'){
        for(const permission of ['KYC_VIEW_BASIC','KYC_VIEW_DOCUMENTS','KYC_VIEW_PASSPORT','KYC_VIEW_BIOMETRIC_SOURCE'] as PermissionCode[])await this.permissions.require(actor,permission,tx);
        if(!dto.identityReviewed||!dto.documentsReviewed||!dto.faceQualityConfirmed)throw new UnprocessableEntityException('Подтвердите ручную проверку анкеты, документов и качества фото лица.');
        const matches=await this.duplicates(tx,current);if((matches.applications.length||matches.resident)&&!dto.duplicateReview?.trim())throw new ConflictException('Найден возможный существующий человек. Проверьте совпадения и укажите результат проверки.');
        await tx.biometricEnrollmentSource.update({where:{applicationId:id},data:{qualityReview:'MANUALLY_ACCEPTED'}});
      }
      const action={UNDER_REVIEW:'APPLICATION_REVIEW_STARTED',NEEDS_INFO:'APPLICATION_INFO_REQUESTED',APPROVED:'APPLICATION_APPROVED',REJECTED:'APPLICATION_REJECTED'}[dto.status];
      await tx.applicationStatusHistory.create({data:{applicationId:id,actorId:actor.id,fromStatus:current.status,toStatus:dto.status}});
      await this.audit(tx,current,action,actor.id);
      return tx.rentalApplication.update({where:{id},data:{status:dto.status,version:{increment:1},...(dto.reason?{feedbackCipher:this.storage.seal({reason:dto.reason,requiredFields:dto.requiredFields},`feedback:${id}`)}:{}),...(dto.duplicateReview?{duplicateReviewCipher:this.storage.seal(dto.duplicateReview,`duplicate:${id}`)}:{}),...(dto.status==='APPROVED'?{approvedAt:new Date()}:{}),...(dto.status==='REJECTED'?{rejectedAt:new Date()}: {})}});
    });
    const event={UNDER_REVIEW:'review_started',NEEDS_INFO:'needs_info',APPROVED:'approved',REJECTED:'rejected'}[dto.status];await this.event(updated,event);return {id,status:updated.status,version:updated.version};
  }
  async convert(actor:Actor,id:string,dto:ConvertDto){
    const a=await this.staffApp(actor,id);const result=await this.locked(a,async(tx,current)=>{
      await this.permissions.require(actor,'APPLICATION_VIEW',tx);await this.permissions.require(actor,'RESIDENT_CREATE_FROM_APPLICATION',tx);version(current,dto.version);
      if(current.status!=='APPROVED')throw new ConflictException('Заселить можно только одобренную заявку.');
      const matches=await this.duplicates(tx,current);
      if(matches.applications.length&&!current.duplicateReviewCipher)throw new ConflictException('Появились возможные совпадения. Требуется проверка администрации.');
      if(matches.resident?.id!==dto.existingResidentId&&(matches.resident||dto.existingResidentId))throw new ConflictException('Подтвердите использование найденного жильца. Автоматическое объединение запрещено.');
      const occupancy=await this.residents.checkInTransaction(tx,actor,conversionCheckIn(dto,matches.resident?.id,this.profile(current)));
      await tx.rentalApplication.update({where:{id},data:{status:'CONVERTED_TO_RESIDENT',residentId:occupancy.residentId,occupancyId:occupancy.id,convertedAt:new Date(),version:{increment:1}}});
      await tx.applicationStatusHistory.create({data:{applicationId:id,actorId:actor.id,fromStatus:'APPROVED',toStatus:'CONVERTED_TO_RESIDENT'}});
      await this.audit(tx,current,'APPLICATION_CONVERTED_TO_RESIDENT',actor.id,{residentId:occupancy.residentId,occupancyId:occupancy.id});return {residentId:occupancy.residentId,occupancyId:occupancy.id};
    });await this.event(a,'converted');return result;
  }
  async document(a:RentalApplication,kind:DocumentKind,actor?:Actor){
    const doc=await this.locked(a,async(tx,current)=>{
      if(actor){await this.permissions.require(actor,'APPLICATION_VIEW',tx);await this.permissions.require(actor,kind==='FACE'?'KYC_VIEW_BIOMETRIC_SOURCE':'KYC_VIEW_DOCUMENTS',tx);if(kind!=='FACE')await this.permissions.require(actor,'KYC_VIEW_PASSPORT',tx);}
      const d=await tx.applicationDocument.findUnique({where:{applicationId_kind:{applicationId:a.id,kind}}});if(!d)throw new NotFoundException('Документ не найден.');
      await this.audit(tx,current,kind==='FACE'?'BIOMETRIC_SOURCE_VIEWED':'DOCUMENT_VIEWED',actor?.id||null,{documentId:d.id,kind});return d;
    });
    const bytes=await this.storage.get(doc.storageKey);
    // Originals stay encrypted; render sanitized pixels without EXIF/embedded metadata.
    try{return await sharp(bytes,{limitInputPixels:24000000}).rotate().resize({width:1600,height:1600,fit:'inside',withoutEnlargement:true}).jpeg({quality:90}).toBuffer();}catch{throw new ServiceUnavailableException('Не удалось открыть изображение.');}
  }
}
