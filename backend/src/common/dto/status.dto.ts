export class StatusResponseDto {
  requestId!: string;
  status!: string;
  chainId!: number;
  txHash!: string | null;
  retryTimes!: number;
  failureReason!: string | null;
  createdAt!: string;
  updatedAt!: string | null;
}
