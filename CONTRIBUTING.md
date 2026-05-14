# Contributing to MCP Auth Adapter

Thank you for considering contributing! This document explains the process and guidelines for contributing to this project.

## How to Contribute

### Reporting Bugs

- Open a [GitHub issue](https://github.com/velias/mcp-auth-adapter/issues) with a clear description.
- Include steps to reproduce, expected behavior, and actual behavior.
- Include the Node.js version and OS if relevant. 
- Include MCP Client and its version where the bug appears if relevant.

### Suggesting Features

- **Features should be discussed before implementation.** Open a [GitHub issue](https://github.com/velias/mcp-auth-adapter/issues) describing the use case, proposed behavior, and any alternatives you considered.
- Wait for feedback and approval before starting work — this saves everyone's time and avoids rejected PRs.

### Submitting Pull Requests

1. **Every PR must reference a GitHub issue.** If one doesn't exist, create it first.
2. Fork the repository and create a branch from `main`.
3. Make your changes (see guidelines below).
4. Ensure all checks pass locally:
   ```bash
   npm run lint
   npm run build
   npm test
   ```
5. Open a PR against `main` and reference the issue (e.g. `Fixes #42` or `Relates to #42`).

### PR titles and labels (for release notes)

GitHub Release notes are **auto-generated from merged PRs**. To keep them useful:

- **Write a clear PR title** — it appears verbatim in the release notes (along with the PR author). The PR body/description is _not_ included.
- **Apply a label** to categorize the PR in release notes. Use one of:
  - `breaking` — breaking changes
  - `enhancement` or `feature` — new functionality
  - `bug` or `fix` — bug fixes
  - `documentation` — docs-only changes
  - Unlabeled PRs land in "Other Changes"
- Labels can be added or changed **at any time** before the release is created — they don't need to be set at merge time.
- All meaningful changes should go through PRs. Direct commits to `main` appear as raw commit hashes in release notes.

## Development Setup

**Prerequisites:** Node.js >= 18.x, npm (or [Docker](https://docs.docker.com/get-docker/) / [Podman](https://podman.io/docs/installation) for container-based development)

```bash
git clone https://github.com/velias/mcp-auth-adapter.git
cd mcp-auth-adapter
npm install
```

### Running Locally

```bash
cp .env.example .env    # Edit .env with your upstream IdP details
npm run dev             # Start with ts-node
```

### Running with Docker / Podman

```bash
docker build -t mcp-auth-adapter .
docker run -p 3000:3000 --env-file .env mcp-auth-adapter
```

```bash
podman build -t mcp-auth-adapter .
podman run -p 3000:3000 --env-file .env mcp-auth-adapter
```

### Running Tests

```bash
npm test                # Jest + supertest (no network, no server)
npm test -- --coverage  # Run with coverage report
```

Tests use [supertest](https://github.com/ladds/supertest) against the Express app with mocked upstream docs — no server started, no network calls. Each test file corresponds to one route module.

The `--coverage` flag prints a summary table to the terminal and generates a detailed HTML report in `coverage/lcov-report/index.html` that you can open in a browser. Coverage is also reported automatically on pull requests by CI.

### Linting

```bash
npm run lint            # ESLint check
npm run lint:fix        # Auto-fix
```

ESLint uses [typescript-eslint](https://typescript-eslint.io/) with type-aware rules (`recommendedTypeChecked`). Config: `eslint.config.mjs`.

## Code Style

- **TypeScript strict mode.** No `any` in production code.
- **Structured logging** — use `logger` from `src/logger.ts`, not `console.*`.
- **OAuth error responses** follow RFC format (`{ error, error_description }`).
- **Tests** — upstream OIDC docs are mocked inline in each test file. Auto-enable behavior (404 when a feature is not configured) must be covered.

## Testing Guidelines

- Every new feature or bug fix should include tests.
- Tests must not make real network calls or start a listening server.
- Each route module has a corresponding test file in `test/`.

## Releases

See [RELEASING.md](RELEASING.md) for the release process, npm token setup, and how release notes are generated.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
