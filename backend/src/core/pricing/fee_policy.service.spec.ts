import BigNumber from 'bignumber.js';

import { ErrorCodes } from '../../common/errors/codes';
import { FeePolicyService } from './fee_policy.service';

const USDT = '0x55d398326f99059ff775485246999027b3197955';

function makePricing() {
  return {
    // identity-ish: returns the native base-unit amount as the fee-token amount
    // (assumes a 1:1 price ratio), so tests can reason about ceilings directly.
    nativeToFeeToken: jest.fn(async (_c: number, _t: string, n: BigNumber) => n),
    toUsd: jest.fn(async (_c: number, _t: string, base: BigNumber) => base.dividedBy(1_000_000)),
  };
}

function withEnv(env: Record<string, string | undefined>, fn: () => void | Promise<void>) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  return Promise.resolve(fn()).finally(() => {
    process.env = saved;
  });
}

describe('FeePolicyService', () => {
  describe('mode + fixed sizing', () => {
    it('returns null from fixedSettlementAmount in bps mode (caller keeps its path)', async () => {
      await withEnv({ GASLESS_FEE_MODE: undefined }, async () => {
        const svc = new FeePolicyService(makePricing() as never);
        expect(svc.mode()).toBe('bps');
        expect(await svc.fixedSettlementAmount(56, USDT, 'USDT', 6, new BigNumber('1000'))).toBeNull();
      });
    });

    it('fixed mode: cost priced into the fee token plus per-token profit (by address)', async () => {
      await withEnv({ GASLESS_FEE_MODE: 'fixed', GASLESS_FEE_PROFIT: `56:${USDT}:0.001` }, async () => {
        const svc = new FeePolicyService(makePricing() as never);
        // cost = 500000 base units; profit 0.001 * 10^6 = 1000 → 501000
        const out = await svc.fixedSettlementAmount(56, USDT, 'USDT', 6, new BigNumber('500000'));
        expect(out!.toFixed()).toBe('501000');
      });
    });

    it('fixed mode: profit resolves by symbol when no address entry', async () => {
      await withEnv({ GASLESS_FEE_MODE: 'fixed', GASLESS_FEE_PROFIT: '56:usdt:0.002' }, async () => {
        const svc = new FeePolicyService(makePricing() as never);
        const out = await svc.fixedSettlementAmount(56, USDT, 'USDT', 6, new BigNumber('500000'));
        expect(out!.toFixed()).toBe('502000');
      });
    });

    it('fixed mode: zero profit when nothing configured for the token', async () => {
      await withEnv({ GASLESS_FEE_MODE: 'fixed', GASLESS_FEE_PROFIT: undefined }, async () => {
        const svc = new FeePolicyService(makePricing() as never);
        const out = await svc.fixedSettlementAmount(56, USDT, 'USDT', 6, new BigNumber('500000'));
        expect(out!.toFixed()).toBe('500000');
      });
    });

    it('throws on a malformed GASLESS_FEE_PROFIT entry', async () => {
      await withEnv({ GASLESS_FEE_PROFIT: '56:USDT' }, () => {
        expect(() => new FeePolicyService(makePricing() as never)).toThrow(/GASLESS_FEE_PROFIT/);
      });
    });
  });

  describe('no-loss ceiling', () => {
    it('is a no-op when disabled (default)', async () => {
      await withEnv({ GASLESS_NO_LOSS_CHECK: undefined }, async () => {
        const svc = new FeePolicyService(makePricing() as never);
        await expect(svc.assertCoversNetworkCost(56, USDT, new BigNumber('1'), new BigNumber('1000'))).resolves.toBeUndefined();
      });
    });

    it('passes when the fee covers the ceiling (simulated + headroom)', async () => {
      await withEnv({ GASLESS_NO_LOSS_CHECK: 'true', GASLESS_PRIORITY_HEADROOM_BPS: '3000' }, async () => {
        const svc = new FeePolicyService(makePricing() as never);
        // ceiling = 1000 * 1.3 = 1300; fee 2000 ≥ 1300 → ok
        await expect(svc.assertCoversNetworkCost(56, USDT, new BigNumber('2000'), new BigNumber('1000'))).resolves.toBeUndefined();
      });
    });

    it('refuses when the fee is below the ceiling', async () => {
      await withEnv({ GASLESS_NO_LOSS_CHECK: 'true', GASLESS_PRIORITY_HEADROOM_BPS: '3000' }, async () => {
        const svc = new FeePolicyService(makePricing() as never);
        // ceiling = 1300; fee 1000 < 1300 → refuse
        await expect(svc.assertCoversNetworkCost(56, USDT, new BigNumber('1000'), new BigNumber('1000'))).rejects.toMatchObject({
          errorInfo: { code: ErrorCodes.GASLESS_FEE_BELOW_MAX_NETWORK_COST },
        });
      });
    });
  });

  describe('fiat (best-effort)', () => {
    it('returns feeUsd + estimatedNativeCostUsd when prices resolve', async () => {
      await withEnv({}, async () => {
        const svc = new FeePolicyService(makePricing() as never);
        const out = await svc.fiat(56, USDT, new BigNumber('1500000'), '0xeee', new BigNumber('2000000'));
        expect(out.feeUsd).toBe('1.5');
        expect(out.estimatedNativeCostUsd).toBe('2');
      });
    });

    it('omits fields when the price feed throws — never fails the estimate', async () => {
      await withEnv({}, async () => {
        const pricing = makePricing();
        pricing.toUsd.mockRejectedValue(new Error('no price'));
        const svc = new FeePolicyService(pricing as never);
        const out = await svc.fiat(56, USDT, new BigNumber('1500000'), '0xeee', new BigNumber('2000000'));
        expect(out.feeUsd).toBeUndefined();
        expect(out.estimatedNativeCostUsd).toBeUndefined();
      });
    });
  });
});
