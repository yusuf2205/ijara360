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

const statuses:Record<string,string>={DRAFT:'Черновик',SUBMITTED:'Заявка принята',UNDER_REVIEW:'На рассмотрении',NEEDS_INFO:'Нужна дополнительная информация',APPROVED:'Одобрено',REJECTED:'Отклонено',CANCELLED:'Заявка отменена',CONVERTED_TO_RESIDENT:'Вы заселены'};
// Short form (owner's decision 2026-10-15): phone, three questions, photos. Passport details are read from the photos.
const steps=['Телефон','О вас','Фото и отправка'];
type Profile=Record<string,string|boolean>;
type Draft={id:string;status:string;version:number;profile:Profile;phoneVerified:boolean;hasPassword?:boolean;documents:{id:string;kind:string}[];feedback:{reason:string;requiredFields?:string}|null};
export default function Apply(){
  const [config,setConfig]=useState<{enabled:boolean;propertyName:string;phoneProvider:string}|null>(null);
  const [app,setApp]=useState<Draft|null>(null);const [profile,setProfile]=useState<Profile>({});
  const [phone,setPhone]=useState('');const [step,setStep]=useState(0);const [loaded,setLoaded]=useState(false);
  const [busy,setBusy]=useState(false);const [error,setError]=useState('');const [saved,setSaved]=useState('');const [verifyUrl,setVerifyUrl]=useState('');
  const [password,setPassword]=useState('');const [pwSaved,setPwSaved]=useState(false);const [scanNote,setScanNote]=useState('');
  const [camera,setCamera]=useState<{kind:string;mode:'face'|'document';title:string}|null>(null);
  const current=useRef<Draft|null>(null);const fields=useRef<Profile>({});const revision=useRef(0);const stored=useRef(0);const saving=useRef<Promise<void>|null>(null);
  const editable=app&&['DRAFT','NEEDS_INFO'].includes(app.status);
  function install(a:Draft){current.current=a;setApp(a);fields.current=a.profile;setProfile(a.profile);revision.current=0;stored.current=0;setPwSaved(Boolean(a.hasPassword));}
  async function load(){const a=await api<Draft>('/public/applications/me');install(a);return a;}
  // A resumed draft with a verified phone continues from personal data.
  useEffect(()=>{void(async()=>{try{setConfig(await api('/public/applications/config'));try{const a=await load();if(a.phoneVerified)setStep(1);}catch(e){if(!(e instanceof ApiError&&e.status===401))throw e;}}catch(e){setError((e as Error).message);}finally{setLoaded(true);}})();},[]);
  function change(key:string,value:string|boolean){fields.current={...fields.current,[key]:value};revision.current++;setProfile(fields.current);setSaved('Есть несохранённые изменения');}
  async function persist(){
    if(saving.current)await saving.current;
    if(!current.current||stored.current===revision.current)return;
    const rev=revision.current;const {phone:_,...data}=fields.current;
    const job=(async()=>{const next=await api<Draft>('/public/applications/me',{method:'PATCH',body:JSON.stringify({...data,version:current.current!.version})});current.current=next;setApp(next);stored.current=rev;setSaved(stored.current===revision.current?'Черновик сохранён на сервере':'Есть несохранённые изменения');})();
    saving.current=job;try{await job;}finally{if(saving.current===job)saving.current=null;}
  }
  useEffect(()=>{if(!editable||busy)return;const timer=setTimeout(()=>{void persist().catch(e=>setError(e.message));},900);return()=>clearTimeout(timer);},[profile,editable,busy]);
  useEffect(()=>{const unload=(e:BeforeUnloadEvent)=>{if(stored.current!==revision.current){e.preventDefault();}};window.addEventListener('beforeunload',unload);return()=>window.removeEventListener('beforeunload',unload);},[]);
  useEffect(()=>{if(!app||editable&&!verifyUrl)return;let disposed=false;const timer=setInterval(()=>{if(busy||saving.current||stored.current!==revision.current)return;void api<Draft>('/public/applications/me').then(a=>{if(!disposed){install(a);if(a.phoneVerified)setVerifyUrl('');}}).catch(()=>{});},4000);return()=>{disposed=true;clearInterval(timer);};},[app?.id,editable,verifyUrl,busy]);
  async function work(fn:()=>Promise<void>){setBusy(true);setError('');try{await fn();}catch(e){setError((e as Error).message);}finally{setBusy(false);}}
  function input(key:string,label:string,type='text',maxLength=160){return <label>{label}<input type={type} maxLength={maxLength} value={String(profile[key]||'')} onChange={e=>change(key,e.target.value)} disabled={busy}/></label>;}
  async function upload(kind:string,file:Blob|undefined){if(!file)return;await work(async()=>{await persist();const image=await prepareImage(file);if(image.size>8*1024*1024)throw Error('Фото слишком большое даже после сжатия. Снимите ещё раз.');const response=await fetch(`/api/public/applications/documents/${kind}`,{method:'PUT',headers:{'Content-Type':image.type||'image/jpeg','X-Ijara-Request':'1'},body:image,credentials:'same-origin'});if(!response.ok){const d=await response.json().catch(()=>({}));throw Error(d.message||'Не удалось загрузить документ.');}if(kind==='PASSPORT_FRONT'||kind==='PASSPORT_BACK')setScanNote('Фото паспорта загружено. Данные распознаются автоматически — через несколько секунд ФИО и данные паспорта заполнятся на шаге «О вас». Проверьте их.');await load();});}
  // The built-in camera (front + auto-shoot for the face, back for documents); "Загрузить файл" is the fallback
  // for a computer without a camera or for an existing photo.
  function cameraBtn(kind:string,text:string,mode:'face'|'document',title:string){
    return <button type="button" className="button primary photo-button" disabled={busy||!app?.phoneVerified} onClick={()=>setCamera({kind,mode,title})}>{text}</button>;
  }
  function fileBtn(kind:string,name:string){
    return <label className="button secondary photo-button">Загрузить файл<input className="visually-hidden" type="file" aria-label={name} accept="image/jpeg,image/png,image/webp" disabled={busy||!app?.phoneVerified} onChange={e=>{const f=e.target.files?.[0];e.target.value='';void upload(kind,f);}}/></label>;
  }
  function photo(kind:string,label:string,face=false){const doc=app?.documents.find(d=>d.kind===kind);return <section className={`application-file${face?' face':''}`}><h3>{label}{doc&&<span className="photo-done"> · загружено</span>}</h3>{doc&&<div className="photo-frame"><img alt={label} src={`/api/public/applications/documents/${kind}?v=${app?.version}`}/></div>}<div className="photo-actions">{cameraBtn(kind,doc?(face?'Переснять лицо':'Переснять'):(face?'Сфотографировать лицо':'Сфотографировать'),face?'face':'document',label)}{fileBtn(kind,`${label}: загрузить файл`)}</div></section>;}
  return <>{camera&&<Camera mode={camera.mode} title={camera.title} onCapture={b=>{const k=camera.kind;setCamera(null);void upload(k,b);}} onCancel={()=>setCamera(null)}/>}<main className="apply-shell"><header><a className="apply-brand" href="/apply" aria-label="ijara360"><Logo size={28}/></a><span>{config?.propertyName||'Анкета арендатора'}</span></header><section className="apply-card">
    <h1>Заявка на проживание</h1>{error&&<div className="error" role="alert">{error}</div>}
    {!loaded?<p>Загружаем анкету…</p>:!app?<><p>Заполните анкету и отправьте документы администрации. Заселение оформляется после рассмотрения.</p>{!config?.enabled?<p>Приём заявок пока не настроен. Обратитесь к администрации.</p>:<form onSubmit={e=>{e.preventDefault();void work(async()=>{await api('/public/applications',{method:'POST',body:JSON.stringify({phone,channel:new URLSearchParams(window.location.search).get('channel')==='TELEGRAM'?'TELEGRAM':'WEB'})});await load();});}}><label>Ваш телефон<input type="tel" required value={phone} maxLength={30} onChange={e=>setPhone(e.target.value)} placeholder="+998 90 123 45 67"/></label><p className="form-hint">Используйте номер, привязанный к вашему Telegram. Черновик будет доступен в этом браузере 30 дней.</p><button className="button primary" disabled={busy}>Начать анкету</button></form>}</>:<>
      <p className="status-pill">{statuses[app.status]}</p>
      {app.feedback&&<aside className="application-feedback"><strong>Комментарий администрации</strong><p>{app.feedback.reason}</p>{app.feedback.requiredFields&&<p>Нужно дополнить: {app.feedback.requiredFields}</p>}</aside>}
      {!editable?<><p>{['APPROVED','CONVERTED_TO_RESIDENT'].includes(app.status)?'Ваша заявка одобрена. После заселения вам будет предоставлен доступ к приложению арендатора.':'Статус обновляется автоматически. Сохраните доступ к этому браузеру.'}</p>{['SUBMITTED','UNDER_REVIEW'].includes(app.status)&&<button className="button secondary" disabled={busy} onClick={()=>void work(async()=>{install(await api('/public/applications/cancel',{method:'POST',body:JSON.stringify({version:app.version})}));})}>Отозвать заявку</button>}</>:<>
        <p className="form-hint">Шаг {step+1} из {steps.length}</p><h2>{steps[step]}</h2>
        <fieldset disabled={busy}>
        {step===0&&<><p>Телефон: {String(profile.phone||'')}</p><p>{app.phoneVerified?'Телефон подтверждён':'Телефон пока не подтверждён'}</p>{!app.phoneVerified&&<><button className="button primary" type="button" onClick={()=>{
          // Open the tab inside the click itself (a tab opened after the server answers is blocked), then point it
          // at the bot. On a phone the t.me link hands over to the Telegram app; the form waits here.
          const tab=window.open('about:blank','_blank');if(tab)tab.opener=null;
          void work(async()=>{try{await persist();const r=await api<{url:string}>('/public/applications/phone',{method:'POST'});setVerifyUrl(r.url);if(tab)tab.location.href=r.url;else window.location.assign(r.url);}catch(e){tab?.close();throw e;}});
        }}>Подтвердить через Telegram</button>{verifyUrl&&<p className="form-hint">В Telegram нажмите «Start», затем «Отправить мой номер». Бот не открылся? <a href={verifyUrl} target="_blank" rel="noreferrer">Открыть бота</a></p>}{config?.phoneProvider==='NOT_CONFIGURED'&&<p>Подтверждение телефона ещё не подключено.</p>}</>}</>}
        {step===1&&<>{input('fullName','ФИО')}{input('organization','Где учитесь или работаете','text',200)}{input('requestedMoveInDate','Желаемая дата заселения','date',10)}</>}
        {step===2&&<>{!app.phoneVerified&&<p>Для загрузки фото сначала подтвердите телефон на шаге «Телефон».</p>}<p className="form-hint">Фото должно быть чётким, в фокусе и при хорошем освещении. Паспорт: все края видны, текст читается, без бликов. Лицо: один человек, взгляд в камеру, без маски и тёмных очков. До 8 МБ.</p>{photo('PASSPORT_FRONT','Паспорт: лицевая сторона')}{photo('PASSPORT_BACK','Паспорт: обратная сторона')}{photo('FACE','Фото лица',true)}<p>Загружено фото: {app.documents.length} из 3</p>{scanNote&&<p className="form-hint apply-scan-note">{scanNote}</p>}
        <section className="apply-password"><h3>Пароль для входа в приложение</h3><p className="form-hint">Логин — ваш номер телефона. Придумайте пароль, чтобы после заселения сразу войти в приложение жильца.</p><label>Пароль<input type="password" minLength={8} maxLength={128} autoComplete="new-password" value={password} onChange={e=>{setPassword(e.target.value);setPwSaved(false);}} placeholder={pwSaved?'Пароль сохранён — можно изменить':'Не менее 8 символов'}/></label><small className="apply-pw-hint">{pwSaved?'Пароль сохранён.':'Не менее 8 символов: буквы, цифры или знаки.'}</small></section>
        <label className="application-consent"><input type="checkbox" checked={Boolean(profile.consent)} onChange={e=>change('consent',e.target.checked)}/>Я согласен на обработку анкеты, паспортных изображений, контактных данных и фотографии лица администрацией для рассмотрения заявки. Фото лица сохраняется как исходник для будущего подключения биометрического доступа; сейчас распознавание не выполняется.</label></>}
        </fieldset>
        <div className="modal-actions"><button className="button secondary" disabled={busy||step===0} onClick={()=>void work(async()=>{await persist();setStep(step-1);})}>Назад</button>{step<steps.length-1?<button className="button primary" disabled={busy} onClick={()=>void work(async()=>{await persist();setStep(step+1);})}>Далее</button>:<button className="button primary" disabled={busy||!app.phoneVerified||!(pwSaved||password.length>=8)} onClick={()=>void work(async()=>{await persist();if(password.length>=8&&!pwSaved){await api('/public/applications/password',{method:'POST',body:JSON.stringify({password})});setPwSaved(true);}install(await api('/public/applications/submit',{method:'POST',body:JSON.stringify({version:current.current!.version})}));})}>Отправить заявку</button>}</div><p role="status" className="form-hint">{saved}</p>
      </>}
    </>}
  </section><footer>Документы хранятся в закрытом хранилище. Не отправляйте паспорт или фото лица в чат Telegram.</footer></main></>;
}
