# Changelog

All notable changes to this project are documented here.
This file is auto-generated from [GitHub Releases](https://github.com/velias/mcp-auth-adapter/releases) — do not edit manually.

---

## [v2.2.0](https://github.com/velias/mcp-auth-adapter/releases/tag/v2.2.0) — 2026-07-02

### Features
* access logging added by @velias in https://github.com/velias/mcp-auth-adapter/pull/36
### Other Changes
* Tests migrated from jest to vitest by @velias in https://github.com/velias/mcp-auth-adapter/pull/32
* Bump esbuild, @vitest/coverage-v8 and vitest by @dependabot[bot] in https://github.com/velias/mcp-auth-adapter/pull/33
* Bump the dev-dependencies group with 2 updates by @dependabot[bot] in https://github.com/velias/mcp-auth-adapter/pull/35
* Bump softprops/action-gh-release from 3.0.0 to 3.0.1 by @dependabot[bot] in https://github.com/velias/mcp-auth-adapter/pull/34


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
* Bump actions/checkout from 6.0.3 to 7.0.0 by @dependabot[bot] in https://github.com/velias/mcp-auth-adapter/pull/28


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
