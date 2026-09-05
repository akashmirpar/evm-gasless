import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { ConfigService } from '@nestjs/config';

import { loadChainsConfig } from '../../config/yaml_reader';
import { PlutonHttpException } from '../../common/errors/pluton_exception';
import { ChainConfigService } from './chain_config.service';

jest.mock('../../config/yaml_reader', () => ({ loadChainsConfig: jest.fn() }));
const mockedLoadChains = loadChainsConfig as jest.MockedFunction<typeof loadChainsConfig>;

function config(map: Record<string, string>): ConfigService {
  return { get: (k: string) => map[k] } as unknown as ConfigService;
}

const evmChain = (over: Record<string, unknown> = {}) => ({
  chainId: 56,
  name: 'bsc',
  displayName: 'BNB Smart Chain',
  nativeSymbol: 'BNB',
  nativeDecimals: 18,
  rangoChainName: 'BSC',
  rpcUrls: ['https://bsc-rpc.publicnode.com'],
  acceptedFeeTokens: ['0x55d398326f99059ff775485246999027b3197955'],
  mainFeeToken: '0x55d398326f99059ff775485246999027b3197955',
  ...over,
});

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const XTSLA = 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB';
const solanaChain = (over: Record<string, unknown> = {}) => ({
  chainId: -2000,
  name: 'solana',
  displayName: 'Solana',
  nativeSymbol: 'SOL',
  nativeDecimals: 9,
  networkType: 'SOLANA',
  rangoChainName: 'SOLANA',
  rpcUrls: ['https://api.mainnet-beta.solana.com'],
  tokens: {
    USDC: { address: USDC, decimals: 6 },
    xTSLA: { address: XTSLA, decimals: 8 },
  },
  ...over,
});

describe('ChainConfigService.load()', () => {
  afterEach(() => mockedLoadChains.mockReset());

  it('throws when config.yaml declares no chains', () => {
    mockedLoadChains.mockReturnValue([]);
    const svc = new ChainConfigService(config({ DEPLOYED_JSON_PATH: '/nonexistent.json' }));
    expect(() => svc.load()).toThrow(/no chains defined/);
  });

  it('throws when a chain has no usable rpcUrls', () => {
    mockedLoadChains.mockReturnValue([evmChain({ rpcUrls: [] })]);
    const svc = new ChainConfigService(config({ DEPLOYED_JSON_PATH: '/nonexistent.json' }));
    expect(() => svc.load()).toThrow(/has no rpcUrls/);
  });

  it('loads an EVM chain and merges its delegate address from deployed.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gasless-deployed-'));
    const deployedPath = join(dir, 'deployed.json');
    writeFileSync(deployedPath, JSON.stringify({ '56': '0xFE4dDd66Edc6005741AF12Cd180fD6Dd90BeB981' }));
    mockedLoadChains.mockReturnValue([evmChain()]);

    const svc = new ChainConfigService(config({ DEPLOYED_JSON_PATH: deployedPath, GASLESS_TREASURY_ADDRESS: '0xtreasury' }));
    svc.load();

    const bsc = svc.get(56);
    expect(bsc.name).toBe('bsc');
    expect(bsc.rpcUrls).toEqual(['https://bsc-rpc.publicnode.com']);
    expect(bsc.delegateContractAddress).toBe('0xfe4ddd66edc6005741af12cd180fd6dd90beb981'); // lowercased
    expect(svc.requireDelegateAddress(56)).toBe('0xfe4ddd66edc6005741af12cd180fd6dd90beb981');
  });

  it('leaves delegateContractAddress null when deployed.json lacks the chain', () => {
    mockedLoadChains.mockReturnValue([evmChain()]);
    const svc = new ChainConfigService(config({ DEPLOYED_JSON_PATH: '/nonexistent.json', GASLESS_TREASURY_ADDRESS: '0xtreasury' }));
    svc.load();
    expect(svc.get(56).delegateContractAddress).toBeNull();
  });

  // Untouched, a quoted chainId keys the registry by the string '56', so every
  // get(56) misses and the chain answers 20001 for all traffic while boot looks
  // healthy. Coercion makes the documented "quote every scalar" style safe here.
  it('coerces a quoted chainId so the registry stays keyed numerically', () => {
    mockedLoadChains.mockReturnValue([evmChain({ chainId: '56' })]);
    const svc = new ChainConfigService(config({ DEPLOYED_JSON_PATH: '/nonexistent.json', GASLESS_TREASURY_ADDRESS: '0xtreasury' }));
    svc.load();
    expect(svc.get(56).chainId).toBe(56);
    expect(svc.getOrNull(56)).not.toBeNull();
  });

  it('coerces a quoted nativeDecimals to a number', () => {
    mockedLoadChains.mockReturnValue([evmChain({ nativeDecimals: '18' })]);
    const svc = new ChainConfigService(config({ DEPLOYED_JSON_PATH: '/nonexistent.json', GASLESS_TREASURY_ADDRESS: '0xtreasury' }));
    svc.load();
    expect(svc.get(56).nativeDecimals).toBe(18);
  });

  it('throws on a chainId that is not a number at all', () => {
    mockedLoadChains.mockReturnValue([evmChain({ chainId: 'bsc-mainnet' })]);
    const svc = new ChainConfigService(config({ DEPLOYED_JSON_PATH: '/nonexistent.json', GASLESS_TREASURY_ADDRESS: '0xtreasury' }));
    expect(() => svc.load()).toThrow(/chainId must be an unquoted integer/);
  });

  it('throws on a negative nativeDecimals', () => {
    mockedLoadChains.mockReturnValue([evmChain({ nativeDecimals: -1 })]);
    const svc = new ChainConfigService(config({ DEPLOYED_JSON_PATH: '/nonexistent.json', GASLESS_TREASURY_ADDRESS: '0xtreasury' }));
    expect(() => svc.load()).toThrow(/nativeDecimals must be an unquoted non-negative integer/);
  });

  it('rejects two chains claiming the same chainId', () => {
    mockedLoadChains.mockReturnValue([evmChain(), evmChain({ name: 'bsc-copy' })]);
    const svc = new ChainConfigService(config({ DEPLOYED_JSON_PATH: '/nonexistent.json', GASLESS_TREASURY_ADDRESS: '0xtreasury' }));
    expect(() => svc.load()).toThrow(/duplicate chainId 56/);
  });

  describe('Solana accepted-fee-token join (GASLESS_ACCEPTED_FEE_TOKENS)', () => {
    const loadSolana = (acceptedEnv: string) => {
      mockedLoadChains.mockReturnValue([solanaChain()]);
      const svc = new ChainConfigService(
        config({
          DEPLOYED_JSON_PATH: '/nonexistent.json',
          GASLESS_SOLANA_TREASURY_ADDRESS: XTSLA,
          GASLESS_ACCEPTED_FEE_TOKENS: acceptedEnv,
        }),
      );
      svc.load();
      return svc.get(-2000).acceptedFeeTokenAddresses;
    };

    it('joins by <chainId>:<symbol> (case-insensitive)', () => {
      expect(loadSolana('-2000:usdc')).toEqual([USDC]);
    });

    it('joins by <chainId>:<address>', () => {
      expect(loadSolana(`-2000:${USDC}`)).toEqual([USDC]);
    });

    it('joins by bare <address>', () => {
      expect(loadSolana(USDC)).toEqual([USDC]);
    });

    it('widens to ALL registry SPLs when the env matches nothing on this chain', () => {
      // A prefix-less bogus address touches no chain, so it does not trip the
      // fail-closed stale-prefix guard; the join just widens with a warn.
      expect(loadSolana('SoBogusMintThatMatchesNothing1111111111111').sort()).toEqual([USDC, XTSLA].sort());
    });

    it('fails CLOSED when the env names a chainId absent from the registry (stale -100)', () => {
      mockedLoadChains.mockReturnValue([solanaChain()]);
      const svc = new ChainConfigService(
        config({
          DEPLOYED_JSON_PATH: '/nonexistent.json',
          GASLESS_SOLANA_TREASURY_ADDRESS: XTSLA,
          GASLESS_ACCEPTED_FEE_TOKENS: '-100:usdc',
        }),
      );
      expect(() => svc.load()).toThrow(/chainId -100 which is not in the registry/);
    });
  });

  it('a request on a retired chainId (-100) surfaces as CHAIN_NOT_SUPPORTED (20001, HTTP 400)', () => {
    // The DTO now lets a well-formed address on -100 through so the SERVICE — not
    // a misleading "invalid address" 400 — is what rejects the retired chain.
    mockedLoadChains.mockReturnValue([evmChain()]);
    const svc = new ChainConfigService(config({ DEPLOYED_JSON_PATH: '/nonexistent.json', GASLESS_TREASURY_ADDRESS: '0xtreasury' }));
    svc.load();
    expect(svc.getOrNull(-100)).toBeNull();
    try {
      svc.get(-100);
      throw new Error('expected get(-100) to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(PlutonHttpException);
      expect((err as PlutonHttpException).errorInfo.code).toBe(20001);
      expect((err as PlutonHttpException).getStatus()).toBe(400);
    }
  });
});
