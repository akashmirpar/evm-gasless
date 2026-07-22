// One-shot funding to make the full e2e matrix runnable:
//  1. Solana: swap USDC → BONK (~$3 worth, unlocks S2)
//  2. Solana: swap USDC → xTSLA (~$8 worth, unlocks S3 safe band + probes overshoot)
//  3. BSC:    swap USDT → USDC (~$5 worth, unlocks EVM unsupported-path)
//
// Uses Rango /basic/swap for all three. Solana swaps route through Jupiter under
// the hood; BSC swap goes through PancakeSwap or similar DEX. User's Solana
// wallet signs its own txs (pays own SOL fees — NOT a gasless flow, this is a
// wallet-owner setup step); BSC swap is signed by E2E_USER_PRIVATE_KEY.

import { readFileSync } from 'fs';
import axios from 'axios';
import {
  Connection, Keypair, Message, MessageV0, PublicKey, Transaction,
  VersionedTransaction, AddressLookupTableAccount, TransactionMessage,
} from '@solana/web3.js';
import { JsonRpcProvider, Wallet as EvmWallet, HDNodeWallet, Contract, parseUnits, formatUnits, MaxUint256 } from 'ethers';

const evmUserPk = () =>
  process.env.E2E_USER_PRIVATE_KEY?.trim() ||
  HDNodeWallet.fromPhrase(process.env.TEST_MNEMONIC, undefined, `m/44'/60'/0'/0/${Number(process.env.TEST_EVM_USER_INDEX ?? '0')}`).privateKey;
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const RANGO_API_URL = (process.env.RANGO_API_URL ?? 'https://api.rango.exchange').replace(/\/$/, '');
const RANGO_API_KEY = process.env.RANGO_API_KEY?.trim();
const SOL_RPC = (process.env.SOLANA_RPC_URLS?.split(',')[0] || 'https://api.mainnet-beta.solana.com').trim();
const BSC_RPC = (process.env.BSC_RPC_URLS?.split(',')[0] || 'https://bsc-rpc.publicnode.com').trim();

function solanaUser() {
  const idx = process.env.TEST_SOLANA_ACCOUNT_INDEX;
  if (!idx) throw new Error('TEST_SOLANA_ACCOUNT_INDEX not set');
  const seed = bip39.mnemonicToSeedSync((process.env.TEST_MNEMONIC || process.env.TEST_SOLANA_SENDER_PRIVATE_KEY), '');
  const { key } = derivePath(`m/44'/501'/${Number(idx)}'/0'`, seed.toString('hex'));
  return Keypair.fromSeed(key);
}

function parseSwapMessage(bytes) {
  const errs = [];
  try {
    const vt = VersionedTransaction.deserialize(bytes);
    if (vt.version === 0) return { msg: vt.message, isVersioned: true };
    errs.push(`vt v=${vt.version}`);
  } catch (e) { errs.push(`vt: ${e.message}`); }
  try {
    const tx = Transaction.from(Buffer.from(bytes));
    const msg = tx.compileMessage();
    if (msg.instructions.length > 0) return { msg, isVersioned: false };
  } catch (e) { errs.push(`tx: ${e.message}`); }
  try {
    const msg = Message.from(Buffer.from(bytes));
    if (msg.instructions.length > 0) return { msg, isVersioned: false };
  } catch (e) { errs.push(`msg: ${e.message}`); }
  throw new Error(`could not parse: ${errs.join('; ')}`);
}

async function solanaLocalSwap({ user, conn, fromRango, toRango, amountBaseUnits, label }) {
  console.log(`\n[Solana swap] ${label}`);
  console.log(`  ${amountBaseUnits} base units of ${fromRango} → ${toRango}`);
  const { data } = await axios.get(`${RANGO_API_URL}/basic/swap`, {
    params: {
      from: fromRango, to: toRango, amount: amountBaseUnits,
      fromAddress: user.publicKey.toBase58(),
      toAddress: user.publicKey.toBase58(),
      slippage: 3.0, disableEstimate: true, apiKey: RANGO_API_KEY,
    },
    timeout: 30_000,
  });
  if (data.resultType !== 'OK' || !data.tx || data.tx.type !== 'SOLANA') {
    throw new Error(`Rango returned no route: ${data.error ?? JSON.stringify(data).slice(0, 200)}`);
  }
  console.log(`  Rango route: ${data.route?.swapper?.title ?? '?'}, expected out ${data.route?.outputAmount ?? '?'}`);

  const serialized = Uint8Array.from(data.tx.serializedMessage);
  const { msg, isVersioned } = parseSwapMessage(serialized);

  let signedTx;
  if (isVersioned) {
    const vtx = new VersionedTransaction(msg);
    vtx.sign([user]);
    signedTx = vtx;
  } else {
    const tx = Transaction.populate(msg);
    tx.partialSign(user);
    signedTx = tx;
  }

  const raw = signedTx.serialize();
  const sig = await conn.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 3 });
  console.log(`  Sent: ${sig}`);
  const conf = await conn.confirmTransaction({
    signature: sig,
    blockhash: isVersioned ? msg.recentBlockhash : msg.recentBlockhash,
    lastValidBlockHeight: (await conn.getLatestBlockhash()).lastValidBlockHeight,
  }, 'confirmed');
  if (conf.value.err) throw new Error(`swap failed: ${JSON.stringify(conf.value.err)}`);
  console.log(`  Confirmed ${label}`);
}

async function evmSwap({ signer, provider, fromToken, fromDec, fromRango, toRango, amountHuman, label }) {
  console.log(`\n[EVM swap] ${label}`);
  console.log(`  ${amountHuman} of ${fromToken} → ${toRango}`);
  const amountWei = parseUnits(amountHuman, fromDec);
  const { data } = await axios.get(`${RANGO_API_URL}/basic/swap`, {
    params: {
      from: fromRango, to: toRango, amount: amountWei.toString(),
      fromAddress: signer.address, toAddress: signer.address,
      slippage: 1.0, disableEstimate: true, apiKey: RANGO_API_KEY,
    },
    timeout: 30_000,
  });
  if (data.resultType !== 'OK' || !data.tx || data.tx.type !== 'EVM') {
    throw new Error(`Rango returned no route: ${data.error ?? JSON.stringify(data).slice(0, 200)}`);
  }
  console.log(`  Rango route: ${data.route?.swapper?.title ?? '?'}, expected out ${data.route?.outputAmount ?? '?'}`);

  if (data.tx.approveTo && data.tx.approveData) {
    const erc = new Contract(fromToken, [
      'function allowance(address,address) view returns (uint256)',
      'function approve(address,uint256) returns (bool)',
    ], signer);
    const cur = await erc.allowance(signer.address, data.tx.approveTo);
    if (cur < amountWei) {
      console.log(`  Approving ${data.tx.approveTo}...`);
      const ap = await signer.sendTransaction({ to: data.tx.approveTo, data: data.tx.approveData });
      await ap.wait();
      console.log(`  Approved: ${ap.hash}`);
    } else {
      console.log(`  Approval sufficient (allowance ${cur})`);
    }
  }

  console.log(`  Sending swap tx to ${data.tx.txTo}...`);
  const tx = await signer.sendTransaction({
    to: data.tx.txTo,
    data: data.tx.txData,
    value: BigInt(data.tx.value ?? '0'),
    gasLimit: 500_000,
  });
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error(`swap failed: ${tx.hash}`);
  console.log(`  Confirmed ${label}: ${tx.hash}`);
}

async function main() {
  const conn = new Connection(SOL_RPC, 'confirmed');
  const solUser = solanaUser();
  const bscProvider = new JsonRpcProvider(BSC_RPC);
  const bscUser = new EvmWallet(evmUserPk(), bscProvider);

  console.log(`Solana user: ${solUser.publicKey.toBase58()}`);
  console.log(`BSC user:    ${bscUser.address}`);

  const USDC_SOL_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const BONK_MINT = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
  const XTSLA_MINT = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB';
  const BSC_USDT = '0x55d398326f99059fF775485246999027B3197955';

  // Step 1: Solana USDC → BONK ($2 → ~150k BONK)
  await solanaLocalSwap({
    user: solUser, conn,
    fromRango: `SOLANA.USDC--${USDC_SOL_MINT}`,
    toRango: `SOLANA.BONK--${BONK_MINT}`,
    amountBaseUnits: '2000000',
    label: '2 USDC → BONK',
  });

  // Step 2: Solana USDC → xTSLA ($4 → ~0.01 xTSLA safe band + a bit more)
  await solanaLocalSwap({
    user: solUser, conn,
    fromRango: `SOLANA.USDC--${USDC_SOL_MINT}`,
    toRango: `SOLANA.xTSLA--${XTSLA_MINT}`,
    amountBaseUnits: '4000000',
    label: '4 USDC → xTSLA',
  });

  // Step 3: BSC USDT → USDC (6 USDT → ~6 USDC, unlocks EVM unsupported-path)
  await evmSwap({
    signer: bscUser, provider: bscProvider,
    fromToken: BSC_USDT, fromDec: 18,
    fromRango: `BSC.USDT--${BSC_USDT.toLowerCase()}`,
    toRango: `BSC.USDC--0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d`,
    amountHuman: '6.0',
    label: '6 USDT → USDC',
  });

  bscProvider.destroy();
  console.log('\n=== Topup complete ===');
}

main().catch(e => { console.error('\nERROR:', e.message); if (e.response?.data) console.error(JSON.stringify(e.response.data, null, 2).slice(0, 800)); process.exit(1); });
