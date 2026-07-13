/** One token's USD price + decimals, as pulled from Rango `/basic/meta`. */
export interface TokenPriceEntry {
  usdPrice: number;
  decimals: number;
}

/**
 * The full price snapshot written by the refresh job and read by the estimator.
 * `tokens` is keyed by `priceKey(chainName, address)`; `updatedAt` is a unix-ms
 * timestamp used for the staleness guard.
 */
export interface PriceBlob {
  updatedAt: number;
  tokens: Record<string, TokenPriceEntry>;
}

/** Sentinel used in the price-blob key for a chain's native asset. */
export const NATIVE_PRICE_KEY = 'NATIVE';

/**
 * Blob key for a token. Native asset (address null/empty) keys on
 * `<chain>:NATIVE`; everything else on `<chain>:<address>`. Chain name is
 * lowercased. EVM hex addresses (0x…) are lowercased so checksummed vs.
 * non-checksummed match; Solana base58 mints are case-sensitive and MUST be
 * preserved (lowercasing could collide two distinct mints).
 */
export function priceKey(chainName: string, address: string | null | undefined): string {
  const chain = chainName.trim().toLowerCase();
  if (!address || address.trim().length === 0) return `${chain}:${NATIVE_PRICE_KEY}`;
  const a = address.trim();
  const addr = a.startsWith('0x') ? a.toLowerCase() : a;
  return `${chain}:${addr}`;
}
