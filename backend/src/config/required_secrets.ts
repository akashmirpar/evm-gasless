import { loadConfig } from './yaml_reader';

/**
 * Values that must be supplied explicitly in production. Each has a
 * developer-friendly fallback that is wrong-but-running in production:
 *   - DATABASE_POSTGRES_PASSWORD falls back to the dev literal `gasless`.
 *   - GASLESS_SOLANA_TREASURY_ADDRESS: an unset Solana treasury makes the batch
 *     builder / fee estimator fall back to the operator's OWN pubkey, so user
 *     fees accrue in the operator wallet. (The EVM treasury has no fallback — an
 *     unset value is '' and every accepted-fee request throws instead — but it
 *     is still required for the service to function.)
 */
const REQUIRED_IN_PRODUCTION = [
  'DATABASE_POSTGRES_PASSWORD',
  'GASLESS_TREASURY_ADDRESS',
  'GASLESS_SOLANA_TREASURY_ADDRESS',
];

// The EVM relayer resolves its operator at boot from OPERATOR_MNEMONIC or
// OPERATOR_PRIVATE_KEY specifically (EvmExecutorService.onModuleInit), and
// RelayerModule is always imported. So an EVM-capable seed is separately
// required — a Solana-only seed would pass a generic check and then crash DI.
const EVM_SEED_KEYS = ['OPERATOR_MNEMONIC', 'OPERATOR_PRIVATE_KEY'];

export function assertRequiredSecrets(nodeEnv: string | undefined = process.env.NODE_ENV): void {
  if ((nodeEnv ?? '').toLowerCase() !== 'production') return;

  const config = loadConfig();
  const value = (key: string): string => String(config[key] ?? '').trim();
  const missing = REQUIRED_IN_PRODUCTION.filter((key) => !value(key));

  if (!EVM_SEED_KEYS.some((key) => value(key))) {
    missing.push(`one of ${EVM_SEED_KEYS.join(' / ')}`);
  }

  if (missing.length > 0) {
    throw new Error(
      `refusing to start in production without: ${missing.join(', ')}. ` +
        `Set them in the secret file (/run/secrets/gasless_env or $GASLESS_ENV_FILE).`,
    );
  }
}
