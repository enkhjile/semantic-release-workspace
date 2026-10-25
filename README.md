# semantic-release-workspace

Workspace-aware monorepo releases for semantic-release.

## Status

The plugin discovers pnpm, npm, Yarn and Cargo workspaces, attributes commits,
plans independent versions and coordinates dependencies. It updates release
manifests, publishes npm packages and Cargo crates, and creates immutable
per-package tags through the real semantic-release lifecycle. Prereleases, maintenance lines and stable branch promotions are supported for npm and Cargo. Dry runs are
read-only; interrupted batches retain exact artifacts for safe retries, including
from a fresh clone. Private packages and `publish = false` crates participate in
planning without being published.

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
modify source files. Native Cargo tools are required only for packaging and publication.

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

Package baselines use completed ancestor journal versions or a newer reachable
`npm/<name>@<version>` or `cargo/<name>@<version>` tag. Tagged history is excluded
from that package's commits. Each package keeps commits since its own last
completed version; another package's batch does not consume its unreleased history.
With no recorded baseline, a declared semantic manifest
version is incremented; Cargo `version.workspace = true` is resolved. A package
with no declared version starts at `1.0.0` when it first needs a release. Invalid
versions fail instead of being coerced. Prerelease branches admit their own identifier and stable baselines; stable branches use stable release history. Inherited Cargo package
versions are planned independently and materialized in each prepared member manifest.

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
successive planning batches consistent without writing manifests. In `publish: false` mode these records are planning history, not evidence of registry publication.

## Package release notes

Release notes summarize each released npm package and Cargo crate separately,
using only its attributed commits. Features, fixes and breaking changes use the
standard Conventional Commit notes generator with the same `preset`, `config`,
`presetConfig` and `parserOpts` used for analysis. Dependency-driven releases
include their changed requirements even when no direct commit triggered a release.
Private packages are labelled, and unchanged packages receive no new entry.

The workspace summary names the branch, npm destination channels and Cargo's
SemVer/Git channels. Dates come from the source commit. The JSON version plan
remains available in a collapsible section. Pending journals retain exact notes
for recovery from fresh clones; promotions reuse the original notes for all
promoted versions, including packages unchanged in the latest batch.

### Optional changelogs

Set `changelog: true` on the workspace plugin to generate `CHANGELOG.md` in each
released package directory. The default is `false`; other value types fail
verification. With no discovered packages, the option has no file output and does not affect retries. For example:

```js
export default {
  branches: ['main'],
  tagFormat: 'workspace-v${version}',
  plugins: [['semantic-release-workspace', { changelog: true }]],
};
```

Entries contain the ecosystem/package name, version, source date, channel and
package notes. npm and Cargo packages sharing a directory share one changelog.
The plugin prepends each new entry and carries forward the eligible released
history. Explicitly committed source edits take precedence. Re-enabling the
option preserves older generated history while releases made with it disabled
receive no retroactive entry. Stable histories exclude prerelease entries;
prerelease branches retain their own identifier's history.

Changelogs live in the immutable prepared release commit, alongside versioned
manifests, and in package archives according to native npm/Cargo file-selection
rules. They are available through the per-package Git tags and retained prepared
refs. Publication restores existing checkout bytes and removes newly generated
files, including after failure; it does not create a source-branch commit.
`publish: false` previews and records notes without preparing or writing files.
Dry runs preview paths without file, ref, package or registry mutations.

Pending batches freeze their changelog policy and exact before/after bytes.
Changing the option during retry is rejected, and legacy pending batches cannot
retroactively enable it. Recovery restores only expected release bytes, rejecting
user edits, ignored files outside committed history and symlinked paths.
Changelog inputs must contain valid UTF-8; invalid encodings fail before mutation.
Channel promotion reuses the original notes and changelogs without new entries.

## Prereleases, maintenance and release channels

Configure branches through semantic-release's standard `branches` option:

```js
export default {
  branches: [
    '1.x',
    'main',
    'next',
    { name: 'beta', prerelease: true },
    { name: 'preview', prerelease: 'rc', channel: 'preview' },
  ],
  tagFormat: 'workspace-v${version}',
  plugins: [['semantic-release-workspace', { publish: true }]],
};
```

Only branches that exist on the release remote become active. Create maintenance
branches from the corresponding historical release, then advance the higher
branch before publishing backports. semantic-release validates the coordinator's
branch ranges. The workspace planner also rejects package versions already
allocated on another branch and package bumps that cross an outstanding higher
branch release. If a dependency-only bump hits that boundary, release a higher
version of the dependent on the higher branch, or merge that release first.
A pending stable batch reserves its coordinator version across all stable branches, including unrelated packages. Finish that batch before starting another stable batch or channel promotion. Prerelease branches use separate identifiers and may progress independently when package allocations do not conflict.

Maintenance `N.x` branches keep each package within its own major line;
`N.N.x` branches keep each within its own minor line. Package versions need not
match the coordinator version or the numbers in the branch name.

On a prerelease branch, a package can progress through `1.2.0-beta.1`,
`1.2.0-beta.2`, and so on. A stronger commit signal can advance its target stable
version. Runtime and peer dependency bumps use the same branch policy; npm and
Cargo dependencies explicitly admit the target prerelease where required.
Stable branches exclude prerelease baselines, so merging prerelease work produces
stable package versions with coordinated stable dependency ranges. Different
prerelease branches keep separate counters, histories and immutable artifacts,
even when they release the same source commit.

Use a single prerelease identifier containing a letter or hyphen, such as
`beta`, `rc` or `beta-test`. Dotted and numeric-only identifiers are rejected
before writes: semantic-release 25.0.9's own last-release lookup cannot recover
them reliably. See its [last-release implementation](https://github.com/semantic-release/semantic-release/blob/v25.0.9/lib/get-last-release.js).

npm dist-tags follow the normalized branch channel: default channel → `latest`,
`next` → `next`, and numeric ranges such as `1.x` → `release-1.x`, matching
`@semantic-release/npm`. Custom channels belong in `branches[].channel`.
In multi-branch mode these channels take precedence over npm tag settings;
the original single default branch mode retains explicit npm tag overrides.
Cargo registries have no dist-tags: prereleases use SemVer, and branch/channel
membership is recorded in Git release history.

Merging a higher stable branch into a lower one invokes the real `addChannel`
hook. It verifies every original retained artifact and registry checksum, then
moves npm dist-tags without rebuilding, republishing or signing again. Cargo
versions are verified and reused without another upload. Promotion includes
packages unchanged in the latest source batch. Historical promotions require
the completed publication plans and retained artifacts for those versions;
planning-only records do not prove registry publication.

Promotion intent is written to `refs/notes/workspace-release-channels/<branch-hash>`
before semantic-release records its batch channel. An unfinished promotion is
recovered at startup on the same source commit, even if core no longer calls
`addChannel`. Registry and authentication policies remain fixed. Accepted updates
are confirmed by reading the tag, allowing a fresh clone to finish without CI
credentials when all tags already match. Missing updates use fresh credentials.
For npm OIDC, enable **Allow npm dist-tag** on the trusted publisher as described
in [npm's trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).
Promotion never creates replacement provenance bundles.

Dry runs preview the version plan or channel promotion without source, remote
ref, registry, identity-token or signing mutations. Promotion inspection reads
existing registry checksums and retained provenance. Registry redirects use the
same frozen-origin credential guard as publication.

See semantic-release's [branch configuration](https://semantic-release.org/foundation/workflow-configuration/)
and [distribution channel workflow](https://semantic-release.org/recipes/release-workflow/distribution-channels/).

## Batch lifecycle

Load the package directly through `plugins` in a consumer repository:

```js
export default {
  branches: ['main'],
  tagFormat: 'workspace-v${version}',
  plugins: ['semantic-release-workspace'],
};
```

Run `semantic-release` from a clean repository root, with full Git history and permission to push tags, Git notes and `refs/semantic-release-workspace/*`. Serialize release jobs for the entire repository, including different branches. Dirty checkouts and running from a package subdirectory are rejected.

Do not add a separate root commit analyzer or npm publisher to this consumer
configuration. The coordinator owns analysis, manifest preparation, publication and package tags. This repository's own `release.config.mjs` continues
using standard plugins to version and publish the plugin package itself.

The exported hooks are `verifyConditions`, `analyzeCommits`, `verifyRelease`,
`generateNotes`, `prepare`, `publish`, `addChannel`, `success`, and `fail`. Package plans use
the standard Conventional Commit analyzer. At least one planned package release
triggers a batch; documentation/chore-only changes do not trigger one. An empty
inventory retains the original repository-wide lifecycle proof behavior.

### Batch tags and completion

semantic-release core creates and pushes the batch tag. A batch starts at
`workspace-v1.0.0`. The original single stable branch mode keeps a patch counter. Multi-branch runs use the strongest planned release type so semantic-release can apply its branch ranges and prerelease counters. These coordinator attempt versions remain independent of package versions.

The primary release branch retains `refs/notes/semantic-release-workspace`; other branches use `refs/notes/workspace-release-branches/<branch-hash>`. Completed plans are archived in `refs/notes/workspace-release-history/<branch-hash>`. Preserve these refs when backing up or migrating a release repository.

`refs/notes/semantic-release-0-workspace` carries coordinator channel metadata for semantic-release 25. Its commit-level note reader otherwise confuses root journals with channels and can lose a channel when prerelease branches tag the same commit. The plugin merges canonical core channel notes into this compatibility record before tagging and after promotion. Package versions and actual npm dist-tags remain governed by their frozen plans. If a legacy root release has unreadable channel metadata, a normal run repairs only that metadata and exits with `EWORKSPACECHANNELRETRY`; rerun to resume its frozen batch. A dry run reports the required repair without writing it.
The journal is a versioned JSON note attached to the repository's single root
commit; it records the release branch, source commit, previous completed source
commit, attempted batch tag, and `pending` or `complete` status. Schema 2 adds
the exact package plan, completed package versions, and projected dependency
ranges. Schema 3 adds the prepared commit, frozen destinations, artifact refs and
publication/tag progress. Schemas 1 and 2 remain readable.
- `prepare` pushes a pending journal **before** core creates its batch tag.
- `publish` executes dependency-first publication and pushes each successful package tag.
- `success` marks the batch complete after all publish hooks have succeeded.
- `fail` preserves pending state. A failure before journal creation leaves no
  pending state.

Analysis uses the previous completed source commit rather than the most recent
batch tag. A tag from a failed run therefore cannot hide unfinished work.

### Retry and dry-run behavior

After failure, rerun the same source commit, including from a fresh clone.
The plugin fetches its journal from the configured release remote. A pending
batch blocks newer source commits on its branch until the original source commit is recovered.
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
than deleting it to bypass recovery checks. Git notes and `refs/semantic-release-workspace/*` are release state and must be retained by
repository backups and mirrors.

Completion covers publication, not subsequent reporting hooks: a reporter that
fails after this plugin's `success` hook may fail the overall command even though
the batch is already complete. Do not use reporting failure to republish work.

### Verification

`pnpm test` builds the package and runs real semantic-release 25 invocations in
separate Node processes against disposable local bare Git remotes. No GitHub
repository, public registry publication, real credentials, or mocked core is required.
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

## Manifest preparation and publishing

Publication is enabled by default. To keep discovery and version planning only,
use `plugins: [['semantic-release-workspace', { publish: false }]]`.

```js
export default {
  branches: ['main'],
  tagFormat: 'workspace-v${version}',
  plugins: [
    [
      'semantic-release-workspace',
      {
        npm: {
          registry: 'https://registry.npmjs.org',
          access: 'public',
          tag: 'latest',
        },
        cargo: { registry: 'crates-io' },
      },
    ],
  ],
};
```

Both ecosystem options are optional. npm resolves registry, access and dist-tag
from plugin options, package `publishConfig`, then native npm configuration,
including scope-specific registry routing. An explicit registry override wins over
scope settings for both verification and upload. Unspecified access retains
npm's null/no-change setting rather than forcing public visibility. Normal npm
`.npmrc` token/basic authentication, custom CAs, proxies and scoped client
certificates are supported. npm packing uses the installed npm command;
publication uses the official npm client libraries with an origin-bound transport
agent, rejecting redirects to another scheme, host or port before sending headers.
npm trusted publishing uses package-scoped OIDC exchange credentials. Configure
an npm trusted publisher for **each package** and the exact CI repository/workflow.
The default `npm.trustedPublishing: "auto"` selects OIDC when a supported CI
identity is available; `true` requires it and `false` uses configured npm
credentials. Selected OIDC failures never fall back to another credential.
GitHub Actions uses its identity request endpoint; GitLab CI and CircleCI use
`NPM_ID_TOKEN` with audience `npm:registry.npmjs.org` (or the effective registry
hostname for compatible alternate registries). Exchange occurs separately for each
package immediately before uploading. Tokens stay in memory and are never stored
in artifact refs or journals. Registry reads use ordinary npm read credentials or
anonymous access; OIDC publish tokens are not used to install private dependencies.

`npm.provenance` accepts `"auto"` (default), `true`, or `false`. Explicit plugin
configuration takes precedence over package `publishConfig.provenance` and native
npm configuration. Automatic provenance accompanies OIDC on public GitHub Actions
or GitLab CI repositories when signing identity is available and the package is
public. CircleCI supports OIDC without automatic provenance. Required provenance
fails for unsupported CI, private packages/repositories or mismatched source SHAs.
Set `npm.access: "public"` for a new scoped package; existing public scoped packages
can retain their access level, which is checked through the registry visibility API.
Disable provenance with `npm.provenance: false`, package publish configuration,
`provenance=false` in `.npmrc`, or `NPM_CONFIG_PROVENANCE=false`.

For GitHub Actions, grant the release job these permissions and use a GitHub-hosted
runner with the source commit checked out:

```yaml
permissions:
  contents: write
  id-token: write
```

```js
export default {
  branches: ['main'],
  tagFormat: 'workspace-v${version}',
  plugins: [
    [
      'semantic-release-workspace',
      {
        npm: { trustedPublishing: true, provenance: true, access: 'public' },
      },
    ],
  ],
};
```

On GitLab.com shared runners, define both audiences explicitly:

```yaml
id_tokens:
  NPM_ID_TOKEN:
    aud: npm:registry.npmjs.org
  SIGSTORE_ID_TOKEN:
    aud: sigstore
```

On CircleCI cloud runners, expose its OIDC identity as `NPM_ID_TOKEN` and leave
provenance automatic or disabled. The provider and trust relationship are verified
by npm; fixture identities used in tests do not replace npm's production checks.
See npm's [trusted publisher setup](https://docs.npmjs.com/trusted-publishers/)
and [provenance requirements](https://docs.npmjs.com/generating-provenance-statements/).

Provenance uses the official Sigstore SDK and the public Fulcio/Rekor services.
The signed statement binds the exact tarball SHA-512, npm package/version and source
commit; verification checks the certificate's source repository and commit, its
trusted chain, certificate transparency and transparency-log signatures. Provenance
is public, including workflow/source metadata. Arbitrary environment variables are
not copied into statements. All identity/exchange/signing redirects are rejected;
registry and attestation requests stay within their frozen registry origin.

The exact signed bundle is retained with its tarball **before** upload intent.
Retries reuse and verify that bundle, preserving its original CI run and avoiding
new signing ledger entries. Registry confirmation requires both matching tarball
integrity and the retained attestation. Missing/corrupt attestations leave the
batch pending and never cause a duplicate upload. An uncertain accepted upload can
complete from a fresh clone without new CI identity or upload credentials; a
rejected upload obtains fresh package-scoped credentials when retried. Earlier
pending token-mode batches retain their authentication policy when CI gains OIDC.
Dry runs perform configuration/available CI metadata checks without network identity
requests, token exchange, signing, packing, refs, tags or uploads. They cannot
verify remote npm trust relationships or Sigstore availability.

Private Sigstore installations can set `npm.sigstore` with `fulcioURL`, `rekorURL`,
`tufMirrorURL` and `tufRootPath`. Use an independently trusted TUF root file, preferably
at the same repository-relative path in every clone. The file's SHA-256 and service
URLs are frozen with each pending batch; changing them blocks retry. URLs require
HTTPS, except loopback HTTP for local integration testing. The default trust root
uses Sigstore's signed TUF repository. Signing requires outbound HTTPS and an
available local loopback socket for the redirect-guarded SDK transport. Runtime
Sigstore 4.1.1 is the newest stable SDK supporting the Node 24.11.0 floor; newer major
versions require a later Node 24 patch.

Cargo supports crates.io and named HTTP sparse registries configured in
`.cargo/config.toml`, `$CARGO_HOME/config.toml`, or
`CARGO_REGISTRIES_<NAME>_INDEX`. Configure `cargo.registry` to override the default;
a single-entry package `publish` allowlist also selects a registry. Allowlists are
enforced. Authentication uses `CARGO_REGISTRY_TOKEN`,
`CARGO_REGISTRIES_<NAME>_TOKEN`, or `$CARGO_HOME/credentials.toml`.
`cargo.trustedPublishing` accepts `"auto"` (default), `true` or `false`.
Automatic mode uses GitHub Actions identity requests or a GitLab.com
`CRATES_IO_ID_TOKEN` when available; required mode validates identity availability
in preflight, including dry runs. Disabled mode uses the existing Cargo token
configuration. Selected OIDC never falls back to a stored token after a failure.
Pending batches retain their frozen authentication mode, including older token
batches retried in CI that now exposes OIDC.

Configure a crates.io trusted publisher for **each crate**, matching the repository,
workflow and optional environment. crates.io currently requires the crate's first
publication to use a normal API token. In GitHub Actions, grant `id-token: write`
to the release job; the plugin obtains and exchanges the identity itself, so an
additional authentication action is unnecessary. For GitLab.com, whose crates.io
support is currently public beta, configure:

```yaml
id_tokens:
  CRATES_IO_ID_TOKEN:
    aud: crates.io
```

```js
// Pass this object as the semantic-release-workspace plugin configuration.
const pluginConfig = { cargo: { trustedPublishing: true } };
```

Compatible named registries use the API base discovered from their sparse index.
The audience is that API base with its `http://` or `https://` prefix removed
(`crates.io` for the public registry); paths and ports remain part of alternate
registry audiences. Identity, exchange, upload and revocation reject redirects.
OIDC exchange and revocation require HTTPS, with HTTP allowed only on loopback
for local tests. Changing the API or authentication policy blocks pending retries.

Unlike npm's package-scoped exchange, Cargo exchanges once per API per invocation
and shares the short-lived credential across matching crates. This accommodates
crates.io's single-use CI identities, including GitLab's supplied job token. The
registry validates signatures and restricts the token to configured crates. The
credential stays in memory, is used only for upload, and is revoked during cleanup
after success or failure. Tokens expire upstream after 30 minutes; this plugin
stops using them after 25 minutes and requires a fresh CI job. They are never
passed to package scripts or saved in manifests, credentials files, journals or
artifact refs. Private dependency/index reads still require ordinary read access.

A rejected upload retries the retained crate with a new exchange. On GitLab, rerun
the CI job to obtain a fresh single-use ID token before exchanging again. An uncertain
accepted upload can finish from a fresh clone without current CI credentials,
using the exact retained checksum and original upload intent. No-change runs and
dry runs make no identity, exchange or revocation calls. Dry runs cannot verify
remote trust settings. Revocation failures are reported and preserve pending
progress; forced termination or lost exchange responses can leave a token active
until its upstream expiry. Such tokens cannot be recovered from disk by retries.
See the [crates.io trusted-publishing setup](https://crates.io/docs/trusted-publishing)
and [exchange protocol](https://github.com/rust-lang/crates.io/blob/main/src/controllers/trustpub/tokens/exchange/mod.rs).

Git-index registries and external credential-provider-only setups are not supported.
Registry HTTP redirects are rejected. Native Cargo packaging verifies the crate
before its exact retained `.crate` bytes are uploaded through the Cargo registry
web API. Internal dependencies resolve from their destination registry, and
upload metadata is read from the verified normalized crate. Cargo publication
cycles are rejected before publication; npm cycles retain a stable order.
Cargo and npm must be installed for their respective package types.

Each batch creates a detached prepared commit containing package versions and
coordinated dependency edits. JSON indentation and unrelated fields are retained;
Cargo edits preserve comments and materialize inherited member versions. Tags use
`npm/<name>@<version>` and `cargo/<name>@<version>` and point to this commit.
The source branch stays at the original source commit. Source manifests are
replaced atomically during execution and restored after success or failure;
startup recovery restores only exact plugin-owned bytes and rejects user edits
and symlink replacements. Lockfile changes stay in isolated packaging copies.

npm artifacts convert `workspace:`, aliases, `file:` and `link:` references to
publishable version requirements. Canonical prepared manifests retain workspace
protocols. Both packers use isolated Git-aware copies, preserving installed npm
build tools, existing ignored build outputs, and Git ignore selection (including
local exclusions). Build workspace dependencies before running the release. Package scripts may run
during the first isolated pack; a retained
artifact is never rebuilt during retry. Avoid scripts with external side effects.

Prepared commits and artifacts are pushed under
`refs/semantic-release-workspace/prepared/<source-commit>` and
`refs/semantic-release-workspace/artifacts/<source-commit>/<package-id-hash>`.
Artifacts are limited to 100 MiB each. Preserve these refs with the journal in
backups. Before starting a batch, all destination versions are checked for conflicts.
Before uploading, the plugin saves an intent; it confirms publication
using npm integrity (and retained provenance when enabled) or the Cargo index checksum. Existing versions are accepted
only when their exact bytes match and this batch already recorded an intent.
Foreign versions, checksum mismatches, missing/corrupt artifacts, changed
publication policy and conflicting tags stop the batch. Failed tag pushes retry
without another upload. An unavailable or delayed registry leaves pending work
for a rerun at the same source commit. Already published registry versions are
irreversible; recovery completes the remaining work instead of rolling them back.

Integration tests use real semantic-release, native npm/Cargo packers, disposable
Git remotes, local registries, a local mutual-TLS registry, and cryptographic
Sigstore certificate/log fixtures with a signed local TUF repository. They exercise
registry overrides, credential-safe redirects, access preservation, packed contents,
private packages, clean/dry/no-change runs, hard termination, lost upload responses,
tag failures, conflicting versions/tags, artifact corruption and fresh-clone retries.
The test runner limits concurrency to two workers because integration cases launch
multiple real release and packaging processes. The test suite requires Cargo/Rust, Git, npm and OpenSSL; no public registry writes
or real credentials are used.

## Development

The published package targets Node.js **24.11.0 and newer**, declared in
`package.json` under `engines.node`. This supports semantic-release 25 and the
current build toolchain. Development and publishing use the exact
Node.js version pinned in `devEngines.runtime` in that same file. `pnpm install`
downloads the runtime and records its version and checksum in `pnpm-lock.yaml`;
project scripts use it automatically.

Install pnpm using the [official installation guide](https://pnpm.io/installation).
The `packageManager` field in `package.json` selects the required pnpm version.

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
The npm runtime clients use the newest stable releases compatible with Node 24.11
(config 10.14.0, registry-fetch 19.1.1, libnpmpublish 11.2.1, agent 4.0.2);
their newer major versions require Node 24.15 or newer.
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

The GitHub Actions workflow verifies the minimum Node version from `engines.node`,
the development version from `devEngines.runtime`, and the latest stable Node,
then releases from `main` or `alpha` only after all
verification jobs pass. The package uses standard semantic-release plugins for
its own releases, avoiding a dependency on its unfinished workspace behavior.

The npm CLI is pinned as a direct development dependency so semantic-release
uses the project's OIDC-capable client. pnpm/setup installs Node without npm;
relying on the runner's global npm can select an older client without OIDC
support and fail publishing with `ENEEDAUTH`.

`main` publishes stable versions to npm's `latest` tag. The `alpha` branch
publishes prereleases such as `1.0.0-alpha.1` to the `alpha` tag and marks their
GitHub releases as prereleases. Install them with
`npm install semantic-release-workspace@alpha`. Merge alpha work into `main`
when it is ready for a stable release; semantic-release calculates the stable
version from the commits and existing release history.

The `@semantic-release/github` options in `release.config.mjs` keep GitHub
releases enabled while disabling issue and pull-request automation:

| Option                  | Effect                                                                 |
| ----------------------- | ---------------------------------------------------------------------- |
| `successComment: false` | Do not comment on released issues or pull requests.                    |
| `failComment: false`    | Do not open or update an issue when a release fails.                   |
| `failTitle: false`      | Also disables opening release-failure issues by title.                 |
| `releasedLabels: false` | Do not add release labels to issues or pull requests.                  |
| `addReleases: false`    | Do not append links from other publishing plugins to the release body. |

The plugin still creates GitHub releases with the generated release notes.
`contents: write` allows release publication; `id-token: write` is for npm OIDC.
See the [GitHub plugin options](https://github.com/semantic-release/github/tree/v12.0.10#options).

Before enabling real publishing:
1. Confirm the `origin` remote and the `repository`, `homepage`, and `bugs`
   metadata in `package.json` match the GitHub repository.
2. Confirm the npm package name is available under your account. If npm requires
   an initial publication before adding a trusted publisher, bootstrap that
   publication only once the plugin is ready to use.
3. Configure npm trusted publishing for that repository and the workflow filename
   `ci.yml`. The release job uses OIDC (`id-token: write`) and `GITHUB_TOKEN`.
4. Protect `main` with required verification checks. Use Conventional Commit PR
   titles when squash merging.
5. Run `pnpm release:dry-run` with the remote and required authentication in place
   before pushing a release-triggering commit.

Pushes to `main` and `alpha` trigger the verification and release workflow.

## License

MIT
