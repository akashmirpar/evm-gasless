/**
 * Reads `config.yaml`, expands `${VAR}` references against the merged secrets,
 * and flattens nested keys to UPPER_SNAKE_CASE so that ConfigService.get()
 * lookups are uniform regardless of nesting depth.
 *
 *   database:                            DATABASE_POSTGRES_HOST = '...'
 *     postgres:                          DATABASE_POSTGRES_PORT = '5432'
 *       host: '${POSTGRES_HOST}'
 *       port: 5432
 *
 * Camel-case keys are split on capitals so `defaultTtlSeconds` becomes
 * `DEFAULT_TTL_SECONDS`.
 *
 * `yamlReader(path)` is invoked from `main.ts` *before* `app.module` is
 * imported. It stores the merged map in module-state; `loadConfig()` exposes
 * it to `@nestjs/config` as a single object that ConfigService consumes. The
 * standalone TypeORM CLI (data-source.ts) calls `loadConfig()` directly since
 * it runs outside Nest's DI container.
 */
import { existsSync, readFileSync } from 'fs';
import { load as parseYaml } from 'js-yaml';
import { resolve } from 'path';

import { readSecretConfig } from './secret_reader';

let configPath = './config.yaml';
let merged: Record<string, string | number | boolean> | null = null;

const VAR_RE = /\$\{([A-Z0-9_]+)\}/g;

function camelToSnakeUpper(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toUpperCase();
}

function flatten(
  obj: Record<string, unknown>,
  prefix: string,
  out: Record<string, unknown>
): Record<string, unknown> {
  for (const [rawKey, val] of Object.entries(obj)) {
    const key = camelToSnakeUpper(rawKey);
    const full = prefix ? `${prefix}_${key}` : key;
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      flatten(val as Record<string, unknown>, full, out);
    } else {
      out[full] = val;
    }
  }
  return out;
}

function expandVars(input: unknown, secrets: Record<string, string>): unknown {
  if (typeof input !== 'string') return input;
  return input.replace(VAR_RE, (_match, varName: string) => {
    const fromSecret = secrets[varName];
    if (fromSecret !== undefined) return fromSecret;
    const fromEnv = process.env[varName];
    if (fromEnv !== undefined) return fromEnv;
    return '';
  });
}

function parseYamlFile(): Record<string, unknown> {
  const absolute = resolve(configPath);
  if (!existsSync(absolute)) return {};
  const parsed = parseYaml(readFileSync(absolute, 'utf8'));
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
}

/** Recursively expand `${VAR}` in every string leaf, preserving array/object shape. */
function expandDeep(input: unknown, secrets: Record<string, string>): unknown {
  if (typeof input === 'string') return expandVars(input, secrets);
  if (Array.isArray(input)) return input.map((v) => expandDeep(v, secrets));
  if (input !== null && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = expandDeep(v, secrets);
    }
    return out;
  }
  return input;
}

/**
 * Expand a URL's `${VAR}` refs, returning null if ANY referenced var is unset
 * (in neither the secret file nor process.env). Used to drop a keyed RPC
 * endpoint like `.../bsc/${ANKR_API_KEY}` when the key isn't configured, so the
 * keyless public fallbacks in the list are used instead of a broken URL.
 */
function expandUrlOrNull(url: string, secrets: Record<string, string>): string | null {
  let unresolved = false;
  const out = url.replace(VAR_RE, (_m, varName: string) => {
    const val = secrets[varName] ?? process.env[varName];
    if (val === undefined || val === '') {
      unresolved = true;
      return '';
    }
    return val;
  });
  return unresolved ? null : out;
}

/**
 * Structured `chains:` section from config.yaml with `${VAR}` (e.g. the RPC
 * provider key `${ANKR_API_KEY}`) expanded against the secret file / env. The
 * chain registry is nested config that doesn't fit the flat UPPER_SNAKE map, so
 * ChainConfigService reads it through here instead of `loadConfig()`. RPC URLs
 * whose provider key is unset are dropped (keyless fallbacks remain).
 */
export function loadChainsConfig(): unknown[] {
  const yamlMap = parseYamlFile();
  const chains = yamlMap['chains'];
  if (!Array.isArray(chains)) return [];
  const secrets = readSecretConfig();
  return chains.map((chain) => {
    const expanded = expandDeep(chain, secrets) as Record<string, unknown>;
    const rawRpc = (chain as Record<string, unknown>)?.rpcUrls;
    if (Array.isArray(rawRpc)) {
      expanded.rpcUrls = rawRpc
        .map((u) => (typeof u === 'string' ? expandUrlOrNull(u, secrets) : null))
        .filter((u): u is string => u !== null);
    }
    return expanded;
  });
}

/** Stage the path for the config file. Must be called before app.module is imported. */
export function yamlReader(path: string) {
  configPath = path;
  merged = null;
}

/**
 * Resolve the config file path from `--config <path>`, then `GASLESS_CONFIG`,
 * falling back to `./config.yaml`. Used by `main.ts` to stage the config
 * before anything reads it.
 */
export function parseConfigPath(): string {
  const idx = process.argv.findIndex((a) => a === '--config');
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.env.GASLESS_CONFIG ?? './config.yaml';
}

/**
 * Returns the merged & flattened config map. Computed once and cached.
 * Order of precedence (later overrides earlier):
 *   1. YAML file (after `${...}` expansion against secrets) — non-secret defaults
 *   2. process.env — deploy-time overrides for any DECLARED key (docker -e / k8s env:)
 *   3. Secret file values — secrets and final overrides
 *
 * `@nestjs/config` resolves this load-factory map BEFORE process.env, so a knob
 * shipped as a literal in the YAML would otherwise make its env var unreachable
 * (the DB path in data-source.ts reads this map with NO ConfigService fallback
 * at all). Folding process.env in here — scoped to keys the YAML already
 * declares, so unrelated host env vars can't leak in — makes the documented
 * precedence real for both the ConfigService and the raw-map consumers.
 */
export function loadConfig(): Record<string, string | number | boolean> {
  if (merged) return merged;

  const absolute = resolve(configPath);
  let yamlMap: Record<string, unknown> = {};
  if (existsSync(absolute)) {
    const raw = readFileSync(absolute, 'utf8');
    const parsed = parseYaml(raw);
    if (parsed && typeof parsed === 'object') {
      yamlMap = parsed as Record<string, unknown>;
    }
  }

  const secrets = readSecretConfig();

  // `chains:` is nested config read separately via loadChainsConfig(); exclude
  // it from the flat map so we don't carry a `CHAINS` array (with an unexpanded
  // ${ANKR_API_KEY} placeholder) as dead noise in the ConfigService map.
  const { chains: _chains, ...flatSource } = yamlMap;
  const flat = flatten(flatSource, '', {});
  const expanded: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(flat)) {
    expanded[k] = expandVars(v, secrets) as string | number | boolean;
  }

  // process.env overrides a declared YAML default (deploy-time override).
  // Scoped to keys the YAML declares so we don't absorb the whole environment.
  // Ignore an empty value so an ambient `FOO=` can't blank a declared default —
  // matches the trim-truthy convention used elsewhere (pick/resolveMode/cron).
  for (const k of Object.keys(expanded)) {
    const fromEnv = process.env[k];
    if (fromEnv !== undefined && fromEnv !== '') expanded[k] = fromEnv;
  }

  // Secret file wins over YAML and process.env at the same flattened name.
  for (const [k, v] of Object.entries(secrets)) {
    expanded[k] = v;
  }

  // Mirror the resolved config back onto process.env so services that still read
  // process.env.* directly (pricing/fee_policy, prefund sizing, price refresh,
  // exception filter) see the SAME values as ConfigService consumers. Runs during
  // ConfigModule init, before any service constructor reads process.env.
  for (const [k, v] of Object.entries(expanded)) {
    process.env[k] = String(v);
  }

  merged = expanded;
  return merged;
}

export function __resetConfigCache() {
  merged = null;
}
