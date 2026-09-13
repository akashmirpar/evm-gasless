// Retry the EVM top-up leg. Fixes the approve flow:
// Rango's `approveTo` is the TOKEN contract, `txTo` is the DEX router that
// pulls from us via transferFrom, so the allowance check must be against
// `txTo`, not `approveTo`.

import { readFileSync } from 'fs';
import axios from 'axios';
import { JsonRpcProvider, Wallet as EvmWallet, Contract, parseUnits, formatUnits } from 'ethers';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const RANGO_API_URL = (process.env.RANGO_API_URL ?? 'https://api.rango.exchange').replace(/\/$/, '');
const RANGO_API_KEY = process.env.RANGO_API_KEY?.trim();
const BSC_RPC = (process.env.BSC_RPC_URLS?.split(',')[0] || 'https://bsc-rpc.publicnode.com').trim();
const BSC_USDT = '0x55d398326f99059fF775485246999027B3197955';
const BSC_USDC = '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d';

const provider = new JsonRpcProvider(BSC_RPC);
const signer = new EvmWallet(process.env.E2E_USER_PRIVATE_KEY, provider);
console.log(`BSC signer: ${signer.address}`);

const amountHuman = '6.0';
const amountWei = parseUnits(amountHuman, 18);

const { data } = await axios.get(`${RANGO_API_URL}/basic/swap`, {
  params: {
    from: `BSC.USDT--${BSC_USDT.toLowerCase()}`,
    to: `BSC.USDC--${BSC_USDC.toLowerCase()}`,
    amount: amountWei.toString(),
    fromAddress: signer.address,
    toAddress: signer.address,
    slippage: 3.0,
    disableEstimate: true,
    apiKey: RANGO_API_KEY,
  },
  timeout: 30_000,
});
if (data.resultType !== 'OK' || !data.tx || data.tx.type !== 'EVM') {
  console.error('no route:', JSON.stringify(data, null, 2).slice(0, 500));
  process.exit(1);
}

console.log(`Route: ${data.route?.swapper?.title}, expected out ${formatUnits(BigInt(data.route.outputAmount), 18)} USDC`);
console.log(`approveTo (token):   ${data.tx.approveTo}`);
console.log(`txTo (dex router):   ${data.tx.txTo}`);

const usdt = new Contract(BSC_USDT, [
  'function allowance(address,address) view returns (uint256)',
], signer);
const cur = await usdt.allowance(signer.address, data.tx.txTo);
console.log(`Current USDT->DEX allowance: ${formatUnits(cur, 18)}`);

if (cur < amountWei && data.tx.approveData) {
  console.log(`Sending approve to token (${data.tx.approveTo})...`);
  const ap = await signer.sendTransaction({ to: data.tx.approveTo, data: data.tx.approveData });
  console.log(`  tx: ${ap.hash}`);
  const rcpt = await ap.wait();
  if (rcpt.status !== 1) throw new Error('approve reverted');
  console.log(`  approved`);
}

console.log(`Sending swap tx to ${data.tx.txTo}...`);
const swap = await signer.sendTransaction({
  to: data.tx.txTo,
  data: data.tx.txData,
  value: BigInt(data.tx.value ?? '0'),
  gasLimit: BigInt(data.tx.gasLimit ?? '500000'),
});
console.log(`  tx: ${swap.hash}`);
const swapRcpt = await swap.wait();
if (swapRcpt.status !== 1) throw new Error('swap reverted');
console.log(`Confirmed swap. Block ${swapRcpt.blockNumber}`);

provider.destroy();
