import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HDNodeWallet, Interface, JsonRpcProvider, Signature, Transaction, Wallet, parseUnits } from 'ethers';

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
    // Solana m/44'/501'/{index}'/0'). Raw OPERATOR_PRIVATE_KEY kept as a fallback.
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

    return this.withOperatorLock(operator.address, () => this.rpc.withFallback<PreparedTx>(req.chainId, async (provider) => {
      const alreadyDelegated = await this.isAlreadyDelegated(provider, req.userAddress, req.delegateContractAddress);
      const ownerSigner = operator.connect(provider);
      const fee = await provider.getFeeData();
      const ownerNonce = await provider.getTransactionCount(operator.address, 'pending');

      const minTip = parseUnits('0.05', 'gwei');
      const maxPriorityFeePerGas = (fee.maxPriorityFeePerGas ?? 0n) < minTip ? minTip : (fee.maxPriorityFeePerGas ?? minTip);
      let maxFeePerGas = fee.maxFeePerGas ?? maxPriorityFeePerGas * 2n;
      if (maxFeePerGas < maxPriorityFeePerGas) {
        maxFeePerGas = maxPriorityFeePerGas;
      }

      const useType4 = !alreadyDelegated && !!req.authorization;
      const signedTx = await ownerSigner.signTransaction({
        to: req.userAddress,
        data,
        value: 0,
        type: useType4 ? 4 : 2,
        chainId: req.chainId,
        nonce: ownerNonce,
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
    return this.rpc.withFallback<BroadcastResult>(chainId, async (provider, url) => {
      const tx = await provider.broadcastTransaction(signedTx);
      this.logger.log(`broadcast chain=${chainId} hash=${tx.hash}`);
      // Redact: the keyed endpoint carries ${ANKR_API_KEY} in its path and this
      // value is persisted to transaction_request.broadcast_rpc_url (and thus
      // every DB backup/replica). Only the host is needed post-mortem.
      return { txHash: tx.hash, rpcUrl: redactRpcUrl(url) };
    });
  }

  async fetchReceipt(req: TransactionRequestEntity): Promise<{ status: 'pending' } | { status: 'success' | 'reverted'; blockNumber: number }> {
    if (!req.txHash) return { status: 'pending' };
    return this.rpc.withFallback(req.chainId, async (provider) => {
      const r = await provider.getTransactionReceipt(req.txHash!);
      if (!r) return { status: 'pending' as const };
      return r.status === 1
        ? { status: 'success' as const, blockNumber: r.blockNumber }
        : { status: 'reverted' as const, blockNumber: r.blockNumber };
    });
  }

  private async isAlreadyDelegated(provider: JsonRpcProvider, userAddress: string, delegateAddress: string): Promise<boolean> {
    const code = await provider.getCode(userAddress);
    const indicator = `0xef0100${delegateAddress.toLowerCase().slice(2)}`;
    return code.toLowerCase() === indicator.toLowerCase();
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
