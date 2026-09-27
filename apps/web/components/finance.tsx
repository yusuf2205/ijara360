'use client';
import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Plus, Wallet, X } from 'lucide-react';
import { api, ApiError, type Resident, type Room } from '../lib/api';
import { dateLabel } from './residents';

export function financeMoney(value:string) {
  const [whole,fraction='']=value.split('.');
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g,'\u00a0')+(fraction?','+fraction.padEnd(2,'0'):'')+' сум';
}
const types:Record<string,string>={RENT:'Аренда',DEPOSIT:'Депозит',PENALTY:'Штраф',UTILITIES:'Коммунальные услуги',OTHER:'Другое'};
const methods:Record<string,string>={CASH:'Наличные',CARD_TRANSFER:'Перевод на карту',BANK_TRANSFER:'Банковский перевод',OTHER:'Другое'};
const statuses:Record<string,string>={UNPAID:'Не оплачено',PARTIALLY_PAID:'Частично оплачено',PAID:'Оплачено',OVERDUE:'Просрочено'};
type Charge={id:string;residentId:string;amount:string;paidAmount:string;dueAmount:string;status:string;type:string;billingPeriodStart:string;billingPeriodEnd:string;dueDate:string;gracePeriodDays:number;resident:{fullName:string};room:{number:string};bed:{number:string}};
type FormMode='charge'|'payment'|Charge;
type Payment={id:string;chargeId:string|null;amount:string;unallocatedAmount:string;allocations:{id:string;amount:string;charge:{type:string;dueDate:string;billingPeriodStart:string;billingPeriodEnd:string}}[];method:string;comment:string|null;createdAt:string;resident:{fullName:string};creator:{fullName:string}};
type Snapshot={summary:{charged:string;paid:string;applied:string;creditBalance:string;outstanding:string;overdue:string;blockedResidents:number};charges:Charge[];payments:Payment[];residents:{id:string;fullName:string;totalDebt:string;creditBalance:string;accessGranted:boolean;accessStatusReason:string}[];chargeCount:number;paymentCount:number;pageSize:number};
type Pending={path:'/finance/charges'|'/finance/payments';body:Record<string,unknown>};
const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tashkent',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
function requestKey() {
  const bytes=crypto.getRandomValues(new Uint8Array(16));bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export function FinancePanel({residents,rooms,userId,initialResidentId='',onSaved}:{residents:Resident[];rooms:Room[];userId:string;initialResidentId?:string;onSaved:()=>Promise<void>}) {
  const [data,setData]=useState<Snapshot|null>(null),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [residentId,setResidentId]=useState(initialResidentId),[status,setStatus]=useState(''),[page,setPage]=useState(1);
  const [modal,setModal]=useState<FormMode|null>(null),[pending,setPending]=useState<Pending|null>(null),[busy,setBusy]=useState(false);
  const storageKey='ijara360-finance-pending:'+userId;
  async function refresh() {
    try{const q=new URLSearchParams({page:String(page)});if(residentId)q.set('residentId',residentId);if(status)q.set('status',status);setData(await api<Snapshot>('/finance?'+q));setError('');}
    catch(e){setError((e as Error).message);setData(null);}
  }
  useEffect(()=>{void refresh();const timer=setInterval(()=>void refresh(),60000);return()=>clearInterval(timer);},[residentId,status,page]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(()=>{try{const saved=sessionStorage.getItem(storageKey);if(saved){const p=JSON.parse(saved) as Pending;if(['/finance/charges','/finance/payments'].includes(p.path)&&p.body?.idempotencyKey)setPending(p);}}catch{setError('Не удалось прочитать незавершённую запись. Проверьте журнал перед новой оплатой.');}},[storageKey]);
  async function submit(request:Pending) {
    setBusy(true);setError('');setNotice('');
    try{
      // Persist the exact request before sending; lost responses/reloads reuse the UUID.
      sessionStorage.setItem(storageKey,JSON.stringify(request));setPending(request);
      await api(request.path,{method:'POST',body:JSON.stringify(request.body)});
      sessionStorage.removeItem(storageKey);setPending(null);setModal(null);
      setNotice(request.path.endsWith('payments')?'Платёж записан. Остаток и допуск пересчитаны.':'Начисление создано.');
      await refresh();await onSaved();
    }catch(e){if(e instanceof ApiError&&e.status>=400&&e.status<500&&e.status!==401&&e.status!==403){sessionStorage.removeItem(storageKey);setPending(null);}setError((e as Error).message);}
    finally{setBusy(false);}
  }
  return <>
    <div className="page-heading"><div><div className="heading-kicker">ФИНАНСОВЫЙ УЧЁТ</div><h1>Финансы</h1><p>Начисления, оплаты и задолженность жильцов.</p></div><div className="resident-actions"><button className="button secondary" disabled={busy||!!pending||!residents.length} onClick={()=>setModal('payment')}>Принять оплату</button><button className="button primary" disabled={busy||!!pending||!residents.length} onClick={()=>setModal('charge')}><Plus size={18}/>Создать начисление</button></div></div>
    {notice&&<div role="status" className="finance-notice">{notice}</div>}
    {error&&<div className="error" role="alert">{error}<button className="button secondary" onClick={refresh}>Обновить данные</button></div>}
    {pending&&<div className="panel finance-pending"><strong>Запись ожидает подтверждения</strong><p>{pending.path.endsWith('payments')?'Платёж':'Начисление'}: {financeMoney(String(pending.body.amount))}. Повторная отправка этого запроса не создаст дубликат.</p><button className="button primary" disabled={busy} onClick={()=>void submit(pending)}>Проверить и повторить запись</button></div>}
    <div className="finance-filters"><label>Жилец<select aria-label="Жилец" value={residentId} onChange={e=>{setResidentId(e.target.value);setPage(1);}}><option value="">Все жильцы</option>{residents.map(r=><option key={r.id} value={r.id}>{r.fullName}</option>)}</select></label><label>Статус начисления<select aria-label="Статус начисления" value={status} onChange={e=>{setStatus(e.target.value);setPage(1);}}><option value="">Все статусы</option>{Object.entries(statuses).map(([v,label])=><option key={v} value={v}>{label}</option>)}</select></label></div>
    {!data&&!error&&<p role="status">Загружаем финансы…</p>}
    {data&&<>
      <div className="stats-grid finance-stats">{[['Начислено',data.summary.charged],['Получено',data.summary.paid],['Зачтено',data.summary.applied],['Авансы',data.summary.creditBalance],['Остаток к оплате',data.summary.outstanding],['Из него просрочено',data.summary.overdue]].map(([label,value])=><div className="stat" key={label}><span>{label}</span><strong>{financeMoney(value)}</strong></div>)}</div>
      <p className="muted">Итоги за всё время{residentId?' по выбранному жильцу':''}. Остаток включает начисления, срок оплаты которых ещё не наступил.</p>
      <section className="panel finance-section"><h2>Начисления <span>{data.chargeCount}</span></h2>
        {!data.charges.length?<div className="empty"><Wallet size={30}/><h3>Начисления не найдены</h3><p>Создайте начисление или измените фильтры.</p></div>:data.charges.map(c=><article key={c.id} className="finance-row" data-testid="charge-row"><div><Link href={`/residents/${c.residentId}`}><strong>{c.resident.fullName}</strong></Link><p>{types[c.type]} · Комната {c.room.number} / Место {c.bed.number}</p><small>{dateLabel(c.billingPeriodStart)} — {dateLabel(c.billingPeriodEnd)}</small><p>Оплатить до {dateLabel(c.dueDate)} · Льготный период: {c.gracePeriodDays} дн.</p></div><div><span className={'status-pill '+(c.status==='OVERDUE'?'finance-overdue':'')}>{statuses[c.status]}</span><dl className="detail-grid"><dt>Начислено</dt><dd>{financeMoney(c.amount)}</dd><dt>Оплачено</dt><dd>{financeMoney(c.paidAmount)}</dd><dt>Остаток</dt><dd>{financeMoney(c.dueAmount)}</dd></dl>{c.status!=='PAID'&&<button className="button secondary" disabled={busy||!!pending} onClick={()=>setModal(c)}>Записать платёж</button>}</div></article>)}
      </section>
      <section className="panel finance-section"><h2>Платежи <span>{data.paymentCount}</span></h2>{!data.payments.length?<p className="muted">Платежей пока нет.</p>:data.payments.map(p=><article key={p.id} className="finance-row" data-testid="payment-row"><div><strong>{p.resident.fullName}</strong><p>{methods[p.method]} · {new Date(p.createdAt).toLocaleString('ru',{timeZone:'Asia/Tashkent'})}</p>{p.comment&&<p className="resident-note">{p.comment}</p>}<small>Записал: {p.creator.fullName}</small><ul className="finance-allocations">{p.allocations.map(a=><li key={a.id}>{types[a.charge.type]} · {dateLabel(a.charge.billingPeriodStart)} — {dateLabel(a.charge.billingPeriodEnd)}: {financeMoney(a.amount)}</li>)}</ul>{p.unallocatedAmount!=='0'&&<p>Остаток аванса: {financeMoney(p.unallocatedAmount)}</p>}</div><strong>{financeMoney(p.amount)}</strong></article>)}</section>
      <div className="resident-actions finance-pagination"><button className="button secondary" disabled={page===1} onClick={()=>setPage(page-1)}>Назад</button><span>Страница {page}</span><button className="button secondary" disabled={page*data.pageSize>=Math.max(data.chargeCount,data.paymentCount)} onClick={()=>setPage(page+1)}>Далее</button></div>
      <section className="panel finance-section"><h2>Финансовый допуск</h2><p className="muted">Ограничен у {data.summary.blockedResidents} жильцов. Просрочка отмечается после срока оплаты; ограничение — после льготного периода.</p>{data.residents.map(r=><article className="finance-row" key={r.id}><Link href={`/residents/${r.id}`}>{r.fullName}</Link><span>К оплате: {financeMoney(r.totalDebt)}<br/>Аванс: {financeMoney(r.creditBalance)}</span><span className={'status-pill '+(!r.accessGranted?'finance-overdue':'')}>{!r.accessGranted?'Ограничен: просрочка':r.accessStatusReason==='GRACE_PERIOD'?'Разрешён: льготный период':'Разрешён'}</span></article>)}{!data.residents.length&&<p>Жильцов пока нет.</p>}</section>
    </>}
    {modal&&(!pending||busy)&&<FinanceForm modal={modal} residents={residents} rooms={rooms} initialResidentId={residentId} close={()=>setModal(null)} submit={submit} busy={busy} error={error}/>}
  </>;
}

function FinanceForm({modal,residents,rooms,initialResidentId,close,submit,busy,error}:{modal:FormMode;residents:Resident[];rooms:Room[];initialResidentId:string;close:()=>void;submit:(request:Pending)=>Promise<void>;busy:boolean;error:string}) {
  const dialog=useRef<HTMLDialogElement>(null),key=useRef(requestKey());
  const context=typeof modal==='object'?modal:null;
  const [residentId,setResidentId]=useState(context?.residentId||initialResidentId||residents[0]?.id||'');
  const selected=residents.find(r=>r.id===residentId);
  const defaultBed=selected?.occupancies.find(o=>o.status==='ACTIVE')?.bedId||selected?.occupancies[0]?.bedId||'';
  useEffect(()=>{dialog.current?.showModal();},[]);
  async function save(e:FormEvent<HTMLFormElement>){
    e.preventDefault();const form=new FormData(e.currentTarget);const value=(name:string)=>String(form.get(name)||'');
    const body=modal==='charge'?{residentId,bedId:value('bedId'),amount:value('amount'),type:value('type'),billingPeriodStart:value('start'),billingPeriodEnd:value('end'),dueDate:value('due'),gracePeriodDays:Number(value('grace')),idempotencyKey:key.current}:{residentId:context?.residentId||residentId,amount:value('amount'),method:value('method'),comment:value('comment'),idempotencyKey:key.current};
    await submit({path:modal==='charge'?'/finance/charges':'/finance/payments',body});
  }
  return <dialog ref={dialog} className="modal finance-modal" onCancel={e=>{if(busy)e.preventDefault();else close();}}><div className="modal-content"><header><h2>{modal==='charge'?'Новое начисление':'Записать платёж'}</h2><button className="icon-button" aria-label="Закрыть" disabled={busy} onClick={close}><X size={20}/></button></header><form onSubmit={save}>
    {modal==='charge'?<><label>Жилец<select required value={residentId} onChange={e=>setResidentId(e.target.value)}>{residents.map(r=><option key={r.id} value={r.id}>{r.fullName}</option>)}</select></label><label>Место начисления<select name="bedId" required key={residentId} defaultValue={defaultBed}><option value="">Выберите место</option>{rooms.flatMap(r=>r.beds.map(b=><option key={b.id} value={b.id}>Комната {r.number} / Место {b.number}</option>))}</select></label><label>Тип начисления<select name="type" defaultValue="RENT">{Object.entries(types).map(([v,label])=><option key={v} value={v}>{label}</option>)}</select></label><div className="form-grid"><label>Начало периода<input type="date" name="start" required defaultValue={today()}/></label><label>Конец периода<input type="date" name="end" required defaultValue={today()}/></label><label>Оплатить до<input type="date" name="due" required defaultValue={today()}/></label><label>Льготный период, дней<input type="number" name="grace" min="0" max="365" required defaultValue="0"/></label></div></>:<><label>Жилец<select aria-label="Жилец" required value={residentId} disabled={!!context} onChange={e=>setResidentId(e.target.value)}>{residents.map(r=><option key={r.id} value={r.id}>{r.fullName}</option>)}</select></label><div className="confirmation">Оплата погасит сначала самые старые начисления. Остаток сохранится как аванс и зачтётся при новых начислениях.</div></>}
    <label>Сумма, сум<input name="amount" inputMode="decimal" required pattern="(0|[1-9][0-9]{0,7})(\.[0-9]{1,2})?" placeholder="Например, 750000.50" defaultValue={context?.dueAmount||''}/></label>
    {modal!=='charge'&&<><label>Способ оплаты<select name="method" defaultValue="CASH">{Object.entries(methods).map(([v,label])=><option key={v} value={v}>{label}</option>)}</select></label><label>Комментарий<textarea name="comment" maxLength={2000}/></label></>}
    <p className="muted">Проверьте сумму и жильца перед сохранением. Запись останется в финансовой истории.</p>{error&&<div role="alert" className="error">{error}</div>}
    <div className="form-actions"><button type="button" className="button secondary" disabled={busy} onClick={close}>Отмена</button><button className="button primary" disabled={busy}>{busy?'Сохраняем…':modal==='charge'?'Подтвердить начисление':'Подтвердить платёж'}</button></div>
  </form></div></dialog>;
}
