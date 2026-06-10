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
  causes?: Array<{ field?: string; message: string }>;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('AllExceptionsFilter');

  catch(exception: unknown, host: ArgumentsHost) {
    const httpCtx = host.switchToHttp();
    const response = httpCtx.getResponse<Response>();
    const request = httpCtx.getRequest<Request>();
    const traceId = (request.headers['x-trace-id'] as string | undefined) ?? '';

    const { status, body } = this.format(exception);

    const logPayload = JSON.stringify({
      traceId,
      method: request.method,
      path: request.url,
      status,
      code: body.code,
      message: this.summarize(exception),
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
      return { status: info.httpCode, body: { code: info.code, message: info.message } };
    }

    if (exception instanceof PlutonSystemException) {
      return {
        status: SystemErrors.General.httpCode,
        body: { code: SystemErrors.General.code, message: SystemErrors.General.message },
      };
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
