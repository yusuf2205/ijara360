import {Body,ConflictException,Controller,Get,HttpCode,Injectable,Module,NotFoundException,Param,ParseUUIDPipe,Patch,Post,Query,Req,UseGuards} from '@nestjs/common';
import {Prisma} from '@prisma/client';
import {Transform,Type} from 'class-transformer';
import {IsIn,IsInt,IsOptional,IsString,Length,Max,Min} from 'class-validator';
import {Actor,AuthModule,AuthRequest,AuthService,SessionGuard} from './auth';
import {Database} from './database';
import {requireAccess} from './permission-policy';
import {Tenant,TenantGuard,TenantModule,TenantRequest} from './tenant';
import {NotificationsModule,NotificationsService} from './notifications';

const categoryLabel:Record<string,string>={COMPLAINT:'Жалоба',SUGGESTION:'Предложение',REPAIR:'Поломка'};
const snippet=(s:string)=>s.length>200?s.slice(0,199)+'…':s;

const CATEGORIES=['COMPLAINT','SUGGESTION','REPAIR'] as const;
const STATUSES=['OPEN','IN_PROGRESS','RESOLVED','REJECTED'] as const;
const OPEN=['OPEN','IN_PROGRESS'];
const MAX_OPEN=20;
const trim=({value}:{value:unknown})=>typeof value==='string'?value.trim():value;
class TicketDto{
  @IsIn(CATEGORIES,{message:'Выберите тип обращения.'}) category!:typeof CATEGORIES[number];
  @Transform(trim) @IsString() @Length(3,120,{message:'Тема: от 3 до 120 символов.'}) title!:string;
  @Transform(trim) @IsString() @Length(5,4000,{message:'Текст: от 5 до 4000 символов.'}) body!:string;
}
class MessageDto{@Transform(trim) @IsString() @Length(1,4000,{message:'Сообщение: до 4000 символов.'}) body!:string;}
class StatusDto{@IsIn(STATUSES) status!:typeof STATUSES[number]; @IsInt() @Min(1) version!:number;}
class ListQuery{
  @IsOptional() @IsIn([...STATUSES,'ACTIVE','CLOSED']) status?:string;
  @IsOptional() @IsIn(CATEGORIES) category?:string;
  @Type(()=>Number) @IsInt() @Min(1) @Max(100000) page=1;
}
class PageQuery{@Type(()=>Number) @IsInt() @Min(1) @Max(100000) page=1;}

type Row=Prisma.TicketGetPayload<{include:{resident:{select:{id:true;fullName:true}};_count:{select:{messages:true}}}}>;
type MessageRow={id:string;authorType:string;body:string;createdAt:Date;staff:{fullName:string}|null};

@Injectable()
export class TicketsService{
  constructor(private readonly db:Database,private readonly auth:AuthService,private readonly notifications:NotificationsService){}
  private async rooms(ids:(string|null)[]){
    const list=[...new Set(ids.filter((x):x is string=>!!x))];
    const rows=list.length?await this.db.room.findMany({where:{id:{in:list}},select:{id:true,number:true}}):[];
    return new Map(rows.map(r=>[r.id,r.number]));
  }
  /** Only OWNER/SUPER_ADMIN see who wrote a ticket. Others see the room only for repairs, where the place is the point. */
  private staffView(t:Row,superAdmin:boolean,rooms:Map<string,string>){
    const room=t.roomId&&(superAdmin||t.category==='REPAIR')?rooms.get(t.roomId)??null:null;
    return {id:t.id,category:t.category,status:t.status,title:t.title,version:t.version,createdAt:t.createdAt,updatedAt:t.updatedAt,closedAt:t.closedAt,messages:t._count.messages,
      room,author:superAdmin?{residentId:t.resident.id,fullName:t.resident.fullName}:null};
  }
  private messages(rows:MessageRow[],viewer:'TENANT'|'STAFF'|'SUPER_ADMIN',tenantName:string){
    return rows.map(m=>({id:m.id,author:m.authorType,createdAt:m.createdAt,body:m.body,
      name:m.authorType==='STAFF'?(viewer==='TENANT'?'Администрация':m.staff?.fullName??'Сотрудник'):viewer==='SUPER_ADMIN'?tenantName:viewer==='TENANT'?'Вы':'Жилец'}));
  }
  private include={resident:{select:{id:true,fullName:true}},_count:{select:{messages:true}}} as const;
  private messageInclude={orderBy:[{createdAt:'asc' as const},{id:'asc' as const}],select:{id:true,authorType:true,body:true,createdAt:true,staff:{select:{fullName:true}}}};

  // Tenant side: own tickets only.
  async create(t:Tenant,dto:TicketDto){
    await this.auth.rateLimit('tenant-ticket',t.accountId,10);
    return this.db.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM residents WHERE id = ${t.residentId}::uuid FOR UPDATE`;
      if(await tx.ticket.count({where:{residentId:t.residentId,status:{in:OPEN}}})>=MAX_OPEN)throw new ConflictException('У вас много открытых обращений. Дождитесь ответа по ним.');
      const occupancy=await tx.occupancy.findFirst({where:{residentId:t.residentId,status:'ACTIVE'},select:{roomId:true}});
      const ticket=await tx.ticket.create({data:{propertyId:t.propertyId,residentId:t.residentId,roomId:occupancy?.roomId??null,category:dto.category,title:dto.title,
        messages:{create:{authorType:'TENANT',body:dto.body}}}});
      // The audit trail records that a ticket exists, never who wrote it or what it says.
      await tx.auditLog.create({data:{propertyId:t.propertyId,actorId:null,action:'TICKET_CREATED',entity:'Ticket',entityId:ticket.id,metadata:{category:dto.category}}});
      // Staff see what was written and where to go, never who wrote it.
      await this.notifications.staff(tx,t.propertyId,['TICKETS_VIEW','TICKETS_MANAGE'],{kind:'TICKET_CREATED',title:'Новое обращение',body:`${categoryLabel[dto.category]}: «${dto.title}»`,link:`/tickets/${ticket.id}`,entity:'Ticket',entityId:ticket.id});
      return this.mine(t,ticket.id,tx);
    });
  }
  async mineList(t:Tenant,page:number){
    const where={residentId:t.residentId,propertyId:t.propertyId};
    const [items,total]=await Promise.all([this.db.ticket.findMany({where,orderBy:[{updatedAt:'desc'},{id:'desc'}],skip:(page-1)*20,take:20,
      select:{id:true,category:true,status:true,title:true,createdAt:true,updatedAt:true,closedAt:true,_count:{select:{messages:true}}}}),this.db.ticket.count({where})]);
    return {items:items.map(({_count,...i})=>({...i,messages:_count.messages})),total,page,pageSize:20};
  }
  async mine(t:Tenant,id:string,tx:Prisma.TransactionClient=this.db){
    const ticket=await tx.ticket.findFirst({where:{id,residentId:t.residentId,propertyId:t.propertyId},include:{messages:this.messageInclude}});
    if(!ticket)throw new NotFoundException('Обращение не найдено.');
    const {messages,residentId:_r,propertyId:_p,roomId:_room,...rest}=ticket;
    return {...rest,messages:this.messages(messages,'TENANT','')};
  }
  async tenantReply(t:Tenant,id:string,dto:MessageDto){
    await this.auth.rateLimit('tenant-ticket-message',t.accountId,30);
    return this.db.$transaction(async tx=>{
      const ticket=await tx.ticket.findFirst({where:{id,residentId:t.residentId,propertyId:t.propertyId}});
      if(!ticket)throw new NotFoundException('Обращение не найдено.');
      if(!OPEN.includes(ticket.status))throw new ConflictException('Обращение закрыто. Если вопрос остался, создайте новое.');
      await tx.ticketMessage.create({data:{ticketId:id,authorType:'TENANT',body:dto.body}});
      await this.notifications.staff(tx,t.propertyId,['TICKETS_VIEW','TICKETS_MANAGE'],{kind:'TICKET_MESSAGE',title:'Новое сообщение в обращении',body:`«${ticket.title}»`,link:`/tickets/${id}`,entity:'Ticket',entityId:id});
      await tx.ticket.update({where:{id},data:{updatedAt:new Date()}});
      return this.mine(t,id,tx);
    });
  }

  // Staff side.
  async list(actor:Actor,q:ListQuery){
    const {superAdmin}=await requireAccess(this.db,actor,['TICKETS_VIEW','TICKETS_MANAGE']);
    const status=q.status==='ACTIVE'?{in:OPEN}:q.status==='CLOSED'?{in:['RESOLVED','REJECTED']}:q.status;
    const where={propertyId:actor.propertyId,...(status?{status}:{}),...(q.category?{category:q.category}:{})};
    const [rows,total,grouped]=await Promise.all([
      this.db.ticket.findMany({where,include:this.include,orderBy:[{updatedAt:'desc'},{id:'desc'}],skip:(q.page-1)*30,take:30}),
      this.db.ticket.count({where}),
      this.db.ticket.groupBy({by:['status'],where:{propertyId:actor.propertyId},_count:true}),
    ]);
    const rooms=await this.rooms(rows.map(r=>r.roomId));
    return {items:rows.map(r=>this.staffView(r,superAdmin,rooms)),total,page:q.page,pageSize:30,counts:Object.fromEntries(grouped.map(g=>[g.status,g._count]))};
  }
  async detail(actor:Actor,id:string,tx:Prisma.TransactionClient=this.db){
    const {superAdmin}=await requireAccess(tx,actor,['TICKETS_VIEW','TICKETS_MANAGE']);
    const ticket=await tx.ticket.findFirst({where:{id,propertyId:actor.propertyId},include:{...this.include,messages:this.messageInclude}});
    if(!ticket)throw new NotFoundException('Обращение не найдено.');
    const rooms=await this.rooms([ticket.roomId]);
    return {...this.staffView(ticket,superAdmin,rooms),thread:this.messages(ticket.messages,superAdmin?'SUPER_ADMIN':'STAFF',ticket.resident.fullName)};
  }
  async staffReply(actor:Actor,id:string,dto:MessageDto){
    return this.db.$transaction(async tx=>{
      await requireAccess(tx,actor,'TICKETS_MANAGE');
      const ticket=await tx.ticket.findFirst({where:{id,propertyId:actor.propertyId}});
      if(!ticket)throw new NotFoundException('Обращение не найдено.');
      if(!OPEN.includes(ticket.status))throw new ConflictException('Обращение закрыто. Чтобы ответить, сначала откройте его снова.');
      await tx.ticketMessage.create({data:{ticketId:id,authorType:'STAFF',staffUserId:actor.id,body:dto.body}});
      await this.notifications.tenant(tx,ticket.residentId,{kind:'TICKET_REPLIED',title:'Ответ на обращение',body:`«${ticket.title}»: ${snippet(dto.body)}`,link:`/app/tickets/${id}`,entity:'Ticket',entityId:id});
      // The first answer takes an open ticket into work.
      await tx.ticket.update({where:{id},data:{updatedAt:new Date(),...(ticket.status==='OPEN'?{status:'IN_PROGRESS',version:{increment:1}}:{})}});
      await tx.auditLog.create({data:{propertyId:actor.propertyId,actorId:actor.id,action:'TICKET_REPLIED',entity:'Ticket',entityId:id,metadata:{}}});
      return this.detail(actor,id,tx);
    });
  }
  async setStatus(actor:Actor,id:string,dto:StatusDto){
    return this.db.$transaction(async tx=>{
      await requireAccess(tx,actor,'TICKETS_MANAGE');
      const ticket=await tx.ticket.findFirst({where:{id,propertyId:actor.propertyId}});
      if(!ticket)throw new NotFoundException('Обращение не найдено.');
      if(ticket.version!==dto.version)throw new ConflictException('Обращение уже изменили. Обновите страницу.');
      if(ticket.status===dto.status)throw new ConflictException('Статус уже установлен.');
      const closed=!OPEN.includes(dto.status);
      await tx.ticket.update({where:{id},data:{status:dto.status,closedAt:closed?new Date():null,version:{increment:1}}});
      await tx.auditLog.create({data:{propertyId:actor.propertyId,actorId:actor.id,action:'TICKET_STATUS_CHANGED',entity:'Ticket',entityId:id,metadata:{from:ticket.status,to:dto.status}}});
      const told:Record<string,string>={IN_PROGRESS:'Обращение взято в работу',RESOLVED:'Обращение решено',REJECTED:'Обращение отклонено'};
      if(told[dto.status])await this.notifications.tenant(tx,ticket.residentId,{kind:'TICKET_STATUS',title:told[dto.status],body:`«${ticket.title}»`,link:`/app/tickets/${id}`,entity:'Ticket',entityId:id});
      return this.detail(actor,id,tx);
    });
  }
}

@Controller('tenant/tickets') @UseGuards(TenantGuard)
class TenantTicketsController{
  constructor(private readonly service:TicketsService){}
  @Post() create(@Req() req:TenantRequest,@Body() dto:TicketDto){return this.service.create(req.tenant,dto);}
  @Get() list(@Req() req:TenantRequest,@Query() q:PageQuery){return this.service.mineList(req.tenant,q.page);}
  @Get(':id') one(@Req() req:TenantRequest,@Param('id',ParseUUIDPipe) id:string){return this.service.mine(req.tenant,id);}
  @Post(':id/messages') @HttpCode(201) reply(@Req() req:TenantRequest,@Param('id',ParseUUIDPipe) id:string,@Body() dto:MessageDto){return this.service.tenantReply(req.tenant,id,dto);}
}

@Controller('tickets') @UseGuards(SessionGuard)
class StaffTicketsController{
  constructor(private readonly service:TicketsService){}
  @Get() list(@Req() req:AuthRequest,@Query() q:ListQuery){return this.service.list(req.actor,q);}
  @Get(':id') one(@Req() req:AuthRequest,@Param('id',ParseUUIDPipe) id:string){return this.service.detail(req.actor,id);}
  @Post(':id/messages') reply(@Req() req:AuthRequest,@Param('id',ParseUUIDPipe) id:string,@Body() dto:MessageDto){return this.service.staffReply(req.actor,id,dto);}
  @Patch(':id') status(@Req() req:AuthRequest,@Param('id',ParseUUIDPipe) id:string,@Body() dto:StatusDto){return this.service.setStatus(req.actor,id,dto);}
}

@Module({imports:[AuthModule,TenantModule,NotificationsModule],providers:[TicketsService],controllers:[TenantTicketsController,StaffTicketsController]})
export class TicketsModule{}
