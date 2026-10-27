import {Injectable, ServiceUnavailableException} from '@nestjs/common';
import {Database} from './database';
import {TelegramService} from './telegram';
import {digest, makeToken} from './security';

export const TENANT_APPROVAL_TTL = 5 * 60000;
type Callback = {id: string; from: {id: number}; data?: string; message?: {chat: {id: number}; message_id: number}};
const when = (d: Date) => new Intl.DateTimeFormat('ru-RU', {timeZone: 'Asia/Tashkent', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit'}).format(d);

/**
 * Confirming a resident's login from a new device (owner's decision 2026-10-27). The resident confirms in their
 * own Telegram; a resident without Telegram is confirmed by an owner («администрация»). Kept dependency-light
 * (db + telegram) so both the tenant login service and the bot dispatcher can use it, like StaffTelegramService.
 */
@Injectable()
export class TenantTelegramService {
  constructor(private readonly db: Database, private readonly telegram: TelegramService) {}

  /** Who may confirm this resident's login: the resident (own Telegram), else the property's owners with Telegram. */
  async approvers(account: {telegramUserId: string | null; propertyId: string}) {
    if (account.telegramUserId) return [{telegramUserId: account.telegramUserId, kind: 'self' as const}];
    const owners = await this.db.user.findMany({where: {propertyId: account.propertyId, active: true, role: {in: ['SUPER_ADMIN', 'OWNER']}, telegramUserId: {not: null}}, select: {telegramUserId: true}});
    return owners.map(o => ({telegramUserId: o.telegramUserId!, kind: 'admin' as const}));
  }

  /**
   * Creates the approval and sends the confirm/deny buttons. Returns null when nobody can confirm (the resident
   * has no Telegram and no owner has linked one) — the caller then lets the login through, so no one is locked out.
   */
  async requestApproval(account: {id: string; residentId: string; propertyId: string; telegramUserId: string | null; fullName: string}, device: {platform: string; deviceName: string; remembered: boolean}) {
    const approvers = await this.approvers(account);
    if (!approvers.length) return null;
    const self = approvers[0].kind === 'self';
    const pollToken = makeToken();
    const approval = await this.db.tenantLoginApproval.create({data: {accountId: account.id, pollTokenHash: digest(pollToken), platform: device.platform, deviceName: device.deviceName, remembered: device.remembered, expiresAt: new Date(Date.now() + TENANT_APPROVAL_TTL)}});
    const text = self
      ? `Вход в приложение Ijara360 с нового устройства.
Устройство: ${device.deviceName}
Время: ${when(approval.createdAt)}

Если это не вы, нажмите «Не я».`
      : `Жилец ${account.fullName} входит в приложение Ijara360 с нового устройства.
Устройство: ${device.deviceName}
Время: ${when(approval.createdAt)}

Разрешить вход?`;
    const buttons = {inline_keyboard: [[{text: self ? 'Это я' : 'Разрешить', callback_data: `tla:${approval.id}`}, {text: self ? 'Не я' : 'Отклонить', callback_data: `tld:${approval.id}`}]]};
    let delivered = 0;
    for (const a of approvers) { try { await this.telegram.send(a.telegramUserId, text, buttons); delivered++; } catch { /* another owner may still get it */ } }
    if (!delivered) {
      await this.db.tenantLoginApproval.update({where: {id: approval.id}, data: {status: 'DENIED', decidedAt: new Date()}});
      throw new ServiceUnavailableException('Не удалось отправить подтверждение в Telegram. Повторите позже.');
    }
    await this.db.auditLog.create({data: {propertyId: account.propertyId, actorId: null, action: 'TENANT_LOGIN_APPROVAL_REQUESTED', entity: 'Resident', entityId: account.residentId, metadata: {platform: device.platform, deviceName: device.deviceName, via: self ? 'self' : 'admin'}}});
    return {id: approval.id, pollToken, expiresAt: approval.expiresAt, confirmBy: self ? 'self' as const : 'admin' as const};
  }

  /** Button press in Telegram. Returns true when the data was a tenant approval (so the bot stops looking). */
  async decide(q: Callback) {
    const m = /^(tla|tld):([0-9a-f-]{36})$/.exec(q.data || '');
    if (!m) return false;
    const approve = m[1] === 'tla';
    const answer = (text: string) => this.telegram.call('answerCallbackQuery', {callback_query_id: q.id, text}).catch(() => undefined);
    const a = await this.db.tenantLoginApproval.findUnique({where: {id: m[2]}, include: {account: {include: {resident: {select: {fullName: true}}}}}});
    const approver = a ? (await this.approvers(a.account)).find(x => x.telegramUserId === String(q.from.id)) : undefined;
    if (!a || !approver) { await answer('Запрос не найден.'); return true; }
    const done = await this.db.tenantLoginApproval.updateMany({where: {id: a.id, status: 'PENDING', expiresAt: {gt: new Date()}}, data: {status: approve ? 'APPROVED' : 'DENIED', decidedAt: new Date()}});
    if (!done.count) { await answer('Запрос уже обработан или истёк.'); return true; }
    await this.db.auditLog.create({data: {propertyId: a.account.propertyId, actorId: null, action: approve ? 'TENANT_LOGIN_APPROVED' : 'TENANT_LOGIN_DENIED', entity: 'Resident', entityId: a.account.residentId, metadata: {platform: a.platform, deviceName: a.deviceName, via: approver.kind}}});
    await answer(approve ? 'Вход подтверждён.' : 'Вход отклонён.');
    const who = approver.kind === 'self' ? '' : `${a.account.resident.fullName}, `;
    if (q.message) await this.telegram.call('editMessageText', {chat_id: q.message.chat.id, message_id: q.message.message_id,
      text: approve ? `Вход подтверждён: ${who}${a.deviceName}.` : `Вход отклонён: ${who}${a.deviceName}.${who ? '' : ' Если это были не вы, смените пароль.'}`}).catch(() => undefined);
    return true;
  }
}
