import {Body,ConflictException,Controller,Get,HttpCode,Injectable,Module,NotFoundException,OnModuleDestroy,OnModuleInit,Param,ParseUUIDPipe,Post,Query,Req,UseGuards} from '@nestjs/common';
import {Prisma} from '@prisma/client';
import {Type} from 'class-transformer';
import {ArrayMaxSize,IsArray,IsBoolean,IsIn,IsISO8601,IsInt,IsNumber,IsOptional,Max,Min,ValidateNested} from 'class-validator';
import {Actor,AuthModule,AuthRequest,AuthService,SessionGuard} from './auth';
import {Database} from './database';
import {requireAccess} from './permission-policy';
import {publish} from './realtime';
import {Tenant,TenantGuard,TenantModule,TenantRequest} from './tenant';

/**
 * M7 geolocation (docs/M7-LOCATION.md). The tenant session decides whose position it is: the client never
 * names a resident. PostgreSQL is the source of truth; realtime events are sent with pg_notify inside the
 * writing transaction, so they leave only after commit. Coordinates never go to logs, audit or Telegram.
 */
const num=(name:string,fallback:number)=>{const v=Number(process.env[name]);return Number.isFinite(v)&&v>0?v:fallback;};
export const locationPolicy={
  liveSeconds:num('LOCATION_LIVE_SECONDS',180),
  // Background updates without a foreground notification come every 15+ minutes on Android (WorkManager).
  staleSeconds:num('LOCATION_STALE_SECONDS',2100),
  retentionDays:num('LOCATION_HISTORY_RETENTION_DAYS',30),
  maxAccuracyMeters:5000,
  maxFutureSeconds:120,
  maxBufferedHours:72,
  // Faster than this between two points is a GPS glitch, not travel (~300 km/h).
  maxSpeedMps:85,
};
export type LocationStatus='LIVE'|'STALE'|'OFFLINE'|'LOCATION_DISABLED';

type Row={sharingEnabled:boolean;permissionState:string;servicesEnabled:boolean|null;recordedAt:Date|null;lastSeenAt:Date};
/** Public status + reason. Disabled only when the app reliably said so; silence after that is OFFLINE. */
export function statusOf(r:Row|null,now=new Date()):{status:LocationStatus;reason:string}{
  if(!r||!r.sharingEnabled)return {status:'LOCATION_DISABLED',reason:r?'SHARING_OFF':'NOT_ENABLED'};
  const silent=(now.getTime()-r.lastSeenAt.getTime())/1000>locationPolicy.staleSeconds;
  if(r.permissionState==='DENIED'||r.servicesEnabled===false)return silent?{status:'OFFLINE',reason:'NO_CONTACT'}:{status:'LOCATION_DISABLED',reason:r.permissionState==='DENIED'?'PERMISSION_DENIED':'SERVICES_OFF'};
  if(!r.recordedAt)return {status:'OFFLINE',reason:silent?'NO_CONTACT':'WAITING_FIRST_POINT'};
  const age=(now.getTime()-r.recordedAt.getTime())/1000;
  if(age<=locationPolicy.liveSeconds)return {status:'LIVE',reason:'OK'};
  if(age<=locationPolicy.staleSeconds)return {status:'STALE',reason:'OLD_POINT'};
  return {status:'OFFLINE',reason:silent?'NO_CONTACT':'NO_FRESH_POINT'};
}

function metersBetween(a:{lat:number;lon:number},b:{lat:number;lon:number}){
  const r=6371000,rad=Math.PI/180,dLat=(b.lat-a.lat)*rad,dLon=(b.lon-a.lon)*rad;
  const h=Math.sin(dLat/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(dLon/2)**2;
  return 2*r*Math.asin(Math.min(1,Math.sqrt(h)));
}

class PointDto{
  @IsNumber({allowNaN:false,allowInfinity:false}) @Min(-90) @Max(90) latitude!:number;
  @IsNumber({allowNaN:false,allowInfinity:false}) @Min(-180) @Max(180) longitude!:number;
  @IsNumber({allowNaN:false,allowInfinity:false}) @Min(0.1) @Max(100000) accuracyMeters!:number;
  @IsISO8601({strict:true}) recordedAt!:string;
  @IsInt() @Min(0) @Max(Number.MAX_SAFE_INTEGER) sequence!:number;
}
class DeviceStateDto{
  @IsIn(['ALWAYS','WHILE_IN_USE','DENIED','UNKNOWN']) permission!:string;
  @IsBoolean() servicesEnabled!:boolean;
  @IsIn(['ALLOWED','RESTRICTED','UNKNOWN']) background!:string;
}
export class UploadDto{
  @IsArray() @ArrayMaxSize(100) @ValidateNested({each:true}) @Type(()=>PointDto) points!:PointDto[];
  @IsOptional() @ValidateNested() @Type(()=>DeviceStateDto) state?:DeviceStateDto;
}
export class ConsentDto{@IsBoolean() enabled!:boolean;}
class HistoryQuery{
  @IsISO8601({strict:true}) from!:string;
  @IsISO8601({strict:true}) to!:string;
}

const residentSelect={id:true,fullName:true,photoUrl:true,occupancies:{where:{status:'ACTIVE' as const},select:{room:{select:{number:true}},bed:{select:{number:true}}},take:1}};

@Injectable()
export class LocationService implements OnModuleInit,OnModuleDestroy{
  private statusTimer?:ReturnType<typeof setInterval>;
  private retentionTimer?:ReturnType<typeof setInterval>;
  /** Worker heartbeats for /api/health and the M6 watchdog. */
  readonly beats={status:null as Date|null,retention:null as Date|null,ingest:null as Date|null};
  /** Whether Yandex accepts the map key for the staff origins: null until checked or without a key. */
  mapKey:'ok'|'rejected'|'unknown'|null=null;
  private mapTimer?:ReturnType<typeof setInterval>;
  constructor(private readonly db:Database,private readonly auth:AuthService){}

  onModuleInit(){
    if(process.env.NODE_ENV==='test')return;
    this.statusTimer=setInterval(()=>void this.refreshStatuses().catch(()=>console.log('location status worker failed')),30000);this.statusTimer.unref();
    this.retentionTimer=setInterval(()=>void this.retention().catch(()=>console.log('location retention worker failed')),3600000);this.retentionTimer.unref();
    void this.checkMapKey();
    this.mapTimer=setInterval(()=>void this.checkMapKey(),3600000);this.mapTimer.unref();
    void this.refreshStatuses().catch(()=>undefined);void this.retention().catch(()=>undefined);
  }
  onModuleDestroy(){if(this.statusTimer)clearInterval(this.statusTimer);if(this.retentionTimer)clearInterval(this.retentionTimer);}

  private event(tx:Prisma.TransactionClient,p:string,residentId:string,type:'resident.location.updated'|'resident.location.status_changed',data:Record<string,string|number|boolean|null>){
    return publish(tx,{p,topic:'location',type,id:residentId,need:['VIEW_LOCATION'],residents:[residentId],data:{residentId,...data}});
  }
  private async activeOccupancy(tx:Prisma.TransactionClient,t:Tenant){
    return tx.occupancy.findFirst({where:{residentId:t.residentId,propertyId:t.propertyId,status:'ACTIVE'},select:{id:true}});
  }

  // ---- tenant ------------------------------------------------------------------------------

  async mine(t:Tenant,sessionId:string){
    const [row,active]=await Promise.all([this.db.residentLocation.findUnique({where:{residentId:t.residentId}}),this.activeOccupancy(this.db,t)]);
    const {status,reason}=statusOf(row);
    return {
      resident:Boolean(active),
      sharingEnabled:Boolean(row?.sharingEnabled),
      thisDeviceIsPrimary:row?.primarySessionId===sessionId,
      primaryDevice:row?.deviceLabel??null,
      status,reason,
      lastSentAt:row?.recordedAt??null,
      accuracyMeters:row?.accuracyM??null,
      lastSeenAt:row?.lastSeenAt??null,
      policy:{liveSeconds:locationPolicy.liveSeconds,staleSeconds:locationPolicy.staleSeconds,retentionDays:locationPolicy.retentionDays},
    };
  }

  /** Turn sharing on (this device becomes the primary one) or off. Stopped for residents who moved out. */
  async consent(t:Tenant,sessionId:string,dto:ConsentDto){
    const result=await this.db.$transaction(async tx=>{
      if(dto.enabled&&!await this.activeOccupancy(tx,t))throw new ConflictException({code:'NOT_RESIDENT',message:'Передача местоположения доступна только жильцам с действующим проживанием.'});
      const session=await tx.tenantSession.findUniqueOrThrow({where:{id:sessionId},select:{deviceName:true,platform:true}});
      const now=new Date();
      const row=await tx.residentLocation.upsert({
        where:{residentId:t.residentId},
        create:{residentId:t.residentId,propertyId:t.propertyId,sharingEnabled:dto.enabled,consentedAt:dto.enabled?now:null,withdrawnAt:dto.enabled?null:now,primarySessionId:dto.enabled?sessionId:null,deviceLabel:dto.enabled?(session.deviceName||session.platform):null,lastSeenAt:now},
        update:dto.enabled?{sharingEnabled:true,consentedAt:now,withdrawnAt:null,primarySessionId:sessionId,deviceLabel:session.deviceName||session.platform,lastSeenAt:now,updatedAt:now}
          :{sharingEnabled:false,withdrawnAt:now,primarySessionId:null,lastSeenAt:now,updatedAt:now},
      });
      await tx.auditLog.create({data:{propertyId:t.propertyId,actorId:null,action:dto.enabled?'LOCATION_SHARING_ENABLED':'LOCATION_SHARING_DISABLED',entity:'Resident',entityId:t.residentId,metadata:{}}});
      await this.applyStatus(tx,row,now);
      return row;
    });
    return {sharingEnabled:result.sharingEnabled};
  }

  /** Points (live or buffered, up to 100) and device telemetry. Light: no finance, no external calls. */
  async upload(t:Tenant,sessionId:string,dto:UploadDto){
    await this.auth.rateLimit('location-upload',sessionId,240);
    const now=new Date();
    this.beats.ingest=now;
    return this.db.$transaction(async tx=>{
      if(!await this.activeOccupancy(tx,t))throw new ConflictException({code:'NOT_RESIDENT',message:'Проживание завершено: передача местоположения остановлена.'});
      const rows=await tx.$queryRaw<{sharing_enabled:boolean;primary_session_id:string|null}[]>`SELECT sharing_enabled,primary_session_id FROM resident_locations WHERE resident_id=${t.residentId}::uuid FOR UPDATE`;
      const lock=rows[0];
      if(!lock?.sharing_enabled)throw new ConflictException({code:'SHARING_OFF',message:'Передача местоположения выключена.'});
      if(lock.primary_session_id!==sessionId)throw new ConflictException({code:'NOT_PRIMARY',message:'Местоположение передаёт другой ваш телефон.'});
      const current=await tx.residentLocation.findUniqueOrThrow({where:{residentId:t.residentId}});

      // Validate, oldest first, against the newest accepted point so far (impossible jumps are glitches).
      const sorted=[...dto.points].sort((a,b)=>Date.parse(a.recordedAt)-Date.parse(b.recordedAt));
      let anchor=current.recordedAt&&current.latitude!=null&&current.longitude!=null?{lat:current.latitude,lon:current.longitude,at:current.recordedAt.getTime()}:null;
      const keep:PointDto[]=[];let rejected=0;
      for(const p of sorted){
        const at=Date.parse(p.recordedAt);
        const bad=at>now.getTime()+locationPolicy.maxFutureSeconds*1000||at<now.getTime()-locationPolicy.maxBufferedHours*3600000||p.accuracyMeters>locationPolicy.maxAccuracyMeters;
        if(bad){rejected++;continue;}
        if(anchor&&at>anchor.at){
          const speed=metersBetween(anchor,{lat:p.latitude,lon:p.longitude})/((at-anchor.at)/1000);
          if(speed>locationPolicy.maxSpeedMps){rejected++;continue;}
        }
        keep.push(p);
        if(!anchor||at>anchor.at)anchor={lat:p.latitude,lon:p.longitude,at};
      }
      let accepted=0;
      if(keep.length){
        const values=Prisma.join(keep.map(p=>Prisma.sql`(${t.residentId}::uuid,${t.propertyId}::uuid,${sessionId}::uuid,${BigInt(p.sequence)},${p.latitude},${p.longitude},${p.accuracyMeters}::real,${new Date(p.recordedAt)},${now})`));
        accepted=await tx.$executeRaw`INSERT INTO resident_location_points (resident_id,property_id,session_id,sequence,latitude,longitude,accuracy_m,recorded_at,received_at) VALUES ${values} ON CONFLICT (session_id,sequence) DO NOTHING`;
      }
      // Current position: the newest legitimate point only. An older buffered point never replaces it.
      const newest=keep.at(-1);
      const advances=Boolean(newest&&(!current.recordedAt||Date.parse(newest.recordedAt)>current.recordedAt.getTime()));
      const data:Prisma.ResidentLocationUpdateInput={lastSeenAt:now,updatedAt:now};
      if(dto.state)Object.assign(data,{permissionState:dto.state.permission,servicesEnabled:dto.state.servicesEnabled,backgroundState:dto.state.background});
      if(advances&&newest)Object.assign(data,{latitude:newest.latitude,longitude:newest.longitude,accuracyM:newest.accuracyMeters,recordedAt:new Date(newest.recordedAt),receivedAt:now});
      const row=await tx.residentLocation.update({where:{residentId:t.residentId},data});
      const changed=await this.applyStatus(tx,row,now);
      if(advances&&!changed)await this.event(tx,t.propertyId,t.residentId,'resident.location.updated',this.payload(row,statusOf(row,now).status));
      return {accepted,duplicates:keep.length-accepted,rejected,status:statusOf(row,now).status};
    });
  }

  private payload(r:{latitude:number|null;longitude:number|null;accuracyM:number|null;recordedAt:Date|null},status:LocationStatus){
    return {latitude:r.latitude,longitude:r.longitude,accuracy:r.accuracyM,recordedAt:r.recordedAt?.toISOString()??null,status};
  }

  /** Stores the computed status; on a change publishes status_changed (with the position) after commit. */
  private async applyStatus(tx:Prisma.TransactionClient,row:Prisma.ResidentLocationGetPayload<object>,now:Date){
    const next=statusOf(row,now);
    if(next.status===row.status&&next.reason===row.statusReason)return false;
    await tx.residentLocation.update({where:{residentId:row.residentId},data:{status:next.status,statusReason:next.reason,...(next.status!==row.status?{statusChangedAt:now}:{})}});
    if(next.status!==row.status)await this.event(tx,row.propertyId,row.residentId,'resident.location.status_changed',{...this.payload(row,next.status),previous:row.status});
    return next.status!==row.status;
  }

  // ---- workers -----------------------------------------------------------------------------

  /** LIVE → STALE → OFFLINE happen with no new points: recompute every row by time. */
  async refreshStatuses(now=new Date()){
    await this.db.$transaction(async tx=>{
      // One worker at a time across restarts or replicas.
      const [{ok}]=await tx.$queryRaw<{ok:boolean}[]>`SELECT pg_try_advisory_xact_lock(hashtext('ijara_location_status')) AS ok`;
      if(!ok)return;
      // Moved out: tracking stops and the current position goes; history stays until retention removes it.
      const gone=await tx.$queryRaw<{resident_id:string;property_id:string;status:string}[]>`
        DELETE FROM resident_locations l WHERE NOT EXISTS (SELECT 1 FROM occupancies o WHERE o.resident_id=l.resident_id AND o.status='ACTIVE')
        RETURNING resident_id,property_id,status`;
      for(const g of gone){
        await tx.auditLog.create({data:{propertyId:g.property_id,actorId:null,action:'LOCATION_STOPPED_AT_CHECKOUT',entity:'Resident',entityId:g.resident_id,metadata:{}}});
        await this.event(tx,g.property_id,g.resident_id,'resident.location.status_changed',{latitude:null,longitude:null,accuracy:null,recordedAt:null,status:'LOCATION_DISABLED',previous:g.status,removed:true});
      }
      const rows=await tx.residentLocation.findMany();
      for(const row of rows)await this.applyStatus(tx,row,now);
    });
    this.beats.status=new Date();
  }

  /** History older than the policy is deleted; the audit keeps only how many points went. */
  async retention(now=new Date()){
    const cutoff=new Date(now.getTime()-locationPolicy.retentionDays*86400000);
    const deleted=await this.db.$queryRaw<{property_id:string;n:bigint}[]>`
      WITH d AS (DELETE FROM resident_location_points WHERE recorded_at<${cutoff} RETURNING property_id) SELECT property_id,count(*)::bigint AS n FROM d GROUP BY property_id`;
    for(const d of deleted)await this.db.auditLog.create({data:{propertyId:d.property_id,actorId:null,action:'LOCATION_HISTORY_PURGED',entity:'Property',entityId:d.property_id,metadata:{points:Number(d.n),olderThanDays:locationPolicy.retentionDays}}});
    this.beats.retention=new Date();
    return deleted.reduce((s,d)=>s+Number(d.n),0);
  }

  // ---- staff -------------------------------------------------------------------------------

  private card(r:{id:string;fullName:string;photoUrl:string|null;occupancies:{room:{number:string};bed:{number:string}}[]},l:Prisma.ResidentLocationGetPayload<object>|null,now:Date){
    const {status,reason}=statusOf(l,now);
    const o=r.occupancies[0];
    return {
      residentId:r.id,fullName:r.fullName,photoUrl:r.photoUrl,room:o?.room.number??null,bed:o?.bed.number??null,
      status,reason,
      // STALE/OFFLINE/DISABLED keep the last known point; the UI labels it "Последняя известная позиция".
      position:l?.recordedAt&&l.latitude!=null&&l.longitude!=null?{latitude:l.latitude,longitude:l.longitude,accuracy:l.accuracyM,recordedAt:l.recordedAt,current:status==='LIVE'}:null,
      lastSeenAt:l?.lastSeenAt??null,device:l?.deviceLabel??null,
      permission:l?.permissionState??null,background:l?.backgroundState??null,sharingEnabled:Boolean(l?.sharingEnabled),
    };
  }

  /** Every resident with an active occupancy, sharing or not. */
  async list(actor:Actor){
    await requireAccess(this.db,actor,'VIEW_LOCATION');
    const now=new Date();
    const residents=await this.db.resident.findMany({where:{propertyId:actor.propertyId,occupancies:{some:{status:'ACTIVE'}}},select:{...residentSelect,location:true},orderBy:{fullName:'asc'}});
    const items=residents.map(r=>this.card(r,r.location,now));
    const counts={ALL:items.length,LIVE:0,STALE:0,OFFLINE:0,LOCATION_DISABLED:0} as Record<string,number>;
    for(const i of items)counts[i.status]++;
    return {items,counts,policy:{liveSeconds:locationPolicy.liveSeconds,staleSeconds:locationPolicy.staleSeconds}};
  }

  /** The authoritative "where is this resident now" (also for the future M9 assistant). */
  async getCurrentResidentLocation(actor:Actor,residentId:string){
    await requireAccess(this.db,actor,'VIEW_LOCATION');
    const r=await this.db.resident.findFirst({where:{id:residentId,propertyId:actor.propertyId},select:{...residentSelect,location:true}});
    if(!r)throw new NotFoundException('Жилец не найден.');
    await this.db.auditLog.create({data:{propertyId:actor.propertyId,actorId:actor.id,action:'RESIDENT_LOCATION_VIEWED',entity:'Resident',entityId:residentId,metadata:{}}});
    return this.card(r,r.location,new Date());
  }

  async history(actor:Actor,residentId:string,q:HistoryQuery){
    const access=await requireAccess(this.db,actor,'VIEW_LOCATION_HISTORY');
    if(!access.superAdmin)await requireAccess(this.db,actor,'VIEW_LOCATION');
    const from=new Date(q.from),to=new Date(q.to);
    if(!(from<to)||to.getTime()-from.getTime()>31*86400000)throw new ConflictException('Период истории — до 31 дня.');
    const r=await this.db.resident.findFirst({where:{id:residentId,propertyId:actor.propertyId},select:{id:true}});
    if(!r)throw new NotFoundException('Жилец не найден.');
    const points=await this.db.residentLocationPoint.findMany({where:{residentId,propertyId:actor.propertyId,recordedAt:{gte:from,lt:to}},orderBy:{recordedAt:'asc'},take:5000,select:{latitude:true,longitude:true,accuracyM:true,recordedAt:true}});
    await this.db.auditLog.create({data:{propertyId:actor.propertyId,actorId:actor.id,action:'RESIDENT_LOCATION_HISTORY_VIEWED',entity:'Resident',entityId:residentId,metadata:{from:from.toISOString(),to:to.toISOString(),points:points.length}}});
    return {points:points.map(p=>({latitude:p.latitude,longitude:p.longitude,accuracy:p.accuracyM,recordedAt:p.recordedAt})),retentionDays:locationPolicy.retentionDays,truncated:points.length===5000};
  }

  /**
   * JS API 3.0 answers 403 "Invalid api key" for a wrong key, a key of another product, a key without an
   * HTTP Referer restriction, or an origin missing from it. Asks with each staff origin as the Referer,
   * the way a browser on the map page does. Never logs the key.
   */
  async checkMapKey(){
    const key=process.env.YANDEX_MAPS_API_KEY||'';
    if(!key){this.mapKey=null;return;}
    const origins=[process.env.APP_ORIGIN,...(process.env.ADDITIONAL_APP_ORIGINS||'').split(',')].map(o=>o?.trim()).filter((o):o is string=>Boolean(o));
    let result:'ok'|'rejected'|'unknown'='ok';
    for(const origin of origins.length?origins:['']){
      try{
        const r=await fetch(`https://api-maps.yandex.ru/v3/?apikey=${encodeURIComponent(key)}&lang=ru_RU`,{headers:origin?{Referer:`${origin}/`}:{},signal:AbortSignal.timeout(15000)});
        await r.body?.cancel();
        if(r.status===403){result='rejected';break;}
        if(!r.ok)result='unknown';
      }catch{result='unknown';}
    }
    this.mapKey=result;
  }

  /** Map key for staff who may see locations; never in the source or the client bundle. */
  async mapConfig(actor:Actor){
    await requireAccess(this.db,actor,'VIEW_LOCATION');
    const key=process.env.YANDEX_MAPS_API_KEY||'';
    return key?{provider:'yandex',apiKey:key}:{provider:null,apiKey:null};
  }
}

@Controller('tenant/location') @UseGuards(TenantGuard)
class TenantLocationController{
  constructor(private readonly service:LocationService){}
  @Get() mine(@Req() req:TenantRequest){return this.service.mine(req.tenant,req.tenantSessionId);}
  @Post('consent') @HttpCode(200) consent(@Req() req:TenantRequest,@Body() dto:ConsentDto){return this.service.consent(req.tenant,req.tenantSessionId,dto);}
  @Post() @HttpCode(200) upload(@Req() req:TenantRequest,@Body() dto:UploadDto){return this.service.upload(req.tenant,req.tenantSessionId,dto);}
}

@Controller() @UseGuards(SessionGuard)
class StaffLocationController{
  constructor(private readonly service:LocationService){}
  @Get('locations') list(@Req() req:AuthRequest){return this.service.list(req.actor);}
  @Get('residents/:id/location') one(@Req() req:AuthRequest,@Param('id',ParseUUIDPipe) id:string){return this.service.getCurrentResidentLocation(req.actor,id);}
  @Get('residents/:id/location/history') history(@Req() req:AuthRequest,@Param('id',ParseUUIDPipe) id:string,@Query() q:HistoryQuery){return this.service.history(req.actor,id,q);}
  @Get('map/config') map(@Req() req:AuthRequest){return this.service.mapConfig(req.actor);}
}

@Module({imports:[AuthModule,TenantModule],providers:[LocationService],controllers:[TenantLocationController,StaffLocationController],exports:[LocationService]})
export class LocationModule{}
