import {Controller,Get,Injectable,Module,Query,Req,UseGuards} from '@nestjs/common';
import {Prisma} from '@prisma/client';
import {Type} from 'class-transformer';
import {IsInt,Max,Min} from 'class-validator';
import {Database} from './database';
import {Tenant,TenantGuard,TenantModule,TenantRequest} from './tenant';

const PAGE=30;
class PageQuery{@Type(()=>Number) @IsInt() @Min(1) @Max(100000) page=1;}
// Tenants see their own money only: no staff names, internal comments or idempotency keys.
const chargeSelect=Prisma.validator<Prisma.ChargeSelect>()({id:true,type:true,status:true,amount:true,paidAmount:true,dueAmount:true,billingPeriodStart:true,billingPeriodEnd:true,dueDate:true,gracePeriodDays:true,createdAt:true,room:{select:{number:true}},bed:{select:{number:true}}});
const paymentSelect=Prisma.validator<Prisma.PaymentSelect>()({id:true,amount:true,method:true,createdAt:true,allocations:{select:{amount:true,charge:{select:{id:true,type:true,billingPeriodStart:true,billingPeriodEnd:true,dueDate:true}}},orderBy:[{createdAt:'asc'},{id:'asc'}]}});

@Injectable()
export class TenantFinanceService {
  constructor(private readonly db:Database){}
  /** Same lock and refresh as staff reads, so overdue status and access are current at the moment of reading. */
  private read<T>(t:Tenant,action:(tx:Prisma.TransactionClient)=>Promise<T>){
    return this.db.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM properties WHERE id = ${t.propertyId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT finance_refresh_property(${t.propertyId}::uuid)`;
      return action(tx);
    },{maxWait:10000,timeout:20000});
  }
  summary(t:Tenant){
    return this.read(t,async tx=>{
      const scope={propertyId:t.propertyId,residentId:t.residentId};
      const [r,overdue,next,occupancy]=await Promise.all([
        tx.resident.findUniqueOrThrow({where:{id:t.residentId},select:{totalDebt:true,creditBalance:true,accessGranted:true,accessStatusReason:true,financeCheckedAt:true}}),
        tx.charge.aggregate({where:{...scope,status:'OVERDUE'},_sum:{dueAmount:true},_count:true}),
        tx.charge.findFirst({where:{...scope,status:{in:['UNPAID','PARTIALLY_PAID','OVERDUE']}},select:chargeSelect,orderBy:[{dueDate:'asc'},{createdAt:'asc'}]}),
        tx.occupancy.findFirst({where:{residentId:t.residentId,status:'ACTIVE'},select:{monthlyPrice:true,paymentDay:true,depositAmount:true,room:{select:{number:true}},bed:{select:{number:true}}}}),
      ]);
      return {access:{granted:r.accessGranted,reason:r.accessStatusReason},totalDebt:r.totalDebt,creditBalance:r.creditBalance,
        overdue:{amount:overdue._sum.dueAmount??new Prisma.Decimal(0),count:overdue._count},nextCharge:next,
        rent:occupancy?{monthlyPrice:occupancy.monthlyPrice,paymentDay:occupancy.paymentDay,depositAmount:occupancy.depositAmount,room:occupancy.room.number,bed:occupancy.bed.number}:null,
        checkedAt:r.financeCheckedAt,asOf:new Date().toISOString()};
    });
  }
  charges(t:Tenant,page:number){
    return this.read(t,async tx=>{
      const where={propertyId:t.propertyId,residentId:t.residentId};
      const [items,total]=await Promise.all([tx.charge.findMany({where,select:chargeSelect,orderBy:[{dueDate:'desc'},{createdAt:'desc'},{id:'desc'}],skip:(page-1)*PAGE,take:PAGE}),tx.charge.count({where})]);
      return {items,total,page,pageSize:PAGE};
    });
  }
  payments(t:Tenant,page:number){
    return this.read(t,async tx=>{
      const where={propertyId:t.propertyId,residentId:t.residentId};
      const [rows,total]=await Promise.all([tx.payment.findMany({where,select:paymentSelect,orderBy:[{createdAt:'desc'},{id:'desc'}],skip:(page-1)*PAGE,take:PAGE}),tx.payment.count({where})]);
      const items=rows.map(p=>({...p,unallocatedAmount:p.amount.minus(p.allocations.reduce((s,a)=>s.plus(a.amount),new Prisma.Decimal(0)))}));
      return {items,total,page,pageSize:PAGE};
    });
  }
}

@Controller('tenant') @UseGuards(TenantGuard)
class TenantFinanceController{
  constructor(private readonly service:TenantFinanceService){}
  @Get('finance') summary(@Req() req:TenantRequest){return this.service.summary(req.tenant);}
  @Get('charges') charges(@Req() req:TenantRequest,@Query() q:PageQuery){return this.service.charges(req.tenant,q.page);}
  @Get('payments') payments(@Req() req:TenantRequest,@Query() q:PageQuery){return this.service.payments(req.tenant,q.page);}
}

@Module({imports:[TenantModule],providers:[TenantFinanceService],controllers:[TenantFinanceController]})
export class TenantFinanceModule{}
