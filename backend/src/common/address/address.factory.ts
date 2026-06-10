import { NetworkType, networkTypeOf } from '../utils/network_type';
import { SolanaAddress } from '../chain/solana/solana_address';
import { Address } from './address';
import { EvmAddress } from './evm_address';

export function addressFor(chainId: number, raw: string): Address {
  switch (networkTypeOf(chainId)) {
    case NetworkType.SOLANA:
      return new SolanaAddress(raw);
    case NetworkType.EVM:
    default:
      return new EvmAddress(raw);
  }
}

export function canonicalizeAddress(chainId: number, raw: string): string {
  return addressFor(chainId, raw).canonical();
}

export function tryCanonicalizeAddress(chainId: number, raw: string): string {
  try {
    return canonicalizeAddress(chainId, raw);
  } catch {
    return raw;
  }
}
