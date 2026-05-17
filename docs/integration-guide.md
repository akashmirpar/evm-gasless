# Integration guide

End-to-end code samples for integrating the gasless relayer into a client app. Examples use **ethers v6** because that's what the backend's relayer also uses; the same flow works with viem or anything else that can sign EIP-712 + EIP-7702.

## Prerequisites

- The backend is running and reachable at `BASE_URL`.
- `GaslessDelegate` is deployed on the target chain and recorded in [`gasless/chains/deployed.json`](../chains/deployed.json).
- You have the end-user's wallet (in a real product, this is the user's MetaMask / WalletConnect / smart-account session — you don't see the private key, you call `signTypedData` / `authorize` through their wallet provider).
- The user's EOA holds enough of the fee token (and any tokens needed by their intent ops).

## TL;DR — the five-step flow

```ts
import { JsonRpcProvider, Signature, Wallet } from 'ethers';

async function relayBatch(opts: {
  backendUrl: string;
  rpcUrl: string;
  chainId: number;
  userSigner: Wallet;          // anything with .signTypedData + .authorize
  feeTokenAddress: string;
  userOps: Array<{ to: string; value: string; data: string }>;
}) {
  const { backendUrl, rpcUrl, chainId, userSigner, feeTokenAddress, userOps } = opts;
  const userAddress = await userSigner.getAddress();

  // 1) Get a fee quote (optional — for UX, to show the user how much they'll pay)
  const estimate = await postJson(`${backendUrl}/gasless/transactions/estimate`, {
    chainId,
    userAddress,
    feeTokenAddress,
    operations: userOps.map((o) => ({ chainId, ...o })),
  });

  // 2) Build the signable batch
  const created = await postJson(`${backendUrl}/gasless/transactions`, {
    chainId,
    userAddress,
    feeTokenAddress,
    operations: userOps.map((o) => ({ chainId, ...o })),
  });
  const { requestId, delegateContractAddress, operations, atomicGroupStart, nonce } = created;

  // 3a) Sign the EIP-712 batch
  const domain = {
    name: 'GaslessDelegate',
    version: '1',
    chainId,
    verifyingContract: userAddress,
  };
  const types = {
    Operation: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
    Batch: [
      { name: 'operations', type: 'Operation[]' },
      { name: 'atomicGroupStart', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
    ],
  };
  const value = { operations, atomicGroupStart, nonce };
  const signature = await userSigner.signTypedData(domain, types, value);

  // 3b) Sign the EIP-7702 authorization
  const provider = new JsonRpcProvider(rpcUrl);
  const userOnProvider = userSigner.connect(provider);
  const authNonce = await provider.getTransactionCount(userAddress);
  const signedAuth = await userOnProvider.authorize({
    address: delegateContractAddress,
    nonce: authNonce,
    chainId,
  });
  const authorization = {
    chainId,
    address: delegateContractAddress,
    nonce: String(authNonce),
    signature: Signature.from(signedAuth.signature).serialized,
  };

  // 4) Submit
  await postJson(`${backendUrl}/gasless/transactions/${requestId}/submit`, {
    signature,
    authorization,
  });

  // 5) Poll for terminal status
  while (true) {
    const status = await getJson(`${backendUrl}/gasless/transactions/${requestId}`);
    if (['MINED_SUCCESS', 'MINED_FAILED', 'FAILED_PERMANENT'].includes(status.status)) {
      return status;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

async function postJson(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.success) throw Object.assign(new Error(json.error.message), { code: json.error.code });
  return json.data;
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url);
  const json = await res.json();
  if (!json.success) throw Object.assign(new Error(json.error.message), { code: json.error.code });
  return json.data;
}
```

The rest of this guide unpacks each step.

## 1. Estimate (optional but recommended for UX)

The estimate endpoint is read-only and free to call. Use it before the user commits to anything — show them what the fee will be and warn if a swap is required.

```ts
const quote = await postJson(`${backendUrl}/gasless/transactions/estimate`, {
  chainId: 56,
  userAddress: '0xUser…',
  feeTokenAddress: '0x55d398326f99059fF775485246999027B3197955',  // BSC USDT
  operations: [{ chainId: 56, to: '0x…', value: '0', data: '0x…' }],
});

if (quote.acceptedFeeToken) {
  showFee(`${formatUnits(quote.feeAmount, 18)} USDT`);
} else {
  showFee(`${formatUnits(quote.feeAmount, decimalsOf(quote.feeTokenAddress))} ${symbolOf(quote.feeTokenAddress)} (routed via swap to ${symbolOf(quote.swapRoute.outputToken)})`);
}
```

## 2. Create the batch

```ts
const created = await postJson(`${backendUrl}/gasless/transactions`, payload);
```

The `created` payload contains everything you need to sign:

```ts
{
  requestId,                       // opaque id used in /submit and GET /:id
  delegateContractAddress,         // EIP-7702 authorization target
  chainId,                         // commit to this in both signatures
  nonce,                           // the on-chain GaslessDelegate.nonce()
  atomicGroupStart,                // signed boundary
  operations,                      // exact list to sign (already canonicalized)
  digest,                          // convenience — compute locally and compare
  expiresAtSeconds,                // Redis TTL
}
```

**Critical:** the `operations` array order, every byte of every `data`, every `value`, every `to`, and `atomicGroupStart` all participate in the EIP-712 digest. Don't filter, reorder, or transform them before signing.

You can sanity-check that you're signing what you think you're signing by hashing locally and comparing to `created.digest`:

```ts
import { TypedDataEncoder } from 'ethers';
const localDigest = TypedDataEncoder.hash(domain, types, { operations, atomicGroupStart, nonce });
if (localDigest !== created.digest) throw new Error('digest mismatch — refusing to sign');
```

## 3a. EIP-712 batch signature

```ts
const signature = await userSigner.signTypedData(domain, types, value);
```

Important: **`domain.verifyingContract` is the user's own EOA address**, not the delegate contract. This is because the EOA is what runs `GaslessDelegate` (via EIP-7702 delegation), and `address(this)` inside the contract resolves to the EOA. Setting `verifyingContract = userAddress` is what binds the signature to that specific EOA.

In a browser wallet flow you'd use the standard `eth_signTypedData_v4` RPC method instead — the typed data structure is identical:

```ts
const typedData = JSON.stringify({
  domain,
  primaryType: 'Batch',
  types: { EIP712Domain: [...], ...types },
  message: value,
});
const signature = await wallet.request({
  method: 'eth_signTypedData_v4',
  params: [userAddress, typedData],
});
```

## 3b. EIP-7702 authorization

This is the one piece most clients won't have done before. EIP-7702 lets an EOA temporarily install a contract's code at its own address. The user signs an authorization tuple `(chainId, address, nonce)` with their EOA key; when the type-4 transaction lands on chain, the EVM checks that signature and installs the delegation atomically.

In ethers v6:

```ts
const userOnProvider = userSigner.connect(provider);
const signedAuth = await userOnProvider.authorize({
  address: delegateContractAddress,    // from POST /transactions response
  nonce: await provider.getTransactionCount(userAddress),  // EOA's tx count
  chainId,
});
```

`signedAuth.signature` is an ethers `Signature` object. Serialize it to bytes for transport:

```ts
const authorization = {
  chainId,
  address: delegateContractAddress,
  nonce: String(authNonce),
  signature: Signature.from(signedAuth.signature).serialized,
};
```

**`nonce` here is the EOA's transaction count**, not the `GaslessDelegate.nonce()` from earlier. Two different nonces:

| Nonce | Where it lives | When it increments |
|-------|----------------|---------------------|
| EOA transaction count (`getTransactionCount`) | EVM account meta | Every native tx the EOA sends. Likely 0 for a fresh wallet. |
| `GaslessDelegate.nonce()` | The EOA's storage (slot 0) | Every successful `executeBatch` call on this EOA. |

The EIP-7702 authorization needs the transaction count. The EIP-712 batch needs the contract nonce.

## 4. Submit

```ts
await postJson(`${backendUrl}/gasless/transactions/${requestId}/submit`, {
  signature,           // from step 3a
  authorization,       // from step 3b
});
```

On `201 Created`, the request is persisted and the relayer poller will pick it up within a few seconds. The Redis stash is dropped immediately.

If you get `40005 GASLESS_INVALID_SIGNATURE`, you've signed something that doesn't match what the backend expects — usually `operations` was modified after `/transactions` returned, or the wallet derived a different signer than `userAddress`. Recompute the digest locally and compare.

## 5. Poll for terminal status

```ts
async function pollUntilDone(backendUrl: string, requestId: string, opts = { intervalMs: 3000, timeoutMs: 180_000 }) {
  const start = Date.now();
  while (Date.now() - start < opts.timeoutMs) {
    const data = await getJson(`${backendUrl}/gasless/transactions/${requestId}`);
    if (['MINED_SUCCESS', 'MINED_FAILED', 'FAILED_PERMANENT'].includes(data.status)) return data;
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
  throw new Error(`request ${requestId} did not settle within ${opts.timeoutMs}ms`);
}
```

`MINED_SUCCESS` only means the outer tx mined — it does **not** guarantee the user's intent ops succeeded. If the atomic group reverted, the on-chain `BatchExecuted` event has `atomicSucceeded: false` and `AtomicReverted` is emitted with the revert data. To detect this, fetch the receipt and parse events:

```ts
import { Contract, JsonRpcProvider, EventLog } from 'ethers';

const delegateAbi = [
  'event BatchExecuted(address indexed account, uint256 indexed nonce, bool atomicSucceeded)',
  'event AtomicReverted(address indexed account, uint256 indexed nonce, bytes reason)',
];
const provider = new JsonRpcProvider(rpcUrl);
const receipt = await provider.getTransactionReceipt(status.txHash);
const iface = new Contract(userAddress, delegateAbi, provider).interface;
for (const log of receipt!.logs) {
  if (log.address.toLowerCase() !== userAddress.toLowerCase()) continue;
  try {
    const parsed = iface.parseLog(log);
    if (parsed?.name === 'BatchExecuted') {
      const atomicSucceeded = parsed.args.atomicSucceeded as boolean;
      if (!atomicSucceeded) console.warn('user intent reverted — fee was still paid');
    }
  } catch {}
}
```

## Wallet integration notes

If you're integrating with a browser wallet (MetaMask, Rabby, Frame, etc.):

- **EIP-7702 support is rolling out.** As of early 2026, MetaMask exposes `wallet_signAuthorization` (or a vendor-specific method) for signing the EIP-7702 tuple. Check the wallet's docs.
- **Smart account wallets that already implement delegation** may reject the authorization request or treat it differently. In that case, the user might not need EIP-7702 at all — the wallet is already a contract account. The gasless service in its current form is designed for plain EOAs, not smart accounts.
- **The EIP-712 signing flow is standard**. Any wallet supporting `eth_signTypedData_v4` works.

## Error handling cheat sheet

| Backend code | What it usually means | Client action |
|--------------|------------------------|----------------|
| `20001` chain not supported | Backend's `chains.json` doesn't list this `chainId` | Show "chain not supported" UI |
| `20003` no deployed contract | `GaslessDelegate` not deployed on this chain yet | Same as above |
| `40002` fee token not accepted, no route | User picked a fee token with no Rango path to an accepted token | Prompt user to choose another fee token |
| `40004` request expired | More than `GASLESS_CREATE_TTL_SECONDS` between `/transactions` and `/submit` | Restart from `/transactions` |
| `40005` invalid signature | The signature doesn't recover to `userAddress` over the prepared digest | Re-sign; verify `domain.verifyingContract === userAddress` |
| `40006` invalid authorization | The auth tuple doesn't match the delegate contract / chain | Re-fetch `delegateContractAddress` and re-sign auth |
| `40007` already submitted | `/submit` called twice on the same `requestId` | Poll status; don't resubmit |
| `MINED_FAILED` status | Tx mined with revert. Usually wrong batchNonce or insufficient fee-token balance | Read `failureReason`. If nonce drift, re-do `/transactions`. If balance, top up and re-do. |

See [error-codes.md](error-codes.md) for the complete registry.

## What you don't need to do

- **You don't need to know the operator's address.** The contract is permissionless.
- **You don't need to manage the operator's gas.** That's the backend's job.
- **You don't need to compute or pass `nonce`.** The backend reads it from chain in `/transactions`.
- **You don't need to construct the must-succeed-zone ops manually.** The backend builds them based on whether the fee token is accepted directly or requires a swap.
