import {ConflictException,Injectable,ServiceUnavailableException} from '@nestjs/common';
import {Database} from './database';
import {TelegramService} from './telegram';
import {digest,makeToken,normalizePhone} from './security';

const LINK_TTL=10*60000;
export const APPROVAL_TTL=5*60000;
const OWNER_ROLES=['SUPER_ADMIN','OWNER'];
type Callback={id:string;from:{id:number};data?:string;message?:{chat:{id:number};message_id:number}};
const when=(d:Date)=>new Intl.DateTimeFormat('ru-RU',{timeZone:'Asia/Tashkent',day:'numeric',month:'long',hour:'2-digit',minute:'2-digit'}).format(d);

/**
 * Staff Telegram: linking an account (own contact with the account's phone) and confirming new-device logins
 * that arrive from the internet. Kept free of the auth module so the auth service and the bot can both use it.
 */
@Injectable()
export class StaffTelegramService{
  constructor(private readonly db:Database,private readonly telegram:TelegramService){}

  async createLink(userId:string){
    if(!this.telegram.ready())throw new ServiceUnavailableException('Telegram пока не подключён.');
    const token=makeToken();
    await this.db.$transaction(async tx=>{
      await tx.staffTelegramLink.updateMany({where:{userId,consumedAt:null},data:{consumedAt:new Date()}});
      await tx.staffTelegramLink.create({data:{userId,tokenHash:digest(token),expiresAt:new Date(Date.now()+LINK_TTL)}});
    });
    return {url:`https://t.me/${process.env.TELEGRAM_BOT_USERNAME}?start=${token}`,expiresIn:LINK_TTL/1000};
  }
  async status(userId:string){
    const u=await this.db.user.findUniqueOrThrow({where:{id:userId},select:{telegramLinkedAt:true}});
    return {linked:!!u.telegramLinkedAt,linkedAt:u.telegramLinkedAt};
  }
  async unlink(userId:string,propertyId:string){
    await this.db.$transaction(async tx=>{
      await tx.user.update({where:{id:userId},data:{telegramUserId:null,telegramLinkedAt:null}});
      await tx.auditLog.create({data:{propertyId,actorId:userId,action:'TELEGRAM_UNLINKED',entity:'User',entityId:userId,metadata:{}}});
    });
    return {linked:false};
  }

  /** /start <token>: true when the token belongs to a staff link (valid or not), so the bot stops looking. */
  async start(token:string,telegramUserId:string,chatId:number){
    const link=await this.db.staffTelegramLink.findUnique({where:{tokenHash:digest(token)}});
    if(!link)return false;
    if(link.consumedAt||link.expiresAt<=new Date()||link.telegramUserId&&link.telegramUserId!==telegramUserId){
      await this.telegram.send(chatId,'Ссылка истекла. Откройте настройки кабинета и нажмите «Привязать Telegram» ещё раз.');return true;
    }
    await this.db.staffTelegramLink.updateMany({where:{id:link.id,consumedAt:null},data:{telegramUserId}});
    await this.telegram.send(chatId,'Чтобы привязать Telegram к кабинету Ijara360, подтвердите номер кнопкой ниже.',{keyboard:[[{text:'Подтвердить мой телефон',request_contact:true}]],resize_keyboard:true,one_time_keyboard:true});
    return true;
  }
  /** Shared contact: true when a staff link was waiting for this Telegram user. */
  async contact(telegramUserId:string,contactUserId:number|undefined,rawPhone:string,chatId:number){
    const link=await this.db.staffTelegramLink.findFirst({where:{telegramUserId,consumedAt:null,expiresAt:{gt:new Date()}},orderBy:{createdAt:'desc'},include:{user:true}});
    if(!link)return false;
    if(String(contactUserId)!==telegramUserId){await this.telegram.send(chatId,'Нужен ваш собственный контакт. Нажмите кнопку «Подтвердить мой телефон».');return true;}
    let phone:string;try{phone=normalizePhone(rawPhone.startsWith('+')?rawPhone:`+${rawPhone}`);}catch{return true;}
    if(phone!==link.user.phone){await this.telegram.send(chatId,'Номер Telegram не совпадает с номером вашей учётной записи в кабинете.',{remove_keyboard:true});return true;}
    try{
      await this.db.$transaction(async tx=>{
        const used=await tx.staffTelegramLink.updateMany({where:{id:link.id,consumedAt:null},data:{consumedAt:new Date()}});
        if(!used.count)throw new ConflictException('used');
        const other=await tx.user.findFirst({where:{telegramUserId,id:{not:link.userId}}});
        if(other)throw new ConflictException('taken');
        await tx.user.update({where:{id:link.userId},data:{telegramUserId,telegramLinkedAt:new Date()}});
        await tx.auditLog.create({data:{propertyId:link.user.propertyId,actorId:link.userId,action:'TELEGRAM_LINKED',entity:'User',entityId:link.userId,metadata:{}}});
      });
    }catch(e){
      if(e instanceof ConflictException&&e.message==='taken'){await this.telegram.send(chatId,'Этот Telegram уже привязан к другому сотруднику.',{remove_keyboard:true});return true;}
      if(e instanceof ConflictException)return true;
      throw e;
    }
    await this.telegram.send(chatId,'Telegram привязан. Сюда будут приходить уведомления и подтверждения входа с новых устройств.',{remove_keyboard:true});
    return true;
  }

  /** Sends the confirm/deny buttons. Throws 503 and closes the request when Telegram cannot be reached. */
  /**
   * Who confirms a new-device login from the internet (owner's decision 2026-10-17): an owner confirms their
   * own login; every other staff member is confirmed by the owners, never by themselves.
   */
  async approvers(user:{id:string;propertyId:string;role:string;telegramUserId:string|null}){
    if(OWNER_ROLES.includes(user.role))return user.telegramUserId?[{id:user.id,telegramUserId:user.telegramUserId}]:[];
    const owners=await this.db.user.findMany({where:{propertyId:user.propertyId,active:true,role:{in:['SUPER_ADMIN','OWNER']},telegramUserId:{not:null}},select:{id:true,telegramUserId:true}});
    return owners.map(o=>({id:o.id,telegramUserId:o.telegramUserId!}));
  }
  async requestApproval(user:{id:string;propertyId:string;role:string;fullName:string;telegramUserId:string|null},device:{platform:string;deviceName:string;remembered:boolean}){
    const approvers=await this.approvers(user);
    const own=OWNER_ROLES.includes(user.role);
    const pollToken=makeToken();
    const approval=await this.db.loginApproval.create({data:{userId:user.id,pollTokenHash:digest(pollToken),platform:device.platform,deviceName:device.deviceName,remembered:device.remembered,expiresAt:new Date(Date.now()+APPROVAL_TTL)}});
    const text=own
      ?`Вход в кабинет Ijara360 с нового устройства через интернет.
Устройство: ${device.deviceName}
Время: ${when(approval.createdAt)}

Если это не вы, нажмите «Не я» и смените пароль.`
      :`Сотрудник ${user.fullName} входит в кабинет Ijara360 с нового устройства через интернет.
Устройство: ${device.deviceName}
Время: ${when(approval.createdAt)}

Разрешить вход?`;
    const buttons={inline_keyboard:[[{text:own?'Это я':'Разрешить',callback_data:`la:${approval.id}`},{text:own?'Не я':'Отклонить',callback_data:`ld:${approval.id}`}]]};
    let delivered=0;
    for(const a of approvers){try{await this.telegram.send(a.telegramUserId,text,buttons);delivered++;}catch{/* another owner may still get it */}}
    if(!delivered){
      await this.db.loginApproval.update({where:{id:approval.id},data:{status:'DENIED',decidedAt:new Date()}});
      throw new ServiceUnavailableException('Не удалось отправить подтверждение в Telegram. Повторите позже.');
    }
    await this.db.auditLog.create({data:{propertyId:user.propertyId,actorId:user.id,action:'LOGIN_APPROVAL_REQUESTED',entity:'User',entityId:user.id,metadata:{platform:device.platform,deviceName:device.deviceName}}});
    return {id:approval.id,pollToken,expiresAt:approval.expiresAt,confirmBy:own?'self' as const:'owner' as const};
  }
  /** Button press in Telegram. Only an approver of that login (see approvers) can decide. */
  async decide(q:Callback){
    const m=/^(la|ld):([0-9a-f-]{36})$/.exec(q.data||'');if(!m)return false;
    const approve=m[1]==='la';
    const a=await this.db.loginApproval.findUnique({where:{id:m[2]},include:{user:true}});
    const answer=(text:string)=>this.telegram.call('answerCallbackQuery',{callback_query_id:q.id,text}).catch(()=>undefined);
    const approver=a?(await this.approvers(a.user)).find(x=>x.telegramUserId===String(q.from.id)):undefined;
    if(!a||!approver){await answer('Запрос не найден.');return true;}
    const done=await this.db.loginApproval.updateMany({where:{id:a.id,status:'PENDING',expiresAt:{gt:new Date()}},data:{status:approve?'APPROVED':'DENIED',decidedAt:new Date()}});
    if(!done.count){await answer('Запрос уже обработан или истёк.');return true;}
    await this.db.auditLog.create({data:{propertyId:a.user.propertyId,actorId:approver.id,action:approve?'LOGIN_APPROVED':'LOGIN_DENIED',entity:'User',entityId:a.userId,metadata:{platform:a.platform,deviceName:a.deviceName}}});
    await answer(approve?'Вход подтверждён.':'Вход отклонён.');
    const who=approver.id===a.userId?'':`${a.user.fullName}, `;
    if(q.message)await this.telegram.call('editMessageText',{chat_id:q.message.chat.id,message_id:q.message.message_id,
      text:approve?`Вход подтверждён: ${who}${a.deviceName}.`:`Вход отклонён: ${who}${a.deviceName}.${who?'':' Если это были не вы, смените пароль в кабинете.'}`}).catch(()=>undefined);
    return true;
  }
}
