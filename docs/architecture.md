# Architecture

The [README](../README.md) describes supported behavior and configuration;
[CONTRIBUTING](../CONTRIBUTING.md) covers development and verification commands.

## Coordinator and package identities

The plugin runs inside the real semantic-release lifecycle. Core owns branch
normalization, coordinator versions, batch tags and hook ordering. The plugin
owns package analysis, dependency coordination, preparation and publication.
One coordinator avoids independent release lifecycles whose partial completion
would be difficult to reconcile across dependent packages.

A `workspace-v<version>` batch tag identifies a coordinator attempt at a source
commit. Package versions are independent: `npm/<name>@<version>` and
`cargo/<name>@<version>` tags identify the prepared release commit. A retry after
core pushed a batch tag may allocate another coordinator version while retaining
the same package versions, plan and artifacts. Completion history, rather than
the latest batch tag, determines which source work remains unreleased.

[The hooks](../src/index.ts) enforce that division:
- Verification checks configuration, the repository root and clean source state,
  recovering expected prepared files and channel metadata when necessary.
- Analysis and release verification compute plans and check publication policy.
- Preparation freezes release output and pushes a pending journal before tagging.
- Publication performs dependency-first uploads and package tagging.
- Success records completion; failure preserves pending state for another run.

The single default release branch uses a patch coordinator counter. Multiple
branches use the strongest package signal so core can enforce its ranges and
prerelease counters. An empty inventory retains repository-wide commit analysis
and batch tracking. A planning-only batch records proposed package history
without claiming that anything reached a registry.

## Discovery and planning stay separate from publication

[Discovery](../src/discovery.ts) parses JavaScript and Cargo workspace files
without invoking package managers, installing dependencies or creating lockfiles.
It produces a deterministic inventory with ecosystem-qualified identities and
canonical paths. Duplicate names within an ecosystem and workspace directory
symlinks are rejected so a package cannot acquire multiple identities or evade
path exclusions. Private packages remain because they affect public dependents.

[Attribution](../src/attribution.ts) assigns commits by changed paths, not scopes.
The deepest package owns a path; ecosystems sharing that directory both own it.
Renames include both paths, merges use the first parent, and configured shared
paths can affect every package. Each package retains its own unreleased history,
even when another package completes a batch in the meantime.

[Planning](../src/planning.ts) selects eligible completed ancestor versions and
reachable package tags before falling back to declared manifest versions.
[Dependency coordination](../src/dependencies.ts) increases release types to a
fixed point, calculating versions from the original package baseline.
Runtime/build/optional incompatibility requires at least a patch; npm peer
incompatibility requires a major; dev-only updates do not force a release.
Strongly connected components provide deterministic dependency-first groups
without repeated increments inside cycles. npm cycles can be published; Cargo
cycles are rejected before publication. Private packages participate in plans
and prepared edits, but receive no registry uploads or package tags.

Completed plans retain projected dependency ranges because canonical source
manifests are restored after release. A projection applies only while its
original field value and dependency identity match; source edits take precedence.
Carrier selection includes unchanged packages and legacy journals, filtering
prerelease carriers so their ranges cannot leak into stable plans. Pending
retries must reproduce the exact frozen plan.

## Source, prepared commits and artifacts have different roles

[Manifest editing](../src/manifests.ts) and [release IO](../src/release-io.ts)
construct a detached prepared commit containing released versions, dependency
edits and optional changelogs. Package tags point there while the source branch
stays at its original commit. This preserves development history while making
the released manifest state available through Git.

Canonical prepared manifests preserve workspace protocols and materialize
inherited Cargo versions. [Packaging](../src/registries.ts) uses isolated,
Git-aware copies: npm artifact manifests convert local protocols into publishable
requirements, and native Cargo packaging verifies normalized crate contents.
Scripts run during the initial pack; retries reuse retained bytes. Ignore
selection and build outputs are preserved without allowing packaging changes
or lockfiles to become source edits.

Staged Cargo dependencies omit the registry name only for the built-in crates.io
index. Custom indexes retain their explicit names, including a configured
`crates-io` alias. Versionless Cargo dev dependencies retain their local-only
meaning: planning does not add a version, and isolated packaging omits them
before workspace members are excluded. Shared workspace definitions still serve
runtime consumers.

Cargo staging selects the release crate as the sole workspace member and excludes
unrelated crates. It keeps ancestor paths out of the exclusion list because Cargo
may parse their inherited metadata while finding the workspace root, even when
an ancestor package is private.

Prepared commits and exact archives are retained in immutable Git refs.
Artifacts include public metadata and SHA-256/SHA-512 integrity proofs; their
commit must have the expected prepared commit as parent. Checks bind each
artifact to its package, source and release scope. A matching archive name or
version alone is insufficient. Git-backed artifacts are limited to 100 MiB;
an existing immutable ref is accepted only for identical content.

Release files are temporarily applied with atomic replacement. Cleanup restores
original bytes and removes newly generated changelogs. Startup recovery accepts
only expected paths containing original or prepared bytes. It rejects user edits
and symlink replacements instead of assuming every dirty file is release-owned.

## Recoverable publication

[Publication](../src/publication.ts) freezes destinations and checks all package
versions for conflicts before recording the batch as pending. Before each upload,
it retains the archive and persists an upload intent. It then reads the registry's
npm integrity or Cargo index checksum: a successful HTTP response is insufficient
proof, and a lost response is not proof of failure.

An existing version is recoverable only when its bytes match the retained
artifact and this batch recorded intent. Foreign versions fail even if their
bytes match. Publication and tag progress are persisted separately, so a failed
tag push can resume without uploading again. Delayed registry visibility leaves
pending work at the same source commit. Published versions are irreversible;
recovery finishes remaining steps instead of attempting a registry rollback.

A fresh clone fetches journals and retained refs to reconstruct this state.
Changed plans, destinations, authentication policies, prepared commits or artifact
proofs block recovery. Missing/malformed journals and conflicting tags also stop
the run; deleting state does not restart a completed release. Completion follows
publication, package tags and cleanup. A later reporting-hook failure can fail
the command after this plugin has already recorded completion.

All release jobs for a repository must be serialized, including different
branches. Normal Git pushes reject conflicting journal histories, but are not a
distributed lock around registry writes. Dry runs can fetch Git metadata and
inspect promotion proofs; they do not prepare files, pack, push release state,
upload, request identities or sign.

## Durable journals and channel compatibility

[Journal validation](../src/journal.ts), [planning validation](../src/plan-validation.ts)
and [execution validation](../src/publication-state.ts) reject inconsistent state
before it becomes a baseline. Schema 1 contains batch lifecycle state; schema 2
adds plans, versions and dependency projections; schema 3 adds the prepared
commit, destinations and publication progress. Retained release notes are optional
for older journals. All three schemas remain readable.

Current branch journals attach to the repository's single root commit; completed
archives attach to each source commit. Retain all release-state refs in backups
and mirrors, alongside ordinary branches and tags:

| Ref                                                                           | Purpose                              |
| ----------------------------------------------------------------------------- | ------------------------------------ |
| `refs/notes/semantic-release-workspace`                                       | Compatible primary-branch journal    |
| `refs/notes/workspace-release-branches/<branch-hash>`                         | Other branch journals                |
| `refs/notes/workspace-release-history/<branch-hash>`                          | Completed source plans               |
| `refs/notes/workspace-release-channels/<branch-hash>`                         | Promotion intent/progress            |
| `refs/notes/semantic-release-0-workspace`                                     | Core-compatible coordinator channels |
| `refs/semantic-release-workspace/prepared/[<scope>/]<source>`                 | Immutable prepared commit            |
| `refs/semantic-release-workspace/artifacts/[<scope>/]<source>/<package-hash>` | Archive and metadata                 |

A release-route digest scopes prepared/artifact refs when branches or channels
require distinct releases from the same source. New journal/history/promotion
refs avoid core's semantic-release notes prefix. The compatibility channel ref
intentionally sorts before other core notes: core's commit-level reader can
otherwise mistake a root journal for channel data or lose channels when multiple
prerelease tags share a source commit. [Channel notes](../src/channel-notes.ts)
merge channels during normal releases. Unreadable legacy metadata is repaired
before a normal run stops with `EWORKSPACECHANNELRETRY`; rerun so core reloads
its tags without changing the frozen batch. Dry runs report the required repair
without writing it.

## Credentials and provenance preserve the original release identity

[npm identity](../src/npm-identity.ts) and [Cargo identity](../src/cargo-identity.ts)
policies select configured credentials or OIDC, freezing the decision in each
destination. Automatic retries retain the original policy when CI gains identity
credentials. Selected OIDC exchange failures never fall back. npm exchanges per
package immediately before upload. Cargo shares one exchange per frozen API per
invocation to accommodate single-use CI identities, stops reusing it after
25 minutes and revokes acquired tokens during cleanup. Failed revocation keeps
the batch pending; crash recovery relies on upstream expiry, not saved credentials.

Exchanged upload tokens stay in memory and never enter package scripts, registry
read probes, journals or artifacts. Native read credentials remain separate.
[npm transport](../src/npm-registry.ts) preserves native authentication and TLS
settings while binding requests to the frozen registry origin. Identity,
exchange, signing and Cargo credential-bearing requests reject redirects.
Subprocess output and authenticated URLs are withheld from release errors.

[Provenance](../src/npm-provenance.ts) binds exact tarball bytes, package/version
and source identity through an npm-compatible statement and verified Sigstore
bundle. The official SDK and TUF verification check certificates and transparency
proofs; a forwarding gateway rejects redirects for SDK signing traffic. Custom
service URLs and the trusted-root digest are frozen. The verified public bundle
is retained before upload intent, and registry confirmation requires that same
attestation alongside tarball integrity. Exact bundle reuse preserves the
original CI run, avoids additional signing ledger entries, and lets an accepted
uncertain upload finish without fresh CI credentials. Retries and promotions
must not re-sign old bytes as a new build.

Registry proof comparisons account for two equivalent
[ProtoJSON defaults](https://protobuf.dev/programming-guides/json/#presence-and-default-values):
an empty DSSE signature `keyid`, and an empty `rfc3161Timestamps` array inside an
existing `timestampVerificationData` object. Only these fields normalize before
strict comparison; message presence, unknown fields, and cryptographic evidence
remain significant. The retained original bundle stays unchanged.

## Channels and release output are part of the frozen plan

[Branch policy](../src/branches.ts) enforces package maintenance boundaries and
cross-branch allocations independently of coordinator versions. Pending stable
batches reserve coordinator allocation across stable branches; prerelease
identifiers keep separate histories and counters. npm channels become dist-tags,
while Cargo records membership through SemVer and Git history.

[Promotion](../src/channels.ts) verifies every original artifact and registry
proof before moving any npm channel. It includes versions unchanged in the latest
batch and preserves newer published ancestor versions on the destination branch.
Selected package versions are frozen in the promotion intent for retries, and
planning-only records cannot satisfy publication proof. Cargo versions are reused
without uploading. Intent is persisted before
core records its channel, allowing startup recovery even when core no longer
calls `addChannel`. Promotion does not pack, upload or sign again.

[Release notes](../src/release-notes.ts) use attributed commits and source dates;
[optional changelogs](../src/changelogs.ts) retain exact before/after bytes in the
journal and prepared commit. Packages sharing a directory share a changelog.
Eligible released history is carried forward, with source edits taking precedence
and stable/prerelease histories distinct. Package moves follow identity to prior
changelog paths for snapshot verification and write the accumulated history at
the new path. Co-located histories retain a verified common suffix only once.
Pending retries reuse exact notes and
reject a changed changelog policy. Promotions reuse historical notes without
adding changelog entries.

## Verify protocols through real local lifecycles

The [tests](../test/) run actual semantic-release subprocesses, disposable bare
Git remotes and native npm/Cargo packers. Local registry, CI identity, mutual-TLS
and signed Sigstore/TUF fixtures exercise protocols without public publication or
real credentials. Assertions cover durable refs, exact archives, source restoration,
no-change/dry-run behavior and fresh-clone recovery under rejected writes, lost
responses, process termination and corrupt state. This verifies the boundary
where core hook order, Git persistence and registry uncertainty meet, using the
real coordinator. Commands and prerequisites belong in
[CONTRIBUTING](../CONTRIBUTING.md).
