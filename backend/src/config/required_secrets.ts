import { loadConfig } from './yaml_reader';

/**
 * Values that must be supplied explicitly in production. Each has a
 * developer-friendly fallback that is wrong-but-running in production:
 *   - DATABASE_POSTGRES_PASSWORD falls back to the dev literal `gasless`.
 *   - GASLESS_TREASURY_ADDRESS has no fallback — an unset value is '' and every
 *     accepted-fee request throws — but it is still required for the service
 *     to function.
 */
const REQUIRED_IN_PRODUCTION = [
  'DATABASE_POSTGRES_PASSWORD',
  'GASLESS_TREASURY_ADDRESS',
  // The RPC provider key. Unset, loadChainsConfig drops every keyed endpoint
  // and the whole fleet silently runs on rate-limited public RPCs (only a boot
  // warning) — a broadcast path degradation that shows up as 429s under load.
  // Fail fast in production instead.
  'ANKR_API_KEY',
];

// The relayer resolves its operator at boot, so an EVM-capable seed must exist —
// validated here with a clear message rather than as an opaque DI crash.
const EVM_SEED_KEYS = ['OPERATOR_MNEMONIC', 'OPERATOR_PRIVATE_KEY'];

export function assertRequiredSecrets(nodeEnv: string | undefined = process.env.NODE_ENV): void {
  if ((nodeEnv ?? '').toLowerCase() !== 'production') return;

  const config = loadConfig();
  const value = (key: string): string => String(config[key] ?? '').trim();
  const missing = REQUIRED_IN_PRODUCTION.filter((key) => !value(key));

  if (!EVM_SEED_KEYS.some((key) => value(key))) {
    missing.push(`an EVM operator seed (one of ${EVM_SEED_KEYS.join(' / ')})`);
  }

  if (missing.length > 0) {
    throw new Error(
      `refusing to start in production without: ${missing.join(', ')}. ` +
        `Set them in the secret file (/run/secrets/gasless_env or $GASLESS_ENV_FILE).`,
    );
  }
}
