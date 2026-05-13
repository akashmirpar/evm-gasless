import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Request } from 'express';
import { Observable, from } from 'rxjs';
import { switchMap, tap, catchError } from 'rxjs/operators';

import { RequestContext } from './context';

declare module 'express-serve-static-core' {
  interface Request {
    plutonContext?: RequestContext;
  }
}

export const CTX_REQUEST_KEY = 'plutonContext';

@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  intercept(execCtx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req: Request = execCtx.switchToHttp().getRequest();
    const traceId = (req.headers['x-trace-id'] as string | undefined) ?? undefined;
    const ctx = new RequestContext(traceId, { type: 'user', id: 'anonymous' });
    req.plutonContext = ctx;

    return from(Promise.resolve()).pipe(
      switchMap(() => next.handle()),
      tap(async () => {
        if (ctx.tx.hasOpenTransaction()) await ctx.tx.commit();
        await ctx.tx.done();
      }),
      catchError(async (err) => {
        if (ctx.tx.hasOpenTransaction()) await ctx.tx.rollback();
        await ctx.tx.done();
        throw err;
      }),
    );
  }
}
