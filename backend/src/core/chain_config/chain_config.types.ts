import { NetworkType } from '../../common/utils/network_type';

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
  networkType: NetworkType;
  rangoChainName: string;
  rpcUrls: string[];
  tokens: ChainTokenConfig[];
  /** EVM only — null on Solana (no delegation contract; native fee-payer). */
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
    networkType?: 'EVM' | 'SOLANA';
    rangoChainName: string;
    defaultRpcs: string[];
    tokens: Record<string, { address: string; decimals: number }>;
    envRpcVar: string;
  }>;
}
