# semantic-release-workspace

Workspace-aware monorepo releases for semantic-release.

## Status

The plugin now implements workspace discovery and the real semantic-release lifecycle:
workspace batch tags, read-only release previews, no-change runs, and durable
retry after a failed run. It discovers pnpm, npm, and Yarn packages, including
private packages. Per-package versions, dependency coordination, npm publishing,
and Cargo/crates.io support are not implemented yet.

## Workspace discovery

Discovery runs during `verifyConditions`, including dry runs, before a batch can
be tagged. It reads files without running package-manager commands or installing
workspace dependencies.

Supported definitions:
- pnpm: the `packages` array in `pnpm-workspace.yaml`.
- npm and modern Yarn: the `workspaces` array in the root `package.json`.
- Yarn classic: `workspaces.packages`; `nohoist` is not a discovery setting.

The root `packageManager` field selects npm or Yarn semantics. Without it, a
Yarn workspace object, `yarn.lock`, or `.yarnrc.yml` identifies Yarn; otherwise
`package.json` declarations use npm semantics. Modern Yarn recursively reads
workspace declarations in selected child packages. Yarn 1 uses root declarations.

Patterns are relative POSIX directory globs, including braces, `*`, and `**`.
Prefix an exclusion with `!`. pnpm and Yarn exclusions are final; npm honors
later positive patterns that cancel earlier matching exclusions.
Leading `./`, repeated slashes, and trailing slashes are normalized. Absolute
paths, backslashes, and parent-directory (`..`) segments are rejected.

For example:

```yaml
packages:
  - "packages/**"
  - "!**/fixtures/**"
```

The internal inventory contains each package's name, canonical absolute directory,
repository-relative path, private status, and manifest. It is sorted by directory
and deduplicated by canonical path, so overlapping globs do not duplicate packages.
Nested packages remain separate inventory entries; ownership of individual commit
paths will be assigned during the version-planning milestone.

Private packages stay in the inventory for later dependency analysis and are not
publication candidates. Duplicate names are rejected across all discovered
packages, including private packages, with both locations in the error.
The repository root is always excluded from the release inventory, even when a
workspace pattern includes it. Git and package-manager cache directories are
excluded. Workspace directory symlinks are rejected, including symlinked
ancestors, to prevent aliases from bypassing exclusions. Manifest symlinks must
remain inside the repository.

Selected directories without `package.json` are ignored; malformed package JSON,
missing/empty package names, and non-boolean `private` fields are rejected. A
version is not required at this discovery stage. With no workspace definition,
the inventory is empty. An empty/comment-only pnpm file or a mapping without `packages` also yields
an empty inventory because the root is excluded.

If both definitions exist, their discovered canonical package membership must
agree. Otherwise discovery fails rather than silently selecting a different
workspace. When they agree, pnpm is recorded as the definition source.

Discovery does not yet affect commit attribution or package versions. The current
batch lifecycle still analyzes repository-wide commits. Cargo manifests are not
read by this discovery implementation.

## Lifecycle proof

Load the package directly through `plugins` in a consumer repository:

```js
export default {
  branches: ['main'],
  tagFormat: 'workspace-v${version}',
  plugins: ['semantic-release-workspace'],
};
```

Run `semantic-release` from a clean repository root, with one stable release
branch, full Git history, and permission to push tags and Git notes. Serialize
release jobs for the repository. Other release branches, prereleases, dirty
checkouts, and running from a package subdirectory are rejected in this milestone.

Do not add a separate root commit analyzer or npm publisher to this consumer
configuration. The coordinator owns the batch trigger; package publication will
arrive in a later milestone. This repository's own `release.config.mjs` continues
using standard plugins to version and publish the plugin package itself.

The exported hooks are `verifyConditions`, `analyzeCommits`, `verifyRelease`,
`generateNotes`, `prepare`, `publish`, `success`, and `fail`. The proof reads
repository-wide commits using the standard Conventional Commit analyzer. It
honors `[skip release]` and `[release skip]`; documentation/chore-only changes do
not trigger a batch. File ownership is not yet used for commit attribution.

### Batch tags and completion

semantic-release core creates and pushes the batch tag. A batch starts at
`workspace-v1.0.0`; later attempts increment its patch version, regardless of the
underlying commit's release type. These are coordinator attempt versions, not
package versions.

Completion is recorded separately in `refs/notes/semantic-release-workspace`.
The journal is a versioned JSON note attached to the repository's single root
commit; it records the release branch, source commit, previous completed source
commit, attempted batch tag, and `pending` or `complete` status.
- `prepare` pushes a pending journal **before** core creates its batch tag.
- `publish` returns a lifecycle proof result and publishes no packages.
- `success` marks the batch complete after all publish hooks have succeeded.
- `fail` preserves pending state. A failure before journal creation leaves no
  pending state.

Analysis uses the previous completed source commit rather than the most recent
batch tag. A tag from a failed run therefore cannot hide unfinished work.

### Retry and dry-run behavior

After failure, rerun the same source commit, including from a fresh clone.
The plugin fetches its journal from the configured release remote. A pending
batch blocks newer source commits until the original source commit is recovered.
A retry after a pushed tag receives another batch tag; a retry before tagging can
use the original candidate tag. The logical work and completion baseline remain
the same. Successful work is not released again on the next invocation.

A `--dry-run` previews notes and the next batch version without preparing,
publishing, pushing a journal, or creating tags. Git metadata may be fetched,
as in semantic-release itself. Source files and remote refs remain unchanged,
including when previewing a pending retry.

Missing state alongside existing reachable workspace tags, malformed journals,
and journal/tag mismatches stop the run. Restore damaged journal state rather
than deleting it to bypass recovery checks. Git notes are part of release state
and must be retained by repository backups and mirrors.

Completion covers publication, not subsequent reporting hooks: a reporter that
fails after this plugin's `success` hook may fail the overall command even though
the batch is already complete. Do not use reporting failure to republish work.

### Verification

`pnpm test` builds the package and runs real semantic-release 25 invocations in
separate Node processes against disposable local bare Git remotes. No GitHub
repository, npm publication, network credentials, or mocked core is required.
Fixture tests exercise workspace definitions, exclusions, private packages,
duplicate names, invalid input, conflicts, and path boundaries. Real-core tests
also verify discovery through all three managers and rejection before tagging.
Lifecycle tests exercise remote refs, persisted journal state, clean source files,
no-change runs, dry-run previews, fresh-clone recovery before/after tagging,
blocked newer commits, and damaged recovery state.

## Development

The published package targets Node.js **24.0.0 and newer**. Development and
publishing use **Node.js 24.17.0** (see `.node-version`), since the current build
and release tools require newer Node 24 patch versions.

Use pnpm **12.15.0**, pinned in `package.json`. Install it using your preferred
Node version manager or `npm install --global pnpm@12.15.0`.

```sh
pnpm install
pnpm check
```

Commands:
- `pnpm build`: compile the ESM entry point and type declarations into `dist/`.
- `pnpm test`: build and test the public package import in a real Node process.
- `pnpm lint`: check formatting and lint rules with Biome.
- `pnpm format`: apply formatting and safe lint fixes.
- `pnpm typecheck`: run strict TypeScript checks.
- `pnpm pack`: build and inspect a publishable tarball.
- `pnpm release:dry-run`: preview the next release in a configured repository.

Development tools use exact stable versions resolved from npm on 2026-10-23.
Node typings track the latest Node 24 release to avoid using newer runtime APIs.
tsdown currently warns that its TypeScript 7 API integration is experimental;
the compiler itself is a stable release. Build and declaration output are verified.
Commit `pnpm-lock.yaml` and use `pnpm install --frozen-lockfile` in CI.

## Versioning and publishing

semantic-release manages this package's versions using Conventional Commits:
- `fix:` produces a patch release.
- `feat:` produces a minor release.
- A `BREAKING CHANGE:` footer produces a major release.
- `chore:`, `docs:`, and `test:` do not release by default.

The version in the checkout is a development placeholder. Release versions are
written during publishing and recorded in Git tags and GitHub release notes;
generated version changes are not committed back to `main`.

The GitHub Actions workflow verifies Node 24 and the latest stable Node, then
releases from `main` only after both verification jobs pass. The package uses
standard semantic-release plugins for its own releases, avoiding a dependency
on its unfinished workspace behavior.

Before enabling real publishing:
1. Create a GitHub repository, set its `origin` remote, and add matching
   `repository`, `homepage`, and `bugs` metadata in `package.json`.
2. Confirm the npm package name is available under your account. If npm requires
   an initial publication before adding a trusted publisher, bootstrap that
   publication only once the plugin is ready to use.
3. Configure npm trusted publishing for that repository and the workflow filename
   `ci.yml`. The release job uses OIDC (`id-token: write`) and `GITHUB_TOKEN`.
4. Protect `main` with required verification checks. Use Conventional Commit PR
   titles when squash merging.
5. Run `pnpm release:dry-run` with the remote and required authentication in place
   before pushing a release-triggering commit.

No remote, npm publication, or release tag is created by initialization.

## License

MIT
