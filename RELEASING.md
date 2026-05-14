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
- `NPM_TOKEN` configured as a **Repository secret** in GitHub Actions:
  Settings > Secrets and variables > Actions > Repository secrets
  (https://github.com/velias/mcp-auth-adapter/settings/secrets/actions)

  The value is an npm Granular Access Token -- see "Initial npm token setup"
  and "npm token maintenance" below.

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

## Version guidance

- `patch` -- bug fixes, docs, internal refactors
- `minor` -- new features, non-breaking behavior changes
- `major` -- breaking changes (config format, removed features, API changes)

## Initial npm token setup

1. Go to [npmjs.com/settings/tokens](https://www.npmjs.com/settings/tokens)
2. Click **Generate New Token** > **Granular Access Token**
3. Configure:
   - **Token name**: e.g. `mcp-auth-adapter-github`
   - **Expiration**: 90 or 365 days (your preference)
   - **Bypass two-factor authentication**: **checked** (required for CI)
   - **Allowed IP ranges**: leave empty
   - **Packages and scopes**: Read and write, All packages
   - **Organizations**: No access
4. Click **Generate token** and copy the value
5. Go to **GitHub repo > Settings > Secrets and variables > Actions**
   (https://github.com/velias/mcp-auth-adapter/settings/secrets/actions)
6. Click **New repository secret**:
   - **Name**: `NPM_TOKEN`
   - **Secret**: paste the token value from step 4

## npm token maintenance

The npm token has an **expiration date**. Check it at
[npmjs.com/settings/tokens](https://www.npmjs.com/settings/tokens).

**When the token expires, `npm publish` in the release workflow will fail with
a 401 or 403 error.**

To rotate:

1. Create a new token on npmjs (same settings as "Initial npm token setup")
2. Go to **GitHub repo > Settings > Secrets and variables > Actions**
   (https://github.com/velias/mcp-auth-adapter/settings/secrets/actions)
3. Click the pencil icon next to `NPM_TOKEN`, paste the new value, click
   **Update secret**
4. (Optional) Delete the old token on npmjs

Set a calendar reminder for a few days before expiration.

### Recovery: re-run a failed release

If a release workflow fails because the token expired (look for 401/403 in the
`npm publish` step logs):

1. Rotate the token (see steps above)
2. Go to the failed workflow run in GitHub Actions
3. Click **"Re-run failed jobs"** -- the workflow will retry `npm publish` with
   the updated secret

The git tag and version bump are already in place, so no need to re-tag. The
GitHub Release may or may not have been created depending on which step failed --
if it was created, it stays; if not, the re-run will create it.

## Hotfix

Same process from a release branch if needed.

## Manual publish (emergency)

```bash
npm login && npm publish --access public
```
