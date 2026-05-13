import { Injectable } from '@nestjs/common';
import { Signature, verifyTypedData } from 'ethers';
import { v4 as uuidv4 } from 'uuid';

import { PlutonException } from '../../../common/errors';
import { ChainConfigService } from '../../../core/chain_config/chain_config.service';
import { IContext } from '../../../core/context/context';
import { RelayerService } from '../../relayer/relayer.service';
import { TransactionRequestEntity } from '../../relayer/domain/entity/transaction_request.entity';
import { CreateTransactionRequestDto, CreateTransactionResponseDto } from '../dto/create_transaction.dto';
import { EstimateRequestDto, EstimateResponseDto } from '../dto/estimate.dto';
import { StatusResponseDto } from '../dto/status.dto';
import { SubmitTransactionRequestDto, SubmitTransactionResponseDto } from '../dto/submit.dto';
import { GaslessErrors } from '../gasless.errors';
import { BatchBuilderService } from './batch_builder.service';
import { BatchHashService } from './batch_hash.service';
import { DelegateStateService } from './delegate_state.service';
import { FeeEstimatorService } from './fee_estimator.service';
import { GaslessCacheService } from './gasless_cache.service';

@Injectable()
export class GaslessService {
  constructor(
    private readonly chainConfig: ChainConfigService,
    private readonly feeEstimator: FeeEstimatorService,
    private readonly batchBuilder: BatchBuilderService,
    private readonly batchHash: BatchHashService,
    private readonly delegateState: DelegateStateService,
    private readonly cache: GaslessCacheService,
    private readonly relayer: RelayerService,
  ) {}

  async estimate(dto: EstimateRequestDto): Promise<EstimateResponseDto> {
    const est = await this.feeEstimator.estimate(dto.chainId, dto.userAddress, dto.feeTokenAddress, dto.operations);
    return {
      feeTokenAddress: est.feeTokenAddress,
      feeAmount: est.feeAmountInFeeToken.toFixed(),
      acceptedFeeToken: est.acceptedFeeToken,
      swapRoute: est.swapRoute
        ? {
            inputToken: est.swapRoute.inputToken,
            outputToken: est.swapRoute.outputToken,
            outputAmount: est.swapRoute.outputAmount.toFixed(),
          }
        : undefined,
    };
  }

  async createTransaction(dto: CreateTransactionRequestDto): Promise<CreateTransactionResponseDto> {
    const cfg = this.chainConfig.get(dto.chainId);
    const delegateAddress = this.chainConfig.requireDelegateAddress(dto.chainId);

    const est = await this.feeEstimator.estimate(dto.chainId, dto.userAddress, dto.feeTokenAddress, dto.operations);
    const built = await this.batchBuilder.build(dto.chainId, dto.userAddress, est, dto.operations);
    const onChainNonce = await this.delegateState.readNonce(dto.chainId, dto.userAddress);
    const batchNonce = onChainNonce.toString();

    const digest = this.batchHash.digest(dto.chainId, dto.userAddress, built.operations, built.atomicGroupStart, batchNonce);

    const requestId = uuidv4();
    const ttlSeconds = Number(process.env.GASLESS_CREATE_TTL_SECONDS ?? '300');
    const expiresAtSeconds = Math.floor(Date.now() / 1000) + ttlSeconds;

    await this.cache.put(requestId, {
      chainId: dto.chainId,
      userAddress: dto.userAddress,
      delegateContractAddress: delegateAddress,
      feeTokenAddress: est.feeTokenAddress,
      feeAmount: est.feeAmountInFeeToken.toFixed(),
      operations: built.operations,
      atomicGroupStart: built.atomicGroupStart,
      batchNonce,
      digest,
      createdAt: Date.now(),
    });

    return {
      requestId,
      delegateContractAddress: delegateAddress,
      chainId: dto.chainId,
      nonce: batchNonce,
      atomicGroupStart: built.atomicGroupStart,
      operations: built.operations,
      digest,
      expiresAtSeconds,
    };
  }

  async submit(ctx: IContext, requestId: string, dto: SubmitTransactionRequestDto): Promise<SubmitTransactionResponseDto> {
    const cached = await this.cache.get(requestId);
    if (!cached) throw PlutonException(GaslessErrors.RequestExpired);

    const domain = this.batchHash.buildDomain(cached.chainId, cached.userAddress);
    const value = {
      operations: cached.operations,
      atomicGroupStart: cached.atomicGroupStart,
      nonce: cached.batchNonce,
    };
    let recovered: string;
    try {
      recovered = verifyTypedData(domain, this.batchHash.types, value, dto.signature);
    } catch (err) {
      throw PlutonException(GaslessErrors.InvalidSignature, err);
    }
    if (recovered.toLowerCase() !== cached.userAddress.toLowerCase()) {
      throw PlutonException(GaslessErrors.InvalidSignature, { recovered, expected: cached.userAddress });
    }

    if (
      dto.authorization.address.toLowerCase() !== cached.delegateContractAddress.toLowerCase() ||
      dto.authorization.chainId !== cached.chainId
    ) {
      throw PlutonException(GaslessErrors.InvalidAuthorization, {
        expectedAddress: cached.delegateContractAddress,
        expectedChainId: cached.chainId,
        provided: dto.authorization,
      });
    }
    try {
      Signature.from(dto.authorization.signature);
    } catch (err) {
      throw PlutonException(GaslessErrors.InvalidAuthorization, err);
    }

    const existing = await this.relayer.findByRequestId(ctx, requestId);
    if (existing) {
      throw PlutonException(GaslessErrors.AlreadySubmitted, { requestId });
    }

    const entity = await this.relayer.insertPending(ctx, {
      requestId,
      chainId: cached.chainId,
      userAddress: cached.userAddress,
      delegateContractAddress: cached.delegateContractAddress,
      feeTokenAddress: cached.feeTokenAddress,
      feeAmount: cached.feeAmount,
      atomicGroupStart: cached.atomicGroupStart,
      batchNonce: cached.batchNonce,
      operations: cached.operations,
      signature: dto.signature,
      authorization: dto.authorization,
    });

    await this.cache.drop(requestId);

    return { requestId, status: entity.status.toString() };
  }

  async status(ctx: IContext, requestId: string): Promise<StatusResponseDto> {
    const entity = await this.relayer.findByRequestId(ctx, requestId);
    if (!entity) throw PlutonException(GaslessErrors.RequestNotFound);
    return this.mapStatus(entity);
  }

  private mapStatus(entity: TransactionRequestEntity): StatusResponseDto {
    return {
      requestId: entity.requestId,
      status: TransactionRequestStatusName[entity.status] ?? `unknown_${entity.status}`,
      chainId: entity.chainId,
      txHash: entity.txHash,
      retryTimes: entity.retryTimes,
      failureReason: entity.failureReason,
      createdAt: entity.createdAt.toISOString(),
      updatedAt: entity.updatedAt ? entity.updatedAt.toISOString() : null,
    };
  }
}

const TransactionRequestStatusName: Record<number, string> = {
  0: 'PENDING',
  10: 'BROADCASTING',
  20: 'BROADCASTED',
  30: 'MINED_SUCCESS',
  40: 'MINED_FAILED',
  90: 'FAILED_PERMANENT',
};
