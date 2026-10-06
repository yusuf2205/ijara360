import {Body,Controller,ForbiddenException,Get,Injectable,Module,NotFoundException,Param,ParseUUIDPipe,Put,Req,UseGuards} from '@nestjs/common';
import {ArrayUnique,IsArray,IsIn} from 'class-validator';
import {Prisma} from '@prisma/client';
import {Actor,AuthModule,AuthRequest,SessionGuard} from './auth';
import {Database} from './database';
import {isSuperAdmin,PERMISSIONS,PermissionCode} from './permission-policy';

class PermissionsDto { @IsArray() @ArrayUnique() @IsIn(PERMISSIONS,{each:true}) permissions!: PermissionCode[]; }
@Injectable()
export class PermissionService {
  constructor(private readonly db:Database){}
  async allowed(actor:Actor,tx:Prisma.TransactionClient=this.db) {
    const user=await tx.user.findFirst({where:{id:actor.id,propertyId:actor.propertyId,active:true,property:{active:true}},include:{permissions:true}});
    if(!user) throw new ForbiddenException('Доступ сотрудника отключён.');
    return isSuperAdmin(user.role)?[...PERMISSIONS]:user.permissions.map(p=>p.permissionCode) as PermissionCode[];
  }
  async require(actor:Actor,permission:PermissionCode,tx:Prisma.TransactionClient=this.db){
    const allowed=await this.allowed(actor,tx);
    if(!allowed.includes(permission)) throw new ForbiddenException('У вас нет доступа к этой функции.');
    return allowed;
  }
  async staff(actor:Actor){
    if(!isSuperAdmin(actor.role)) throw new ForbiddenException('Управлять правами может только владелец.');
    await this.allowed(actor);
    const users=await this.db.user.findMany({where:{propertyId:actor.propertyId},select:{id:true,fullName:true,role:true,active:true,permissions:{select:{permissionCode:true}}}});
    return {available:PERMISSIONS,users:users.map(u=>({...u,permissions:isSuperAdmin(u.role)?PERMISSIONS:u.permissions.map(p=>p.permissionCode),protected:isSuperAdmin(u.role)}))};
  }
  async set(actor:Actor,id:string,permissions:PermissionCode[]){
    return this.db.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM properties WHERE id=${actor.propertyId}::uuid FOR UPDATE`;
      await this.allowed(actor,tx);
      const actual=await tx.user.findUniqueOrThrow({where:{id:actor.id}});
      if(!isSuperAdmin(actual.role)) throw new ForbiddenException('Управлять правами может только владелец.');
      const user=await tx.user.findFirst({where:{id,propertyId:actor.propertyId},include:{permissions:true}});
      if(!user)throw new NotFoundException('Сотрудник не найден.');
      if(isSuperAdmin(user.role))throw new ForbiddenException('Права владельца нельзя ограничить.');
      const old=user.permissions.map(p=>p.permissionCode);
      await tx.userPermission.deleteMany({where:{userId:id}});
      await tx.userPermission.createMany({data:permissions.map(permissionCode=>({userId:id,propertyId:actor.propertyId,permissionCode}))});
      for(const code of PERMISSIONS)if(old.includes(code)!==permissions.includes(code)) await tx.auditLog.create({data:{propertyId:actor.propertyId,actorId:actor.id,entity:'User',entityId:id,action:permissions.includes(code)?'PERMISSION_GRANTED':'PERMISSION_REVOKED',metadata:{permission:code}}});
      return {permissions};
    });
  }
}
@Controller('permissions') @UseGuards(SessionGuard)
class PermissionController {
  constructor(private readonly service:PermissionService){}
  @Get('me') async me(@Req() req:AuthRequest){return {permissions:await this.service.allowed(req.actor)};}
  @Get('staff') staff(@Req() req:AuthRequest){return this.service.staff(req.actor);}
  @Put('users/:id') set(@Req() req:AuthRequest,@Param('id',ParseUUIDPipe) id:string,@Body() dto:PermissionsDto){return this.service.set(req.actor,id,dto.permissions);}
}
@Module({imports:[AuthModule],providers:[PermissionService],controllers:[PermissionController],exports:[PermissionService]})
export class PermissionModule{}
