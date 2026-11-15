# Migrate from shared repository tags

Use this guide when an existing semantic-release setup releases workspace
packages under one repository tag, such as `v2.4.0`, and you want independent
package versions. Keep your old tags and GitHub releases.

A shared tag is **not** a package baseline for this plugin. Declared manifest
versions supply a version number but do not mark historical commits as released.
Without package baselines, the first run can analyze old features and breaking
changes again.

## 1. Establish the last completed release

Pause the old release workflow and finish any pending publication. Start from a
completed stable release, with full Git history and tags available.

For each already-published workspace member, identify:
- Its exact package name and ecosystem.
- Its last published version, verified against its registry.
- The reachable source commit that produced that version.

The commands below assume both `@acme/core` and `@acme/app` were published at
`2.4.0` from `v2.4.0`. If versions or release commits differ, use each package's
actual version and commit. Do not infer publication merely from the shared tag.

JavaScript packages must be workspace members: the root JavaScript package is
not published by this plugin. If your old setup publishes only the root package,
keep ordinary semantic-release or move that package into a workspace first.
Cargo root crates are supported.

## 2. Seed package baseline tags

Create additional tags at the **old release commit**, not the migration commit
or current HEAD:

```sh
git fetch origin --tags

git tag 'npm/@acme/core@2.4.0' 'v2.4.0^{commit}'
git tag 'npm/@acme/app@2.4.0' 'v2.4.0^{commit}'

git push origin \
  'refs/tags/npm/@acme/core@2.4.0' \
  'refs/tags/npm/@acme/app@2.4.0'
```

For Cargo, the equivalent is:

```sh
git tag 'cargo/my-crate@2.4.0' 'v2.4.0^{commit}'
git push origin 'refs/tags/cargo/my-crate@2.4.0'
```

Repeat for every already-published package, including unchanged members.
Do not overwrite existing package tags or seed versions that were never
published. New packages with no publication history need no migration tag.

These tags set both the package's version baseline and the boundary of already
released commits. They do not upload packages, rewrite old tags, or import
retained artifacts/journals from the old system.

## 3. Replace the release configuration

Install compatible release tools in the repository root:

```sh
npm install --save-dev 'semantic-release@^25.0.9' semantic-release-workspace
```

Use the [supported Node runtime](../README.md#quick-start). Keep your workspace
definitions, source-controlled dependency requirements, and package-manager
lockfile. Commit installation and configuration changes as `chore:` changes.

For a repository releasing from `main`, use `release.config.mjs`:

```js
export default {
  branches: ['main'],
  tagFormat: 'workspace-v${version}',
  plugins: [
    ['semantic-release-workspace', { changelog: true }],
    // Optional, if installed: '@semantic-release/github',
  ],
};
```

Use your actual stable branch name. The exact coordinator `tagFormat` is
required; it intentionally leaves your old `v…` tag namespace intact.

Remove separate root commit-analysis, notes-generation, and npm-publishing
plugins. This plugin owns those steps. Replace root changelog/git commit plugins
with the optional `changelog` setting if appropriate: versioned manifests and the
root changelog live in prepared commits referenced by package tags, **not commits
pushed to your source branch**.

The optional GitHub plugin goes after the workspace plugin and creates one
aggregate release per coordinator batch, with package sections. It does not
convert or delete your historical GitHub releases.

## 4. Verify the cutover

On a clean checkout of the configured release branch:

```sh
npm exec -- semantic-release --dry-run
```

With all baselines seeded and no unreleased package changes, expect **no release**.
Any package changes after its baseline remain eligible and should appear in the
preview. Investigate unexpected packages or version jumps before publishing.
Use `--dry-run`, not `publish: false`, which records planning history.

For example, after both packages were released at `2.4.0`, a new
`fix(core): repair an API` touching only core should produce:

| Item                            | Result                                 |
| ------------------------------- | -------------------------------------- |
| core                            | `2.4.1`, tagged `npm/@acme/core@2.4.1` |
| app                             | Remains `2.4.0`; no upload             |
| app's explicit core requirement | Unchanged                              |
| First coordinator batch         | `workspace-v1.0.0`                     |

The batch version is independent of the package versions. Choose dependency
upgrades yourself and commit the dependent package's manifest change with a
release signal. See [version and dependency rules](reference.md#package-versions-and-dependencies).

## 5. Enable the new workflow

Use one serialized release job for the whole repository. Install/build package
dependencies, fetch full history, and allow pushes of tags, Git notes, and
`refs/semantic-release-workspace/*`. Configure registry credentials or a trusted
publisher for each package/crate; update trust settings if the workflow filename
or environment changes. See the [CI example](examples.md#github-actions-with-oidc).

After publication, a fresh-clone rerun at the same source should publish nothing
new. Preserve release state and follow [recovery instructions](reference.md#recovery-and-backups)
if a new batch fails.

This recipe covers a stable-branch cutover. For existing prerelease or maintenance
branches, check package baselines and ancestry on each branch before enabling
releases; do not apply one stable tag blindly to every branch. Seeded historical
tags do not reconstruct the artifacts needed to recover or promote old
publications through the new plugin.
