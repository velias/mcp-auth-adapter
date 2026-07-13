# Releasing

## How release notes are generated

GitHub automatically generates release notes from **merged PRs** between the
previous tag and the new tag. For each PR, the **title** and **author** are
shown (the PR body is not included). PRs are grouped into sections based on
their GitHub **labels** (configured in `.github/release.yml`).

This means:
- All changes should go through PRs with **clear, descriptive titles**.
- Apply labels (`breaking`, `enhancement`, `bug`, `documentation`, etc.) to PRs
  so they are grouped correctly. Labels can be added **at any time before the
  release is created** -- not necessarily at merge time.
- Direct commits to `main` (not via PR) appear as raw commit hashes -- avoid
  these for user-visible changes.

After the release is created, you can **edit the notes in the GitHub UI** to
add context, highlight important changes, or remove noise.

## Prerequisites

- Push access to `main`
- [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated
  (`gh auth login`) -- used by `npm run changelog` to fetch release notes
- **npm Trusted Publisher** configured on npmjs.com -- see "Trusted Publisher
  setup" below. This is the primary publish mechanism: no long-lived npm
  tokens are stored in GitHub secrets.
- (Bootstrap only) For the very first publish of a new package, an `NPM_TOKEN`
  repository secret may be needed -- see "Initial npm token setup (bootstrap)"
  below.

## Steps

1. Ensure `main` is green (CI passing)
2. Review merged PRs since the last tag -- add/fix labels if needed
3. Run: `npm version patch|minor|major` (bumps version in package.json,
   creates git commit + `vX.Y.Z` tag)
4. Push: `git push origin main --follow-tags`
5. The `release.yml` workflow will automatically:
   - Run lint, test, build
   - Publish to npm with provenance
   - Create a GitHub Release with auto-generated notes
   - Build and push a container image to `ghcr.io/velias/mcp-auth-adapter`
     with tags `X.Y.Z`, `X.Y`, `X`, and `latest`
6. (Optional) Edit the GitHub Release notes in the UI to curate
7. Run `npm run changelog` to regenerate `CHANGELOG.md` from all GitHub
   Releases, then commit and push the result. This can also be re-run later
   if you edit release notes after the fact.

## Version guidance

- `patch` -- bug fixes, docs, internal refactors
- `minor` -- new features, non-breaking behavior changes
- `major` -- breaking changes (config format, removed features, API changes)

## Trusted Publisher setup

npm [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) uses
OpenID Connect (OIDC) so the GitHub Actions workflow can publish to npm
**without any long-lived npm token**. The npm registry verifies the
cryptographic identity of the workflow run instead of a stored secret.

The trusted publisher is bound to an **exact GitHub location** -- the specific
user/org, repository, and workflow filename must all match. This means only
the `release.yml` workflow in `velias/mcp-auth-adapter` can publish the
package; a fork or a different workflow file cannot.

### Configure on npmjs.com

1. Go to [npmjs.com/package/mcp-auth-adapter/access](https://www.npmjs.com/package/mcp-auth-adapter/access)
   (or: package page > **Settings** > **Publishing access**)
2. In the **Trusted Publisher** section, click **Add trusted publisher** and
   select **GitHub Actions**
3. Fill in:
   - **Organization or user**: `velias`
   - **Repository**: `mcp-auth-adapter`
   - **Workflow filename**: `release.yml` (filename only, not the full path;
     must include the `.yml` extension)
   - **Environment name**: leave empty (unless you add a GitHub Environment
     for deployment protection later)
   - **Allowed actions**: select `npm publish`
4. Click **Save changes**

All fields are **case-sensitive** and must exactly match the GitHub repository
and workflow file.

### Workflow requirements

The release workflow (`.github/workflows/release.yml`) already satisfies the
requirements:

- `id-token: write` permission is set on the publish job (required for OIDC
  token generation)
- `actions/setup-node` is configured with `registry-url: https://registry.npmjs.org`
- `npm publish --provenance --access public` is used (provenance is
  automatically generated with trusted publishing, but the explicit flag is
  harmless)
- A **GitHub-hosted runner** (`ubuntu-latest`) is used -- self-hosted runners
  are not supported for trusted publishing

Once the trusted publisher is configured on npmjs.com, the workflow will
authenticate via OIDC automatically. The npm CLI prefers the OIDC flow when
available, even if `NODE_AUTH_TOKEN` is also set.

> **Note:** Trusted publishing requires npm CLI >= 11.5.1. If the bundled npm
> in your Node.js version is older, add `npm install -g npm@latest` before
> the publish step.

### After verification

After confirming that a release publishes successfully via trusted publishing:

1. Remove the `NPM_TOKEN` secret from
   [GitHub repo secrets](https://github.com/velias/mcp-auth-adapter/settings/secrets/actions)
2. Remove the `NODE_AUTH_TOKEN` env var from the publish step in `release.yml`
3. Delete the old Granular Access Token from
   [npmjs.com/settings/tokens](https://www.npmjs.com/settings/tokens)

This eliminates token expiration as a maintenance burden entirely.

## Initial npm token setup (bootstrap)

An npm token is only needed for the **very first publish** of a new package
(before the package exists on npmjs.com and a trusted publisher can be
configured), or as a **temporary fallback** while setting up trusted
publishing.

1. Go to [npmjs.com/settings/tokens](https://www.npmjs.com/settings/tokens)
2. Click **Generate New Token** > **Granular Access Token**
3. Configure:
   - **Token name**: e.g. `mcp-auth-adapter-github`
   - **Expiration**: 90 days (or your preference)
   - **Bypass two-factor authentication**: **checked** (required for CI)
   - **Allowed IP ranges**: leave empty
   - **Packages and scopes**: `Read and write`, `mcp-auth-adapter` package only
   - **Organizations**: `No access`
4. Click **Generate token** and copy the value
5. Go to **GitHub repo > Settings > Secrets and variables > Actions**
   (https://github.com/velias/mcp-auth-adapter/settings/secrets/actions)
6. Click **New repository secret**:
   - **Name**: `NPM_TOKEN`
   - **Secret**: paste the token value from step 4

Once the package is published and trusted publishing is configured (see above),
this token should be deleted.

### npm token maintenance (legacy)

If you are still using an npm token (before migrating to trusted publishing),
note that the token has an **expiration date**. Check it at
[npmjs.com/settings/tokens](https://www.npmjs.com/settings/tokens).

**When the token expires, `npm publish` in the release workflow will fail with
a 401 or 403 or 404 error.**

To rotate:

1. Create a new token on npmjs (same settings as above)
2. Go to **GitHub repo > Settings > Secrets and variables > Actions**
   (https://github.com/velias/mcp-auth-adapter/settings/secrets/actions)
3. Click the pencil icon next to `NPM_TOKEN`, paste the new value, click
   **Update secret**
4. (Optional) Delete the old token on npmjs

### Recovery: re-run a failed release

If a release workflow fails at the `npm publish` step (look for 401/403 in
the logs):

1. If using trusted publishing: verify the configuration on npmjs.com matches
   the workflow exactly (user, repo, filename, case)
2. If using a token: rotate it (see above)
3. Go to the failed workflow run in GitHub Actions
4. Click **"Re-run failed jobs"** -- the workflow will retry `npm publish`

The git tag and version bump are already in place, so no need to re-tag. The
GitHub Release may or may not have been created depending on which step failed --
if it was created, it stays; if not, the re-run will create it.

## Hotfix

Same process from a release branch if needed.

## Manual publish (emergency)

```bash
npm login && npm publish --access public
```
