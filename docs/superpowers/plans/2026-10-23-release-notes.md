# Package Release Notes Implementation Plan

Execution: inline as authorized, test-first, with one independent final review.

Goal: readable package notes, channel summaries and opt-in changelogs with the existing frozen release lifecycle.
Spec: ../specs/2026-10-23-release-notes.md
Constraints: Node >=24.0.0; changelog defaults false; no source commits; real semantic-release integration tests; existing registry/auth policies remain frozen.

## 1. Package notes and summaries

- [x] Add real-lifecycle tests in test/release-notes.test.ts for npm/Cargo attribution, breaking changes, dependency-only bumps and channel summaries; watch missing-note assertions fail.
- [x] Add src/release-notes.ts with notesForRelease(config, context, planning, destinations) and formatReleaseNotes(plan, notes, publishing). Use the existing standard generator, deterministic source date, and package-specific contexts.
- [x] Extend PlanningState/validation/writeJournal to retain optional releaseNotes; wire generateNotes and prepare. Promote the installed notes generator from a dev dependency to a runtime dependency.
- [x] Test pending note replay, no-change runs and addChannel summaries using archived package notes. Verify types/lint and commit the slice.

## 2. Immutable changelogs

- [x] Add failing lifecycle tests for changelog:true, preserved history, read-only dry runs, fresh-clone retries and policy drift.
- [x] Extend existing file preparation/application/recovery to support missing CHANGELOG.md files and frozen changelog changes. Reuse prepared manifests/artifact refs. Select prior eligible changelog content from the original version's prepared release snapshot; source edits take precedence.
- [x] Test hard termination, edited and symlinked files, npm/Cargo shared directories, prerelease/stable history and promotions without duplicate entries.
- [x] Document usage, snapshot retention and configuration/recovery semantics. Verify targeted cases.
- [x] Commit the immutable-changelog slice after final verification.

## 3. Final verification

- [x] Request one fresh, read-only review focused on lost history, stale/unsafe file recovery, promotion duplication, frozen config and mixed directory membership.
- [x] Resolve concrete findings with regressions, including empty-inventory retries.
- [x] Run full lint/type/build/tests, Node 24.0/26 compatibility checks and package validation.
- [x] Commit the verified result and confirm clean status.

## Verification results

- 275 tests verified: the full run passed 222 of 274; macOS sleep interrupted 52 cases. All 52 passed on an isolated rerun with a temporary keep-awake assertion (177 seconds), with exact failed/passed case matching. The additional empty-inventory retry regression passed separately.
- Node 26.12.1: all 24 new milestone tests plus the public package import test passed. Node 24.0.0: eight focused notes/changelog/package checks plus the empty-inventory retry regression passed.
- Lint, TypeScript checks, build, package archive metadata/contents and Git whitespace checks passed.
- Independent review findings have regressions for root-relative presets, existing H2 release headings, invalid UTF-8, and alternating npm/Cargo history in a shared directory. The final empty-inventory policy guard also received independent review.
