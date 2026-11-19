# Configuration reference

Detailed behavior and options for semantic-release-workspace. Start with the
[quick start](../README.md#quick-start) or [workspace examples](examples.md).
- [Release modes](#release-modes)
- [Workspace discovery](#workspace-discovery)
- [Package versions and dependencies](#package-versions-and-dependencies)
- [Release notes and changelogs](#release-notes-and-changelogs)
- [npm publishing](#npm-publishing), [Cargo publishing](#cargo-publishing), and [Python publishing](#python-publishing)
- [Branches and channels](#branches-and-channels)
- [Recovery and backups](#recovery-and-backups)

## Release modes

| Mode                      | Result                                                                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default (`publish: true`) | Plans versions, prepares manifests, retains artifacts, uploads eligible npm packages/crates, and creates package tags.                              |
| `publish: false`          | Records version plans and completion history, including coordinator tags and journals; does not prepare files, pack artifacts, or publish packages. |
| `--dry-run`               | Previews the plan, notes, and next coordinator version or promotion without source-file changes or release-state writes.                            |

For planning-only operation, use
`plugins: [['semantic-release-workspace', { publish: false }]]`.
Its recorded versions are planning history, not proof of registry publication.
Explicit dependency requirements remain source-controlled; planning history never
silently upgrades them.

Dry runs may fetch Git metadata. Promotion previews also read registry checksums
and retained provenance. They make no identity requests, token exchanges, signing
requests, package uploads, or channel updates, and cannot validate remote trusted
publisher settings or Sigstore availability.

## Workspace discovery

Discovery reads manifests without installing dependencies or invoking package
managers. JavaScript, Cargo, and uv definitions can coexist in one repository.

### pnpm, npm, and Yarn

| Workspace          | Definition                                       |
| ------------------ | ------------------------------------------------ |
| pnpm               | `packages` in `pnpm-workspace.yaml`              |
| npm or modern Yarn | `workspaces` array in the root `package.json`    |
| Yarn classic       | `workspaces.packages` in the root `package.json` |

`packageManager` selects npm/Yarn semantics. Without it, a Yarn workspace object,
`yarn.lock`, or `.yarnrc.yml` identifies Yarn; otherwise package.json declarations
use npm semantics. Modern Yarn recursively reads selected child workspace
settings; Yarn 1 uses root declarations. `nohoist` does not affect discovery.

Patterns are repository-relative POSIX directory globs, including braces, `*`,
and `**`. Prefix exclusions with `!`:

```yaml
packages:
  - "packages/**"
  - "!**/fixtures/**"
```

pnpm/Yarn exclusions are final; npm allows later positive patterns to reinclude
matches. Leading `./`, repeated slashes, and trailing slashes are normalized.
Absolute paths, backslashes, and `..` segments are rejected. If pnpm and
package.json definitions coexist, their canonical package membership must agree.

The JavaScript repository root is excluded, even if a pattern selects it.
Directories without package.json are ignored. Invalid JSON, empty/missing names,
and non-boolean `private` values fail discovery; versions are checked later.
No definition, an empty pnpm file, or no selected packages yields an empty inventory.

### Cargo

A root `Cargo.toml` enables discovery without package.json. Virtual workspaces,
root packages with `[workspace]`, and standalone root crates are supported.
Unlike JavaScript, a Cargo root package is included at path `.`.

`workspace.members` uses globs with `*`, `**`, `?`, and character classes,
including hidden directories; braces and extended shell globs are disabled.
`workspace.exclude` uses literal directories and excludes descendants. Explicit
member paths and their descendants take precedence over exclusions. All members
are included regardless of `default-members`.

Local path dependencies inside an explicit workspace also become members,
including inherited, renamed, target-specific, dev, and build dependencies.
Canonical `dev-dependencies`/`build-dependencies` take precedence over legacy
underscore spellings. Exclusions apply; paths outside the repository remain external.
Unmatched member patterns, missing/invalid manifests, nested workspace roots, and
members pointing at another workspace fail discovery.

`publish = false` and `publish = []` mark crates private. `publish.workspace = true`
resolves through `workspace.package.publish`; registry allowlists are enforced
when selecting a publication destination. Discovery itself needs no Rust
installation and creates no lockfile or registry resolution.

### uv

A root `pyproject.toml` supports a standalone `[project]` or a
`[tool.uv.workspace]` with `members` directory globs and optional `exclude`
globs. The root project is included; a virtual root without `[project]` is not.
Exclusions win over members. Selected directories must contain a project manifest;
ordinary files and hidden directories without a manifest are ignored.
Nested uv workspaces, unsafe paths and directory symlinks fail discovery.
Unmatched patterns select nothing.
Braces and extended shell globs are not supported.

Names use Python normalization: lowercase, with runs of `.`, `_` and `-`
collapsed to `-`. Duplicate normalized names fail, including private members.
`tool.uv.managed = false` projects are skipped; on the root, it disables Python
workspace discovery entirely without disabling npm/Cargo discovery. Applications without a build
system, or projects with `tool.uv.package = false`, are marked private;
`tool.uv.package = true` explicitly enables package status.

Each selected project needs a static `project.version`. Supported versions have
one to three numeric release components (for example `1`, `1.2`, `1.2.3`) and
canonical `aN`, `bN`, or `rcN` suffixes. Planned versions have three release
components. Epochs, development/post/local releases, noncanonical spellings and
longer release tuples fail explicitly, as do dynamic or missing versions.
Prerelease identifiers must be `alpha`, `beta`, or `rc`; a planned alpha version
is spelled `1.3.0a1`, not `1.3.0-alpha.1`. Coordinator tags remain SemVer.
Reachable baseline tags use `python/<normalized-name>@<version>`. A branch
transition that would lower the Python version (such as an rc baseline to alpha
on the same release line) fails; use a compatible identifier or higher release line.

Python releases prepare `project.version`, build a wheel and source distribution,
and publish using [PyPI trusted publishing](#python-publishing). Dependency
requirements, `tool.uv.sources` and `uv.lock` remain untouched. A core change never selects its
unchanged consumers; a manual dependency upgrade with an app-owned release commit
selects that app. Non-dry planning runs still record coordinator tags and journals.

See the [uv example](examples.md#uv) and the upstream
[uv workspace rules](https://docs.astral.sh/uv/concepts/projects/workspaces/).

### Membership boundaries

Overlapping selections are deduplicated by canonical path. Nested packages stay
separate; the deepest package owns a changed file, and different ecosystems at
the same directory both own it. Private packages remain in dependency planning
but receive no registry upload or package tag.

Duplicate names fail within each ecosystem, including private packages. npm,
Cargo and Python may share a name. Git, package-manager caches, Python `.venv`
and generated Cargo `target` directories are excluded. Workspace directory symlinks and symlinked ancestors
are rejected. Discovery can read manifest symlinks inside the repository, but
publication requires regular manifest files, including private and unchanged
members staged for packaging. Publication dry-runs check this requirement.

## Package versions and dependencies

Switching from shared repository tags? Follow the [migration guide](migration.md)
to seed package baselines before the first release.

Commit scopes do not choose packages: changed paths do. Renames include old and
new paths; deletions and initial commits count, and merge changes use the first
parent. Unowned root files and empty commits do not release packages.
`[skip release]` and `[release skip]` skip the whole commit.

Use repository-relative `sharedFiles` globs to attribute shared changes to every
package. Pass Conventional Commit analyzer options alongside them:

```js
export default {
  branches: ['main'],
  tagFormat: 'workspace-v${version}',
  plugins: [
    [
      'semantic-release-workspace',
      {
        sharedFiles: ['shared/**', 'build.config.js'],
        // preset, config, presetConfig, parserOpts, releaseRules
      },
    ],
  ],
};
```

By default, `feat:` releases a minor, `fix:` a patch, and breaking changes a
major; documentation/chore-only changes do not release packages. Each package
takes its strongest signal. Its baseline follows
completed ancestor history or a newer reachable `npm/<name>@<version>` or
`cargo/<name>@<version>` tag, then its declared semantic version. For npm/Cargo,
a package with no version starts at `1.0.0` on its first release; invalid versions fail.
Each package retains its own unreleased commits across other packages' batches.
Inherited Cargo versions are planned independently and written into prepared
member manifests.

Packages have independent versions. Only their own attributed
release commits select them for release. Updating `core` does not release `app`,
and releasing both does not rewrite `app`'s explicit dependency requirement.
Upgrade dependencies yourself and commit the app manifest change with a release
signal, for example `fix(app): upgrade core to 2.0.0`. Update and commit your
lockfile using your package manager when needed; the plugin does not maintain
source lockfiles or commit release-time manifest edits.

For example, `feat(core): add an API` touching only core releases a new core
version. App keeps its previous version and dependency requirement. A later
`fix(app): adopt the new API` touching app's source and dependency manifest
releases app with the requirement you committed. A shared root Cargo dependency
edit alone does not select every consumer: include an app-owned change in the
release commit, or configure `sharedFiles` to attribute that root file.

Explicit npm semver and Cargo version requirements are preserved, including
explicit `workspace:^1.0.0` requirements. Native local references are different:
`workspace:*`, `workspace:^`, `workspace:~`, path aliases, and `file:`/`link:`
references intentionally select the local package and are converted to registry
requirements when packed. Versionless Cargo runtime/build path dependencies also
need a publishable version; versionless dev dependencies stay local and are
omitted from published crates. Use an explicit version requirement when you want
to choose dependency upgrades manually.

Dependency ordering publishes a selected dependency before a selected consumer
when the consumer requires that planned version. Pins to older registry versions
do not impose an order on the new batch or create publication cycles. Ordering
never selects another package for release. npm publication cycles
use a stable order; Cargo publication cycles are rejected. An explicit requirement
must resolve on the destination registry when its consumer is packaged/installed.
Cargo packaging removes local paths and keeps the explicit registry requirement;
both source checkouts and retained workspace snapshots need compatible local
path/version pairs for whole-workspace Cargo commands. Since source package
versions are restored after publishing, explicitly align a local crate's declared
version when adopting a new incompatible path requirement, or use a registry-only
dependency. A `chore:` commit can align source metadata without requesting another
release; use a separate `fix:`/`feat:` commit for the consumer upgrade.

Coordinator batch versions are independent of package versions. The first batch
is `workspace-v1.0.0`; single-default-branch operation uses a patch counter,
while multi-branch operation uses the strongest planned release type.
With an empty inventory, the plugin retains repository-wide lifecycle tracking.

## Release notes and changelogs

Release notes group attributed Conventional Commits and dependency changes by
package, label private packages, name actual npm destination tags, and use the
source commit's date. Unchanged packages get no new entry. A collapsible JSON
plan and the plugin's publish result expose package versions, commits, dependency
field locations, private flags, and ordered groups.

Set `changelog: true` to generate **one root `CHANGELOG.md`**, with a section for
each released public package and its independent version. The default is `false`;
other types are rejected. Entries include source date, channel, and notes.
Unchanged/private packages get no new changelog section. Retained root history
survives later releases of other packages and package directory moves. Explicit
committed edits to the root file take precedence. Re-enabling changelogs preserves
previous generated history without backfilling disabled releases. Stable and
prerelease histories are selected separately.

The root changelog and versioned manifests live in the prepared release commit.
Read the changelog through package tags or retained prepared refs. The source
branch is not advanced; original checkout bytes are restored and generated files
removed after publication or failure. A root changelog is not automatically
copied into each package archive. `publish: false` only records/previews notes
and paths. Existing per-package changelog files are left untouched.

Pending retries reuse exact notes and changelog bytes and require the same
changelog policy. User edits, unsafe paths, and invalid UTF-8 changelog inputs
are rejected. Promotions reuse original notes and create no changelog entries.

### Optional aggregate GitHub release

Add the official GitHub plugin **after** the workspace plugin to publish one
GitHub release per coordinator batch, containing sections for the released
packages and their independent versions:

```js
export default {
  branches: ['main', { name: 'rc', prerelease: true }],
  tagFormat: 'workspace-v${version}',
  plugins: [
    ['semantic-release-workspace', { changelog: true }],
    [
      '@semantic-release/github',
      {
        successComment: false,
        failComment: false,
        failTitle: false,
        releasedLabels: false,
        addReleases: false,
      },
    ],
  ],
};
```

Install `@semantic-release/github` and provide `GITHUB_TOKEN` with repository
contents write permission. The GitHub release uses the `workspace-v…` coordinator
tag, not a package version; RC batches are GitHub prereleases. Package tags
still exist independently. Omit this plugin to skip GitHub releases entirely.
`addReleases: false` only disables appended publishing-plugin links, not release
creation or the grouped notes.

Package publication recovery belongs to the workspace plugin. If GitHub rejects
a release after package uploads, the batch remains pending. A same-source retry,
including a fresh clone, reuses the frozen package versions, artifacts, and notes
without republishing accepted packages. Core may allocate a new coordinator tag
for that retry, so the aggregate GitHub release can appear on that new tag. The
original coordinator tag remains; package versions do not change. A completed
no-change rerun creates no additional GitHub release.

## npm publishing

Set npm options as needed, using
`['semantic-release-workspace', pluginOptions]` as the plugin entry:

```js
const pluginOptions = {
  npm: {
    registry: 'https://registry.npmjs.org',
    access: 'public',
    tag: 'latest',
    trustedPublishing: 'auto',
    provenance: 'auto',
    visibilityTimeout: 300000,
  },
};
```

Registry, access, and tag normally resolve from plugin options, package
`publishConfig`, then native npm configuration, including scope routing. Explicit
registry overrides win for reads and writes. Registry URLs require HTTP(S)
without embedded credentials, query, or fragment. Unspecified access keeps npm's
null/no-change setting. Branch channels override tag settings in multi-branch
mode; a single default branch retains explicit tag overrides.

Native `.npmrc` tokens/basic authentication, custom CAs, proxies, and scoped
client certificates are supported. Packing uses the installed npm command;
registry requests reject redirects outside the frozen scheme, host, and port.
Artifact manifests convert workspace/local references to publishable ranges;
prepared manifests retain workspace protocols. Packing uses isolated Git-aware
copies with installed build tools and native ignore selection.

A successful npm upload completes publication without waiting for registry reads.
If the response is lost, recovery checks the registry for matching integrity and,
when enabled, provenance before accepting an existing version. These uncertain
uploads get up to five confirmation reads with exponential backoff;
`npm.visibilityTimeout` bounds the waiting time (default `300000` milliseconds,
zero disables waiting). Individual requests may run beyond this limit.
If confirmation fails, retry the same batch with its retained artifact.

npm packing does not require newly published dependencies to be visible. Cargo
packaging does: before packing a dependent that uses a newly published workspace
crate, the plugin waits up to five minutes for that crate's index checksum.
Independent crates and retries with retained artifacts skip this wait.

### Trusted publishing and provenance

| Option                  | `"auto"` (default)                                                                                         | `true`                                                                                      | `false`                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------- |
| `npm.trustedPublishing` | Selects OIDC when supported CI identity is available.                                                      | Requires OIDC.                                                                              | Uses configured npm credentials. |
| `npm.provenance`        | Signs public packages from public GitHub/GitLab repositories when OIDC and signing identity are available. | Requires supported CI, public access/repository, matching source SHA, and signing identity. | Disables signing.                |

Provenance precedence is plugin option, `publishConfig.provenance`, then native
npm configuration. `.npmrc` `provenance=false` or `NPM_CONFIG_PROVENANCE=false`
also disables it. Set `access: 'public'` for new scoped packages; existing public
scoped packages can leave access unchanged, checked through the visibility API.

Configure a trusted publisher for **each npm package** with the exact repository,
workflow, and applicable environment. Allow direct **npm publish**; channel
promotions also need **npm dist-tag** permission. npm supports GitHub-hosted
Actions, GitLab.com shared runners, and CircleCI cloud. See
[npm's setup instructions](https://docs.npmjs.com/trusted-publishers/).

For GitHub Actions, add permissions and repository-wide serialization:

```yaml
permissions:
  contents: write
  id-token: write
concurrency:
  group: workspace-release
  cancel-in-progress: false
```

Check out the source commit with full history, install/build dependencies, then
run semantic-release with the consumer configuration. GitHub identity is obtained
by the plugin. For required OIDC and provenance, set
`npm: { trustedPublishing: true, provenance: true, access: 'public' }`.

For a GitLab.com release job, define both audiences:

```yaml
release:
  resource_group: workspace-release
  id_tokens:
    NPM_ID_TOKEN:
      aud: npm:registry.npmjs.org
    SIGSTORE_ID_TOKEN:
      aud: sigstore
  script:
    - npm exec -- semantic-release
```

For compatible alternate registries, use `npm:<effective-registry-hostname>` as
the npm audience. CircleCI supplies `NPM_ID_TOKEN`; leave provenance automatic or
disabled there because required provenance is unsupported. OIDC selection never
falls back to stored publish credentials after exchange failure. Exchanges are
package-scoped and occur immediately before upload; tokens stay in memory.
Supplied npm and signing identities must match their destination audiences before
they are forwarded. Registry reads and private dependency installation still need
ordinary read access.

Provenance is public and binds the tarball digest, package/version, repository,
and source commit to its CI identity. Arbitrary environment variables are not
copied into statements. The original signed bundle is retained with its tarball;
retries verify and reuse it without signing again. Recovery of uncertain uploads
and channel promotion check both registry integrity and retained attestation.
Missing/corrupt proof leaves that work pending; successful uploads need no
post-upload attestation read.
Identity/exchange/signing redirects are rejected; attestation reads stay within
the frozen registry origin.

For private Sigstore infrastructure, set `npm.sigstore` with `fulcioURL`,
`rekorURL`, `tufMirrorURL`, and `tufRootPath`. Supply an independently trusted TUF
root file at a path available in every clone. URLs and the root's SHA-256 are
frozen for retry. Service URLs require HTTPS; HTTP is allowed only on loopback
for local testing. Signing also needs a local loopback socket and outbound access
to the configured services. Public Sigstore services and TUF trust are the default.

## Cargo publishing

Cargo supports crates.io and named HTTP sparse registries. Configure indexes in
`.cargo/config.toml`, `$CARGO_HOME/config.toml`, or
`CARGO_REGISTRIES_<NAME>_INDEX`:

```toml
[registries.internal]
index = "sparse+https://registry.example.com/index/"
```

Set `cargo: { registry: 'internal' }` on the plugin to override selection.
Otherwise `CARGO_REGISTRY_DEFAULT`, a single-entry package publish allowlist,
native default-registry configuration, then `crates-io` determine the registry.
Package publish allowlists remain enforced. Native credentials come from
`CARGO_REGISTRY_TOKEN`, `CARGO_REGISTRIES_<NAME>_TOKEN`, or
`$CARGO_HOME/credentials.toml` (with the usual home-directory fallback).
Git-index registries and external-credential-provider-only setups are unsupported.

Native Cargo packaging verifies each crate. Internal dependencies resolve from
their destination registry; the verified normalized crate supplies upload metadata.
Exact retained `.crate` bytes are uploaded through the registry API.
The built-in crates.io destination needs no `[registries.crates-io]` alias.
Custom registry indexes keep their configured registry names.

`cargo.trustedPublishing` accepts `"auto"` (default), `true`, or `false`.
Automatic mode selects GitHub Actions identity or GitLab.com's
`CRATES_IO_ID_TOKEN` when available; required mode checks identity during
preflight, including dry runs. Disabled mode uses native credentials. Selected
OIDC failures do not fall back to stored tokens. Frozen pending authentication
modes are retained even if a later CI job gains OIDC.

Create a trusted publisher for **each crate**, matching repository, workflow,
and applicable environment. A new crates.io crate needs its initial publication
with an API token before trusted publishing can be configured; see the
[crates.io setup guide](https://crates.io/docs/trusted-publishing).
GitHub Actions needs `id-token: write`; the plugin handles exchange itself.
For GitLab.com, add this entry under the release job's `id_tokens`:

```yaml
CRATES_IO_ID_TOKEN:
  aud: crates.io
```

For alternate registries, the audience is the sparse index's discovered API base
with its HTTP(S) scheme removed; paths and ports remain part of the audience.
Exchange/revocation require HTTPS except loopback HTTP for local tests.
Identity, exchange, upload, and revocation reject redirects.

One invocation shares an exchanged token across crates using the same API.
The token is used only for upload, stays in memory, and is revoked during cleanup
after success or failure. The plugin stops using it after 25 minutes, before its
30-minute upstream expiry; start a fresh CI job after that limit. GitLab retries
also need a fresh single-use ID token. Read probes and private dependency/index
resolution use ordinary read credentials, not the upload token.

Revocation failures leave pending progress and are reported. Forced termination
or a lost exchange response can leave a token active until upstream expiry.
No-change runs and dry runs request, exchange, and revoke no credentials.

## Python publishing

Python publication requires uv 0.13.9 and a Python interpreter on `PATH`.
Use static `project.version` and a declared `[build-system]`. The plugin builds
both a wheel and a source distribution with uv in a temporary checkout, validates
their package identity, and retains both files before uploading. Backend code runs
during the initial build; a retry uses the retained bytes without rebuilding.

Set `python.trustedPublishing: true` explicitly to enable Python publishing.
Python publishing supports GitHub Actions OIDC with PyPI and TestPyPI; custom
registries and long-lived token authentication are unsupported.
Python uses required trusted publishing; stored PyPI tokens and uv credentials
are not used. Configure the trusted publisher for each project on PyPI, matching
your repository, release workflow and environment. PyPI supports a
[pending publisher for a new project](https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/).
GitHub Actions needs `id-token: write` on the release job. No long-lived PyPI
publishing token is required.

```js
[
  'semantic-release-workspace',
  {
    python: { trustedPublishing: true },
  },
];
```

PyPI is the default destination. To use TestPyPI, configure both URLs:

```js
python: {
  trustedPublishing: true,
  uploadUrl: 'https://test.pypi.org/legacy/',
  indexUrl: 'https://test.pypi.org/simple/',
}
```

PyPI attestations are not generated. The retained distribution set, including
base64 encoding, must fit the existing 100 MiB artifact limit.

The destination and authentication policy are frozen for an unfinished batch.
Changing them does not redirect a retry. Credential-bearing exchanges reject
redirects; exchanged tokens stay out of builds, retained artifacts and logs.

Only package versions change. Declared dependency requirements, `tool.uv.sources`
and `uv.lock` stay as committed. Builds disable uv source overrides so artifacts
use declared registry requirements. Upgrade dependencies and regenerate lockfiles
yourself when adopting a new workspace package version.

A successful upload needs no registry visibility polling. If only one file was
accepted or the response was lost, retry the same source and configuration. The
plugin compares remote filenames and checksums with the retained files, rejects
conflicts, and finishes missing uploads. A fresh clone must fetch the release
state as described under [recovery and backups](#recovery-and-backups).
The package tag is created only after both files are accepted or verified present.

Dry runs build nothing and request no publishing credentials. `publish: false`
continues to support planning-only operation without Python tools or uploads.

## Branches and channels

Use semantic-release's standard branch configuration; only existing remote
branches become active:

```js
export default {
  branches: [
    '1.x',
    'main',
    'next',
    { name: 'rc', prerelease: true },
    { name: 'preview', prerelease: 'rc', channel: 'preview' },
  ],
  tagFormat: 'workspace-v${version}',
  plugins: ['semantic-release-workspace'],
};
```

Prereleases have package-local counters such as `1.2.0-rc.1` and
`1.2.0-rc.2`; stronger commit signals can advance the target stable version.
Stable branches exclude prerelease baselines, and merging prerelease work creates
stable package versions. Explicit dependency requirements are preserved: upgrade
prerelease pins to stable versions yourself before releasing the dependent on
main. Promote rc into main and backmerge main into rc with merge commits
to preserve release ancestry. A backmerge with no unreleased package changes
releases nothing; subsequent attributed commits start the next prerelease cycle.
Different prerelease identifiers retain separate histories and artifacts.

Use one identifier containing a letter or hyphen (`alpha`, `rc`, `beta-test`).
Dotted and numeric-only identifiers are rejected because semantic-release 25's
last-release lookup cannot reliably recover them. Custom npm channels belong in
`branches[].channel`: the default becomes `latest`, `next` stays `next`, and
numeric ranges such as `1.x` become `release-1.x`. Cargo uses SemVer/Git channel
membership because registries have no dist-tags.

Create maintenance branches from their historical release and advance higher
branches before backports. `N.x` keeps each package within its own major line;
`N.N.x` keeps its minor line. Package versions need not match branch numbers or
the coordinator version. Conflicting allocations and bumps crossing an
outstanding higher release are rejected. For dependency-only conflicts, release
a higher dependent version on the higher branch or merge that release first.

A pending stable batch blocks new stable batches and promotions across branches,
even for unrelated packages. Finish it first. Separate prerelease identifiers
can advance when package allocations do not conflict; still serialize all jobs.

Merging a higher stable branch into a lower one can promote its original versions
through `addChannel`. The plugin checks retained artifacts and registry proofs,
then moves npm tags; Cargo versions are reused without uploading. No package is
rebuilt, republished, or signed again, and no new changelog entry is created.
Promotions include packages unchanged in the latest batch, preserve newer
published versions already reachable on the destination branch, and require
retained publication history. Enabling publishing cannot promote planning-only
versions into published history. The selected versions are retained for retries.
Interrupted promotions recover on the same source commit; already-confirmed
tag changes need no new CI credentials.
See semantic-release's [branch configuration](https://semantic-release.org/foundation/workflow-configuration/).

## Recovery and backups

After a failure, restore the same source commit and configuration, then rerun,
including from a fresh clone. Pending work blocks newer commits on that branch.
Versions, destinations, authentication policy, notes, and retained artifacts stay
fixed. New batch attempt tags may be allocated without changing package versions.

The source branch stays at its original commit. Package tags
`npm/<name>@<version>` and `cargo/<name>@<version>` point to a prepared commit
containing released manifests and optional changelogs. Existing checkout bytes
are restored after success/failure; recovery rejects user edits and changed
symlink paths rather than overwriting them. Lockfile changes stay in isolated
packaging copies.

Artifacts are retained in Git before upload intent and limited to **100 MiB each**.
For an uncertain upload, an existing registry version is accepted only with
matching retained bytes and this batch's recorded upload intent. Foreign versions, checksum mismatches,
missing/corrupt artifacts, changed policy, and conflicting tags stop recovery.
Recorded successful uploads and failed tag pushes can be reconciled without
registry confirmation or another upload; rejected uploads reuse artifacts with
fresh credentials. If the upload
response is lost or the process crashes before recording its acknowledgment, a
retry may upload the same retained artifact again when the version is not yet
visible.
Published versions are irreversible: recovery completes remaining work without
rolling back registry releases.

Back up **all Git notes** and **`refs/semantic-release-workspace/*`**, together with
ordinary package/coordinator tags. Standard clones or mirrors may need explicit
refspecs to preserve these namespaces. Do not delete journals to bypass a pending
batch: restore damaged state. The exact ref layout and compatibility behavior
are documented under [durable journals](https://github.com/enkhjile/semantic-release-workspace/blob/main/docs/architecture.md#durable-journals-and-channel-compatibility).
If a legacy channel repair reports `EWORKSPACECHANNELRETRY`, rerun after that
repair; dry runs report the repair without writing it.

Completion covers package publication and this plugin's success hook. A later
reporting hook can fail after completion; that is not a reason to republish.
See [publication recovery design](https://github.com/enkhjile/semantic-release-workspace/blob/main/docs/architecture.md#recoverable-publication).
