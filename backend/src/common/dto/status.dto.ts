export class StatusResponseDto {
  requestId!: string;
  status!: string;
  chainId!: number;
  txHash!: string | null;
  retryTimes!: number;
  failureReason!: string | null;
  /**
   * Structured tag classifying the on-chain failure (Solana MINED_FAILED
   * receipts only). `null` for success/pending, EVM, or rows written before
   * this field was added. Values:
   *   - `market_rejection` — aggregator route hit a DEX rejection (slippage,
   *     pool state moved). Client should retry with a fresh /estimate.
   *   - `insufficient_balance` — user's account short at execution time.
   *   - `size_limit` — tx exceeded Solana's 1232-byte wire budget.
   *   - `other` — everything else. Terminal, don't retry.
   */
  failureCategory?: string | null;
  createdAt!: string;
  updatedAt!: string | null;
}
