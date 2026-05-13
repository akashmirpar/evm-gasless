import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

import { RequestContext } from './context';

export const CtxParam = createParamDecorator((_: unknown, execCtx: ExecutionContext): RequestContext => {
  const req: Request = execCtx.switchToHttp().getRequest();
  if (!req.plutonContext) {
    throw new Error('RequestContext not initialized — is RequestContextInterceptor registered?');
  }
  return req.plutonContext;
});
