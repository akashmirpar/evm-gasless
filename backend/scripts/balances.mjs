// Show operator + user wallet balances across every chain / token we test with.
// Reads keys from backend/.env (never echoes secrets — pubkeys/addresses only).
//
// Usage:  cd backend && node scripts/balances.mjs
// Output is a table per wallet showing native + relevant tokens per chain.

import { readFileSync } from 'fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, getAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { JsonRpcProvider, Wallet, Contract, formatUnits, formatEther } from 'ethers';
import bs58 from 'bs58';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

function fromMnemonic(mnemonic, index) {
  const seed = bip39.mnemonicToSeedSync(mnemonic, '');
  const { key } = derivePath(`m/44'/501'/${index}'/0'`, seed.toString('hex'));
  return Keypair.fromSeed(key);
}

// Wallets to inspect
const EVM_OPERATOR_PK = process.env.OPERATOR_PRIVATE_KEY;
const EVM_USER_PK = process.env.E2E_USER_PRIVATE_KEY;

const SOL_MNEMONIC = (process.env.TEST_SOLANA_SENDER_PRIVATE_KEY || '').trim();
const SOL_USER_INDEX = Number(process.env.TEST_SOLANA_ACCOUNT_INDEX || '0');
// Recipient in e2e = user_index + 1
const SOL_RECIPIENT_INDEX = SOL_USER_INDEX + 1;

// EVM chains + tokens
const EVM_CHAINS = {
  BSC: {
    chainId: 56,
    rpc: (process.env.BSC_RPC_URLS?.split(',')[0] || 'https://bsc-rpc.publicnode.com').trim(),
    tokens: {
      USDT: { addr: '0x55d398326f99059fF775485246999027B3197955', dec: 18 },
      USDC: { addr: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', dec: 18 },
    },
    nativeSymbol: 'BNB',
  },
  Base: {
    chainId: 8453,
    rpc: (process.env.BASE_RPC_URLS?.split(',')[0] || 'https://base-rpc.publicnode.com').trim(),
    tokens: {
      USDT: { addr: '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', dec: 6 },
      USDC: { addr: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', dec: 6 },
    },
    nativeSymbol: 'ETH',
  },
  Arbitrum: {
    chainId: 42161,
    rpc: (process.env.ARBITRUM_RPC_URLS?.split(',')[0] || 'https://arbitrum-one-rpc.publicnode.com').trim(),
    tokens: {
      USDT: { addr: '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', dec: 6 },
      USDC: { addr: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', dec: 6 },
      ARB:  { addr: '0x912CE59144191C1204E64559FE8253a0e49E6548', dec: 18 },
    },
    nativeSymbol: 'ETH',
  },
};

// Solana tokens
const SOL_MINTS = {
  USDC: { addr: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', prog: TOKEN_PROGRAM_ID, dec: 6 },
  USDT: { addr: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', prog: TOKEN_PROGRAM_ID, dec: 6 },
  BONK: { addr: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', prog: TOKEN_PROGRAM_ID, dec: 5 },
  xTSLA:{ addr: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB', prog: TOKEN_2022_PROGRAM_ID, dec: 8 },
  xAAPL:{ addr: 'XsbEhLAtcf6HdfpFZ5xEMdqW8nfAvcsP5bdudRLJzJp', prog: TOKEN_2022_PROGRAM_ID, dec: 8 },
  xNVDA:{ addr: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', prog: TOKEN_2022_PROGRAM_ID, dec: 8 },
};

const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

async function evmBalances(label, address) {
  console.log(`\n=== ${label}: ${address} (EVM) ===`);
  for (const [chain, cfg] of Object.entries(EVM_CHAINS)) {
    try {
      const provider = new JsonRpcProvider(cfg.rpc);
      const native = await provider.getBalance(address);
      const rows = [`${cfg.nativeSymbol.padEnd(6)} ${formatEther(native)}`];
      for (const [sym, t] of Object.entries(cfg.tokens)) {
        try {
          const c = new Contract(t.addr, ERC20_ABI, provider);
          const bal = await c.balanceOf(address);
          rows.push(`${sym.padEnd(6)} ${formatUnits(bal, t.dec)}`);
        } catch { /* skip */ }
      }
      provider.destroy();
      console.log(`  ${chain.padEnd(10)}: ${rows.join('  ')}`);
    } catch (e) {
      console.log(`  ${chain}: ERROR ${e.message}`);
    }
  }
}

async function solanaBalances(label, publicKey, conn) {
  console.log(`\n=== ${label}: ${publicKey.toBase58()} (Solana) ===`);
  const sol = await conn.getBalance(publicKey);
  const rows = [`SOL   ${(sol / 1e9).toFixed(6)}`];
  for (const [sym, m] of Object.entries(SOL_MINTS)) {
    try {
      const ata = getAssociatedTokenAddressSync(new PublicKey(m.addr), publicKey, true, m.prog);
      const acct = await getAccount(conn, ata, 'confirmed', m.prog);
      rows.push(`${sym.padEnd(5)} ${(Number(acct.amount) / (10 ** m.dec)).toFixed(6)}`);
    } catch { /* no ATA */ }
  }
  console.log(`  ${rows.join('  ')}`);
}

async function main() {
  console.log('gasless funds report — ' + new Date().toISOString());

  // EVM: operator + user
  if (EVM_OPERATOR_PK) {
    const provider = new JsonRpcProvider(EVM_CHAINS.BSC.rpc);
    const operator = new Wallet(EVM_OPERATOR_PK, provider);
    await evmBalances('OPERATOR (fee-payer)', operator.address);
  }
  if (EVM_USER_PK) {
    const provider = new JsonRpcProvider(EVM_CHAINS.BSC.rpc);
    const user = new Wallet(EVM_USER_PK, provider);
    await evmBalances('E2E USER', user.address);
  }

  // Solana
  if (SOL_MNEMONIC) {
    const solConn = new Connection(
      (process.env.SOLANA_RPC_URLS?.split(',')[0] || 'https://api.mainnet-beta.solana.com').trim(),
      'confirmed',
    );
    const user = fromMnemonic(SOL_MNEMONIC, SOL_USER_INDEX);
    const recipient = fromMnemonic(SOL_MNEMONIC, SOL_RECIPIENT_INDEX);
    await solanaBalances(`SOLANA USER (idx=${SOL_USER_INDEX}, also operator on dev)`, user.publicKey, solConn);
    await solanaBalances(`SOLANA RECIPIENT (idx=${SOL_RECIPIENT_INDEX})`, recipient.publicKey, solConn);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
