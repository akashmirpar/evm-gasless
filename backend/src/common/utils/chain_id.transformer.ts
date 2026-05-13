import type { ValueTransformer } from 'typeorm';

export const chainIdTransformer: ValueTransformer = {
  to(value: number | null | undefined): string | null | undefined {
    if (value === null || value === undefined) return value;
    return String(value);
  },
  from(value: string | null | undefined): number | null | undefined {
    if (value === null || value === undefined) return value;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw new Error(`chainId ${value} exceeds JS safe-integer range`);
    }
    return parsed;
  },
};
