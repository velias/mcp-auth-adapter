# Changelog

All notable changes to this project are documented here.
This file is auto-generated from [GitHub Releases](https://github.com/velias/mcp-auth-adapter/releases) — do not edit manually.

---

## [v2.4.0](https://github.com/velias/mcp-auth-adapter/releases/tag/v2.4.0) — 2026-07-31

### Features
* DPoP (RFC 9449) support added if upstream IdP supports it by @velias in https://github.com/velias/mcp-auth-adapter/pull/61
* PAR (RFC 9126) support added if upstream IdP advertises it by @velias in https://github.com/velias/mcp-auth-adapter/pull/62
* Hardened OAuth redirect handling and outbound fetches against open-redirect / SSRF class issues. by @velias in https://github.com/velias/mcp-auth-adapter/pull/67
  * Reject HTTP redirects when fetching upstream well-known and health probes (redirect: 'error')
  * Validate CIMD redirect_uris (and authorize/PAR CIMD redirects) with shared URI security checks; block dangerous schemes (javascript:, data:, etc.)
  * Make redirect allowlist wildcards host-aware: http://host/* / http://host/:* still allow any port/path, but domain-extension matches (host.evil.com) are rejected
  * Treat IPv6-mapped private addresses in hex form (::ffff:7f00:1) as private for CIMD SSRF checks


**Full Changelog**: https://github.com/velias/mcp-auth-adapter/compare/v2.3.0...v2.4.0

---

## [v2.3.0](https://github.com/velias/mcp-auth-adapter/releases/tag/v2.3.0) — 2026-07-13

### Features
* Possibility to map DCR Client Name to different IdP Clients by @velias in https://github.com/velias/mcp-auth-adapter/pull/48
* All client request validation problems are now logged as `warn` for better supportability by @velias in https://github.com/velias/mcp-auth-adapter/pull/48
* Composite health check added by @velias in https://github.com/velias/mcp-auth-adapter/pull/49

### Other Changes
* Bump the dev-dependencies group across 1 directory with 5 updates by @dependabot[bot] in https://github.com/velias/mcp-auth-adapter/pull/50

**Full Changelog**: https://github.com/velias/mcp-auth-adapter/compare/v2.2.1...v2.3.0

## Deployment notes
* If you have Prometheus dashboards or alerts referencing `mcp_auth_*` metrics, review them for the new `idp_client` label dimension. 
* The new `/health` endpoint should be blocked from public internet access.

---

## [v2.2.1](https://github.com/velias/mcp-auth-adapter/releases/tag/v2.2.1) — 2026-07-03

### Features
* Logged values are always quoted for consistent parsing by @velias in https://github.com/velias/mcp-auth-adapter/pull/43
### Other Changes
* Bump the dev-dependencies group with 3 updates by @dependabot[bot] in https://github.com/velias/mcp-auth-adapter/pull/42

**Full Changelog**: https://github.com/velias/mcp-auth-adapter/compare/v2.2.0...v2.2.1

---

## [v2.2.0](https://github.com/velias/mcp-auth-adapter/releases/tag/v2.2.0) — 2026-07-02

### Features
* access logging added by @velias in https://github.com/velias/mcp-auth-adapter/pull/36
### Other Changes
* Tests migrated from jest to vitest by @velias in https://github.com/velias/mcp-auth-adapter/pull/32
* Bump esbuild, @vitest/coverage-v8 and vitest by @dependabot[bot] in https://github.com/velias/mcp-auth-adapter/pull/33
* Bump the dev-dependencies group with 2 updates by @dependabot[bot] in https://github.com/velias/mcp-auth-adapter/pull/35

**Full Changelog**: https://github.com/velias/mcp-auth-adapter/compare/v2.1.0...v2.2.0

---

## [v2.1.0](https://github.com/velias/mcp-auth-adapter/releases/tag/v2.1.0) — 2026-06-22

### Features
* Full 'OAuth Client Credentials' MCP Spec extension support by @velias in https://github.com/velias/mcp-auth-adapter/pull/27
* Improved Resource Parameter Validation (RFC 8707) by @velias in https://github.com/velias/mcp-auth-adapter/pull/29
* Prometheus metrics improvements by @velias in https://github.com/velias/mcp-auth-adapter/pull/30
* Performance optimizations by @velias in https://github.com/velias/mcp-auth-adapter/pull/31
### Other Changes
* Bump the dev-dependencies group with 2 updates by @dependabot[bot] in https://github.com/velias/mcp-auth-adapter/pull/24
* Bump form-data from 4.0.5 to 4.0.6 by @dependabot[bot] in https://github.com/velias/mcp-auth-adapter/pull/25
* updated @babel/core dev dependency by @velias in https://github.com/velias/mcp-auth-adapter/pull/26

**Full Changelog**: https://github.com/velias/mcp-auth-adapter/compare/v2.0.0...v2.1.0

---

## [v2.0.0](https://github.com/velias/mcp-auth-adapter/releases/tag/v2.0.0) — 2026-06-12

### BREAKING CHANGES
* `MCP_PROXY_AUTH_STATE_SECRET` is now required when the authorize proxy is active (scope filtering, CIMD, or standalone iss interception). Existing deployments must add this variable — generate with `openssl rand -hex 32`.
* `MCP_PROXY_AUTH_ALLOWED_REDIRECT_URIS` is now required for non-CIMD-only deployments. Configure allowed MCP client redirect URI patterns (see README for known client patterns).
* `token_endpoint` in well-known metadata is now rewritten to the adapter's URL when the authorize proxy is active (was only for CIMD).
* Upstream IdP client must register `{MCP_BASE_URL}/authorize/callback` as an allowed redirect URI.

### Features
* RFC 9207 `iss` parameter compliance — intercepts upstream IdP authorization responses to provide correct issuer identification, preventing mix-up attack rejections by MCP clients enforcing the 2026-07-28 MCP Auth Spec Draft
* Unified token proxy — `/token` is now always proxied when the authorize proxy is active, handling `redirect_uri` rewriting for authorization code grants
* Zero-downtime secret rotation via `MCP_PROXY_AUTH_STATE_SECRET_PREVIOUS`
* Configurable state blob TTL via `MCP_PROXY_AUTH_STATE_TTL_MINUTES` (default 30 min)
* Shared URI security validation — tightened redirect_uri checks (control chars, userinfo rejection) across DCR and authorize endpoints

**Full Changelog**: https://github.com/velias/mcp-auth-adapter/compare/v1.0.1...v2.0.0

---

## [v1.0.1](https://github.com/velias/mcp-auth-adapter/releases/tag/v1.0.1) — 2026-05-25

### Features
* Improved DRC request validation

### Other Changes
* Bump qs from 6.15.1 to 6.15.2
* Bump the dev-dependencies and Github actions

**Full Changelog**: https://github.com/velias/mcp-auth-adapter/compare/v1.0.0...v1.0.1

---

## [v1.0.0](https://github.com/velias/mcp-auth-adapter/releases/tag/v1.0.0) — 2026-05-15

### Features
* Container image
* Prometheus metrics exposed
* Graceful Shutdown

### Other Changes
* Security hardening, OWASP review
* Different small improvements - configuration validations, runtime hardening
* Multiple runtime and dev dependencies bumped to latest versions

**Full Changelog**: https://github.com/velias/mcp-auth-adapter/compare/v0.2.0...v1.0.0

---

## [v0.2.0](https://github.com/velias/mcp-auth-adapter/releases/tag/v0.2.0) — 2026-05-14

### Features
* Initial version with many basic features - DCR, scopes filtering, CIMD

**Full Changelog**: https://github.com/velias/mcp-auth-adapter/commits/v0.2.0
