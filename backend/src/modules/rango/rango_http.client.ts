import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance, isAxiosError } from 'axios';
import BigNumber from 'bignumber.js';

import { PlutonException } from '../../common/errors';
import { RangoClient } from './rango.client';
import { RangoErrors } from './rango.errors';
import {
  RangoEvmCall,
  RangoQuoteRequest,
  RangoQuoteResult,
  RangoSwapRequest,
  RangoSwapResult,
} from './rango.types';

interface RangoBasicQuoteResponse {
  requestId: string;
  resultType: string;
  outputAmount?: string;
  outputAmountMin?: string;
  error?: string | null;
  errorCode?: string | null;
  route?: {
    outputAmount?: string;
    outputAmountMin?: string;
  };
}

interface RangoBasicSwapResponse extends RangoBasicQuoteResponse {
  tx?: {
    type: string;
    from?: string;
    // Rango Basic API uses txTo/txData for the EVM call, distinct from
    // approveTo/approveData which describe the (optional) prerequisite approve.
    txTo?: string;
    txData?: string;
    value?: string;
    approveTo?: string;
    approveData?: string;
  };
}

@Injectable()
export class RangoHttpClient extends RangoClient {
  private readonly logger = new Logger(RangoHttpClient.name);
  private readonly http: AxiosInstance;
  private readonly apiKey: string;

  constructor() {
    super();
    const baseUrl = (process.env.RANGO_API_URL ?? 'https://api.rango.exchange').replace(/\/$/, '');
    this.apiKey = (process.env.RANGO_API_KEY ?? '').trim();
    this.http = axios.create({ baseURL: baseUrl, timeout: 15_000 });
  }

  async quote(req: RangoQuoteRequest): Promise<RangoQuoteResult> {
    const data = await this.call<RangoBasicQuoteResponse>('/basic/quote', {
      from: this.token(req.from),
      to: this.token(req.to),
      amount: req.amount,
    });
    if (data.resultType !== 'OK' || (!data.outputAmount && !data.route?.outputAmount)) {
      throw PlutonException(RangoErrors.NoRoute, data);
    }
    const out = new BigNumber(data.outputAmount ?? data.route!.outputAmount!);
    const min = new BigNumber(data.outputAmountMin ?? data.route?.outputAmountMin ?? out.toFixed());
    return { outputAmount: out, outputAmountMin: min, requestId: data.requestId, raw: data };
  }

  async swap(req: RangoSwapRequest): Promise<RangoSwapResult> {
    const data = await this.call<RangoBasicSwapResponse>('/basic/swap', {
      from: this.token(req.from),
      to: this.token(req.to),
      amount: req.amount,
      fromAddress: req.userAddress,
      toAddress: req.recipientAddress,
      slippage: req.slippage,
      disableEstimate: true,
    });
    if (data.resultType !== 'OK' || !data.tx) {
      throw PlutonException(RangoErrors.NoRoute, data);
    }
    if (data.tx.type !== 'EVM') {
      throw PlutonException(RangoErrors.InvalidResponse, data);
    }
    if (!data.tx.txTo || !data.tx.txData) {
      throw PlutonException(RangoErrors.InvalidResponse, data);
    }
    const evm: RangoEvmCall = {
      from: data.tx.from ?? '',
      to: data.tx.txTo,
      data: data.tx.txData,
      value: data.tx.value ?? '0',
      approveTo: data.tx.approveTo ?? null,
      approveData: data.tx.approveData ?? null,
      approveAddress: data.tx.approveTo ?? null,
    };
    const out = new BigNumber(data.outputAmount ?? data.route?.outputAmount ?? '0');
    const min = new BigNumber(data.outputAmountMin ?? data.route?.outputAmountMin ?? out.toFixed());
    return { outputAmount: out, outputAmountMin: min, requestId: data.requestId, evmTransaction: evm, raw: data };
  }

  private token(t: { chainName: string; address: string | null; symbol: string }): string {
    if (!t.address) return `${t.chainName}.${t.symbol}`;
    return `${t.chainName}.${t.symbol}--${t.address}`;
  }

  private async call<T>(path: string, params: Record<string, unknown>): Promise<T> {
    try {
      const { data } = await this.http.get<T>(path, {
        params: this.apiKey ? { ...params, apiKey: this.apiKey } : params,
      });
      return data;
    } catch (err) {
      if (isAxiosError(err)) {
        this.logger.warn(`rango ${path} failed status=${err.response?.status} body=${JSON.stringify(err.response?.data ?? {})}`);
      } else {
        this.logger.warn(`rango ${path} failed: ${(err as Error)?.message ?? err}`);
      }
      throw PlutonException(RangoErrors.RequestFailed, err);
    }
  }
}
