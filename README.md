# semantic-release-workspace

Workspace-aware monorepo releases for semantic-release.

## Status

The plugin now implements workspace discovery and the real semantic-release lifecycle:
workspace batch tags, read-only release previews, no-change runs, and durable
retry after a failed run. It discovers pnpm, npm, Yarn, and Cargo workspaces,
including private packages and non-publishable crates. It attributes commits to
packages and produces independent version plans with coordinated dependency
updates. Manifest changes, package tags, and npm/crates.io publication are not
implemented yet.

## Workspace discovery

Discovery runs during `verifyConditions`, including dry runs, before a batch can
be tagged. It reads files without running package-manager commands or installing
workspace dependencies.

### JavaScript workspaces

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

The internal inventory contains each package's ecosystem, name, canonical absolute
directory, repository-relative path, manifest path, private status, and manifest.
It is sorted by directory
and deduplicated by canonical path, so overlapping globs do not duplicate packages.
Nested packages remain separate inventory entries; the deepest discovered package
directory owns a changed file. Ecosystems at the same directory both own it.

Private packages stay in the inventory for later dependency analysis and are not
publication candidates. Duplicate names are rejected within each ecosystem,
including private packages, with both locations in the error. An npm package and
a Cargo crate may share a name because their registries have separate namespaces.
The JavaScript repository root is excluded from the release inventory, even when a
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

### Cargo workspaces

A root `Cargo.toml` enables Cargo discovery, with no `package.json` required.
Cargo and JavaScript definitions can coexist; both contribute to one inventory.
Discovery supports virtual workspaces, a root package with `[workspace]`, and a
standalone root crate. Unlike JavaScript, a Cargo root package is a member and
appears at path `.`.

`workspace.members` selects directories with globs; `workspace.exclude` contains
literal directory paths and excludes their descendants too. Explicit member
paths and their descendants take precedence over exclusions, matching Cargo.
Cargo member globs support `*`, `**`, `?`, and character classes, including hidden
directories. Brace expansion and extended shell globs are disabled. Patterns must
stay inside the repository and use forward slashes. A member pattern with no
matches, a missing/invalid member manifest, a nested workspace root, or a member
pointing at a different workspace fails discovery. Generated `target`, Git, and
package-manager cache directories are ignored. The same canonical-path and
symlink checks apply to both ecosystems.

All workspace members are included, regardless of `default-members`. Local path
dependencies inside an explicit Cargo workspace also become members, including
inherited `workspace.dependencies`, dev/build dependencies, and target-specific
dependencies. Legacy `dev_dependencies` and `build_dependencies` tables are
recognized, with canonical hyphenated names taking precedence. Exclusions still apply. Path dependencies outside the repository
are external dependencies and do not become inventory entries.

Crates with `package.publish = false` or `publish = []` stay in the inventory with
`private: true`. `publish.workspace = true` resolves through
`workspace.package.publish`. Allowed registry names are preserved for future
publishing decisions. Duplicate Cargo names are rejected even for private crates.
The raw TOML manifest is retained without rewriting its package/dependency tables.

Discovery parses manifests directly: it requires no Rust installation, does not
invoke Cargo, and does not create a lockfile, resolve registry dependencies, or
modify source files. Cargo version updates and crates.io publishing will need a
later milestone.

## Package attribution and version planning

For a nonempty inventory, commits are attributed by changed files, regardless of
commit scope. A rename includes both its old and new paths; deletions and initial
commits are included. Merge changes are read against the first parent. A nested
package owns its files instead of its parent. Empty commits and unowned root
files do not trigger package releases. `[skip release]` and `[release skip]`
exclude the whole commit.

Opt shared files into every package with repository-relative `sharedFiles` globs:

```js
export default {
  branches: ['main'],
  tagFormat: 'workspace-v${version}',
  plugins: [
    [
      'semantic-release-workspace',
      {
        sharedFiles: ['shared/**', 'build.config.js'],
      },
    ],
  ],
};
```

Conventional Commit analyzer options, such as `preset` and `releaseRules`, can be
supplied on the same plugin configuration. Each package receives its own strongest
major/minor/patch signal. Private packages participate but remain non-publishable.

Package baselines use completed journal versions or a newer reachable stable
`npm/<name>@<version>` or `cargo/<name>@<version>` tag. Tagged history is excluded
from that package's commits. Each package keeps commits since its own last
completed version; another package's batch does not consume its unreleased history.
With no recorded baseline, a declared stable manifest
version is incremented; Cargo `version.workspace = true` is resolved. A package
with no declared version starts at `1.0.0` when it first needs a release. Invalid
or prerelease baselines fail instead of being coerced. Inherited Cargo package
versions are planned independently; a later manifest writer must materialize
member versions when they differ.

### Dependency coordination

npm and Cargo use separate dependency graphs. The planner iterates until no
release type increases, then emits dependency-first groups. Cycles form one group;
a package is incremented once from its original baseline, even inside a cycle.
- Out-of-range runtime, optional, and Cargo build dependencies force at least a patch.
- Out-of-range npm peer dependencies require a major because the old support range changes.
- Dev-only dependencies receive proposed updates but do not force releases.
- npm `workspace:` aliases/shorthands and local `file:`/`link:` references track
  local version changes; optional declarations override duplicate normal dependencies.
- Ordinary npm semver requirements select a matching local current version.
  Registry aliases, git/URL references, and incompatible registry requirements are external.
- Cargo path dependencies include renamed, inherited, target-specific, and legacy
  table forms. Registry-only or excluded/outside-workspace crates are external.
- Cargo bare `1.2.3` means caret compatibility; npm bare `1.2.3` is exact.
  Cargo comma-separated comparators are intersected. Missing Cargo path version
  requirements receive a proposed version for future publication.

The plan is emitted as a JSON block in release notes (including dry runs) and as
`plan` on this plugin's publish result. It contains every package's attributed
commits, current/next versions, release type, private flag, dependency updates
with manifest/field locations, and ordered groups. Batch attempt versions remain
separate from package versions.

Completing a batch records planned versions and projected dependency ranges in
the journal. Later plans use those ranges while their original manifest values
remain unchanged; an edited dependency requirement takes precedence. This keeps
successive planning batches consistent without writing manifests. These records
are planning history, not evidence of registry publication.

## Batch lifecycle

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
`generateNotes`, `prepare`, `publish`, `success`, and `fail`. Package plans use
the standard Conventional Commit analyzer. At least one planned package release
triggers a batch; documentation/chore-only changes do not trigger one. An empty
inventory retains the original repository-wide lifecycle proof behavior.

### Batch tags and completion

semantic-release core creates and pushes the batch tag. A batch starts at
`workspace-v1.0.0`; later attempts increment its patch version, regardless of the
underlying commit's release type. These are coordinator attempt versions, not
package versions.

Completion is recorded separately in `refs/notes/semantic-release-workspace`.
The journal is a versioned JSON note attached to the repository's single root
commit; it records the release branch, source commit, previous completed source
commit, attempted batch tag, and `pending` or `complete` status. Schema 2 adds
the exact package plan, completed package versions, and projected dependency
ranges. Schema 1 journals remain readable and migrate when package planning begins.
- `prepare` pushes a pending journal **before** core creates its batch tag.
- `publish` returns the package plan and publishes no packages.
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
the same. Package versions and the stored plan remain identical across retries.
If source, configuration, or baseline changes produce a different pending plan,
the run fails until the original conditions are restored. Successful work is not
released again on the next invocation.

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
also verify discovery through all three JavaScript managers, Cargo-only and mixed
repositories, and rejection before tagging. When Cargo is installed, an additional
fixture compares discovery with real offline `cargo metadata`; no registry access
is needed.
Lifecycle tests exercise remote refs, persisted journal state, clean source files,
no-change runs, dry-run previews, fresh-clone recovery before/after tagging,
blocked newer commits, and damaged recovery state. Planning tests exercise
independent/tagged versions, nested ownership, rename attribution, shared files,
npm/Cargo ranges, dependency chains/cycles, peers and dev dependencies, private
packages, schema migration, projected ranges, and exact fresh-clone plan recovery.

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

Dependency audit reviewed on 2026-10-23:
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
affects the transitive `braces` package used by semantic-release and fast-glob;
no patched version is available. Cargo discovery disables brace expansion, so its
patterns do not enter the affected expansion routines. The remaining
semantic-release path accepts repository-controlled configuration. This upstream
finding is deferred pending a compatible fix; review again before publishing or
by 2026-11-23, whichever comes first.


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
