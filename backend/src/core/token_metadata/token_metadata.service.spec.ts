import type { ConfigService } from '@nestjs/config';

import { TokenMetadataService } from './token_metadata.service';
import { NATIVE_TOKEN_SENTINEL } from '../chain_config/chain_config.service';
import { NetworkType } from '@getomnichain/omnichain';
import { REDIS_KEY_PREFIX } from '../../common/redis';

interface FakeCache {
  store: Map<string, unknown>;
  get: jest.Mock;
  set: jest.Mock;
}

function makeCache(seed: Record<string, unknown> = {}): FakeCache {
  const store = new Map<string, unknown>(Object.entries(seed));
  return {
    store,
    get: jest.fn((k: string) => Promise.resolve(store.get(k))),
    set: jest.fn((k: string, v: unknown) => { store.set(k, v); return Promise.resolve(); }),
  };
}

function makeService(opts: {
  chainConfig?: Partial<{ nativeDecimals: number; nativeSymbol: string; networkType: NetworkType }>;
  rpcDecimals?: bigint | number | Error | 'malformed';
  cache?: FakeCache;
}): { svc: TokenMetadataService; cache: FakeCache; withChain: jest.Mock } {
  const cfg = {
    networkType: NetworkType.EVM,
    nativeDecimals: 18,
    nativeSymbol: 'ETH',
    ...opts.chainConfig,
  };
  const chainConfig = { get: () => cfg } as never;
  const { AbiCoder } = require('ethers');
  const coder = AbiCoder.defaultAbiCoder();
  // Fake omnichain EvmChain: `call` returns the ABI-encoded ERC-20 read (or
  // throws to model a revert). Encoded as uint256 so an out-of-uint8 value
  // (999) surfaces as a decode error, mirroring an unreadable token.
  const chain = {
    call: async () => {
      if (opts.rpcDecimals instanceof Error) throw opts.rpcDecimals;
      if (opts.rpcDecimals === 'malformed') return { result: '0x' }; // undecodable
      return { result: coder.encode(['uint256'], [BigInt(opts.rpcDecimals ?? 18)]) };
    },
  };
  const withChain = jest.fn(async (_id: number, fn: (c: unknown) => Promise<unknown>) => fn(chain));
  const rpc = { withChain } as never;
  const cache = opts.cache ?? makeCache();

  const svc = new TokenMetadataService(chainConfig, rpc, cache as never, { get: () => undefined } as unknown as ConfigService);
  return { svc, cache, withChain };
}

describe('TokenMetadataService.getDecimals', () => {
  afterEach(() => jest.restoreAllMocks());

  it('short-circuits on native sentinel — returns chain nativeDecimals, no RPC call', async () => {
    const { svc, withChain } = makeService({ chainConfig: { nativeDecimals: 18 } });
    await expect(svc.getDecimals(42161, NATIVE_TOKEN_SENTINEL)).resolves.toBe(18);
    expect(withChain).not.toHaveBeenCalled();
  });

  it('cache hit — returns cached value, no RPC call', async () => {
    const cache = makeCache({ [`${REDIS_KEY_PREFIX}token:decimals:42161:0xabcdef`]: 6 });
    const { svc, withChain } = makeService({ cache });
    await expect(svc.getDecimals(42161, '0xABCDEF')).resolves.toBe(6);
    expect(withChain).not.toHaveBeenCalled();
  });

  it('cache miss — RPC call, writes cache, returns value', async () => {
    const { svc, cache, withChain } = makeService({ rpcDecimals: 6 });
    await expect(svc.getDecimals(42161, '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9')).resolves.toBe(6);
    expect(withChain).toHaveBeenCalledTimes(1);
    expect(cache.set).toHaveBeenCalledWith(
      `${REDIS_KEY_PREFIX}token:decimals:42161:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9`,
      6,
      expect.any(Number),
    );
  });

  it('cache miss + revert → throws FeeTokenUnreadable (40010)', async () => {
    const { svc } = makeService({ rpcDecimals: new Error('call reverted') });
    await expect(svc.getDecimals(42161, '0x1111111111111111111111111111111111111111'))
      .rejects.toMatchObject({ errorInfo: expect.objectContaining({ code: 40010 }) });
  });

  it('rejects an unparsable/empty decimals response as FeeTokenUnreadable', async () => {
    const { svc } = makeService({ rpcDecimals: 'malformed' });
    await expect(svc.getDecimals(42161, '0x1111111111111111111111111111111111111111'))
      .rejects.toMatchObject({ errorInfo: expect.objectContaining({ code: 40010 }) });
  });

});
