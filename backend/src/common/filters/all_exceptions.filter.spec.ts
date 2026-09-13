import { ArgumentsHost } from '@nestjs/common';

import { AllExceptionsFilter } from './all_exceptions.filter';
import { PlutonException } from '../errors';
import { GaslessErrors } from '../errors/gasless.errors';

function hostFor(): { host: ArgumentsHost; sent: { status?: number; body?: any } } {
  const sent: { status?: number; body?: any } = {};
  const res = {
    status(code: number) { sent.status = code; return this; },
    json(body: unknown) { sent.body = body; return this; },
  };
  const req = { headers: {}, method: 'POST', url: '/gasless/transactions' };
  const host = { switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }) } as unknown as ArgumentsHost;
  return { host, sent };
}

function withEnv(value: string | undefined, fn: () => void) {
  const saved = process.env.GASLESS_EXPOSE_ERROR_CAUSES;
  if (value === undefined) delete process.env.GASLESS_EXPOSE_ERROR_CAUSES;
  else process.env.GASLESS_EXPOSE_ERROR_CAUSES = value;
  try { fn(); } finally {
    if (saved === undefined) delete process.env.GASLESS_EXPOSE_ERROR_CAUSES;
    else process.env.GASLESS_EXPOSE_ERROR_CAUSES = saved;
  }
}

describe('AllExceptionsFilter — causes exposure gate', () => {
  const sensitive = PlutonException(GaslessErrors.PriceUnavailable, { err: 'internal', logs: ['secret log'] });

  it('omits causes from the response by default', () => {
    withEnv(undefined, () => {
      const { host, sent } = hostFor();
      new AllExceptionsFilter().catch(sensitive, host);
      expect(sent.body.error.code).toBe(GaslessErrors.PriceUnavailable.code);
      expect(sent.body.error.causes).toBeUndefined();
    });
  });

  it('includes causes only when GASLESS_EXPOSE_ERROR_CAUSES is enabled', () => {
    withEnv('true', () => {
      const { host, sent } = hostFor();
      new AllExceptionsFilter().catch(sensitive, host);
      expect(sent.body.error.causes).toBeDefined();
      expect(sent.body.error.causes.length).toBeGreaterThan(0);
    });
  });

  it('treats any non-true value as off', () => {
    withEnv('yes', () => {
      const { host, sent } = hostFor();
      new AllExceptionsFilter().catch(sensitive, host);
      expect(sent.body.error.causes).toBeUndefined();
    });
  });
});
