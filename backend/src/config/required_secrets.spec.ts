import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { __resetSecretCache } from './secret_reader';
import { __resetConfigCache, yamlReader } from './yaml_reader';
import { assertRequiredSecrets } from './required_secrets';

/**
 * Boots the config loader from a throwaway secret file, then runs
 * assertRequiredSecrets as production. Covers the gap the reviewer flagged: a
 * raw EVM key with no Solana seed must fail fast here, not crash later in DI.
 */
function withSecrets(lines: string[], fn: () => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'gasless-reqsec-'));
  const yamlPath = join(dir, 'config.yaml');
  const envPath = join(dir, 'secrets.env');
  writeFileSync(yamlPath, "service:\n  port: '3100'\n");
  writeFileSync(envPath, `${lines.join('\n')}\n`);
  const prev = process.env.GASLESS_ENV_FILE;
  process.env.GASLESS_ENV_FILE = envPath;
  __resetSecretCache();
  __resetConfigCache();
  yamlReader(yamlPath);
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.GASLESS_ENV_FILE;
    else process.env.GASLESS_ENV_FILE = prev;
    __resetSecretCache();
    __resetConfigCache();
  }
}

const REQUIRED = [
  'DATABASE_POSTGRES_PASSWORD=pw',
  'GASLESS_TREASURY_ADDRESS=0xabc',
  'GASLESS_SOLANA_TREASURY_ADDRESS=SoLtreasury',
];

describe('assertRequiredSecrets (production)', () => {
  it('does nothing outside production', () => {
    withSecrets([], () => {
      expect(() => assertRequiredSecrets('development')).not.toThrow();
    });
  });

  it('passes with a unified OPERATOR_MNEMONIC (covers both EVM and Solana)', () => {
    withSecrets([...REQUIRED, 'OPERATOR_MNEMONIC=seed words here'], () => {
      expect(() => assertRequiredSecrets('production')).not.toThrow();
    });
  });

  it('throws for a raw EVM key with NO Solana seed (the reviewer gap)', () => {
    withSecrets([...REQUIRED, 'OPERATOR_PRIVATE_KEY=0xdead'], () => {
      expect(() => assertRequiredSecrets('production')).toThrow(/Solana operator seed/);
    });
  });

  it('passes for a raw EVM key plus a raw Solana key', () => {
    withSecrets([...REQUIRED, 'OPERATOR_PRIVATE_KEY=0xdead', 'SOLANA_OPERATOR_PRIVATE_KEY=base58'], () => {
      expect(() => assertRequiredSecrets('production')).not.toThrow();
    });
  });

  it('throws for a Solana-only seed with no EVM seed', () => {
    withSecrets([...REQUIRED, 'SOLANA_OPERATOR_MNEMONIC=seed'], () => {
      expect(() => assertRequiredSecrets('production')).toThrow(/EVM operator seed/);
    });
  });

  it('names every missing required secret at once', () => {
    withSecrets(['OPERATOR_MNEMONIC=seed'], () => {
      expect(() => assertRequiredSecrets('production')).toThrow(/DATABASE_POSTGRES_PASSWORD/);
    });
  });
});
