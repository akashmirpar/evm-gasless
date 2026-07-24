// RIN-135 live gasless verification against the booted branch.
// USDC transfer + USDC fee, SOL-less-proof by balance delta (operator pays).
// MODE env selects single|bundled. Auth via x-api-key.

import { readFileSync } from 'fs';
import axios from 'axios';
import { Connection, Keypair, PublicKey, VersionedTransaction, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import { requireEnv } from './_env.mjs';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const BACKEND = (process.env.E2E_BACKEND_URL ?? 'http://localhost:3578').replace(/\/$/, '');
const RPC = 'https://api.mainnet-beta.solana.com';
const MODE = process.env.MODE ?? 'single';
const USER_INDEX = Number(process.env.USER_INDEX ?? '0');
const API_KEY = readFileSync('/tmp/e2e_api_key.txt', 'utf8').trim();
const H = { headers: { 'x-api-key': API_KEY } };
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const BONK_MINT = new PublicKey('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
// Fee token: USDC (accepted, direct) or BONK (non-accepted → swap-fee path, exercises RIN-118 sim).
const FEE_MINT = process.env.FEE_TOKEN === 'BONK' ? BONK_MINT : USDC_MINT;

function fromMnemonic(mnemonic, index) {
  const seed = bip39.mnemonicToSeedSync(mnemonic, '');
  const { key } = derivePath(`m/44'/501'/${index}'/0'`, seed.toString('hex'));
  return Keypair.fromSeed(key);
}
const MN = requireEnv('TEST_MNEMONIC', 'TEST_SOLANA_SENDER_PRIVATE_KEY');
const user = fromMnemonic(MN, USER_INDEX);
const recipient = fromMnemonic(MN, USER_INDEX + 1).publicKey;
const operator = fromMnemonic(requireEnv('OPERATOR_MNEMONIC'), Number(process.env.OPERATOR_MNEMONIC_INDEX ?? '0')).publicKey;

console.log(`MODE=${MODE} user(idx${USER_INDEX})=${user.publicKey.toBase58()} recipient=${recipient.toBase58()}`);
console.log(`operator=${operator.toBase58()}`);

const conn = new Connection(RPC, 'confirmed');
const userSolBefore = await conn.getBalance(user.publicKey);
const opSolBefore = await conn.getBalance(operator);

const mintInfo = await conn.getAccountInfo(USDC_MINT);
const programId = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
const userAta = getAssociatedTokenAddressSync(USDC_MINT, user.publicKey, false, programId);
const recipientAta = getAssociatedTokenAddressSync(USDC_MINT, recipient, false, programId);

const ixs = [];
if (!(await conn.getAccountInfo(recipientAta))) {
  ixs.push(createAssociatedTokenAccountInstruction(user.publicKey, recipientAta, recipient, USDC_MINT, programId));
}
ixs.push(createTransferCheckedInstruction(userAta, USDC_MINT, recipientAta, user.publicKey, 100n, 6, [], programId));
const wireIx = ixs.map(ix => ({
  programId: ix.programId.toBase58(),
  keys: ix.keys.map(k => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
  data: bs58.encode(ix.data),
}));

const prio = process.env.PRIORITY ? { priorityMicroLamportsPerCu: process.env.PRIORITY } : {};
const est = await axios.post(`${BACKEND}/gasless/solana/transactions/estimate`, {
  chainId: -100, userAddress: user.publicKey.toBase58(), feeTokenAddress: FEE_MINT.toBase58(), instructions: wireIx, mode: MODE, ...prio,
}, H).catch(e => { console.error('ESTIMATE FAILED:', e.response?.status, JSON.stringify(e.response?.data ?? e.message)); process.exit(1); });
console.log(`estimate OK: feeAmount=${est.data.data.feeAmount} mode=${est.data.data.mode}`);

const create = await axios.post(`${BACKEND}/gasless/solana/transactions`, {
  chainId: -100, userAddress: user.publicKey.toBase58(), feeTokenAddress: FEE_MINT.toBase58(), instructions: wireIx, mode: MODE, ...prio,
}, H).catch(e => { console.error('CREATE FAILED:', e.response?.status, JSON.stringify(e.response?.data ?? e.message)); process.exit(1); });
const c = create.data.data;
console.log(`create OK requestId=${c.requestId} mode=${c.mode} prefundSig=${c.prefundTxSignature ?? '(none)'}`);

const tx = VersionedTransaction.deserialize(Buffer.from(c.unsignedTransactionBase64, 'base64'));
const userSig = bs58.encode(nacl.sign.detached(tx.message.serialize(), user.secretKey));
await axios.post(`${BACKEND}/gasless/solana/transactions/${c.requestId}/submit`, { userSignature: userSig }, H)
  .catch(e => { console.error('SUBMIT FAILED:', e.response?.status, JSON.stringify(e.response?.data ?? e.message)); process.exit(1); });
console.log('submit OK, polling...');

const start = Date.now();
let final = null;
while (Date.now() - start < 180_000) {
  const res = await axios.get(`${BACKEND}/gasless/solana/transactions/${c.requestId}`, H).catch(e => ({ status: e.response?.status, data: e.response?.data }));
  const d = res.data?.data;
  if (d && ['MINED_SUCCESS', 'MINED_FAILED', 'FAILED_PERMANENT'].includes(d.status)) { final = d; break; }
  await new Promise(r => setTimeout(r, 3000));
}
const userSolAfter = await conn.getBalance(user.publicKey);
const opSolAfter = await conn.getBalance(operator);
console.log('\n=== FINAL ===');
console.log(`status=${final?.status} txSignature=${final?.txSignature ?? final?.signature ?? '(n/a)'}`);
console.log(`user  SOL: ${userSolBefore/LAMPORTS_PER_SOL} -> ${userSolAfter/LAMPORTS_PER_SOL} (delta ${(userSolAfter-userSolBefore)/LAMPORTS_PER_SOL})`);
console.log(`oper  SOL: ${opSolBefore/LAMPORTS_PER_SOL} -> ${opSolAfter/LAMPORTS_PER_SOL} (delta ${(opSolAfter-opSolBefore)/LAMPORTS_PER_SOL})`);
console.log(`GASLESS PROOF: operator paid=${opSolAfter<opSolBefore} user-not-charged-net=${userSolAfter>=userSolBefore}`);
process.exit(final?.status === 'MINED_SUCCESS' ? 0 : 1);
