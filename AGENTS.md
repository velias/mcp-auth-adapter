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
  Validates `redirect_uris` format (parseable URI, no fragments per
  RFC 6749 §3.1.2; any scheme including custom/private-use per RFC 8252 §7.1)
  and type-checks `grant_types`/`response_types` (must be arrays of strings).
  Invalid input returns RFC 7591 `invalid_client_metadata` errors.
  Debug logs include `client_name` and `redirect_uris` count for audit.
  Auto-enables when `MCP_PROXY_DCR_CLIENT_ID` is set.
- **Authorization adapter** — `GET /authorize` validates `redirect_uri` against
  configured patterns, wraps original `redirect_uri` + `state` into a signed
  HMAC state blob, rewrites `redirect_uri` to the adapter's callback, and
  redirects to upstream. Supports scope filtering, optional CIMD client_id
  substitution, and RFC 8707 `resource` parameter validation (format check
  always active; optional require + allowlist enforcement via config).
  Auto-enables when scope filtering, CIMD, or
  `MCP_PROXY_AUTH_STATE_SECRET` is configured.
- **Authorization callback (RFC 9207 `iss` interception)** —
  `GET /authorize/callback` receives the upstream redirect, verifies the signed
  state blob (HMAC + expiry), validates upstream `iss` parameter using two-tier
  logic, then redirects to the original MCP client `redirect_uri` with the
  adapter's `iss` value. Prevents OAuth mix-up attacks per RFC 9207.
- **Token proxy** — `POST /token` proxies token requests to the upstream IdP.
  For `authorization_code` grants, validates `redirect_uri` against allowed
  patterns and rewrites it to the adapter's callback URL. For `refresh_token`
  grants, passes through without redirect_uri modification. For
  `client_credentials` and `urn:ietf:params:oauth:grant-type:jwt-bearer` grants,
  passes all parameters through without redirect_uri logic (covers both the
  Client Credentials extension and the Enterprise-Managed Authorization
  extension). RFC 8707 `resource` parameter validation is applied to all grant
  types except `refresh_token`. Forwards the `Authorization` header to upstream
  for non-CIMD requests (supports `client_secret_basic` per RFC 6749 §2.3.1;
  skipped for CIMD because client_id is rewritten). Always active when the
  authorize proxy is active.
- **CIMD adapter** (EXPERIMENTAL) — Accepts CIMD-style `client_id` URLs from
  MCP clients, validates metadata documents, maps them to upstream IdP
  client_ids, and proxies `/authorize` and `/token` with client_id substitution.
  Auto-enables when `MCP_PROXY_CIMD_MAP` or `MCP_PROXY_CIMD_DEFAULT_CLIENT_ID`
  is set.

## Tech stack

| Area        | Choice                                       |
|-------------|----------------------------------------------|
| Runtime     | Node.js >= 18                                |
| Language    | TypeScript 6.x (strict mode)                  |
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
  state-signer.ts    # HMAC-SHA256 state blob signing/verification with key rotation
  uri-validation.ts  # Shared redirect URI security validation, pattern matching, resource pattern pre-parsing + matching (domain wildcards)
  middleware/
    security.ts      # requireJsonContentType (Content-Type guard for DCR)
    metrics.ts       # Per-router HTTP request counting and latency middleware
  cimd.ts            # CIMD URL validation, document fetch/validation, cache, resolution (EXPERIMENTAL)
  routes/
    well-known.ts    # /.well-known/* — filtered upstream OIDC metadata
    register.ts      # POST /register — fixed client_id DCR with input validation
    authorize.ts     # GET /authorize — redirect adapter, scope filtering, state wrapping, CIMD
    authorize-callback.ts # GET /authorize/callback — iss interception, state verification
    token.ts         # POST /token — unified token proxy with redirect_uri rewriting
    health.ts        # /health/live, /health/ready
    metrics.ts       # GET /metrics — Prometheus text exposition format endpoint
test/
  well-known.test.ts          # Well-known doc content, whitelist, cache-control, refresh, CIMD fields
  register.test.ts            # DCR response, input validation, content-type guard, feature flag
  authorize.test.ts           # Redirect, scope filtering, state wrapping, redirect_uri validation, CIMD
  authorize-callback.test.ts  # Callback: state verification, iss validation, error forwarding
  token.test.ts               # Token proxy: substitution, redirect_uri rewriting, passthrough, client_credentials, JWT bearer, Authorization header forwarding
  state-signer.test.ts        # State blob sign/verify, tamper, expiry, key rotation
  uri-validation.test.ts      # URI security checks, pattern matching
  cimd.test.ts                # CIMD URL/doc validation, cache, resolution, IP checks
  cimd-fetch.test.ts          # CIMD fetch with mocked HTTP: SSRF, size, timeout, content-type
  health.test.ts              # Liveness/readiness probes
  metrics.test.ts             # Metrics primitives, no-op stubs, /metrics endpoint, config parsing
  config.test.ts              # Config parsing, validation, auto-enable logic
```

## Architecture notes

- **Single process, in-memory cache.** The upstream OIDC document is fetched at
  startup and refreshed on a `setInterval` (`wellKnownRefreshMinutes`). On
  refresh failure, the previous document is kept.
- **Middleware order matters.** Health routes are mounted **before** compression
  and `express.json()` so probes skip unnecessary processing. `/metrics` is
  mounted after compression (responses can be large) but before body parsers.
- **No explicit feature flags.** All optional features (DCR, authorize proxy,
  CIMD) auto-enable based on the presence of their configuration — see
  "Key responsibilities" above. Exception: `MCP_METRICS_ENABLED` (default
  `true`) explicitly controls the metrics subsystem.
- **`UpstreamState`** holds the cached well-known document (already
  filtered/merged for clients) plus its pre-serialized JSON string (served
  directly by the well-known handler without per-request `JSON.stringify`),
  the raw `upstreamAuthorizationEndpoint` URL (used by the authorize redirect),
  `upstreamTokenEndpoint` (used by the token proxy), `upstreamIssuer` (for
  RFC 9207 validation), and `upstreamSupportsIss` (derived from upstream
  metadata, defaults to `false` when the upstream doc cannot be fetched).
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
  `["authorization_code", "client_credentials"]`, `["S256"]`). Existing upstream
  values are never overridden. `validateUpstreamDoc()` (also in
  `src/routes/well-known.ts`) is called at startup and on periodic refresh to
  emit `Upstream IdP compatibility:` warnings when the upstream metadata is
  missing or incomplete for MCP.
- **Pre-parsed resource patterns.** Resource allowlist patterns (`ParsedResourcePattern`)
  are parsed once at config time via `parseResourcePatterns()`. Runtime matching
  in `checkAndMatchResource()` parses the request URI once and returns both the
  validation result and the matched pattern — no `new URL()` on patterns per
  request and no duplicate parsing. Legacy standalone helpers
  (`matchesResourcePattern()`, `matchedResourcePattern()`, `checkResourceParam()`)
  remain for backward compatibility.
  `ResourceConfig.allowedResources` is `ParsedResourcePattern[]`, not `string[]`.
- **Metrics subsystem.** `src/metrics.ts` provides zero-dependency Prometheus
  primitives (Counter, Gauge, Histogram) behind `ICounter`/`IGauge`/`IHistogram`
  interfaces. `createMetricsRegistry(enabled)` returns a real `Registry` or a
  `NoopRegistry` with stub methods, so instrumentation call sites are
  unconditional. HTTP metrics middleware is mounted per-router (only functional
  routes), not globally. The `/metrics` endpoint serializes to Prometheus text
  exposition format on demand.
- **Logging.** `src/logger.ts` provides a structured key=value logger writing
  to stdout (info, debug) and stderr (warn, error). `createLogger(debugEnabled)`
  returns a `Logger` with `info`, `warn`, `error`, `debug` methods and an
  `isDebugEnabled` flag for call-site guards. Debug logs are gated by
  `MCP_DEBUG`. Never use `console.*` directly — always use the `logger`
  instance.

## Performance conventions

- **Config-time over request-time.** Move expensive work (regex compilation,
  `Set` construction from config arrays, `new URL()` on static patterns, JSON
  serialization of stable documents) to startup or router/middleware creation
  time. Request handlers should use pre-computed structures, not rebuild them
  per call. The existing `parseResourcePatterns()` → `ParsedResourcePattern[]`
  pattern is the model: parse once at config load, match with field comparisons
  at runtime.
- **One parse per input per request.** When a request value (e.g. a URI) needs
  both validation and a derived result (metrics label, pattern match), do both
  in a single pass. Avoid calling separate helpers that each re-parse the same
  input independently (e.g. two `new URL()` calls on the same string).
- **Middleware ordering.** Health probes are mounted **before** compression and
  body parsers (tiny fixed responses, high frequency). `/metrics` is mounted
  after compression (responses can be large) but before body parsers. Functional
  routes come after both. When adding new operational endpoints, consider whether
  they benefit from compression.
- **Debug log argument cost.** `logger.debug()` gates on `debugEnabled` *inside*
  the function — call-site arguments (object spreads, `requestMeta(req)`, string
  slicing) are evaluated even when debug is off. Guard with
  `if (logger.isDebugEnabled)` when constructing non-trivial metadata objects.

## Configuration

All env vars are prefixed with `MCP_`. See `.env.example` for the full list.
Key ones: `MCP_BASE_URL`, `MCP_UPSTREAM_SSO_URL`, `MCP_PROXY_DCR_CLIENT_ID`,
`MCP_WELL_KNOWN_SCOPES_SUPPORTED`, `MCP_PROXY_AUTH_SCOPES_REMOVED`,
`MCP_PROXY_AUTH_SCOPES_PRESERVED`.

RFC 9207 iss interception: `MCP_PROXY_AUTH_STATE_SECRET` (required when
authorize proxy is active), `MCP_PROXY_AUTH_STATE_SECRET_PREVIOUS` (optional,
for key rotation), `MCP_PROXY_AUTH_STATE_TTL_MINUTES` (default 30),
`MCP_PROXY_AUTH_ALLOWED_REDIRECT_URIS` (required when DCR is also active).

CIMD (EXPERIMENTAL): `MCP_PROXY_CIMD_MAP`, `MCP_PROXY_CIMD_DEFAULT_CLIENT_ID`,
`MCP_PROXY_CIMD_CACHE_MINUTES`.

RFC 8707 Resource Parameter: `MCP_PROXY_AUTH_REQUIRE_RESOURCE` (boolean,
default `false`), `MCP_PROXY_AUTH_ALLOWED_RESOURCES` (comma-separated URI
patterns — trailing `*` = path prefix match, `*.domain.com` = domain wildcard
matching domain and all subdomains, e.g. `https://*.corp.example.com/*`).

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
  - **Application metrics**:
    - `mcp_auth_request_rejected_total{route, reason, grant_type?, resource?}` —
      incremented at every validation rejection. `route` is `/authorize`,
      `/authorize/callback`, `/token`, or `/register`. `reason` is a bounded
      enum per route. `grant_type` only on `/token` (recognized values:
      `authorization_code`, `refresh_token`, `client_credentials`, `jwt_bearer`;
      omitted for unrecognized). `resource` only on `/authorize` and `/token`
      when `allowedResources` is configured (uses matched pattern, not raw URI).
    - `mcp_auth_authorize_redirects_total{resource?}` — successful `/authorize`
      redirects. `resource` label as above.
    - `mcp_auth_token_proxy_upstream_duration_seconds{grant_type?, resource?}` —
      token upstream request duration with `grant_type` and `resource` labels.
    - `mcp_auth_token_proxy_upstream_status_total{status, grant_type?, resource?}` —
      token upstream status codes with `grant_type` and `resource` labels.
  - **Rejection counter pattern**: Every validation rejection in a route
    handler must call `rejectedTotal.inc(...)` with fixed `route` + `reason`
    labels before sending the error response.
  - **`grant_type` label pattern**: Only recognized grant types get a label
    (via `grantTypeLabel()` in `token.ts`). Add new grant types to
    `GRANT_TYPE_LABELS` — the only place to update.
  - **`resource` label pattern**: Uses matched allowlist pattern, not raw URI.
    Only emitted when `allowedResources` is configured. When empty, omit the
    label entirely. Use `checkAndMatchResource()` from `uri-validation.ts`
    (returns both validation result and matched pattern in one pass).
- OAuth error responses follow RFC format (`{ error, error_description }`).
- **Router config objects** — Router factory functions accept a single flat
  typed config interface + `logger`. The config interface `extends` shared
  sub-interfaces (e.g. `AuthScopeConfig`, `ResourceConfig`) so the config
  object can be passed directly to helper functions that accept those
  sub-interfaces — no intermediate destructuring needed. Fields from nested
  concerns are inlined with a prefix when names would collide
  (e.g. `stateSecret`, `stateBaseUrl`, `redirectBaseUrl`, `redirectAllowedUris`).
  Examples: `AuthorizeRouterConfig extends AuthScopeConfig, ResourceConfig`,
  `TokenRouterConfig extends ResourceConfig`. The `logger` stays as a separate
  second argument (infrastructure concern, not config).
- **DRY / code reuse** — When the same validation or business logic applies to
  multiple routes (e.g. `/authorize` and `/token`), extract it into a shared
  helper in the appropriate `src/*.ts` utility module rather than duplicating
  inline. Route handlers should be thin orchestrators that call shared functions
  and map results to HTTP responses. Existing examples:
  - `src/uri-validation.ts` — `validateRedirectUriSecurity()`,
    `validateResourceUri()`, `matchesRedirectPattern()`,
    `parseResourcePatterns()` (config-time compiler),
    `checkAndMatchResource()` (single-pass validation + pattern match)
  - `src/state-signer.ts` — `signState()`, `verifyState()`
  - `src/cimd.ts` — validation, resolution, caching used by both authorize and
    token routes
  - `src/config.ts` — shared interfaces (`AppConfig`, `ResourceConfig` via
    re-export from uri-validation) consumed by all route modules

  When adding a new cross-route concern, prefer a pure function returning a
  result/error value over duplicating HTTP response logic in each handler.
