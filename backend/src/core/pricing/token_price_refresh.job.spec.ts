import { RangoMetaToken } from '../../modules/rango/rango.types';
import { PriceBlob, priceKey } from './pricing.types';
import { TokenPriceRefreshJob } from './token_price_refresh.job';

function makeJob(metaTokens: RangoMetaToken[] | Error): {
  job: TokenPriceRefreshJob;
  published: PriceBlob[];
  meta: jest.Mock;
} {
  const scheduler = { register: jest.fn() };
  const meta = jest.fn(metaTokens instanceof Error ? () => Promise.reject(metaTokens) : () => Promise.resolve(metaTokens));
  const rango = { meta } as never;
  const published: PriceBlob[] = [];
  const pricing = { publish: jest.fn(async (b: PriceBlob) => { published.push(b); }) } as never;
  const job = new TokenPriceRefreshJob(scheduler as never, rango, pricing);
  return { job, published, meta };
}

const tok = (chainName: string, address: string | null, usdPrice: number | null, decimals = 18): RangoMetaToken => ({
  chainName,
  address,
  symbol: 'X',
  decimals,
  usdPrice,
});

describe('TokenPriceRefreshJob', () => {
  it('registers itself with the scheduler on construction', () => {
    const scheduler = { register: jest.fn() };
    new TokenPriceRefreshJob(scheduler as never, { meta: jest.fn() } as never, { publish: jest.fn() } as never);
    expect(scheduler.register).toHaveBeenCalledWith('SCHEDULER_TOKEN_PRICE_REFRESH', expect.anything(), expect.any(String));
  });

  it('publishes a blob keyed by chain+address, native included, priced tokens only', async () => {
    const { job, published } = makeJob([
      tok('BSC', null, 600, 18),
      tok('BSC', '0xAAA', 1, 6),
      tok('BSC', '0xBBB', null, 6), // no price → skipped
    ]);
    await job.execute();
    expect(published).toHaveLength(1);
    const blob = published[0];
    expect(blob.tokens[priceKey('BSC', null)]).toEqual({ usdPrice: 600, decimals: 18 });
    expect(blob.tokens[priceKey('BSC', '0xaaa')]).toEqual({ usdPrice: 1, decimals: 6 });
    expect(blob.tokens[priceKey('BSC', '0xbbb')]).toBeUndefined();
    expect(blob.updatedAt).toBeGreaterThan(0);
  });

  it('skips tokens with non-integer or out-of-range decimals (NaN passes typeof number)', async () => {
    const { job, published } = makeJob([
      tok('BSC', null, 600, 18),
      tok('BSC', '0xNAN', 5, NaN),
      tok('BSC', '0xNEG', 5, -2),
      tok('BSC', '0xBIG', 5, 999),
    ]);
    await job.execute();
    expect(Object.keys(published[0].tokens)).toEqual([priceKey('BSC', null)]);
  });

  it('does NOT overwrite with an empty blob when meta returns no usable prices', async () => {
    const { job, published } = makeJob([tok('BSC', '0xAAA', null), tok('BSC', '0xBBB', 0)]);
    await job.execute();
    expect(published).toHaveLength(0);
  });

  it('propagates a Rango outage (job runner logs; last blob is kept)', async () => {
    const { job, published } = makeJob(new Error('rango down'));
    await expect(job.execute()).rejects.toThrow('rango down');
    expect(published).toHaveLength(0);
  });
});
