# Package release notes and changelogs

Implement the authorized milestone inline. Keep Node >=24.0.0, real semantic-release hooks, existing branch and publication policies, and backwards-readable journals.

## Contract

- Every package with a nextVersion receives readable Conventional Commit notes generated from its attributed commits, using the installed @semantic-release/release-notes-generator and existing preset/parser options. Breaking changes, features/fixes and explicit dependency updates are included. Private releases are labelled private. Unchanged packages have no new release notes.
- The aggregate notes identify the branch, release channel, source date and npm/Cargo package versions. npm summaries use actual destination dist-tags; Cargo explains SemVer/Git channel membership. Keep the existing machine-readable JSON plan.
- Add changelog: boolean, default false. true prepares CHANGELOG.md in each released package directory. Packages sharing a directory share one file with ecosystem-labelled entries. Invalid options fail verification.
- Changelogs use the same immutable prepared commit and packaging lifecycle as versioned manifests. Existing source history is preserved; subsequent releases carry forward the eligible baseline's released changelog while canonical source is unchanged. Explicit source edits take precedence. Stable versions exclude prerelease history; prerelease branches carry their own identifier's history.
- Store releaseNotes (source date, package notes/channels and exact changelog before/after bytes) in PlanningState. It is optional for old journals and preserved in pending/completed archives. Pending output is reused exactly. Changed changelog policy is rejected; legacy pending batches cannot enable changelogs retroactively.
- Dry runs and publish:false preview notes without writing files or remote refs, packaging, identity or registry mutations. Publication temporarily applies changelogs, packages them, and restores source bytes or removes newly generated files, including after failure. Recovery accepts only frozen planned paths/bytes; user edits and symlinks are never overwritten.
- addChannel summaries include the retained notes for every promoted version, including unchanged packages from older source batches. Promotion creates no changelog entries and performs no new packaging/upload/signing.

## Verification

Use real semantic-release with local Git remotes and registry fixtures. Cover package isolation, custom parser/preset behavior, breaking and dependency-only releases, mixed ecosystems, optional/default changelogs, existing history and user edits, shared directories, branch/pre/stable/promotion summaries, dry/no-change runs, failure/fresh-clone retries, hard-stop recovery and changed/unsafe files. Check the full suite, lint, types, build, packed contents and supported Node runtimes.

References: https://semantic-release.org/developer-guide/plugin/ and https://github.com/semantic-release/release-notes-generator.
