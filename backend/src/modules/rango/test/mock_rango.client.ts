import { Injectable } from '@nestjs/common';
import BigNumber from 'bignumber.js';

import { RangoClient } from '../rango.client';
import { RangoQuoteRequest, RangoQuoteResult, RangoSwapRequest, RangoSwapResult } from '../rango.types';

@Injectable()
export class MockRangoClient extends RangoClient {
  constructor(
    private readonly outputAmount = new BigNumber('1000000'),
    private readonly evmTo = '0x1111111111111111111111111111111111111111',
  ) {
    super();
  }

  async quote(_req: RangoQuoteRequest): Promise<RangoQuoteResult> {
    return {
      outputAmount: this.outputAmount,
      outputAmountMin: this.outputAmount.multipliedBy('0.995').integerValue(BigNumber.ROUND_FLOOR),
      requestId: 'mock-req',
      raw: null,
    };
  }

  async swap(req: RangoSwapRequest): Promise<RangoSwapResult> {
    return {
      outputAmount: this.outputAmount,
      outputAmountMin: this.outputAmount.multipliedBy('0.995').integerValue(BigNumber.ROUND_FLOOR),
      requestId: 'mock-req',
      evmTransaction: {
        from: req.userAddress,
        to: this.evmTo,
        data: '0x',
        value: '0',
        approveTo: this.evmTo,
        approveData: '0x',
        approveAddress: this.evmTo,
      },
      raw: null,
    };
  }
}
