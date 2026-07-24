/**
 * Reads `KEY=VALUE` pairs from a secret file. Ordered lookup:
 *   1. /run/secrets/gasless_env (Docker secret)
 *   2. $GASLESS_ENV_FILE
 *   3. ./.env (relative to cwd)
 *
 * Lines starting with `#` and empty lines are ignored. Values may be quoted
 * with single or double quotes; surrounding whitespace is trimmed.
 *
 * The result is cached in-process so callers can call `readSecretConfig()`
 * many times without re-reading the file.
 */
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';

let cache: Record<string, string> | null = null;

const DEFAULT_PATHS = ['/run/secrets/gasless_env'];

function pickSecretsPath(): string | null {
  for (const p of DEFAULT_PATHS) {
    if (existsSync(p)) return p;
  }
  if (process.env.GASLESS_ENV_FILE && existsSync(process.env.GASLESS_ENV_FILE)) {
    return process.env.GASLESS_ENV_FILE;
  }
  const dotenv = resolve(process.cwd(), '.env');
  if (existsSync(dotenv)) return dotenv;
  return null;
}

function parseDotenv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function readSecretConfig(forceRefresh = false): Record<string, string> {
  if (cache && !forceRefresh) return cache;
  const path = pickSecretsPath();
  if (!path) {
    cache = {};
    return cache;
  }
  const raw = readFileSync(path, 'utf8');
  cache = parseDotenv(raw);
  return cache;
}

/** Internal: clears the cache. Used by tests. */
export function __resetSecretCache() {
  cache = null;
}
