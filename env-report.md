# Env Variable Usage Report

Audit of `backend/.env.example` against the **backend application codebase** (`backend/src`, `backend/test`, `backend/scripts`). Docker-compose files were intentionally excluded per request.

**Method:** env vars are read directly via `process.env` (there is no `@nestjs/config` layer), including dynamic lookups such as `process.env[c.envRpcVar]` and `process.env[timeOverrideEnvKey(name)]`. Every declared key was matched against literal and dynamic references. Two dotenv loaders exist (`src/main.ts`, `src/core/database/data-source.ts`) and load the same `.env`.

Scope note: `contract/.env.example` and `code-review/.env.example` belong to separate sub-projects (Foundry deploy scripts / Python tooling) and were not part of this backend audit.

---

## Variables NOT used in the codebase

### 1. Declared but never read (dead entries)

These appear in `backend/.env.example` but have **no reference anywhere** in `src`, `test`, or `scripts` — not as literals nor via any constructed/dynamic key:

| Variable | Notes |
|----------|-------|
| `SOLANA_JITO_BUNDLE_MAX_WAIT_SECONDS` | Documented as Jito bundle inclusion poll timeout, but no code reads it. |
| `SOLANA_JITO_FALLBACK_TO_G1` | Documented G2→G1 fallback toggle; no code reads it. |
| `SOLANA_SOL_USD_PRICE` | Documented fallback SOL price; no code reads it. |
| `SOLANA_FEE_TOKEN_USD_PRICE` | Documented fallback fee-token price; no code reads it. |
| `RELAYER_RETRY_CAP_MS` | Sibling `RELAYER_RETRY_BASE_MS` and `RELAYER_MAX_RETRIES` are read, but the cap is not. |

### 2. Used only by Docker Compose, not the codebase

Declared in `.env.example` and consumed only in compose files. The `.env.example` itself annotates these as `docker-compose.dev.yml only`:

| Variable | Notes |
|----------|-------|
| `DEV_NAME` | Per-developer container/volume/network suffix. |
| `POSTGRES_IMAGE` | Optional image pin for the Postgres service. |
| `REDIS_IMAGE` | Optional image pin for the Redis service. |

---

## Verified as USED (including non-obvious cases)

Called out because they could look unused on a naive literal grep:

- `BSC_RPC_URLS`, `BASE_RPC_URLS`, `ARBITRUM_RPC_URLS` — read dynamically at `src/core/chain_config/chain_config.service.ts:66` via `process.env[c.envRpcVar]`, where `envRpcVar` comes from `chains/chains.json`. **Used.**
- `SOLANA_RPC_URLS`, `SOLANA_DEVNET_RPC_URLS` — same dynamic path via `chains.json`. **Used.**
- `RELAYER_CRON`, `RELAYER_SOLANA_CRON` — read via `timeOverrideEnvKey(name)` in `src/core/scheduler/scheduler.service.ts`. **Used.**
- `E2E_TREASURY_ADDRESS` — read in `test/e2e/helpers.ts:63`. **Used** (test-only).
- All other keys (DB, Redis, operator wallets, Solana priority/mode/broadcast tuning, fee policy, Rango, remaining E2E vars) resolve to direct `process.env.X` reads.

---

## Bonus: used in code but NOT declared in `.env.example`

The reverse-direction gaps (referenced by code, absent from `.env.example`) — worth documenting so operators know they exist:

| Variable | Where |
|----------|-------|
| `SOLANA_G2_ENABLED` | Legacy fallback alias for `SOLANA_BUNDLED_MODE_ENABLED` (mentioned in a comment but not declared as a key). |
| `GASLESS_TOKEN_METADATA_TTL_SECONDS` | `token_metadata.service.ts`. |
| `RANGO_HTTP_TIMEOUT_MS` | `rango_http.client.ts`. |
| `REDIS_USERNAME` | `redis` connection (ACL users). |
| `SOLANA_ATA_CREATE_DISCRIMINATORS` | Solana batch/prefund logic. |
| `SOLANA_RPC_PER_URL_RETRIES`, `SOLANA_RPC_PER_URL_RETRY_DELAY_MS` | `solana_rpc.service.ts`. |
| `E2E_DELEGATE_CONTRACT_ADDRESS`, `E2E_RPC_URL_42161` | E2E test helpers. |
