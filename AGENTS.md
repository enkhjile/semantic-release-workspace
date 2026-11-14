# Repository guidance

Read [CONTRIBUTING.md](CONTRIBUTING.md) for setup, commands and PR policy;
[README.md](README.md) defines consumer behavior and
[docs/architecture.md](docs/architecture.md) explains release invariants.

## Architecture

- `src/index.ts` implements semantic-release hooks. Core owns coordinator versions,
  branches and batch tags; this plugin owns independent npm/Cargo package releases.
- Discovery → attribution → planning/dependency ordering stays separate from
  publication. Release only packages with their own attributed release commits;
  preserve explicit dependency requirements. Local packaging references are the
  documented exception, not automatic dependent synchronization.
- `publication.ts`, `registries.ts` and `release-io.ts` prepare and publish retained
  artifacts; `journal.ts` and validation modules enforce durable recovery.
  Keep source commits, prepared commits and immutable artifact refs distinct.
- `release-notes.ts` / `changelogs.ts` produce aggregate notes and an optional root
  changelog. The optional official GitHub plugin follows the workspace plugin.
  This repository's own `release.config.mjs` uses standard plugins instead.

## Coding conventions

- Use small, focused TypeScript ESM changes, `.js` relative imports and type-only
  imports where appropriate. Follow Biome and strict `tsconfig.json`; do not
  weaken checks to make a change pass. Prefer existing helpers over new abstractions.
- Treat `package.json` as the toolchain source of truth: `engines.node` for support,
  `devEngines.runtime` for development Node, `packageManager` for pnpm. Keep the
  lockfile in sync; do not add a separate Node version file.
- Preserve deterministic plans, error codes, credential redaction and validation
  before side effects. Never persist tokens in logs, journals or artifacts.
- Use Conventional Commits. Update usage docs for behavior changes and architecture
  docs for changed invariants; keep implementation detail out of quick-start flows.

## Tests and verification

- `pnpm test:unit` runs pure in-memory tests without a build or Rust.
  `vitest.config.ts` explicitly lists unit files; new files default to integration.
- `pnpm test:integration` builds and runs the full integration suite.
  Use real semantic-release, disposable Git remotes, native npm/Cargo packaging
  and local registry/OIDC/Sigstore fixtures for release regressions.
- Preserve dry-run/no-change assertions, exact artifact checks and fresh-clone
  recovery coverage. Do not replace integration coverage with mocked hooks.
- Use at most four workers (fewer on constrained machines). For code/packaging
  changes, run `pnpm check` and inspect `pnpm pack`; docs-only changes need link,
  example and formatting checks. Report the checks actually run and any failures.

## Release safety and cleanup

- `main` is development-only. `rc` publishes release candidates; `release` publishes
  stable versions. Promote with merge commits and preserve release ancestry.

- Routine tests must not publish publicly or use real credentials. Live publication,
  release-branch merges and destructive remote cleanup need explicit authorization.
  Use designated test packages and maintainer-approved publication scope.
- `pnpm release` publishes this plugin; `release:dry-run` can contact authenticated
  services. Neither is a routine test. Consumer `publish: false` still writes
  planning tags/journals; only `--dry-run` is a nonpublishing preview without
  release-state writes. Serialize consumer releases across all branches.
- Retry pending batches from the same source/configuration with frozen versions
  and bytes. Never delete journals, rewrite tags or re-sign artifacts to bypass
  recovery. Preserve all documented release refs. Promote/backmerge release
  branches with merge commits so their ancestry survives.
- Remove task-created temporary clones, tarballs, build targets and local servers
  after verification. Preserve user files, shared caches, other checkouts and
  release refs. Do not treat published versions as temporary files.
