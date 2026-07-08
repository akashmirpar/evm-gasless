// Given a target token+amount+wallet, tell you (dry-run) or actually execute
// the shortest Rango-routed hop that gets the funds there. Complement to
// balances.mjs — that reads state; this changes it.
//
// Usage:
//   node scripts/route-funds.mjs --plan
//     Prints a routing plan for topping up the standard e2e set-points.
//   node scripts/route-funds.mjs --target=SOL_XTSLA:0.01
//     Bridges enough xTSLA to the Solana user wallet.
//   node scripts/route-funds.mjs --target=SOL_BONK:200000
//     Bridges enough BONK, sourcing from BSC USDT.
//
// Sourcing rule: always bridge FROM `E2E_USER_PRIVATE_KEY` on BSC (USDT balance
// is the seed). Destination is the Solana user wallet at TEST_SOLANA_*_INDEX.
// Uses Rango /basic/swap the same way scenario3_xtsla_bridge.mjs does.

import { readFileSync } from 'fs';
import axios from 'axios';
import { JsonRpcProvider, Wallet as EvmWallet, Contract, formatUnits } from 'ethers';
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

const RANGO_API_URL = (process.env.RANGO_API_URL ?? 'https://api.rango.exchange').replace(/\/$/, '');
const RANGO_API_KEY = process.env.RANGO_API_KEY?.trim();
const BSC_RPC = (process.env.BSC_RPC_URLS?.split(',')[0] || 'https://bsc-rpc.publicnode.com').trim();
const SOL_RPC = (process.env.SOLANA_RPC_URLS?.split(',')[0] || 'https://api.mainnet-beta.solana.com').trim();

function solanaUser() {
  const seed = bip39.mnemonicToSeedSync(process.env.TEST_SOLANA_SENDER_PRIVATE_KEY, '');
  const idx = Number(process.env.TEST_SOLANA_ACCOUNT_INDEX || '0');
  const { key } = derivePath(`m/44'/501'/${idx}'/0'`, seed.toString('hex'));
  return Keypair.fromSeed(key);
}

const BSC_USDT = { addr: '0x55d398326f99059fF775485246999027B3197955', dec: 18, sym: 'USDT' };
const TARGETS = {
  SOL_USDC:  { chain: 'SOLANA', sym: 'USDC',  mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', dec: 6, prog: TOKEN_PROGRAM_ID,   floor: 100n },
  SOL_BONK:  { chain: 'SOLANA', sym: 'BONK',  mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', dec: 5, prog: TOKEN_PROGRAM_ID,   floor: 200_000n },
  SOL_XTSLA: { chain: 'SOLANA', sym: 'xTSLA', mint: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', dec: 8, prog: TOKEN_2022_PROGRAM_ID, floor: 1_000_000n },
};

async function solBal(conn, owner, target) {
  try {
    const ata = getAssociatedTokenAddressSync(new PublicKey(target.mint), owner, true, target.prog);
    const acct = await getAccount(conn, ata, 'confirmed', target.prog);
    return acct.amount;
  } catch { return 0n; }
}

async function bscBal(provider, address, token) {
  const c = new Contract(token.addr, ['function balanceOf(address) view returns (uint256)'], provider);
  return BigInt(await c.balanceOf(address));
}

async function rangoQuote(from, to, amount, fromAddr, toAddr) {
  const { data } = await axios.get(`${RANGO_API_URL}/basic/quote`, {
    params: { from, to, amount, apiKey: RANGO_API_KEY },
    timeout: 15_000,
  });
  return data;
}

async function main() {
  const solConn = new Connection(SOL_RPC, 'confirmed');
  const bscProvider = new JsonRpcProvider(BSC_RPC);
  const solUser = solanaUser();
  const bscUser = new EvmWallet(process.env.E2E_USER_PRIVATE_KEY, bscProvider);

  const targetsToCheck = argv.target
    ? [(() => {
        const [key, amt] = String(argv.target).split(':');
        const t = TARGETS[key];
        if (!t) throw new Error(`unknown target ${key}. known: ${Object.keys(TARGETS).join(', ')}`);
        return { key, target: t, need: BigInt(Math.floor(Number(amt) * 10 ** t.dec)) };
      })()]
    : Object.entries(TARGETS).map(([key, target]) => ({ key, target, need: target.floor }));

  const bscUsdtBal = await bscBal(bscProvider, bscUser.address, BSC_USDT);
  console.log(`Source: BSC USDT wallet ${bscUser.address} has ${formatUnits(bscUsdtBal, BSC_USDT.dec)} USDT`);

  for (const { key, target, need } of targetsToCheck) {
    const have = await solBal(solConn, solUser.publicKey, target);
    const delta = need > have ? need - have : 0n;
    const haveStr = (Number(have) / 10 ** target.dec).toFixed(6);
    const needStr = (Number(need) / 10 ** target.dec).toFixed(6);
    if (delta === 0n) {
      console.log(`  [ok]  ${key.padEnd(10)} have=${haveStr} need=${needStr} — no routing needed`);
      continue;
    }
    const rango = await rangoQuote(
      `BSC.USDT--${BSC_USDT.addr}`,
      `SOLANA.${target.sym}--${target.mint}`,
      String(delta * BigInt(10 ** (BSC_USDT.dec - target.dec)) || 100_000_000n),
      bscUser.address, solUser.publicKey.toBase58(),
    );
    const outputAmt = rango.route?.outputAmount ?? '(none)';
    console.log(`  [route needed] ${key.padEnd(10)} have=${haveStr} need=${needStr} short=${(Number(delta) / 10 ** target.dec).toFixed(6)} — Rango.${rango.route?.swapper?.title ?? 'no-route'} would deliver ~${outputAmt} base units of ${target.sym}`);
  }

  if (argv.execute) {
    console.log('\n--execute not yet implemented — this script currently plans only.');
    console.log('For an actual bridge, use scripts/bridge_bsc_usdt_to_arb_eth.mjs as the template.');
    process.exit(2);
  } else {
    console.log('\nDry-run complete. Add --execute to actually send the routing txs (not yet implemented).');
  }

  bscProvider.destroy();
}

main().catch(e => { console.error(e); process.exit(1); });
