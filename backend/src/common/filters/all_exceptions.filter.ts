import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Request, Response } from 'express';

import { PlutonHttpException, PlutonSystemException, SystemErrors } from '../errors';

interface NestExceptionPayload {
  code?: number;
  message?: string | string[];
  causes?: Array<{ field?: string; message: string }>;
  [key: string]: unknown;
}

interface ErrorBody {
  code: number;
  message: string;
  causes?: Array<{ field?: string; message: string } | Record<string, unknown>>;
}

const CAUSES_MAX_BYTES = 6000;

function sanitizeUrlsInString(s: string): string {
  return s
    .replace(/(https?:\/\/[^\/\s)]+)\/[a-f0-9]{32,}/gi, '$1/<redacted>')
    .replace(/([?&](?:apiKey|api_key|auth|token|key)=)[^&\s)]+/gi, '$1<redacted>')
    .replace(/(\/v[23]\/)[a-f0-9]{32,}/gi, '$1<redacted>')
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]+/g, '$1<redacted>')
    .replace(/((?:^|["'\s])x-(?:api|admin)-key["'\s:=]+)[^\s",}]+/gi, '$1<redacted>');
}

function serializeCause(cause: unknown): unknown {
  if (cause === undefined || cause === null) return null;
  if (cause instanceof Error) {
    return { type: cause.constructor.name, message: sanitizeUrlsInString(cause.message) };
  }
  if (typeof cause === 'string') return sanitizeUrlsInString(cause);
  if (typeof cause === 'object') {
    try {
      const s = JSON.stringify(cause);
      return JSON.parse(sanitizeUrlsInString(s.length > CAUSES_MAX_BYTES ? s.slice(0, CAUSES_MAX_BYTES) + '"…[truncated]"' : s));
    } catch {
      return { error: 'unserializable cause' };
    }
  }
  return cause;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('AllExceptionsFilter');
  // Fingerprinting surface: echoed in responses only when the operator opts in; always logged server-side.
  private readonly exposeCauses =
    ['true', '1'].includes((process.env.GASLESS_EXPOSE_ERROR_CAUSES ?? 'false').trim().toLowerCase());

  catch(exception: unknown, host: ArgumentsHost) {
    const httpCtx = host.switchToHttp();
    const response = httpCtx.getResponse<Response>();
    const request = httpCtx.getRequest<Request>();
    const traceId = (request.headers['x-trace-id'] as string | undefined) ?? '';

    const { status, body } = this.format(exception);

    const loggedCauses =
      (exception instanceof PlutonHttpException || exception instanceof PlutonSystemException) && exception.causes.length > 0
        ? exception.causes.map(serializeCause).filter((c) => c !== null)
        : undefined;
    const logPayload = JSON.stringify({
      traceId,
      method: request.method,
      path: request.url,
      status,
      code: body.code,
      message: this.summarize(exception),
      causes: loggedCauses,
    });
    if (status >= 500) {
      this.logger.error(logPayload);
    } else if (status === 404) {
      // 404s on an internet-exposed host are dominated by scanner traffic
      // (`/.env`, `/.git/config`, `/wp/v2/users/`, etc.). Keep them at debug
      // so real signal stays visible; flip to verbose if you need them.
      this.logger.debug(logPayload);
    } else {
      this.logger.warn(logPayload);
    }

    response.status(status).json({ success: false, error: body });
  }

  private format(exception: unknown): { status: number; body: ErrorBody } {
    if (exception instanceof PlutonHttpException) {
      const info = exception.errorInfo;
      const body: ErrorBody = { code: info.code, message: info.message };
      if (this.exposeCauses && exception.causes.length > 0) {
        body.causes = exception.causes.map(serializeCause).filter((c) => c !== null) as ErrorBody['causes'];
      }
      return { status: info.httpCode, body };
    }

    if (exception instanceof PlutonSystemException) {
      const info = exception.errorInfo;
      const body: ErrorBody = { code: info.code, message: info.message };
      if (this.exposeCauses && exception.causes.length > 0) {
        body.causes = exception.causes.map(serializeCause).filter((c) => c !== null) as ErrorBody['causes'];
      }
      return { status: info.httpCode, body };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const payload = exception.getResponse();
      if (
        status === HttpStatus.BAD_REQUEST &&
        typeof payload === 'object' &&
        payload !== null &&
        Array.isArray((payload as NestExceptionPayload).message)
      ) {
        const messages = (payload as NestExceptionPayload).message as string[];
        return {
          status,
          body: {
            code: SystemErrors.ValidationError.code,
            message: SystemErrors.ValidationError.message,
            causes: messages.map((m) => ({ message: m })),
          },
        };
      }
      const message =
        typeof payload === 'string'
          ? payload
          : ((payload as NestExceptionPayload)?.message as string) ?? exception.message;
      return {
        status,
        body: { code: 0, message: typeof message === 'string' ? message : exception.message },
      };
    }

    return {
      status: SystemErrors.General.httpCode,
      body: { code: SystemErrors.General.code, message: SystemErrors.General.message },
    };
  }

  private summarize(exception: unknown): string {
    if (exception instanceof Error) return exception.message;
    try {
      return JSON.stringify(exception);
    } catch {
      return String(exception);
    }
  }
}
