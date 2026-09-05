import { ValidationPipe } from '@nestjs/common';

import { EstimateRequestDto } from './estimate.dto';

/**
 * Regression guard for the `@AddressField` bypass: when the package can't resolve
 * a chain family (unsupported chainId), the decorator falls back to a
 * well-formedness floor rather than disabling validation. A malformed `to` on a
 * nested operation must still 400 — on BOTH a supported and an unsupported
 * chainId — instead of riding through to the service.
 */
describe('EstimateRequestDto — operations[].to is validated even on an unsupported chainId', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  const meta = { type: 'body' as const, metatype: EstimateRequestDto };

  const body = (chainId: number, to: string): unknown => ({
    chainId,
    userAddress: '0x55d398326f99059ff775485246999027b3197955',
    feeTokenAddress: '0x55d398326f99059ff775485246999027b3197955',
    operations: [{ chainId, to, value: '0', data: '0x' }],
  });

  it('rejects a malformed nested to on a supported chain (56)', async () => {
    await expect(pipe.transform(body(56, 'not-an-address'), meta)).rejects.toMatchObject({ status: 400 });
  });

  it('rejects a malformed nested to on a retired/unsupported chain (-100)', async () => {
    await expect(pipe.transform(body(-100, 'not-an-address'), meta)).rejects.toMatchObject({ status: 400 });
  });

  it('accepts a well-formed nested to on a retired chain (deferred to the service for CHAIN_NOT_SUPPORTED)', async () => {
    const out = (await pipe.transform(
      body(-100, '0x000000000000000000000000000000000000dEaD'),
      meta,
    )) as EstimateRequestDto;
    expect(out.operations[0].to).toBeDefined();
  });
});
