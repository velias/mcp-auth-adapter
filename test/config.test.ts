import { loadConfig, parseClientNameMap, matchClientName, buildClientIdRedirectMap, ParsedClientNameEntry } from '../src/config';

const REQUIRED_ENV = {
  MCP_BASE_URL: 'http://localhost:3000',
  MCP_UPSTREAM_SSO_URL: 'https://sso.example.com/auth/realms/test',
};

const VALID_HEX_SECRET = 'a'.repeat(64);
const VALID_REDIRECT_URIS = 'http://localhost:*';

function withEnv(extra: Record<string, string>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  const allKeys = new Set([...Object.keys(REQUIRED_ENV), ...Object.keys(extra)]);
  for (const key of allKeys) {
    saved[key] = process.env[key];
  }
  try {
    for (const key of Object.keys(REQUIRED_ENV)) {
      process.env[key] = REQUIRED_ENV[key as keyof typeof REQUIRED_ENV];
    }
    for (const [key, value] of Object.entries(extra)) {
      process.env[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Required env vars
// ---------------------------------------------------------------------------
describe('loadConfig — required env vars', () => {
  it('throws when MCP_BASE_URL is missing', () => {
    withEnv({}, () => {
      delete process.env.MCP_BASE_URL;
      expect(() => loadConfig()).toThrow(/MCP_BASE_URL/);
    });
  });

  it('throws when MCP_UPSTREAM_SSO_URL is missing', () => {
    withEnv({}, () => {
      delete process.env.MCP_UPSTREAM_SSO_URL;
      expect(() => loadConfig()).toThrow(/MCP_UPSTREAM_SSO_URL/);
    });
  });

  it('returns config with only required vars set', () => {
    withEnv({}, () => {
      const cfg = loadConfig();
      expect(cfg.baseUrl).toBe(REQUIRED_ENV.MCP_BASE_URL);
      expect(cfg.upstreamSsoUrl).toBe(REQUIRED_ENV.MCP_UPSTREAM_SSO_URL);
      expect(cfg.port).toBe(3000);
      expect(cfg.clientId).toBe('');
      expect(cfg.proxyDcrEndpoint).toBe(false);
      expect(cfg.proxyAuthEndpoint).toBe(false);
      expect(cfg.cimdEnabled).toBe(false);
      expect(cfg.debug).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------
describe('loadConfig — URL validation', () => {
  it('rejects malformed MCP_BASE_URL', () => {
    withEnv({ MCP_BASE_URL: 'not-a-url' }, () => {
      expect(() => loadConfig()).toThrow(/MCP_BASE_URL.*not a valid URL/);
    });
  });

  it('rejects non-http/https scheme for MCP_BASE_URL', () => {
    withEnv({ MCP_BASE_URL: 'ftp://files.example.com' }, () => {
      expect(() => loadConfig()).toThrow(/MCP_BASE_URL.*http or https/);
    });
  });

  it('rejects malformed MCP_UPSTREAM_SSO_URL', () => {
    withEnv({ MCP_UPSTREAM_SSO_URL: '://broken' }, () => {
      expect(() => loadConfig()).toThrow(/MCP_UPSTREAM_SSO_URL.*not a valid URL/);
    });
  });

  it('rejects non-http/https scheme for MCP_UPSTREAM_SSO_URL', () => {
    withEnv({ MCP_UPSTREAM_SSO_URL: 'file:///etc/passwd' }, () => {
      expect(() => loadConfig()).toThrow(/MCP_UPSTREAM_SSO_URL.*http or https/);
    });
  });

  it('strips trailing slashes from MCP_BASE_URL', () => {
    withEnv({ MCP_BASE_URL: 'http://localhost:3000///' }, () => {
      expect(loadConfig().baseUrl).toBe('http://localhost:3000');
    });
  });

  it('strips trailing slash from MCP_UPSTREAM_SSO_URL', () => {
    withEnv({ MCP_UPSTREAM_SSO_URL: 'https://sso.example.com/auth/realms/test/' }, () => {
      expect(loadConfig().upstreamSsoUrl).toBe('https://sso.example.com/auth/realms/test');
    });
  });

  it('accepts valid http URL', () => {
    withEnv({ MCP_BASE_URL: 'http://localhost:3000' }, () => {
      expect(loadConfig().baseUrl).toBe('http://localhost:3000');
    });
  });

  it('accepts valid https URL', () => {
    withEnv({ MCP_UPSTREAM_SSO_URL: 'https://sso.example.com/realm' }, () => {
      expect(loadConfig().upstreamSsoUrl).toBe('https://sso.example.com/realm');
    });
  });
});

// ---------------------------------------------------------------------------
// parseIntEnv — port, refresh, etc.
// ---------------------------------------------------------------------------
describe('loadConfig — integer env vars', () => {
  it('accepts a valid port', () => {
    withEnv({ MCP_PORT: '8080' }, () => {
      expect(loadConfig().port).toBe(8080);
    });
  });

  it('rejects fractional port value', () => {
    withEnv({ MCP_PORT: '3000.7' }, () => {
      expect(() => loadConfig()).toThrow(/MCP_PORT.*integer/);
    });
  });

  it('rejects negative port value', () => {
    withEnv({ MCP_PORT: '-1' }, () => {
      expect(() => loadConfig()).toThrow(/MCP_PORT.*>= 1/);
    });
  });

  it('rejects zero port value', () => {
    withEnv({ MCP_PORT: '0' }, () => {
      expect(() => loadConfig()).toThrow(/MCP_PORT.*>= 1/);
    });
  });

  it('rejects non-numeric port value', () => {
    withEnv({ MCP_PORT: 'abc' }, () => {
      expect(() => loadConfig()).toThrow(/MCP_PORT.*integer/);
    });
  });

  it('rejects port with trailing text', () => {
    withEnv({ MCP_PORT: '3000abc' }, () => {
      expect(() => loadConfig()).toThrow(/MCP_PORT.*integer/);
    });
  });

  it('accepts a valid well-known refresh interval', () => {
    withEnv({ MCP_WELL_KNOWN_REFRESH_MINUTES: '5' }, () => {
      expect(loadConfig().wellKnownRefreshMinutes).toBe(5);
    });
  });

  it('rejects fractional well-known refresh', () => {
    withEnv({ MCP_WELL_KNOWN_REFRESH_MINUTES: '1.5' }, () => {
      expect(() => loadConfig()).toThrow(/MCP_WELL_KNOWN_REFRESH_MINUTES.*integer/);
    });
  });

  it('rejects negative shutdown timeout', () => {
    withEnv({ MCP_SHUTDOWN_TIMEOUT_SECONDS: '-10' }, () => {
      expect(() => loadConfig()).toThrow(/MCP_SHUTDOWN_TIMEOUT_SECONDS.*>= 0/);
    });
  });

  it('accepts zero for shutdown timeout', () => {
    withEnv({ MCP_SHUTDOWN_TIMEOUT_SECONDS: '0' }, () => {
      expect(loadConfig().shutdownTimeoutSeconds).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// Boolean env var (MCP_DEBUG)
// ---------------------------------------------------------------------------
describe('loadConfig — boolean env vars', () => {
  it.each(['true', 'TRUE', 'True'])('MCP_DEBUG="%s" → debug=true', (val) => {
    withEnv({ MCP_DEBUG: val }, () => {
      expect(loadConfig().debug).toBe(true);
    });
  });

  it.each(['false', 'FALSE', '0', 'anything'])('MCP_DEBUG="%s" → debug=false', (val) => {
    withEnv({ MCP_DEBUG: val }, () => {
      expect(loadConfig().debug).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Access log (MCP_ACCESS_LOG)
// ---------------------------------------------------------------------------
describe('loadConfig — access log', () => {
  it('defaults to true when unset', () => {
    withEnv({}, () => {
      expect(loadConfig().accessLog).toBe(true);
    });
  });

  it.each(['true', 'TRUE', 'True'])('MCP_ACCESS_LOG="%s" → accessLog=true', (val) => {
    withEnv({ MCP_ACCESS_LOG: val }, () => {
      expect(loadConfig().accessLog).toBe(true);
    });
  });

  it.each(['false', 'FALSE', '0', 'anything'])('MCP_ACCESS_LOG="%s" → accessLog=false', (val) => {
    withEnv({ MCP_ACCESS_LOG: val }, () => {
      expect(loadConfig().accessLog).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Scopes env vars
// ---------------------------------------------------------------------------
describe('loadConfig — scopes env vars', () => {
  it('parses comma-separated scopes', () => {
    withEnv({ MCP_WELL_KNOWN_SCOPES_SUPPORTED: 'openid,profile, email ' }, () => {
      const cfg = loadConfig();
      expect(cfg.scopesSupported).toEqual(['openid', 'profile', 'email']);
    });
  });

  it('returns undefined for empty scopes', () => {
    withEnv({ MCP_WELL_KNOWN_SCOPES_SUPPORTED: '' }, () => {
      expect(loadConfig().scopesSupported).toBeUndefined();
    });
  });

  it('returns undefined for whitespace-only scopes', () => {
    withEnv({ MCP_WELL_KNOWN_SCOPES_SUPPORTED: ' , , ' }, () => {
      expect(loadConfig().scopesSupported).toBeUndefined();
    });
  });

  it('parses authScopesRemoved and enables proxy', () => {
    withEnv({ MCP_PROXY_AUTH_SCOPES_REMOVED: 'offline_access', MCP_PROXY_AUTH_STATE_SECRET: VALID_HEX_SECRET, MCP_PROXY_AUTH_ALLOWED_REDIRECT_URIS: VALID_REDIRECT_URIS }, () => {
      const cfg = loadConfig();
      expect(cfg.authScopesRemoved).toEqual(['offline_access']);
      expect(cfg.proxyAuthEndpoint).toBe(true);
    });
  });

  it('parses authScopesPreserved and enables proxy', () => {
    withEnv({ MCP_PROXY_AUTH_SCOPES_PRESERVED: 'openid,profile', MCP_PROXY_AUTH_STATE_SECRET: VALID_HEX_SECRET, MCP_PROXY_AUTH_ALLOWED_REDIRECT_URIS: VALID_REDIRECT_URIS }, () => {
      const cfg = loadConfig();
      expect(cfg.authScopesPreserved).toEqual(['openid', 'profile']);
      expect(cfg.proxyAuthEndpoint).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// DCR client_id
// ---------------------------------------------------------------------------
describe('loadConfig — DCR client_id', () => {
  it('enables DCR when MCP_PROXY_DCR_CLIENT_ID is set', () => {
    withEnv({ MCP_PROXY_DCR_CLIENT_ID: 'my-client' }, () => {
      const cfg = loadConfig();
      expect(cfg.clientId).toBe('my-client');
      expect(cfg.proxyDcrEndpoint).toBe(true);
    });
  });

  it('trims whitespace from client_id', () => {
    withEnv({ MCP_PROXY_DCR_CLIENT_ID: '  my-client  ' }, () => {
      expect(loadConfig().clientId).toBe('my-client');
    });
  });

  it('treats whitespace-only client_id as absent', () => {
    withEnv({ MCP_PROXY_DCR_CLIENT_ID: '   ' }, () => {
      const cfg = loadConfig();
      expect(cfg.clientId).toBe('');
      expect(cfg.proxyDcrEndpoint).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// CIMD map
// ---------------------------------------------------------------------------
describe('loadConfig — CIMD map', () => {
  it('parses valid CIMD map JSON', () => {
    const map = { 'https://example.com/client-metadata': 'upstream-id' };
    withEnv({ MCP_PROXY_CIMD_MAP: JSON.stringify(map), MCP_PROXY_AUTH_STATE_SECRET: VALID_HEX_SECRET }, () => {
      const cfg = loadConfig();
      expect(cfg.cimdMap).toEqual(map);
      expect(cfg.cimdEnabled).toBe(true);
      expect(cfg.proxyAuthEndpoint).toBe(true);
    });
  });

  it('rejects non-JSON CIMD map', () => {
    withEnv({ MCP_PROXY_CIMD_MAP: 'not-json' }, () => {
      expect(() => loadConfig()).toThrow(/not valid JSON/);
    });
  });

  it('rejects array CIMD map', () => {
    withEnv({ MCP_PROXY_CIMD_MAP: '["a","b"]' }, () => {
      expect(() => loadConfig()).toThrow(/must be a JSON object/);
    });
  });

  it('rejects non-string values in CIMD map', () => {
    withEnv({ MCP_PROXY_CIMD_MAP: '{"https://example.com/meta": 42}' }, () => {
      expect(() => loadConfig()).toThrow(/non-string value/);
    });
  });

  it('rejects empty upstream client_id in CIMD map', () => {
    withEnv({ MCP_PROXY_CIMD_MAP: '{"https://example.com/meta": "  "}' }, () => {
      expect(() => loadConfig()).toThrow(/empty upstream client_id/);
    });
  });

  it('rejects invalid CIMD URL in map (http scheme)', () => {
    const map = { 'http://example.com/meta': 'upstream-id' };
    withEnv({ MCP_PROXY_CIMD_MAP: JSON.stringify(map) }, () => {
      expect(() => loadConfig()).toThrow(/invalid CIMD URL/);
    });
  });

  it('returns empty map when MCP_PROXY_CIMD_MAP is unset', () => {
    withEnv({}, () => {
      expect(loadConfig().cimdMap).toEqual({});
    });
  });

  it('returns empty map when MCP_PROXY_CIMD_MAP is empty string', () => {
    withEnv({ MCP_PROXY_CIMD_MAP: '' }, () => {
      expect(loadConfig().cimdMap).toEqual({});
    });
  });
});

// ---------------------------------------------------------------------------
// CIMD default client_id & cache
// ---------------------------------------------------------------------------
describe('loadConfig — CIMD default & cache', () => {
  it('enables CIMD with only default client_id', () => {
    withEnv({ MCP_PROXY_CIMD_DEFAULT_CLIENT_ID: 'default-client', MCP_PROXY_AUTH_STATE_SECRET: VALID_HEX_SECRET }, () => {
      const cfg = loadConfig();
      expect(cfg.cimdDefaultClientId).toBe('default-client');
      expect(cfg.cimdEnabled).toBe(true);
    });
  });

  it('uses cache minutes default of 30', () => {
    withEnv({}, () => {
      expect(loadConfig().cimdCacheMinutes).toBe(30);
    });
  });

  it('accepts custom cache minutes', () => {
    withEnv({ MCP_PROXY_CIMD_CACHE_MINUTES: '10' }, () => {
      expect(loadConfig().cimdCacheMinutes).toBe(10);
    });
  });

  it('rejects fractional cache minutes', () => {
    withEnv({ MCP_PROXY_CIMD_CACHE_MINUTES: '2.5' }, () => {
      expect(() => loadConfig()).toThrow(/MCP_PROXY_CIMD_CACHE_MINUTES.*integer/);
    });
  });
});

// ---------------------------------------------------------------------------
// Auto-enable logic
// ---------------------------------------------------------------------------
describe('loadConfig — auto-enable logic', () => {
  it('does not enable proxyAuthEndpoint with no relevant config', () => {
    withEnv({}, () => {
      expect(loadConfig().proxyAuthEndpoint).toBe(false);
    });
  });

  it('enables proxyAuthEndpoint when CIMD is configured', () => {
    withEnv({ MCP_PROXY_CIMD_DEFAULT_CLIENT_ID: 'x', MCP_PROXY_AUTH_STATE_SECRET: VALID_HEX_SECRET }, () => {
      expect(loadConfig().proxyAuthEndpoint).toBe(true);
    });
  });

  it('enables proxyAuthEndpoint when scopesRemoved is set', () => {
    withEnv({ MCP_PROXY_AUTH_SCOPES_REMOVED: 'offline_access', MCP_PROXY_AUTH_STATE_SECRET: VALID_HEX_SECRET, MCP_PROXY_AUTH_ALLOWED_REDIRECT_URIS: VALID_REDIRECT_URIS }, () => {
      expect(loadConfig().proxyAuthEndpoint).toBe(true);
    });
  });

  it('enables proxyAuthEndpoint when scopesPreserved is set', () => {
    withEnv({ MCP_PROXY_AUTH_SCOPES_PRESERVED: 'openid', MCP_PROXY_AUTH_STATE_SECRET: VALID_HEX_SECRET, MCP_PROXY_AUTH_ALLOWED_REDIRECT_URIS: VALID_REDIRECT_URIS }, () => {
      expect(loadConfig().proxyAuthEndpoint).toBe(true);
    });
  });

  it('enables proxyAuthEndpoint when only state secret is set', () => {
    withEnv({ MCP_PROXY_AUTH_STATE_SECRET: VALID_HEX_SECRET, MCP_PROXY_AUTH_ALLOWED_REDIRECT_URIS: VALID_REDIRECT_URIS }, () => {
      expect(loadConfig().proxyAuthEndpoint).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// State secret validation
// ---------------------------------------------------------------------------
describe('loadConfig — state secret', () => {
  it('throws when proxyAuthEndpoint is true but state secret is missing', () => {
    withEnv({ MCP_PROXY_AUTH_SCOPES_REMOVED: 'offline_access' }, () => {
      expect(() => loadConfig()).toThrow(/MCP_PROXY_AUTH_STATE_SECRET/);
    });
  });

  it('treats empty string as not configured (does not activate auth proxy)', () => {
    withEnv({ MCP_PROXY_AUTH_STATE_SECRET: '' }, () => {
      const cfg = loadConfig();
      expect(cfg.proxyAuthEndpoint).toBe(false);
      expect(cfg.authStateSecret).toBeUndefined();
    });
  });

  it('treats whitespace-only as not configured', () => {
    withEnv({ MCP_PROXY_AUTH_STATE_SECRET: '   ' }, () => {
      const cfg = loadConfig();
      expect(cfg.proxyAuthEndpoint).toBe(false);
      expect(cfg.authStateSecret).toBeUndefined();
    });
  });

  it('throws for non-hex characters', () => {
    withEnv({ MCP_PROXY_AUTH_STATE_SECRET: 'g'.repeat(64) }, () => {
      expect(() => loadConfig()).toThrow(/hex/);
    });
  });

  it('throws for odd-length hex string', () => {
    withEnv({ MCP_PROXY_AUTH_STATE_SECRET: 'a'.repeat(65) }, () => {
      expect(() => loadConfig()).toThrow(/even length/);
    });
  });

  it('throws for hex string shorter than 64 chars (< 32 bytes)', () => {
    withEnv({ MCP_PROXY_AUTH_STATE_SECRET: 'a'.repeat(62) }, () => {
      expect(() => loadConfig()).toThrow(/at least 32 bytes/);
    });
  });

  it('parses valid hex secret to Buffer', () => {
    withEnv({ MCP_PROXY_AUTH_STATE_SECRET: VALID_HEX_SECRET, MCP_PROXY_AUTH_ALLOWED_REDIRECT_URIS: VALID_REDIRECT_URIS }, () => {
      const cfg = loadConfig();
      expect(cfg.authStateSecret).toBeInstanceOf(Buffer);
      expect(cfg.authStateSecret!.length).toBe(32);
    });
  });

  it('accepts uppercase hex', () => {
    withEnv({ MCP_PROXY_AUTH_STATE_SECRET: 'A'.repeat(64), MCP_PROXY_AUTH_ALLOWED_REDIRECT_URIS: VALID_REDIRECT_URIS }, () => {
      const cfg = loadConfig();
      expect(cfg.authStateSecret).toBeInstanceOf(Buffer);
    });
  });

  it('trims whitespace from secret', () => {
    withEnv({ MCP_PROXY_AUTH_STATE_SECRET: '  ' + VALID_HEX_SECRET + '  ', MCP_PROXY_AUTH_ALLOWED_REDIRECT_URIS: VALID_REDIRECT_URIS }, () => {
      const cfg = loadConfig();
      expect(cfg.authStateSecret).toBeInstanceOf(Buffer);
    });
  });
});

// ---------------------------------------------------------------------------
// State secret previous (optional)
// ---------------------------------------------------------------------------
describe('loadConfig — state secret previous', () => {
  it('is undefined when not set', () => {
    withEnv({ MCP_PROXY_AUTH_STATE_SECRET: VALID_HEX_SECRET, MCP_PROXY_AUTH_ALLOWED_REDIRECT_URIS: VALID_REDIRECT_URIS }, () => {
      expect(loadConfig().authStateSecretPrevious).toBeUndefined();
    });
  });

  it('treats empty string as not configured', () => {
    withEnv({ MCP_PROXY_AUTH_STATE_SECRET: VALID_HEX_SECRET, MCP_PROXY_AUTH_STATE_SECRET_PREVIOUS: '', MCP_PROXY_AUTH_ALLOWED_REDIRECT_URIS: VALID_REDIRECT_URIS }, () => {
      expect(loadConfig().authStateSecretPrevious).toBeUndefined();
    });
  });

  it('parses valid previous secret', () => {
    withEnv({
      MCP_PROXY_AUTH_STATE_SECRET: VALID_HEX_SECRET,
      MCP_PROXY_AUTH_STATE_SECRET_PREVIOUS: 'b'.repeat(64),
      MCP_PROXY_AUTH_ALLOWED_REDIRECT_URIS: VALID_REDIRECT_URIS,
    }, () => {
      const cfg = loadConfig();
      expect(cfg.authStateSecretPrevious).toBeInstanceOf(Buffer);
      expect(cfg.authStateSecretPrevious!.length).toBe(32);
    });
  });

  it('throws for invalid previous secret format', () => {
    withEnv({
      MCP_PROXY_AUTH_STATE_SECRET: VALID_HEX_SECRET,
      MCP_PROXY_AUTH_STATE_SECRET_PREVIOUS: 'not-hex',
      MCP_PROXY_AUTH_ALLOWED_REDIRECT_URIS: VALID_REDIRECT_URIS,
    }, () => {
      expect(() => loadConfig()).toThrow(/MCP_PROXY_AUTH_STATE_SECRET_PREVIOUS.*hex/);
    });
  });
});

// ---------------------------------------------------------------------------
// State TTL
// ---------------------------------------------------------------------------
describe('loadConfig — state TTL', () => {
  it('defaults to 30 minutes (1800 seconds)', () => {
    withEnv({ MCP_PROXY_AUTH_STATE_SECRET: VALID_HEX_SECRET, MCP_PROXY_AUTH_ALLOWED_REDIRECT_URIS: VALID_REDIRECT_URIS }, () => {
      expect(loadConfig().authStateTtlSeconds).toBe(1800);
    });
  });

  it('parses custom TTL', () => {
    withEnv({ MCP_PROXY_AUTH_STATE_SECRET: VALID_HEX_SECRET, MCP_PROXY_AUTH_STATE_TTL_MINUTES: '10', MCP_PROXY_AUTH_ALLOWED_REDIRECT_URIS: VALID_REDIRECT_URIS }, () => {
      expect(loadConfig().authStateTtlSeconds).toBe(600);
    });
  });

  it('throws for TTL below minimum (0)', () => {
    withEnv({ MCP_PROXY_AUTH_STATE_SECRET: VALID_HEX_SECRET, MCP_PROXY_AUTH_STATE_TTL_MINUTES: '0', MCP_PROXY_AUTH_ALLOWED_REDIRECT_URIS: VALID_REDIRECT_URIS }, () => {
      expect(() => loadConfig()).toThrow(/MCP_PROXY_AUTH_STATE_TTL_MINUTES.*>= 1/);
    });
  });
});

// ---------------------------------------------------------------------------
// Allowed redirect URIs
// ---------------------------------------------------------------------------
describe('loadConfig — allowed redirect URIs', () => {
  it('returns empty array when not set (CIMD-only mode)', () => {
    withEnv({ MCP_PROXY_AUTH_STATE_SECRET: VALID_HEX_SECRET, MCP_PROXY_CIMD_DEFAULT_CLIENT_ID: 'default' }, () => {
      expect(loadConfig().allowedRedirectUris).toEqual([]);
    });
  });

  it('treats empty string as not configured (returns empty array)', () => {
    withEnv({ MCP_PROXY_AUTH_STATE_SECRET: VALID_HEX_SECRET, MCP_PROXY_CIMD_DEFAULT_CLIENT_ID: 'default', MCP_PROXY_AUTH_ALLOWED_REDIRECT_URIS: '' }, () => {
      expect(loadConfig().allowedRedirectUris).toEqual([]);
    });
  });

  it('parses comma-separated patterns', () => {
    withEnv({
      MCP_PROXY_AUTH_STATE_SECRET: VALID_HEX_SECRET,
      MCP_PROXY_AUTH_ALLOWED_REDIRECT_URIS: 'http://localhost:*,https://example.com/cb',
    }, () => {
      expect(loadConfig().allowedRedirectUris).toEqual(['http://localhost:*', 'https://example.com/cb']);
    });
  });

  it('trims whitespace per pattern', () => {
    withEnv({
      MCP_PROXY_AUTH_STATE_SECRET: VALID_HEX_SECRET,
      MCP_PROXY_AUTH_ALLOWED_REDIRECT_URIS: ' http://localhost:* , https://example.com/cb ',
    }, () => {
      expect(loadConfig().allowedRedirectUris).toEqual(['http://localhost:*', 'https://example.com/cb']);
    });
  });

  it('throws for pattern without scheme', () => {
    withEnv({
      MCP_PROXY_AUTH_STATE_SECRET: VALID_HEX_SECRET,
      MCP_PROXY_AUTH_ALLOWED_REDIRECT_URIS: 'localhost:8080',
    }, () => {
      expect(() => loadConfig()).toThrow(/invalid pattern.*scheme/i);
    });
  });

  it('throws when auth proxy active with DCR but no patterns configured', () => {
    withEnv({
      MCP_PROXY_AUTH_STATE_SECRET: VALID_HEX_SECRET,
      MCP_PROXY_DCR_CLIENT_ID: 'mcp-client',
    }, () => {
      expect(() => loadConfig()).toThrow(/MCP_PROXY_AUTH_ALLOWED_REDIRECT_URIS/);
    });
  });

  it('throws when required (standalone state secret, no DCR, no CIMD) but empty', () => {
    withEnv({
      MCP_PROXY_AUTH_STATE_SECRET: VALID_HEX_SECRET,
    }, () => {
      expect(() => loadConfig()).toThrow(/MCP_PROXY_AUTH_ALLOWED_REDIRECT_URIS/);
    });
  });

  it('does not throw when CIMD-only (no DCR)', () => {
    withEnv({
      MCP_PROXY_AUTH_STATE_SECRET: VALID_HEX_SECRET,
      MCP_PROXY_CIMD_DEFAULT_CLIENT_ID: 'default',
    }, () => {
      expect(() => loadConfig()).not.toThrow();
    });
  });
});

// ---------------------------------------------------------------------------
// RFC 8707 Resource parameter config
// ---------------------------------------------------------------------------
describe('loadConfig — resource parameter config', () => {
  it('requireResource defaults to false when unset', () => {
    withEnv({}, () => {
      expect(loadConfig().requireResource).toBe(false);
    });
  });

  it('requireResource is true when env is "true"', () => {
    withEnv({ MCP_PROXY_AUTH_REQUIRE_RESOURCE: 'true' }, () => {
      expect(loadConfig().requireResource).toBe(true);
    });
  });

  it('requireResource is false when env is "false"', () => {
    withEnv({ MCP_PROXY_AUTH_REQUIRE_RESOURCE: 'false' }, () => {
      expect(loadConfig().requireResource).toBe(false);
    });
  });

  it('allowedResources returns empty array when unset', () => {
    withEnv({}, () => {
      expect(loadConfig().allowedResources).toEqual([]);
    });
  });

  it('allowedResources parses comma-separated patterns', () => {
    withEnv({ MCP_PROXY_AUTH_ALLOWED_RESOURCES: 'https://mcp.example.com/*,https://api.example.com/mcp' }, () => {
      expect(loadConfig().allowedResources.map(p => p.original)).toEqual(['https://mcp.example.com/*', 'https://api.example.com/mcp']);
    });
  });

  it('allowedResources trims whitespace', () => {
    withEnv({ MCP_PROXY_AUTH_ALLOWED_RESOURCES: ' https://mcp.example.com/* , https://api.example.com/mcp ' }, () => {
      expect(loadConfig().allowedResources.map(p => p.original)).toEqual(['https://mcp.example.com/*', 'https://api.example.com/mcp']);
    });
  });

  it('allowedResources rejects patterns without http/https scheme', () => {
    withEnv({ MCP_PROXY_AUTH_ALLOWED_RESOURCES: 'cursor://foo/*' }, () => {
      expect(() => loadConfig()).toThrow(/MCP_PROXY_AUTH_ALLOWED_RESOURCES.*http:\/\/ or https:\/\//);
    });
  });

  it('allowedResources rejects patterns without any scheme', () => {
    withEnv({ MCP_PROXY_AUTH_ALLOWED_RESOURCES: 'mcp.example.com/foo' }, () => {
      expect(() => loadConfig()).toThrow(/MCP_PROXY_AUTH_ALLOWED_RESOURCES.*http:\/\/ or https:\/\//);
    });
  });

  it('allowedResources accepts http:// patterns (for dev)', () => {
    withEnv({ MCP_PROXY_AUTH_ALLOWED_RESOURCES: 'http://localhost:3000/*' }, () => {
      expect(loadConfig().allowedResources.map(p => p.original)).toEqual(['http://localhost:3000/*']);
    });
  });

  it('both fields are independent of auth proxy config', () => {
    withEnv({ MCP_PROXY_AUTH_REQUIRE_RESOURCE: 'true', MCP_PROXY_AUTH_ALLOWED_RESOURCES: 'https://mcp.example.com/*' }, () => {
      const cfg = loadConfig();
      expect(cfg.requireResource).toBe(true);
      expect(cfg.allowedResources.map(p => p.original)).toEqual(['https://mcp.example.com/*']);
      expect(cfg.proxyAuthEndpoint).toBe(false);
    });
  });

  it('allowedResources accepts domain wildcard + path wildcard', () => {
    withEnv({ MCP_PROXY_AUTH_ALLOWED_RESOURCES: 'https://*.corp.example.com/*' }, () => {
      expect(loadConfig().allowedResources.map(p => p.original)).toEqual(['https://*.corp.example.com/*']);
    });
  });

  it('allowedResources accepts domain wildcard with exact path', () => {
    withEnv({ MCP_PROXY_AUTH_ALLOWED_RESOURCES: 'https://*.corp.example.com/api/v1' }, () => {
      expect(loadConfig().allowedResources.map(p => p.original)).toEqual(['https://*.corp.example.com/api/v1']);
    });
  });

  it('allowedResources accepts http domain wildcard', () => {
    withEnv({ MCP_PROXY_AUTH_ALLOWED_RESOURCES: 'http://*.corp.example.com/*' }, () => {
      expect(loadConfig().allowedResources.map(p => p.original)).toEqual(['http://*.corp.example.com/*']);
    });
  });

  it('allowedResources rejects domain wildcard without scheme', () => {
    withEnv({ MCP_PROXY_AUTH_ALLOWED_RESOURCES: '*.corp.example.com/*' }, () => {
      expect(() => loadConfig()).toThrow(/MCP_PROXY_AUTH_ALLOWED_RESOURCES.*http:\/\/ or https:\/\//);
    });
  });

  it('allowedResources rejects bare wildcard host https://*/*', () => {
    withEnv({ MCP_PROXY_AUTH_ALLOWED_RESOURCES: 'https://*/*' }, () => {
      expect(() => loadConfig()).toThrow(/bare \* is not allowed/);
    });
  });

  it('allowedResources rejects bare wildcard host https://*', () => {
    withEnv({ MCP_PROXY_AUTH_ALLOWED_RESOURCES: 'https://*' }, () => {
      expect(() => loadConfig()).toThrow(/bare \* is not allowed/);
    });
  });

  it('allowedResources rejects *. without domain', () => {
    withEnv({ MCP_PROXY_AUTH_ALLOWED_RESOURCES: 'https://*./*' }, () => {
      expect(() => loadConfig()).toThrow(/bare \* is not allowed/);
    });
  });
});

// ---------------------------------------------------------------------------
// DCR client name map
// ---------------------------------------------------------------------------
describe('loadConfig — DCR client name map', () => {
  it('simple format parsing (string values)', () => {
    const map = { 'Cursor': 'cursor-client', 'Claude Code*': 'claude-client' };
    withEnv({ MCP_PROXY_DCR_CLIENT_NAME_MAP: JSON.stringify(map) }, () => {
      const cfg = loadConfig();
      expect(cfg.dcrClientNameMap).toHaveLength(2);
      expect(cfg.dcrClientNameMap[0].clientId).toBe('cursor-client');
      expect(cfg.dcrClientNameMap[0].isPrefix).toBe(false);
      expect(cfg.dcrClientNameMap[1].clientId).toBe('claude-client');
      expect(cfg.dcrClientNameMap[1].isPrefix).toBe(true);
      expect(cfg.proxyDcrEndpoint).toBe(true);
    });
  });

  it('extended format parsing (object values with allowed_redirect_uris)', () => {
    const map = {
      'Cursor': { client_id: 'cursor-client', allowed_redirect_uris: 'cursor://anysphere.cursor-mcp/*' },
    };
    withEnv({ MCP_PROXY_DCR_CLIENT_NAME_MAP: JSON.stringify(map) }, () => {
      const cfg = loadConfig();
      expect(cfg.dcrClientNameMap[0].allowedRedirectUris).toEqual(['cursor://anysphere.cursor-mcp/*']);
      expect(cfg.dcrClientIdRedirectMap.get('cursor-client')).toEqual(['cursor://anysphere.cursor-mcp/*']);
    });
  });

  it('mixed format (some simple, some extended)', () => {
    const map = {
      'Cursor': { client_id: 'cursor-client', allowed_redirect_uris: 'cursor://anysphere.cursor-mcp/*' },
      'VS Code*': 'vscode-client',
    };
    withEnv({ MCP_PROXY_DCR_CLIENT_NAME_MAP: JSON.stringify(map) }, () => {
      const cfg = loadConfig();
      expect(cfg.dcrClientNameMap).toHaveLength(2);
      expect(cfg.dcrClientNameMap[0].allowedRedirectUris).toBeDefined();
      expect(cfg.dcrClientNameMap[1].allowedRedirectUris).toBeUndefined();
    });
  });

  it('invalid JSON rejection', () => {
    withEnv({ MCP_PROXY_DCR_CLIENT_NAME_MAP: 'not-json' }, () => {
      expect(() => loadConfig()).toThrow(/not valid JSON/);
    });
  });

  it('empty client_id rejection', () => {
    withEnv({ MCP_PROXY_DCR_CLIENT_NAME_MAP: '{"Cursor":"  "}' }, () => {
      expect(() => loadConfig()).toThrow(/empty upstream client_id/);
    });
  });

  it('non-string/non-object values rejected', () => {
    withEnv({ MCP_PROXY_DCR_CLIENT_NAME_MAP: '{"Cursor":123}' }, () => {
      expect(() => loadConfig()).toThrow(/must be a string.*or an object/);
    });
  });

  it('invalid redirect_uri pattern rejection (missing scheme)', () => {
    const map = { 'Cursor': { client_id: 'cursor-client', allowed_redirect_uris: 'localhost:8080' } };
    withEnv({ MCP_PROXY_DCR_CLIENT_NAME_MAP: JSON.stringify(map) }, () => {
      expect(() => loadConfig()).toThrow(/invalid.*pattern.*scheme/i);
    });
  });

  it('degenerate pattern keys rejected: empty', () => {
    withEnv({ MCP_PROXY_DCR_CLIENT_NAME_MAP: '{"":"client-id"}' }, () => {
      expect(() => loadConfig()).toThrow(/empty.*whitespace/);
    });
  });

  it('degenerate pattern keys rejected: whitespace-only', () => {
    withEnv({ MCP_PROXY_DCR_CLIENT_NAME_MAP: '{"   ":"client-id"}' }, () => {
      expect(() => loadConfig()).toThrow(/empty.*whitespace/);
    });
  });

  it('degenerate pattern keys rejected: bare "*"', () => {
    withEnv({ MCP_PROXY_DCR_CLIENT_NAME_MAP: '{"*":"client-id"}' }, () => {
      expect(() => loadConfig()).toThrow(/bare "\*"/);
    });
  });

  it('client_id collision with fallback + allowed_redirect_uris throws error', () => {
    const map = { 'Cursor': { client_id: 'mcp-client', allowed_redirect_uris: 'cursor://anysphere.cursor-mcp/*' } };
    withEnv({
      MCP_PROXY_DCR_CLIENT_ID: 'mcp-client',
      MCP_PROXY_DCR_CLIENT_NAME_MAP: JSON.stringify(map),
      MCP_PROXY_AUTH_STATE_SECRET: VALID_HEX_SECRET,
      MCP_PROXY_AUTH_ALLOWED_REDIRECT_URIS: VALID_REDIRECT_URIS,
    }, () => {
      expect(() => loadConfig()).toThrow(/equals MCP_PROXY_DCR_CLIENT_ID/);
    });
  });

  it('client_id collision with fallback WITHOUT allowed_redirect_uris is allowed', () => {
    const map = { 'Cursor': 'mcp-client' };
    withEnv({
      MCP_PROXY_DCR_CLIENT_ID: 'mcp-client',
      MCP_PROXY_DCR_CLIENT_NAME_MAP: JSON.stringify(map),
      MCP_PROXY_AUTH_STATE_SECRET: VALID_HEX_SECRET,
      MCP_PROXY_AUTH_ALLOWED_REDIRECT_URIS: VALID_REDIRECT_URIS,
    }, () => {
      expect(() => loadConfig()).not.toThrow();
    });
  });

  it('proxyDcrEndpoint auto-enables with map alone (no MCP_PROXY_DCR_CLIENT_ID)', () => {
    withEnv({ MCP_PROXY_DCR_CLIENT_NAME_MAP: '{"Cursor":"cursor-client"}' }, () => {
      const cfg = loadConfig();
      expect(cfg.proxyDcrEndpoint).toBe(true);
      expect(cfg.clientId).toBe('');
    });
  });

  it('proxyDcrEndpoint still works with only MCP_PROXY_DCR_CLIENT_ID (backwards compatibility)', () => {
    withEnv({ MCP_PROXY_DCR_CLIENT_ID: 'mcp-client' }, () => {
      const cfg = loadConfig();
      expect(cfg.proxyDcrEndpoint).toBe(true);
      expect(cfg.dcrClientNameMap).toEqual([]);
    });
  });

  it('CIMD-only still skips global redirect URI requirement', () => {
    withEnv({
      MCP_PROXY_CIMD_DEFAULT_CLIENT_ID: 'default',
      MCP_PROXY_AUTH_STATE_SECRET: VALID_HEX_SECRET,
    }, () => {
      expect(() => loadConfig()).not.toThrow();
    });
  });

  it('global redirect URIs not required when all map entries have per-client patterns and no fallback', () => {
    const map = {
      'Cursor': { client_id: 'cursor-client', allowed_redirect_uris: 'cursor://anysphere.cursor-mcp/*' },
      'Claude Code*': { client_id: 'claude-client', allowed_redirect_uris: 'http://localhost:*' },
    };
    withEnv({
      MCP_PROXY_DCR_CLIENT_NAME_MAP: JSON.stringify(map),
      MCP_PROXY_AUTH_STATE_SECRET: VALID_HEX_SECRET,
    }, () => {
      expect(() => loadConfig()).not.toThrow();
      const cfg = loadConfig();
      expect(cfg.allowedRedirectUris).toEqual([]);
    });
  });

  it('global redirect URIs still required when fallback exists without per-client patterns', () => {
    const map = { 'Cursor': 'cursor-client' };
    withEnv({
      MCP_PROXY_DCR_CLIENT_ID: 'fallback-client',
      MCP_PROXY_DCR_CLIENT_NAME_MAP: JSON.stringify(map),
      MCP_PROXY_AUTH_STATE_SECRET: VALID_HEX_SECRET,
    }, () => {
      expect(() => loadConfig()).toThrow(/MCP_PROXY_AUTH_ALLOWED_REDIRECT_URIS/);
    });
  });

  it('reverse map construction with merging (multiple name patterns → same client_id)', () => {
    const map = {
      'App A': { client_id: 'shared-client', allowed_redirect_uris: 'http://localhost:*' },
      'App B': { client_id: 'shared-client', allowed_redirect_uris: 'https://app-b.example.com/cb' },
    };
    withEnv({ MCP_PROXY_DCR_CLIENT_NAME_MAP: JSON.stringify(map) }, () => {
      const cfg = loadConfig();
      const patterns = cfg.dcrClientIdRedirectMap.get('shared-client');
      expect(patterns).toEqual(['http://localhost:*', 'https://app-b.example.com/cb']);
    });
  });
});

// ---------------------------------------------------------------------------
// parseClientNameMap / matchClientName / buildClientIdRedirectMap unit tests
// ---------------------------------------------------------------------------
describe('parseClientNameMap (unit)', () => {
  it('returns empty array when env is not set', () => {
    const saved = process.env.MCP_PROXY_DCR_CLIENT_NAME_MAP;
    delete process.env.MCP_PROXY_DCR_CLIENT_NAME_MAP;
    expect(parseClientNameMap('MCP_PROXY_DCR_CLIENT_NAME_MAP')).toEqual([]);
    if (saved !== undefined) process.env.MCP_PROXY_DCR_CLIENT_NAME_MAP = saved;
  });

  it('rejects object entry with missing client_id', () => {
    process.env.TEST_NAME_MAP = '{"Cursor":{}}';
    expect(() => parseClientNameMap('TEST_NAME_MAP')).toThrow(/non-empty.*client_id/);
    delete process.env.TEST_NAME_MAP;
  });
});

describe('matchClientName (unit)', () => {
  const entries: ParsedClientNameEntry[] = [
    { originalPattern: 'Cursor', normalizedPattern: 'cursor', isPrefix: false, clientId: 'cursor-client' },
    { originalPattern: 'Claude Code*', normalizedPattern: 'claude code', isPrefix: true, clientId: 'claude-client' },
  ];

  it('returns null for undefined name', () => {
    expect(matchClientName(undefined, entries)).toBeNull();
  });

  it('returns null for empty entries', () => {
    expect(matchClientName('Cursor', [])).toBeNull();
  });

  it('matches exact case-insensitively', () => {
    const result = matchClientName('CURSOR', entries);
    expect(result?.clientId).toBe('cursor-client');
  });

  it('matches prefix with suffix', () => {
    const result = matchClientName('Claude Code (test)', entries);
    expect(result?.clientId).toBe('claude-client');
  });

  it('returns null for no match', () => {
    expect(matchClientName('Unknown', entries)).toBeNull();
  });
});

describe('buildClientIdRedirectMap (unit)', () => {
  it('groups entries by clientId and merges patterns', () => {
    const entries: ParsedClientNameEntry[] = [
      { originalPattern: 'A', normalizedPattern: 'a', isPrefix: false, clientId: 'shared', allowedRedirectUris: ['http://a/*'] },
      { originalPattern: 'B', normalizedPattern: 'b', isPrefix: false, clientId: 'shared', allowedRedirectUris: ['http://b/*'] },
      { originalPattern: 'C', normalizedPattern: 'c', isPrefix: false, clientId: 'other', allowedRedirectUris: ['http://c/*'] },
    ];
    const map = buildClientIdRedirectMap(entries);
    expect(map.get('shared')).toEqual(['http://a/*', 'http://b/*']);
    expect(map.get('other')).toEqual(['http://c/*']);
  });

  it('skips entries without allowedRedirectUris', () => {
    const entries: ParsedClientNameEntry[] = [
      { originalPattern: 'A', normalizedPattern: 'a', isPrefix: false, clientId: 'shared' },
    ];
    const map = buildClientIdRedirectMap(entries);
    expect(map.size).toBe(0);
  });

  it('deduplicates merged patterns', () => {
    const entries: ParsedClientNameEntry[] = [
      { originalPattern: 'A', normalizedPattern: 'a', isPrefix: false, clientId: 'shared', allowedRedirectUris: ['http://a/*'] },
      { originalPattern: 'B', normalizedPattern: 'b', isPrefix: false, clientId: 'shared', allowedRedirectUris: ['http://a/*'] },
    ];
    const map = buildClientIdRedirectMap(entries);
    expect(map.get('shared')).toEqual(['http://a/*']);
  });
});
