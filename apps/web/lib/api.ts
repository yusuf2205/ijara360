export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { ...options, cache: 'no-store', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-Ijara-Request': '1', ...options.headers } });
  } catch { throw new ApiError(0, 'Нет соединения с сервером. Проверьте сеть и повторите.'); }
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, Array.isArray(data?.message) ? data.message.join(' · ') : data?.message || 'Не удалось выполнить запрос.');
  return data as T;
}
export type User = { id: string; fullName: string; phone: string; role: 'OWNER' | 'ADMIN'; active?: boolean };
export type Bed = { id: string; number: string; displayNumber: string; status: 'AVAILABLE' | 'OCCUPIED' };
export type Room = { id: string; number: string; capacity: number; version: number; beds: Bed[]; totalBeds: number; availableBeds: number; occupiedBeds: number };
export type Property = { id: string; name: string; address: string | null };
export type Activity = { id: string; action: string; entity: string; entityId: string; actor: { fullName: string }; createdAt: string; metadata: Record<string, unknown> };
