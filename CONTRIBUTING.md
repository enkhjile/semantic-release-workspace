# Contributing

## Set up a checkout

Fork [semantic-release-workspace](https://github.com/enkhjile/semantic-release-workspace),
then clone your fork and create a branch from `main`:

```sh
git clone https://github.com/YOUR-USER/semantic-release-workspace.git
cd semantic-release-workspace
git remote add upstream https://github.com/enkhjile/semantic-release-workspace.git
git switch -c fix/describe-your-change
pnpm install --frozen-lockfile
pnpm check
```

The published package supports **Node.js 24.0.0 and newer**, as declared by
`engines.node` in [package.json](package.json). That file is also the source of
truth for the exact development Node version (`devEngines.runtime`) and pnpm
version (`packageManager`); do not maintain separate version pins in this guide.
Install pnpm using its [installation guide](https://pnpm.io/installation).
Installation downloads the declared Node runtime when needed, and project scripts
use it automatically. Commit `pnpm-lock.yaml` with dependency changes.

The full test suite also needs Git, npm, OpenSSL, and stable Rust with Cargo on
`PATH`. CI installs stable Rust before testing; local Cargo tests need the same
toolchain. See the [Rust installation guide](https://www.rust-lang.org/tools/install).

## Development commands

| Command          | Purpose                                                    |
| ---------------- | ---------------------------------------------------------- |
| `pnpm check`     | Run lint, strict type checking, then the build and tests.  |
| `pnpm test`      | Build, then run the test suite with two workers.           |
| `pnpm build`     | Compile the ESM entry point and declarations into `dist/`. |
| `pnpm lint`      | Check formatting and lint rules with Biome.                |
| `pnpm format`    | Apply formatting and safe lint fixes; review the result.   |
| `pnpm typecheck` | Run strict TypeScript checks without emitting files.       |
| `pnpm pack`      | Build and create a publishable tarball for inspection.     |

For a focused test run, build first because integration tests import the public
package from `dist/`, then call Vitest directly:

```sh
pnpm build
pnpm exec vitest run test/coordination.test.ts --maxWorkers=2
pnpm exec vitest run test/publication.test.ts --maxWorkers=2 -t 'dry run'
```

Use Vitest's file arguments and `-t` name filter. Do not use `pnpm test --filter`
to select tests: `pnpm test` runs a compound build-and-test script. Keep the
two-worker limit; integration cases launch several real release and packaging
processes each.

Tests use disposable Git repositories and remotes, local npm/Cargo registries,
mutual TLS, and local Sigstore/TUF fixtures. They require no real publishing
credentials and make no public registry writes. Keep new test fixtures local and
avoid scripts with external side effects.

## Make a reviewable change

- Prefer small, clear TypeScript changes that follow nearby code and Biome rules.
- Keep strict null, optional-property, and indexed-access checks meaningful.
- Test observable behavior, including failures, recovery, and side-effect order.
- Update the [README](README.md) when user-facing behavior or configuration changes.
- For code or packaging changes, run `pnpm check` and inspect `pnpm pack` output.
  For docs-only changes, validate links, examples, and formatting. Report what
  you checked and any checks you could not run; do not claim unverified results.
- Open a focused pull request against `main`, explain the problem and resulting
  behavior, and include relevant validation. Maintainers can use `alpha` for
  prerelease work.

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
generated version changes back to `main`.

The [GitHub Actions workflow](.github/workflows/ci.yml) verifies the manifest's
development Node version and latest stable Node. Pushes to `main` and `alpha`
trigger verification and release; the release job runs only after both checks
pass, and never for pull requests. Manual workflow runs release only on those
branches. `main` publishes stable versions to npm's `latest` tag; `alpha`
publishes versions such as `1.0.0-alpha.1` to `alpha` and creates GitHub prereleases.
Merge ready alpha work into `main`; semantic-release derives the stable version
from commits and release history. Users can install prereleases with
`npm install semantic-release-workspace@alpha`.

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

Before enabling publishing, confirm the remote and package metadata match the
repository, confirm npm package-name availability, and configure npm trusted
publishing for this repository and workflow filename `ci.yml`. If npm requires
an initial publication before trusted-publisher setup, bootstrap it only when the
plugin is ready to use. Protect `main` with required verification checks.

`pnpm release:dry-run` requires a configured repository, remote, and authentication
and can contact external services. Maintainers should use it before a
release-triggering push. `pnpm release` can publish packages, push tags, and create
GitHub releases; neither release command is a routine contributor check.

## Historical toolchain and audit notes

The following records the **2026-10-23 snapshot**, not a fresh dependency audit.
Development tools were selected as exact stable releases. npm runtime clients
were kept on releases supporting the Node 24.0 floor; their newer majors then
required Node 24.15 or newer. Node typings stayed on Node 24 to avoid newer APIs.
tsdown warned that its TypeScript 7 API integration was experimental, while the
compiler itself was stable; build and declaration output were verified then.

At that review, [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
affected transitive `braces` used by semantic-release and fast-glob, and no patched
version was available. Cargo discovery disabled brace expansion; the remaining
semantic-release path accepted repository-controlled configuration. The finding
was deferred pending a compatible fix, with review due before publishing or by
2026-11-23, whichever came first. Reassess current advisories before publishing.
