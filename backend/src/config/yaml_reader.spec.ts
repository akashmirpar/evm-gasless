import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { __resetSecretCache } from './secret_reader';
import { __resetConfigCache, loadConfig, yamlReader } from './yaml_reader';

describe('yamlReader / loadConfig', () => {
  beforeEach(() => {
    __resetConfigCache();
    __resetSecretCache();
  });

  it('flattens nested YAML keys to UPPER_SNAKE_CASE and expands ${VAR} from process.env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gasless-cfg-'));
    const yamlPath = join(dir, 'config.yaml');
    const emptySecrets = join(dir, 'empty.env');
    writeFileSync(emptySecrets, '');
    writeFileSync(
      yamlPath,
      [
        'service:',
        "  port: '${SERVICE_PORT}'",
        'redis:',
        "  defaultTtlSeconds: '${REDIS_DEFAULT_TTL_SECONDS}'",
      ].join('\n')
    );
    process.env.SERVICE_PORT = '4242';
    process.env.REDIS_DEFAULT_TTL_SECONDS = '600';
    // Pin the secrets file so the ambient ./.env in dev environments
    // doesn't bleed in and override the values we're asserting on.
    process.env.GASLESS_ENV_FILE = emptySecrets;

    yamlReader(yamlPath);
    const cfg = loadConfig();

    expect(cfg.SERVICE_PORT).toBe('4242');
    expect(cfg.REDIS_DEFAULT_TTL_SECONDS).toBe('600');

    delete process.env.SERVICE_PORT;
    delete process.env.REDIS_DEFAULT_TTL_SECONDS;
    delete process.env.GASLESS_ENV_FILE;
  });

  it('keeps literal YAML defaults as strings (no ${...} indirection needed)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gasless-cfg-'));
    const yamlPath = join(dir, 'config.yaml');
    const emptySecrets = join(dir, 'empty.env');
    writeFileSync(emptySecrets, '');
    writeFileSync(
      yamlPath,
      ['gasless:', "  createTtlSeconds: '90'", 'solana:', "  modeDefault: 'single'"].join('\n')
    );
    process.env.GASLESS_ENV_FILE = emptySecrets;

    yamlReader(yamlPath);
    const cfg = loadConfig();

    expect(cfg.GASLESS_CREATE_TTL_SECONDS).toBe('90');
    expect(cfg.SOLANA_MODE_DEFAULT).toBe('single');

    delete process.env.GASLESS_ENV_FILE;
  });

  it('lets secret-file values override YAML values at the same flattened key', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gasless-cfg-'));
    const yamlPath = join(dir, 'config.yaml');
    const envPath = join(dir, 'env');
    writeFileSync(yamlPath, ['gasless:', "  createTtlSeconds: '90'"].join('\n'));
    writeFileSync(envPath, 'GASLESS_CREATE_TTL_SECONDS=120\n');
    process.env.GASLESS_ENV_FILE = envPath;

    yamlReader(yamlPath);
    const cfg = loadConfig();

    expect(cfg.GASLESS_CREATE_TTL_SECONDS).toBe('120');

    delete process.env.GASLESS_ENV_FILE;
  });
});
