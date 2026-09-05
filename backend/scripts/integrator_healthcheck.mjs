// Minimal end-to-end health check for the Solana gasless endpoint. Runs one
// USDC transfer through the full lifecycle (estimate → create → sign → submit
// → poll) and reports pass/fail with timing. Sharable with integrators to
// establish a working baseline they can compare their failing traffic against.
//
// Env expected (in an .env file next to this script, or exported):
//   E2E_BACKEND_URL         — where the backend lives (default http://localhost:3578)
//   SOLANA_RPC_URL          — the Solana RPC to sanity-check against
//   TEST_USER_MNEMONIC      — 12/24-word BIP-39 mnemonic for the signing user
//   TEST_USER_ACCOUNT_INDEX — derivation index for the Phantom-standard path
//
// Prints one line summary per stage plus a final PASS/FAIL. Non-zero exit on
// failure. Safe to run in a loop with a small sleep to build a reliability
// sample.

import { readFileSync } from 'fs';
import axios from 'axios';
import {
  Connection, Keypair, PublicKey, VersionedTransaction, TransactionInstruction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction, createTransferCheckedInstruction,
  getAssociatedTokenAddressSync, getAccount,
} from '@solana/spl-token';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';

try {
  for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
} catch { /* .env optional if env is exported */ }

const BACKEND = (process.env.E2E_BACKEND_URL ?? 'http://localhost:3578').replace(/\/$/, '');
const RPC = (process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com').trim();
const MNEMONIC = process.env.TEST_USER_MNEMONIC ?? process.env.TEST_SOLANA_SENDER_PRIVATE_KEY;
const INDEX = Number(process.env.TEST_USER_ACCOUNT_INDEX ?? process.env.TEST_SOLANA_ACCOUNT_INDEX ?? '0');

if (!MNEMONIC) {
  console.error('Missing TEST_USER_MNEMONIC (or TEST_SOLANA_SENDER_PRIVATE_KEY) in env.');
  process.exit(2);
}

const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

function deriveUser(idx) {
  const seed = bip39.mnemonicToSeedSync(MNEMONIC, '');
  const { key } = derivePath(`m/44'/501'/${idx}'/0'`, seed.toString('hex'));
  return Keypair.fromSeed(key);
}

const user = deriveUser(INDEX);
const recipient = deriveUser(INDEX + 1).publicKey;
const started = Date.now();
const stage = (name, ok, extra = '') => console.log(`[${((Date.now() - started) / 1000).toFixed(2)}s] ${ok ? 'OK' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);

const conn = new Connection(RPC, 'confirmed');

const mintInfo = await conn.getAccountInfo(USDC_MINT);
if (!mintInfo) { stage('mint accessible', false); process.exit(1); }
const programId = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
const userAta = getAssociatedTokenAddressSync(USDC_MINT, user.publicKey, false, programId);
const recipientAta = getAssociatedTokenAddressSync(USDC_MINT, recipient, false, programId);

let userBal = 0n;
try { userBal = (await getAccount(conn, userAta, 'confirmed', programId)).amount; } catch { }
if (userBal < 100n) {
  stage('user USDC balance', false, `have ${userBal} base units, need >= 100`);
  process.exit(1);
}
stage('user USDC balance', true, `${userBal} base units`);

const ixs = [];
const recipientInfo = await conn.getAccountInfo(recipientAta);
if (!recipientInfo) {
  ixs.push(createAssociatedTokenAccountInstruction(user.publicKey, recipientAta, recipient, USDC_MINT, programId));
}
ixs.push(createTransferCheckedInstruction(userAta, USDC_MINT, recipientAta, user.publicKey, 100n, 6, [], programId));
const wireIx = ixs.map(ix => ({
  programId: ix.programId.toBase58(),
  keys: ix.keys.map(k => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
  data: bs58.encode(ix.data),
}));

const body = {
  chainId: 'mainnet',
  userAddress: user.publicKey.toBase58(),
  feeTokenAddress: USDC_MINT.toBase58(),
  instructions: wireIx,
};
if (process.env.PRIORITY_MICRO_LAMPORTS_PER_CU) {
  body.priorityMicroLamportsPerCu = process.env.PRIORITY_MICRO_LAMPORTS_PER_CU;
  console.log(`(override: ${body.priorityMicroLamportsPerCu} μLamports/CU)`);
}

const est = await axios.post(`${BACKEND}/gasless/solana/transactions/estimate`, body).catch((e) => e.response);
if (!est?.data?.success) { stage('estimate', false, JSON.stringify(est?.data ?? '(no response)').slice(0, 200)); process.exit(1); }
stage('estimate', true, `fee=${est.data.data.feeAmount} accepted=${est.data.data.acceptedFeeToken}`);

const create = await axios.post(`${BACKEND}/gasless/solana/transactions`, body).catch((e) => e.response);
if (!create?.data?.success) { stage('create', false, JSON.stringify(create?.data ?? '').slice(0, 200)); process.exit(1); }
const { requestId, unsignedTransactionBase64, mode } = create.data.data;
stage('create', true, `requestId=${requestId} mode=${mode} txBytes=${Buffer.from(unsignedTransactionBase64, 'base64').length}`);

const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTransactionBase64, 'base64'));
const userSig = bs58.encode(nacl.sign.detached(tx.message.serialize(), user.secretKey));
const submit = await axios.post(`${BACKEND}/gasless/solana/transactions/${requestId}/submit`, { userSignature: userSig }).catch((e) => e.response);
if (!submit?.data?.success) { stage('submit', false, JSON.stringify(submit?.data ?? '').slice(0, 200)); process.exit(1); }
stage('submit', true, submit.data.data.status);

const pollStart = Date.now();
let final = null;
while (Date.now() - pollStart < 180_000) {
  const res = await axios.get(`${BACKEND}/gasless/solana/transactions/${requestId}`).catch((e) => e.response);
  if (res?.data?.success) {
    const d = res.data.data;
    if (['MINED_SUCCESS', 'MINED_FAILED', 'FAILED_PERMANENT'].includes(d.status)) { final = d; break; }
  }
  await new Promise(r => setTimeout(r, 2000));
}
if (!final) { stage('poll (timeout)', false); process.exit(1); }
stage(`final: ${final.status}`, final.status === 'MINED_SUCCESS', final.txHash ?? final.failureReason ?? '');
process.exit(final.status === 'MINED_SUCCESS' ? 0 : 1);
