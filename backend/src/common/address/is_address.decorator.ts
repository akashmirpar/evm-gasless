import { registerDecorator, ValidationArguments, ValidationOptions } from 'class-validator';

import { addressFor } from './address.factory';
import { EvmAddress } from './evm_address';

export function IsAddress(chainIdProperty: string, options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isAddress',
      target: object.constructor,
      propertyName,
      constraints: [chainIdProperty],
      options,
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          if (typeof value !== 'string') return false;
          const [chainIdProp] = args.constraints as [string];
          const chainId = (args.object as Record<string, unknown>)[chainIdProp];
          if (typeof chainId !== 'number') return false;
          if (EvmAddress.isNative(value)) return true;
          try {
            addressFor(chainId, value);
            return true;
          } catch {
            return false;
          }
        },
        defaultMessage(args: ValidationArguments): string {
          const [chainIdProp] = args.constraints as [string];
          return `${args.property} must be a valid address for chain identified by '${chainIdProp}'`;
        },
      },
    });
  };
}
