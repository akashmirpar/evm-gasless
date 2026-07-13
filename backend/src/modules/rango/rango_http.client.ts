import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosInstance, isAxiosError } from 'axios';
import BigNumber from 'bignumber.js';

import { PlutonException } from '../../common/errors';
import { RangoClient } from './rango.client';
import { RangoErrors } from './rango.errors';
import {
  RangoEvmCall,
  RangoMetaToken,
  RangoQuoteRequest,
  RangoQuoteResult,
  RangoSolanaCall,
  RangoSwapRequest,
  RangoSwapResult,
} from './rango.types';

interface RangoMetaResponse {
  tokens?: Array<{
    blockchain?: string;
    symbol?: string;
    address?: string | null;
    decimals?: number;
    usdPrice?: number | null;
  }>;
}

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
    // EVM fields (type === 'EVM').
    txTo?: string;
    txData?: string;
    value?: string;
    approveTo?: string;
    approveData?: string;
    // Solana fields (type === 'SOLANA').
    txType?: 'VERSIONED' | 'LEGACY';
    serializedMessage?: number[];
    recentBlockhash?: string;
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
    // Rango's /basic/quote is intermittently slow (10-25s tail latencies
    // observed 2026-07-11). Env-overridable; default 30s survives the
    // typical p99 while still capping runaway hangs.
    this.http = axios.create({ baseURL: baseUrl, timeout: Number(process.env.RANGO_HTTP_TIMEOUT_MS ?? '30000') });
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
    const out = new BigNumber(data.outputAmount ?? data.route?.outputAmount ?? '0');
    const min = new BigNumber(data.outputAmountMin ?? data.route?.outputAmountMin ?? out.toFixed());

    if (data.tx.type === 'EVM') {
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
      return { outputAmount: out, outputAmountMin: min, requestId: data.requestId, evmTransaction: evm, raw: data };
    }

    if (data.tx.type === 'SOLANA') {
      if (!Array.isArray(data.tx.serializedMessage) || data.tx.serializedMessage.length === 0) {
        throw PlutonException(RangoErrors.InvalidResponse, data);
      }
      if (!data.tx.recentBlockhash) {
        throw PlutonException(RangoErrors.InvalidResponse, data);
      }
      const txType: 'VERSIONED' | 'LEGACY' = data.tx.txType === 'LEGACY' ? 'LEGACY' : 'VERSIONED';
      const solana: RangoSolanaCall = {
        serializedMessage: Uint8Array.from(data.tx.serializedMessage),
        recentBlockhash: data.tx.recentBlockhash,
        from: data.tx.from ?? '',
        txType,
      };
      return { outputAmount: out, outputAmountMin: min, requestId: data.requestId, solanaTransaction: solana, raw: data };
    }

    throw PlutonException(RangoErrors.InvalidResponse, data);
  }

  async meta(): Promise<RangoMetaToken[]> {
    const data = await this.call<RangoMetaResponse>('/basic/meta', {});
    const tokens = data.tokens ?? [];
    return tokens
      .filter(
        (t) =>
          typeof t.blockchain === 'string' &&
          typeof t.symbol === 'string' &&
          Number.isInteger(t.decimals) &&
          (t.decimals as number) >= 0 &&
          (t.decimals as number) <= 36,
      )
      .map((t) => ({
        chainName: t.blockchain as string,
        address: t.address ?? null,
        symbol: t.symbol as string,
        decimals: t.decimals as number,
        usdPrice: typeof t.usdPrice === 'number' ? t.usdPrice : null,
      }));
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
