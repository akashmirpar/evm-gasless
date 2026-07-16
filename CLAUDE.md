# pluton-gasless — working rules

## Review (non-negotiable)
Every feature branch MUST be reviewed with the project reviewer BEFORE pushing:

    cd code-review && python3 code_reviewer.py

(edit ISSUE_ID / SOURCE_BRANCH / TARGET_BRANCH constants at the top first). It fetches
the YouTrack card, snapshots the diff and conventions, and pipes prompt.md to `claude -p`,
writing `issue_<ID>_review.md`. Loop review → fix → re-review until the Critical section
is empty. Generic review agents do NOT replace this script.

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
