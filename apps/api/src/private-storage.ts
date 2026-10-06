import {Injectable,ServiceUnavailableException,UnprocessableEntityException} from '@nestjs/common';
import {createCipheriv,createDecipheriv,createHmac,randomBytes,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
import sharp from 'sharp';

@Injectable()
export class PrivateStorage {
  private key(){
    const value=process.env.KYC_ENCRYPTION_KEY || '';
    if(!/^[a-f0-9]{64}$/i.test(value))throw new ServiceUnavailableException('Защищённое хранилище пока не настроено.');
    return Buffer.from(value,'hex');
  }
  ready(){try {this.key();return Boolean(process.env.KYC_STORAGE_PATH && isAbsolute(process.env.KYC_STORAGE_PATH));}catch{return false;}}
  encrypt(data:Buffer,context:string){
    const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',this.key(),iv);cipher.setAAD(Buffer.from(context));
    const encrypted=Buffer.concat([cipher.update(data),cipher.final()]);
    return Buffer.concat([iv,cipher.getAuthTag(),encrypted]);
  }
  decrypt(data:Buffer,context:string){
    try {const cipher=createDecipheriv('aes-256-gcm',this.key(),data.subarray(0,12));cipher.setAAD(Buffer.from(context));cipher.setAuthTag(data.subarray(12,28));return Buffer.concat([cipher.update(data.subarray(28)),cipher.final()]);}
    catch {throw new ServiceUnavailableException('Не удалось открыть защищённые данные.');}
  }
  seal(value:unknown,context:string){return this.encrypt(Buffer.from(JSON.stringify(value)),context).toString('base64');}
  open<T>(value:string,context:string):T{return JSON.parse(this.decrypt(Buffer.from(value,'base64'),context).toString('utf8')) as T;}
  hash(value:string){return createHmac('sha256',this.key()).update(value).digest('hex');}
  async image(data:Buffer,face:boolean){
    if(!Buffer.isBuffer(data)||data.length<1024||data.length>8*1024*1024)throw new UnprocessableEntityException('Размер изображения должен быть от 1 КБ до 8 МБ.');
    try {
      const pipeline=sharp(data,{limitInputPixels:24000000,failOn:'warning'});
      const info=await pipeline.metadata();
      if(!['jpeg','png','webp'].includes(info.format||'')||(info.pages||1)!==1||!info.width||!info.height||info.width<(face?480:600)||info.height<(face?480:400))throw Error();
      await pipeline.clone().raw().toBuffer(); // Fully decode, not merely parse headers.
      return {width:info.width,height:info.height,mimeType:`image/${info.format}`};
    } catch {throw new UnprocessableEntityException('Нужен целый JPG, PNG или WebP достаточного размера. Для лица — минимум 480 × 480, для паспорта — 600 × 400.');}
  }
  async put(applicationId:string,kind:string,data:Buffer){
    if(!this.ready())throw new ServiceUnavailableException('Защищённое хранилище пока не настроено.');
    const storageKey=`applications/${applicationId}/${kind.toLowerCase()}/${randomUUID()}.enc`;
    const target=join(process.env.KYC_STORAGE_PATH!,storageKey);
    await mkdir(join(target,'..'),{recursive:true,mode:0o700});
    try {await writeFile(target,this.encrypt(data,storageKey),{mode:0o600,flag:'wx'});}catch{throw new ServiceUnavailableException('Не удалось загрузить документ. Повторите позже.');}
    return storageKey;
  }
  async get(storageKey:string){
    if(!/^applications\/[a-f0-9-]{36}\/(passport_front|passport_back|face)\/[a-f0-9-]{36}\.enc$/.test(storageKey))throw new ServiceUnavailableException('Документ недоступен.');
    try{return this.decrypt(await readFile(join(process.env.KYC_STORAGE_PATH!,storageKey)),storageKey);}catch{throw new ServiceUnavailableException('Документ временно недоступен.');}
  }
}
