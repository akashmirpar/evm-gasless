import { Transform } from 'class-transformer';
import { ValidationArguments, ValidationOptions, registerDecorator } from 'class-validator';

import { ChainErrorKinds, canonicalizeAddress, isChainError, tryCanonicalizeAddress } from '@getomnichain/omnichain';

import { NATIVE_TOKEN_SENTINEL, isNativeSentinel } from './native_token';

export { NATIVE_TOKEN_SENTINEL, isNativeSentinel };

const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Well-formedness floor (20-byte hex) used when the chain can't be resolved
 * (unsupported chainId), so an unroutable id defers to the service without
 * disabling address validation. */
function isWellFormedAddress(value: string): boolean {
  return EVM_ADDRESS_RE.test(value);
}

/**
 * The published `@getomnichain/omnichain` `AddressField` has no native-token
 * branch — it runs the sentinel straight through EIP-55 checksum validation,
 * rejecting a mixed-case sentinel. gasless's native-fee path accepts the
 * sentinel, so this decorator restores the case-insensitive short-circuit and
 * delegates real addresses to the package's canonicalize/validation.
 */
function IsAddress(chainIdProperty: string, options?: ValidationOptions) {
  return (object: object, propertyName: string): void => {
    registerDecorator({
      name: 'isAddress',
      target: object.constructor,
      propertyName,
      options,
      constraints: [chainIdProperty],
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          if (typeof value !== 'string') return false;
          if (isNativeSentinel(value)) return true;
          const chainId = (args.object as Record<string, unknown>)[chainIdProperty];
          if (typeof chainId !== 'number') return false;
          try {
            canonicalizeAddress(chainId, value);
            return true;
          } catch (err) {
            // A retired/unsupported chainId (e.g. -100) must surface as the
            // service's CHAIN_NOT_SUPPORTED, not a misleading "invalid address".
            // But we must NOT turn the field into a validation off-switch: still
            // require the value to be a well-formed address so a
            // malformed `to`/address can't ride through on an unroutable chainId.
            if (isChainError(err, ChainErrorKinds.ChainNotSupported)) return isWellFormedAddress(value);
            return false;
          }
        },
        defaultMessage(): string {
          return `$property is not a valid address for the given ${chainIdProperty}`;
        },
      },
    });
  };
}

/**
 * Validates + canonicalizes an address field against a sibling chainId property.
 * Native sentinel (any casing) → canonical lowercase sentinel; otherwise the
 * package's canonicalization (checksum-lowercased). A retired/unknown chainId
 * is left for the service to reject.
 */
export function AddressField(chainIdProperty: string): PropertyDecorator {
  const transform = Transform(({ obj, value }) => {
    if (typeof value !== 'string') return value;
    if (isNativeSentinel(value)) return NATIVE_TOKEN_SENTINEL;
    const chainId = (obj as Record<string, unknown>)[chainIdProperty];
    if (typeof chainId !== 'number') return value;
    return tryCanonicalizeAddress(chainId, value);
  });
  const validate = IsAddress(chainIdProperty);
  return (target, propertyKey) => {
    transform(target, propertyKey);
    validate(target, propertyKey as string);
  };
}
