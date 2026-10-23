# semantic-release-workspace

Workspace-aware monorepo releases for semantic-release.

## Status

This repository contains the package foundation, development tooling, and
release pipeline. Workspace discovery and release lifecycle hooks are not
implemented yet; this scaffold is not a usable monorepo plugin.

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
