# Contributing to `ourdao-backend`

Thanks for your interest in contributing. This repo is the off-chain indexer and read API for OurDAO — it mirrors on-chain state into Postgres and serves queryable history the Soroban contract itself can't provide.

Please read this in full before opening a pull request.

## Table of contents

- [Before you write code](#before-you-write-code)
- [Local setup](#local-setup)
- [Running the checks CI runs](#running-the-checks-ci-runs)
- [What a good pull request looks like](#what-a-good-pull-request-looks-like)
- [Backend-specific rules](#backend-specific-rules)
- [What gets closed without review](#what-gets-closed-without-review)
- [Reporting a security issue](#reporting-a-security-issue)
- [License](#license)

## Before you write code

**Claim the issue first.** Comment on the issue you want to work on and wait to be assigned before opening a pull request. This prevents duplicate work and gives us a chance to flag context that isn't in the issue text.

Pull requests that arrive without an assigned issue will be closed with a pointer back here. The one exception is a genuine security fix, which should follow [Reporting a security issue](#reporting-a-security-issue) instead.

If you think something should change but there's no issue for it, open one and describe the problem before writing the fix.

## Local setup

You need Node.js 20+ and Docker (for a local Postgres — or point `DATABASE_URL` at your own instance).

```bash
git clone https://github.com/ourdao/ourdao-backend
cd ourdao-backend
npm install

docker compose up -d          # local Postgres 16 on :5432
cp .env.example .env          # set CONTRACT_ID to a deployed contract id

npm run dev                   # API on http://localhost:4000
npm run dev:worker            # indexer, in a second terminal
```

The schema is applied idempotently on boot by both processes, so there's no separate migration step for a fresh database.

## Running the checks CI runs

CI runs exactly these, and a pull request that fails any of them will not be merged:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

**The tests need a real Postgres.** They are not mocked — that's deliberate, because the whole point of this service is its interaction with the database. Set `TEST_DATABASE_URL` to a database you don't mind being written to:

```bash
TEST_DATABASE_URL=postgres://ourdao:ourdao@localhost:5432/ourdao_test npm test
```

CI provisions a throwaway `ourdao_test` database as a service container and does exactly this.

Two more checks CI runs that aren't in the list above:

- **`npm run test:coverage`** produces a per-file coverage report and enforces the thresholds in `vitest.config.ts`. A change that drops coverage below the floor fails CI. The thresholds ratchet — raise them when you can, don't lower them to pass.
- **The Docker image is built and smoke-tested** in a separate `docker-build` job (it starts the image against a real Postgres and checks `/health`). The most common way to break it: add a migration and forget that `npm run build` must copy `src/db/schema.sql` and `src/db/migrations/` into `dist/` — the image then starts and fails at runtime. The `build` script already does the copy; don't remove it.

## What a good pull request looks like

- **It's scoped to one issue.** If you find a second problem while working, open a second issue. Don't bundle.
- **It includes a test that would fail without your change.** For a bug fix, that means a regression test that reproduces the bug. "The existing tests still pass" is the floor, not the bar.
- **Its tests hit a real database, not a mock.** Follow the pattern in the existing suites.
- **It doesn't reformat code you didn't change.**
- **Its description explains why, not just what.**
- **CI is green** before you request review.

## Backend-specific rules

- **This service is strictly read-only with respect to the chain.** It never holds a private key, never signs, and never submits a transaction. Any pull request that introduces a signing path, a key in config, or an outbound write to the network will be rejected regardless of quality — that's an architectural boundary, not a preference.
- **The `events` table is append-only.** Raw indexed events are the audit trail. Derived tables (`members`, `loans`, `loan_proposals`, `treasury_proposals`, `notifications`) are rebuilt from it. Don't mutate or delete rows in `events`.
- **Event folding stays transactional.** Writing a raw event and folding it into derived tables happens inside one database transaction so a crash can't leave them inconsistent. New event handlers must preserve that.
- **Indexer changes must be resumable.** The poll loop resumes from a persisted cursor (`indexer_cursor`), not from genesis. Don't introduce state that only exists in memory across polls.
- **New contract events need a decoder.** When [`ourdao-contracts`](https://github.com/ourdao/ourdao-contracts) adds an event, `src/stellar/events.ts` needs the matching topic-symbol → data-tuple mapping, and usually a derived-table effect. Note in your PR description which contract commit introduced the event. An event whose symbol isn't in `EVENT_FIELDS` is still persisted to `events` and still no-ops in the fold — but the indexer now logs one `[events] unknown event symbol …` warning per symbol per process (on the live path and on `npm run reindex` alike). If you see that warning in the logs, the catalog is behind the contract.
- **Authorization checks use the authenticated address, never a re-parse.** `authenticateRequest` returns a discriminated union — `{ authenticated: false, status, error }` or `{ authenticated: true, address }`. An ownership/authorization check must compare against `auth.address`; never call `extractAuthHeaders` a second time to re-derive identity. Supported wallet address types on the signature-auth endpoints: `G…` (verified directly) and `M…` (resolved to the underlying `G…`). `C…` contract accounts are unsupported and return `400` with an explicit message — not a misleading `401`.
- **`status` columns are constrained; the value list has one source of truth.** `loan_proposals`, `loans`, and `treasury_proposals` each carry a `CHECK` constraint on `status`. The accepted values are the `as const` arrays in `src/types.ts` (`LOAN_PROPOSAL_STATUSES`, `LOAN_STATUSES`, `TREASURY_PROPOSAL_STATUSES`) — the TypeScript unions are derived from them. To add or change a status value, edit the array, `src/db/schema.sql`, and a numbered migration together; `test/status-constraints.test.ts` fails if the DB constraint and the array drift apart.
- **Before changing the `events` table's storage shape, measure first.** Run `npm run bench:events` and read [`docs/events-storage.md`](./docs/events-storage.md) — it has the per-row size model, growth per unit of DAO activity, a per-index review, and the concrete threshold at which partitioning is worth its migration cost. A speculative storage change without numbers will be sent back for measurements.
- **Bigints serialize as strings.** JSON has no native 128-bit integer type. Keep the existing conversion discipline — don't let a raw bigint reach a response body.
- **`NUMERIC(40,0)` for amounts, `BIGINT` only for sequences.** On-chain `i128` amounts are `NUMERIC(40,0)` and cross the API as strings. Ledger/sequence numbers are `BIGINT` and returned as JSON numbers via a `BIGINT → number` parser scoped to the pool in `src/db/index.ts`. A token amount stored as `BIGINT` would be parsed to a `number` and lose precision above 2⁵³ silently — never do that. See the README's [Database schema](./README.md#database-schema).
- **Schema changes are additive where possible.** If you must change an existing column, say so explicitly in the PR description, since the schema is applied on boot against existing databases.

## What gets closed without review

- Pull requests against an unassigned or unclaimed issue.
- Formatting-only, whitespace-only, or comment-typo-only changes.
- Unrelated dependency bumps bundled into a feature or fix.
- Generated or AI-authored changes whose author can't explain the diff when asked in review. The policy is outcome-based, not tool-based — use whatever tools you like, but you're accountable for understanding and defending what you submit.
- Behavior changes with no accompanying test.
- Anything that gives this service the ability to sign or submit transactions (see above).

## Reporting a security issue

**Do not open a public issue for a security vulnerability.** Use GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability) on this repository.

Include what you found, how to reproduce it, and what an attacker could do with it.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE) that covers this project.
