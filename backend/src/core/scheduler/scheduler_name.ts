export const SchedulerName = {
  EvmRelayer: 'SCHEDULER_EVM_RELAYER',
  TokenPriceRefresh: 'SCHEDULER_TOKEN_PRICE_REFRESH',
} as const;

export type SchedulerName = (typeof SchedulerName)[keyof typeof SchedulerName];

export function timeOverrideEnvKey(name: SchedulerName): string {
  return `${name}_TIME`;
}
