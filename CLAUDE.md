# pluton-gasless — working rules

## Review (non-negotiable)
Every feature branch MUST be reviewed with the project reviewer BEFORE pushing:

    python3 code-review/review.py --source <branch> --target main --card <slug>

Loop review → fix → re-review until the Critical section is empty (exit 0). The
artifacts (`diff_N.diff`, `review_N.md`) live in `code-review/cards/<slug>/` and are
part of the deliverable. Generic review agents do NOT replace this script.

## Workflow
1. Task card first: `code-review/cards/<slug>/description.md` in the `_TEMPLATE.md`
   format (every section filled), then post with `make_card.py post` (YouTrack).
2. Implement on a feature branch off `main`; never push to `main` directly.
3. Unit tests + live e2e (`--config test/jest-e2e.json`); gasless paths must be
   verified with a SOL-less user — a funded test wallet does not test gasless.
4. `review.py` loop (above).
5. Push, open PR. Commit as the user only — no Claude co-author trailers.

## Code style
Self-documenting code, minimal comments: keep a comment only where removing it
would realistically cause a future bug (a load-bearing invariant). Rationale and
design belong in `docs/`, not in code. `.env.example` is the only file where
explanatory comment blocks are expected.
