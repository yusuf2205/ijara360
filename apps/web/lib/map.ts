'use client';
/**
 * Yandex Maps JS API v3 behind a small adapter (docs/M7-LOCATION.md). The map only draws what Ijara360's
 * PostgreSQL says; if Yandex is down, the list and statuses keep working. The key comes from /api/map/config
 * (staff with VIEW_LOCATION only) and is never part of the bundle. Markers are our own elements, so a moved
 * resident updates one marker in place instead of rebuilding the map.
 */
type LngLat = [number, number];
// Minimal typing of the parts of ymaps3 used here.
type YChild = { update(props: object): void };
type YMapInstance = YChild & { addChild(c: unknown): void; removeChild(c: unknown): void; destroy(): void };
type Ymaps3 = {
  ready: Promise<void>;
  YMap: new (el: HTMLElement, props: object) => YMapInstance;
  YMapDefaultSchemeLayer: new (props: object) => unknown;
  YMapDefaultFeaturesLayer: new (props: object) => unknown;
  YMapMarker: new (props: object, el: HTMLElement) => YChild;
  YMapFeature: new (props: object) => YChild;
};
declare global { interface Window { ymaps3?: Ymaps3 } }

let loading: Promise<Ymaps3> | null = null;
/** Loads the API once per page; a failure can be retried. */
export function loadYandex(apiKey: string): Promise<Ymaps3> {
  if (window.ymaps3) return window.ymaps3.ready.then(() => window.ymaps3 as Ymaps3);
  if (loading) return loading;
  loading = new Promise<Ymaps3>((resolve, reject) => {
    // JS API 3.0 checks the key against the HTTP Referer, but the site sends "Referrer-Policy: same-origin"
    // (no Referer at all to other sites). Once a map is shown, this page tells other sites its origin only:
    // never the path, which can hold a resident id. The script and the requests it makes follow it.
    if (!document.querySelector('meta[name="referrer"]')) {
      const m = document.createElement('meta');
      m.name = 'referrer';
      m.content = 'strict-origin';
      document.head.appendChild(m);
    }
    const s = document.createElement('script');
    s.referrerPolicy = 'strict-origin';
    s.src = `https://api-maps.yandex.ru/v3/?apikey=${encodeURIComponent(apiKey)}&lang=ru_RU`;
    s.async = true;
    const fail = () => { s.remove(); loading = null; reject(new Error('map')); };
    s.onerror = fail;
    s.onload = () => { const y = window.ymaps3; if (!y) return fail(); y.ready.then(() => resolve(y), fail); };
    // A blocked or hanging script must not leave the page waiting forever.
    setTimeout(() => { if (!window.ymaps3) fail(); }, 20000);
    document.head.appendChild(s);
  });
  return loading;
}

export type MapStatus = 'LIVE' | 'STALE' | 'OFFLINE' | 'LOCATION_DISABLED';
export type MapPoint = { id: string; label: string; initials: string; latitude: number; longitude: number; accuracy: number | null; status: MapStatus; current: boolean };

/** Accuracy circle as a polygon (the API has no circle primitive). */
function circle(lat: number, lng: number, meters: number): LngLat[] {
  const out: LngLat[] = [];
  const dLat = meters / 111320, dLng = meters / (111320 * Math.cos(lat * Math.PI / 180));
  for (let i = 0; i <= 32; i++) { const a = (i / 32) * 2 * Math.PI; out.push([lng + dLng * Math.cos(a), lat + dLat * Math.sin(a)]); }
  return out;
}

export class ResidentMap {
  private map: YMapInstance;
  private markers = new Map<string, { marker: YChild; el: HTMLButtonElement; ring?: YChild; point: MapPoint }>();
  private route: YChild[] = [];
  constructor(private y: Ymaps3, el: HTMLElement, private onSelect: (id: string) => void) {
    this.map = new y.YMap(el, { location: { center: [69.2401, 41.2995], zoom: 12 }, behaviors: ['drag', 'pinchZoom', 'scrollZoom', 'dblClick'] });
    this.map.addChild(new y.YMapDefaultSchemeLayer({}));
    this.map.addChild(new y.YMapDefaultFeaturesLayer({}));
  }
  private paint(el: HTMLButtonElement, p: MapPoint, selected: boolean) {
    el.className = `map-marker ${p.status.toLowerCase()}${p.current ? '' : ' last-known'}${selected ? ' selected' : ''}`;
    el.textContent = p.initials;
    el.setAttribute('aria-label', `${p.label}: ${p.current ? 'сейчас здесь' : 'последняя известная позиция'}`);
    el.dataset.coords = `${p.latitude.toFixed(6)},${p.longitude.toFixed(6)}`;
  }
  private ring(p: MapPoint) {
    // Only a meaningful circle: a 1.5 km "precision" is shown as a wide, faint area, never as a dot.
    if (!p.accuracy || p.accuracy < 15) return undefined;
    const f = new this.y.YMapFeature({ geometry: { type: 'Polygon', coordinates: [circle(p.latitude, p.longitude, Math.min(p.accuracy, 3000))] }, style: { fill: 'rgba(254,193,35,0.18)', stroke: [{ color: 'rgba(17,17,17,0.35)', width: 1 }] } });
    this.map.addChild(f);
    return f;
  }
  /** Replaces the marker set (initial load, filters). */
  set(points: MapPoint[], selected: string | null) {
    for (const [id, m] of this.markers) if (!points.some(p => p.id === id)) { this.map.removeChild(m.marker); if (m.ring) this.map.removeChild(m.ring); this.markers.delete(id); }
    for (const p of points) {
      const m = this.markers.get(p.id);
      if (m) { this.move(p, selected === p.id); continue; }
      const el = document.createElement('button');
      el.type = 'button';
      el.addEventListener('click', ev => { ev.stopPropagation(); this.onSelect(p.id); });
      this.paint(el, p, selected === p.id);
      const marker = new this.y.YMapMarker({ coordinates: [p.longitude, p.latitude] }, el);
      this.map.addChild(marker);
      this.markers.set(p.id, { marker, el, ring: this.ring(p), point: p });
    }
  }
  /** One resident moved or changed status: update that marker only. */
  move(p: MapPoint, selected: boolean) {
    const m = this.markers.get(p.id);
    if (!m) return this.set([...[...this.markers.values()].map(x => x.point), p], selected ? p.id : null);
    // Short hops glide; a jump across the city is not animated as if it were real travel.
    const far = Math.abs(m.point.latitude - p.latitude) + Math.abs(m.point.longitude - p.longitude) > 0.01;
    m.el.style.transition = far ? 'none' : '';
    m.marker.update({ coordinates: [p.longitude, p.latitude] });
    if (m.ring) this.map.removeChild(m.ring);
    m.ring = this.ring(p);
    m.point = p;
    this.paint(m.el, p, selected);
  }
  select(id: string | null) {
    for (const [mid, m] of this.markers) this.paint(m.el, m.point, mid === id);
    const m = id ? this.markers.get(id) : undefined;
    if (m) this.map.update({ location: { center: [m.point.longitude, m.point.latitude], zoom: 15, duration: 300 } });
  }
  fit() {
    const pts = [...this.markers.values()].map(m => m.point);
    if (!pts.length) return;
    if (pts.length === 1) { this.map.update({ location: { center: [pts[0].longitude, pts[0].latitude], zoom: 15 } }); return; }
    const lngs = pts.map(p => p.longitude), lats = pts.map(p => p.latitude);
    this.map.update({ location: { bounds: [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], duration: 300 } });
  }
  /** History: the route as a line with start and end marks. */
  showRoute(points: { latitude: number; longitude: number }[]) {
    for (const r of this.route) this.map.removeChild(r);
    this.route = [];
    if (!points.length) return;
    const line = new this.y.YMapFeature({ geometry: { type: 'LineString', coordinates: points.map(p => [p.longitude, p.latitude]) }, style: { stroke: [{ color: '#111111', width: 4 }] } });
    this.map.addChild(line); this.route.push(line);
    for (const [p, cls, label] of [[points[0], 'route-start', 'Начало'], [points[points.length - 1], 'route-end', 'Конец']] as const) {
      const el = document.createElement('span'); el.className = `route-mark ${cls}`; el.setAttribute('aria-label', label);
      el.dataset.coords = `${p.latitude.toFixed(6)},${p.longitude.toFixed(6)}`;
      const mk = new this.y.YMapMarker({ coordinates: [p.longitude, p.latitude] }, el);
      this.map.addChild(mk); this.route.push(mk);
    }
    const lngs = points.map(p => p.longitude), lats = points.map(p => p.latitude);
    this.map.update({ location: { bounds: [[Math.min(...lngs), Math.min(...lats)], [Math.max(...lngs), Math.max(...lats)]], duration: 300 } });
  }
  destroy() { this.map.destroy(); this.markers.clear(); }
}
