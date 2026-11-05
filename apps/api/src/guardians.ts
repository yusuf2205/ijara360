import {Body,ConflictException,Controller,Delete,HttpCode,Injectable,Logger,Module,NotFoundException,Param,ParseUUIDPipe,Post,Req,ServiceUnavailableException,UseGuards} from '@nestjs/common';
import {Prisma} from '@prisma/client';
import {Transform} from 'class-transformer';
import {IsOptional,IsString,Length} from 'class-validator';
import {Actor,AuthModule,AuthRequest,SessionGuard} from './auth';
import {Database} from './database';
import {Lang,NotificationsModule,NotificationsService,fmt} from './notifications';
import {requireAccess} from './permission-policy';
import {publish} from './realtime';
import {digest,makeToken,normalizePhone} from './security';
import {TelegramModule,TelegramService} from './telegram';

/**
 * Parent access (owner's decisions 2026-11-05): a parent follows a resident's rent in the Telegram bot. Only staff
 * add a parent and get a one-time bot link; the parent opens it and is connected. The parent never sees location
 * or documents. See migration 202611060001_guardians.
 */
const INVITE_TTL=7*86400000;
const MAX_GUARDIANS=3;
const trim=({value}:{value:unknown})=>typeof value==='string'?value.trim():value;
export class GuardianDto{
  @Transform(trim) @IsString() @Length(2,80,{message:'Кто это: от 2 до 80 символов, например «Мама, Дилноза».'}) name!:string;
  @IsOptional() @Transform(({value})=>typeof value==='string'&&value.trim()===''?undefined:trim({value})) @IsString() @Length(8,30) phone?:string;
}
type Tx=Prisma.TransactionClient;
type Callback={id:string;from:{id:number};data?:string;message?:{chat:{id:number};message_id:number}};
const lock=(tx:Tx,propertyId:string)=>tx.$queryRaw`SELECT id FROM properties WHERE id = ${propertyId}::uuid FOR UPDATE`;

@Injectable()
export class GuardiansService{
  private readonly logger=new Logger(GuardiansService.name);
  constructor(private readonly db:Database,private readonly telegram:TelegramService){}
  link(token:string){return `https://t.me/${process.env.TELEGRAM_BOT_USERNAME}?start=${token}`;}
  private async issue(tx:Tx,guardianId:string){
    await tx.guardianInvite.updateMany({where:{guardianId,consumedAt:null},data:{consumedAt:new Date()}});
    const token=makeToken();const expiresAt=new Date(Date.now()+INVITE_TTL);
    await tx.guardianInvite.create({data:{guardianId,tokenHash:digest(token),expiresAt}});
    return {link:this.link(token),expiresAt};
  }
  private write<T>(actor:Actor,action:(tx:Tx)=>Promise<T>){
    if(!this.telegram.ready())throw new ServiceUnavailableException('Telegram-бот не подключён, поэтому родителя подключить нельзя.');
    return this.db.$transaction(async tx=>{
      await lock(tx,actor.propertyId);
      await requireAccess(tx,actor,'RESIDENTS_MANAGE');
      const result=await action(tx);
      await publish(tx,{p:actor.propertyId,topic:'house',type:'changed'});
      return result;
    },{maxWait:10000,timeout:15000});
  }
  private async living(tx:Tx,actor:Actor,residentId:string){
    const r=await tx.resident.findFirst({where:{id:residentId,propertyId:actor.propertyId},select:{id:true,occupancies:{where:{status:'ACTIVE'},select:{id:true}}}});
    if(!r)throw new NotFoundException('Жилец не найден.');
    if(!r.occupancies.length)throw new ConflictException('Подключить родителя можно только к жильцу, который сейчас проживает.');
  }
  private async active(tx:Tx,actor:Actor,residentId:string,id:string){
    const g=await tx.guardian.findFirst({where:{id,residentId,propertyId:actor.propertyId,revokedAt:null}});
    if(!g)throw new NotFoundException('Родитель не найден или уже отключён.');
    return g;
  }
  /** Adds a parent and returns the one-time bot link for staff to pass on. */
  add(actor:Actor,residentId:string,dto:GuardianDto){
    let phone:string|null=null;
    if(dto.phone)phone=normalizePhone(dto.phone);
    return this.write(actor,async tx=>{
      await this.living(tx,actor,residentId);
      if(await tx.guardian.count({where:{residentId,revokedAt:null}})>=MAX_GUARDIANS)throw new ConflictException(`К одному жильцу можно подключить не больше ${MAX_GUARDIANS} родителей.`);
      const g=await tx.guardian.create({data:{propertyId:actor.propertyId,residentId,name:dto.name,phone,createdById:actor.id}});
      await tx.auditLog.create({data:{propertyId:actor.propertyId,actorId:actor.id,action:'GUARDIAN_ADDED',entity:'Resident',entityId:residentId,metadata:{guardianId:g.id}}});
      return {id:g.id,...await this.issue(tx,g.id)};
    });
  }
  /** A new link: the previous one stops working. A parent who opens it from another Telegram moves there. */
  relink(actor:Actor,residentId:string,id:string){
    return this.write(actor,async tx=>{
      await this.living(tx,actor,residentId);
      const g=await this.active(tx,actor,residentId,id);
      await tx.auditLog.create({data:{propertyId:actor.propertyId,actorId:actor.id,action:'GUARDIAN_LINK_CREATED',entity:'Resident',entityId:residentId,metadata:{guardianId:g.id}}});
      return {id:g.id,...await this.issue(tx,g.id)};
    });
  }
  async revoke(actor:Actor,residentId:string,id:string){
    const g=await this.write(actor,async tx=>{
      const g=await this.active(tx,actor,residentId,id);
      await revokeGuardian(tx,g.id);
      await tx.auditLog.create({data:{propertyId:actor.propertyId,actorId:actor.id,action:'GUARDIAN_REVOKED',entity:'Resident',entityId:residentId,metadata:{guardianId:g.id,reason:'STAFF'}}});
      return g;
    });
    if(g.telegramUserId){
      const r=await this.db.resident.findUnique({where:{id:residentId},select:{fullName:true}});
      const text=g.lang==='uz'?`Ma’muriyat sizni ${r?.fullName} bo‘yicha xabarlardan uzdi. Endi xabarlar kelmaydi.`:`Администрация отключила вас от сведений о жильце ${r?.fullName}. Уведомления больше не приходят.`;
      await this.telegram.send(g.telegramUserId,text).catch(()=>this.logger.warn('Could not tell a parent about the disconnect.'));
    }
    return {revoked:true};
  }
}

/** Ends a parent's access and clears the contact data; invites stop working. Notifications already queued still go. */
export async function revokeGuardian(tx:Tx,id:string){
  await tx.guardian.update({where:{id},data:{revokedAt:new Date(),phone:null,telegramUserId:null}});
  await tx.guardianInvite.updateMany({where:{guardianId:id,consumedAt:null},data:{consumedAt:new Date()}});
}

const T={
  ru:{
    expired:'Ссылка недействительна или уже использована. Попросите администрацию общежития прислать новую.',
    already:(n:string)=>`Вы уже получаете сведения о жильце ${n}.`,
    linked:(p:string,n:string)=>`Готово! Вы подключены к сведениям о жильце ${n} (${p}).\n\nСюда будут приходить: напоминания об оплате и просрочке, полученные оплаты с номером чека, новые начисления, переселение, срок проживания и выезд.\nМестоположение и документы жильца вам не видны.`,
    balance:'💰 Баланс',lang:'🌐 O‘zbek tilida',leave:'Отключиться',
    leaveAsk:(n:string)=>`Отключиться от сведений о жильце ${n}? Подключиться снова можно будет только по новой ссылке от администрации.`,
    leaveYes:'Да, отключиться',cancel:'Отмена',left:(n:string)=>`Вы отключены от сведений о жильце ${n}.`,
    gone:'Вы больше не подключены к этому жильцу.',menu:'Выберите жильца:',langSet:'Язык: русский.',
  },
  uz:{
    expired:'Havola yaroqsiz yoki allaqachon ishlatilgan. Yotoqxona ma’muriyatidan yangisini so‘rang.',
    already:(n:string)=>`Siz ${n} bo‘yicha xabarlarni allaqachon olyapsiz.`,
    linked:(p:string,n:string)=>`Tayyor! Siz ${n} (${p}) bo‘yicha xabarlarga ulandingiz.\n\nBu yerga keladi: to‘lov va kechikish eslatmalari, chek raqami bilan qabul qilingan to‘lovlar, yangi hisoblar, ko‘chirish, yashash muddati va chiqib ketish.\nYashovchining joylashuvi va hujjatlari sizga ko‘rinmaydi.`,
    balance:'💰 Balans',lang:'🌐 На русском',leave:'Uzilish',
    leaveAsk:(n:string)=>`${n} bo‘yicha xabarlardan uzilasizmi? Qayta ulanish faqat ma’muriyatning yangi havolasi orqali mumkin.`,
    leaveYes:'Ha, uzilish',cancel:'Bekor qilish',left:(n:string)=>`Siz ${n} bo‘yicha xabarlardan uzildingiz.`,
    gone:'Siz endi bu yashovchiga ulanmagansiz.',menu:'Yashovchini tanlang:',langSet:'Til: o‘zbekcha.',
  },
} as const;
const L=(lang:string):Lang=>lang==='uz'?'uz':'ru';

/** The parent's side in the bot: the start link, the balance, the language and leaving. Used by the bot dispatcher. */
@Injectable()
export class GuardianTelegramService{
  constructor(private readonly db:Database,private readonly telegram:TelegramService,private readonly notifications:NotificationsService){}
  buttons(g:{id:string;lang:string}){
    const t=T[L(g.lang)];
    return {inline_keyboard:[[{text:t.balance,callback_data:`gb:${g.id}`}],[{text:t.lang,callback_data:`gl:${g.id}`},{text:t.leave,callback_data:`gq:${g.id}`}]]};
  }
  /** /start <token>: true when the token was a parent invite (valid or not), so the dispatcher stops looking. */
  async start(token:string,userId:string,chatId:number){
    const invite=await this.db.guardianInvite.findUnique({where:{tokenHash:digest(token)},include:{guardian:true}});
    if(!invite)return false;
    const g=invite.guardian;const t=T[L(g.lang)];
    const result=await this.db.$transaction(async tx=>{
      await lock(tx,g.propertyId);
      const fresh=await tx.guardianInvite.findUnique({where:{id:invite.id},include:{guardian:{include:{property:{select:{name:true,active:true}},resident:{select:{fullName:true,occupancies:{where:{status:'ACTIVE'},select:{id:true}}}}}}}});
      const fg=fresh?.guardian;
      if(!fresh||!fg||fresh.consumedAt||fresh.expiresAt<=new Date()||fg.revokedAt||!fg.property.active||!fg.resident.occupancies.length)return {kind:'expired' as const};
      await tx.guardianInvite.update({where:{id:fresh.id},data:{consumedAt:new Date()}});
      const twin=await tx.guardian.findFirst({where:{residentId:fg.residentId,telegramUserId:userId,revokedAt:null,id:{not:fg.id}}});
      if(twin){
        // The same Telegram already follows this resident: drop the duplicate instead of linking it twice.
        await revokeGuardian(tx,fg.id);
        await tx.auditLog.create({data:{propertyId:fg.propertyId,actorId:null,action:'GUARDIAN_REVOKED',entity:'Resident',entityId:fg.residentId,metadata:{guardianId:fg.id,reason:'DUPLICATE'}}});
        await publish(tx,{p:fg.propertyId,topic:'house',type:'changed'});
        return {kind:'already' as const,name:fg.resident.fullName,g:twin};
      }
      await tx.guardian.update({where:{id:fg.id},data:{telegramUserId:userId,linkedAt:new Date()}});
      await tx.auditLog.create({data:{propertyId:fg.propertyId,actorId:null,action:'GUARDIAN_LINKED',entity:'Resident',entityId:fg.residentId,metadata:{guardianId:fg.id}}});
      await this.notifications.guardianLinked(tx,fg.residentId,fg.name);
      await publish(tx,{p:fg.propertyId,topic:'house',type:'changed'});
      return {kind:'linked' as const,name:fg.resident.fullName,property:fg.property.name};
    },{maxWait:10000,timeout:15000});
    if(result.kind==='expired'){await this.telegram.send(chatId,t.expired);return true;}
    if(result.kind==='already'){await this.telegram.send(chatId,T[L(result.g.lang)].already(result.name),this.buttons(result.g));return true;}
    await this.telegram.send(chatId,t.linked(result.property,result.name),this.buttons(g));
    await this.telegram.send(chatId,await this.balance(g.id),this.buttons(g)).catch(()=>undefined);
    return true;
  }
  /** Plain /start from a connected parent: one balance message per resident they follow. True when there was any. */
  async menu(userId:string,chatId:number){
    const list=await this.db.guardian.findMany({where:{telegramUserId:userId,revokedAt:null,linkedAt:{not:null}},orderBy:{linkedAt:'asc'}});
    if(!list.length)return false;
    for(const g of list)await this.telegram.send(chatId,await this.balance(g.id),this.buttons(g));
    return true;
  }
  /** Debt, advance, the next payment and the last payment, read the same way the resident's app reads them. */
  async balance(guardianId:string){
    const g=await this.db.guardian.findUniqueOrThrow({where:{id:guardianId}});
    const lang=L(g.lang);const f=fmt(lang);
    return this.db.$transaction(async tx=>{
      await lock(tx,g.propertyId);
      await tx.$queryRaw`SELECT finance_refresh_property(${g.propertyId}::uuid)`;
      const scope={propertyId:g.propertyId,residentId:g.residentId};
      const [r,overdue,next,last,occ]=await Promise.all([
        tx.resident.findUniqueOrThrow({where:{id:g.residentId},select:{fullName:true,totalDebt:true,creditBalance:true}}),
        tx.charge.aggregate({where:{...scope,status:'OVERDUE'},_sum:{dueAmount:true}}),
        tx.charge.findFirst({where:{...scope,status:{in:['UNPAID','PARTIALLY_PAID','OVERDUE']}},orderBy:[{dueDate:'asc'},{createdAt:'asc'}],select:{type:true,dueAmount:true,dueDate:true,billingPeriodStart:true}}),
        tx.payment.findFirst({where:scope,orderBy:[{createdAt:'desc'},{id:'desc'}],select:{id:true,amount:true,createdAt:true}}),
        tx.occupancy.findFirst({where:{residentId:g.residentId,status:'ACTIVE'},select:{room:{select:{number:true}},bed:{select:{number:true}}}}),
      ]);
      const no=last?await receiptNo(tx,g.propertyId,last.id):null;
      const od=overdue._sum.dueAmount??new Prisma.Decimal(0);
      const lines=[`${r.fullName}${occ?` · ${f.place(occ.room.number,occ.bed.number)}`:''}`,''];
      if(lang==='uz'){
        lines.push(`Qarz: ${f.sum(r.totalDebt)}${od.gt(0)?` (muddati o‘tgan: ${f.sum(od)})`:''}`);
        if(r.creditBalance.gt(0))lines.push(`Avans: ${f.sum(r.creditBalance)}`);
        lines.push(next?`Navbatdagi to‘lov: ${f.charge(next)} — ${f.sum(next.dueAmount)}, ${f.day(next.dueDate)} gacha.`:'To‘lanmagan hisoblar yo‘q.');
        if(last)lines.push(`Oxirgi to‘lov: ${f.sum(last.amount)}, ${f.day(last.createdAt)}${no?`, chek № ${f.receipt(no)}`:''}.`);
      }else{
        lines.push(`Долг: ${f.sum(r.totalDebt)}${od.gt(0)?` (просрочено: ${f.sum(od)})`:''}`);
        if(r.creditBalance.gt(0))lines.push(`Аванс: ${f.sum(r.creditBalance)}`);
        lines.push(next?`Следующий платёж: ${f.charge(next)} — ${f.sum(next.dueAmount)} до ${f.day(next.dueDate)}.`:'Неоплаченных начислений нет.');
        if(last)lines.push(`Последняя оплата: ${f.sum(last.amount)}, ${f.day(last.createdAt)}${no?`, чек № ${f.receipt(no)}`:''}.`);
      }
      return lines.join('\n');
    },{maxWait:10000,timeout:20000});
  }
  /** Button press in the bot. True when the data belonged to parent access. */
  async decide(q:Callback){
    const m=/^(gb|gl|gq|gqy|gqn):([0-9a-f-]{36})$/.exec(q.data||'');
    if(!m)return false;
    const answer=(text='')=>this.telegram.call('answerCallbackQuery',{callback_query_id:q.id,text}).catch(()=>undefined);
    const g=await this.db.guardian.findUnique({where:{id:m[2]},include:{resident:{select:{fullName:true}}}});
    if(!g||g.revokedAt||g.telegramUserId!==String(q.from.id)){await answer(`${T.ru.gone} / ${T.uz.gone}`);return true;}
    const t=T[L(g.lang)];const chat=q.message?.chat.id??q.from.id;
    switch(m[1]){
      case 'gb':await answer();await this.telegram.send(chat,await this.balance(g.id),this.buttons(g));break;
      case 'gl':{
        const lang=g.lang==='uz'?'ru':'uz';
        await this.db.guardian.updateMany({where:{telegramUserId:g.telegramUserId,revokedAt:null},data:{lang}});
        await answer(T[lang].langSet);
        await this.telegram.send(chat,await this.balance(g.id),this.buttons({id:g.id,lang}));break;
      }
      case 'gq':await answer();await this.telegram.send(chat,t.leaveAsk(g.resident.fullName),{inline_keyboard:[[{text:t.leaveYes,callback_data:`gqy:${g.id}`},{text:t.cancel,callback_data:`gqn:${g.id}`}]]});break;
      case 'gqn':
        await answer();
        if(q.message)await this.telegram.call('deleteMessage',{chat_id:q.message.chat.id,message_id:q.message.message_id}).catch(()=>undefined);
        break;
      case 'gqy':{
        await this.db.$transaction(async tx=>{
          await lock(tx,g.propertyId);
          const gone=await tx.guardian.updateMany({where:{id:g.id,revokedAt:null},data:{revokedAt:new Date(),phone:null,telegramUserId:null}});
          if(!gone.count)return;
          await tx.guardianInvite.updateMany({where:{guardianId:g.id,consumedAt:null},data:{consumedAt:new Date()}});
          await tx.auditLog.create({data:{propertyId:g.propertyId,actorId:null,action:'GUARDIAN_REVOKED',entity:'Resident',entityId:g.residentId,metadata:{guardianId:g.id,reason:'PARENT'}}});
          await publish(tx,{p:g.propertyId,topic:'house',type:'changed'});
        });
        await answer();
        if(q.message)await this.telegram.call('editMessageText',{chat_id:q.message.chat.id,message_id:q.message.message_id,text:t.left(g.resident.fullName)}).catch(()=>undefined);
        break;
      }
    }
    return true;
  }
}

/** The payment's receipt number: its place in the house's payment sequence (same as finance receiptNumbers). */
export async function receiptNo(tx:Tx,propertyId:string,paymentId:string){
  const rows=await tx.$queryRaw<{n:bigint}[]>`
    SELECT n FROM (SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM payments WHERE property_id = ${propertyId}::uuid) x
    WHERE id = ${paymentId}::uuid`;
  return rows[0]?Number(rows[0].n):null;
}

@Controller('residents/:residentId/guardians') @UseGuards(SessionGuard)
class GuardiansController{
  constructor(private readonly service:GuardiansService){}
  @Post() @HttpCode(200) add(@Req() req:AuthRequest,@Param('residentId',ParseUUIDPipe) residentId:string,@Body() dto:GuardianDto){return this.service.add(req.actor,residentId,dto);}
  @Post(':id/link') @HttpCode(200) relink(@Req() req:AuthRequest,@Param('residentId',ParseUUIDPipe) residentId:string,@Param('id',ParseUUIDPipe) id:string){return this.service.relink(req.actor,residentId,id);}
  @Delete(':id') revoke(@Req() req:AuthRequest,@Param('residentId',ParseUUIDPipe) residentId:string,@Param('id',ParseUUIDPipe) id:string){return this.service.revoke(req.actor,residentId,id);}
}

@Module({imports:[AuthModule,TelegramModule,NotificationsModule],providers:[GuardiansService,GuardianTelegramService],controllers:[GuardiansController],exports:[GuardianTelegramService]})
export class GuardiansModule{}
