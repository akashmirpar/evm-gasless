// Send native and/or an ERC-20 from a key held in an env file to an address.
// Dry-run by default: prints the plan and exits. Pass --go to broadcast.
//
//   node scripts/transfer.mjs --env ../.env --key OPERATOR_PRIVATE_KEY \
//     --rpc https://arb1.arbitrum.io/rpc --chain 42161 --to 0xRecipient \
//     [--eth 0.0025] [--token 0xToken --amount 1.0] [--go]
//
// Never prints the key.
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { JsonRpcProvider, Wallet, Contract, parseEther, parseUnits, formatEther, formatUnits } from 'ethers';

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i === -1 ? def : argv[i + 1]; };
const GO = argv.includes('--go');
const ENV = opt('env'), KEY = opt('key'), RPC = opt('rpc'), CHAIN = Number(opt('chain')), TO = (opt('to') || '').trim();
const ETH = opt('eth'), TOKEN = (opt('token') || '').trim(), AMOUNT = opt('amount');

if (!ENV || !KEY || !RPC || !CHAIN || !/^0x[0-9a-fA-F]{40}$/.test(TO)) {
  console.error('usage: --env <file> --key <ENV_KEY> --rpc <url> --chain <id> --to <0x> [--eth <n>] [--token <0x> --amount <n>] [--go]');
  process.exit(1);
}
if (!ETH && !(TOKEN && AMOUNT)) { console.error('nothing to send: pass --eth and/or --token+--amount'); process.exit(1); }

let pk = '';
for (const line of readFileSync(resolve(ENV), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && m[1] === KEY) pk = m[2].trim();
}
if (!pk) { console.error(`${KEY} not set in ${ENV}`); process.exit(1); }

const provider = new JsonRpcProvider(RPC, CHAIN, { staticNetwork: true });
let wallet;
try { wallet = new Wallet(pk, provider); } catch { console.error('key failed to load (not printed)'); process.exit(1); }
pk = '';

const from = await wallet.getAddress();
const ERC20 = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function transfer(address,uint256) returns (bool)'];
const token = TOKEN ? new Contract(TOKEN, ERC20, wallet) : null;
const decimals = token ? Number(await token.decimals()) : 0;

const ethBal = await provider.getBalance(from);
const tokBal = token ? await token.balanceOf(from) : 0n;
console.log(`chain ${CHAIN} via ${RPC}`);
console.log(`from  ${from}`);
console.log(`to    ${TO}`);
console.log(`from balance: ${formatEther(ethBal)} ETH${token ? `, ${formatUnits(tokBal, decimals)} token` : ''}`);
if (ETH) console.log(`plan: send ${ETH} ETH`);
if (token) console.log(`plan: send ${AMOUNT} of ${TOKEN}`);

if (ETH && parseEther(ETH) >= ethBal) { console.error('insufficient ETH for amount + gas'); process.exit(1); }
if (token && parseUnits(AMOUNT, decimals) > tokBal) { console.error('insufficient token balance'); process.exit(1); }
if (!GO) { console.log('\nDRY RUN — re-run with --go to broadcast.'); process.exit(0); }

if (ETH) {
  const tx = await wallet.sendTransaction({ to: TO, value: parseEther(ETH) });
  console.log(`\nETH tx   ${tx.hash}`);
  const r = await tx.wait();
  console.log(`status   ${r.status === 1 ? 'SUCCESS' : 'FAILED'} block ${r.blockNumber}`);
}
if (token) {
  const tx = await token.transfer(TO, parseUnits(AMOUNT, decimals));
  console.log(`\ntoken tx ${tx.hash}`);
  const r = await tx.wait();
  console.log(`status   ${r.status === 1 ? 'SUCCESS' : 'FAILED'} block ${r.blockNumber}`);
}
provider.destroy();
