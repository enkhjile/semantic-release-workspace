# Package Version Planning Implementation Plan

> **For agentic workers:** Use executing-plans to implement this authorized milestone inline, then request one independent final review.

**Goal:** Produce deterministic npm/Cargo package versions and coordinated dependency updates through real semantic-release.
**Architecture:** Add attribution and dependency modules behind a single planning coordinator. Persist package baselines and pending plans in the existing Git-note journal without module-global state.
**Tech Stack:** Node 24+, TypeScript 7, semantic-release 25, existing glob/TOML tools, exact stable node-semver.
**Spec:** ../specs/2026-10-23-version-planning-design.md

## Global Constraints

- Node 24.0.0+ package support; preserve exact stable tooling.
- No package publication, manifest writes, or package tags.
- Preserve read-only previews and durable retry from a fresh clone.

## Review Focus

- Filename delimiters, renames and merge histories must not lose package owners.
- npm exact ranges and Cargo bare caret ranges must differ correctly.
- Workspace protocols, shared inherited dependency fields and private crates must remain visible.
- Dependency cycles must terminate and retain direct major/minor signals.
- Pending plans must not silently change when config or journal data changes.

### Task 1: Attribution and planning contracts

Files: src/attribution.ts, src/plan-types.ts, src/journal.ts, test/fixtures/repository.ts, test/planning.test.ts.
- [x] Add real repository fixtures and failing attribution/independent-version tests.
- [x] Add raw Git output, deepest path ownership, shared file configuration, and stable plan types.
- [x] Verify focused tests against real Git.

### Task 2: Versions and dependency coordination

Files: src/dependencies.ts, src/planning.ts, test/planning.test.ts, package.json and lockfile.
- [x] Add failing baseline, npm/Cargo range, chain/cycle, private and inherited dependency tests.
- [x] Implement baseline resolution, real commit analysis, dependency extraction/range updates, and fixed-point coordination.
- [x] Verify expected literal package versions and updates using real semantic-release.

### Task 3: Durable lifecycle integration

Files: src/index.ts, src/journal.ts, src/plan-types.ts, test/lifecycle.test.ts, test/fixtures/run-release.mjs, README.md.
- [x] Add failing dry-run/no-change/retry and schema migration/corruption tests.
- [x] Integrate plan notes/results and schema 2 pending/completed baselines, retaining schema 1 and empty-inventory compatibility.
- [x] Run full quality checks, Node compatibility and packaging checks; obtain independent review, fix findings, and commit.

## Verification

- `pnpm check`: lint, strict types, build, and all 137 tests passed on Node 24.17.0.
- All 137 tests passed on Node 26.12.1, including real semantic-release subprocesses against local bare remotes.
- 101 discovery, real Git attribution, dependency coordination, and import checks passed on Node 24.0.0.
- Frozen install and package contents verified; existing tsdown TypeScript API warning remains documented.
- Independent review approved after regressions for Cargo wildcards, target-bound projections, complete journal coherence, first-parent merges, and independent package histories.
