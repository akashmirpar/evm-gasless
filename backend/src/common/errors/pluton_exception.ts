import { HttpException } from '@nestjs/common';
import { EntityNotFoundError } from 'typeorm';

import { ErrorInfo } from './error_info';
import { SystemErrors } from './system.errors';

export type PlutonContext = 'http' | 'system';

export class PlutonHttpException extends HttpException {
  readonly errorInfo: ErrorInfo;
  readonly causes: unknown[];

  constructor(errorInfo: ErrorInfo, cause?: unknown) {
    super({ code: errorInfo.code, message: errorInfo.message }, errorInfo.httpCode);
    this.errorInfo = errorInfo;
    this.causes = cause === undefined ? [] : [cause];
    if (cause instanceof Error && cause.stack) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }
}

export class PlutonSystemException extends Error {
  readonly errorInfo: ErrorInfo;
  readonly causes: unknown[];

  constructor(errorInfo: ErrorInfo, cause?: unknown) {
    super(errorInfo.message);
    this.errorInfo = errorInfo;
    this.causes = cause === undefined ? [] : [cause];
    if (cause instanceof Error && cause.stack) {
      this.stack = `${this.stack}\nCaused by: ${cause.stack}`;
    }
  }
}

export type PlutonExceptionType = PlutonHttpException | PlutonSystemException;

export function PlutonException(
  errorInfo: ErrorInfo,
  cause?: unknown,
  context: PlutonContext = 'http',
): PlutonExceptionType {
  if (cause instanceof EntityNotFoundError && errorInfo === SystemErrors.General) {
    return context === 'system'
      ? new PlutonSystemException(SystemErrors.NotFound, cause)
      : new PlutonHttpException(SystemErrors.NotFound, cause);
  }
  return context === 'system'
    ? new PlutonSystemException(errorInfo, cause)
    : new PlutonHttpException(errorInfo, cause);
}

export function isPlutonException(err: unknown, info?: ErrorInfo): boolean {
  if (!(err instanceof PlutonHttpException) && !(err instanceof PlutonSystemException)) {
    return false;
  }
  if (!info) return true;
  return err.errorInfo.code === info.code;
}
