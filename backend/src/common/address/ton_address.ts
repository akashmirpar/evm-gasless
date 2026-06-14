import { NetworkType } from '../utils/network_type';
import { Address } from './address';

const TON_USER_FRIENDLY_REGEX = /^[A-Za-z0-9_-]{48}$/;
const TON_RAW_REGEX = /^-?\d+:[a-fA-F0-9]{64}$/;
const USER_FRIENDLY_BYTE_LENGTH = 36;
const CRC_POLYNOMIAL = 0x1021;

export class TonAddress extends Address {
  constructor(raw: string) {
    super(raw);
    TonAddress.assertValid(raw);
  }

  canonical(): string {
    return this.raw;
  }

  get networkType(): NetworkType {
    return NetworkType.TON;
  }

  private static assertValid(raw: string): void {
    if (typeof raw !== 'string') {
      throw new Error('Invalid TON address: not a string');
    }
    if (TON_RAW_REGEX.test(raw)) return;
    if (TON_USER_FRIENDLY_REGEX.test(raw)) {
      TonAddress.assertUserFriendlyChecksum(raw);
      return;
    }
    throw new Error(`Invalid TON address: "${raw}"`);
  }

  private static assertUserFriendlyChecksum(userFriendly: string): void {
    const bytes = Buffer.from(
      userFriendly.replace(/-/g, '+').replace(/_/g, '/'),
      'base64',
    );
    if (bytes.length !== USER_FRIENDLY_BYTE_LENGTH) {
      throw new Error(`Invalid TON address: "${userFriendly}"`);
    }
    const claimedCrc = (bytes[34] << 8) | bytes[35];
    const computedCrc = crc16CcittXmodem(bytes.subarray(0, 34));
    if (claimedCrc !== computedCrc) {
      throw new Error(`Invalid TON address checksum: "${userFriendly}"`);
    }
  }
}

function crc16CcittXmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ CRC_POLYNOMIAL) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}
