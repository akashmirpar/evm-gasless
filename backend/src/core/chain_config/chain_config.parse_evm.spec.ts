import { ChainConfigService } from './chain_config.service';

function callParseEvm(raw: unknown) {
  return (ChainConfigService as unknown as { parseEvmChain: (r: unknown, s: Set<string>) => unknown }).parseEvmChain(raw, new Set());
}

function chain(overrides: Partial<{ chainId: number; name: string; acceptedFeeTokens: string[]; mainFeeToken: string }>) {
  return {
    chainId: 42161,
    name: 'arbitrum',
    displayName: 'Arbitrum One',
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    rangoChainName: 'ARBITRUM',
    rpcUrls: [],
    acceptedFeeTokens: ['0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', '0xaf88d065e77c8cc2239327c5edb3a432268e5831'],
    mainFeeToken: '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
    ...overrides,
  };
}

describe('ChainConfigService.parseEvmChain (boot validation)', () => {
  it('accepts a valid EVM chain (mainFeeToken ∈ acceptedFeeTokens)', () => {
    const result = callParseEvm(chain({}) as never) as {
      acceptedFeeTokenAddresses: string[];
      mainFeeTokenAddress: string;
    };
    expect(result.acceptedFeeTokenAddresses).toHaveLength(2);
    expect(result.mainFeeTokenAddress).toBe('0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9');
  });

  it('rejects boot when acceptedFeeTokens is missing', () => {
    expect(() =>
      callParseEvm(chain({ acceptedFeeTokens: [] }) as never),
    ).toThrow(/missing "acceptedFeeTokens"/);
  });

  it('rejects boot when mainFeeToken is missing', () => {
    expect(() =>
      callParseEvm(chain({ mainFeeToken: '' }) as never),
    ).toThrow(/missing "mainFeeToken"/);
  });

  it('rejects boot when mainFeeToken is not in acceptedFeeTokens', () => {
    expect(() =>
      callParseEvm(
        chain({
          mainFeeToken: '0x1111111111111111111111111111111111111111',
        }) as never,
      ),
    ).toThrow(/is not in acceptedFeeTokens/);
  });

  it('normalizes addresses to lowercase', () => {
    const result = callParseEvm(
      chain({
        acceptedFeeTokens: ['0xFD086BC7CD5C481DCC9C85EBE478A1C0B69FCBB9'],
        mainFeeToken: '0xFD086BC7CD5C481DCC9C85EBE478A1C0B69FCBB9',
      }) as never,
    ) as { acceptedFeeTokenAddresses: string[]; mainFeeTokenAddress: string };
    expect(result.acceptedFeeTokenAddresses[0]).toBe('0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9');
    expect(result.mainFeeTokenAddress).toBe('0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9');
  });
});
