# evm-gasless — working rules

## Workflow
1. Implement on a feature branch off `main`; never push to `main` directly.
2. `cd backend && npx tsc --noEmit && npx jest` must be clean before a PR.
3. `cd contract && forge test` must be clean when the contract changes.
4. Open a PR against `main`.

## Code style
Self-documenting code, minimal comments: keep a comment only where removing it
would realistically cause a future bug (a load-bearing invariant). Rationale and
design belong in `docs/`, not in code. `.env.example` is the only file where
explanatory comment blocks are expected.
