import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export const PERMISSIONS = ['APPLICATION_VIEW','APPLICATION_REVIEW','APPLICATION_APPROVE','APPLICATION_REJECT','KYC_VIEW_BASIC','KYC_VIEW_DOCUMENTS','KYC_VIEW_PASSPORT','KYC_VIEW_BIOMETRIC_SOURCE','RESIDENT_CREATE_FROM_APPLICATION',
  'ROOMS_MANAGE','RESIDENTS_MANAGE','FINANCE_VIEW','FINANCE_MANAGE','TICKETS_VIEW','TICKETS_MANAGE'] as const;
export type PermissionCode = typeof PERMISSIONS[number];
// What every ADMIN could do before M5 made these functions grantable; new ADMINs start from it.
export const DEFAULT_ADMIN_PERMISSIONS: PermissionCode[] = ['RESIDENTS_MANAGE','FINANCE_VIEW','FINANCE_MANAGE'];
// OWNER is the existing installation's super-administrator. Preserve its M1 contract.
export const isSuperAdmin = (role: string) => role === 'OWNER' || role === 'SUPER_ADMIN';

type Actor = { id: string; propertyId: string };
/** Re-checks inside the caller's transaction that the actor is active and may use the function (any of a list). */
export async function requireAccess(tx: Prisma.TransactionClient, actor: Actor, need: PermissionCode | PermissionCode[] | 'SUPER_ADMIN' | null): Promise<{ superAdmin: boolean }> {
  const user = await tx.user.findFirst({ where: { id: actor.id, propertyId: actor.propertyId, active: true, property: { active: true } }, include: { permissions: { select: { permissionCode: true } } } });
  if (!user) throw new ForbiddenException('Доступ к дому отключён.');
  if (isSuperAdmin(user.role)) return { superAdmin: true };
  if (need === null) return { superAdmin: false };
  if (need === 'SUPER_ADMIN') throw new ForbiddenException('Это действие доступно владельцу.');
  const any = Array.isArray(need) ? need : [need];
  if (!user.permissions.some(p => any.includes(p.permissionCode as PermissionCode))) throw new ForbiddenException('У вас нет доступа к этой функции.');
  return { superAdmin: false };
}
