/**
 * Globally unique error codes. Adding a new domain reserves a 1xxx range.
 *
 * Ranges:
 *   2xxxx — chain config / RPC / on-chain
 *   3xxxx — rango client
 *   4xxxx — gasless flow (estimate, create, submit, status)
 *   5xxxx — relayer
 *   8xxxx — health
 *   9xxxx — system / framework
 */
export const ErrorCodes = {
  CHAIN_NOT_SUPPORTED: 20001,
  CHAIN_RPC_UNAVAILABLE: 20002,
  CHAIN_NO_DEPLOYED_CONTRACT: 20003,
  CHAIN_TOKEN_NOT_FOUND: 20004,
  CHAIN_GAS_ESTIMATION_FAILED: 20005,

  RANGO_REQUEST_FAILED: 30001,
  RANGO_NO_ROUTE: 30002,
  RANGO_INVALID_RESPONSE: 30003,

  GASLESS_INVALID_REQUEST: 40001,
  GASLESS_FEE_TOKEN_NOT_ACCEPTED_AND_NO_ROUTE: 40002,
  GASLESS_REQUEST_NOT_FOUND: 40003,
  GASLESS_REQUEST_EXPIRED: 40004,
  GASLESS_INVALID_SIGNATURE: 40005,
  GASLESS_INVALID_AUTHORIZATION: 40006,
  GASLESS_REQUEST_ALREADY_SUBMITTED: 40007,

  RELAYER_BROADCAST_FAILED: 50001,
  RELAYER_TX_NOT_MINED: 50002,
  RELAYER_TX_REVERTED: 50003,
  RELAYER_GAVE_UP: 50004,

  HEALTH_CHECK_FAILED: 80001,

  SYSTEM_VALIDATION_ERROR: 90001,
  SYSTEM_NOT_FOUND: 90002,
  SYSTEM_ILLEGAL_TRANSITION: 90003,
  SYSTEM_CONCURRENT_TRANSITION: 90004,
  SYSTEM_GENERAL: 90099,
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

(function validateCodes() {
  const seen = new Set<number>();
  for (const [name, code] of Object.entries(ErrorCodes)) {
    if (seen.has(code)) {
      throw new Error(`Duplicate error code ${code} (${name})`);
    }
    seen.add(code);
  }
})();
