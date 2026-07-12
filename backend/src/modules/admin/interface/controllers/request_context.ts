import type { Request } from 'express';

import type { AdminContext } from '../../services/admin_context';

/** Build the audit envelope from the current admin + HTTP request. */
export function buildContext(adminId: string, request: Request, reason?: string | null): AdminContext {
  return {
    adminId,
    ip: extractIp(request) ?? null,
    userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
    reason: reason ?? null,
  };
}

function extractIp(request: Request): string | undefined {
  const forwarded = request.headers['x-forwarded-for'];
  const forwardedIp = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return request.ip ?? forwardedIp ?? request.socket?.remoteAddress ?? undefined;
}
