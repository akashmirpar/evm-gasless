import { Transform } from 'class-transformer';

import { canonicalizeAddress } from './address.factory';
import { EvmAddress, NATIVE_TOKEN_SENTINEL } from './evm_address';
import { IsAddress } from './is_address.decorator';

export function AddressField(chainIdProperty: string): PropertyDecorator {
  const transform = Transform(({ obj, value }) => {
    if (typeof value !== 'string') return value;
    if (EvmAddress.isNative(value)) return NATIVE_TOKEN_SENTINEL;
    const chainId = (obj as Record<string, unknown>)[chainIdProperty];
    if (typeof chainId !== 'number') return value;
    try {
      return canonicalizeAddress(chainId, value);
    } catch {
      return value;
    }
  });
  const validate = IsAddress(chainIdProperty);
  return (target, propertyKey) => {
    transform(target, propertyKey);
    validate(target, propertyKey as string);
  };
}
