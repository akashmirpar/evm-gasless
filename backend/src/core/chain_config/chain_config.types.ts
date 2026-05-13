export interface ChainTokenConfig {
  symbol: string;
  address: string;
  decimals: number;
}

export interface ChainConfig {
  chainId: number;
  name: string;
  displayName: string;
  nativeSymbol: string;
  nativeDecimals: number;
  rangoChainName: string;
  rpcUrls: string[];
  tokens: ChainTokenConfig[];
  delegateContractAddress: string | null;
  acceptedFeeTokenAddresses: string[];
  treasuryAddress: string;
}

export interface ChainsJsonShape {
  chains: Array<{
    chainId: number;
    name: string;
    displayName: string;
    nativeSymbol: string;
    nativeDecimals: number;
    rangoChainName: string;
    defaultRpcs: string[];
    tokens: Record<string, { address: string; decimals: number }>;
    envRpcVar: string;
  }>;
}
