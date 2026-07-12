/** Actor + request-context envelope shared across audit-trail writes. */
export interface AdminContext {
  adminId: string;
  ip: string | null;
  userAgent: string | null;
  reason: string | null;
}
