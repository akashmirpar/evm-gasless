import { redactRpcUrl, scrubRpcSecrets } from './redact_rpc';

const KEYED = 'https://rpc.ankr.com/bsc/SECRETKEY123';

describe('redactRpcUrl', () => {
  it('drops the key-bearing path, keeping protocol//host', () => {
    expect(redactRpcUrl(KEYED)).toBe('https://rpc.ankr.com');
  });
  it('returns <rpc> for a non-URL', () => {
    expect(redactRpcUrl('not a url')).toBe('<rpc>');
  });
});

describe('scrubRpcSecrets', () => {
  it('strips the full keyed URL from an error message', () => {
    const msg = `could not detect network (event="noNetwork", url=${KEYED})`;
    const out = scrubRpcSecrets(msg, [KEYED]);
    expect(out).not.toContain('SECRETKEY123');
    expect(out).toContain('https://rpc.ankr.com');
  });

  it('strips a bare key-bearing path even when the full URL is not verbatim', () => {
    const msg = 'FetchError: request to /bsc/SECRETKEY123 failed';
    const out = scrubRpcSecrets(msg, [KEYED]);
    expect(out).not.toContain('SECRETKEY123');
  });

  it('leaves keyless messages untouched', () => {
    const msg = 'ETIMEDOUT https://bsc-rpc.publicnode.com';
    expect(scrubRpcSecrets(msg, ['https://bsc-rpc.publicnode.com'])).toBe(msg);
  });
});
