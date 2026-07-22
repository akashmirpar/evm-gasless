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
  delegateContractAddress: string | null;
  acceptedFeeTokenAddresses: string[];
  mainFeeTokenAddress: string;
  tokens: ChainTokenConfig[];
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
    rpcUrls: string[];
    acceptedFeeTokens?: string[];
    mainFeeToken?: string;
    tokens?: Record<string, { address: string; decimals: number }>;
  }>;
}
