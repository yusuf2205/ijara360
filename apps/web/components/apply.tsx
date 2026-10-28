'use client';
import { Logo } from './brand';
import {useEffect,useRef,useState} from 'react';
import {api,ApiError} from '../lib/api';
import {Camera} from './camera';

// Resize + re-encode any image to a JPEG under ~1600px, so a large phone photo never fails the 8 MB upload limit.
// `imageOrientation:'from-image'` applies the EXIF rotation (phone photos), so the saved image is upright.
async function prepareImage(file:Blob):Promise<Blob>{
  if(!file.type.startsWith('image/'))return file;
  try{
    const bitmap=await createImageBitmap(file,{imageOrientation:'from-image'});
    const limit=1600;const scale=Math.min(1,limit/Math.max(bitmap.width,bitmap.height));
    const w=Math.round(bitmap.width*scale),h=Math.round(bitmap.height*scale);
    const canvas=document.createElement('canvas');canvas.width=w;canvas.height=h;
    canvas.getContext('2d')!.drawImage(bitmap,0,0,w,h);bitmap.close();
    const blob=await new Promise<Blob|null>(res=>canvas.toBlob(res,'image/jpeg',0.85));
    return blob||file;
  }catch{return file;}
}

type Lang='ru'|'uz';
// Applicant-facing text in Russian and Uzbek (owner's choice 2026-10-28: residents + the form get Uzbek).
const TR={
  ru:{
    brandFallback:'Анкета арендатора',title:'Заявка на проживание',loading:'Загружаем анкету…',
    intro:'Заполните анкету и отправьте документы администрации. Заселение оформляется после рассмотрения.',
    disabled:'Приём заявок пока не настроен. Обратитесь к администрации.',
    phoneLabel:'Ваш телефон',phoneHint:'Используйте номер, привязанный к вашему Telegram. Черновик будет доступен в этом браузере 30 дней.',
    startBtn:'Начать анкету',adminComment:'Комментарий администрации',needComplete:'Нужно дополнить: ',
    approvedMsg:'Ваша заявка одобрена. После заселения вам будет предоставлен доступ к приложению арендатора.',
    autoStatus:'Статус обновляется автоматически. Сохраните доступ к этому браузеру.',withdraw:'Отозвать заявку',
    phoneColon:'Телефон: ',phoneVerified:'Телефон подтверждён',phoneNotVerified:'Телефон пока не подтверждён',
    confirmTelegram:'Подтвердить через Telegram',
    tgHint:'В Telegram нажмите «Start», затем «Отправить мой номер». Бот не открылся? ',openBot:'Открыть бота',
    phoneNotConfigured:'Подтверждение телефона ещё не подключено.',
    fullName:'ФИО',organization:'Где учитесь или работаете',moveInDate:'Желаемая дата заселения',
    photoFirstVerify:'Для загрузки фото сначала подтвердите телефон на шаге «Телефон».',
    photoHint:'Фото должно быть чётким, в фокусе и при хорошем освещении. Паспорт: все края видны, текст читается, без бликов. Лицо: один человек, взгляд в камеру, без маски и тёмных очков. До 8 МБ.',
    passportFront:'Паспорт: лицевая сторона',passportBack:'Паспорт: обратная сторона',facePhoto:'Фото лица',
    pwTitle:'Пароль для входа в приложение',
    pwHint:'Логин — ваш номер телефона. Придумайте пароль, чтобы после заселения сразу войти в приложение жильца.',
    pwLabel:'Пароль',pwPlaceholderSaved:'Пароль сохранён — можно изменить',pwPlaceholder:'Не менее 8 символов',
    pwSavedNote:'Пароль сохранён.',pwReq:'Не менее 8 символов: буквы, цифры или знаки.',
    consent:'Я согласен на обработку анкеты, паспортных изображений, контактных данных и фотографии лица администрацией для рассмотрения заявки. Фото лица сохраняется как исходник для будущего подключения биометрического доступа; сейчас распознавание не выполняется.',
    back:'Назад',next:'Далее',submit:'Отправить заявку',
    footer:'Документы хранятся в закрытом хранилище. Не отправляйте паспорт или фото лица в чат Telegram.',
    photoDone:' · загружено',retakeFace:'Переснять лицо',retake:'Переснять',shootFace:'Сфотографировать лицо',shoot:'Сфотографировать',
    uploadFile:'Загрузить файл',
    scanNote:'Фото паспорта загружено. Данные распознаются автоматически — через несколько секунд ФИО и данные паспорта заполнятся на шаге «О вас». Проверьте их.',
    bigPhoto:'Фото слишком большое даже после сжатия. Снимите ещё раз.',uploadFail:'Не удалось загрузить документ.',
    stepOf:(s:number,n:number)=>`Шаг ${s} из ${n}`,uploadedOf:(n:number)=>`Загружено фото: ${n} из 3`,uploadAria:(l:string)=>`${l}: загрузить файл`,
    steps:['Телефон','О вас','Фото и отправка'],
    statuses:{DRAFT:'Черновик',SUBMITTED:'Заявка принята',UNDER_REVIEW:'На рассмотрении',NEEDS_INFO:'Нужна дополнительная информация',APPROVED:'Одобрено',REJECTED:'Отклонено',CANCELLED:'Заявка отменена',CONVERTED_TO_RESIDENT:'Вы заселены'} as Record<string,string>,
  },
  uz:{
    brandFallback:'Ijarachi anketasi',title:'Yashash uchun ariza',loading:'Anketa yuklanmoqda…',
    intro:'Anketani to‘ldiring va hujjatlarni ma’muriyatga yuboring. Joylashtirish ko‘rib chiqilgandan so‘ng rasmiylashtiriladi.',
    disabled:'Arizalar qabuli hali sozlanmagan. Ma’muriyatga murojaat qiling.',
    phoneLabel:'Telefoningiz',phoneHint:'Telegramingizga bog‘langan raqamdan foydalaning. Qoralama shu brauzerda 30 kun saqlanadi.',
    startBtn:'Anketani boshlash',adminComment:'Ma’muriyat izohi',needComplete:'To‘ldirish kerak: ',
    approvedMsg:'Arizangiz tasdiqlandi. Joylashganingizdan so‘ng ijarachi ilovasiga kirish beriladi.',
    autoStatus:'Holat avtomatik yangilanadi. Ushbu brauzerni saqlab qoling.',withdraw:'Arizani qaytarib olish',
    phoneColon:'Telefon: ',phoneVerified:'Telefon tasdiqlandi',phoneNotVerified:'Telefon hali tasdiqlanmagan',
    confirmTelegram:'Telegram orqali tasdiqlash',
    tgHint:'Telegramda «Start», keyin «Mening raqamimni yuborish» ni bosing. Bot ochilmadimi? ',openBot:'Botni ochish',
    phoneNotConfigured:'Telefonni tasdiqlash hali ulanmagan.',
    fullName:'F.I.Sh.',organization:'Qayerda o‘qiysiz yoki ishlaysiz',moveInDate:'Istalgan ko‘chib kirish sanasi',
    photoFirstVerify:'Rasm yuklash uchun avval «Telefon» qadamida telefonni tasdiqlang.',
    photoHint:'Rasm aniq, fokusda va yaxshi yoritilgan bo‘lsin. Pasport: barcha chetlari ko‘rinsin, matn o‘qilsin, yaltirashsiz. Yuz: bitta odam, kameraga qarab, niqobsiz va qora ko‘zoynaksiz. 8 MB gacha.',
    passportFront:'Pasport: old tomoni',passportBack:'Pasport: orqa tomoni',facePhoto:'Yuz rasmi',
    pwTitle:'Ilovaga kirish uchun parol',
    pwHint:'Login — telefon raqamingiz. Parol o‘ylab toping, shunda joylashganingizdan so‘ng ijarachi ilovasiga darhol kirasiz.',
    pwLabel:'Parol',pwPlaceholderSaved:'Parol saqlangan — o‘zgartirish mumkin',pwPlaceholder:'Kamida 8 ta belgi',
    pwSavedNote:'Parol saqlandi.',pwReq:'Kamida 8 ta belgi: harflar, raqamlar yoki belgilar.',
    consent:'Men anketani, pasport tasvirlarini, aloqa ma’lumotlarini va yuz rasmini ma’muriyat tomonidan arizani ko‘rib chiqish uchun qayta ishlashga roziman. Yuz rasmi kelajakda biometrik kirishni ulash uchun manba sifatida saqlanadi; hozircha tanib olish amalga oshirilmaydi.',
    back:'Orqaga',next:'Keyingi',submit:'Arizani yuborish',
    footer:'Hujjatlar yopiq omborda saqlanadi. Pasport yoki yuz rasmini Telegram chatiga yubormang.',
    photoDone:' · yuklandi',retakeFace:'Yuzni qayta olish',retake:'Qayta olish',shootFace:'Yuzni suratga olish',shoot:'Suratga olish',
    uploadFile:'Fayl yuklash',
    scanNote:'Pasport rasmi yuklandi. Ma’lumotlar avtomatik tanib olinadi — bir necha soniyada F.I.Sh. va pasport ma’lumotlari «Siz haqingizda» qadamida to‘ldiriladi. Ularni tekshiring.',
    bigPhoto:'Rasm siqilgandan keyin ham juda katta. Yana suratga oling.',uploadFail:'Hujjatni yuklab bo‘lmadi.',
    stepOf:(s:number,n:number)=>`Qadam ${s} / ${n}`,uploadedOf:(n:number)=>`Yuklangan rasm: ${n} / 3`,uploadAria:(l:string)=>`${l}: fayl yuklash`,
    steps:['Telefon','Siz haqingizda','Rasm va yuborish'],
    statuses:{DRAFT:'Qoralama',SUBMITTED:'Ariza qabul qilindi',UNDER_REVIEW:'Ko‘rib chiqilmoqda',NEEDS_INFO:'Qo‘shimcha ma’lumot kerak',APPROVED:'Tasdiqlandi',REJECTED:'Rad etildi',CANCELLED:'Ariza bekor qilindi',CONVERTED_TO_RESIDENT:'Siz joylashdingiz'} as Record<string,string>,
  },
} as const;

type Profile=Record<string,string|boolean>;
type Draft={id:string;status:string;version:number;profile:Profile;phoneVerified:boolean;hasPassword?:boolean;documents:{id:string;kind:string}[];feedback:{reason:string;requiredFields?:string}|null};
export default function Apply(){
  const [lang,setLang]=useState<Lang>('ru');
  const t=TR[lang];
  useEffect(()=>{try{const s=localStorage.getItem('ijara_apply_lang');if(s==='uz'||s==='ru')setLang(s);}catch{/* private mode */}},[]);
  function pickLang(l:Lang){setLang(l);try{localStorage.setItem('ijara_apply_lang',l);}catch{/* ignore */}}
  const [config,setConfig]=useState<{enabled:boolean;propertyName:string;phoneProvider:string}|null>(null);
  const [app,setApp]=useState<Draft|null>(null);const [profile,setProfile]=useState<Profile>({});
  const [phone,setPhone]=useState('');const [step,setStep]=useState(0);const [loaded,setLoaded]=useState(false);
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [saved,setSaved]=useState('');const [verifyUrl,setVerifyUrl]=useState('');
  const [password,setPassword]=useState('');const [pwSaved,setPwSaved]=useState(false);const [scanNote,setScanNote]=useState(false);
  const [camera,setCamera]=useState<{kind:string;mode:'face'|'document';title:string}|null>(null);
  const current=useRef<Draft|null>(null);const fields=useRef<Profile>({});const revision=useRef(0);const stored=useRef(0);const saving=useRef<Promise<void>|null>(null);
  const editable=app&&['DRAFT','NEEDS_INFO'].includes(app.status);
  function install(a:Draft){current.current=a;setApp(a);fields.current=a.profile;setProfile(a.profile);revision.current=0;stored.current=0;setPwSaved(Boolean(a.hasPassword));}
  async function load(){const a=await api<Draft>('/public/applications/me');install(a);return a;}
  // A resumed draft with a verified phone continues from personal data.
  useEffect(()=>{void(async()=>{try{setConfig(await api('/public/applications/config'));try{const a=await load();if(a.phoneVerified)setStep(1);}catch(e){if(!(e instanceof ApiError&&e.status===401))throw e;}}catch(e){setError((e as Error).message);}finally{setLoaded(true);}})();},[]);
  function change(key:string,value:string|boolean){fields.current={...fields.current,[key]:value};revision.current++;setProfile(fields.current);setSaved('pending');}
  async function persist(){
    if(saving.current)await saving.current;
    if(!current.current||stored.current===revision.current)return;
    const rev=revision.current;const {phone:_,...data}=fields.current;
    const job=(async()=>{const next=await api<Draft>('/public/applications/me',{method:'PATCH',body:JSON.stringify({...data,version:current.current!.version})});current.current=next;setApp(next);stored.current=rev;setSaved(stored.current===revision.current?'saved':'pending');})();
    saving.current=job;try{await job;}finally{if(saving.current===job)saving.current=null;}
  }
  useEffect(()=>{if(!editable||busy)return;const timer=setTimeout(()=>{void persist().catch(e=>setError(e.message));},900);return()=>clearTimeout(timer);},[profile,editable,busy]);
  useEffect(()=>{const unload=(e:BeforeUnloadEvent)=>{if(stored.current!==revision.current){e.preventDefault();}};window.addEventListener('beforeunload',unload);return()=>window.removeEventListener('beforeunload',unload);},[]);
  useEffect(()=>{if(!app||editable&&!verifyUrl)return;let disposed=false;const timer=setInterval(()=>{if(busy||saving.current||stored.current!==revision.current)return;void api<Draft>('/public/applications/me').then(a=>{if(!disposed){install(a);if(a.phoneVerified)setVerifyUrl('');}}).catch(()=>{});},4000);return()=>{disposed=true;clearInterval(timer);};},[app?.id,editable,verifyUrl,busy]);
  async function work(fn:()=>Promise<void>){setBusy(true);setError('');try{await fn();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  function input(key:string,label:string,type='text',maxLength=160){return <label>{label}<input type={type} maxLength={maxLength} value={String(profile[key]||'')} onChange={e=>change(key,e.target.value)} disabled={busy}/></label>;}
  async function upload(kind:string,file:Blob|undefined){if(!file)return;await work(async()=>{await persist();const image=await prepareImage(file);if(image.size>8*1024*1024)throw Error(t.bigPhoto);const response=await fetch(`/api/public/applications/documents/${kind}`,{method:'PUT',headers:{'Content-Type':image.type||'image/jpeg','X-Ijara-Request':'1'},body:image,credentials:'same-origin'});if(!response.ok){const d=await response.json().catch(()=>({}));throw Error(d.message||t.uploadFail);}if(kind==='PASSPORT_FRONT'||kind==='PASSPORT_BACK')setScanNote(true);await load();});}
  // The built-in camera (front + auto-shoot for the face, back for documents); upload a file is the fallback
  // for a computer without a camera or for an existing photo.
  function cameraBtn(kind:string,text:string,mode:'face'|'document',title:string){
    return <button type="button" className="button primary photo-button" disabled={busy||!app?.phoneVerified} onClick={()=>setCamera({kind,mode,title})}>{text}</button>;
  }
  function fileBtn(kind:string,name:string){
    return <label className="button secondary photo-button">{t.uploadFile}<input className="visually-hidden" type="file" aria-label={name} accept="image/jpeg,image/png,image/webp" disabled={busy||!app?.phoneVerified} onChange={e=>{const f=e.target.files?.[0];e.target.value='';void upload(kind,f);}}/></label>;
  }
  function photo(kind:string,label:string,face=false){const doc=app?.documents.find(d=>d.kind===kind);return <section className={`application-file${face?' face':''}`}><h3>{label}{doc&&<span className="photo-done">{t.photoDone}</span>}</h3>{doc&&<div className="photo-frame"><img alt={label} src={`/api/public/applications/documents/${kind}?v=${app?.version}`}/></div>}<div className="photo-actions">{cameraBtn(kind,doc?(face?t.retakeFace:t.retake):(face?t.shootFace:t.shoot),face?'face':'document',label)}{fileBtn(kind,t.uploadAria(label))}</div></section>;}
  const savedText=saved==='saved'?(lang==='uz'?'Qoralama serverda saqlandi':'Черновик сохранён на сервере'):saved==='pending'?(lang==='uz'?'Saqlanmagan o‘zgarishlar bor':'Есть несохранённые изменения'):'';
  return <>{camera&&<Camera mode={camera.mode} title={camera.title} onCapture={b=>{const k=camera.kind;setCamera(null);void upload(k,b);}} onCancel={()=>setCamera(null)}/>}<main className="apply-shell"><header><a className="apply-brand" href="/apply" aria-label="ijara360"><Logo size={28}/></a><div className="apply-head-side"><div className="lang-switch" role="group" aria-label="Til / Язык"><button type="button" className={lang==='ru'?'on':''} aria-pressed={lang==='ru'} onClick={()=>pickLang('ru')}>RU</button><button type="button" className={lang==='uz'?'on':''} aria-pressed={lang==='uz'} onClick={()=>pickLang('uz')}>UZ</button></div><span>{config?.propertyName||t.brandFallback}</span></div></header><section className="apply-card">
    <h1>{t.title}</h1>{error&&<div className="error" role="alert">{error}</div>}
    {!loaded?<p>{t.loading}</p>:!app?<><p>{t.intro}</p>{!config?.enabled?<p>{t.disabled}</p>:<form onSubmit={e=>{e.preventDefault();void work(async()=>{await api('/public/applications',{method:'POST',body:JSON.stringify({phone,channel:new URLSearchParams(window.location.search).get('channel')==='TELEGRAM'?'TELEGRAM':'WEB'})});await load();});}}><label>{t.phoneLabel}<input type="tel" required value={phone} maxLength={30} onChange={e=>setPhone(e.target.value)} placeholder="+998 90 123 45 67"/></label><p className="form-hint">{t.phoneHint}</p><button className="button primary" disabled={busy}>{t.startBtn}</button></form>}</>:<>
      <p className="status-pill">{t.statuses[app.status]}</p>
      {app.feedback&&<aside className="application-feedback"><strong>{t.adminComment}</strong><p>{app.feedback.reason}</p>{app.feedback.requiredFields&&<p>{t.needComplete}{app.feedback.requiredFields}</p>}</aside>}
      {!editable?<><p>{['APPROVED','CONVERTED_TO_RESIDENT'].includes(app.status)?t.approvedMsg:t.autoStatus}</p>{['SUBMITTED','UNDER_REVIEW'].includes(app.status)&&<button className="button secondary" disabled={busy} onClick={()=>void work(async()=>{install(await api('/public/applications/cancel',{method:'POST',body:JSON.stringify({version:app.version})}));})}>{t.withdraw}</button>}</>:<>
        <p className="form-hint">{t.stepOf(step+1,t.steps.length)}</p><h2>{t.steps[step]}</h2>
        <fieldset disabled={busy}>
        {step===0&&<><p>{t.phoneColon}{String(profile.phone||'')}</p><p>{app.phoneVerified?t.phoneVerified:t.phoneNotVerified}</p>{!app.phoneVerified&&<><button className="button primary" type="button" onClick={()=>{
          // Open the tab inside the click itself (a tab opened after the server answers is blocked), then point it
          // at the bot. On a phone the t.me link hands over to the Telegram app; the form waits here.
          const tab=window.open('about:blank','_blank');if(tab)tab.opener=null;
          void work(async()=>{try{await persist();const r=await api<{url:string}>('/public/applications/phone',{method:'POST'});setVerifyUrl(r.url);if(tab)tab.location.href=r.url;else window.location.assign(r.url);}catch(e){tab?.close();throw e;}});
        }}>{t.confirmTelegram}</button>{verifyUrl&&<p className="form-hint">{t.tgHint}<a href={verifyUrl} target="_blank" rel="noreferrer">{t.openBot}</a></p>}{config?.phoneProvider==='NOT_CONFIGURED'&&<p>{t.phoneNotConfigured}</p>}</>}</>}
        {step===1&&<>{input('fullName',t.fullName)}{input('organization',t.organization,'text',200)}{input('requestedMoveInDate',t.moveInDate,'date',10)}</>}
        {step===2&&<>{!app.phoneVerified&&<p>{t.photoFirstVerify}</p>}<p className="form-hint">{t.photoHint}</p>{photo('PASSPORT_FRONT',t.passportFront)}{photo('PASSPORT_BACK',t.passportBack)}{photo('FACE',t.facePhoto,true)}<p>{t.uploadedOf(app.documents.length)}</p>{scanNote&&<p className="form-hint apply-scan-note">{t.scanNote}</p>}
        <section className="apply-password"><h3>{t.pwTitle}</h3><p className="form-hint">{t.pwHint}</p><label>{t.pwLabel}<input type="password" minLength={8} maxLength={128} autoComplete="new-password" value={password} onChange={e=>{setPassword(e.target.value);setPwSaved(false);}} placeholder={pwSaved?t.pwPlaceholderSaved:t.pwPlaceholder}/></label><small className="apply-pw-hint">{pwSaved?t.pwSavedNote:t.pwReq}</small></section>
        <label className="application-consent"><input type="checkbox" checked={Boolean(profile.consent)} onChange={e=>change('consent',e.target.checked)}/>{t.consent}</label></>}
        </fieldset>
        <div className="modal-actions"><button className="button secondary" disabled={busy||step===0} onClick={()=>void work(async()=>{await persist();setStep(step-1);})}>{t.back}</button>{step<t.steps.length-1?<button className="button primary" disabled={busy} onClick={()=>void work(async()=>{await persist();setStep(step+1);})}>{t.next}</button>:<button className="button primary" disabled={busy||!app.phoneVerified||!(pwSaved||password.length>=8)} onClick={()=>void work(async()=>{await persist();if(password.length>=8&&!pwSaved){await api('/public/applications/password',{method:'POST',body:JSON.stringify({password})});setPwSaved(true);}install(await api('/public/applications/submit',{method:'POST',body:JSON.stringify({version:current.current!.version})}));})}>{t.submit}</button>}</div><p role="status" className="form-hint">{savedText}</p>
      </>}
    </>}
  </section><footer>{t.footer}</footer></main></>;
}
