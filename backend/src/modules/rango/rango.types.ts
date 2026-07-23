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

export interface RangoSolanaCall {
  /** v0 message bytes (no signatures envelope) ready for MessageV0.deserialize. */
  serializedMessage: Uint8Array;
  recentBlockhash: string;
  /** Sender pubkey the message was compiled for. */
  from: string;
  /** 'VERSIONED' (almost always Jupiter today) or 'LEGACY'. */
  txType: 'VERSIONED' | 'LEGACY';
}

export interface RangoSwapResult {
  outputAmount: BigNumber;
  outputAmountMin: BigNumber;
  requestId: string;
  /** Populated when the route lands on an EVM chain. */
  evmTransaction?: RangoEvmCall;
  /** Populated when the route lands on Solana. */
  solanaTransaction?: RangoSolanaCall;
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
