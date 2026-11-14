# Contributing

[AGENTS.md](AGENTS.md) summarizes these conventions for coding agents.

## Set up a checkout

Fork [semantic-release-workspace](https://github.com/enkhjile/semantic-release-workspace),
then clone your fork and create a branch from `main`:

```sh
git clone https://github.com/YOUR-USER/semantic-release-workspace.git
cd semantic-release-workspace
git remote add upstream https://github.com/enkhjile/semantic-release-workspace.git
git switch main
git switch -c fix/describe-your-change
pnpm install --frozen-lockfile
pnpm check
```

The published package supports **Node.js 24.11.0 and newer**, as declared by
`engines.node` in [package.json](package.json). That file is also the source of
truth for the exact development Node version (`devEngines.runtime`) and pnpm
version (`packageManager`).
Install pnpm using its [installation guide](https://pnpm.io/installation).
Installation downloads the declared Node runtime when needed, and project scripts
use it automatically. Commit `pnpm-lock.yaml` with dependency changes.

The full test suite also needs Git, npm, OpenSSL, and stable Rust with Cargo on
`PATH`. CI installs stable Rust before testing; local Cargo tests need the same
toolchain. See the [Rust installation guide](https://www.rust-lang.org/tools/install).

## Development commands

| Command                 | Purpose                                                    |
| ----------------------- | ---------------------------------------------------------- |
| `pnpm check`            | Run lint, strict type checking, then the build and tests.  |
| `pnpm test`             | Build, then run both test projects with four workers.      |
| `pnpm test:unit`        | Run in-memory unit tests without building or Rust.         |
| `pnpm test:integration` | Build, then run all integration tests.                     |
| `pnpm build`            | Compile the ESM entry point and declarations into `dist/`. |
| `pnpm lint`             | Check formatting and lint rules with Biome.                |
| `pnpm format`           | Apply formatting and safe lint fixes; review the result.   |
| `pnpm typecheck`        | Run strict TypeScript checks without emitting files.       |
| `pnpm pack`             | Build and create a publishable tarball for inspection.     |

For focused runs, select the project and file explicitly. Unit tests need no
build; integration tests load the public package from `dist/`:

```sh
pnpm exec vitest run --project unit test/coordination.test.ts --maxWorkers=4
pnpm build
pnpm exec vitest run --project integration test/publication.test.ts --maxWorkers=4 -t 'dry run'
```

Vitest projects in `vitest.config.ts` separate unit and integration tests.
Unit tests are pure in-memory coordination and manifest editing.
Tests using filesystem fixtures, Git, native packaging, or local servers belong
to integration. New test files default to integration so they cannot silently
fall outside CI; add genuinely pure files to the unit list when appropriate.
Use `--project unit` or `--project integration` to select a suite.

Use Vitest's file arguments and `-t` name filter. Do not use `pnpm test --filter`
to select tests: `pnpm test` runs a compound build-and-test script. Keep the
four-worker limit used by CI; integration cases launch several real release and
packaging processes each. Use fewer workers when local resources are limited.

Tests use disposable Git repositories and remotes, local npm/Cargo registries,
mutual TLS, and local Sigstore/TUF fixtures. They require no real publishing
credentials and make no public registry writes. Keep new test fixtures local and
avoid scripts with external side effects.

Reproduce release regressions through real `semantic-release` runs. Check the
published artifact as well as the plan when manifests change, and cover dry-run
side effects and fresh-clone recovery when release state is involved.
Use the public package entry point and native npm/Cargo archives to test packaging.
Assert dependency requirements and release metadata inside the published artifact,
not just the plan. Authentication tests must use local identity and registry
fixtures; GitHub release tests must use a local API fixture.

## Try local changes in a consumer repository

Build a tarball from this checkout:

```sh
pnpm pack
```

Then install it in a disposable consumer repository, replacing the path:

```sh
npm install --save-dev 'semantic-release@^25.0.9' /absolute/path/to/semantic-release-workspace-0.0.0-development.tgz
```

Use local registry fixtures for publication tests. Remove the generated tarball
when finished.

## Make a reviewable change

- Prefer small, clear TypeScript changes that follow nearby code and Biome rules.
- Keep strict null, optional-property, and indexed-access checks meaningful.
- Test observable behavior, including failures, recovery, and side-effect order.
- Update the [README](README.md) when user-facing behavior or configuration changes.
- For code or packaging changes, run `pnpm check` and inspect `pnpm pack` output.
  For docs-only changes, validate links, examples, and formatting. Report what
  you checked and any checks you could not run; do not claim unverified results.
- Open a focused pull request against `main`, explain the problem and resulting
  behavior, and include relevant validation. Maintainers promote reviewed changes
  to `rc` for release candidates.

Use Conventional Commits for commits and squash-merge PR titles: `fix:` requests
a patch release, `feat:` a minor release, and a `BREAKING CHANGE:` footer a major
release. `chore:`, `docs:`, and `test:` do not release by default.

If you use AI tools, you remain responsible for understanding and reviewing the
change, checking its correctness, running appropriate tests, and ensuring you
have the right to contribute its contents. Contributions are part of this
[MIT-licensed project](LICENSE); do not include code or data you cannot share.

## Maintainer releases

This section describes releases of this plugin itself. Its
[release.config.mjs](release.config.mjs) uses standard semantic-release plugins.
The workspace plugin's consumer setup is documented in the [README](README.md).
The checkout version is a development placeholder: publishing writes release
versions and records them in tags and GitHub release notes, without committing
generated version changes back to the source branch.

The [CI workflow](.github/workflows/ci.yml) uses native path filters to skip PRs
and `release`/`rc` pushes changing only root `README.md`, `CONTRIBUTING.md`,
`AGENTS.md`, or Markdown under `docs/`. Mixed code/docs changes run CI.
[Full verification](.github/workflows/verify.yml) runs lint, types, build, unit
tests, all integration tests and packaging on minimum, project and latest stable
Node. Manual runs always perform full verification. Ordinary feature branch
pushes do not duplicate PR runs; open a draft PR for feedback.

The npm trusted publisher is bound to `ci.yml`; changing that filename requires
updating the trust configuration.
Release jobs require successful full verification on the merged commit and are
serialized without cancelling an in-flight publication. PRs never publish.
Docs-only changes start no tests or release attempt. A path-filtered workflow
can leave a required branch-protection check pending when skipped; account for
that behavior when configuring repository rules.
`release` publishes stable versions to npm's `latest` tag; `rc` publishes versions
such as `1.0.0-rc.1` to `rc` and creates GitHub prereleases.
`main` is the development branch and never publishes npm versions. Promote reviewed
`main` work into `rc` with a merge commit to publish a release candidate. When ready
for a stable release, merge `rc` into `release`, then backmerge `release` into `rc` and
`rc` into `main`. Preserve the ancestry of these long-lived branches rather than
squashing their promotion or backmerge. semantic-release derives versions from
commits and release history; a backmerge containing no unreleased changes does
not request another release.
Users can install prereleases with
`npm install semantic-release-workspace@rc`.

The npm CLI is a pinned development dependency so semantic-release uses the
project's OIDC-capable client consistently across runners.

The GitHub plugin keeps releases enabled while limiting issue/PR automation:

| Option in `release.config.mjs` | Effect                                                             |
| ------------------------------ | ------------------------------------------------------------------ |
| `successComment: false`        | Do not comment on released issues or pull requests.                |
| `failComment: false`           | Do not open or update release-failure issues.                      |
| `failTitle: false`             | Disable opening release-failure issues by title.                   |
| `releasedLabels: false`        | Do not add release labels to issues or pull requests.              |
| `addReleases: false`           | Do not append other publishing plugins' links to the release body. |

GitHub releases still contain generated release notes. See the
[GitHub plugin options](https://github.com/semantic-release/github/tree/v12.0.10#options).
The release job grants `contents: write` for GitHub releases and `id-token: write`
for npm OIDC, and supplies `GITHUB_TOKEN`.

Maintainers must keep the npm trusted publisher aligned with this repository and
`ci.yml`, and preserve its publication permissions when changing release setup.

`pnpm release:dry-run` requires a configured repository, remote, and authentication
and can contact external services. Maintainers should use it before a
release-triggering push. `pnpm release` can publish packages, push tags, and create
GitHub releases; neither release command is a routine contributor check.

## Dependency review and cleanup

Run `pnpm audit` when reviewing dependencies and before a release. Check current
advisories and affected dependency paths; an old clean audit is not evidence for
the current lockfile. Report unresolved findings and assess compatible fixes
without weakening the supported Node range or bypassing integration tests.

Routine verification uses local fixtures, not public test publications. Live
registry tests and destructive remote cleanup require explicit authorization;
use designated test packages and obtain maintainer approval for public writes.
Retry unfinished releases with their original source, configuration and retained artifacts. Never
delete journals or rewrite tags to bypass a pending batch; see
[recovery and backups](README.md#recovery-and-backups).

After verification, stop local fixture servers and remove temporary clones,
downloaded archives, `pnpm pack` tarballs and task-created Cargo targets. Preserve
shared caches, other checkouts, and release-state refs. Published package versions
are not temporary test files.
