#!/bin/sh
# New password for the house owner when nobody can sign in any more. Run on the NAS as root, from the
# deployed release (or from Windows: scripts/Reset-OwnerPassword.ps1):
#   sudo sh scripts/reset-owner-password.sh
# Lists the owner accounts, asks which phone and a new password (hidden, typed twice). Only the Argon2 hash
# is stored; every session and trusted device of that account is signed out, and the reset is written to
# the audit journal. The password never appears on screen, in arguments or in the environment.
set -eu
test "$(id -u)" = 0 || { echo 'Запустите через sudo.' >&2; exit 1; }
test -t 0 || { echo 'Запустите в терминале: пароль вводится скрыто.' >&2; exit 1; }
api=${API_CONTAINER:-ijara360-api-1}
docker inspect -f '{{.State.Running}}' "$api" 2>/dev/null | grep -qx true || { echo "Сервер приложения ($api) не запущен. Сначала разверните релиз." >&2; exit 1; }

echo 'Аккаунты владельца:'
docker exec -w /app "$api" node -e '
if(!process.env.DATABASE_URL&&require("fs").existsSync("/run/api.env"))process.loadEnvFile("/run/api.env");
const {PrismaClient}=require("@prisma/client");const db=new PrismaClient();
db.user.findMany({where:{role:{in:["OWNER","SUPER_ADMIN"]}},select:{fullName:true,phone:true,active:true},orderBy:{createdAt:"asc"}})
 .then(us=>{if(!us.length)console.log("  (нет)");for(const u of us)console.log(`  ${u.phone}  ${u.fullName}${u.active?"":"  (отключён)"}`);})
 .finally(()=>db.$disconnect());'

printf 'Телефон владельца (как в списке): '
IFS= read -r phone
test -n "$phone" || { echo 'Телефон не указан.' >&2; exit 1; }
printf 'Новый пароль (не меньше 8 символов, ввод скрыт): '
stty -echo; IFS= read -r p1 || p1=''; stty echo; printf '\n'
printf 'Повторите пароль: '
stty -echo; IFS= read -r p2 || p2=''; stty echo; printf '\n'
[ "$p1" = "$p2" ] || { echo 'Пароли не совпадают. Ничего не изменено.' >&2; exit 1; }
[ "${#p1}" -ge 8 ] || { echo 'Пароль короче 8 символов. Ничего не изменено.' >&2; exit 1; }

# Phone and password go to the container on stdin, one per line.
printf '%s\n%s\n' "$phone" "$p1" | docker exec -i -w /app "$api" node -e '
if(!process.env.DATABASE_URL&&require("fs").existsSync("/run/api.env"))process.loadEnvFile("/run/api.env");
const {PrismaClient}=require("@prisma/client");
const {hashPassword,normalizePhone,digest}=require("./apps/api/dist/security");
let input="";process.stdin.on("data",d=>input+=d).on("end",async()=>{
  const [rawPhone,password]=input.replace(/\n$/,"").split("\n");const db=new PrismaClient();
  try{
    const phone=normalizePhone(rawPhone);
    const user=await db.user.findUnique({where:{phone}});
    if(!user||!["OWNER","SUPER_ADMIN"].includes(user.role)){console.error("Владелец с таким телефоном не найден. Ничего не изменено.");process.exitCode=1;return;}
    if(!password||password.length<8||password.length>128){console.error("Пароль: от 8 до 128 символов. Ничего не изменено.");process.exitCode=1;return;}
    const passwordHash=await hashPassword(password);
    await db.$transaction(async tx=>{
      await tx.user.update({where:{id:user.id},data:{passwordHash}});
      await tx.session.deleteMany({where:{userId:user.id}});
      await tx.trustedDevice.deleteMany({where:{userId:user.id}});
      // Lift the 15-minute login lock left by earlier wrong attempts.
      await tx.rateBucket.deleteMany({where:{key:digest(`login-phone:${Math.floor(Date.now()/900000)}:${phone}`)}});
      await tx.auditLog.create({data:{propertyId:user.propertyId,actorId:user.id,action:"PASSWORD_RESET_ON_SERVER",entity:"User",entityId:user.id,metadata:{}}});
    });
    console.log(`Готово: новый пароль задан для «${user.fullName}» (${phone}). Все прежние входы завершены.`);
    console.log("Войдите с этим телефоном и новым паролем. Из дома (Wi-Fi или Tailscale) Telegram не нужен.");
  }catch(e){console.error("Не удалось сменить пароль: "+(e.message||e));process.exitCode=1;}
  finally{await db.$disconnect();}
});'
unset p1 p2
