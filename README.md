# semantic-release-workspace

Release npm, Cargo, and Python uv workspaces with semantic-release. Each package
gets its own version, based on Conventional Commits that touch its files.
- Discover pnpm, npm, Yarn, Cargo, uv, and mixed workspaces.
- Release changed packages; choose dependency upgrades yourself.
- Publish through OIDC, with retained artifacts for interrupted-release recovery.
- Generate one root changelog and optional aggregate GitHub releases.

Python packages use static `project.version` values and native uv builds.
See [PyPI trusted publishing](https://github.com/enkhjile/semantic-release-workspace/blob/main/docs/reference.md#python-publishing) for setup.

## What gets released?

Starting with core at 1.0.0 and app at 2.0.0:

| Commit and changed files                              | Result                                                         |
| ----------------------------------------------------- | -------------------------------------------------------------- |
| `feat(core): add an API` in `packages/core/`          | core → 1.1.0; app unchanged                                    |
| `fix(app): adopt core 1.1.0` in app's manifest/source | app → 2.0.1; its committed dependency requirement is preserved |
| `docs: clarify usage`                                 | No release                                                     |

**Changed paths select packages, not commit scopes.** Releasing core does not
automatically release app or upgrade app's dependencies. Commit dependency and
lockfile updates yourself. Native local references such as `workspace:*` are
converted to registry requirements during packaging; use explicit version
requirements for manual upgrades.

## Quick start

Use Node.js **24.22.3+ within 24.x, or 26.13.1+** and run from your repository root.
Your repository needs a workspace definition; see the
[examples for each package manager](https://github.com/enkhjile/semantic-release-workspace/blob/main/docs/examples.md).

Install the stable release alongside semantic-release 25:

```sh
npm install --save-dev 'semantic-release@^25.0.9' semantic-release-workspace
```

For pnpm use `pnpm add -Dw`; for Yarn use `yarn add -D` (Yarn classic also needs
`-W`). Pass the same two package names and version requirement.
Commit the resulting manifest and lockfile.

Create `release.config.mjs`:

```js
export default {
  branches: ['main'],
  tagFormat: 'workspace-v${version}',
  plugins: ['semantic-release-workspace'],
};
```

Use your release branch instead of `main` if needed. The exact `tagFormat` is
required: semantic-release tracks release batches with `workspace-v…` tags,
while this plugin creates independent `npm/<name>@<version>`,
`cargo/<name>@<version>` and `python/<name>@<version>` package tags.
A batch version is not a package version.

The plugin handles commit analysis, manifests, notes, and publishing. Do not add
a separate root commit analyzer, notes generator, or npm publisher.

### Preview, then publish

From a clean checkout on a configured release branch:

```sh
npm exec -- semantic-release --dry-run
```

A dry run previews package versions and notes without uploads or release-state
writes. It may read Git and registry metadata; it does not validate trusted
publisher permissions. **`publish: false` is not a dry run**: it records planning
history. See [release modes](https://github.com/enkhjile/semantic-release-workspace/blob/main/docs/reference.md#release-modes).

Before enabling a release workflow:
- Fetch full Git history and allow pushes of tags, Git notes, and
  `refs/semantic-release-workspace/*`.
- Install workspace dependencies and build anything package scripts require.
  npm is needed for npm packaging; Rust/Cargo for crates; uv and Python for
  Python distributions.
- Configure publishing credentials or a trusted publisher for each public
  package. Private workspace members are not published.
- Serialize releases across the entire repository, including different branches.

Use the [GitHub Actions example](https://github.com/enkhjile/semantic-release-workspace/blob/main/docs/examples.md#github-actions-with-oidc)
to run `semantic-release` in CI. Package scripts can run during packaging.
On failure, retry the **same source commit and configuration**; retain release
tags, notes, and artifact refs for recovery.

## Changelogs and GitHub releases

Set `changelog: true` for one root `CHANGELOG.md`, with sections for each released
package. Add `@semantic-release/github` after the workspace plugin for one GitHub
release per batch. See the [copyable configuration](https://github.com/enkhjile/semantic-release-workspace/blob/main/docs/examples.md#changelog-and-github-release).

Versioned manifests and the changelog are retained in prepared commits referenced
by package tags. **The plugin does not commit these edits back to your source
branch.** Unchanged packages get no new changelog section.

## Documentation

- [Migrate from shared repository tags](https://github.com/enkhjile/semantic-release-workspace/blob/main/docs/migration.md)
- [Workspace and CI examples](https://github.com/enkhjile/semantic-release-workspace/blob/main/docs/examples.md)
- [Configuration reference](https://github.com/enkhjile/semantic-release-workspace/blob/main/docs/reference.md):
  discovery, version planning, npm/Cargo/Python publishing, branches, and recovery
- [Architecture](https://github.com/enkhjile/semantic-release-workspace/blob/main/docs/architecture.md)
- [Contributing](https://github.com/enkhjile/semantic-release-workspace/blob/main/CONTRIBUTING.md)
- [Release history](https://github.com/enkhjile/semantic-release-workspace/releases)

## Contributing and license

Issues and focused pull requests are welcome. See the contributing guide for
setup and verification. Licensed under [MIT](LICENSE).

## AI-assisted development

Code, tests, and documentation were developed with substantial AI coding
assistance. AI-generated output may contain mistakes; review the configuration
and validate behavior in your own release workflow.
