# Error codes

Every backend error is wrapped in `{ "success": false, "error": { "code", "message" } }`. Codes are stable numeric identifiers — clients should switch on `code`, not on `message` (which may be reworded).

Source of truth: [`backend/src/common/errors/codes.ts`](../backend/src/common/errors/codes.ts). The list below documents every code, when it fires, and how a client should typically handle it.

## Range allocation

| Range | Domain |
|-------|--------|
| `2xxxx` | Chain config / RPC / on-chain |
| `3xxxx` | Rango client |
| `4xxxx` | Gasless flow (estimate, create, submit, status) |
| `5xxxx` | Relayer |
| `8xxxx` | Health |
| `9xxxx` | System / framework |

A boot-time validator throws if two codes collide. Don't reuse numbers — pick the next free slot in the domain's range.

## Chain config / on-chain (2xxxx)

| Code | HTTP | Name | When it fires | Client action |
|------|------|------|----------------|----------------|
| `20001` | 400 | `CHAIN_NOT_SUPPORTED` | The `chainId` in the request isn't in `chains.json`. | Show "chain not supported" UI; the user must switch networks. |
| `20002` | 503 | `CHAIN_RPC_UNAVAILABLE` | All configured RPCs for a chain failed. | Transient infra issue. Retry with backoff; if persistent, the backend's RPC config is broken. |
| `20003` | 503 | `CHAIN_NO_DEPLOYED_CONTRACT` | The chain is supported but `GaslessDelegate` hasn't been deployed (no entry in `deployed.json` for this chainId). | Show "gasless not available on this chain yet". |
| `20004` | 400 | `CHAIN_TOKEN_NOT_FOUND` | The `feeTokenAddress` isn't in `chains.json`'s token list for this chain. The backend needs decimal metadata to quote correctly. | Prompt user to pick a different fee token (one your UI lists from the chain's known tokens). |
| `20005` | 500 | `CHAIN_GAS_ESTIMATION_FAILED` | RPC `eth_estimateGas` failed for all operator user ops. | Falls back internally to `GASLESS_DEFAULT_GAS_UNITS` — this code is rarely surfaced. If you see it, retry. |

## Rango (3xxxx)

| Code | HTTP | Name | When it fires | Client action |
|------|------|------|----------------|----------------|
| `30001` | 502 | `RANGO_REQUEST_FAILED` | HTTP call to Rango's `/basic/quote` or `/basic/swap` raised (timeout, 5xx, bad response). | Retry; if persistent, Rango may be down or the backend's `RANGO_API_KEY` is invalid. |
| `30002` | 422 | `RANGO_NO_ROUTE` | Rango replied but couldn't find a swap path between the input and output tokens. | Try a different fee token. |
| `30003` | 502 | `RANGO_INVALID_RESPONSE` | Rango replied but with an unexpected shape (e.g. `type !== 'EVM'`, missing `txTo`/`txData`). | Likely a protocol version drift between backend and Rango API. Open an issue. |

## Gasless flow (4xxxx)

| Code | HTTP | Name | When it fires | Client action |
|------|------|------|----------------|----------------|
| `40001` | 400 | `GASLESS_INVALID_REQUEST` | Generic catch-all for malformed gasless requests not caught by class-validator. | Check request shape against the API reference. |
| `40002` | 422 | `GASLESS_FEE_TOKEN_NOT_ACCEPTED_AND_NO_ROUTE` | The fee token isn't on the operator's accept-list AND no Rango route exists to convert it. | Prompt user to pick a different fee token. |
| `40003` | 404 | `GASLESS_REQUEST_NOT_FOUND` | `GET /:requestId` or `POST /:requestId/submit` for a `requestId` that doesn't exist in Postgres (or the submit-stash, depending on stage). | Check the id; show "request not found" — usually means the client lost track of state. |
| `40004` | 410 | `GASLESS_REQUEST_EXPIRED` | `POST /:requestId/submit` arrived after the Redis TTL elapsed. The prepared batch is gone. | Restart from `POST /gasless/transactions`. |
| `40005` | 400 | `GASLESS_INVALID_SIGNATURE` | The EIP-712 signature provided to `/submit` doesn't recover to `userAddress`. | Re-sign. Common causes: wrong domain (verifyingContract must be the user's EOA, not the delegate contract), tampered `operations`, wrong nonce. |
| `40006` | 400 | `GASLESS_INVALID_AUTHORIZATION` | The EIP-7702 authorization tuple's `address` or `chainId` doesn't match the prepared batch, or its `signature` is malformed. | Re-sign the authorization with the correct `delegateContractAddress` and `chainId`. |
| `40007` | 409 | `GASLESS_REQUEST_ALREADY_SUBMITTED` | `/submit` called twice for the same `requestId`. The first call already persisted a row. | Idempotent retry: just call `GET /:requestId` to read current status; don't resubmit. |

## Relayer (5xxxx)

Most of these are internal — they end up as `failureReason` text on the `transaction_request` row, not as HTTP responses. Clients usually only see them via the `failureReason` field in `GET /:requestId`.

| Code | Name | When it fires |
|------|------|----------------|
| `50001` | `RELAYER_BROADCAST_FAILED` | All RPCs rejected the type-4 tx. Retried with backoff; eventually escalates to `FAILED_PERMANENT`. |
| `50002` | `RELAYER_TX_NOT_MINED` | Receipt poll timed out. The relayer re-checks on the next tick; rarely surfaces as a hard error. |
| `50003` | `RELAYER_TX_REVERTED` | Receipt arrived with `status === 0`. The status row goes to `MINED_FAILED`. |
| `50004` | `RELAYER_GAVE_UP` | Retry budget exhausted before reaching a terminal on-chain state. Row transitions to `FAILED_PERMANENT`. Manual operator action required. |

## Health (8xxxx)

| Code | HTTP | Name | When it fires |
|------|------|------|----------------|
| `80001` | 503 | `HEALTH_CHECK_FAILED` | `/health` failed to ping Postgres. Should never reach a client through the normal API. |

## System (9xxxx)

These are framework-level errors. Usually wrap a thrown exception in a generic shape so the client doesn't see a stack trace.

| Code | HTTP | Name | When it fires |
|------|------|------|----------------|
| `90001` | 400 | `SYSTEM_VALIDATION_ERROR` | Class-validator rejected the request body. The response's `causes` array contains per-field messages. |
| `90002` | 404 | `SYSTEM_NOT_FOUND` | A generic not-found from a `findOneByOrFail` somewhere. |
| `90003` | 409 | `SYSTEM_ILLEGAL_TRANSITION` | FSM was asked for a transition that has no entry for the current `(status, action)` pair. Internal bug; if a client sees this, file an issue. |
| `90004` | 409 | `SYSTEM_CONCURRENT_TRANSITION` | FSM's conditional UPDATE matched zero rows — someone else won the race. Self-recovers; rare to surface to clients. |
| `90099` | 500 | `SYSTEM_GENERAL` | Catch-all wrapping any uncaught error. |

## Client-side retry vs. abort

Quick rule of thumb for typical client code:

| If you see | Retry? |
|------------|--------|
| `4xx` from chain config (`20001`, `20003`, `20004`) | No — user must change inputs. |
| `5xx` from chain RPC (`20002`) | Yes, with backoff. |
| `5xx` from Rango (`30001`) | Yes, a few times. |
| `4xx` from Rango (`30002`) | No — different fee token. |
| `40004` request expired | Restart from `/transactions`. |
| `40005`/`40006` invalid signature/auth | No — fix the signing code, then retry. |
| `40007` already submitted | Don't resubmit; poll status. |
| `90099` general | Yes once; then surface. |
