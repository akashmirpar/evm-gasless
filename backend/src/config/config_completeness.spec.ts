import { readFileSync, readdirSync, statSync } from 'fs';
import { load as parseYaml } from 'js-yaml';
import { join, resolve } from 'path';

import { isSecretKey } from './yaml_reader';

/**
 * Guards the RIN-135 acceptance criterion: config.yaml holds all public config
 * and .env holds only secrets. Both Criticals from the RIN-135 review were keys
 * the code reads that never made it into the YAML — invisible to every other
 * test because the secret-file overlay happened to supply them.
 */

const SRC_DIR = resolve(__dirname, '..');
const CONFIG_YAML = resolve(__dirname, '..', '..', 'config.yaml');

/** Supplied by the runtime/orchestrator, never by our config files. */
const RUNTIME_KEYS = new Set(['NODE_ENV', 'HOSTNAME', 'GASLESS_CONFIG', 'GASLESS_ENV_FILE']);

/**
 * Secrets and their fallbacks: they belong in the secret file, so they are
 * deliberately absent from (or only `${VAR}`-referenced in) the YAML.
 */
const SECRET_KEYS = new Set([
  'OPERATOR_PRIVATE_KEY',
  'TEST_MNEMONIC',
]);

function camelToSnakeUpper(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toUpperCase();
}

function flattenKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  const out: string[] = [];
  for (const [rawKey, val] of Object.entries(obj)) {
    if (rawKey === 'chains') continue;
    const full = prefix ? `${prefix}_${camelToSnakeUpper(rawKey)}` : camelToSnakeUpper(rawKey);
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      out.push(...flattenKeys(val as Record<string, unknown>, full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('config completeness (config.yaml vs the keys src/ reads)', () => {
  const declared = new Set(flattenKeys(parseYaml(readFileSync(CONFIG_YAML, 'utf8')) as Record<string, unknown>));
  const files = sourceFiles(SRC_DIR);

  function readKeys(pattern: RegExp): Map<string, string> {
    const found = new Map<string, string>();
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(pattern)) {
        const key = match[1];
        if (!found.has(key)) found.set(key, file.replace(`${SRC_DIR}/`, ''));
      }
    }
    return found;
  }

  it('every process.env.X read in src/ is declared in config.yaml (or is a secret/runtime key)', () => {
    const undeclared = [...readKeys(/process\.env\.([A-Z][A-Z0-9_]*)/g)]
      .filter(([key]) => !declared.has(key) && !RUNTIME_KEYS.has(key) && !SECRET_KEYS.has(key))
      .map(([key, file]) => `${key} (${file})`);

    expect(undeclared).toEqual([]);
  });

  it("every config.get('X') read in src/ is declared in config.yaml (or is a secret/runtime key)", () => {
    const undeclared = [...readKeys(/\.get(?:<[^>]*>)?\(\s*'([A-Z][A-Z0-9_]*)'/g)]
      .filter(([key]) => !declared.has(key) && !RUNTIME_KEYS.has(key) && !SECRET_KEYS.has(key))
      .map(([key, file]) => `${key} (${file})`);

    expect(undeclared).toEqual([]);
  });

  // The mirror only writes non-secret keys onto process.env, so a knob READ via
  // process.env whose name matches a secret pattern would silently miss the
  // mirror and revert to its code default. Renaming a knob into a *_TOKEN/_SECRET
  // suffix would trip this rather than ship a stale default (the class the
  // percentile revert belonged to).
  it('no process.env-read knob in src/ has a secret-shaped name that the mirror would drop', () => {
    const mirrorMisses = [...readKeys(/process\.env\.([A-Z][A-Z0-9_]*)/g)]
      .filter(([key]) => !RUNTIME_KEYS.has(key) && isSecretKey(key))
      .map(([key, file]) => `${key} (${file})`);

    expect(mirrorMisses).toEqual([]);
  });

  it('config.yaml carries no literal secret — secret-shaped keys are ${VAR} references only', () => {
    const raw = readFileSync(CONFIG_YAML, 'utf8');
    const offenders: string[] = [];
    for (const line of raw.split('\n')) {
      const match = line.match(/^\s*([A-Za-z][A-Za-z0-9]*)\s*:\s*(.+)$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      const flat = camelToSnakeUpper(key);
      const isSecretShaped = /(MNEMONIC|PRIVATE_KEY|PASSWORD|API_KEY|SECRET)$/.test(flat);
      if (!isSecretShaped) continue;
      const value = rawValue.trim().replace(/^['"]|['"]$/g, '');
      if (value && !value.startsWith('${')) offenders.push(`${key}: ${value.slice(0, 12)}…`);
    }
    expect(offenders).toEqual([]);
  });
});
