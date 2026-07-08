import { Injectable } from '@nestjs/common';
import { TypedDataDomain, TypedDataField, TypedDataEncoder } from 'ethers';

import { OperationInput } from '../domain/operation';

@Injectable()
export class BatchHashService {
  buildDomain(chainId: number, verifyingContract: string): TypedDataDomain {
    return { name: 'GaslessDelegate', version: '1', chainId, verifyingContract };
  }

  readonly types: Record<string, TypedDataField[]> = {
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

  digest(chainId: number, verifyingContract: string, ops: OperationInput[], atomicGroupStart: number, nonce: string): string {
    const domain = this.buildDomain(chainId, verifyingContract);
    const value = {
      operations: ops.map((o) => ({ to: o.to, value: o.value, data: o.data })),
      atomicGroupStart,
      nonce,
    };
    return TypedDataEncoder.hash(domain, this.types, value);
  }
}
