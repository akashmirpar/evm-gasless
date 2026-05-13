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
  evmTransaction: RangoEvmCall;
  raw: unknown;
}
