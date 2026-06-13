export const SchedulerName = {
  EvmRelayer: 'SCHEDULER_EVM_RELAYER',
  SolanaRelayer: 'SCHEDULER_SOLANA_RELAYER',
} as const;

export type SchedulerName = (typeof SchedulerName)[keyof typeof SchedulerName];

export function timeOverrideEnvKey(name: SchedulerName): string {
  return `${name}_TIME`;
}
