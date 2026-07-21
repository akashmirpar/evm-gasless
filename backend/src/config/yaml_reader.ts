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

/** Stage the path for the config file. Must be called before app.module is imported. */
export function yamlReader(path: string) {
  configPath = path;
  merged = null;
}

/**
 * Resolve the config file path from `--config <path>`, then `PLUTON_CONFIG`,
 * falling back to `./config.yaml`. Used by `main.ts` to stage the config
 * before anything reads it.
 */
export function parseConfigPath(): string {
  const idx = process.argv.findIndex((a) => a === '--config');
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return process.env.PLUTON_CONFIG ?? './config.yaml';
}

/**
 * Returns the merged & flattened config map. Computed once and cached.
 * Order of precedence (later overrides earlier):
 *   1. YAML file (after `${...}` expansion against secrets)
 *   2. Secret file values
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

  const flat = flatten(yamlMap, '', {});
  const expanded: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(flat)) {
    expanded[k] = expandVars(v, secrets) as string | number | boolean;
  }

  // Secrets override YAML keys at the same flattened name.
  for (const [k, v] of Object.entries(secrets)) {
    expanded[k] = v;
  }

  merged = expanded;
  return merged;
}

export function __resetConfigCache() {
  merged = null;
}
