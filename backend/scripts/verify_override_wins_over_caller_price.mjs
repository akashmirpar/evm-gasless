// Regression test for PR #20 review finding: when integrator sets
// priorityMicroLamportsPerCu at DTO AND their instructions already contain
// a setComputeUnitPrice(low_value), our override should WIN on-wire — not
// silently no-op while the user is still billed for the higher amount.

import { readFileSync } from 'fs';
import axios from 'axios';
import {
  Connection, Keypair, PublicKey, VersionedTransaction,
  ComputeBudgetProgram, SystemProgram,
} from '@solana/web3.js';
import bs58 from 'bs58';
import nacl from 'tweetnacl';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';

for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const BACKEND = (process.env.E2E_BACKEND_URL ?? 'http://localhost:3578').replace(/\/$/, '');
const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const seed = bip39.mnemonicToSeedSync(process.env.TEST_SOLANA_SENDER_PRIVATE_KEY, '');
const { key } = derivePath(`m/44'/501'/${Number(process.env.TEST_SOLANA_ACCOUNT_INDEX)}'/0'`, seed.toString('hex'));
const user = Keypair.fromSeed(key);
console.log('user:', user.publicKey.toBase58());

// Build user instructions that include a low-value setComputeUnitPrice.
const LOW_PRICE = 100;
const OVERRIDE = 1_800_000;
const cbLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 });
const cbPrice = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: LOW_PRICE });
const noop = SystemProgram.transfer({ fromPubkey: user.publicKey, toPubkey: user.publicKey, lamports: 1 });

const toWire = (ix) => ({
  programId: ix.programId.toBase58(),
  keys: ix.keys.map(k => ({ pubkey: k.pubkey.toBase58(), isSigner: k.isSigner, isWritable: k.isWritable })),
  data: bs58.encode(ix.data),
});

const body = {
  chainId: -100,
  userAddress: user.publicKey.toBase58(),
  feeTokenAddress: USDC_MINT.toBase58(),
  instructions: [cbLimit, cbPrice, noop].map(toWire),
  priorityMicroLamportsPerCu: String(OVERRIDE),
};

console.log(`caller instructions include setComputeUnitPrice=${LOW_PRICE} μLam/CU`);
console.log(`DTO override priorityMicroLamportsPerCu=${OVERRIDE} μLam/CU`);
console.log(`expected: on-wire tx bids ${OVERRIDE} μLam/CU (override wins), caller's ${LOW_PRICE} is filtered out`);

const create = await axios.post(`${BACKEND}/gasless/solana/transactions`, body).catch(e => e.response);
if (!create?.data?.success) { console.error('CREATE FAILED:', JSON.stringify(create?.data ?? '').slice(0, 200)); process.exit(1); }
const { requestId, unsignedTransactionBase64 } = create.data.data;
console.log(`create OK requestId=${requestId}`);

const tx = VersionedTransaction.deserialize(Buffer.from(unsignedTransactionBase64, 'base64'));
const cbIxs = tx.message.compiledInstructions.filter((ci) => tx.message.staticAccountKeys[ci.programIdIndex]?.equals(ComputeBudgetProgram.programId));
const priceIxs = cbIxs.filter(ci => Buffer.from(ci.data)[0] === 0x03);
console.log(`built tx contains ${priceIxs.length} setComputeUnitPrice instruction(s) (expect exactly 1)`);
if (priceIxs.length !== 1) { console.error('FAIL: wrong number of price ixs'); process.exit(2); }
const chosen = Number(Buffer.from(priceIxs[0].data).readBigUInt64LE(1));
console.log(`on-wire setComputeUnitPrice=${chosen} μLam/CU`);
if (chosen === OVERRIDE) {
  console.log('PASS: override won, caller\'s low value was filtered out');
  process.exit(0);
} else {
  console.error(`FAIL: expected ${OVERRIDE}, got ${chosen}`);
  process.exit(3);
}
