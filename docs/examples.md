# Workspace examples

Use these files in your own repository, together with the
[quick-start release config](../README.md#quick-start). Choose one JavaScript
workspace definition; Cargo can coexist with any of them. Examples use stable
releases from `main`; add an RC branch only when you need it.

## JavaScript packages

All three JavaScript examples use this layout:

```text
package.json
release.config.mjs
packages/
  core/package.json
  core/index.js
  app/package.json
  app/index.js
```

For `packages/core/package.json`:

```json
{
  "name": "@your-scope/core",
  "version": "1.0.0",
  "type": "module",
  "exports": "./index.js",
  "files": ["index.js"],
  "publishConfig": { "access": "public" }
}
```

For `packages/app/package.json`, use the same fields with
`"name": "@your-scope/app"` and `"version": "2.0.0"`.
Both `index.js` files can start with `export const value = 1;`.
Replace the package scope with one you own before publishing.
The examples start without inter-package dependencies. To adopt a released core
version later, add an explicit requirement such as
`"dependencies": { "@your-scope/core": "^1.1.0" }` to app and commit it with
`fix(app): adopt core 1.1.0`. Update the lockfile with your package manager.

### npm

Root `package.json`:

```json
{
  "name": "workspace-example",
  "private": true,
  "workspaces": ["packages/*"]
}
```

Install release tools with the npm command in the quick start. Commit
`package-lock.json`; use `npm ci` in CI.

### pnpm

Root `package.json`:

```json
{
  "name": "workspace-example",
  "private": true,
  "packageManager": "pnpm@12.15.0",
  "engines": { "node": "^24.22.3 || >=26.13.1" },
  "devEngines": {
    "runtime": { "name": "node", "version": "24.22.3", "onFail": "download" }
  }
}
```

Root `pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
```

Install with `pnpm add -Dw 'semantic-release@^25.0.9' semantic-release-workspace`.
Commit `pnpm-lock.yaml`; use `pnpm install --frozen-lockfile` in CI.
The runtime pin also supplies Node to the workflow below.

### Yarn

Use npm's root manifest with `"packageManager": "yarn@4.18.1"` added.
Install with `yarn add -D 'semantic-release@^25.0.9' semantic-release-workspace`.
Commit `yarn.lock` and use `yarn install --immutable` in CI.
Launch with `yarn exec semantic-release`. For this example, set
`nodeLinker: node-modules` in `.yarnrc.yml`; the installed npm executable
is used for package archives.

## Cargo

Root `Cargo.toml`:

```toml
[workspace]
members = ["crates/*"]
resolver = "3"
```

For `crates/core/Cargo.toml`:

```toml
[package]
name = "your-project-core"
version = "1.0.0"
edition = "2024"
license = "MIT"
description = "Core library for your project"
```

Add `crates/core/src/lib.rs`:

```rust
pub fn value() -> u8 { 1 }
```

Create app by copying the crate to `crates/app/`, changing its name to
`your-project-app` and version to `2.0.0`. Replace names with your own before
publishing. `publish = false` marks a private crate.

Even a Cargo-only repository needs Node and semantic-release. Add a private root
`package.json` (for example the pnpm manifest above), install the release tools,
and commit their lockfile. For Cargo-only repos, use
`pnpm add -D 'semantic-release@^25.0.9' semantic-release-workspace` without
`-w`, or the npm install command from the quick start. No JavaScript workspace
declaration is needed.

For manual upgrades, add an explicit Cargo version requirement to app.
If you also specify a local `path`, its crate's source version must satisfy the
requirement. Publishing does not advance source versions; see
[Cargo dependency requirements](reference.md#package-versions-and-dependencies).

## Mixed npm and Cargo

Combine any JavaScript example with the Cargo example in the same repository.
Keep `packages/*` for JavaScript and `crates/*` for Rust; use one root
`release.config.mjs` and one release job.

A commit touching only `packages/core/index.js` selects the npm core package.
A commit touching only `crates/core/src/lib.rs` selects the Cargo core crate.
Matching names do not synchronize versions across ecosystems.

## Changelog and GitHub release

Install `@semantic-release/github` as a root dev dependency, then use:

```js
export default {
  branches: ['main'],
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

This produces one aggregate GitHub release per batch, with package sections,
and retains one root changelog in the prepared commit. It does not push generated
files to your source branch. Omit the GitHub plugin to publish packages without
GitHub releases. Details: [notes and changelogs](reference.md#release-notes-and-changelogs).

## GitHub Actions with OIDC

This workflow uses the pnpm example's toolchain fields and committed lockfile.
Save it as `.github/workflows/release.yml`:

```yaml
name: Release
on:
  push:
    branches: [main]

permissions:
  contents: write
  id-token: write

concurrency:
  group: workspace-release
  cancel-in-progress: false

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0
          persist-credentials: false
      - uses: pnpm/setup@a0881977cd8ea73b1ed212236c99ca10dcc80cf4 # v3.1.1
        with:
          cache: true
          require-lockfile: true
      # Add your project's tests and build steps before publishing.
      # For Cargo/mixed repos, also install your Rust toolchain.
      - run: pnpm exec semantic-release
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

For npm/Yarn, replace the setup step with Node setup and the corresponding frozen
install command above; replace the final command with
`npm exec -- semantic-release` or `yarn exec semantic-release`.
Keep full history, permissions, and the branch-independent concurrency group.
Make your required tests and build succeed before the publication step.

Before enabling this workflow, configure a trusted publisher **per package/crate**
with your repository and exact filename `release.yml`; no environment is used
here. For npm, allow direct `npm publish` and, for channel promotions,
`npm dist-tag`. New packages/crates need an initial authenticated publication
before trust can be configured. See
[npm's guide](https://docs.npmjs.com/trusted-publishers/) and
[crates.io's guide](https://crates.io/docs/trusted-publishing).

The plugin selects OIDC automatically in supported CI. For public npm packages
in public repositories, provenance is automatic too. No publish token is needed
once trust is configured; private dependency installation may still need read
credentials. For required OIDC/provenance and alternate registries, see the
[publishing reference](reference.md#trusted-publishing-and-provenance).

## Try a change

Commit initial setup as `chore: set up workspace`. Then change core's source
and commit `feat(core): add an API`. On `main`, run the quick-start dry-run command
(or your package manager's equivalent). Expect core 1.1.0, app unchanged,
and no new tags or uploads. In a mixed repo, only the ecosystem whose source you
changed releases.

After credentials and CI are configured, pushing that release commit publishes
the selected package. Retrying a completed release without new changes publishes
nothing. An interrupted release must be retried from the same source commit and
configuration; see [recovery](reference.md#recovery-and-backups).

## uv

```toml
# pyproject.toml — virtual root
[tool.uv.workspace]
members = ["packages/*"]
exclude = ["packages/scratch"]
```

```toml
# packages/core/pyproject.toml
[project]
name = "example-core"
version = "1.2.0"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"
```

Add the package source at `packages/core/src/example_core/__init__.py`.

```js
// release.config.mjs
export default {
  branches: ['main'],
  tagFormat: 'workspace-v${version}',
  plugins: [
    [
      'semantic-release-workspace',
      {
        python: { trustedPublishing: true },
      },
    ],
  ],
};
```

A `feat: add core API` commit touching `packages/core` selects
`python:example-core` at `1.3.0`. Preview with `pnpm exec semantic-release --dry-run`.
A normal run builds a wheel and source distribution, publishes to PyPI and creates
`python/example-core@1.3.0`. Explicit dependencies and `uv.lock` remain unchanged.
Use `publish: false` for planning-only operation.

Use the [GitHub Actions workflow](#github-actions-with-oidc), adding uv before the
release step:

```yaml
- uses: astral-sh/setup-uv@68559e99cc807c1eb7e9238fd43a15bba460eec2 # v10.3.3
  with:
    version: "0.13.9"
    python-version: "3.15.2"
- run: |
    uv python install 3.15.2
    echo "$(dirname "$(uv python find 3.15.2)")" >> "$GITHUB_PATH"
```

Configure a PyPI trusted publisher for `example-core` using your real project name,
repository and `release.yml` workflow. If you set an environment on the publisher,
set the same environment on the release job. Python-only repositories still need
Node, semantic-release and this plugin; npm/Cargo and Python members can coexist.
See [Python publishing](reference.md#python-publishing) and
[supported versions and discovery rules](reference.md#uv).
