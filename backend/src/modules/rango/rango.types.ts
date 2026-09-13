import BigNumber from 'bignumber.js';

export interface RangoToken {
  chainName: string;
  address: string | null;
  symbol: string;
  decimals: number;
}

export interface RangoQuoteRequest {
  from: RangoToken;
  to: RangoToken;
  amount: string;
}

export interface RangoQuoteResult {
  outputAmount: BigNumber;
  outputAmountMin: BigNumber;
  requestId: string;
  raw: unknown;
}

export interface RangoSwapRequest {
  from: RangoToken;
  to: RangoToken;
  amount: string;
  userAddress: string;
  recipientAddress: string;
  slippage: number;
}

export interface RangoEvmCall {
  from: string;
  to: string;
  data: string;
  value: string;
  approveTo: string | null;
  approveData: string | null;
  approveAddress: string | null;
}

export interface RangoSwapResult {
  outputAmount: BigNumber;
  outputAmountMin: BigNumber;
  requestId: string;
  evmTransaction?: RangoEvmCall;
  raw: unknown;
}

/**
 * One token entry from Rango `/basic/meta`. `usdPrice` is null when Rango has
 * no price feed for the token. `address` is null for a chain's native asset.
 */
export interface RangoMetaToken {
  chainName: string;
  address: string | null;
  symbol: string;
  decimals: number;
  usdPrice: number | null;
}
