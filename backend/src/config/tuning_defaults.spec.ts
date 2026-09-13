import { readFileSync } from 'fs';
import { load as parseYaml } from 'js-yaml';
import { resolve } from 'path';

/**
 * Pins the tuning knobs whose values were measured rather than guessed. The
 * RIN-135 config move silently reverted a tuned knob from
 * the tuned 90 back to 75 (~25% of the priority-fee auction lost) and widened
 * a fee-token whitelist from an explicit list to "everything", and no test
 * failed. Changing any value here should be a deliberate edit with a reason.
 */

const CONFIG_YAML = resolve(__dirname, '..', '..', 'config.yaml');

const EXPECTED: Record<string, string> = {
  // Fee sizing.
  'gasless.feeMode': 'bps',
  'gasless.baseFeeMarkupPercent': '15',
  'gasless.priorityHeadroomBps': '3000',
  'gasless.noLossCheck': 'false',
  'gasless.exposeErrorCauses': 'false',
  'gasless.priceMaxAgeSeconds': '900',
  'gasless.rangoSlippage': '5.0',
  'gasless.createTtlSeconds': '90',
  'gasless.defaultGasUnits': '1500000',
  'gasless.txGasLimit': '2000000',
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
