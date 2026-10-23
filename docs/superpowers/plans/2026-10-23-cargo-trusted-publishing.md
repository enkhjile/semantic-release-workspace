# Cargo OIDC implementation

Execution: inline, test-first; user authorized this milestone.
- [x] Prove the missing Cargo exchange/revocation lifecycle using real semantic-release.
- [x] Add frozen Cargo auth policy and a per-invocation, registry-bound credential session.
- [x] Cover dry/no-change, native mode, GitLab, redirects, failures and fresh-clone retry safety.
- [x] Document setup, obtain independent review, verify compatibility/packaging and commit.


## Verification

- `pnpm check` passed formatting/lint, strict typing, build and all 227 tests on Node 24.17.0. The new Cargo suite contains 26 real semantic-release integration cases and one real-HTTP credential lifetime check.
- All 27 Cargo cases passed on Node 26.12.1. Node 24.0.0 passed all 27 plus the public package import (28 checks).
- Coverage proves single-use identity exchange across dependent crates, GitHub/GitLab, defaults/native opt-out/legacy pending policy, required dry-run validation, no-change runs, rejected and uncertain uploads, fresh-clone and partial-batch recovery, malformed/rejected/expired credentials, read/write credential separation, same/cross-origin redirects, registry overrides/audiences, API drift, insecure API rejection, revocation failure and conservative lifetime cleanup.
- Independent review approved the implementation; shared Cargo User-Agent and a copyable documentation example were included after review.
- Package inspection passed: five expected files and a byte-identical tested bundle. Frozen installation and diff whitespace checks passed. No dependencies or lockfile changes were introduced; the previously documented upstream braces advisory remains unchanged. The existing tsdown TypeScript API warning remains.
- Tests use local CI/registry HTTP fixtures, native verified Cargo packages and disposable Git remotes. No public uploads were performed.
