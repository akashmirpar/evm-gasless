/**
 * Single source of truth for the native-gas-token sentinel. Industry-standard
 * address (1inch / Rango / Paraswap) used to mean "the chain's native coin" on
 * the fee-token field. Imported by both the DTO address decorator and
 * ChainConfigService so the native-fee money path can't drift between the two.
 */
export const NATIVE_TOKEN_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

export function isNativeSentinel(address: string): boolean {
  return address.trim().toLowerCase() === NATIVE_TOKEN_SENTINEL;
}
