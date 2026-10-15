import {Controller,Get,Injectable,Module,Req,UseGuards} from '@nestjs/common';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {AuthModule,AuthRequest,SessionGuard,Actor} from './auth';
import {Database} from './database';
import {requireAccess} from './permission-policy';

const STALE_AFTER=5*60000;
const KEYS=['api','database','tailnet','internet','lan','domain','backup','cloud','usb','disk','realtime','locationApi','locationWorker','retention','map'] as const;
type Check={key:string;label:string;ok:boolean|null;detail:string;since:string|null};

/**
 * Server status for the owner's "Сервер" panel: what scripts/watchdog.cjs last wrote (read-only mount).
 * Only the known fields are passed on; the file holds no personal data.
 */
@Injectable()
export class SystemService{
  constructor(private readonly db:Database){}
  async status(actor:Actor){
    await requireAccess(this.db,actor,'SUPER_ADMIN');
    const dir=process.env.SERVER_STATUS_PATH;
    let raw:any=null;
    if(dir){try{raw=JSON.parse(await readFile(join(dir,'watchdog.json'),'utf8'));}catch{raw=null;}}
    if(!raw||typeof raw.checkedAt!=='string')return {available:false};
    const checkedAt=new Date(raw.checkedAt);
    const checks:Check[]=(Array.isArray(raw.checks)?raw.checks:[]).filter((c:any)=>KEYS.includes(c?.key)).map((c:any)=>({
      key:c.key,label:String(c.label||'').slice(0,80),ok:c.ok===true?true:c.ok===false?false:null,detail:String(c.detail||'').slice(0,160),since:typeof c.since==='string'?c.since:null,
    }));
    const num=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?v:null;
    return {
      available:true,
      checkedAt:checkedAt.toISOString(),
      // The watchdog writes every minute; an old file means the watchdog itself has stopped.
      stale:!(Date.now()-checkedAt.getTime()<STALE_AFTER),
      checks,
      backup:raw.backup&&typeof raw.backup.at==='string'?{at:raw.backup.at,bytes:num(raw.backup.bytes),documents:num(raw.backup.documents)}:null,
      disk:raw.disk?{free:num(raw.disk.free),total:num(raw.disk.total)}:null,
      telegram:raw.telegram===true,
    };
  }
}

@Controller('system') @UseGuards(SessionGuard)
class SystemController{
  constructor(private readonly service:SystemService){}
  @Get('status') status(@Req() req:AuthRequest){return this.service.status(req.actor);}
}

@Module({imports:[AuthModule],providers:[SystemService],controllers:[SystemController]})
export class SystemModule{}
