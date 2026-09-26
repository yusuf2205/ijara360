'use client';
import Link from 'next/link';
import {useEffect,useRef,useState,type FormEvent} from 'react';
import {ArrowLeft,ArrowRight,Plus,Search,Users,X} from 'lucide-react';
import {api,type Resident,type Room} from '../lib/api';

export const dateLabel=(value:string)=>new Date(value).toLocaleDateString('ru',{timeZone:'UTC'});
export const money=(value:string)=>new Intl.NumberFormat('ru',{maximumFractionDigits:2}).format(Number(value))+' сум';
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tashkent',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
export type ResidentAction={mode:'check-in'|'transfer'|'check-out'|'edit'|'create';resident?:Resident;bedId?:string};

export function ResidentsPanel({residents,residentId,onAction,initialFilter='all'}:{residents:Resident[];residentId?:string;onAction:(action:ResidentAction)=>void;initialFilter?:string}) {
 const [query,setQuery]=useState(''); const [filter,setFilter]=useState(initialFilter);
 const resident=residents.find(r=>r.id===residentId);
 if(residentId) {
  if(!resident) return <div className="empty"><h1>Жилец не найден</h1><Link href="/residents">Все жильцы</Link></div>;
  const active=resident.occupancies.find(o=>o.status==='ACTIVE');
  return <>
   <Link href="/residents" className="back-link"><ArrowLeft size={16}/>Все жильцы</Link>
   <div className="page-heading"><div><div className="heading-kicker">КАРТОЧКА ЖИЛЬЦА</div><h1>{resident.fullName}</h1><p><a href={`tel:${resident.phone}`}>{resident.phone}</a></p></div><button className="button secondary" onClick={()=>onAction({mode:'edit',resident})}>Изменить данные</button></div>
   <div className="settings-grid"><section className="panel"><h2>Текущее проживание</h2>{active ? <>
    <p className="resident-location"><Link href={`/rooms/${active.roomId}`}>Комната {active.room.number} / Место {active.bed.number}</Link></p>
    <dl className="detail-grid"><dt>Статус</dt><dd>Проживает</dd><dt>Дата заселения</dt><dd>{dateLabel(active.moveInDate)}</dd><dt>Месячная цена</dt><dd>{money(active.monthlyPrice)}</dd><dt>День оплаты</dt><dd>{active.paymentDay}</dd><dt>Депозит</dt><dd>{money(active.depositAmount)}</dd></dl>
    <div className="resident-actions"><button className="button primary" onClick={()=>onAction({mode:'transfer',resident})}>Переселить</button><button className="button secondary" onClick={()=>onAction({mode:'check-out',resident})}>Выселить</button></div>
   </> : <><p className="muted">{resident.occupancies.length?'Жилец выселен. История сохранена.':'Жилец ещё не заселён.'}</p><button className="button primary" onClick={()=>onAction({mode:'check-in',resident})}><Plus size={18}/>{resident.occupancies.length?'Заселить снова':'Заселить'}</button></>}</section>
   <section className="panel"><h2>Заметка</h2><p className="resident-note">{resident.note || 'Заметок пока нет.'}</p></section></div>
   <section className="panel occupancy-history"><h2>История проживания</h2>{resident.occupancies.length ? resident.occupancies.map(o=><article key={o.id} className="stay-row"><div><strong>Комната {o.room.number} / Место {o.bed.number}</strong><p>{dateLabel(o.moveInDate)} → {o.moveOutDate?dateLabel(o.moveOutDate):'сейчас'}</p></div><span className={`status-pill ${o.status==='ACTIVE'?'occupied':''}`}>{o.status==='ACTIVE'?'Проживает':'Завершено'}</span></article>) : <p className="muted">История появится после первого заселения.</p>}</section>
  </>;
 }
 const found=residents.filter(r=>{
  const active=r.occupancies.some(o=>o.status==='ACTIVE');const digits=query.replace(/\D/g,'');
  return (filter==='all'||filter==='active'&&active||filter==='closed'&&!active&&r.occupancies.length>0)&&(!query||r.fullName.toLocaleLowerCase().includes(query.toLocaleLowerCase())||Boolean(digits)&&r.phone.includes(digits));
 });
 return <><div className="page-heading"><div><div className="heading-kicker">ЛЮДИ ВАШЕГО ДОМА</div><h1>Жильцы</h1><p>Текущее проживание и вся история в одной карточке.</p></div><div className="resident-actions"><button className="button primary" onClick={()=>onAction({mode:'check-in'})}><Plus size={18}/>Заселить</button><button className="button secondary" onClick={()=>onAction({mode:'create'})}>Добавить жильца</button></div></div>
  <div className="resident-toolbar"><div className="filter-tabs" aria-label="Фильтр жильцов">{[['all','Все'],['active','Сейчас живут'],['closed','Выселенные']].map(([value,label])=><button key={value} className={filter===value?'selected':''} aria-pressed={filter===value} onClick={()=>setFilter(value)}>{label}</button>)}</div><label className="search-field"><Search size={18}/><input aria-label="Найти жильца" placeholder="Имя или телефон" value={query} onChange={e=>setQuery(e.target.value)}/></label></div>
  <div className="resident-list">{found.map(r=>{const active=r.occupancies.find(o=>o.status==='ACTIVE');return <Link className="resident-row" href={`/residents/${r.id}`} key={r.id}><span className="avatar">{r.fullName.slice(0,1)}</span><div className="resident-person"><strong>{r.fullName}</strong><small>{r.phone}</small></div><div className="resident-place"><strong>{active?`Комната ${active.room.number} / Место ${active.bed.number}`:'Без места'}</strong><small>{active?`С ${dateLabel(active.moveInDate)}`:r.occupancies.length?'Выселен':'Не заселён'}</small></div><span className={`status-pill ${active?'occupied':''}`}>{active?'Проживает':r.occupancies.length?'Выселен':'Не заселён'}</span><ArrowRight size={17}/></Link>;})}</div>
  {!found.length&&<div className="empty"><Users size={36}/><h2>{residents.length?'Жильцы не найдены':'Жильцов пока нет'}</h2><p>{residents.length?'Измените поиск или фильтр.':'Нажмите «Заселить», чтобы добавить первого жильца и выбрать свободное место.'}</p></div>}
 </>;
}

export function ResidentFlow({action,rooms,residents,close,saved}:{action:ResidentAction;rooms:Room[];residents:Resident[];close:()=>void;saved:(residentId?:string)=>Promise<void>}) {
 const dialog=useRef<HTMLDialogElement>(null); const {mode,resident}=action;
 const active=resident?.occupancies.find(o=>o.status==='ACTIVE');
 const initialRoom=rooms.find(r=>r.beds.some(b=>b.id===action.bedId));
 const [step,setStep]=useState(0);const [busy,setBusy]=useState(false);const [error,setError]=useState('');
 const [residentId,setResidentId]=useState(resident?.id||'');const [fullName,setFullName]=useState(resident?.fullName||'');const [phone,setPhone]=useState(resident?.phone||'');const [note,setNote]=useState(resident?.note||'');
 const [roomId,setRoomId]=useState(initialRoom?.id||'');const [bedId,setBedId]=useState(action.bedId||'');const [date,setDate]=useState(today());
 const [price,setPrice]=useState('');const [paymentDay,setPaymentDay]=useState('10');const [deposit,setDeposit]=useState('0');
 useEffect(()=>{dialog.current?.showModal();},[]);
 const selected=residents.find(r=>r.id===residentId);const room=rooms.find(r=>r.id===roomId);const bed=room?.beds.find(b=>b.id===bedId);
 const duplicate=!residentId&&phone.replace(/\D/g,'').length>=8?residents.find(r=>r.phone.replace(/\D/g,'')===phone.replace(/\D/g,'')):undefined;
 const titles={'check-in':'Заселить жильца',transfer:'Переселить жильца','check-out':'Выселить жильца',edit:'Изменить жильца',create:'Новый жилец'};
 function choose(id:string) {setResidentId(id);const r=residents.find(r=>r.id===id);setFullName(r?.fullName||'');setPhone(r?.phone||'');setNote(r?.note||'');setError('');}
 async function submit(e:FormEvent<HTMLFormElement>) {
  e.preventDefault();setError('');
  if(mode==='check-in'&&step===0) {
   if(duplicate){setError('Жилец с таким телефоном уже существует. Выберите его ниже.');return;}
   if(selected?.occupancies.some(o=>o.status==='ACTIVE')){setError('Жилец уже проживает в доме');return;}
  }
  if(mode==='check-in'&&step<3){setStep(step+1);return;}
  setBusy(true);
  try {
   let result: {residentId?:string;id?:string}|undefined;
   if(mode==='create'||mode==='edit') result=await api(mode==='edit'?`/residents/${resident!.id}`:'/residents',{method:mode==='edit'?'PATCH':'POST',body:JSON.stringify({fullName,phone,note})});
   if(mode==='check-in') result=await api('/occupancies/check-in',{method:'POST',body:JSON.stringify({...(residentId?{residentId}:{resident:{fullName,phone,note}}),bedId,moveInDate:date,monthlyPrice:price,paymentDay:Number(paymentDay),depositAmount:deposit})});
   if(mode==='transfer') result=await api(`/occupancies/${active!.id}/transfer`,{method:'POST',body:JSON.stringify({bedId,transferDate:date})});
   if(mode==='check-out') result=await api(`/occupancies/${active!.id}/check-out`,{method:'POST',body:JSON.stringify({moveOutDate:date})});
   await saved(result?.residentId||result?.id);close();
  }catch(e){setError((e as Error).message);}finally{setBusy(false);}
 }
 const selectBed=<div className="form-grid"><label>Комната<select required value={roomId} onChange={e=>{setRoomId(e.target.value);setBedId('');}}><option value="">Выберите комнату</option>{rooms.filter(r=>r.availableBeds>0).map(r=><option key={r.id} value={r.id}>Комната {r.number} · свободно {r.availableBeds}</option>)}</select></label><label>Свободное место<select required value={bedId} onChange={e=>setBedId(e.target.value)}><option value="">Выберите место</option>{room?.beds.filter(b=>b.status==='AVAILABLE').map(b=><option key={b.id} value={b.id}>Место {b.number}</option>)}</select></label></div>;
 const currentSummary=active&&<div className="confirmation"><strong>{resident?.fullName}</strong><dl className="detail-grid"><dt>Текущее место</dt><dd>Комната {active.room.number} / Место {active.bed.number}</dd><dt>Заселение</dt><dd>{dateLabel(active.moveInDate)}</dd><dt>Месячная цена</dt><dd>{money(active.monthlyPrice)}</dd><dt>Депозит</dt><dd>{money(active.depositAmount)}</dd></dl></div>;
 return <dialog className="modal resident-modal" ref={dialog} onCancel={e=>{if(busy)e.preventDefault();else close();}}><div className="modal-content"><header><h2>{titles[mode]}</h2><button className="icon-button" aria-label="Закрыть" disabled={busy} onClick={close}><X size={20}/></button></header>
  {mode==='check-in'&&<div className="steps">{['Жилец','Место','Условия','Проверка'].map((label,i)=><span key={label} className={i===step?'current':''}>{i+1}. {label}</span>)}</div>}
  <form onSubmit={submit}>
   {((mode==='check-in'&&step===0)||mode==='create'||mode==='edit')&&<>
    {mode==='check-in'&&<label>Существующий жилец<select value={residentId} onChange={e=>choose(e.target.value)}><option value="">Новый жилец</option>{residents.map(r=><option key={r.id} value={r.id}>{r.fullName} · {r.phone}{r.occupancies.some(o=>o.status==='ACTIVE')?' · уже проживает':''}</option>)}</select></label>}
    <label>ФИО<input required maxLength={160} value={fullName} onChange={e=>setFullName(e.target.value)} readOnly={mode==='check-in'&&!!residentId}/></label>
    <label>Телефон<input type="tel" required maxLength={30} pattern="[+][0-9 ()-]{8,29}" placeholder="+998 90 123 45 67" value={phone} onChange={e=>setPhone(e.target.value)} readOnly={mode==='check-in'&&!!residentId}/></label>
    <label>Заметка<textarea maxLength={2000} value={note} onChange={e=>setNote(e.target.value)} readOnly={mode==='check-in'&&!!residentId}/></label>
    {duplicate&&<div className="confirmation"><p>Такой телефон уже есть: {duplicate.fullName}</p><button type="button" className="button secondary" onClick={()=>choose(duplicate.id)}>Выбрать существующего жильца</button></div>}
   </>}
   {mode==='check-in'&&step===1&&<>{selectBed}<p className="form-hint">Показаны места, свободные на момент открытия формы. При сохранении доступность проверяется снова.</p></>}
   {mode==='check-in'&&step===2&&<><label>Месячная цена, сум<input inputMode="decimal" required pattern="(0|[1-9][0-9]{0,11})([.][0-9]{1,2})?" value={price} onChange={e=>setPrice(e.target.value)}/></label><div className="form-grid"><label>День оплаты<input type="number" min={1} max={31} required value={paymentDay} onChange={e=>setPaymentDay(e.target.value)}/></label><label>Депозит, сум<input inputMode="decimal" required pattern="(0|[1-9][0-9]{0,11})([.][0-9]{1,2})?" value={deposit} onChange={e=>setDeposit(e.target.value)}/></label></div><label>Дата заселения<input type="date" required min="1900-01-01" max={today()} value={date} onChange={e=>setDate(e.target.value)}/></label><p className="form-hint">Сохраняем условия проживания. Начисления и платежи здесь не создаются.</p></>}
   {mode==='check-in'&&step===3&&<div className="confirmation"><h3>Проверьте заселение</h3><dl className="detail-grid"><dt>Жилец</dt><dd>{fullName}<br/>{phone}</dd><dt>Место</dt><dd>Комната {room?.number} / Место {bed?.number}</dd><dt>Дата</dt><dd>{dateLabel(date)}</dd><dt>Месячная цена</dt><dd>{money(price)}</dd><dt>День оплаты</dt><dd>{paymentDay}</dd><dt>Депозит</dt><dd>{money(deposit)}</dd></dl></div>}
   {mode==='transfer'&&<>{currentSummary}{selectBed}<label>Дата переселения<input type="date" required min={active?.moveInDate.slice(0,10)} max={today()} value={date} onChange={e=>setDate(e.target.value)}/></label><p className="form-hint">Старое проживание останется в истории. Цена, день оплаты и депозит сохраняются.</p></>}
   {mode==='check-out'&&<>{currentSummary}<label>Дата выселения<input type="date" required min={active?.moveInDate.slice(0,10)} max={today()} value={date} onChange={e=>setDate(e.target.value)}/></label><p className="form-hint">Место освободится. Карточка жильца и история сохранятся. Возврат депозита этой операцией не оформляется.</p></>}
   {error&&<div className="error" role="alert">{error}</div>}
   <div className="modal-actions"><button type="button" disabled={busy} className="button secondary" onClick={()=>{if(mode==='check-in'&&step>0){setStep(step-1);setError('');}else close();}}>{mode==='check-in'&&step>0?'Назад':'Отмена'}</button><button className="button primary" disabled={busy}>{busy?'Сохраняем…':mode==='check-in'?step<3?'Продолжить':'Подтвердить заселение':mode==='transfer'?'Подтвердить переселение':mode==='check-out'?'Подтвердить выселение':'Сохранить'}</button></div>
  </form>
 </div></dialog>;
}
