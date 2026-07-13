import BigNumber from 'bignumber.js';

import { FeeEstimatorService } from './fee_estimator.service';
import { FeePolicyService } from '../../../core/pricing';
import { NATIVE_TOKEN_SENTINEL } from '../../../core/chain_config/chain_config.service';
import { NetworkType } from '../../../common/utils/network_type';

interface QuoteCall {
  from: { chainName: string; address: string | null; symbol: string; decimals: number };
  to: { chainName: string; address: string | null; symbol: string; decimals: number };
  amount: string;
}

const MAIN_FEE_TOKEN = '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9';
const OTHER_ACCEPTED = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const ARBITRARY_ERC20 = '0x912ce59144191c1204e64559fe8253a0e49e6548';

function makeEstimator(opts: {
  quoteReturns?: BigNumber[];
  onQuote?: (calls: QuoteCall[]) => void;
}) {
  const cfg = {
    chainId: 42161,
    rangoChainName: 'ARBITRUM',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    networkType: NetworkType.EVM,
    acceptedFeeTokenAddresses: [MAIN_FEE_TOKEN, OTHER_ACCEPTED],
    mainFeeTokenAddress: MAIN_FEE_TOKEN,
  } as never;
  const chainConfig = { get: () => cfg } as never;

  const withFallback = jest.fn(async (_id: number, fn: (p: unknown) => Promise<unknown>) => {
    const provider = {
      getFeeData: async () => ({ maxFeePerGas: 20_000_000n, gasPrice: 20_000_000n }),
      estimateGas: async () => 100_000n,
    };
    return fn(provider as never);
  });
  const rpc = { withFallback } as never;

  const quoteCalls: QuoteCall[] = [];
  let quoteIndex = 0;
  const defaultQuotes = opts.quoteReturns ?? [new BigNumber('5000'), new BigNumber('1000000000000000000')];
  const rango = {
    quote: jest.fn(async (req: QuoteCall) => {
      quoteCalls.push(req);
      const out = defaultQuotes[quoteIndex] ?? new BigNumber('1000');
      quoteIndex++;
      opts.onQuote?.(quoteCalls);
      return { outputAmount: out, outputAmountMin: out, requestId: 'x', raw: {} };
    }),
  } as never;

  const tokenMetadata = {
    getDecimals: jest.fn(async (_c: number, addr: string) => (addr === MAIN_FEE_TOKEN || addr === OTHER_ACCEPTED ? 6 : 18)),
    getSymbolBestEffort: jest.fn(async () => '?'),
  };

  // Default env → bps mode, no-loss off: FeePolicyService never sizes via the
  // price feed and its fiat calls swallow the stub's rejection.
  const pricingStub = {
    nativeToFeeToken: jest.fn(async () => { throw new Error('no price in bps test'); }),
    toUsd: jest.fn(async () => { throw new Error('no price in bps test'); }),
  } as never;
  const feePolicy = new FeePolicyService(pricingStub);
  const svc = new FeeEstimatorService(chainConfig, rpc, rango, tokenMetadata as never, feePolicy);
  return { svc, rango, tokenMetadata, quoteCalls };
}

describe('FeeEstimatorService — three fee paths', () => {
  const OPS = [{ chainId: 42161, to: '0x0000000000000000000000000000000000000001', value: '0', data: '0x' }];

  it('accepted ERC-20 fee token → direct path (single forward quote, no swap route)', async () => {
    const { svc, quoteCalls } = makeEstimator({ quoteReturns: [new BigNumber('5000')] });
    const result = await svc.estimate(42161, '0xuser', MAIN_FEE_TOKEN, OPS);
    expect(result.acceptedFeeToken).toBe(true);
    expect(result.swapRoute).toBeUndefined();
    expect(result.acceptedFeeTokenAddress).toBe(MAIN_FEE_TOKEN);
    expect(result.isNativeFeeToken).toBe(false);
    expect(result.feeAmountInFeeToken.toString()).toBe('5000');
    expect(quoteCalls).toHaveLength(1);
    expect(quoteCalls[0].from.address).toBeNull();
    expect(quoteCalls[0].to.address).toBe(MAIN_FEE_TOKEN);
  });

  it('native sentinel → swap path (inverse quote from mainFeeToken → native)', async () => {
    const { svc, quoteCalls } = makeEstimator({
      quoteReturns: [new BigNumber('5000'), new BigNumber('1000000000000000')],
    });
    const result = await svc.estimate(42161, '0xuser', NATIVE_TOKEN_SENTINEL, OPS);
    expect(result.acceptedFeeToken).toBe(false);
    expect(result.isNativeFeeToken).toBe(true);
    expect(result.swapRoute?.inputToken).toBe(NATIVE_TOKEN_SENTINEL);
    expect(result.swapRoute?.outputToken).toBe(MAIN_FEE_TOKEN);
    expect(quoteCalls).toHaveLength(2);
    // Forward quote: native → mainFeeToken
    expect(quoteCalls[0].from.address).toBeNull();
    expect(quoteCalls[0].to.address).toBe(MAIN_FEE_TOKEN);
    // Inverse quote: mainFeeToken → native
    expect(quoteCalls[1].from.address).toBe(MAIN_FEE_TOKEN);
    expect(quoteCalls[1].to.address).toBeNull();
  });

  it('arbitrary ERC-20 → swap path (decimals fetched via TokenMetadata, inverse quote to that token)', async () => {
    const { svc, quoteCalls, tokenMetadata } = makeEstimator({
      quoteReturns: [new BigNumber('5000'), new BigNumber('100000000000000000000')],
    });
    const result = await svc.estimate(42161, '0xuser', ARBITRARY_ERC20, OPS);
    expect(result.acceptedFeeToken).toBe(false);
    expect(result.isNativeFeeToken).toBe(false);
    expect(result.swapRoute?.inputToken).toBe(ARBITRARY_ERC20);
    expect(result.swapRoute?.outputToken).toBe(MAIN_FEE_TOKEN);
    expect(tokenMetadata.getDecimals).toHaveBeenCalledWith(42161, ARBITRARY_ERC20);
    // Inverse quote: mainFeeToken → arbitrary ERC-20
    expect(quoteCalls[1].from.address).toBe(MAIN_FEE_TOKEN);
    expect(quoteCalls[1].to.address).toBe(ARBITRARY_ERC20);
  });
});
