import {Injectable,OnModuleDestroy} from '@nestjs/common';
import {Server} from 'node:http';
import {WebSocket,WebSocketServer} from 'ws';
import {Database} from './database';
import {PermissionService} from './permissions';
import {digest} from './security';
import {allowedOrigins} from './origins';

@Injectable()
export class ApplicationEvents implements OnModuleDestroy {
  private server?:WebSocketServer;
  private clients=new Map<WebSocket,string>();
  private timer?:NodeJS.Timeout;
  private grants=new WeakMap<WebSocket,string>();
  constructor(private readonly db:Database,private readonly permissions:PermissionService){}
  private async session(token:string){
    const session=await this.db.session.findUnique({where:{tokenHash:token},include:{user:true}});
    if(!session||session.expiresAt<=new Date())return null;
    try{const grants=await this.permissions.require(session.user,'APPLICATION_VIEW');return {...session.user,grants};}catch{return null;}
  }
  attach(http:Server){
    this.server=new WebSocketServer({noServer:true,maxPayload:1024,perMessageDeflate:false});
    http.on('upgrade',async(req,socket,head)=>{
      if(req.url!=='/api/events'){socket.destroy();return;}
      try {
        if(!allowedOrigins(process.env.APP_ORIGIN!,process.env.ADDITIONAL_APP_ORIGINS,process.env.NODE_ENV==='production').has(req.headers.origin||'')){socket.destroy();return;}
        const raw=(req.headers.cookie||'').split(';').map(c=>c.trim()).find(c=>c.startsWith('ijara_session='))?.slice(14);
        if(!raw||raw.length>200||this.clients.size>=500){socket.destroy();return;}
        const token=digest(raw);const user=await this.session(token);if(!user){socket.destroy();return;}
        this.server!.handleUpgrade(req,socket,head,ws=>{this.clients.set(ws,token);this.grants.set(ws,JSON.stringify(user.grants.sort()));ws.on('close',()=>this.clients.delete(ws));ws.on('error',()=>ws.terminate());ws.on('message',()=>ws.close(1008));ws.send(JSON.stringify({type:'ready'}));});
      }catch{socket.destroy();}
    });
    this.timer=setInterval(()=>{void this.revalidate();},5000);this.timer.unref();
  }
  private async revalidate(){for(const [ws,token] of this.clients){try{const user=await this.session(token);if(!user)ws.close(1008);else {const rights=JSON.stringify(user.grants.sort());if(this.grants.get(ws)!==rights){this.grants.set(ws,rights);ws.send(JSON.stringify({type:'permissions.changed'}));}ws.ping();}}catch{ws.close(1011);}}}
  async emit(propertyId:string,type:string,applicationId:string){
    for(const [ws,token] of this.clients){try{const user=await this.session(token);if(!user){ws.close(1008);continue;}if(user.propertyId===propertyId&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type,applicationId}));}catch{ws.close(1011);}}
  }
  onModuleDestroy(){if(this.timer)clearInterval(this.timer);for(const ws of this.clients.keys())ws.terminate();this.server?.close();}
}
