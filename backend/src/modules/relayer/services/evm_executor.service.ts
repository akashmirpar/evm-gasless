import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HDNodeWallet, Interface, Signature, Transaction, Wallet, parseUnits } from 'ethers';
import { Priority, isNotFound, isPending } from '@getomnichain/omnichain';

import { PlutonException } from '../../../common/errors';
import { ChainConfigService } from '../../../core/chain_config/chain_config.service';
import { redactRpcUrl } from '../../../common/utils/redact_rpc';
import { RpcService } from '../../../core/rpc/rpc.service';
import { TransactionRequestEntity } from '../domain/entity/transaction_request.entity';
import { RelayerErrors } from '../relayer.errors';

const DELEGATE_IFACE = new Interface([
  'function executeBatch(tuple(address to, uint256 value, bytes data)[] ops, uint256 atomicGroupStart, uint256 batchNonce, bytes signature) external',
]);

export interface BroadcastResult {
  txHash: string;
  rpcUrl: string;
}

export interface PreparedTx {
  signedTx: string;
  txHash: string;
}

@Injectable()
export class EvmExecutorService implements OnModuleInit {
  private readonly logger = new Logger(EvmExecutorService.name);
  private readonly operatorMutex = new Map<string, Promise<unknown>>();
  private cachedOperator: Wallet | null = null;

  constructor(
    private readonly chainConfig: ChainConfigService,
    private readonly rpc: RpcService,
    private readonly config: ConfigService,
  ) {}

  /** Fail-fast: resolve the operator at boot so a missing/malformed seed is
   * caught before the first relay, not silently during one. */
  onModuleInit(): void {
    this.logger.log(`evm operator address: ${this.operatorWallet.address}`);
  }

  private get operatorWallet(): Wallet {
    // Cache: mnemonic derivation is PBKDF2(2048)+HD, not free — resolve once
    // rather than per prepare() call.
    if (this.cachedOperator) return this.cachedOperator;
    // Preferred: one BIP-39 mnemonic drives both chains (EVM m/44'/60'/0'/0/{index},
    // Raw OPERATOR_PRIVATE_KEY kept as a fallback.
    // Declared-but-unset YAML keys resolve to '' (not undefined), so test
    // truthiness after trim rather than nullish-coalescing.
    const mnemonic = (this.config.get<string>('OPERATOR_MNEMONIC') ?? '').trim();
    if (mnemonic) {
      const index = EvmExecutorService.parseIndex(this.config.get<string>('OPERATOR_MNEMONIC_INDEX'));
      const hd = HDNodeWallet.fromPhrase(mnemonic, undefined, `m/44'/60'/0'/0/${index}`);
      this.cachedOperator = new Wallet(hd.privateKey);
      return this.cachedOperator;
    }
    const pk = (this.config.get<string>('OPERATOR_PRIVATE_KEY') ?? '').trim();
    if (!pk) throw new Error('operator wallet unset: provide OPERATOR_MNEMONIC or OPERATOR_PRIVATE_KEY');
    this.cachedOperator = new Wallet(pk);
    return this.cachedOperator;
  }

  private static parseIndex(raw: string | undefined): number {
    const n = Number((raw ?? '0').trim() || '0');
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`OPERATOR_MNEMONIC_INDEX must be a non-negative integer, got ${raw}`);
    }
    return n;
  }

  private async withOperatorLock<T>(operatorAddress: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.operatorMutex.get(operatorAddress) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(fn);
    this.operatorMutex.set(operatorAddress, next);
    try {
      return await next;
    } finally {
      if (this.operatorMutex.get(operatorAddress) === next) {
        this.operatorMutex.delete(operatorAddress);
      }
    }
  }

  async prepare(req: TransactionRequestEntity): Promise<PreparedTx> {
    const data = DELEGATE_IFACE.encodeFunctionData('executeBatch', [
      req.operations.map((o) => [o.to, BigInt(o.value), o.data]),
      BigInt(req.atomicGroupStart),
      BigInt(req.batchNonce),
      req.signature,
    ]);
    const operator = this.operatorWallet;

    return this.withOperatorLock(operator.address, () => this.rpc.withChain<PreparedTx>(req.chainId, async (chain) => {
      const delegation = await chain.getDelegation(req.userAddress);
      const alreadyDelegated = !!delegation && delegation.delegate.toLowerCase() === req.delegateContractAddress.toLowerCase();
      const gas = await chain.suggestGas(Priority.NORMAL);
      const ownerNonce = await chain.getPendingNonce(operator.address);

      const minTip = parseUnits('0.05', 'gwei');
      const suggestedTip = gas.maxPriorityFeePerGas ?? 0n;
      const maxPriorityFeePerGas = suggestedTip < minTip ? minTip : suggestedTip;
      let maxFeePerGas = gas.maxFeePerGas ?? maxPriorityFeePerGas * 2n;
      if (maxFeePerGas < maxPriorityFeePerGas) {
        maxFeePerGas = maxPriorityFeePerGas;
      }

      // Signing is local (custody stays consumer-side) — no provider needed.
      const useType4 = !alreadyDelegated && !!req.authorization;
      const signedTx = await operator.signTransaction({
        to: req.userAddress,
        data,
        value: 0,
        type: useType4 ? 4 : 2,
        chainId: req.chainId,
        nonce: Number(ownerNonce),
        gasLimit: BigInt(this.config.get<string>('GASLESS_TX_GAS_LIMIT') ?? '2000000'),
        maxFeePerGas,
        maxPriorityFeePerGas,
        authorizationList: useType4 ? [this.toAuthorizationStruct(req)] : undefined,
      });
      const parsed = Transaction.from(signedTx);
      const txHash = parsed.hash;
      if (!txHash) {
        throw PlutonException(RelayerErrors.BroadcastFailed, new Error('signed tx has no derivable hash'), 'system');
      }
      return { signedTx, txHash };
    }));
  }

  async send(chainId: number, signedTx: string): Promise<BroadcastResult> {
    return this.rpc.withChain<BroadcastResult>(chainId, async (chain, url) => {
      // The SDK treats provider "already-known" as success and returns the
      // deterministic hash, so a failover re-broadcast of the SAME signed bytes
      // to another endpoint can't double-send.
      const txHash = await chain.broadcast(signedTx);
      this.logger.log(`broadcast chain=${chainId} hash=${txHash}`);
      // Redact: the keyed endpoint carries ${ANKR_API_KEY} in its path and this
      // value is persisted to transaction_request.broadcast_rpc_url (and thus
      // every DB backup/replica). Only the host is needed post-mortem.
      return { txHash, rpcUrl: redactRpcUrl(url) };
    });
  }

  async fetchReceipt(req: TransactionRequestEntity): Promise<{ status: 'pending' } | { status: 'success' | 'reverted'; blockNumber: number }> {
    if (!req.txHash) return { status: 'pending' };
    return this.rpc.withChain(req.chainId, async (chain) => {
      const st = await chain.getTransactionStatus(req.txHash!);
      if (isPending(st) || isNotFound(st)) return { status: 'pending' as const };
      return st.status === 'Success'
        ? { status: 'success' as const, blockNumber: st.blockNumber ?? 0 }
        : { status: 'reverted' as const, blockNumber: st.blockNumber ?? 0 };
    });
  }

  private toAuthorizationStruct(req: TransactionRequestEntity): { chainId: number; address: string; nonce: number; signature: { r: string; s: string; yParity: 0 | 1 } } {
    const auth = req.authorization!;
    const sig = Signature.from(auth.signature);
    return {
      chainId: auth.chainId,
      address: auth.address,
      nonce: Number(auth.nonce),
      signature: { r: sig.r, s: sig.s, yParity: sig.yParity },
    };
  }
}
