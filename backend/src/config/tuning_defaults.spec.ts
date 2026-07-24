import { readFileSync } from 'fs';
import { load as parseYaml } from 'js-yaml';
import { resolve } from 'path';

/**
 * Pins the tuning knobs whose values were measured rather than guessed. The
 * RIN-135 config move silently reverted SOLANA_DYNAMIC_PRIORITY_PERCENTILE from
 * the tuned 90 back to 75 (~25% of the priority-fee auction lost) and widened
 * the Solana fee-token whitelist from seven entries to "everything", and no test
 * failed. Changing any value here should be a deliberate edit with a reason.
 */

const CONFIG_YAML = resolve(__dirname, '..', '..', 'config.yaml');

const EXPECTED: Record<string, string> = {
  // Solana priority-fee auction — see the dated rationale in config.yaml.
  'solana.dynamicPriorityEnabled': 'true',
  'solana.dynamicPriorityPercentile': '90',
  'solana.defaultPriorityMicrolamportsPerCu': '500000',
  'solana.maxPriorityMicrolamportsPerCu': '2000000',
  'solana.minFeeLamports': '666666',
  // Raised after a swap-fee bundle was repeatedly not included at 5000.
  'solana.jito.tipLamports': '200000',
  'solana.bundledModeEnabled': 'true',
  'solana.modeDefault': 'single',
  // Fee sizing.
  'gasless.feeMode': 'bps',
  'gasless.baseFeeMarkupPercent': '15',
  'gasless.priorityHeadroomBps': '3000',
  'gasless.noLossCheck': 'false',
  'gasless.exposeErrorCauses': 'false',
  'gasless.prefundSizing': 'simulate',
  'gasless.maxPrefundLamports': '50000000',
  'gasless.priceMaxAgeSeconds': '900',
  'gasless.rangoSlippage': '5.0',
  'gasless.createTtlSeconds': '90',
  'gasless.defaultGasUnits': '1500000',
  'gasless.txGasLimit': '2000000',
  // Deliberate whitelist: empty would make every registry SPL an accepted fee token.
  'gasless.acceptedFeeTokens': '56:USDT,8453:USDT,42161:USDT,-100:USDC,-100:xTSLA,-100:xNVDA,-100:xAAPL',
};

function at(obj: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, part) => {
    if (acc && typeof acc === 'object') return (acc as Record<string, unknown>)[part];
    return undefined;
  }, obj);
}

describe('config.yaml tuning defaults', () => {
  const yaml = parseYaml(readFileSync(CONFIG_YAML, 'utf8')) as Record<string, unknown>;

  it.each(Object.entries(EXPECTED))('%s is %s', (path, expected) => {
    expect(String(at(yaml, path))).toBe(expected);
  });

  it('every pinned path exists in the file', () => {
    const missing = Object.keys(EXPECTED).filter((path) => at(yaml, path) === undefined);
    expect(missing).toEqual([]);
  });
});
