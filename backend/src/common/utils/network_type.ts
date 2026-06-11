export enum NetworkType {
  EVM = 'EVM',
  COSMOS = 'COSMOS',
  TON = 'TON',
  SOLANA = 'SOLANA',
  BTC = 'BTC',
}

const networkTypeRegistry = new Map<number, NetworkType>();

export function registerNonEvmChain(chainId: number, networkType: NetworkType): void {
  networkTypeRegistry.set(chainId, networkType);
}

export function networkTypeOf(chainId: number): NetworkType {
  return networkTypeRegistry.get(chainId) ?? NetworkType.EVM;
}
