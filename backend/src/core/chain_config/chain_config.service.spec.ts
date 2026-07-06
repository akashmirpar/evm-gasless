import { NATIVE_TOKEN_SENTINEL, isNativeSentinel } from './chain_config.service';

describe('isNativeSentinel', () => {
  it('true for lowercase sentinel', () => {
    expect(isNativeSentinel(NATIVE_TOKEN_SENTINEL)).toBe(true);
  });

  it('true for uppercase sentinel', () => {
    expect(isNativeSentinel('0xEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE')).toBe(true);
  });

  it('true for mixed-case sentinel with padding whitespace', () => {
    expect(isNativeSentinel('  0xEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEe ')).toBe(true);
  });

  it('false for zero address', () => {
    expect(isNativeSentinel('0x0000000000000000000000000000000000000000')).toBe(false);
  });

  it('false for a real ERC-20 address', () => {
    expect(isNativeSentinel('0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9')).toBe(false);
  });
});
