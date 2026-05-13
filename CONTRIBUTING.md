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

## Development Setup

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

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
