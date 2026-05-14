import { Injectable, Logger } from '@nestjs/common';
import { Interface, JsonRpcProvider, Signature, Wallet, parseUnits } from 'ethers';

import { PlutonException } from '../../../common/errors';
import { ChainConfigService } from '../../../core/chain_config/chain_config.service';
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

@Injectable()
export class EvmExecutorService {
  private readonly logger = new Logger(EvmExecutorService.name);

  constructor(
    private readonly chainConfig: ChainConfigService,
    private readonly rpc: RpcService,
  ) {}

  private get operatorWallet(): Wallet {
    const pk = (process.env.OPERATOR_PRIVATE_KEY ?? '').trim();
    if (!pk) throw new Error('OPERATOR_PRIVATE_KEY missing');
    return new Wallet(pk);
  }

  async broadcast(req: TransactionRequestEntity): Promise<BroadcastResult> {
    const cfg = this.chainConfig.get(req.chainId);
    const data = DELEGATE_IFACE.encodeFunctionData('executeBatch', [
      req.operations.map((o) => [o.to, BigInt(o.value), o.data]),
      BigInt(req.atomicGroupStart),
      BigInt(req.batchNonce),
      req.signature,
    ]);
    const operator = this.operatorWallet;

    return this.rpc.withFallback<BroadcastResult>(req.chainId, async (provider, url) => {
      const alreadyDelegated = await this.isAlreadyDelegated(provider, req.userAddress, req.delegateContractAddress);
      const ownerSigner = operator.connect(provider);
      const fee = await provider.getFeeData();
      const ownerNonce = await provider.getTransactionCount(operator.address);

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
        gasLimit: BigInt(process.env.GASLESS_TX_GAS_LIMIT ?? '2000000'),
        maxFeePerGas,
        maxPriorityFeePerGas,
        authorizationList: useType4 ? [this.toAuthorizationStruct(req)] : undefined,
      });

      const tx = await provider.broadcastTransaction(signedTx);
      this.logger.log(`broadcast id=${req.id} chain=${req.chainId} hash=${tx.hash}`);
      return { txHash: tx.hash, rpcUrl: url };
    }).catch((err) => {
      throw PlutonException(RelayerErrors.BroadcastFailed, err, 'system');
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
