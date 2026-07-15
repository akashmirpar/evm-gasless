import BigNumber from 'bignumber.js';

import { ErrorCodes } from '../../common/errors/codes';
import { NATIVE_TOKEN_SENTINEL } from '../chain_config/chain_config.service';
import { PricingService } from './pricing.service';
import { PriceBlob, priceKey } from './pricing.types';

const RANGO_CHAIN = 'BSC';
const USDT = '0x55d398326f99059ff775485246999027b3197955';

function makeService(): { svc: PricingService; cache: { get: jest.Mock; set: jest.Mock; del: jest.Mock } } {
  const cache = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined), del: jest.fn() };
  const chainConfig = { get: () => ({ rangoChainName: RANGO_CHAIN }) } as never;
  const svc = new PricingService(cache as never, chainConfig);
  return { svc, cache };
}

function blob(ageMs = 0): PriceBlob {
  return {
    updatedAt: Date.now() - ageMs,
    tokens: {
      [priceKey(RANGO_CHAIN, null)]: { usdPrice: 600, decimals: 18 },
      [priceKey(RANGO_CHAIN, USDT)]: { usdPrice: 1, decimals: 6 },
    },
  };
}

describe('PricingService', () => {
  it('serves a published native price', async () => {
    const { svc } = makeService();
    await svc.publish(blob());
    expect(await svc.priceUsd(56, NATIVE_TOKEN_SENTINEL)).toBe(600);
  });

  it('converts a native amount into fee-token base units at current prices', async () => {
    const { svc } = makeService();
    await svc.publish(blob());
    // 0.001 BNB (1e15 wei) at $600 = $0.60 → 0.60 USDT → 600000 base units (6 decimals).
    const out = await svc.nativeToFeeToken(56, USDT, new BigNumber('1000000000000000'));
    expect(out.toFixed()).toBe('600000');
  });

  it('rounds fee-token base units up (operator never under-charges)', async () => {
    const { svc } = makeService();
    const b = blob();
    b.tokens[priceKey(RANGO_CHAIN, USDT)] = { usdPrice: 3, decimals: 6 };
    await svc.publish(b);
    // $0.60 / $3 = 0.2 USDT → 200000; use an amount that produces a fraction.
    const out = await svc.nativeToFeeToken(56, USDT, new BigNumber('1000000000000001'));
    expect(out.toFixed()).toMatch(/^\d+$/);
    expect(out.isGreaterThanOrEqualTo(200000)).toBe(true);
  });

  it('renders USD value of a token amount', async () => {
    const { svc } = makeService();
    await svc.publish(blob());
    const usd = await svc.toUsd(56, USDT, new BigNumber('1500000')); // 1.5 USDT
    expect(usd.toFixed()).toBe('1.5');
  });

  it('throws PriceUnavailable when the blob is stale', async () => {
    const { svc } = makeService(); // maxAge default 900s
    await svc.publish(blob(901_000));
    await expect(svc.priceUsd(56, NATIVE_TOKEN_SENTINEL)).rejects.toMatchObject({
      errorInfo: { code: ErrorCodes.GASLESS_PRICE_UNAVAILABLE },
    });
  });

  it('throws PriceUnavailable when the token is absent from the blob', async () => {
    const { svc } = makeService();
    await svc.publish(blob());
    await expect(svc.priceUsd(56, '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).rejects.toMatchObject({
      errorInfo: { code: ErrorCodes.GASLESS_PRICE_UNAVAILABLE },
    });
  });

  it('lazily loads the blob from Redis when the in-memory copy is empty', async () => {
    const { svc, cache } = makeService();
    cache.get.mockResolvedValueOnce(JSON.stringify(blob()));
    expect(await svc.priceUsd(56, NATIVE_TOKEN_SENTINEL)).toBe(600);
    expect(cache.get).toHaveBeenCalledTimes(1);
  });

  it('pins Redis retention to maxAge, not the global default TTL', async () => {
    const { svc, cache } = makeService();
    await svc.publish(blob());
    expect(cache.set).toHaveBeenCalledWith('gasless:prices', expect.any(String), 900_000);
  });

  it('re-reads Redis and adopts a fresher blob when the in-memory copy is stale (self-heal)', async () => {
    const { svc, cache } = makeService();
    await svc.publish(blob(901_000)); // in-memory copy is stale
    const fresh = blob(0);
    fresh.tokens[priceKey(RANGO_CHAIN, null)] = { usdPrice: 999, decimals: 18 };
    cache.get.mockResolvedValueOnce(JSON.stringify(fresh));
    expect(await svc.priceUsd(56, NATIVE_TOKEN_SENTINEL)).toBe(999);
  });

  it('discards a Redis blob with a non-numeric updatedAt instead of trusting it as fresh', async () => {
    const { svc, cache } = makeService();
    // No in-memory copy; Redis returns a blob whose updatedAt would make the
    // age guard misbehave (NaN comparison). Must fail closed, not serve it.
    cache.get.mockResolvedValueOnce(JSON.stringify({ updatedAt: 'oops', tokens: blob().tokens }));
    await expect(svc.priceUsd(56, NATIVE_TOKEN_SENTINEL)).rejects.toMatchObject({
      errorInfo: { code: ErrorCodes.GASLESS_PRICE_UNAVAILABLE },
    });
  });

  it('does not touch Redis while the in-memory copy is fresh', async () => {
    const { svc, cache } = makeService();
    await svc.publish(blob());
    await svc.priceUsd(56, NATIVE_TOKEN_SENTINEL);
    expect(cache.get).not.toHaveBeenCalled();
  });
});
