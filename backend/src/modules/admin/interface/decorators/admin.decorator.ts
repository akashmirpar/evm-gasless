import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import type { AdminEntity } from '../../domain/entity/admin.entity';

type Carrier = Request & { admin?: AdminEntity; adminId?: string };

/** Injects the full admin (`AdminEntity`) attached by `AdminKeyGuard`. */
export const Admin = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AdminEntity | undefined =>
    ctx.switchToHttp().getRequest<Carrier>().admin,
);

/** Injects just the admin's UUID. */
export const AdminId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined =>
    ctx.switchToHttp().getRequest<Carrier>().adminId,
);
