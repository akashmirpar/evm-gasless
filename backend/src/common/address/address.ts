import { NetworkType } from '../utils/network_type';

export abstract class Address {
  protected constructor(protected readonly raw: string) {}

  abstract canonical(): string;
  abstract get networkType(): NetworkType;

  equals(other: Address): boolean {
    return this.networkType === other.networkType && this.canonical() === other.canonical();
  }

  toString(): string {
    return this.canonical();
  }
}
