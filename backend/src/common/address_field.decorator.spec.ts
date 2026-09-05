import { ValidationPipe } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { IsInt, validateSync } from 'class-validator';
import { createRequire } from 'module';
import { dirname } from 'path';

import { CHAIN_ID_SOLANA_MAINNET } from '@getomnichain/omnichain';

import { AddressField, NATIVE_TOKEN_SENTINEL } from './address_field.decorator';

/**
 * Guards the regression the package's `AddressField` introduced (dropped native
 * sentinel short-circuit) and the contract that a retired chainId is left for
 * the service to reject with CHAIN_NOT_SUPPORTED, not mislabelled as a bad
 * address. Runs through both `validateSync` and the real Nest `ValidationPipe`.
 */
class FeeDto {
  @IsInt()
  chainId!: number;

  @AddressField('chainId')
  feeTokenAddress!: string;
}

function run(chainId: number, feeTokenAddress: string): { ok: boolean; value: string } {
  const dto = plainToInstance(FeeDto, { chainId, feeTokenAddress });
  const errors = validateSync(dto, { whitelist: true });
  return { ok: errors.length === 0, value: dto.feeTokenAddress };
}

describe('AddressField — native sentinel + per-family canonicalization', () => {
  const BSC = 56;

  it.each([
    ['lowercase', '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'],
    ['uppercase', '0xEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE'],
    ['EIP-55 mixed', '0xEeeeeEeeeEeEeeEeEeeeeEEeEeeeeEeeeeeeEEeE'],
    ['non-checksum mixed', '0xEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEe'],
  ])('accepts the native sentinel (%s) and canonicalizes to the lowercase sentinel', (_label, input) => {
    const { ok, value } = run(BSC, input);
    expect(ok).toBe(true);
    expect(value).toBe(NATIVE_TOKEN_SENTINEL);
  });

  it('accepts and lowercases a real EVM address', () => {
    const { ok, value } = run(BSC, '0x55d398326f99059fF775485246999027B3197955');
    expect(ok).toBe(true);
    expect(value).toBe('0x55d398326f99059ff775485246999027b3197955');
  });

  it('rejects a malformed EVM address', () => {
    expect(run(BSC, '0xnothex').ok).toBe(false);
    expect(run(BSC, 'not-an-address').ok).toBe(false);
  });

  it('accepts a base58 Solana address on a Solana chain, unchanged', () => {
    const { ok, value } = run(CHAIN_ID_SOLANA_MAINNET, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
    expect(ok).toBe(true);
    expect(value).toBe('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  });

  it('rejects a malformed Solana address', () => {
    expect(run(CHAIN_ID_SOLANA_MAINNET, 'not base58 !!!').ok).toBe(false);
  });

  it('lets a retired chainId (-100) PASS DTO validation so the service returns CHAIN_NOT_SUPPORTED', () => {
    // The address itself is well-formed; the chain is what is unsupported. The
    // DTO must not mislabel this as an invalid address on the fee-token field.
    expect(run(-100, '0x55d398326f99059ff775485246999027b3197955').ok).toBe(true);
  });
});

describe('AddressField — through the real Nest ValidationPipe', () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true });
  const meta = { type: 'body' as const, metatype: FeeDto };

  it('rejects a malformed address with a 400', async () => {
    await expect(pipe.transform({ chainId: 56, feeTokenAddress: 'bogus' }, meta)).rejects.toMatchObject({ status: 400 });
  });

  it('accepts + canonicalizes the native sentinel', async () => {
    const out = (await pipe.transform({ chainId: 56, feeTokenAddress: '0xEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEe' }, meta)) as FeeDto;
    expect(out.feeTokenAddress).toBe(NATIVE_TOKEN_SENTINEL);
  });
});

describe('class-validator / class-transformer are single installed instances (no silent-bypass dup)', () => {
  // A duplicate copy of either package resolved by the omnichain package would
  // mean its decorators register on a DIFFERENT metadata store than the app's
  // ValidationPipe reads — validation would silently pass everything. Compare
  // the resolved PACKAGE ROOT (dir of its package.json), not an entry file.
  const pkgRequire = createRequire(require.resolve('@getomnichain/omnichain/package.json'));

  it.each(['class-validator', 'class-transformer'])('%s resolves to one package root for app and omnichain', (pkg) => {
    const appRoot = dirname(require.resolve(`${pkg}/package.json`));
    const pkgRoot = dirname(pkgRequire.resolve(`${pkg}/package.json`));
    expect(pkgRoot).toBe(appRoot);
  });
});
