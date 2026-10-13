import {Global,Injectable,Logger,Module,OnModuleDestroy,OnModuleInit} from '@nestjs/common';
import {Prisma} from '@prisma/client';
import {IncomingMessage,Server} from 'node:http';
import {Client} from 'pg';
import {WebSocket,WebSocketServer} from 'ws';
import {Database} from './database';
import {PermissionCode,isSuperAdmin} from './permission-policy';
import {PermissionModule,PermissionService} from './permissions';
import {digest} from './security';
import {allowedOrigins} from './origins';

/**
 * One realtime channel for the whole app. Events carry only a topic, a type and an id, never personal data;
 * clients refetch what they are allowed to see. Events are published with pg_notify inside the writing
 * transaction, so PostgreSQL delivers them only after commit, and never for a rolled-back action.
 */
export type RealtimeEvent={
  p:string;                 // property
  topic:'applications'|'tickets'|'finance'|'house'|'notifications';
  type:string;
  id?:string;
  need?:PermissionCode[];   // staff: any of these (owners always); omitted = every staff member of the property
  users?:string[];          // staff: only these users
  residents?:string[];      // tenants: only these residents
  staff?:false;             // not for staff sockets at all
};
type StaffClient={kind:'staff';token:string;userId:string;propertyId:string;superAdmin:boolean;grants:string};
type TenantClient={kind:'tenant';token:string;accountId:string;residentId:string;propertyId:string};
type Conn=StaffClient|TenantClient;
const CHANNEL='ijara_events';
const MAX_SOCKETS=500,MAX_PER_PERSON=10;

export async function publish(db:Prisma.TransactionClient|Database,event:RealtimeEvent){
  await db.$executeRaw`SELECT pg_notify(${CHANNEL}, ${JSON.stringify(event)})`;
}

function token(req:IncomingMessage,cookieName:string){
  const cookie=(req.headers.cookie||'').split(';').map(c=>c.trim()).find(c=>c.startsWith(cookieName+'='))?.slice(cookieName.length+1);
  const auth=req.headers.authorization;const bearer=typeof auth==='string'&&auth.startsWith('Bearer ')?auth.slice(7).trim():undefined;
  // Browsers send the cookie and an allowed Origin; native apps send a bearer token and no Origin.
  if(req.headers.origin){
    if(!allowedOrigins(process.env.APP_ORIGIN!,process.env.ADDITIONAL_APP_ORIGINS,process.env.NODE_ENV==='production').has(req.headers.origin))return null;
    return cookie??null;
  }
  return !cookie&&bearer?bearer:null;
}

@Injectable()
export class RealtimeHub implements OnModuleInit,OnModuleDestroy{
  private readonly logger=new Logger(RealtimeHub.name);
  private server?:WebSocketServer;
  private clients=new Map<WebSocket,Conn>();
  private timer?:NodeJS.Timeout;
  private listener?:Client;
  private retry?:NodeJS.Timeout;
  private closing=false;
  constructor(private readonly db:Database,private readonly permissions:PermissionService){}

  async onModuleInit(){await this.listen();}
  private async listen(){
    if(this.closing)return;
    const client=new Client({connectionString:process.env.DATABASE_URL});
    client.on('notification',m=>{if(m.channel===CHANNEL&&m.payload){try{this.deliver(JSON.parse(m.payload) as RealtimeEvent);}catch{/* malformed payloads are ignored */}}});
    client.on('error',()=>{void this.reconnect(client);});
    client.on('end',()=>{void this.reconnect(client);});
    try{await client.connect();await client.query(`LISTEN ${CHANNEL}`);this.listener=client;}
    catch{await this.reconnect(client);}
  }
  private async reconnect(client:Client){
    if(this.closing||this.retry||(this.listener&&this.listener!==client))return;
    this.listener=undefined;client.removeAllListeners();client.end().catch(()=>undefined);
    this.logger.warn('Realtime listener lost the database; reconnecting.');
    // Events may have been missed while disconnected: every client refetches.
    this.broadcast({type:'resync'});
    this.retry=setTimeout(()=>{this.retry=undefined;void this.listen();},2000);this.retry.unref();
  }

  attach(http:Server){
    this.server=new WebSocketServer({noServer:true,maxPayload:1024,perMessageDeflate:false});
    http.on('upgrade',async(req,socket,head)=>{
      try{
        const path=(req.url||'').split('?')[0];
        if(path!=='/api/events'&&path!=='/api/tenant/events'){socket.destroy();return;}
        const raw=token(req,path==='/api/events'?'ijara_session':'ijara_tenant');
        if(!raw||raw.length>200||this.clients.size>=MAX_SOCKETS){socket.destroy();return;}
        const conn=path==='/api/events'?await this.staff(digest(raw)):await this.tenant(digest(raw));
        if(!conn||this.count(conn)>=MAX_PER_PERSON){socket.destroy();return;}
        this.server!.handleUpgrade(req,socket,head,ws=>{
          this.clients.set(ws,conn);
          ws.on('close',()=>this.clients.delete(ws));ws.on('error',()=>ws.terminate());ws.on('message',()=>ws.close(1008));
          ws.send(JSON.stringify({type:'ready'}));
        });
      }catch{socket.destroy();}
    });
    this.timer=setInterval(()=>{void this.revalidate();},5000);this.timer.unref();
  }
  private count(c:Conn){let n=0;for(const x of this.clients.values())if(c.kind==='staff'?x.kind==='staff'&&x.userId===c.userId:x.kind==='tenant'&&x.accountId===c.accountId)n++;return n;}
  private async staff(tokenHash:string):Promise<StaffClient|null>{
    const s=await this.db.session.findUnique({where:{tokenHash},include:{user:true}});
    if(!s||s.expiresAt<=new Date()||!s.user.active)return null;
    try{const grants=await this.permissions.allowed(s.user);return {kind:'staff',token:tokenHash,userId:s.user.id,propertyId:s.user.propertyId,superAdmin:isSuperAdmin(s.user.role),grants:[...grants].sort().join(',')};}catch{return null;}
  }
  private async tenant(tokenHash:string):Promise<TenantClient|null>{
    const s=await this.db.tenantSession.findUnique({where:{tokenHash},include:{account:{include:{resident:{select:{property:{select:{active:true}}}}}}}});
    if(!s||s.expiresAt<=new Date()||!s.account.active||!s.account.resident.property.active)return null;
    return {kind:'tenant',token:tokenHash,accountId:s.accountId,residentId:s.account.residentId,propertyId:s.account.propertyId};
  }
  /** Sessions end and rights change while sockets stay open: re-check every few seconds. */
  private async revalidate(){
    for(const [ws,c] of this.clients){
      try{
        const now=c.kind==='staff'?await this.staff(c.token):await this.tenant(c.token);
        if(!now){ws.close(1008);continue;}
        if(now.kind==='staff'&&c.kind==='staff'&&now.grants!==c.grants){this.clients.set(ws,now);ws.send(JSON.stringify({type:'permissions.changed'}));}
        ws.ping();
      }catch{ws.close(1011);}
    }
  }
  private allowed(c:Conn,e:RealtimeEvent){
    if(c.propertyId!==e.p)return false;
    if(c.kind==='tenant')return !!e.residents?.includes(c.residentId);
    if(e.staff===false)return false;
    if(e.users&&!e.users.includes(c.userId))return false;
    if(e.need&&!c.superAdmin&&!e.need.some(n=>c.grants.split(',').includes(n)))return false;
    return true;
  }
  deliver(e:RealtimeEvent){
    const message=JSON.stringify({topic:e.topic,type:e.type,...(e.id?{id:e.id}:{})});
    for(const [ws,c] of this.clients)if(ws.readyState===WebSocket.OPEN&&this.allowed(c,e))ws.send(message);
  }
  private broadcast(m:object){const s=JSON.stringify(m);for(const ws of this.clients.keys())if(ws.readyState===WebSocket.OPEN)ws.send(s);}
  async onModuleDestroy(){
    this.closing=true;if(this.timer)clearInterval(this.timer);if(this.retry)clearTimeout(this.retry);
    for(const ws of this.clients.keys())ws.terminate();this.server?.close();
    const l=this.listener;this.listener=undefined;if(l){l.removeAllListeners();await l.end().catch(()=>undefined);}
  }
}

@Global()
@Module({imports:[PermissionModule],providers:[RealtimeHub],exports:[RealtimeHub]})
export class RealtimeModule{}
