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
import { Logger } from '@nestjs/common';
import { existsSync, readFileSync } from 'fs';
import { load as parseYaml } from 'js-yaml';
import { resolve } from 'path';

import { readSecretConfig } from './secret_reader';

const logger = new Logger('ConfigLoader');

let configPath = './config.yaml';
let merged: Record<string, string | number | boolean> | null = null;
let mirroredKeys: string[] = [];

const VAR_RE = /\$\{([A-Z0-9_]+)\}/g;

const SECRET_KEY_PATTERNS = [/_MNEMONIC$/, /_PRIVATE_KEY$/, /_PASSWORD$/, /_API_KEY$/, /_SECRET$/, /_UUID$/, /_TOKEN$/];

/** Keys never mirrored onto process.env (see the mirror loop in loadConfig). */
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((re) => re.test(key));
}

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
      // A valueless YAML key (`foo:`) parses as null; keep it an empty string so
      // the mirror below can't write the literal 'null' into process.env.
      out[full] = val === null ? '' : val;
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
function expandUrlOrNull(url: string, secrets: Record<string, string>, missing?: string[]): string | null {
  let unresolved = false;
  const out = url.replace(VAR_RE, (_m, varName: string) => {
    const val = secrets[varName] ?? process.env[varName];
    if (val === undefined || val === '') {
      unresolved = true;
      missing?.push(varName);
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
  warnOnLegacyRpcOverrides(secrets, chains as Record<string, unknown>[]);
  return chains.map((chain) => {
    const source = chain as Record<string, unknown>;
    const expanded = expandDeep(chain, secrets) as Record<string, unknown>;
    const label = String(source?.name ?? source?.chainId ?? '?');

    const override = rpcOverrideFor(source, secrets);
    if (override) {
      logger.log(`chain ${label}: rpcUrls overridden by ${override.key} (${override.urls.length} endpoint(s))`);
      expanded.rpcUrls = override.urls;
      return expanded;
    }

    const rawRpc = source?.rpcUrls;
    if (Array.isArray(rawRpc)) {
      const kept: string[] = [];
      for (const u of rawRpc) {
        if (typeof u !== 'string') continue;
        const missing: string[] = [];
        const resolved = expandUrlOrNull(u, secrets, missing);
        if (resolved === null) {
          logger.warn(
            `chain ${label}: dropped RPC endpoint ${u} — unset ${[...new Set(missing)].join(', ')}. ` +
              `Falling back to the remaining (keyless, rate-limited) endpoints.`,
          );
          continue;
        }
        kept.push(resolved);
      }
      if (kept.length === 1) {
        logger.warn(`chain ${label}: only one RPC endpoint resolved — no fallback if it rate-limits or fails.`);
      }
      expanded.rpcUrls = kept;
    }
    return expanded;
  });
}

function rpcOverrideKeys(chain: Record<string, unknown>): string[] {
  const keys: string[] = [];
  const name = typeof chain?.name === 'string' ? chain.name : '';
  if (name) keys.push(`CHAINS_${camelToSnakeUpper(name.replace(/-/g, '_'))}_RPC_URLS`);
  if (chain?.chainId !== undefined) keys.push(`CHAINS_${String(chain.chainId)}_RPC_URLS`);
  return keys;
}

function rpcOverrideFor(
  chain: Record<string, unknown>,
  secrets: Record<string, string>,
): { key: string; urls: string[] } | null {
  for (const key of rpcOverrideKeys(chain)) {
    const raw = (secrets[key] ?? process.env[key] ?? '').trim();
    if (!raw) continue;
    const urls = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    if (urls.length > 0) return { key, urls };
  }
  return null;
}

/**
 * `<CHAIN>_RPC_URLS` was the pre-RIN-135 override. It is no longer read, so a
 * deployment still carrying paid endpoints there would silently move to the
 * YAML list on its first restart. Name the key and the replacement instead.
 */
function warnOnLegacyRpcOverrides(secrets: Record<string, string>, chains: Record<string, unknown>[]): void {
  const supported = new Set(chains.flatMap((c) => rpcOverrideKeys(c)));
  const seen = new Set<string>();
  for (const key of [...Object.keys(secrets), ...Object.keys(process.env)]) {
    if (!key.endsWith('_RPC_URLS') || supported.has(key) || seen.has(key)) continue;
    seen.add(key);
    logger.warn(
      `${key} is set but no longer read — RPC endpoints now live in config.yaml under chains[].rpcUrls. ` +
        `To override at deploy time use ${[...supported].join(' / ') || 'CHAINS_<NAME>_RPC_URLS'}.`,
    );
  }
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
  // Guard empties the same way the process.env fold does: a blanked override in
  // the secret file (`GASLESS_TX_GAS_LIMIT=`) must not shadow the YAML default.
  for (const [k, v] of Object.entries(secrets)) {
    if (v !== '') expanded[k] = v;
  }

  // Treat any key that resolved to '' as ABSENT. An empty value reaches a
  // consumer's `Number()`/`BigInt()` as 0/0n rather than firing its `?? default`,
  // silently zeroing money-path knobs (gas limit, slippage, markup, priority
  // ceiling, prefund cap, HTTP timeout). Empties arrive two ways not covered by
  // the folds above: an unset `${VAR}` in the YAML (expandVars returns '') and a
  // YAML key left blank on purpose. Dropping them makes '' and "unset" identical,
  // which is the intended contract — a knob is either configured or defaulted.
  for (const k of Object.keys(expanded)) {
    if (expanded[k] === '') delete expanded[k];
  }

  // Mirror the resolved config back onto process.env so services that still read
  // process.env.* directly see the SAME values as ConfigService consumers. Runs
  // during ConfigModule init, before any service constructor reads process.env.
  //
  // Secrets are excluded: process.env is readable via /proc/<pid>/environ, is
  // inherited by every spawned child, and is serialized by crash handlers —
  // the same exposure docs/secrets-and-config-convention.md forbids in
  // docker-compose `environment:`. Nothing in src/ reads a secret this way;
  // secrets are resolved through ConfigService / readSecretConfig().
  // Track only the keys the mirror INTRODUCES (absent from process.env before),
  // so __resetConfigCache can undo them. Without this, a key mirrored on one boot
  // survives on process.env and the env-override fold on the next boot picks up
  // that stale value, shadowing the new YAML — a nondeterminism trap for the
  // multi-boot e2e harness. Pre-existing env vars (real overrides) are left alone.
  for (const [k, v] of Object.entries(expanded)) {
    if (isSecretKey(k)) continue;
    if (!(k in process.env)) mirroredKeys.push(k);
    process.env[k] = String(v);
  }

  merged = expanded;
  return merged;
}

export function __resetConfigCache() {
  merged = null;
  // Undo the mirror so a re-boot doesn't inherit the previous boot's values via
  // the env-override fold. Only keys the mirror introduced are removed.
  for (const k of mirroredKeys) delete process.env[k];
  mirroredKeys = [];
}
