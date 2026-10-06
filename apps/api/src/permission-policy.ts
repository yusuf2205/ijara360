export const PERMISSIONS = ['APPLICATION_VIEW','APPLICATION_REVIEW','APPLICATION_APPROVE','APPLICATION_REJECT','KYC_VIEW_BASIC','KYC_VIEW_DOCUMENTS','KYC_VIEW_PASSPORT','KYC_VIEW_BIOMETRIC_SOURCE','RESIDENT_CREATE_FROM_APPLICATION'] as const;
export type PermissionCode = typeof PERMISSIONS[number];
// OWNER is the existing installation's super-administrator. Preserve its M1 contract.
export const isSuperAdmin = (role: string) => role === 'OWNER' || role === 'SUPER_ADMIN';
