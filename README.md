# semantic-release-workspace

Independent npm and Cargo package releases through semantic-release. The plugin
finds workspace packages, attributes commits by changed files, coordinates local
dependencies, publishes package artifacts, and retains release state for retries
from the same checkout or a fresh clone.

For implementation details, see [Architecture](https://github.com/enkhjile/semantic-release-workspace/blob/main/docs/architecture.md). For project
setup and contributions, see [CONTRIBUTING.md](https://github.com/enkhjile/semantic-release-workspace/blob/main/CONTRIBUTING.md).

## Setup

Requirements for a consumer repository:
- Node.js **24.11.0 or newer** and **semantic-release 25** (`^25.0.9`).
- Git with full repository history, a clean checkout, and release commands run
  from the repository root. Running from a package directory is rejected.
- Permission to push tags, Git notes, and `refs/semantic-release-workspace/*` to
  the configured release remote.
- npm for npm packaging, and Rust/Cargo for Cargo packaging. Install workspace
  dependencies and build dependencies needed by package scripts before release.
- One release job at a time for the **whole repository**, including different
  branches. A concurrency group containing the branch name is insufficient.

Until an npm release is available, follow the [development setup](https://github.com/enkhjile/semantic-release-workspace/blob/main/CONTRIBUTING.md#set-up-a-checkout)
in this checkout and build a local tarball:

```sh
pnpm pack
```

Then install that tarball in the consumer repository root, replacing the path:

```sh
npm install --save-dev 'semantic-release@^25.0.9' /absolute/path/to/semantic-release-workspace-0.0.0-development.tgz
```

Load the plugin in the consumer's `release.config.mjs`:

```js
export default {
  branches: ['main'],
  tagFormat: 'workspace-v${version}',
  plugins: ['semantic-release-workspace'],
};
```

The exact `tagFormat` is required. This plugin owns commit analysis, versioned
manifests, package publication, and per-package tags; do not add a separate root
commit analyzer or npm publisher to this configuration. Publication is enabled
by default. This repository's own package-release setup is described separately
in [CONTRIBUTING.md](https://github.com/enkhjile/semantic-release-workspace/blob/main/CONTRIBUTING.md#maintainer-releases).

Start with `npm exec -- semantic-release --dry-run`, then use
`npm exec -- semantic-release` in the release environment when ready to publish.
Package scripts can run during the first isolated pack; avoid scripts with
external side effects. Retried artifacts are reused without rebuilding.

### Release modes

| Mode                      | Result                                                                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default (`publish: true`) | Plans versions, prepares manifests, retains artifacts, uploads eligible npm packages/crates, and creates package tags.                              |
| `publish: false`          | Records version plans and completion history, including coordinator tags and journals; does not prepare files, pack artifacts, or publish packages. |
| `--dry-run`               | Previews the plan, notes, and next coordinator version or promotion without source-file changes or release-state writes.                            |

For planning-only operation, use
`plugins: [['semantic-release-workspace', { publish: false }]]`.
Its recorded versions are planning history, not proof of registry publication.
Completed projections inform later dependency plans even though source manifests
remain unchanged. Editing a dependency requirement takes precedence over its
stored projection.

Dry runs may fetch Git metadata. Promotion previews also read registry checksums
and retained provenance. They make no identity requests, token exchanges, signing
requests, package uploads, or channel updates, and cannot validate remote trusted
publisher settings or Sigstore availability.

## Workspace discovery

Discovery reads manifests without installing dependencies or invoking package
managers. JavaScript and Cargo definitions can coexist in one repository.

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

### Membership boundaries

Overlapping selections are deduplicated by canonical path. Nested packages stay
separate; the deepest package owns a changed file, and different ecosystems at
the same directory both own it. Private packages remain in dependency planning
but receive no registry upload or package tag.

Duplicate names fail within each ecosystem, including private packages. npm and
Cargo may share a name. Git, package-manager caches, and generated Cargo `target`
directories are excluded. Workspace directory symlinks and symlinked ancestors
are rejected; manifest symlinks must stay inside the repository.

## Package versions and dependencies

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
`cargo/<name>@<version>` tag, then its declared semantic version. A package with
no version starts at `1.0.0` on its first release; invalid versions fail.
Each package retains its own unreleased commits across other packages' batches.
Inherited Cargo versions are planned independently and written into prepared
member manifests.

npm and Cargo dependencies are coordinated separately, in dependency-first groups:
- Out-of-range runtime, optional, and Cargo build requirements force at least a
  patch release of the dependent; npm peer requirement changes force a major.
- Dev-only updates appear in the plan without forcing a dependent release.
  Cargo dev dependencies without a version stay local and are omitted from
  published crates, matching native Cargo behavior.
- npm `workspace:` aliases/shorthands and `file:`/`link:` references track local
  versions. Optional declarations override duplicate normal dependencies.
- Compatible ordinary npm semver requirements can select local packages;
  incompatible registry requirements, registry aliases, and git/URL references
  remain external. Cargo registry-only and excluded/outside-workspace crates
  remain external.
- Cargo bare `1.2.3` means caret compatibility; npm bare `1.2.3` is exact.
  Cargo comma-separated comparators intersect. Path-only Cargo runtime and
  build dependencies receive a proposed version requirement.
- Cycles settle without repeatedly incrementing a package. npm publication cycles
  use a stable order; Cargo publication cycles are rejected.

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

Set `changelog: true` in the plugin options to generate package `CHANGELOG.md`
files; the default is `false`, and other types are rejected. npm/Cargo packages
sharing a directory share one file with ecosystem-labelled entries. Entries carry
package/version, source date, channel, and notes. Eligible released history is
carried forward by package identity, including after a directory move;
explicit committed source edits take precedence. Re-enabling
changelogs preserves earlier generated history without backfilling disabled releases.
Stable history excludes prereleases; prerelease history follows its identifier.

Changelogs and versioned manifests live in the prepared release commit and,
subject to native file selection, package archives. Read them through package
tags or retained prepared refs. The source branch is not advanced; original
checkout bytes are restored and newly generated files removed after publication
or failure. `publish: false` only records/previews notes and paths.

Pending retries reuse exact notes and changelog bytes and require the same
changelog policy. User edits, unsafe paths, and invalid UTF-8 changelog inputs
are rejected. Promotions reuse original notes and create no changelog entries.

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
retries verify and reuse it without signing again. Registry confirmation checks
both integrity and retained attestation. Missing/corrupt proof leaves work pending.
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

## Branches and channels

Use semantic-release's standard branch configuration; only existing remote
branches become active:

```js
export default {
  branches: [
    '1.x',
    'main',
    'next',
    { name: 'alpha', prerelease: true },
    { name: 'preview', prerelease: 'rc', channel: 'preview' },
  ],
  tagFormat: 'workspace-v${version}',
  plugins: ['semantic-release-workspace'],
};
```

Prereleases have package-local counters such as `1.2.0-alpha.1` and
`1.2.0-alpha.2`; stronger commit signals can advance the target stable version.
Stable branches exclude prerelease baselines, and merging prerelease work creates
stable package versions with coordinated stable dependency ranges. Different
prerelease identifiers retain separate histories and artifacts.

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
An existing registry version is accepted only with matching retained bytes and
this batch's recorded upload intent. Foreign versions, checksum mismatches,
missing/corrupt artifacts, changed policy, and conflicting tags stop recovery.
Accepted uploads with lost responses and failed tag pushes can be reconciled
without another upload; rejected uploads reuse artifacts with fresh credentials.
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

## Contributing and license

See [CONTRIBUTING.md](https://github.com/enkhjile/semantic-release-workspace/blob/main/CONTRIBUTING.md) for development, verification, and this
project's own release process. The project uses the [MIT license](LICENSE).

## AI-assisted development

Code, tests, and documentation were developed with substantial AI coding
assistance. AI-generated output may contain mistakes; review the configuration
and validate behavior in your own release workflow.
