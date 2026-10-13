import {Injectable,OnModuleDestroy,OnModuleInit,ServiceUnavailableException,UnauthorizedException} from '@nestjs/common';
import {RentalApplication} from '@prisma/client';
import {Database} from './database';
import {ApplicationService} from './applications.service';
import {AuthService} from './auth';
import {TelegramService} from './telegram';
import {StaffTelegramService} from './staff-telegram';
import {digest,makeToken,normalizePhone,safeTokenEqual} from './security';

type TelegramUpdate={update_id:number;message?:{from?:{id:number;is_bot?:boolean};chat:{id:number;type:string};text?:string;contact?:{user_id?:number;phone_number:string}};callback_query?:{id:string;from:{id:number};data?:string;message?:{chat:{id:number};message_id:number}}};
@Injectable()
export class PhoneVerificationService implements OnModuleInit,OnModuleDestroy {
  private stopped=false;private timer?:NodeJS.Timeout;
  constructor(private readonly db:Database,private readonly applications:ApplicationService,private readonly auth:AuthService,private readonly telegram:TelegramService,private readonly staff:StaffTelegramService){}
  ready(){return this.telegram.ready();}
  async challenge(a:RentalApplication){
    if(!this.ready())throw new ServiceUnavailableException('Подтверждение телефона пока не подключено.');
    await this.auth.rateLimit('telegram-challenge',a.id,5);
    const token=makeToken();
    await this.applications.locked(a,async(tx,current)=>{
      if(!['DRAFT','NEEDS_INFO'].includes(current.status))throw new UnauthorizedException('Заявка уже отправлена.');
      await tx.phoneChallenge.updateMany({where:{applicationId:a.id,consumedAt:null},data:{consumedAt:new Date()}});
      await tx.phoneChallenge.create({data:{applicationId:a.id,tokenHash:digest(token),expiresAt:new Date(Date.now()+10*60000)}});
    });return {url:`https://t.me/${process.env.TELEGRAM_BOT_USERNAME}?start=${token}`,expiresIn:600};
  }
  // Kept as a seam: tests replace this method to run the bot logic without the network.
  async call(method:string,body:unknown):Promise<any>{return this.telegram.call(method,body);}
  async send(chatId:number,text:string,reply_markup?:unknown){await this.call('sendMessage',{chat_id:chatId,text,reply_markup});}
  async handle(update:TelegramUpdate){
    if(update.callback_query){await this.staff.decide(update.callback_query);return;}
    const m=update.message;if(!m||m.chat?.type!=='private'||!m.from||m.from.is_bot||m.from.id!==m.chat.id)return;
    const userId=String(m.from.id);
    if(m.text?.startsWith('/start ')){
      const token=m.text.slice(7).trim();if(!/^[A-Za-z0-9_-]{32,100}$/.test(token))return;
      if(await this.staff.start(token,userId,m.chat.id))return;
      const challenge=await this.db.phoneChallenge.findUnique({where:{tokenHash:digest(token)}});
      if(!challenge||challenge.consumedAt||challenge.expiresAt<=new Date()||challenge.telegramUserId&&challenge.telegramUserId!==userId){await this.send(m.chat.id,'Ссылка истекла. Откройте анкету и запросите подтверждение снова.');return;}
      const bound=await this.db.phoneChallenge.updateMany({where:{id:challenge.id,consumedAt:null,OR:[{telegramUserId:null},{telegramUserId:userId}]},data:{telegramUserId:userId}});
      if(!bound.count)return;
      await this.send(m.chat.id,'Подтвердите номер из анкеты кнопкой ниже. Передайте свой контакт, привязанный к Telegram. Паспорт и фото лица загружайте только в защищённой анкете.',{keyboard:[[{text:'Подтвердить мой телефон',request_contact:true}]],resize_keyboard:true,one_time_keyboard:true});return;
    }
    if(m.contact){
      if(await this.staff.contact(userId,m.contact.user_id,m.contact.phone_number,m.chat.id))return;
      if(m.contact.user_id!==m.from.id){await this.send(m.chat.id,'Нужен ваш собственный контакт. Нажмите кнопку подтверждения телефона.');return;}
      const challenge=await this.db.phoneChallenge.findFirst({where:{telegramUserId:userId,consumedAt:null,expiresAt:{gt:new Date()}},orderBy:{expiresAt:'desc'},include:{application:true}});
      if(!challenge){await this.send(m.chat.id,'Сначала запросите подтверждение в своей анкете.');return;}
      let phone:string;try{phone=normalizePhone(m.contact.phone_number.startsWith('+')?m.contact.phone_number:`+${m.contact.phone_number}`);}catch{return;}
      if(this.applications.profile(challenge.application).phone!==phone){await this.send(m.chat.id,'Контакт не совпадает с номером в анкете. Используйте номер, привязанный к вашему Telegram.');return;}
      await this.applications.locked(challenge.application,async(tx,a)=>{
        const fresh=await tx.phoneChallenge.findUnique({where:{id:challenge.id}});
        if(!fresh||fresh.consumedAt||fresh.expiresAt<=new Date()||!['DRAFT','NEEDS_INFO'].includes(a.status))return;
        await tx.phoneChallenge.update({where:{id:challenge.id},data:{consumedAt:new Date()}});
        await tx.rentalApplication.update({where:{id:a.id},data:{phoneVerifiedAt:new Date(),phoneVerificationMethod:'TELEGRAM_OWN_CONTACT',version:{increment:1}}});
        await this.applications.audit(tx,a,'APPLICATION_PHONE_VERIFIED',null,{method:'TELEGRAM_OWN_CONTACT'});
      });
      await this.applications.event(challenge.application,'updated');await this.send(m.chat.id,'Телефон подтверждён. Вернитесь в анкету и продолжите заполнение.',{remove_keyboard:true});return;
    }
    if(m.text==='/start'||m.text==='/apply'){
      const origin=process.env.PUBLIC_APP_ORIGIN||process.env.APP_ORIGIN;
      await this.send(m.chat.id,'Подайте заявку в защищённой анкете. Документы не нужно отправлять в чат.',{inline_keyboard:[[{text:'Открыть анкету',url:`${origin}/apply?channel=TELEGRAM`}]]});
    }
  }
  async webhook(secret:string,update:TelegramUpdate){
    if(process.env.TELEGRAM_MODE!=='webhook'||!process.env.TELEGRAM_WEBHOOK_SECRET||!safeTokenEqual(secret||'',process.env.TELEGRAM_WEBHOOK_SECRET))throw new UnauthorizedException('Запрос отклонён.');
    await this.handle(update);return {ok:true};
  }
  onModuleInit(){if(this.ready()&&process.env.TELEGRAM_MODE==='polling'&&process.env.NODE_ENV!=='test')void this.poll();}
  private async poll(){
    if(this.stopped)return;
    try{
      const cursor=await this.db.telegramCursor.upsert({where:{id:'applications'},create:{id:'applications'},update:{}});
      const updates=await this.call('getUpdates',{offset:cursor.lastUpdateId+1,timeout:25,allowed_updates:['message','callback_query']}) as TelegramUpdate[];
      for(const update of updates){if(this.stopped)break;await this.handle(update);await this.db.telegramCursor.update({where:{id:'applications'},data:{lastUpdateId:update.update_id}});}
    }catch{console.warn('Telegram application transport unavailable; retry scheduled.');}
    if(!this.stopped){this.timer=setTimeout(()=>void this.poll(),1500);this.timer.unref();}
  }
  onModuleDestroy(){this.stopped=true;if(this.timer)clearTimeout(this.timer);}
}
