// Chain the 3 Solana e2e scenarios back-to-back with pre-flight balance
// checks, so a single command tells you the whole matrix result.
//
// Usage:
//   node scripts/test-matrix.mjs                       # runs S1, S2, S3
//   node scripts/test-matrix.mjs --only=1,3            # subset
//
// Runs the two jest specs for scenarios 1+2 and the mjs driver for scenario 3
// as subprocesses; captures pass/fail/timing per scenario; prints summary.

import { readFileSync } from 'fs';
import { spawn } from 'child_process';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, getAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const argv = Object.fromEntries(process.argv.slice(2).map(a => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));

const only = argv.only ? new Set(String(argv.only).split(',')) : null;
const wants = n => !only || only.has(String(n));

function solanaUser() {
  const rawIdx = process.env.TEST_SOLANA_ACCOUNT_INDEX;
  if (rawIdx === undefined || rawIdx === '') {
    throw new Error('TEST_SOLANA_ACCOUNT_INDEX not set — refusing to guess (see .env.example)');
  }
  const seed = bip39.mnemonicToSeedSync(process.env.TEST_SOLANA_SENDER_PRIVATE_KEY, '');
  const { key } = derivePath(`m/44'/501'/${Number(rawIdx)}'/0'`, seed.toString('hex'));
  return Keypair.fromSeed(key);
}

const SOL_RPC = (process.env.SOLANA_RPC_URLS?.split(',')[0] || 'https://api.mainnet-beta.solana.com').trim();
const USDC = { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', prog: TOKEN_PROGRAM_ID,   dec: 6 };
const BONK = { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', prog: TOKEN_PROGRAM_ID,   dec: 5 };
const XTSLA= { mint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', prog: TOKEN_2022_PROGRAM_ID, dec: 8 };

async function balance(conn, owner, t) {
  try {
    const ata = getAssociatedTokenAddressSync(new PublicKey(t.mint), owner, true, t.prog);
    const acct = await getAccount(conn, ata, 'confirmed', t.prog);
    return acct.amount;
  } catch { return 0n; }
}

function run(cmd, args, env = {}) {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; process.stdout.write(d); });
    child.stderr.on('data', d => { err += d; process.stderr.write(d); });
    child.on('close', code => resolve({ code, out, err, ms: Date.now() - start }));
  });
}

const conn = new Connection(SOL_RPC, 'confirmed');
const user = solanaUser();

console.log('Pre-flight balance check:');
const usdc = await balance(conn, user.publicKey, USDC);
const bonk = await balance(conn, user.publicKey, BONK);
const xtsla = await balance(conn, user.publicKey, XTSLA);
const sol = await conn.getBalance(user.publicKey);
console.log(`  USDC:  ${(Number(usdc) / 1e6).toFixed(6)}   need ≥0.0001 for S1`);
console.log(`  BONK:  ${(Number(bonk) / 1e5).toFixed(6)}   need ≥100000 base units for S2 fee+transfer`);
console.log(`  xTSLA: ${(Number(xtsla) / 1e8).toFixed(6)}   need ≥0.008 for S3`);
console.log(`  SOL:   ${(sol / 1e9).toFixed(6)}    need >0.001 for operator fees`);

const preflightErrors = [];
if (wants(1) && usdc < 100n) preflightErrors.push('S1 needs ≥100 USDC base units');
if (wants(2) && bonk < 100_000n) preflightErrors.push('S2 needs ≥100000 BONK base units');
if (wants(3) && xtsla < 800_000n) preflightErrors.push('S3 needs ≥800000 xTSLA base units (0.008)');
if (sol < 1_000_000n) preflightErrors.push('operator needs >0.001 SOL');

if (preflightErrors.length) {
  console.error('\nPre-flight failed:');
  for (const e of preflightErrors) console.error(`  - ${e}`);
  console.error('\nTop up via `node scripts/route-funds.mjs --plan` then re-run.');
  process.exit(2);
}

const jestBase = ['jest', '--config', 'test/jest-e2e.json', 'test/e2e/solana.live.e2e-spec.ts', '--testTimeout=300000', '--forceExit'];
const results = [];

if (wants(1)) {
  console.log('\n=== Scenario 1: USDC transfer + USDC fee ===');
  const r = await run('npx', [...jestBase, '-t', 'USDC transfer'], { E2E_LIVE: '1' });
  results.push({ n: 1, name: 'USDC transfer + USDC fee', ok: r.code === 0, ms: r.ms });
}
if (wants(2)) {
  console.log('\n=== Scenario 2: BONK swap-fee + BONK transfer ===');
  const r = await run('npx', [...jestBase, '-t', 'swap-fee path'], { E2E_LIVE: '1' });
  results.push({ n: 2, name: 'BONK swap-fee + BONK transfer', ok: r.code === 0, ms: r.ms });
}
if (wants(3)) {
  console.log('\n=== Scenario 3: xTSLA fee + xTSLA→USDT@BSC bridge ===');
  const r = await run('node', ['scripts/scenario3_xtsla_bridge.mjs']);
  results.push({ n: 3, name: 'xTSLA fee + xTSLA→USDT@BSC bridge', ok: r.code === 0, ms: r.ms });
}

console.log('\n=== SUMMARY ===');
for (const r of results) {
  console.log(`  S${r.n} ${r.ok ? 'PASS' : 'FAIL'}  (${(r.ms / 1000).toFixed(1)}s)  ${r.name}`);
}
process.exit(results.every(r => r.ok) ? 0 : 1);
