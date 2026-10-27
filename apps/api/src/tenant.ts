import {Body,CanActivate,ConflictException,Controller,Delete,ExecutionContext,ForbiddenException,Get,GoneException,HttpCode,Injectable,Module,NotFoundException,Param,ParseUUIDPipe,Patch,Post,Req,Res,UnauthorizedException,UseGuards} from '@nestjs/common';
import {Prisma} from '@prisma/client';
import {Transform} from 'class-transformer';
import {IsBoolean,IsIn,IsOptional,IsString,IsUUID,Length} from 'class-validator';
import {Request,Response} from 'express';
import {Actor,AuthModule,AuthRequest,AuthService,SessionGuard,deviceLabel} from './auth';
import {Database} from './database';
import {requireAccess} from './permission-policy';
import {digest,hashPassword,makeToken,normalizePhone,safeTokenEqual,verifyPassword} from './security';
import {TelegramModule,TelegramService} from './telegram';
import {TenantTelegramService} from './tenant-telegram';

const DAY=86400000;
const INVITE_TTL=2*DAY;
export type Tenant={accountId:string;residentId:string;propertyId:string};
export type TenantRequest=Request&{tenant:Tenant;tenantSessionId:string};

class InviteTokenDto{@IsString() @Length(32,100) token!:string;}
class AcceptInviteDto extends InviteTokenDto{@IsString() @Length(8,128,{message:'Пароль: от 8 до 128 символов.'}) password!:string;}
class InviteDto{@IsOptional() @IsIn(['AUTO','LINK']) channel?:'AUTO'|'LINK';}
class AccountActiveDto{@IsBoolean() active!:boolean;}
class TenantLoginDto{
  @IsString() @Length(8,30) phone!:string;
  @IsString() @Length(1,128) password!:string;
  @IsOptional() @IsBoolean() remember?:boolean;
  @IsOptional() @IsIn(['WEB','ANDROID','IOS','WINDOWS']) platform?:'WEB'|'ANDROID'|'IOS'|'WINDOWS';
  @IsOptional() @Transform(({value})=>typeof value==='string'?value.trim():value) @IsString() @Length(1,120) deviceName?:string;
  @IsOptional() @IsString() @Length(32,100) deviceToken?:string;
}
class TenantApprovalDto{
  @IsUUID('4') id!:string;
  @IsString() @Length(32,100) pollToken!:string;
  @IsOptional() @IsString() @Length(32,100) deviceToken?:string;
}
type Issued={token:string;accountId:string;channel:'TELEGRAM'|'LINK';expiresAt:Date;telegramUserId:string|null};
const sessionSelect={id:true,deviceName:true,platform:true,remembered:true,createdAt:true,lastSeenAt:true,expiresAt:true} as const;

function tenantToken(req:Request):string|undefined{
  const cookie=req.cookies?.ijara_tenant;if(typeof cookie==='string')return cookie;
  const h=req.headers.authorization;return typeof h==='string'&&h.startsWith('Bearer ')?h.slice(7).trim():undefined;
}
function tenantDeviceToken(req:Request,bodyToken?:string):string|undefined{
  const c=req.cookies?.ijara_tenant_device;if(typeof c==='string'&&c)return c;
  return bodyToken;
}
function tenantSession(r:{token:string;deviceToken:string|null;expiresAt:Date;platform:string},res:Response){
  const secure=process.env.COOKIE_SECURE!=='false';
  if(r.platform!=='WEB')return {token:r.token,deviceToken:r.deviceToken,expiresAt:r.expiresAt};
  res.cookie('ijara_tenant',r.token,{httpOnly:true,secure,sameSite:'strict',path:'/api/tenant',expires:r.expiresAt});
  if(r.deviceToken)res.cookie('ijara_tenant_device',r.deviceToken,{httpOnly:true,secure,sameSite:'strict',path:'/api/tenant',expires:new Date(Date.now()+400*DAY)});
  return {expiresAt:r.expiresAt};
}

@Injectable()
export class TenantAccountsService {
  constructor(private readonly db:Database,private readonly telegram:TelegramService,private readonly auth:AuthService,private readonly tenantTelegram:TenantTelegramService){}
  link(token:string){return `${this.telegram.origin()}/invite#${token}`;}
  /**
   * Creates or re-activates the resident's account and a fresh one-time invite inside the caller's transaction.
   * Returns null when the phone already belongs to another tenant account (never merged automatically).
   */
  async issue(tx:Prisma.TransactionClient,p:{propertyId:string;residentId:string;phone:string;telegramUserId?:string|null;createdById:string|null;forceLink?:boolean}):Promise<Issued|null>{
    const clash=await tx.tenantAccount.findUnique({where:{phone:p.phone}});
    if(clash&&clash.residentId!==p.residentId)return null;
    const account=await tx.tenantAccount.upsert({where:{residentId:p.residentId},
      create:{propertyId:p.propertyId,residentId:p.residentId,phone:p.phone,telegramUserId:p.telegramUserId??null},
      update:{phone:p.phone,active:true,...(p.telegramUserId?{telegramUserId:p.telegramUserId}:{})}});
    await tx.tenantInvite.updateMany({where:{accountId:account.id,consumedAt:null},data:{consumedAt:new Date()}});
    const token=makeToken();const expiresAt=new Date(Date.now()+INVITE_TTL);
    const channel=account.telegramUserId&&!p.forceLink?'TELEGRAM':'LINK';
    await tx.tenantInvite.create({data:{accountId:account.id,tokenHash:digest(token),channel,createdById:p.createdById,expiresAt}});
    await tx.auditLog.create({data:{propertyId:p.propertyId,actorId:p.createdById,action:'TENANT_INVITE_CREATED',entity:'Resident',entityId:p.residentId,metadata:{channel,accountId:account.id}}});
    return {token,accountId:account.id,channel,expiresAt,telegramUserId:account.telegramUserId};
  }
  /** Sends a Telegram invite after commit. Failure leaves the invite valid so staff can resend or share a link. */
  async deliver(issued:Issued,fullName:string,place:string){
    if(issued.channel!=='TELEGRAM'||!issued.telegramUserId)return {channel:'LINK' as const,delivered:false,link:this.link(issued.token),expiresAt:issued.expiresAt};
    try{
      await this.telegram.send(issued.telegramUserId,`Здравствуйте, ${fullName.split(' ')[0]}! Вы заселены: ${place}.\nЗадайте пароль для приложения Ijara360 по кнопке ниже. Ссылка действует 48 часов. Входить нужно по вашему номеру телефона.`,{inline_keyboard:[[{text:'Задать пароль',url:this.link(issued.token)}]]});
      return {channel:'TELEGRAM' as const,delivered:true,expiresAt:issued.expiresAt};
    }catch{return {channel:'TELEGRAM' as const,delivered:false,expiresAt:issued.expiresAt};}
  }
  private async place(tx:Prisma.TransactionClient,residentId:string){
    const o=await tx.occupancy.findFirst({where:{residentId,status:'ACTIVE'},include:{room:{select:{number:true}},bed:{select:{number:true}}}});
    return o?`комната ${o.room.number}, место ${o.bed.number}`:null;
  }
  async invite(actor:Actor,residentId:string,dto:InviteDto){
    const result=await this.db.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM properties WHERE id=${actor.propertyId}::uuid FOR UPDATE`;
      await requireAccess(tx,actor,'RESIDENTS_MANAGE');
      const r=await tx.resident.findFirst({where:{id:residentId,propertyId:actor.propertyId}});
      if(!r)throw new NotFoundException('Жилец не найден.');
      const place=await this.place(tx,r.id);
      if(!place)throw new ConflictException('Пригласить в приложение можно только жильца, который сейчас проживает.');
      const issued=await this.issue(tx,{propertyId:actor.propertyId,residentId:r.id,phone:r.phone,createdById:actor.id,forceLink:dto.channel==='LINK'});
      if(!issued)throw new ConflictException('Этот телефон уже используется другим аккаунтом жильца.');
      return {issued,fullName:r.fullName,place};
    },{maxWait:10000,timeout:15000});
    return this.deliver(result.issued,result.fullName,result.place);
  }
  async status(actor:Actor,residentId:string){
    const r=await this.db.resident.findFirst({where:{id:residentId,propertyId:actor.propertyId},include:{tenantAccount:{include:{invites:{where:{consumedAt:null,expiresAt:{gt:new Date()}},orderBy:{createdAt:'desc'},take:1},sessions:{where:{expiresAt:{gt:new Date()}},select:{lastSeenAt:true,createdAt:true}}}}}});
    if(!r)throw new NotFoundException('Жилец не найден.');
    const a=r.tenantAccount;
    if(!a)return {status:'NONE',telegramLinked:false};
    const lastSeen=a.sessions.map(s=>s.lastSeenAt||s.createdAt).sort((x,y)=>+y-+x)[0]||null;
    return {status:!a.active?'DISABLED':a.activatedAt?'ACTIVE':'INVITED',telegramLinked:Boolean(a.telegramUserId),activatedAt:a.activatedAt,lastSeenAt:lastSeen,activeSessions:a.sessions.length,pendingInviteExpiresAt:a.invites[0]?.expiresAt??null};
  }
  async setActive(actor:Actor,residentId:string,active:boolean){
    return this.db.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM properties WHERE id=${actor.propertyId}::uuid FOR UPDATE`;
      await requireAccess(tx,actor,'RESIDENTS_MANAGE');
      const a=await tx.tenantAccount.findFirst({where:{residentId,propertyId:actor.propertyId}});
      if(!a)throw new NotFoundException('У жильца нет аккаунта приложения.');
      if(active)throw new ConflictException('Чтобы снова открыть доступ, отправьте новое приглашение.');
      await tx.tenantAccount.update({where:{id:a.id},data:{active:false}});
      await tx.tenantSession.deleteMany({where:{accountId:a.id}});
      await tx.tenantInvite.updateMany({where:{accountId:a.id,consumedAt:null},data:{consumedAt:new Date()}});
      await tx.auditLog.create({data:{propertyId:actor.propertyId,actorId:actor.id,action:'TENANT_ACCOUNT_DISABLED',entity:'Resident',entityId:residentId,metadata:{accountId:a.id}}});
      return {status:'DISABLED'};
    });
  }
  private async validInvite(tx:Prisma.TransactionClient,token:string){
    const invite=await tx.tenantInvite.findUnique({where:{tokenHash:digest(token)},include:{account:{include:{resident:{include:{property:{select:{name:true,active:true}}}}}}}});
    if(!invite||invite.consumedAt||invite.expiresAt<=new Date()||!invite.account.active||!invite.account.resident.property.active)throw new GoneException('Ссылка недействительна или уже использована. Попросите администрацию прислать новую.');
    return invite;
  }
  async inspect(token:string,ip:string){
    await this.auth.rateLimit('tenant-invite-ip',ip,30);
    const invite=await this.validInvite(this.db,token);
    const phone=invite.account.phone;
    return {firstName:invite.account.resident.fullName.split(' ')[0],propertyName:invite.account.resident.property.name,phone:`${phone.slice(0,4)} ** *** ${phone.slice(-4,-2)} ${phone.slice(-2)}`,expiresAt:invite.expiresAt};
  }
  async accept(dto:AcceptInviteDto,ip:string){
    await this.auth.rateLimit('tenant-invite-ip',ip,30);
    const passwordHash=await hashPassword(dto.password);
    return this.db.$transaction(async tx=>{
      const invite=await this.validInvite(tx,dto.token);
      const consumed=await tx.tenantInvite.updateMany({where:{id:invite.id,consumedAt:null},data:{consumedAt:new Date()}});
      if(!consumed.count)throw new GoneException('Ссылка уже использована.');
      const a=invite.account;
      await tx.tenantAccount.update({where:{id:a.id},data:{passwordHash,activatedAt:a.activatedAt??new Date()}});
      // A new password ends every existing tenant session.
      await tx.tenantSession.deleteMany({where:{accountId:a.id}});
      await tx.auditLog.create({data:{propertyId:a.propertyId,actorId:null,action:a.activatedAt?'TENANT_PASSWORD_RESET':'TENANT_ACCOUNT_ACTIVATED',entity:'Resident',entityId:a.residentId,metadata:{accountId:a.id,channel:invite.channel}}});
      return {phone:a.phone};
    });
  }
  /**
   * A new device is confirmed in Telegram first (owner's decision 2026-10-27): the resident confirms in their own
   * Telegram, or an owner confirms for a resident who has none. A device confirmed once is trusted afterwards. If
   * nobody can confirm (resident has no Telegram and no owner linked one) the login goes through, so no lockout.
   */
  async login(dto:TenantLoginDto,ip:string,userAgent:string|undefined,ctx:{deviceToken?:string}){
    const phone=normalizePhone(dto.phone);
    await this.auth.rateLimit('tenant-login-ip',ip,40);
    await this.auth.rateLimit('tenant-login-phone',phone,10);
    const a=await this.db.tenantAccount.findUnique({where:{phone},include:{resident:{select:{fullName:true,property:{select:{active:true}},occupancies:{where:{status:'ACTIVE'},select:{id:true}}}}}});
    const valid=await verifyPassword(dto.password,a?.passwordHash||'scrypt$00$00');
    if(!valid||!a?.active||!a.resident.property.active||!a.resident.occupancies.length)throw new UnauthorizedException('Неверный телефон или пароль.');
    const device={platform:dto.platform??'WEB',deviceName:dto.deviceName||deviceLabel(userAgent),remembered:Boolean(dto.remember)};
    const trusted=ctx.deviceToken?await this.db.tenantTrustedDevice.findFirst({where:{tokenHash:digest(ctx.deviceToken),accountId:a.id}}):null;
    if(trusted)return this.issueSession(a.id,device,trusted.id);
    // The first device is trusted without a second step: the registration was already confirmed through the
    // Telegram invite. Every later new device is confirmed in Telegram (resident's own, or an owner's).
    const known=await this.db.tenantTrustedDevice.count({where:{accountId:a.id}});
    if(known===0)return this.issueSession(a.id,device,null);
    const approval=await this.tenantTelegram.requestApproval({id:a.id,residentId:a.residentId,propertyId:a.propertyId,telegramUserId:a.telegramUserId,fullName:a.resident.fullName},device);
    if(!approval)return this.issueSession(a.id,device,null);
    return {kind:'approval' as const,approval};
  }
  private async issueSession(accountId:string,device:{platform:string;deviceName:string;remembered:boolean},trustedId:string|null){
    const token=makeToken();const deviceToken=trustedId?null:makeToken();const now=new Date();
    const expiresAt=new Date(now.getTime()+(device.remembered?30:1)*DAY);
    await this.db.$transaction(async tx=>{
      await tx.tenantSession.create({data:{tokenHash:digest(token),accountId,expiresAt,platform:device.platform,deviceName:device.deviceName,remembered:device.remembered,lastSeenAt:now}});
      if(trustedId)await tx.tenantTrustedDevice.update({where:{id:trustedId},data:{lastUsedAt:now}});
      else{
        await tx.tenantTrustedDevice.create({data:{accountId,tokenHash:digest(deviceToken!),label:device.deviceName,platform:device.platform}});
        // Keep the 20 most recently used devices per account.
        const stale=await tx.tenantTrustedDevice.findMany({where:{accountId},orderBy:{lastUsedAt:'desc'},skip:20,select:{id:true}});
        if(stale.length)await tx.tenantTrustedDevice.deleteMany({where:{id:{in:stale.map(d=>d.id)}}});
      }
      await tx.tenantSession.deleteMany({where:{expiresAt:{lt:now}}});
    });
    return {kind:'session' as const,token,deviceToken,expiresAt,platform:device.platform};
  }
  /** The app or browser polls until the Telegram button is pressed; an approved request yields exactly one session. */
  async completeApproval(dto:TenantApprovalDto,ctx:{deviceToken?:string}){
    await this.auth.rateLimit('tenant-login-approval',dto.id,200);
    const a=await this.db.tenantLoginApproval.findUnique({where:{id:dto.id}});
    if(!a||!safeTokenEqual(digest(dto.pollToken),a.pollTokenHash))throw new NotFoundException('Запрос на вход не найден.');
    if(a.status==='DENIED')throw new ForbiddenException('Вход отклонён.');
    if(a.status==='USED'||(a.status==='PENDING'&&a.expiresAt<=new Date()))throw new GoneException('Время на подтверждение истекло. Войдите снова.');
    if(a.status==='PENDING')return {kind:'pending' as const};
    const used=await this.db.tenantLoginApproval.updateMany({where:{id:a.id,status:'APPROVED'},data:{status:'USED'}});
    if(!used.count)throw new GoneException('Время на подтверждение истекло. Войдите снова.');
    const trusted=ctx.deviceToken?await this.db.tenantTrustedDevice.findFirst({where:{tokenHash:digest(ctx.deviceToken),accountId:a.accountId}}):null;
    return this.issueSession(a.accountId,{platform:a.platform,deviceName:a.deviceName,remembered:a.remembered},trusted?.id??null);
  }
  async me(t:Tenant){
    const r=await this.db.resident.findUniqueOrThrow({where:{id:t.residentId},include:{property:{select:{name:true,address:true}},occupancies:{where:{status:'ACTIVE'},include:{room:{select:{number:true}},bed:{select:{number:true}}}}}});
    const o=r.occupancies[0];
    return {fullName:r.fullName,phone:r.phone,property:r.property,occupancy:o?{room:o.room.number,bed:o.bed.number,moveInDate:o.moveInDate,monthlyPrice:o.monthlyPrice,paymentDay:o.paymentDay,depositAmount:o.depositAmount}:null};
  }
  async sessions(t:Tenant,currentId:string){
    const rows=await this.db.tenantSession.findMany({where:{accountId:t.accountId,expiresAt:{gt:new Date()}},select:sessionSelect,orderBy:[{lastSeenAt:'desc'},{createdAt:'desc'}]});
    return rows.map(s=>({...s,current:s.id===currentId}));
  }
  async revoke(t:Tenant,id:string){
    const gone=await this.db.tenantSession.deleteMany({where:{id,accountId:t.accountId}});
    if(!gone.count)throw new NotFoundException('Сессия не найдена или уже завершена.');
    return {revoked:true};
  }
}

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly db:Database){}
  async canActivate(context:ExecutionContext){
    const req=context.switchToHttp().getRequest<TenantRequest>();
    const token=tenantToken(req);
    if(!token||token.length>200)throw new UnauthorizedException('Войдите в приложение.');
    const s=await this.db.tenantSession.findUnique({where:{tokenHash:digest(token)},include:{account:{include:{resident:{select:{property:{select:{active:true}}}}}}}});
    if(!s||s.expiresAt<=new Date()||!s.account.active||!s.account.resident.property.active)throw new UnauthorizedException('Сессия завершена. Войдите снова.');
    req.tenant={accountId:s.accountId,residentId:s.account.residentId,propertyId:s.account.propertyId};req.tenantSessionId=s.id;
    const stale=new Date(Date.now()-300000);
    if(!s.lastSeenAt||s.lastSeenAt<stale)await this.db.tenantSession.updateMany({where:{id:s.id},data:{lastSeenAt:new Date()}});
    return true;
  }
}

@Controller('tenant')
class TenantController {
  constructor(private readonly service:TenantAccountsService,private readonly db:Database){}
  @Post('invites/inspect') @HttpCode(200) inspect(@Body() dto:InviteTokenDto,@Req() req:Request){return this.service.inspect(dto.token,req.ip||'unknown');}
  @Post('invites/accept') @HttpCode(200) accept(@Body() dto:AcceptInviteDto,@Req() req:Request){return this.service.accept(dto,req.ip||'unknown');}
  @Post('auth/login') @HttpCode(200)
  async login(@Body() dto:TenantLoginDto,@Req() req:Request,@Res({passthrough:true}) res:Response){
    const r=await this.service.login(dto,req.ip||'unknown',req.headers['user-agent'],{deviceToken:tenantDeviceToken(req,dto.deviceToken)});
    if(r.kind==='approval'){res.status(202);return {approval:r.approval};}
    return tenantSession(r,res);
  }
  @Post('auth/login/approval') @HttpCode(200)
  async approval(@Body() dto:TenantApprovalDto,@Req() req:Request,@Res({passthrough:true}) res:Response){
    const r=await this.service.completeApproval(dto,{deviceToken:tenantDeviceToken(req,dto.deviceToken)});
    if(r.kind==='pending'){res.status(202);return {status:'PENDING'};}
    return tenantSession(r,res);
  }
  @Post('auth/logout') @HttpCode(204)
  async logout(@Req() req:Request,@Res({passthrough:true}) res:Response){
    const t=tenantToken(req);if(t)await this.db.tenantSession.deleteMany({where:{tokenHash:digest(t)}});
    res.clearCookie('ijara_tenant',{path:'/api/tenant',httpOnly:true,secure:process.env.COOKIE_SECURE!=='false',sameSite:'strict'});
  }
  @Get('me') @UseGuards(TenantGuard) me(@Req() req:TenantRequest){return this.service.me(req.tenant);}
  @Get('sessions') @UseGuards(TenantGuard) sessions(@Req() req:TenantRequest){return this.service.sessions(req.tenant,req.tenantSessionId);}
  @Delete('sessions/:id') @UseGuards(TenantGuard) revoke(@Req() req:TenantRequest,@Param('id',ParseUUIDPipe) id:string){return this.service.revoke(req.tenant,id);}
}

@Controller('residents') @UseGuards(SessionGuard)
class TenantAccountController {
  constructor(private readonly service:TenantAccountsService){}
  @Get(':id/app-account') status(@Req() req:AuthRequest,@Param('id',ParseUUIDPipe) id:string){return this.service.status(req.actor,id);}
  @Post(':id/app-invite') @HttpCode(200) invite(@Req() req:AuthRequest,@Param('id',ParseUUIDPipe) id:string,@Body() dto:InviteDto){return this.service.invite(req.actor,id,dto);}
  @Patch(':id/app-account') setActive(@Req() req:AuthRequest,@Param('id',ParseUUIDPipe) id:string,@Body() dto:AccountActiveDto){
    if(dto.active)throw new ForbiddenException('Чтобы снова открыть доступ, отправьте новое приглашение.');
    return this.service.setActive(req.actor,id,false);
  }
}

@Module({imports:[AuthModule,TelegramModule],providers:[TenantAccountsService,TenantTelegramService,TenantGuard],controllers:[TenantController,TenantAccountController],exports:[TenantAccountsService,TenantTelegramService,TenantGuard]})
export class TenantModule{}
