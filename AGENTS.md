# AGENTS.md

## Project overview

**mcp-auth-adapter** is a thin, stateless OAuth/OIDC auth adapter for MCP clients.
It sits in front of upstream IdP (Keycloak-style) so MCP servers can advertise
this adapter as the authorization server instead of the raw IdP URL. It does **not**
issue tokens — all real auth/token work stays on the upstream IdP.

### Key responsibilities

- **Discovery** — Serves `/.well-known/openid-configuration` and
  `/.well-known/oauth-authorization-server` as a filtered, MCP-oriented view of
  upstream OIDC metadata (with optional injection of this app's DCR,
  authorization, and token proxy URLs).
- **Dynamic Client Registration (DCR)** — `POST /register` returns a fixed,
  pre-configured `client_id` (RFC 7591 style, public client).
  Auto-enables when `MCP_PROXY_DCR_CLIENT_ID` is set.
- **Authorization adapter** — `GET /authorize` forwards to the upstream
  authorization URL with configurable scope filtering and optional CIMD
  client_id substitution. Auto-enables when scope filtering or CIMD is configured.
- **CIMD adapter** (EXPERIMENTAL) — Accepts CIMD-style `client_id` URLs from
  MCP clients, validates metadata documents, maps them to upstream IdP
  client_ids, and proxies `/authorize` and `/token` with client_id substitution.
  Auto-enables when `MCP_PROXY_CIMD_MAP` or `MCP_PROXY_CIMD_DEFAULT_CLIENT_ID`
  is set.

## Tech stack

| Area        | Choice                                       |
|-------------|----------------------------------------------|
| Runtime     | Node.js >= 18                                |
| Language    | TypeScript 5.6 (strict mode)                  |
| HTTP        | Express 5.x                                   |
| Tests       | Jest + ts-jest + supertest (in-memory, no I/O)|
| Lint        | ESLint 10 flat config + typescript-eslint      |
| Build       | `tsc` → `dist/`                               |
| Dev         | `ts-node src/index.ts`                        |
| CI          | GitHub Actions                                |

## Directory layout

```
src/
  index.ts           # Entry point: loads env, fetches upstream doc, starts server
  app.ts             # Express app factory, middleware ordering, UpstreamState
  config.ts          # AppConfig type + loadConfig() from MCP_* env vars
  logger.ts          # Structured line logger (ts= level= msg= ...)
  metrics.ts         # Prometheus metrics primitives (Counter, Gauge, Histogram, Registry, no-op stubs)
  fetch-utils.ts     # Shared fetch helpers (readResponseWithLimit — streaming read with byte cap)
  middleware/
    security.ts      # requireJsonContentType (Content-Type guard for DCR)
    metrics.ts       # Per-router HTTP request counting and latency middleware
  cimd.ts            # CIMD URL validation, document fetch/validation, cache, resolution (EXPERIMENTAL)
  routes/
    well-known.ts    # /.well-known/* — filtered upstream OIDC metadata
    register.ts      # POST /register — fixed client_id DCR
    authorize.ts     # GET /authorize — redirect adapter, scope filtering, CIMD client_id substitution
    token.ts         # POST /token — token endpoint proxy with CIMD client_id substitution (EXPERIMENTAL)
    health.ts        # /health/live, /health/ready
    metrics.ts       # GET /metrics — Prometheus text exposition format endpoint
test/
  well-known.test.ts # Well-known doc content, whitelist, cache-control, refresh, CIMD fields
  register.test.ts   # DCR response, content-type guard, feature flag
  authorize.test.ts  # Redirect, configurable scope filtering, feature flag, CIMD integration
  token.test.ts      # Token proxy: substitution, passthrough, security, error handling
  cimd.test.ts       # CIMD URL/doc validation, cache, resolution, IP checks
  cimd-fetch.test.ts # CIMD fetch with mocked HTTP: SSRF, size, timeout, content-type
  health.test.ts     # Liveness/readiness probes
  metrics.test.ts    # Metrics primitives, no-op stubs, /metrics endpoint, config parsing
```

## Architecture notes

- **Single process, in-memory cache.** The upstream OIDC document is fetched at
  startup and refreshed on a `setInterval` (`wellKnownRefreshMinutes`). On
  refresh failure, the previous document is kept.
- **Middleware order matters.** Health routes are mounted **before**
  `express.json()` so probes avoid body parsing.
- **No explicit feature flags.** All optional features (DCR, authorize proxy,
  CIMD) auto-enable based on the presence of their configuration — see
  "Key responsibilities" above. Exception: `MCP_METRICS_ENABLED` (default
  `true`) explicitly controls the metrics subsystem.
- **`UpstreamState`** holds the cached well-known document (already
  filtered/merged for clients), the raw `upstreamAuthorizationEndpoint` URL
  (used by the authorize redirect), and `upstreamTokenEndpoint` (used by the
  CIMD token proxy).
- **Graceful shutdown.** `SIGTERM`/`SIGINT` set `shuttingDown` (readiness probe
  returns 503), clear the refresh timer, and call `server.close()` to drain
  in-flight requests with a configurable force-exit timeout.
- **Well-known whitelist.** Only a curated set of fields from the upstream doc
  is forwarded to clients — see `UPSTREAM_WHITELIST_FIELDS` in
  `src/routes/well-known.ts`.
- **Flow-level defaults.** When the upstream well-known descriptor includes `authorization_endpoint`
  and `token_endpoint` but omits `response_types_supported`,
  `grant_types_supported`, or `code_challenge_methods_supported`, the well-known
  builder injects safe MCP-required defaults (`["code"]`,
  `["authorization_code"]`, `["S256"]`). Existing upstream values are never
  overridden. `validateUpstreamDoc()` (also in `src/routes/well-known.ts`) is
  called at startup and on periodic refresh to emit `Upstream IdP compatibility:`
  warnings when the upstream metadata is missing or incomplete for MCP.
- **Metrics subsystem.** `src/metrics.ts` provides zero-dependency Prometheus
  primitives (Counter, Gauge, Histogram) behind `ICounter`/`IGauge`/`IHistogram`
  interfaces. `createMetricsRegistry(enabled)` returns a real `Registry` or a
  `NoopRegistry` with stub methods, so instrumentation call sites are
  unconditional. HTTP metrics middleware is mounted per-router (only functional
  routes), not globally. The `/metrics` endpoint serializes to Prometheus text
  exposition format on demand.
- **Logging.** `src/logger.ts` provides a structured key=value logger writing
  to stdout (info, debug) and stderr (warn, error). `createLogger(debugEnabled)`
  returns a `Logger` with `info`, `warn`, `error`, `debug` methods. Debug logs
  are gated by `MCP_DEBUG`. Never use `console.*` directly — always use the
  `logger` instance.

## Configuration

All env vars are prefixed with `MCP_`. See `.env.example` for the full list.
Key ones: `MCP_BASE_URL`, `MCP_UPSTREAM_SSO_URL`, `MCP_PROXY_DCR_CLIENT_ID`,
`MCP_WELL_KNOWN_SCOPES_SUPPORTED`, `MCP_PROXY_AUTH_SCOPES_REMOVED`,
`MCP_PROXY_AUTH_SCOPES_PRESERVED`.

CIMD (EXPERIMENTAL): `MCP_PROXY_CIMD_MAP`, `MCP_PROXY_CIMD_DEFAULT_CLIENT_ID`,
`MCP_PROXY_CIMD_CACHE_MINUTES`.

Observability: `MCP_METRICS_ENABLED`.

Lifecycle: `MCP_SHUTDOWN_TIMEOUT_SECONDS`.

`loadConfig()` in `src/config.ts` validates and returns an `AppConfig` object.

## Common commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript to dist/
npm run dev          # Run in dev mode (ts-node)
npm start            # Run compiled output (node dist/index.js)
npm test             # Run Jest tests
npm run lint         # ESLint check
npm run lint:fix     # ESLint auto-fix
```

## Testing conventions

- Tests use **supertest** on the Express app — no real network, no listening
  server.
- Upstream OIDC docs are **mocked inline** in each test file.
- Each test file corresponds to one route module.
- Auto-enable behavior (404 when feature is not configured) is tested in the
  relevant file.

## Code style

- TypeScript strict mode. No `any` in production code.
- ESLint `recommendedTypeChecked` rules; `no-unsafe-*` rules are relaxed in
  `test/**`.
- Structured logging — use `logger` from `src/logger.ts`, not `console.*`.
  Use `info` for lifecycle events and success paths, `warn` for recoverable
  failures and config issues, `error` for unrecoverable or unexpected failures,
  `debug` for per-request detail (gated by `MCP_DEBUG`).
- Metrics — all application metric names use the `mcp_auth_` prefix; process
  metrics (`process_*`, `nodejs_*`) are un-prefixed per convention. New metrics
  must use bounded label cardinality (fixed route patterns, enum values — never
  user input). To instrument a new route: add `metricsMiddleware` in `app.ts`
  alongside the router mount. To add domain-specific metrics: accept
  `IMetricsRegistry` in the module, create counters/gauges/histograms from it.
  No external metrics dependencies — the zero-dependency approach is deliberate.
- OAuth error responses follow RFC format (`{ error, error_description }`).
