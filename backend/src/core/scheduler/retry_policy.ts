export interface RetryPolicy {
  maxRetryTimes: number;
  baseDelayMs: number;
  exponentialRate: number;
}

export function computeNextRetryAt(policy: RetryPolicy, retryTimes: number, now: Date): Date {
  const delayMs = policy.baseDelayMs * Math.pow(policy.exponentialRate, retryTimes);
  return new Date(now.getTime() + delayMs);
}

export function isRetryExhausted(policy: RetryPolicy, retryTimes: number): boolean {
  return retryTimes >= policy.maxRetryTimes;
}
