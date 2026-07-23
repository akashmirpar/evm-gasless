import { RangoMetaToken, RangoQuoteRequest, RangoQuoteResult, RangoSwapRequest, RangoSwapResult } from './rango.types';

export abstract class RangoClient {
  abstract quote(req: RangoQuoteRequest): Promise<RangoQuoteResult>;
  abstract swap(req: RangoSwapRequest): Promise<RangoSwapResult>;
  /** Full token list with USD prices from `/basic/meta`. */
  abstract meta(): Promise<RangoMetaToken[]>;
}
