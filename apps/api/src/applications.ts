import {Body,Controller,Get,Headers,Module,Param,ParseEnumPipe,ParseUUIDPipe,Patch,Post,Put,Query,Req,Res,UseGuards} from '@nestjs/common';
import {DocumentKind} from '@prisma/client';
import {Request,Response} from 'express';
import {AuthModule,AuthRequest,SessionGuard} from './auth';
import {PermissionModule} from './permissions';
import {PrivateStorage} from './private-storage';
import {ResidentsModule} from './residents';
import {ApplicationService} from './applications.service';
import {ApplicationEvents} from './application-events';
import {PhoneVerificationService} from './phone-verification';
import {ApplicationVersionDto,ConvertDto,DraftDto,ReviewDto,StartApplicationDto} from './applications.dto';

function imageResponse(res:Response,bytes:Buffer){res.set({'Content-Type':'image/jpeg','Cache-Control':'no-store, private','Content-Disposition':'inline; filename="document.jpg"','X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin'});res.send(bytes);}
@Controller('public/applications')
class ApplicantController {
  constructor(private readonly service:ApplicationService,private readonly phone:PhoneVerificationService){}
  @Get('config') config(){return this.service.config();}
  @Post() async start(@Body() dto:StartApplicationDto,@Req() req:Request,@Res({passthrough:true}) res:Response){
    const result=await this.service.start(dto,req.ip||'unknown');
    res.cookie('ijara_applicant',result.token,{httpOnly:true,secure:process.env.COOKIE_SECURE!=='false',sameSite:'strict',path:'/api/public/applications',expires:result.expiresAt});return {created:true};
  }
  @Get('me') async me(@Req() req:Request){return this.service.own(await this.service.session(req.cookies?.ijara_applicant));}
  @Patch('me') async save(@Req() req:Request,@Body() dto:DraftDto){return this.service.save(await this.service.session(req.cookies?.ijara_applicant),dto);}
  @Post('phone') async phoneChallenge(@Req() req:Request){return this.phone.challenge(await this.service.session(req.cookies?.ijara_applicant));}
  @Post('submit') async submit(@Req() req:Request,@Body() dto:ApplicationVersionDto){return this.service.submit(await this.service.session(req.cookies?.ijara_applicant),dto.version);}
  @Post('cancel') async cancel(@Req() req:Request,@Body() dto:ApplicationVersionDto){return this.service.cancel(await this.service.session(req.cookies?.ijara_applicant),dto.version);}
  @Put('documents/:kind') async upload(@Req() req:Request,@Param('kind',new ParseEnumPipe(DocumentKind)) kind:DocumentKind){return this.service.upload(await this.service.session(req.cookies?.ijara_applicant),kind,req.body);}
  @Get('documents/:kind') async document(@Req() req:Request,@Param('kind',new ParseEnumPipe(DocumentKind)) kind:DocumentKind,@Res() res:Response){imageResponse(res,await this.service.document(await this.service.session(req.cookies?.ijara_applicant),kind));}
}
@Controller('applications') @UseGuards(SessionGuard)
class ApplicationController {
  constructor(private readonly service:ApplicationService){}
  @Get() list(@Req() req:AuthRequest,@Query('status') status?:string,@Query('page') page?:string,@Query('today') today?:string){return this.service.list(req.actor,status,page===undefined?1:Number(page),today==='1');}
  @Get(':id') detail(@Req() req:AuthRequest,@Param('id',ParseUUIDPipe) id:string){return this.service.detail(req.actor,id);}
  @Post(':id/review') review(@Req() req:AuthRequest,@Param('id',ParseUUIDPipe) id:string,@Body() dto:ReviewDto){return this.service.review(req.actor,id,dto);}
  @Post(':id/convert') convert(@Req() req:AuthRequest,@Param('id',ParseUUIDPipe) id:string,@Body() dto:ConvertDto){return this.service.convert(req.actor,id,dto);}
  @Get(':id/documents/:kind') async document(@Req() req:AuthRequest,@Param('id',ParseUUIDPipe) id:string,@Param('kind',new ParseEnumPipe(DocumentKind)) kind:DocumentKind,@Res() res:Response){imageResponse(res,await this.service.document(await this.service.staffApp(req.actor,id),kind,req.actor));}
}
@Controller('telegram')
class TelegramController {
  constructor(private readonly phone:PhoneVerificationService){}
  @Post('webhook') webhook(@Headers('x-telegram-bot-api-secret-token') secret:string,@Body() update:unknown){return this.phone.webhook(secret,update as Parameters<PhoneVerificationService['webhook']>[1]);}
}
@Module({imports:[AuthModule,PermissionModule,ResidentsModule],providers:[ApplicationService,ApplicationEvents,PrivateStorage,PhoneVerificationService],controllers:[ApplicantController,ApplicationController,TelegramController],exports:[ApplicationEvents]})
export class ApplicationsModule{}
