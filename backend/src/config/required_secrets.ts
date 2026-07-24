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

// Both relayers resolve their operator at boot and RelayerModule/SolanaModule
// are always imported, so BOTH an EVM-capable and a Solana-capable seed must
// exist — validated here with a clear message rather than as an opaque DI crash.
// OPERATOR_MNEMONIC satisfies both (it derives EVM m/44'/60' and Solana m/44'/501').
const EVM_SEED_KEYS = ['OPERATOR_MNEMONIC', 'OPERATOR_PRIVATE_KEY'];
const SOLANA_SEED_KEYS = ['OPERATOR_MNEMONIC', 'SOLANA_OPERATOR_MNEMONIC', 'SOLANA_OPERATOR_PRIVATE_KEY'];

export function assertRequiredSecrets(nodeEnv: string | undefined = process.env.NODE_ENV): void {
  if ((nodeEnv ?? '').toLowerCase() !== 'production') return;

  const config = loadConfig();
  const value = (key: string): string => String(config[key] ?? '').trim();
  const missing = REQUIRED_IN_PRODUCTION.filter((key) => !value(key));

  if (!EVM_SEED_KEYS.some((key) => value(key))) {
    missing.push(`an EVM operator seed (one of ${EVM_SEED_KEYS.join(' / ')})`);
  }
  if (!SOLANA_SEED_KEYS.some((key) => value(key))) {
    missing.push(`a Solana operator seed (one of ${SOLANA_SEED_KEYS.join(' / ')})`);
  }

  if (missing.length > 0) {
    throw new Error(
      `refusing to start in production without: ${missing.join(', ')}. ` +
        `Set them in the secret file (/run/secrets/gasless_env or $GASLESS_ENV_FILE).`,
    );
  }
}
