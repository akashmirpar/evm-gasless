# GaslessDelegate

EIP-7702 delegate target. Users delegate their EOA to this contract; **anyone** can then submit batches of operations the user has signed off-chain with a single EIP-712 signature. Submission is permissionless — the user's signature commits to every byte of the operation list, so a third-party submitter cannot redirect any payment.

A batch has two zones, split by `atomicGroupStart`:
- **Must-succeed zone** (`ops[0..atomicGroupStart-1]`): treasury transfer, ERC-20 approvals, fee-token swaps. Whole-tx revert on any failure.
- **Atomic group** (`ops[atomicGroupStart..end]`): the user's actual intent. Isolated via self-call — a revert here unwinds only the group, leaving the must-succeed zone intact and the nonce consumed.

```
gasless/contract/
├── src/GaslessDelegate.sol      contract
├── test/GaslessDelegate.t.sol   foundry tests
└── docs/
    ├── architecture.md          roles, flow, EIP-7702 context
    ├── execution-model.md       must-succeed-zone + atomic-group split
    └── eip712-batch-hashing.md  signing scheme rationale (with EIP-712 citations)
```

## Where to read next

- **Trying to understand the contract end-to-end?** Start with [docs/architecture.md](docs/architecture.md).
- **Wondering why the batch is split into two zones?** [docs/execution-model.md](docs/execution-model.md).
- **Wondering why the batch is hashed the way it is?** [docs/eip712-batch-hashing.md](docs/eip712-batch-hashing.md).

## Build & test

```sh
forge build
forge test
```
