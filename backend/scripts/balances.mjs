// Show operator + user wallet balances across every EVM chain / token we test with.
// Reads keys from backend/.env (never echoes secrets — addresses only).
//
// Usage:  cd backend && node scripts/balances.mjs

import { readFileSync } from 'fs';
import { JsonRpcProvider, Wallet, Contract, formatUnits, formatEther } from 'ethers';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const EVM_OPERATOR_PK = process.env.OPERATOR_PRIVATE_KEY;
const EVM_USER_PK = process.env.E2E_USER_PRIVATE_KEY;

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

const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

async function evmBalances(label, address) {
  console.log(`\n=== ${label}: ${address} ===`);
  for (const [name, chain] of Object.entries(EVM_CHAINS)) {
    try {
      const provider = new JsonRpcProvider(chain.rpc);
      const native = formatEther(await provider.getBalance(address));
      let line = `  ${name.padEnd(9)}: ${chain.nativeSymbol.padEnd(4)} ${native}`;
      for (const [sym, t] of Object.entries(chain.tokens)) {
        const bal = await new Contract(t.addr, ERC20_ABI, provider).balanceOf(address);
        line += `  ${sym.padEnd(4)} ${formatUnits(bal, t.dec)}`;
      }
      console.log(line);
    } catch (err) {
      console.log(`  ${name.padEnd(9)}: ERR ${String(err.message).slice(0, 60)}`);
    }
  }
}

console.log(`gasless funds report — ${new Date().toISOString()}`);
if (EVM_OPERATOR_PK) await evmBalances('OPERATOR (fee-payer)', new Wallet(EVM_OPERATOR_PK).address);
else console.log('\nOPERATOR_PRIVATE_KEY unset — skipping operator');
if (EVM_USER_PK) await evmBalances('E2E USER', new Wallet(EVM_USER_PK).address);
else console.log('\nE2E_USER_PRIVATE_KEY unset — skipping user');
