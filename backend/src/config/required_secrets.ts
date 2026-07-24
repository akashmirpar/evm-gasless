import { loadConfig } from './yaml_reader';

/**
 * Values that must be supplied explicitly in production. Each one has a
 * developer-friendly fallback that is wrong-but-running in production:
 * the DB password falls back to the dev literal `gasless`, and an unset
 * treasury makes ChainConfigService fall back to the operator's own address,
 * so user fees would accumulate in the operator wallet instead of the treasury.
 */
const REQUIRED_IN_PRODUCTION = [
  'DATABASE_POSTGRES_PASSWORD',
  'GASLESS_TREASURY_ADDRESS',
  'GASLESS_SOLANA_TREASURY_ADDRESS',
];

const OPERATOR_SEED_KEYS = [
  'OPERATOR_MNEMONIC',
  'OPERATOR_PRIVATE_KEY',
  'SOLANA_OPERATOR_MNEMONIC',
  'SOLANA_OPERATOR_PRIVATE_KEY',
];

export function assertRequiredSecrets(nodeEnv: string | undefined = process.env.NODE_ENV): void {
  if ((nodeEnv ?? '').toLowerCase() !== 'production') return;

  const config = loadConfig();
  const value = (key: string): string => String(config[key] ?? '').trim();
  const missing = REQUIRED_IN_PRODUCTION.filter((key) => !value(key));

  if (!OPERATOR_SEED_KEYS.some((key) => value(key))) {
    missing.push(`one of ${OPERATOR_SEED_KEYS.join(' / ')}`);
  }

  if (missing.length > 0) {
    throw new Error(
      `refusing to start in production without: ${missing.join(', ')}. ` +
        `Set them in the secret file (/run/secrets/gasless_env or $GASLESS_ENV_FILE).`,
    );
  }
}
