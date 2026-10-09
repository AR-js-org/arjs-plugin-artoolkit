# Maintainers guide

Releases follow the shared process in
[AR.js-next's MAINTAINERS.md](https://github.com/AR-js-org/AR.js-next/blob/main/MAINTAINERS.md):
one milestone per version (`v0.3.0`), tracked on the
[AR.js-next roadmap](https://github.com/orgs/AR-js-org/projects/2) project, and
a release issue opened from the "Release" template. This document records
what is specific to this repository.

## How a release is cut here

Releases are cut by **pushing a tag**, unlike artoolkit5-ts, which dispatches
a workflow that creates the tag itself. Two independent workflows fire on
`v*.*.*`:

| Workflow      | Does                                                           |
| ------------- | -------------------------------------------------------------- |
| `release.yml` | Builds, zips `dist/` and `types/`, creates the GitHub Release  |
| `publish.yml` | Publishes to npm over OIDC trusted publishing, with provenance |

1. **The version bump is manual.** No workflow bumps `package.json`; carry
   the bump on `dev` ahead of the release
   (`npm version X.Y.Z --no-git-tag-version`). `publish.yml` refuses a tag
   that disagrees with `package.json`. The same commit dates the changelog
   (see [Changelog](#changelog)).
2. Merge `dev` → `main`.
3. **Tag after the merge**, on `main`. Both workflows run the files as they
   exist at the tagged commit, so tagging first silently runs the previous
   release's workflows.
4. **Re-sync `dev`** with `git merge --ff-only origin/main`: GitHub's merge
   commit exists only on `main`, and a branch cut from a stale `dev` thinks it
   is on the previous version.
5. Confirm the publish from the run log line `+ @ar-js-org/arjs-plugin-artoolkit@X.Y.Z`.
   `npm view` lags by minutes after a successful publish; do not read the lag
   as a failure.

## Changelog

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
PRs with a user-visible change add their entry under `## [Unreleased]` as they
land (see AGENTS.md, "Pull requests"), so at release time the section only
needs checking and dating:

1. Check `## [Unreleased]` against the milestone's closed issues and merged
   PRs. Every breaking change is marked **Breaking** and says what consumers
   must change.
2. In the version-bump commit, rename it to `## [X.Y.Z] - YYYY-MM-DD` and add
   a new, empty `## [Unreleased]` above it.
3. Update the compare links at the bottom: `[Unreleased]` becomes
   `…/compare/vX.Y.Z...HEAD`, and add `[X.Y.Z]: …/compare/v<previous>...vX.Y.Z`.

## Recovering a partial release

The workflows are independent on purpose: a failed npm publish does not lose
the release assets.

- Re-run `publish.yml` alone via `workflow_dispatch` with `tag: vX.Y.Z`. Its
  guards refuse a tag that is not `vX.Y.Z`, disagrees with `package.json`, or
  is already on npm.
- `release.yml` runs on tag pushes only; it has no manual dispatch (#39). To
  rebuild or re-attach the assets, open the run the tag push started and use
  **Re-run all jobs**: the re-run keeps the tag as its ref, and the upload
  replaces the existing assets (`gh release upload --clobber`).

## Trusted publishing traps

- **Do not set `registry-url` on setup-node** in `publish.yml`. It writes an
  `.npmrc` with `_authToken=${NODE_AUTH_TOKEN}`; with no token npm believes
  auth is configured and never performs the OIDC exchange. npm's own example
  workflow includes it, so it is easy to reintroduce by copying the docs.
- **`publish.yml` must use Node 24.x**, stated in the workflow rather than read
  from `.nvmrc`. Trusted publishing needs npm ≥ 11.5.1, which Node 22's npm 10.9
  is not. `.nvmrc` pins Node 24 as well, but publishing must not depend on it.
- npm authorises per workflow **filename** and does not validate the trusted
  publisher configuration when it is saved. Renaming `publish.yml` breaks
  publishing silently until the next release.

## Do not publish by hand

`dist/` and `types/` are built by the workflows. A manual `npm publish` works
but carries no provenance attestation (0.1.3 has none for that reason).

Do not commit them either. Both are gitignored, and the version-bump commit
before a tag carries no build output: never `git add -f` `dist/` or `types/`
into it.

## Known failure modes

- If `release.yml` fails at _Download build artifacts_, pin
  `upload-artifact`/`download-artifact` back to `@v4`; the pairing only runs
  on a tag push, so CI never exercises it.
