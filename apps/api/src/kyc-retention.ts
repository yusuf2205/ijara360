import {Injectable,Logger,OnModuleDestroy,OnModuleInit} from '@nestjs/common';
import {Prisma,RentalApplication} from '@prisma/client';
import {ApplicationService} from './applications.service';
import {Database} from './database';
import {PrivateStorage} from './private-storage';

// Residents: documents, PINFL and passport number are kept 2 years after check-out.
// Rejected and cancelled applications: all personal data is kept 1 week. The database functions hold both periods.
@Injectable()
export class KycRetentionService implements OnModuleInit,OnModuleDestroy{
  private readonly log=new Logger('KycRetention');
  private timer?:ReturnType<typeof setInterval>;
  lastRun:Date|null=null;
  constructor(private readonly db:Database,private readonly storage:PrivateStorage,private readonly applications:ApplicationService){}
  onModuleInit(){if(process.env.NODE_ENV!=='test'){this.timer=setInterval(()=>void this.tick(),3600000);this.timer.unref();}}
  onModuleDestroy(){if(this.timer)clearInterval(this.timer);}
  // Midday only: the night backup checks its archive against its dump, so a purge between the two would fail it.
  private async tick(){
    if(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Tashkent',hour:'2-digit'}).format(new Date())!=='13')return;
    try{await this.purge();}catch{this.log.error('KYC retention worker failed');}
  }
  async purge(){
    if(!this.storage.ready())throw new Error('Storage is not configured.');
    const residents=await this.db.$queryRaw<{id:string}[]>`SELECT id FROM rental_applications WHERE status='CONVERTED_TO_RESIDENT' AND documents_purged_at IS NULL AND kyc_documents_expired(resident_id)`;
    const closed=await this.db.$queryRaw<{id:string}[]>`SELECT id FROM rental_applications WHERE status IN ('REJECTED','CANCELLED') AND profile_purged_at IS NULL AND updated_at<=CURRENT_TIMESTAMP-INTERVAL '7 days'`;
    const load=(rows:{id:string}[])=>this.db.rentalApplication.findMany({where:{id:{in:rows.map(r=>r.id)}}});
    const results=[
      ...await this.each(await load(residents),'2_YEARS_AFTER_CHECK_OUT',(tx,a)=>{
        const {pinfl:_p,passportSeries:_s,passportNumber:_n,...cleaned}=this.applications.profile(a);
        return tx.$queryRaw<{documents:number}[]>`SELECT kyc_purge_application_documents(${a.id}::uuid,${this.storage.seal(cleaned,`application:${a.id}`)}) AS documents`;
      }),
      ...await this.each(await load(closed),'1_WEEK_AFTER_CLOSING',(tx,a)=>tx.$queryRaw<{documents:number}[]>`SELECT kyc_purge_closed_application(${a.id}::uuid,${this.storage.seal({},`application:${a.id}`)}) AS documents`),
    ];
    this.lastRun=new Date();
    return {purged:results.filter(Boolean).length,failed:results.filter(r=>!r).length};
  }
  private async each(items:RentalApplication[],policy:string,purge:(tx:Prisma.TransactionClient,a:RentalApplication)=>Promise<{documents:number}[]>){
    const results:boolean[]=[];
    for(const a of items){
      try{
        // Files go last, inside the transaction: if anything fails the rows stay and the next run retries.
        await this.db.$transaction(async tx=>{
          const [{documents}]=await purge(tx,a);
          await this.applications.audit(tx,a,'KYC_DATA_PURGED',null,{documents,policy});
          await this.storage.removeApplication(a.id);
        },{maxWait:10000,timeout:30000});
        await this.applications.event(a,'data_purged');
        results.push(true);
      }catch{results.push(false);this.log.error(`Could not purge the data of application ${a.id}`);}
    }
    return results;
  }
}
