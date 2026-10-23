# Publication Implementation Plan

**Goal:** Execute frozen npm/Cargo package plans with recoverable manifests, exact artifacts and immutable package tags.
**Spec:** ../specs/2026-10-23-publication-design.md
**Execution:** Inline implementation with test-first slices and independent final review.
- [x] Implement comment-preserving manifest preparation and npm artifact manifests; verify direct tests.
- [x] Add prepared trees/artifact refs and schema 3 progress validation, preserving schema 1/2.
- [x] Add destination resolution, native packing, registry probes and exact-byte publishers.
- [x] Integrate lifecycle cleanup, dry runs, immutable tags and fresh-clone recovery.
- [x] Add local registry fixtures and real semantic-release publication/retry tests.
- [x] Run quality/compatibility/packaging checks, obtain review, fix findings, and commit.


## Verification

- `pnpm check`: formatting/lint, strict types, build and all 168 tests passed on Node 24.17.0.
- The same frozen build passed all 168 tests on Node 26.12.1, including real semantic-release publication processes.
- Node 24.0.0 passed 104 unit/runtime checks and seven final publication integration tests: npm/Cargo registry overrides, GET/PUT cross-origin credential guards, accepted-upload fresh-clone recovery, mutual TLS, and malformed Cargo response redaction.
- Local registry tests cover native Cargo verification, inherited versions and renamed dependencies, private crates, workspace protocol conversion, missing/conflicting tags, missing/swapped artifacts, read-only dry runs, no-change reruns, rejected/uncertain uploads, package-script hard termination and symlink/user-edit recovery protection.
- `pnpm install --frozen-lockfile`, packaging (five expected files and identical tested bundle), CI YAML parsing and `git diff --check` passed. Stable Rust setup added to CI for required Cargo integration tests.
- Independent review approved after fixes for registry scope overrides, origin-safe credential transport, client certificate retention, native access/null semantics, Git ignore selection, atomic recovery, artifact association, explicit TOML inheritance and missing-tag reconciliation.
- Runtime audit retains only the already documented unpatched upstream braces advisory; no new advisory. The existing tsdown TypeScript 7 API warning and Node 24.0 experimental glob warning remain.
- Consumer workspace OIDC/provenance, Git-index Cargo registries and external Cargo credential providers are deferred; README documents supported credentials and durable-ref backup requirements.
