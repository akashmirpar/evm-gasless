import { readFileSync } from 'fs';
import { JsonRpcProvider, Wallet, Contract, parseUnits, formatEther, formatUnits, MaxUint256 } from 'ethers';

const CONTRACT_ENV = new URL('../.env', import.meta.url);
for (const line of readFileSync(CONTRACT_ENV, 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const OPERATOR_PK = process.env.OPERATOR_PRIVATE_KEY;
if (!OPERATOR_PK) throw new Error('OPERATOR_PRIVATE_KEY missing');

const BSC_RPC = (process.env.BSC_RPC_URLS ?? '').split(',')[0]?.trim() || 'https://bsc-rpc.publicnode.com';
const ARB_RPC = (process.env.ARBITRUM_RPC_URLS ?? '').split(',')[0]?.trim() || 'https://arbitrum-one-rpc.publicnode.com';
const RANGO_KEY = (process.env.RANGO_API_KEY ?? '').trim();

const BSC_USDT = '0x55d398326f99059fF775485246999027B3197955';
const AMOUNT_USDT = process.env.BRIDGE_AMOUNT_USDT || '5.0';
const SLIPPAGE_PCT = Number(process.env.BRIDGE_SLIPPAGE_PCT ?? '1.0');

const argv = process.argv.slice(2);
const go = argv.includes('--go') || process.env.CONFIRM === 'go';

async function rangoSwap(fromAddress, amountWei) {
  const params = new URLSearchParams({
    from: `BSC.USDT--${BSC_USDT.toLowerCase()}`,
    to: 'ARBITRUM.ETH',
    amount: amountWei.toString(),
    fromAddress,
    toAddress: fromAddress,
    slippage: String(SLIPPAGE_PCT),
    disableEstimate: 'true',
    apiKey: RANGO_KEY,
  });
  const res = await fetch(`https://api.rango.exchange/basic/swap?${params}`);
  const json = await res.json();
  if (json.resultType !== 'OK' || !json.tx) {
    throw new Error(`Rango: ${json.error || json.resultType}`);
  }
  return json;
}

async function main() {
  const bscProvider = new JsonRpcProvider(BSC_RPC);
  const arbProvider = new JsonRpcProvider(ARB_RPC);
  const operator = new Wallet(OPERATOR_PK, bscProvider);

  const amountWei = parseUnits(AMOUNT_USDT, 18);
  console.log('=== BSC USDT -> Arbitrum ETH bridge ===');
  console.log(`Operator:    ${operator.address}`);
  console.log(`Amount:      ${AMOUNT_USDT} USDT (${amountWei} wei, 18-dec BSC USDT)`);
  console.log(`Slippage:    ${SLIPPAGE_PCT}%`);
  console.log('');

  const usdt = new Contract(BSC_USDT, [
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)',
  ], operator);
  const [usdtBal, bnbBal, arbEthBefore] = await Promise.all([
    usdt.balanceOf(operator.address),
    bscProvider.getBalance(operator.address),
    arbProvider.getBalance(operator.address),
  ]);
  console.log(`BSC USDT bal:  ${formatUnits(usdtBal, 18)}`);
  console.log(`BSC BNB bal:   ${formatEther(bnbBal)}`);
  console.log(`Arb ETH bal:   ${formatEther(arbEthBefore)}  (before)`);
  console.log('');

  if (usdtBal < amountWei) throw new Error(`insufficient USDT (need ${AMOUNT_USDT}, have ${formatUnits(usdtBal, 18)})`);

  const swap = await rangoSwap(operator.address, amountWei);
  const outWei = BigInt(swap.route.outputAmount);
  const outMinWei = BigInt(swap.route.outputAmountMin);
  console.log(`Rango route: ${swap.route.swapper.title}  requestId=${swap.requestId}`);
  console.log(`Expected out: ${formatEther(outWei)} ETH (min ${formatEther(outMinWei)})`);
  console.log(`Approve to:  ${swap.tx.approveTo}`);
  console.log(`Bridge to:   ${swap.tx.txTo}`);
  console.log(`Bridge value:${swap.tx.value ?? '0'} wei`);
  console.log('');

  if (!go) {
    console.log('Dry-run mode. Re-run with --go (or CONFIRM=go) to actually send.');
    return;
  }

  const currentAllowance = await usdt.allowance(operator.address, swap.tx.txTo);
  if (currentAllowance < amountWei) {
    console.log(`Sending approve(${swap.tx.txTo}, ${AMOUNT_USDT}) ...`);
    const approveTx = await usdt.approve(swap.tx.txTo, amountWei);
    console.log(`  approve tx: https://bscscan.com/tx/${approveTx.hash}`);
    const r = await approveTx.wait();
    console.log(`  confirmed in block ${r.blockNumber}`);
  } else {
    console.log(`allowance already sufficient (${formatUnits(currentAllowance, 18)} >= ${AMOUNT_USDT})`);
  }
  console.log('');

  console.log(`Sending bridge tx to ${swap.tx.txTo} ...`);
  const bridgeTx = await operator.sendTransaction({
    to: swap.tx.txTo,
    data: swap.tx.txData,
    value: swap.tx.value ? BigInt(swap.tx.value) : 0n,
  });
  console.log(`  bridge tx: https://bscscan.com/tx/${bridgeTx.hash}`);
  const bridgeReceipt = await bridgeTx.wait();
  console.log(`  confirmed in block ${bridgeReceipt.blockNumber} status=${bridgeReceipt.status}`);
  console.log('');

  console.log('Waiting for cross-chain settlement on Arbitrum...');
  const deadline = Number(process.env.POLL_DEADLINE_MS ?? 15 * 60_000);
  const started = Date.now();
  let lastLog = 0;
  while (Date.now() - started < deadline) {
    const bal = await arbProvider.getBalance(operator.address);
    if (bal > arbEthBefore) {
      const delta = bal - arbEthBefore;
      console.log(`  Arb ETH: +${formatEther(delta)} (total ${formatEther(bal)}) after ${Math.round((Date.now()-started)/1000)}s`);
      return;
    }
    if (Date.now() - lastLog > 15_000) {
      console.log(`  ... still waiting (${Math.round((Date.now()-started)/1000)}s), current bal ${formatEther(bal)}`);
      lastLog = Date.now();
    }
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('timed out waiting for Arb ETH — check Rango tracker for requestId');
}

main().catch((err) => {
  console.error('FAILED:', err.message || err);
  process.exit(1);
});
