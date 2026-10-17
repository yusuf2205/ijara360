'use client';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MapPin, Navigation, RefreshCw, Search, X } from 'lucide-react';
import { api } from '../lib/api';
import { loadYandex, ResidentMap, type MapPoint, type MapStatus } from '../lib/map';
import { useRealtime, type RealtimeEvent } from '../lib/realtime';

type Position = { latitude: number; longitude: number; accuracy: number | null; recordedAt: string; current: boolean };
export type LocationItem = { residentId: string; fullName: string; room: string | null; bed: string | null; status: MapStatus; reason: string; position: Position | null; lastSeenAt: string | null; device: string | null; permission: string | null; background: string | null; sharingEnabled: boolean };
type ListResponse = { items: LocationItem[]; counts: Record<string, number> };

export const statusLabel: Record<MapStatus, string> = { LIVE: 'В сети', STALE: 'Давно', OFFLINE: 'Нет связи', LOCATION_DISABLED: 'Отключена' };
const reasonText: Record<string, string> = {
  NOT_ENABLED: 'Не включал передачу', SHARING_OFF: 'Жилец выключил передачу', PERMISSION_DENIED: 'Геолокация запрещена в телефоне',
  SERVICES_OFF: 'Службы геолокации выключены', SIGNED_OUT: 'Жилец вышел из приложения', WAITING_FIRST_POINT: 'Ждём первую точку', NO_CONTACT: 'Телефон давно не выходил на связь', NO_FRESH_POINT: 'Нет свежих точек',
};
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '·';
export function ago(iso: string | null, now = Date.now()) {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 30) return 'сейчас';
  if (s < 60) return `${s} сек назад`;
  if (s < 3600) return `${Math.round(s / 60)} мин назад`;
  if (s < 86400) return `${Math.round(s / 3600)} ч назад`;
  return new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}
export function accuracyText(m: number | null) {
  if (m == null) return '—';
  if (m >= 1000) return `низкая, около ${(m / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} км — место приблизительное`;
  return `около ${Math.round(m)} м`;
}
const placeLine = (i: LocationItem) => [i.room && `Комната ${i.room}`, i.bed && `Место ${i.bed}`].filter(Boolean).join(' · ') || 'Без места';
function detail(i: LocationItem, now: number) {
  if (i.status === 'LOCATION_DISABLED' || (i.status === 'OFFLINE' && !i.position)) return reasonText[i.reason] || statusLabel[i.status];
  if (!i.position) return reasonText[i.reason] || '—';
  return i.status === 'LIVE' ? `Обновлено ${ago(i.position.recordedAt, now)}` : `Последняя точка ${ago(i.position.recordedAt, now)}`;
}
const toPoint = (i: LocationItem): MapPoint | null => i.position ? { id: i.residentId, label: i.fullName, initials: initials(i.fullName), latitude: i.position.latitude, longitude: i.position.longitude, accuracy: i.position.accuracy, status: i.status, current: i.status === 'LIVE' } : null;

/** Re-renders "N seconds ago" texts without refetching. */
function useNow(ms = 15000) { const [now, setNow] = useState(Date.now()); useEffect(() => { const t = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(t); }, [ms]); return now; }

type MapState = 'loading' | 'ready' | 'error' | 'off';
/** Hosts a Yandex map in a div; reports its state. Returns the adapter once ready. */
function useResidentMap(onSelect: (id: string) => void) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<ResidentMap | null>(null);
  const [state, setState] = useState<MapState>('loading');
  const [attempt, setAttempt] = useState(0);
  const select = useRef(onSelect); select.current = onSelect;
  useEffect(() => {
    let dead = false;
    setState('loading');
    api<{ provider: string | null; apiKey: string | null }>('/map/config').then(async c => {
      if (!c.apiKey) { if (!dead) setState('off'); return; }
      const y = await loadYandex(c.apiKey);
      if (dead || !box.current) return;
      map.current = new ResidentMap(y, box.current, id => select.current(id));
      setState('ready');
    }).catch(() => { if (!dead) setState('error'); });
    return () => { dead = true; map.current?.destroy(); map.current = null; };
  }, [attempt]);
  return { box, map, state, retry: () => setAttempt(a => a + 1) };
}

function MapFrame({ box, state, retry, className = '' }: { box: React.RefObject<HTMLDivElement | null>; state: MapState; retry: () => void; className?: string }) {
  return <div className={`map-frame ${className}`}>
    <div ref={box} className="map-canvas" aria-label="Карта" role="region"/>
    {state !== 'ready' && <div className="map-overlay" role="status">
      {state === 'loading' && <p>Загружаем карту…</p>}
      {state === 'off' && <><MapPin size={28}/><strong>Карта не подключена</strong><p>Список и статусы работают. Карта появится, когда владелец подключит ключ Яндекс Карт.</p></>}
      {state === 'error' && <><strong>Не удалось загрузить карту.</strong><p>Данные жильцов сохранены.</p><button className="button secondary" onClick={retry}><RefreshCw size={16}/>Повторить</button></>}
    </div>}
  </div>;
}

const FILTERS: (MapStatus | 'ALL')[] = ['ALL', 'LIVE', 'STALE', 'OFFLINE', 'LOCATION_DISABLED'];

/** Staff map: counters, filters, search, resident list and the Yandex map, updated in realtime. */
export function MapPanel({ canHistory, initialResident = null }: { canHistory: boolean; initialResident?: string | null }) {
  const [items, setItems] = useState<LocationItem[] | null>(null);
  const known = useRef(new Set<string>());
  useEffect(() => { known.current = new Set((items ?? []).map(i => i.residentId)); }, [items]);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<MapStatus | 'ALL'>('ALL');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(initialResident);
  const now = useNow();
  const { box, map, state, retry } = useResidentMap(setSelected);
  const fitted = useRef(false);
  const load = useCallback(() => api<ListResponse>('/locations').then(r => { setItems(r.items); setError(''); }).catch(e => setError((e as Error).message)), []);
  useEffect(() => { void load(); }, [load]);
  // Marker moves arrive with their data: patch one resident in place; anything else refetches.
  const live = useRealtime(['location'], load, useCallback((e: RealtimeEvent) => {
    const d = e.data;
    if (!d || typeof d.residentId !== 'string' || d.removed || !known.current.has(d.residentId)) return false;
    setItems(list => list?.map(i => {
      if (i.residentId !== d.residentId) return i;
      const position = typeof d.latitude === 'number' && typeof d.longitude === 'number' && typeof d.recordedAt === 'string'
        ? { latitude: d.latitude, longitude: d.longitude, accuracy: typeof d.accuracy === 'number' ? d.accuracy : null, recordedAt: d.recordedAt, current: d.status === 'LIVE' } : i.position;
      return { ...i, status: d.status as MapStatus, position, reason: d.status === i.status ? i.reason : '' };
    }) ?? list);
    // A status change may also change the reason text: refetch for it; a plain move is fully applied here.
    return e.type === 'resident.location.updated';
  }, []));

  const counts = useMemo(() => {
    const c: Record<string, number> = { ALL: items?.length ?? 0, LIVE: 0, STALE: 0, OFFLINE: 0, LOCATION_DISABLED: 0 };
    for (const i of items ?? []) c[i.status]++;
    return c;
  }, [items]);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^комната\s*/, '').replace(/^место\s*/, '');
    return (items ?? []).filter(i => (filter === 'ALL' || i.status === filter) && (!q || i.fullName.toLowerCase().includes(q) || i.room === q || i.bed === q || placeLine(i).toLowerCase().includes(query.trim().toLowerCase())));
  }, [items, filter, query]);

  useEffect(() => {
    if (state !== 'ready' || !map.current) return;
    map.current.set(visible.map(toPoint).filter((p): p is MapPoint => !!p), selected);
    if (!fitted.current && visible.some(i => i.position)) { map.current.fit(); fitted.current = true; }
  }, [state, visible, selected, map]);
  useEffect(() => { if (state === 'ready') map.current?.select(selected); }, [selected, state, map]);

  const chosen = items?.find(i => i.residentId === selected) ?? null;
  return <section className="map-page" aria-label="Карта жильцов">
    <div className="map-toolbar">
      <div className="map-counters" role="group" aria-label="Фильтр по статусу">
        {FILTERS.map(f => <button key={f} type="button" className={`map-chip ${f.toLowerCase()} ${filter === f ? 'active' : ''}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
          <span className="dot" aria-hidden="true"/>{f === 'ALL' ? 'Все' : statusLabel[f]}<strong>{counts[f]}</strong>
        </button>)}
      </div>
      <label className="search-field map-search"><Search size={16}/><input aria-label="Поиск жильца" placeholder="Имя, комната или место" value={query} onChange={e => setQuery(e.target.value)}/></label>
      <span className="map-live" role="status">{live ? 'Обновляется сразу' : 'Переподключение…'}</span>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="map-layout">
      <MapFrame box={box} state={state} retry={retry} className="map-main"/>
      <aside className="map-list" aria-label="Жильцы на карте">
        {!items ? <p role="status">Загружаем…</p> : !items.length ? <p className="form-hint">Нет жильцов с действующим проживанием.</p> : !visible.length ? <p className="form-hint">Никого не нашли.</p> :
          <ul>{visible.map(i => <li key={i.residentId}>
            <button type="button" className={`map-person ${selected === i.residentId ? 'active' : ''}`} onClick={() => setSelected(i.residentId)} aria-label={`${i.fullName}, ${statusLabel[i.status]}`}>
              <span className={`person-avatar ${i.status.toLowerCase()}`} aria-hidden="true">{initials(i.fullName)}</span>
              <span className="person-text"><strong>{i.fullName}</strong><small>{placeLine(i)}</small><small className={`person-status ${i.status.toLowerCase()}`}>{statusLabel[i.status]} · {detail(i, now)}</small></span>
            </button>
          </li>)}</ul>}
      </aside>
    </div>
    {chosen && <div className="map-card" role="dialog" aria-label={`Геолокация: ${chosen.fullName}`}>
      <button className="icon-button map-card-close" aria-label="Закрыть" onClick={() => setSelected(null)}><X size={18}/></button>
      <h2>{chosen.fullName}</h2>
      <p className="form-hint">{placeLine(chosen)}</p>
      <p><span className={`status-badge ${chosen.status.toLowerCase()}`}>{statusLabel[chosen.status]}</span></p>
      <LocationFacts item={chosen} now={now}/>
      <div className="map-card-actions">
        <Link className="button secondary" href={`/residents/${chosen.residentId}`}>Открыть жильца</Link>
        {canHistory && <Link className="button secondary" href={`/residents/${chosen.residentId}/location`}>История</Link>}
      </div>
    </div>}
  </section>;
}

function LocationFacts({ item, now }: { item: LocationItem; now: number }) {
  const p = item.position;
  return <dl className="location-facts">
    {p ? <>
      <div><dt>{item.status === 'LIVE' ? 'Обновлено' : 'Последняя известная позиция'}</dt><dd>{ago(p.recordedAt, now)}</dd></div>
      <div><dt>Точность</dt><dd>{accuracyText(p.accuracy)}</dd></div>
    </> : <div><dt>Позиция</dt><dd>{reasonText[item.reason] || 'Нет данных'}</dd></div>}
    {item.status === 'LOCATION_DISABLED' && p && <div><dt>Причина</dt><dd>{reasonText[item.reason] || 'Геолокация отключена'}</dd></div>}
    {item.device && <div><dt>Устройство</dt><dd>{item.device}</dd></div>}
  </dl>;
}

/** "Геолокация" block in the resident card (VIEW_LOCATION only). */
export function ResidentLocationCard({ residentId, canHistory }: { residentId: string; canHistory: boolean }) {
  const [item, setItem] = useState<LocationItem | null>(null);
  const [error, setError] = useState('');
  const now = useNow();
  const load = useCallback(() => api<LocationItem>(`/residents/${residentId}/location`).then(setItem).catch(e => setError((e as Error).message)), [residentId]);
  useEffect(() => { void load(); }, [load]);
  useRealtime(['location'], load, useCallback((e: RealtimeEvent) => e.data?.residentId !== residentId, [residentId]));
  return <section className="panel location-panel" aria-labelledby="resident-location">
    <div className="panel-heading"><Navigation size={20}/><h2 id="resident-location">Геолокация</h2></div>
    {error ? <p className="error" role="alert">{error}</p> : !item ? <p role="status">Загружаем…</p> : <>
      <p><span className={`status-badge ${item.status.toLowerCase()}`}>{statusLabel[item.status]}</span></p>
      <LocationFacts item={item} now={now}/>
      <div className="map-card-actions">
        {item.position && <Link className="button secondary" href={`/map?resident=${residentId}`}>Показать на карте</Link>}
        {canHistory && <Link className="button secondary" href={`/residents/${residentId}/location`}>История</Link>}
      </div>
    </>}
  </section>;
}

type HistoryPoint = { latitude: number; longitude: number; accuracy: number | null; recordedAt: string };
const tz = 'Asia/Tashkent';
const dayStart = (offset: number) => { const d = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); return new Date(new Date(`${d}T00:00:00+05:00`).getTime() + offset * 86400000); };
const timeOf = (iso: string) => new Intl.DateTimeFormat('ru-RU', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

/** Route for a day or a custom range (VIEW_LOCATION_HISTORY). Every view is audited by the API. */
export function LocationHistory({ residentId, name }: { residentId: string; name?: string }) {
  const [range, setRange] = useState<'today' | 'yesterday' | 'custom'>('today');
  const [from, setFrom] = useState(dayStart(-1).toISOString().slice(0, 10));
  const [to, setTo] = useState(dayStart(0).toISOString().slice(0, 10));
  const [data, setData] = useState<{ points: HistoryPoint[]; retentionDays: number; truncated: boolean } | null>(null);
  const [error, setError] = useState('');
  const { box, map, state, retry } = useResidentMap(() => undefined);
  const period = useMemo(() => range === 'today' ? [dayStart(0), dayStart(1)] : range === 'yesterday' ? [dayStart(-1), dayStart(0)]
    : [new Date(`${from}T00:00:00+05:00`), new Date(new Date(`${to}T00:00:00+05:00`).getTime() + 86400000)], [range, from, to]);
  useEffect(() => {
    setData(null); setError('');
    api<{ points: HistoryPoint[]; retentionDays: number; truncated: boolean }>(`/residents/${residentId}/location/history?from=${period[0].toISOString()}&to=${period[1].toISOString()}`).then(setData).catch(e => setError((e as Error).message));
  }, [residentId, period]);
  useEffect(() => { if (state === 'ready' && data) map.current?.showRoute(data.points); }, [state, data, map]);
  return <section className="map-page" aria-label="История перемещений">
    <div className="page-heading"><div><div className="heading-kicker">ГЕОЛОКАЦИЯ</div><h1>История перемещений{name ? `: ${name}` : ''}</h1><p>Хранится {data?.retentionDays ?? 30} дней, потом удаляется автоматически. Каждый просмотр записывается в журнал.</p></div></div>
    <div className="map-toolbar">
      <div className="map-counters" role="group" aria-label="Период">
        {([['today', 'Сегодня'], ['yesterday', 'Вчера'], ['custom', 'Период']] as const).map(([k, l]) => <button key={k} type="button" className={`map-chip ${range === k ? 'active' : ''}`} aria-pressed={range === k} onClick={() => setRange(k)}>{l}</button>)}
      </div>
      {range === 'custom' && <div className="history-range"><label>С<input type="date" value={from} onChange={e => setFrom(e.target.value)}/></label><label>По<input type="date" value={to} onChange={e => setTo(e.target.value)}/></label></div>}
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="map-layout">
      <MapFrame box={box} state={state} retry={retry} className="map-main"/>
      <aside className="map-list" aria-label="Точки маршрута">
        {!data ? <p role="status">Загружаем…</p> : !data.points.length ? <p className="form-hint">За этот период точек нет.</p> : <>
          <p className="form-hint">{data.points.length} точек{data.truncated ? ' (показаны первые 5000)' : ''}</p>
          <ol className="history-points">{data.points.map(p => <li key={p.recordedAt}><strong>{timeOf(p.recordedAt)}</strong><small>Точность {accuracyText(p.accuracy)}</small></li>)}</ol>
        </>}
      </aside>
    </div>
  </section>;
}

/** Small summary for the dashboard; the click goes to /map. */
export function LocationSummary() {
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const load = useCallback(() => api<ListResponse>('/locations').then(r => setCounts(r.counts)).catch(() => setCounts(null)), []);
  useEffect(() => { void load(); }, [load]);
  useRealtime(['location'], load);
  if (!counts) return null;
  return <Link href="/map" className="panel location-summary" aria-label="Геолокация жильцов: открыть карту">
    <div className="panel-heading"><MapPin size={20}/><h2>Геолокация</h2></div>
    <div className="location-summary-row">{(['LIVE', 'STALE', 'OFFLINE', 'LOCATION_DISABLED'] as MapStatus[]).map(s => <span key={s} className={`map-chip static ${s.toLowerCase()}`}><span className="dot" aria-hidden="true"/>{statusLabel[s]}<strong>{counts[s] ?? 0}</strong></span>)}</div>
  </Link>;
}
