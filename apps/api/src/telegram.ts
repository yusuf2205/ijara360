import {Injectable,Module,ServiceUnavailableException} from '@nestjs/common';

/** Minimal Telegram Bot API client shared by phone verification and tenant invites. The token never leaves this class. */
@Injectable()
export class TelegramService {
  ready(){return Boolean(process.env.TELEGRAM_BOT_TOKEN&&/^[a-zA-Z0-9_]{5,32}$/.test(process.env.TELEGRAM_BOT_USERNAME||''));}
  async call(method:string,body:unknown):Promise<any>{
    try{
      const response=await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(35000)});
      const data=await response.json() as {ok:boolean;result:unknown};if(!response.ok||!data.ok)throw Error();return data.result;
    }catch{throw new ServiceUnavailableException('Telegram временно недоступен. Повторите позже.');}
  }
  async send(chatId:number|string,text:string,reply_markup?:unknown){await this.call('sendMessage',{chat_id:chatId,text,reply_markup});}
  /** Public address of the web app for links in bot messages. */
  origin(){return process.env.PUBLIC_APP_ORIGIN||process.env.APP_ORIGIN||'';}
}
@Module({providers:[TelegramService],exports:[TelegramService]})
export class TelegramModule{}
