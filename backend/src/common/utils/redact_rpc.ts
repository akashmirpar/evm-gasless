/**
 * RPC URLs can carry a provider credential in their path/query (e.g.
 * `https://rpc.ankr.com/bsc/${ANKR_API_KEY}`). These helpers keep that key out
 * of logs and error payloads: `redactRpcUrl` for the URL itself, and
 * `scrubRpcSecrets` for free-text (ethers / web3.js fetch errors routinely
 * embed the full request URL in their message/stack).
 */

/** Reduce an RPC URL to `protocol//host`, dropping the key-bearing path/query. */
export function redactRpcUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return '<rpc>';
  }
}

/** Strip any of the given RPC URLs' credentials from a free-text message. */
export function scrubRpcSecrets(message: string, urls: string[]): string {
  let out = message;
  for (const url of urls) {
    if (!url) continue;
    out = out.split(url).join(redactRpcUrl(url));
    try {
      const u = new URL(url);
      if (u.pathname && u.pathname !== '/') out = out.split(u.pathname).join('/<redacted>');
      if (u.search) out = out.split(u.search).join('');
    } catch {
      /* non-URL entry — nothing to strip */
    }
  }
  return out;
}
