# MCP Auth Adapter

<p align="center">
  <img src="docs/banner.svg" alt="Make your corporate IdP MCP-ready, now!" width="720"/>
</p>

[![CI](https://github.com/velias/mcp-auth-adapter/actions/workflows/ci.yml/badge.svg)](https://github.com/velias/mcp-auth-adapter/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/velias/f550f0ffe68a574a690032088359fef3/raw/mcp-auth-adapter-coverage.json)](https://github.com/velias/mcp-auth-adapter/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/velias/mcp-auth-adapter/badge)](https://securityscorecards.dev/viewer/?uri=github.com/velias/mcp-auth-adapter)

An OAuth/OIDC authentication adapter for [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) clients. It sits in front of any OAuth 2.0 / OIDC upstream IdP that serves standard discovery metadata -- such as Keycloak, Auth0, Okta, Azure AD (Entra ID), Google Identity, or any provider serving standard OAuth 2.0 / OIDC discovery metadata -- and provides functionality required by the [MCP Authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) for the most common MCP clients (Claude Code/Desktop, Cursor IDE, ChatGPT, Gemini CLI, VS Code, ...) and [their known problematic behaviours](#known-mcp-client-behaviors).

MCP servers [announce this adapter as their authorization server](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#authorization-server-discovery). MCP clients discover it via `.well-known` and interact with its endpoints. **Authentication itself, token issuing, and token exchanges are all performed by the upstream IdP** -- this adapter is only a very thin, transparent, stateless facade.

### Features

- **Well-known discovery** (`/.well-known/openid-configuration`, `/.well-known/oauth-authorization-server`) -- filtered, MCP-focused view of the upstream IdP metadata with injected adapter endpoints and tailored configurations.
- **Open Dynamic Client Registration** (`POST /register`, optional) -- returns a pre-configured fixed `client_id` for all registering MCP clients per [RFC 7591](https://rfc-editor.org/rfc/rfc7591).
- **Authorization proxy** (`GET /authorize`, optional) -- intercepts authorization requests, applies configurable scope filtering and/or CIMD `client_id` substitution, and redirects to the upstream IdP.
- **CIMD adapter** (`GET /authorize` + `POST /token`, EXPERIMENTAL, optional) -- accepts [Client ID Metadata Document](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/) style `client_id` URLs, validates metadata documents, and maps them to pre-configured fixed upstream IdP client_ids. See [CIMD Adapter](#cimd-adapter-experimental).

## Container Image

Pre-built container images are published to GitHub Container Registry on every release. This is the recommended way to deploy in production -- no Node.js installation required.

**Prerequisites:** [Docker](https://docs.docker.com/get-docker/) or [Podman](https://podman.io/docs/installation)

### Pull and run

Podman is used in examples, but you can use `docker` command instead:

```bash
podman run -d --name mcp-auth-adapter \
  -p 3000:3000 \
  -e MCP_BASE_URL=https://mcp-auth.example.com \
  -e MCP_UPSTREAM_SSO_URL=https://sso.example.com/auth/realms/external \
  -e MCP_PROXY_DCR_CLIENT_ID=mcp-client \
  ghcr.io/velias/mcp-auth-adapter:latest
```

Or use an env file for all configuration (see [Configuration](#configuration) below):

```bash
podman run -d -p 3000:3000 --env-file .env ghcr.io/velias/mcp-auth-adapter:latest
```

### Available tags

Each release `vX.Y.Z` produces the following image tags:
- `X.Y.Z` -- exact version (recommended for production)
- `X.Y` -- latest patch within a minor version
- `X` -- latest minor within a major version
- `latest` -- most recent release

To build the image locally from source, see [CONTRIBUTING.md](CONTRIBUTING.md#running-with-docker--podman).

## Build from Source

**Prerequisites:** Node.js >= 18.x (uses native `fetch`), npm

```bash
npm install
npm run build

# Create .env from the template and edit it
cp .env.example .env

npm start
```

## Configuration

Environment variables are used. All variables are prefixed with `MCP_`. A `.env` file in the project root is loaded automatically, explicit environment variables take precedence.

| Variable | Required | Default | Description |
|---|---|---|---|
| | | | **Core** |
| `MCP_BASE_URL` | Yes | -- | Public base URL of this adapter (**no trailing slash**). Used as `issuer` (RFC 8414 §3.3) and to construct endpoint URLs. Must exactly match what MCP servers advertise in their Protected Resource Metadata `authorization_servers` array. |
| `MCP_UPSTREAM_SSO_URL` | Yes | -- | Base URL (issuer) of the upstream IdP. Works with any OAuth 2.0 / OIDC provider. Discovery is attempted via `/.well-known/openid-configuration`, then `/.well-known/oauth-authorization-server` (RFC 8414); on failure, fallback endpoints are derived using Keycloak URL conventions ([see below](#upstream-well-known-handling)). |
| `MCP_PORT` | No | `3000` | Port this app listens on. |
| | | | **Dynamic Client Registration** |
| `MCP_PROXY_DCR_CLIENT_ID` | No | -- | Fixed `client_id` returned by `POST /register`. Setting this enables the DCR proxy. Must be pre-registered at the upstream IdP as a public client. If omitted, the upstream IdP's registration endpoint is announced directly. |
| | | | **Scope filtering** (auto-enables `/authorize` proxy) |
| `MCP_PROXY_AUTH_SCOPES_REMOVED` | No | -- | Comma-separated scopes to strip from `/authorize` requests (e.g. `offline_access`). Ignored if `MCP_PROXY_AUTH_SCOPES_PRESERVED` is also set. |
| `MCP_PROXY_AUTH_SCOPES_PRESERVED` | No | -- | Comma-separated scopes to keep in `/authorize` requests; all others are stripped. Takes precedence over `MCP_PROXY_AUTH_SCOPES_REMOVED`. |
| | | | **Well-known discovery** |
| `MCP_WELL_KNOWN_SCOPES_SUPPORTED` | No | -- | Comma-separated scopes to announce in `scopes_supported`. If empty, the field is omitted. Note: some MCP clients request all announced scopes -- this controls *announced* scopes, not *forwarded* scopes. |
| `MCP_WELL_KNOWN_REFRESH_MINUTES` | No | `60` | How often (in minutes) to re-fetch the upstream well-known document. |
| | | | **CIMD adapter** (EXPERIMENTAL, auto-enables `/authorize` proxy + `/token` proxy) |
| `MCP_PROXY_CIMD_MAP` | No | -- | JSON object mapping CIMD URLs to upstream IdP client_ids. Format: `{"<cimd_url>":"<upstream_client_id>", ...}`. N:1 mapping supported. CIMD auto-enables when this is non-empty or `MCP_PROXY_CIMD_DEFAULT_CLIENT_ID` is set. |
| `MCP_PROXY_CIMD_DEFAULT_CLIENT_ID` | No | -- | Fallback upstream client_id for CIMD URLs not in the map. If unset, unknown CIMD URLs are rejected with 403 (strict allowlist). |
| `MCP_PROXY_CIMD_CACHE_MINUTES` | No | `30` | Cache TTL (in minutes) for validated CIMD metadata documents. |
| | | | **Diagnostics** |
| `MCP_DEBUG` | No | `false` | Emit structured debug logs for every request. |

## Known MCP Client Behaviors

MCP clients interact with OAuth/OIDC in ways that can cause issues with upstream IdPs not specifically designed for MCP. This adapter addresses the most common known problems.

### Clients request all announced scopes

Many MCP clients (notably Claude Code, Claude Desktop, Cursor IDE) read `scopes_supported` from the well-known document and include **all** of them in the `/authorize` request. When an upstream IdP announces dozens of scopes (e.g. Keycloak exposes internal scopes like `profile`, `email`, `roles`, `web-origins`, etc.), the authorization request balloons with scopes the MCP server doesn't need — confusing users on the consent screen or causing outright rejection by the upstream IdP if some scopes require pre-approval.

**Mitigation 1 — control what's announced:**

```bash
# Only announce scopes your MCP servers actually need
MCP_WELL_KNOWN_SCOPES_SUPPORTED=openid,api.read,api.write
```

This replaces the upstream `scopes_supported` in discovery, so greedy clients only see (and request) what you intend.

**Mitigation 2 — filter scopes at the authorize proxy:**

Even if you cannot control what's announced (e.g. you need `scopes_supported` to reflect the full upstream list for other consumers), the authorize proxy can strip unwanted scopes before forwarding to the upstream IdP:

```bash
# Remove specific problematic scopes from authorize requests
MCP_PROXY_AUTH_SCOPES_REMOVED=roles,web-origins,microprofile-jwt

# Or use an allowlist — only these scopes reach the upstream IdP
MCP_PROXY_AUTH_SCOPES_PRESERVED=openid,api.read,api.write
```

This catches scopes regardless of whether the client added them from the discovery document or hardcoded them.

### Clients always request `offline_access` scope

Some MCP clients (e.g. Claude Code, Cursor IDE) unconditionally add `offline_access` to every authorization request to be sure they obtain refresh tokens, as some IdPs provide it only under this scope. This may be problematic when this scope has different consequence in your IdP:

- The upstream IdP requires explicit admin consent or client-level configuration to issue offline tokens
- The IdP rejects the entire authorization request when `offline_access` is not an allowed scope for the client
- Organization policy restricts long-lived refresh tokens for security reasons

**Mitigation — strip the scope at the proxy:**

```bash
# Remove offline_access before forwarding to the upstream IdP
MCP_PROXY_AUTH_SCOPES_REMOVED=offline_access
```

Or use the allowlist approach to be more restrictive:

```bash
# Only forward these specific scopes, drop everything else
MCP_PROXY_AUTH_SCOPES_PRESERVED=openid,api.read,api.write
```

### Combining both controls

For a typical deployment where greedy clients and `offline_access` are both issues:

```bash
# Announce only relevant scopes (controls what clients ask for)
MCP_WELL_KNOWN_SCOPES_SUPPORTED=openid,api.read,api.write

# Strip offline_access even if a client adds it explicitly
MCP_PROXY_AUTH_SCOPES_REMOVED=offline_access
```

`MCP_WELL_KNOWN_SCOPES_SUPPORTED` controls the **demand side** (what clients see and request), while `MCP_PROXY_AUTH_SCOPES_REMOVED` / `MCP_PROXY_AUTH_SCOPES_PRESERVED` controls the **supply side** (what actually reaches the upstream IdP). Using both provides defense in depth.

## Open DCR and its Security Limitations

MCP Clients need a way to get `client_id` necessary to login through the upstream IdP. 
You can use Open DCR functionality of this adapter if your IdP does not provide it, or if you do not want to use it.

The Open DCR endpoint returns a fixed public `client_id` (`token_endpoint_auth_method: none`) to be used by MCP Clients. 
But as many MCP Clients are local apps, any local application can obtain this `client_id` and start an OAuth flow. 
IdP do not know who is asking for the `client_id`. Two emerging standards address this:

- **DCR with Software Statement Assertion (SSA)** -- cryptographically proves client identity via signed JWTs ([RFC 7591 §2.3](https://rfc-editor.org/rfc/rfc7591#section-2.3)). No major MCP client currently includes Software Statements in DCR requests.
- **Client ID Metadata Documents (CIMD)** -- the `client_id` is an HTTPS URL pointing to a metadata document. Default mechanism in the [MCP Auth Spec (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#client-id-metadata-documents), not yet universally adopted. **This adapter includes experimental CIMD support** -- see [CIMD Adapter](#cimd-adapter-experimental).

Until "DCR with SSA" or CIMD is widely supported, user consent during login at the upstream IdP is the last line of defense. This is an [accepted limitation of the MCP auth ecosystem](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#localhost-redirect-uri-risks).

## CIMD Adapter (EXPERIMENTAL)

> **Status**: Based on [`draft-ietf-oauth-client-id-metadata-document-01`](https://datatracker.ietf.org/doc/draft-ietf-oauth-client-id-metadata-document/) (March 2026), an IETF Internet-Draft not yet at RFC status. This implementation may change as the spec evolves.

When configured, the adapter bridges MCP clients using CIMD-style `client_id` (HTTPS URLs) to upstream IdPs that don't support CIMD natively:

1. Validates CIMD URL syntax per the spec (Section 3)
2. Checks if the client is allowed in the configuration (map lookup + optional default) -- rejects unknown clients before any I/O
3. Fetches and validates the CIMD metadata document (with SSRF protections and caching)
4. Validates `redirect_uri` against the document's `redirect_uris` (exact match per RFC 9700)
5. Substitutes the CIMD `client_id` with a pre-registered upstream IdP client_id
6. Forwards the request to the upstream IdP

**Configuration example:**
```bash
MCP_PROXY_CIMD_MAP='{"https://cursor.com/.well-known/oauth-client.json":"cursor-sso-client","https://claude.ai/.well-known/oauth-client.json":"claude-sso-client"}'
MCP_PROXY_CIMD_DEFAULT_CLIENT_ID=generic-mcp-client
```

**When CIMD is enabled**, the well-known document is modified to:
- Advertise `client_id_metadata_document_supported: true`
- Rewrite `token_endpoint` to this adapter's `/token` proxy
- Ensure `token_endpoint_auth_methods_supported` includes `"none"`

**Upstream IdP client registration**: Each upstream client_id in `MCP_PROXY_CIMD_MAP` must be pre-registered at the upstream IdP as a public client (`token_endpoint_auth_method: none`). Redirect URI patterns must match what the corresponding MCP clients use (typically `http://127.0.0.1:*` or `http://localhost:*`).

**Why configure separate upstream clients per MCP client?** While a single default upstream client_id works, configuring dedicated upstream clients per CIMD URL enables **distinct user consent screens** at the upstream IdP. The consent screen can display the specific application name (e.g. "Cursor IDE" vs "Claude Code"), giving users visibility into which MCP client is requesting access. This is the primary security benefit of per-client mapping -- users can make informed consent decisions and administrators can revoke access per MCP client independently.

### CIMD Security Considerations

- **Token `azp` mismatch**: Issued tokens contain the **upstream** client_id in the `azp` claim, not the CIMD URL the MCP client sent. This works only if MCP client validates `azp` against its own `client_id`. If a future client does, tokens would appear invalid -- an inherent limitation of client_id substitution that requires native IdP CIMD support to resolve.
- **SSRF protection**: DNS resolution checks (rejects private/loopback/link-local IPs including IPv6-mapped IPv4), no redirect following, 5KB response size limit, 5-second timeout.
- **DNS rebinding caveat**: A TOCTOU gap exists between the DNS check and the actual fetch connection. The cache mitigates this by limiting repeated fetches.
- **Cache isolation**: Configured (mapped) clients are pinned in cache and cannot be evicted by an attacker flooding unknown CIMD URLs. Unpinned cache is capped at 1000 entries.
- **Allowlist-first**: When `MCP_PROXY_CIMD_DEFAULT_CLIENT_ID` is not set, only mapped CIMD URLs are allowed; unknown URLs are rejected without any outbound fetch.
- **Token proxy**: Relays token requests to the upstream IdP with `client_id` substitution, body size limits, timeouts, response size limits, and header whitelisting.

## Token Issuer Validation

This adapter rewrites `issuer` in well-known metadata to its own `MCP_BASE_URL` (RFC 8414 §3.3), but tokens are issued by the **upstream IdP** -- their `iss` claim contains the upstream IdP URL.

**MCP servers and clients must not validate the access token JWT `iss` claim against this adapter's discovery `issuer`.**

Two correct approaches:

1. **Skip `iss` validation (recommended)** -- JWKS signature verification is sufficient. A valid signature against the adapter's `jwks_uri` (which points to the upstream IdP's JWKS) cryptographically proves the token's origin.
2. **Validate `iss` against the upstream IdP URL** -- configure the MCP server with `MCP_UPSTREAM_SSO_URL`, not `MCP_BASE_URL`.

This separation exists because the adapter is an lightweight authorization metadata facade, not a token issuer. It controls discovery, client registration, and authorization redirects, but all token operations remain at the upstream IdP.

All the major MCP clients we tested today are OK.

## Deployment Notes

### Upstream IdP Client Registration

Every `client_id` used by this adapter (both the DCR client and each CIMD-mapped client) must be pre-registered at the upstream IdP with the following settings:

| Setting | Value | Reason |
|---|---|---|
| Client type | Public | MCP clients cannot hold secrets (`token_endpoint_auth_method: none`) |
| Consent | **Enabled (required)** | User consent is the primary security control -- it lets users see which application is requesting access and decide whether to grant it |
| Standard flow | Enabled | Authorization code flow is the only flow used by MCP clients |
| Valid redirect URIs | See below | Must cover all MCP clients that will use this `client_id` |
| Allowed scopes | | Must cover all the scopes required by MCP servers using this MCP authentication adapter, mainly the one requiring pre-approval |

**Redirect URI patterns** to cover the most common MCP clients -- non-authoritative hints, please verify at the deployment time:

| Pattern | MCP Clients |
|---|---|
| `http://localhost:*` | Claude Code, Claude Desktop, Gemini CLI, Codex CLI, Codex App, Goose, Windsurf, Zed, Warp (CLI agents), Amazon Q CLI, MCP Inspector |
| `http://127.0.0.1:*` | VS Code |
| `https://claude.ai/api/mcp/auth_callback` | Claude.ai (web) |
| `https://claude.com/api/mcp/auth_callback` | Claude.com (web) |
| `https://chatgpt.com/connector_platform_oauth_redirect` | ChatGPT (web) |
| `https://chatgpt.com/connector/oauth/*` | ChatGPT (web) |
| `cursor://anysphere.cursor-mcp/*` | Cursor IDE |
| `https://insiders.vscode.dev/*` | VS Code Insiders (web) |
| `https://vscode.dev/*` | VS Code (web) |
| `warp://mcp/*` | Warp |
| `vscode://saoudrizwan.claude-dev/*` | Cline |

Note: ephemeral ports are typically used on localhost/127.0.0.1, so your IdP has to allow any port here. And any possible path also.

For the **DCR client** (`MCP_PROXY_DCR_CLIENT_ID`), configure all patterns above to support all MCP clients with a single shared client.

For **CIMD-mapped clients** (`MCP_PROXY_CIMD_MAP`), you can be more restrictive -- each upstream client only needs the redirect URI patterns for the specific MCP client it maps to. This is one of the advantages of per-client mapping: tighter redirect URI scoping alongside distinct consent screens.

### TLS

[RFC 7591 §5](https://rfc-editor.org/rfc/rfc7591#section-5) requires TLS for the DCR registration endpoint. In production, TLS should be terminated at the reverse proxy / load balancer in front of this application.

### Caching

Well-known endpoints return `Cache-Control: public, max-age=<seconds>` (half of `MCP_WELL_KNOWN_REFRESH_MINUTES`). DCR returns `Cache-Control: no-store`. CDNs (e.g. Akamai) must honor origin cache headers to ensure clients receive up-to-date discovery documents.

### Rate Limiting

[RFC 7591 §3](https://rfc-editor.org/rfc/rfc7591#section-3) recommends rate limiting for open DCR endpoints. This adapter does not implement app-level rate limiting -- it should be handled by an external WAF or reverse proxy (e.g. Akamai, Cloudflare, nginx).

### Upstream IdP Compatibility

On first startup (and after every `MCP_UPSTREAM_SSO_URL` change), review the adapter's log output for warnings prefixed with `Upstream IdP compatibility:`. These indicate the upstream IdP may not fully support MCP authorization requirements -- for example, missing `authorization_endpoint`, missing `token_endpoint`, or missing PKCE support (`code_challenge_methods_supported` without `S256`). The adapter injects safe defaults where possible, but these warnings should be investigated to ensure the upstream IdP is correctly configured for MCP flows.

## Health Probes

| Endpoint | Purpose | Response |
|---|---|---|
| `GET /health/live` | **Liveness** -- process is running, HTTP listener responsive | `200` |
| `GET /health/ready` | **Readiness** -- application initialized, ready to serve | `200` |

Both are mounted before body-parsing middleware. Neither checks upstream IdP availability -- the adapter is functional even with fallback defaults.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, testing, linting, and code style guidelines.

## Upstream Well-Known Handling

The adapter fetches the upstream IdP's discovery document at startup (trying OIDC and RFC 8414 paths) but only exposes a strict whitelist of fields relevant to MCP. See [Well-Known Field Filtering](#well-known-field-filtering) for details.

- **Discovery fallback chain**: The adapter tries `/.well-known/openid-configuration` first, then `/.well-known/oauth-authorization-server` (RFC 8414). If both fail, endpoints are derived from `MCP_UPSTREAM_SSO_URL` using Keycloak URL conventions (e.g. `{issuer}/protocol/openid-connect/auth`). **This last-resort fallback is Keycloak-specific** -- for other IdPs the derived URLs will be incorrect. Capability fields default to safe minimums (e.g. `code_challenge_methods_supported: ["S256"]`).
- **Flow-level defaults**: When the upstream provides `authorization_endpoint` and `token_endpoint` but omits flow fields, the adapter injects: `response_types_supported: ["code"]`, `grant_types_supported: ["authorization_code"]`, `code_challenge_methods_supported: ["S256"]`. Existing upstream values are never overridden.
- **Periodic refresh**: Re-fetches at the configured interval (default: 60 min). On success, the new document is used immediately. On failure, the previous document is kept.
- **Compatibility validation**: At startup and on each periodic refresh, the adapter validates the upstream document and logs `Upstream IdP compatibility:` warnings for:
  - Missing `authorization_endpoint` or `token_endpoint` (MCP authorization flow will not work).
  - Missing `code_challenge_methods_supported` (the adapter will advertise `["S256"]` but if the upstream doesn't actually support PKCE, token exchange will fail).
  - `code_challenge_methods_supported` present but without `S256` (MCP requires PKCE with S256).

### Well-Known Field Filtering

The adapter only exposes a strict whitelist of upstream fields. New upstream fields are **not** automatically included -- they must be added to `UPSTREAM_WHITELIST_FIELDS` in [`src/routes/well-known.ts`](src/routes/well-known.ts).

#### Included fields

`issuer`, `authorization_endpoint`, `token_endpoint`, `jwks_uri`, `registration_endpoint`, `scopes_supported`, `response_types_supported`, `response_modes_supported`, `grant_types_supported`, `token_endpoint_auth_methods_supported`, `token_endpoint_auth_signing_alg_values_supported`, `code_challenge_methods_supported`, `id_token_signing_alg_values_supported`, `subject_types_supported`, `claims_supported`, `introspection_endpoint`, `userinfo_endpoint`, `revocation_endpoint`, `authorization_response_iss_parameter_supported`

#### Adapted fields

| Field | Condition | Adaptation |
|---|---|---|
| `issuer` | Always | Replaced with `MCP_BASE_URL` per RFC 8414 §3.3 |
| `registration_endpoint` | `MCP_PROXY_DCR_CLIENT_ID` set | Replaced with `{MCP_BASE_URL}/register` |
| `authorization_endpoint` | Scope filtering or CIMD configured | Replaced with `{MCP_BASE_URL}/authorize` |
| `token_endpoint_auth_methods_supported` | DCR or CIMD enabled | `"none"` injected if not already present |
| `token_endpoint` | CIMD enabled | Rewritten to `{MCP_BASE_URL}/token` |
| `client_id_metadata_document_supported` | CIMD enabled | Set to `true` |
| `scopes_supported` | `MCP_WELL_KNOWN_SCOPES_SUPPORTED` set | Replaced with configured value; omitted if empty |
| `response_types_supported` | Upstream omits + auth flow present | Defaults to `["code"]` |
| `grant_types_supported` | Upstream omits + auth flow present | Defaults to `["authorization_code"]` |
| `code_challenge_methods_supported` | Upstream omits + auth flow present | Defaults to `["S256"]` |
| `authorization_response_iss_parameter_supported` | Auth proxy enabled | Removed (upstream issuer won't match rewritten issuer) |

#### Excluded fields (by category)

| Category | Fields | Reason |
|---|---|---|
| OIDC session / logout | `end_session_endpoint`, `check_session_iframe`, `frontchannel_logout_*`, `backchannel_logout_*` | MCP clients manage token lifecycles via expiration and revocation, not OIDC logout. |
| CIBA | `backchannel_authentication_endpoint`, `backchannel_authentication_request_signing_alg_*`, `backchannel_token_delivery_modes_supported` | Not part of MCP flows. |
| Device flow | `device_authorization_endpoint` | Not a standard MCP flow. |
| PAR | `pushed_authorization_request_endpoint`, `require_pushed_authorization_requests` | Not standard in MCP. |
| JAR / JARM | `request_object_*`, `request_parameter_supported`, `request_uri_parameter_supported`, `require_request_uri_registration`, `authorization_signing_alg_*`, `authorization_encryption_*` | Not used by MCP clients. |
| mTLS | `mtls_endpoint_aliases`, `tls_client_certificate_bound_access_tokens` | Not typical for MCP client flows. |
| Encryption | `id_token_encryption_*`, `userinfo_signing_alg_*`, `userinfo_encryption_*` | Not consumed by MCP clients. |
| Server-side auth | `introspection_endpoint_auth_*`, `revocation_endpoint_auth_*` | Server-side concern, not relevant to client discovery. |
| Misc | `claim_types_supported`, `claims_parameter_supported`, `acr_values_supported`, `prompt_values_supported` | Not needed for standard MCP flows. |

Note: This list is informative only, anything not included in `UPSTREAM_WHITELIST_FIELDS` is automatically excluded.

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines. All PRs must reference a GitHub issue, and new features should be discussed in an issue before implementation.

## License

This project is licensed under the [Apache License 2.0](LICENSE).

## Disclaimer

This project is an independent, community-driven effort. It is **not** affiliated with, endorsed by, or connected to Anthropic or the Model Context Protocol project. 
"Model Context Protocol" and "MCP" may be trademarks of their respective owners. Use of these names is solely for descriptive purposes to indicate compatibility.