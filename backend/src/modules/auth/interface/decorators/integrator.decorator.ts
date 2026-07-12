import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

import type { ApiKeyEntity } from '../../domain/entity/api_key.entity';

type Carrier = Request & { integrator?: ApiKeyEntity; integratorId?: string };

/** Injects the full integrator (`ApiKeyEntity`) attached by `ApiKeyGuard`. */
export const Integrator = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ApiKeyEntity | undefined =>
    ctx.switchToHttp().getRequest<Carrier>().integrator,
);

/** Injects just the integrator's UUID. */
export const IntegratorId = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): string | undefined =>
    ctx.switchToHttp().getRequest<Carrier>().integratorId,
);
