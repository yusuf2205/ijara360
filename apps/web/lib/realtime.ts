'use client';
import { useEffect, useRef, useState } from 'react';

export type Topic = 'applications' | 'tickets' | 'finance' | 'house' | 'notifications';
type Listener = { topics: Topic[]; run: () => void };

/**
 * One WebSocket per page shared by every panel. Events only say that something changed; each panel refetches
 * what it is allowed to see. After a reconnect (or a server 'resync') every panel refetches, so nothing is missed.
 */
const listeners = new Set<Listener>();
const status = new Set<(up: boolean) => void>();
let ws: WebSocket | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let delay = 1000;
let up = false;
function setUp(v: boolean) { up = v; status.forEach(s => s(v)); }
function all() { listeners.forEach(l => l.run()); }
function connect() {
  if (ws || !listeners.size) return;
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/events`);
  ws = socket;
  socket.onmessage = m => {
    let e: { type?: string; topic?: Topic };
    try { e = JSON.parse(String(m.data)); } catch { return; }
    if (e.type === 'ready') { const again = delay > 1000; delay = 1000; setUp(true); if (again) all(); return; }
    if (e.type === 'resync' || e.type === 'permissions.changed') { all(); return; }
    listeners.forEach(l => { if (e.topic && l.topics.includes(e.topic)) l.run(); });
  };
  socket.onclose = () => {
    ws = undefined; setUp(false);
    if (!listeners.size) return;
    timer = setTimeout(connect, delay); delay = Math.min(delay * 2, 15000);
  };
  socket.onerror = () => socket.close();
}

/** Calls `refresh` (debounced) whenever one of `topics` changes on the server. Returns whether the channel is up. */
export function useRealtime(topics: Topic[], refresh: () => unknown) {
  const latest = useRef(refresh); latest.current = refresh;
  const [connected, setConnected] = useState(up);
  const key = topics.join(',');
  useEffect(() => {
    let pending: ReturnType<typeof setTimeout> | undefined;
    const listener: Listener = { topics: key.split(',') as Topic[], run: () => { clearTimeout(pending); pending = setTimeout(() => void latest.current(), 250); } };
    listeners.add(listener); status.add(setConnected); setConnected(up); connect();
    return () => {
      clearTimeout(pending); listeners.delete(listener); status.delete(setConnected);
      if (!listeners.size) { clearTimeout(timer); ws?.close(); ws = undefined; }
    };
  }, [key]);
  return connected;
}
