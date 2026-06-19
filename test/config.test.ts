import { loadConfig } from '../src/config';

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
      expect(loadConfig().allowedResources).toEqual(['https://mcp.example.com/*', 'https://api.example.com/mcp']);
    });
  });

  it('allowedResources trims whitespace', () => {
    withEnv({ MCP_PROXY_AUTH_ALLOWED_RESOURCES: ' https://mcp.example.com/* , https://api.example.com/mcp ' }, () => {
      expect(loadConfig().allowedResources).toEqual(['https://mcp.example.com/*', 'https://api.example.com/mcp']);
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
      expect(loadConfig().allowedResources).toEqual(['http://localhost:3000/*']);
    });
  });

  it('both fields are independent of auth proxy config', () => {
    withEnv({ MCP_PROXY_AUTH_REQUIRE_RESOURCE: 'true', MCP_PROXY_AUTH_ALLOWED_RESOURCES: 'https://mcp.example.com/*' }, () => {
      const cfg = loadConfig();
      expect(cfg.requireResource).toBe(true);
      expect(cfg.allowedResources).toEqual(['https://mcp.example.com/*']);
      expect(cfg.proxyAuthEndpoint).toBe(false);
    });
  });
});
