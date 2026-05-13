import BigNumber from 'bignumber.js';
import type { ValueTransformer } from 'typeorm';

export const bigNumberTransformer: ValueTransformer = {
  to(value?: BigNumber | string | number | null): string | null {
    if (value === null || value === undefined) return null;
    if (value instanceof BigNumber) return value.toFixed();
    return new BigNumber(value as string | number).toFixed();
  },
  from(value?: string | null): BigNumber | null {
    if (value === null || value === undefined) return null;
    return new BigNumber(value);
  },
};
