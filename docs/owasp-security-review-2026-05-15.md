# OWASP Top 10 Security Review — mcp-auth-adapter

- **Date:** 2026-05-15
- **Performed by:** AI agent (Anthropic Claude, Opus 4.6) via Cursor IDE
- **Scope:** OWASP Top 10 (2021) review of the mcp-auth-adapter codebase
- **Commit range:** up to and including fixes from this review

---

## Overall Assessment

The codebase is well-hardened for its role as a thin auth proxy: JSON-only
responses (no HTML/XSS surface), generic error messages (no internal leaks),
explicit field whitelists on well-known docs and DCR echo, CIMD SSRF protections
(HTTPS-only, private IP blocking, redirect rejection, byte caps, timeouts), and
body size limits on all parsers. No Critical findings were identified. Two items
were fixed during this review; the rest are accepted risk or deployment guidance.

---

## Findings Summary

| # | Severity | Title | OWASP | Status |
|---|----------|-------|-------|--------|
| 1 | HIGH | Unbounded upstream well-known JSON parse | A05 | **Fixed** |
| 2 | LOW | Missing RFC 6598 in SSRF blocklist | A10 | **Fixed** |
| 3 | INFO | Upstream endpoint origin not validated | A01/A10 | Accepted risk |
| 4 | INFO | CIMD DNS rebinding / TOCTOU | A10 | Accepted risk |
| 5 | INFO | `/metrics` unauthenticated | A01 | Accepted risk |
| 6 | INFO | Debug logs may contain OAuth parameters | A09 | Accepted risk |
| 7 | INFO | No browser security headers | A05 | Accepted risk |
| 8 | INFO | Compression on token responses (BREACH) | A02 | Accepted risk |
| 9 | INFO | DCR echo reflects value shapes without validation | A08 | Accepted risk |
| 10 | INFO | CIMD rejection logged at debug level only | A09 | Accepted risk |

---

## Fixed Findings

### 1. HIGH — Unbounded upstream well-known JSON parse

- **OWASP:** A05 (Security Misconfiguration) / Availability
- **File:** `src/index.ts`
- **Issue:** `response.json()` buffered the entire upstream well-known body with
  no byte cap. CIMD and token reads both used `readResponseWithLimit`, but the
  discovery fetch did not. A compromised or buggy upstream returning a multi-GB
  JSON body would cause OOM.
- **Resolution:** Replaced `response.json()` with `readResponseWithLimit`
  (from `src/fetch-utils.ts`) capped at 256 KB, followed by `JSON.parse`.

### 2. LOW — Missing RFC 6598 Shared Address Space in SSRF blocklist

- **OWASP:** A10 (SSRF)
- **File:** `src/cimd.ts` — `isPrivateIPv4`
- **Issue:** `100.64.0.0/10` (RFC 6598 Carrier-Grade NAT / Shared Address Space)
  was not blocked. Some cloud/VPC environments route this range internally (e.g.,
  AWS VPC uses `100.64.x.x` for DNS and other internal services).
- **Resolution:** Added `100.64.0.0/10` check to `isPrivateIPv4`. Test coverage
  added in `test/cimd.test.ts` for both IPv4 and IPv6-mapped variants.

---

## Accepted Risk / Informational

### 3. INFO — Upstream endpoint origin not validated

- **OWASP:** A01 (Broken Access Control) / A10 (SSRF)
- **File:** `src/app.ts`
- **Details:** `authorization_endpoint` and `token_endpoint` from the upstream
  well-known doc are used without verifying they belong to the same origin as
  `MCP_UPSTREAM_SSO_URL`.
- **Risk acceptance rationale:** The upstream doc is fetched from the
  operator-configured `MCP_UPSTREAM_SSO_URL` over TLS. A malicious endpoint in
  that doc would require a compromised IdP, which is out of scope. Adding origin
  validation would conflict with legitimate multi-host IdP topologies and add
  configuration complexity disproportionate to the risk.

### 4. INFO — CIMD DNS rebinding / TOCTOU

- **OWASP:** A10 (SSRF)
- **File:** `src/cimd.ts`
- **Details:** A time-of-check/time-of-use gap exists between DNS resolution
  (private IP check) and the subsequent HTTPS fetch.
- **Risk acceptance rationale:** Already documented in README. Mitigated by
  cache (limits repeated fetches), HTTPS-only, redirect rejection, and byte
  caps. True fix requires connecting to the resolved IP directly (complex,
  breaks TLS SNI).

### 5. INFO — `/metrics` unauthenticated

- **OWASP:** A01
- **Risk acceptance rationale:** Already documented in README as an
  unauthenticated operational endpoint intended for cluster-internal use only.
  Should not be exposed to untrusted networks.

### 6. INFO — Debug logs may contain OAuth parameters

- **OWASP:** A09 (Logging)
- **Files:** `src/routes/authorize.ts`, `src/routes/token.ts`
- **Risk acceptance rationale:** Only emitted when `MCP_DEBUG=true` (default
  off). Standard debug-level tracing. Operators enabling debug accept this
  trade-off.

### 7. INFO — No browser security headers

- **OWASP:** A05
- **File:** `src/app.ts`
- **Details:** No HSTS, X-Content-Type-Options, CSP, or X-Frame-Options headers.
- **Risk acceptance rationale:** This is a backend API/proxy, not a
  browser-facing app. Headers should be set at the reverse proxy layer per
  deployment. `x-powered-by` is already disabled.

### 8. INFO — Compression on token responses (BREACH theoretical)

- **OWASP:** A02
- **File:** `src/app.ts`
- **Risk acceptance rationale:** BREACH requires attacker-chosen plaintext +
  secret in the same compressed response + many requests. Token responses are
  one-shot, not reflective. Negligible real-world risk.

### 9. INFO — DCR echo reflects value shapes without schema validation

- **OWASP:** A08
- **File:** `src/routes/register.ts`
- **Details:** Keys are whitelisted (good). Values are passed through as-is
  (e.g., `redirect_uris` could be a string instead of an array).
- **Risk acceptance rationale:** Low impact — only affects the DCR response the
  client itself sent.

### 10. INFO — CIMD rejection logged at debug level only

- **OWASP:** A09
- **File:** `src/routes/authorize.ts`
- **Risk acceptance rationale:** 403 responses are returned; HTTP metrics
  capture the status code. Reverse proxy / LB access logs provide per-request
  visibility. Acceptable for this project's logging philosophy.

---

## Not Applicable / Not Found

| OWASP Category | Status |
|---|---|
| A03 Injection (SQL/NoSQL/OS) | N/A — no database, no shell exec |
| A04 Insecure Design | N/A — auth is delegated to upstream IdP |
| A06 Vulnerable Components | No known CVEs in express@4.22, compression@1.8, dotenv@17 |
| A07 XSS | N/A — all responses are JSON, no HTML rendering |
