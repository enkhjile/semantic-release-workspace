# Package Release Notes Implementation Plan

Execution: inline as authorized, test-first, with one independent final review.

Goal: readable package notes, channel summaries and opt-in changelogs with the existing frozen release lifecycle.
Spec: ../specs/2026-10-23-release-notes.md
Constraints: Node >=24.0.0; changelog defaults false; no source commits; real semantic-release integration tests; existing registry/auth policies remain frozen.

## 1. Package notes and summaries

- [ ] Add real-lifecycle tests in test/release-notes.test.ts for npm/Cargo attribution, breaking changes, dependency-only bumps and channel summaries; watch missing-note assertions fail.
- [ ] Add src/release-notes.ts with notesForRelease(config, context, planning, destinations) and formatReleaseNotes(plan, notes, publishing). Use the existing standard generator, deterministic source date, and package-specific contexts.
- [ ] Extend PlanningState/validation/writeJournal to retain optional releaseNotes; wire generateNotes and prepare. Promote the installed notes generator from a dev dependency to a runtime dependency.
- [ ] Test pending note replay, no-change runs and addChannel summaries using archived package notes. Verify types/lint and commit the slice.

## 2. Immutable changelogs

- [ ] Add failing lifecycle tests for changelog:true, preserved history, read-only dry runs, fresh-clone retries and policy drift.
- [ ] Extend existing file preparation/application/recovery to support missing CHANGELOG.md files and frozen changelog changes. Reuse prepared manifests/artifact refs. Select prior eligible changelog content from the original version's prepared release snapshot; source edits take precedence.
- [ ] Test hard termination, edited and symlinked files, npm/Cargo shared directories, prerelease/stable history and promotions without duplicate entries.
- [ ] Document usage, snapshot retention and configuration/recovery semantics. Verify targeted cases and commit the slice.

## 3. Final verification

- [ ] Request one fresh, read-only review focused on lost history, stale/unsafe file recovery, promotion duplication, frozen config and mixed directory membership.
- [ ] Resolve concrete findings with regressions. Run full lint/type/build/tests, Node 24.0/26 compatibility checks and package validation. Commit fixes and confirm clean status.
