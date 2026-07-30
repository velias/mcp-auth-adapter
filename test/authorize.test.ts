import request from 'supertest';
import { createApp } from '../src/app';
import { AppConfig, ParsedClientNameEntry, buildClientIdRedirectMap } from '../src/config';
import { filterScopes } from '../src/routes/authorize';
import { parseResourcePatterns } from '../src/uri-validation';

const UPSTREAM_AUTH_ENDPOINT = 'https://sso.example.com/auth/realms/test/protocol/openid-connect/auth';

const MOCK_UPSTREAM_DOC: Record<string, unknown> = {
  issuer: 'https://sso.example.com/auth/realms/test',
  authorization_endpoint: UPSTREAM_AUTH_ENDPOINT,
  token_endpoint: 'https://sso.example.com/auth/realms/test/protocol/openid-connect/token',
  code_challenge_methods_supported: ['S256'],
};

const TEST_STATE_SECRET = Buffer.from('a'.repeat(64), 'hex');

const CONFIG: AppConfig = {
  baseUrl: 'http://localhost:3000',
  port: 3000,
  upstreamSsoUrl: 'https://sso.example.com/auth/realms/test',
  clientId: 'test-client',
  proxyAuthEndpoint: true,
  proxyDcrEndpoint: true,
  authScopesRemoved: ['offline_access'],
  wellKnownRefreshMinutes: 60,
  debug: false,
  accessLog: false,
  cimdMap: {},
  cimdCacheMinutes: 30,
  cimdEnabled: false,
  metricsEnabled: false,
  dpopEnabled: false,
  shutdownTimeoutSeconds: 30,
  authStateSecret: TEST_STATE_SECRET,
  authStateTtlSeconds: 1800,
  allowedRedirectUris: ['http://localhost:*', 'http://127.0.0.1:*'],
  requireResource: false,
  allowedResources: [],
  dcrClientNameMap: [],
  dcrClientIdRedirectMap: new Map(),
};

function makeApp(configOverrides: Partial<AppConfig> = {}) {
  return createApp({
    config: { ...CONFIG, ...configOverrides },
    upstreamDoc: MOCK_UPSTREAM_DOC,
  }).app;
}

describe('filterScopes (unit)', () => {
  it('returns original scope when neither removed nor preserved is set', () => {
    expect(filterScopes('openid profile email', {})).toBe('openid profile email');
  });

  it('removes scopes listed in removed', () => {
    expect(filterScopes('openid offline_access profile', { removed: ['offline_access'] }))
      .toBe('openid profile');
  });

  it('removes multiple scopes', () => {
    expect(filterScopes('openid offline_access profile email', { removed: ['offline_access', 'email'] }))
      .toBe('openid profile');
  });

  it('returns null when all scopes are removed', () => {
    expect(filterScopes('offline_access', { removed: ['offline_access'] })).toBeNull();
  });

  it('preserves only listed scopes', () => {
    expect(filterScopes('openid offline_access profile email', { preserved: ['openid', 'profile'] }))
      .toBe('openid profile');
  });

  it('returns null when no scopes match preserved list', () => {
    expect(filterScopes('offline_access email', { preserved: ['openid'] })).toBeNull();
  });

  it('preserved takes precedence over removed', () => {
    expect(filterScopes('openid offline_access profile', {
      removed: ['offline_access'],
      preserved: ['openid', 'offline_access'],
    })).toBe('openid offline_access');
  });
});

describe('GET /authorize (Auth Proxy)', () => {
  it('redirects to upstream authorization endpoint with rewritten redirect_uri and state', async () => {
    const app = makeApp();

    const res = await request(app)
      .get('/authorize')
      .query({
        client_id: 'my-client',
        redirect_uri: 'http://localhost:8080/callback',
        response_type: 'code',
        scope: 'openid profile',
        state: 'abc123',
      });

    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.origin + location.pathname).toBe(UPSTREAM_AUTH_ENDPOINT);
    expect(location.searchParams.get('client_id')).toBe('my-client');
    expect(location.searchParams.get('redirect_uri')).toBe('http://localhost:3000/authorize/callback');
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('scope')).toBe('openid profile');
    // State is now a signed blob containing original state
    expect(location.searchParams.get('state')).not.toBe('abc123');
    expect(location.searchParams.get('state')!.length).toBeGreaterThan(10);
  });

  describe('Scope removal mode (authScopesRemoved)', () => {
    it('strips configured scopes from request', async () => {
      const app = makeApp({ authScopesRemoved: ['offline_access'] });

      const res = await request(app)
        .get('/authorize')
        .query({
          client_id: 'my-client',
          redirect_uri: 'http://localhost:8080/callback',
          response_type: 'code',
          scope: 'openid offline_access profile',
        });

      expect(res.status).toBe(302);
      const location = new URL(res.headers.location);
      expect(location.searchParams.get('scope')).toBe('openid profile');
    });

    it('removes multiple configured scopes', async () => {
      const app = makeApp({ authScopesRemoved: ['offline_access', 'email'] });

      const res = await request(app)
        .get('/authorize')
        .query({
          client_id: 'my-client',
          redirect_uri: 'http://localhost:8080/callback',
          response_type: 'code',
          scope: 'openid offline_access profile email',
        });

      expect(res.status).toBe(302);
      const location = new URL(res.headers.location);
      expect(location.searchParams.get('scope')).toBe('openid profile');
    });

    it('deletes scope param when all scopes are removed', async () => {
      const app = makeApp({ authScopesRemoved: ['offline_access'] });

      const res = await request(app)
        .get('/authorize')
        .query({
          client_id: 'my-client',
          redirect_uri: 'http://localhost:8080/callback',
          response_type: 'code',
          scope: 'offline_access',
        });

      expect(res.status).toBe(302);
      const location = new URL(res.headers.location);
      expect(location.searchParams.has('scope')).toBe(false);
    });
  });

  describe('Scope preservation mode (authScopesPreserved)', () => {
    it('keeps only preserved scopes', async () => {
      const app = makeApp({
        authScopesRemoved: undefined,
        authScopesPreserved: ['openid', 'profile'],
      });

      const res = await request(app)
        .get('/authorize')
        .query({
          client_id: 'my-client',
          redirect_uri: 'http://localhost:8080/callback',
          response_type: 'code',
          scope: 'openid offline_access profile email',
        });

      expect(res.status).toBe(302);
      const location = new URL(res.headers.location);
      expect(location.searchParams.get('scope')).toBe('openid profile');
    });

    it('deletes scope param when no scopes match preserved list', async () => {
      const app = makeApp({
        authScopesRemoved: undefined,
        authScopesPreserved: ['openid'],
      });

      const res = await request(app)
        .get('/authorize')
        .query({
          client_id: 'my-client',
          redirect_uri: 'http://localhost:8080/callback',
          response_type: 'code',
          scope: 'offline_access email',
        });

      expect(res.status).toBe(302);
      const location = new URL(res.headers.location);
      expect(location.searchParams.has('scope')).toBe(false);
    });

    it('preserved takes precedence over removed when both are set', async () => {
      const app = makeApp({
        authScopesRemoved: ['offline_access'],
        authScopesPreserved: ['openid', 'offline_access'],
      });

      const res = await request(app)
        .get('/authorize')
        .query({
          client_id: 'my-client',
          redirect_uri: 'http://localhost:8080/callback',
          response_type: 'code',
          scope: 'openid offline_access profile',
        });

      expect(res.status).toBe(302);
      const location = new URL(res.headers.location);
      expect(location.searchParams.get('scope')).toBe('openid offline_access');
    });
  });

  describe('No scope filtering configured', () => {
    it('passes all scopes through unchanged', async () => {
      const app = makeApp({
        authScopesRemoved: undefined,
        authScopesPreserved: undefined,
      });

      const res = await request(app)
        .get('/authorize')
        .query({
          client_id: 'my-client',
          redirect_uri: 'http://localhost:8080/callback',
          response_type: 'code',
          scope: 'openid offline_access profile email',
        });

      expect(res.status).toBe(302);
      const location = new URL(res.headers.location);
      expect(location.searchParams.get('scope')).toBe('openid offline_access profile email');
    });
  });

  it('preserves security-critical parameters (code_challenge, nonce, resource)', async () => {
    const app = makeApp();

    const res = await request(app)
      .get('/authorize')
      .query({
        client_id: 'my-client',
        redirect_uri: 'http://localhost:8080/callback',
        response_type: 'code',
        scope: 'openid',
        state: 'state-value',
        code_challenge: 'challenge123',
        code_challenge_method: 'S256',
        nonce: 'nonce-value',
        resource: 'https://mcp.example.com',
      });

    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    // state is wrapped in signed blob (not the original value)
    expect(location.searchParams.get('state')).not.toBe('state-value');
    expect(location.searchParams.get('code_challenge')).toBe('challenge123');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('nonce')).toBe('nonce-value');
    expect(location.searchParams.get('resource')).toBe('https://mcp.example.com');
  });

  it('requires redirect_uri when state config is active', async () => {
    const app = makeApp();

    const res = await request(app)
      .get('/authorize')
      .query({
        client_id: 'my-client',
        response_type: 'code',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(res.body.error_description).toContain('redirect_uri');
  });

  it('silently drops non-string query values (repeated params)', async () => {
    const app = makeApp();

    const res = await request(app)
      .get('/authorize?client_id=my-client&redirect_uri=http%3A%2F%2Flocalhost%3A8080%2Fcallback&response_type=code&scope=openid&extra=a&extra=b');

    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.searchParams.get('client_id')).toBe('my-client');
    expect(location.searchParams.has('extra')).toBe(false);
  });

  it('strips unsupported response_mode (fragment)', async () => {
    const app = makeApp();

    const res = await request(app)
      .get('/authorize')
      .query({
        client_id: 'my-client',
        redirect_uri: 'http://localhost:8080/callback',
        response_type: 'code',
        response_mode: 'fragment',
      });

    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.searchParams.has('response_mode')).toBe(false);
  });

  it('preserves response_mode=query', async () => {
    const app = makeApp();

    const res = await request(app)
      .get('/authorize')
      .query({
        client_id: 'my-client',
        redirect_uri: 'http://localhost:8080/callback',
        response_type: 'code',
        response_mode: 'query',
      });

    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.searchParams.get('response_mode')).toBe('query');
  });

  it('rejects redirect_uri with fragment (security)', async () => {
    const app = makeApp();

    const res = await request(app)
      .get('/authorize')
      .query({
        client_id: 'my-client',
        redirect_uri: 'http://localhost:8080/callback#frag',
        response_type: 'code',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(res.body.error_description).toContain('redirect_uri');
  });

  it('rejects redirect_uri with userinfo (security)', async () => {
    const app = makeApp();

    const res = await request(app)
      .get('/authorize')
      .query({
        client_id: 'my-client',
        redirect_uri: 'http://user:pass@localhost:8080/callback',
        response_type: 'code',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(res.body.error_description).toContain('redirect_uri');
  });

  it('returns 404 when proxyAuthEndpoint is disabled', async () => {
    const app = makeApp({ proxyAuthEndpoint: false });

    const res = await request(app)
      .get('/authorize')
      .query({ client_id: 'my-client', response_type: 'code' });

    expect(res.status).toBe(404);
  });
});

describe('GET /authorize (CIMD integration)', () => {
  const CIMD_URL = 'https://cursor.com/oauth-client.json';

  const mockCimdDoc = {
    client_id: CIMD_URL,
    redirect_uris: ['http://127.0.0.1:8080/callback'],
    client_name: 'Cursor',
  };

  const mockCimdFetcher = vi.fn().mockResolvedValue(mockCimdDoc);

  function makeAppWithCimd(configOverrides: Partial<AppConfig> = {}, fetcher = mockCimdFetcher) {
    return createApp({
      config: {
        ...CONFIG,
        cimdMap: { [CIMD_URL]: 'cursor-sso-client' },
        cimdCacheMinutes: 30,
        cimdEnabled: true,
        ...configOverrides,
      },
      upstreamDoc: MOCK_UPSTREAM_DOC,
      cimdFetcher: fetcher,
    }).app;
  }

  beforeEach(() => {
    mockCimdFetcher.mockClear();
  });

  it('substitutes CIMD client_id and redirects to upstream with rewritten redirect_uri', async () => {
    const app = makeAppWithCimd();

    const res = await request(app)
      .get('/authorize')
      .query({
        client_id: CIMD_URL,
        redirect_uri: 'http://127.0.0.1:8080/callback',
        response_type: 'code',
        scope: 'openid',
        state: 'xyz',
      });

    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.searchParams.get('client_id')).toBe('cursor-sso-client');
    expect(location.searchParams.get('redirect_uri')).toBe('http://localhost:3000/authorize/callback');
    // state is wrapped in signed blob
    expect(location.searchParams.get('state')).not.toBe('xyz');
  });

  it('passes through non-CIMD client_id unchanged', async () => {
    const app = makeAppWithCimd();

    const res = await request(app)
      .get('/authorize')
      .query({
        client_id: 'regular-client',
        redirect_uri: 'http://localhost:8080/callback',
        response_type: 'code',
      });

    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.searchParams.get('client_id')).toBe('regular-client');
  });

  it('returns 403 for unknown CIMD URL without default', async () => {
    const app = makeAppWithCimd();

    const res = await request(app)
      .get('/authorize')
      .query({
        client_id: 'https://unknown.com/oauth.json',
        redirect_uri: 'http://127.0.0.1:8080/callback',
        response_type: 'code',
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('invalid_client');
  });

  it('returns 400 for invalid CIMD URL syntax', async () => {
    const app = makeAppWithCimd({
      cimdMap: {},
      cimdDefaultClientId: 'fallback',
    });

    const res = await request(app)
      .get('/authorize')
      .query({
        client_id: 'https://evil.com/../secret',
        redirect_uri: 'http://127.0.0.1:8080/callback',
        response_type: 'code',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client');
  });

  it('returns 400 for redirect_uri mismatch', async () => {
    const app = makeAppWithCimd();

    const res = await request(app)
      .get('/authorize')
      .query({
        client_id: CIMD_URL,
        redirect_uri: 'http://evil.com/steal',
        response_type: 'code',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(res.body.error_description).toContain('redirect_uri');
  });

  it('applies scope filtering after CIMD substitution', async () => {
    const app = makeAppWithCimd({ authScopesRemoved: ['offline_access'] });

    const res = await request(app)
      .get('/authorize')
      .query({
        client_id: CIMD_URL,
        redirect_uri: 'http://127.0.0.1:8080/callback',
        response_type: 'code',
        scope: 'openid offline_access',
      });

    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.searchParams.get('scope')).toBe('openid');
    expect(location.searchParams.get('client_id')).toBe('cursor-sso-client');
  });

  it('CIMD URLs pass through unmodified when CIMD not configured', async () => {
    const app = makeApp({ cimdEnabled: false, cimdMap: {} });

    const res = await request(app)
      .get('/authorize')
      .query({
        client_id: 'https://cursor.com/oauth-client.json',
        redirect_uri: 'http://localhost:8080/callback',
        response_type: 'code',
      });

    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.searchParams.get('client_id')).toBe('https://cursor.com/oauth-client.json');
  });

  it('does not echo raw unsanitized input in error responses', async () => {
    const app = makeAppWithCimd();
    const malicious = 'https://unknown.com/oauth.json' + String.fromCharCode(0, 10, 31);

    const res = await request(app)
      .get('/authorize')
      .query({
        client_id: malicious,
        response_type: 'code',
      });

    // eslint-disable-next-line no-control-regex
    expect(res.body.error_description).not.toMatch(/[\u0000-\u001f]/);
  });

  it('returns error without leaking internal details on CIMD fetch failure', async () => {
    const failingFetcher = vi.fn().mockRejectedValue(
      new Error('DNS resolution failed for blocked-host.invalid: SSRF blocked'),
    );
    const app = makeAppWithCimd(
      { cimdMap: {}, cimdDefaultClientId: 'fallback' },
      failingFetcher,
    );

    const res = await request(app)
      .get('/authorize')
      .query({
        client_id: 'https://failing.com/oauth.json',
        redirect_uri: 'http://127.0.0.1:8080/callback',
        response_type: 'code',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client');
    expect(res.body.error_description).not.toContain('blocked-host.invalid');
    expect(res.body.error_description).not.toContain('sso.example.com');
  });
});

describe('GET /authorize (metrics counters)', () => {
  it('produces mcp_auth_request_rejected_total on resource rejection', async () => {
    const { app } = createApp({
      config: { ...CONFIG, metricsEnabled: true, allowedResources: parseResourcePatterns(['https://mcp.example.com/*']) },
      upstreamDoc: MOCK_UPSTREAM_DOC,
    });

    await request(app)
      .get('/authorize')
      .query({
        client_id: 'my-client',
        redirect_uri: 'http://localhost:8080/callback',
        response_type: 'code',
        resource: 'https://other.com/mcp',
      });

    const res = await request(app).get('/metrics');
    expect(res.text).toContain('mcp_auth_request_rejected_total');
    expect(res.text).toContain('reason="resource_not_allowed"');
    expect(res.text).toContain('route="/authorize"');
  });

  it('produces mcp_auth_authorize_redirects_total with resource label on success', async () => {
    const { app } = createApp({
      config: { ...CONFIG, metricsEnabled: true, allowedResources: parseResourcePatterns(['https://mcp.example.com/*']) },
      upstreamDoc: MOCK_UPSTREAM_DOC,
    });

    await request(app)
      .get('/authorize')
      .query({
        client_id: 'my-client',
        redirect_uri: 'http://localhost:8080/callback',
        response_type: 'code',
        resource: 'https://mcp.example.com/v1',
      });

    const res = await request(app).get('/metrics');
    expect(res.text).toContain('mcp_auth_authorize_redirects_total{resource="https://mcp.example.com/*"} 1');
  });
});

describe('Global JSON error handler', () => {
  it('returns RFC-style JSON 500 on unhandled route errors', async () => {
    const poisoned = { toString() { throw new Error('Simulated internal failure'); } };
    const { app } = createApp({
      config: CONFIG,
      upstreamDoc: { ...MOCK_UPSTREAM_DOC, authorization_endpoint: poisoned },
    });

    const res = await request(app)
      .get('/authorize')
      .query({ client_id: 'my-client', redirect_uri: 'http://localhost:8080/callback', response_type: 'code' });

    expect(res.status).toBe(500);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body).toEqual({
      error: 'server_error',
      error_description: 'An unexpected error occurred',
    });
  });

  it('does not leak internal error details in the response', async () => {
    const poisoned = { toString() { throw new Error('SECRET_DB_PASSWORD=hunter2'); } };
    const { app } = createApp({
      config: CONFIG,
      upstreamDoc: { ...MOCK_UPSTREAM_DOC, authorization_endpoint: poisoned },
    });

    const res = await request(app)
      .get('/authorize')
      .query({ client_id: 'my-client', redirect_uri: 'http://localhost:8080/callback', response_type: 'code' });

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('SECRET_DB_PASSWORD');
    expect(JSON.stringify(res.body)).not.toContain('hunter2');
  });
});

describe('createApp startup guards', () => {
  it('throws when CIMD is enabled but upstream doc lacks token_endpoint', () => {
    const docWithoutToken = { ...MOCK_UPSTREAM_DOC };
    delete docWithoutToken.token_endpoint;
    expect(() =>
      createApp({
        config: { ...CONFIG, cimdEnabled: true, cimdMap: { 'https://example.com/c.json': 'x' }, cimdCacheMinutes: 30 },
        upstreamDoc: docWithoutToken,
      }),
    ).toThrow(/missing token_endpoint/);
  });
});

describe('GET /authorize (resource parameter)', () => {
  it('passes through valid resource parameter to upstream', async () => {
    const app = makeApp();

    const res = await request(app)
      .get('/authorize')
      .query({
        client_id: 'my-client',
        redirect_uri: 'http://localhost:8080/callback',
        response_type: 'code',
        resource: 'https://mcp.example.com',
      });

    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.searchParams.get('resource')).toBe('https://mcp.example.com');
  });

  it('passes through when resource is absent (default: no enforcement)', async () => {
    const app = makeApp();

    const res = await request(app)
      .get('/authorize')
      .query({
        client_id: 'my-client',
        redirect_uri: 'http://localhost:8080/callback',
        response_type: 'code',
      });

    expect(res.status).toBe(302);
  });

  it('rejects resource with custom scheme (cursor://)', async () => {
    const app = makeApp();

    const res = await request(app)
      .get('/authorize')
      .query({
        client_id: 'my-client',
        redirect_uri: 'http://localhost:8080/callback',
        response_type: 'code',
        resource: 'cursor://foo/bar',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(res.body.error_description).toContain('resource');
  });

  it('rejects resource with fragment', async () => {
    const app = makeApp();

    const res = await request(app)
      .get('/authorize')
      .query({
        client_id: 'my-client',
        redirect_uri: 'http://localhost:8080/callback',
        response_type: 'code',
        resource: 'https://mcp.example.com#frag',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(res.body.error_description).toContain('resource');
  });

  describe('require enforcement (requireResource: true)', () => {
    it('rejects request missing resource', async () => {
      const app = makeApp({ requireResource: true });

      const res = await request(app)
        .get('/authorize')
        .query({
          client_id: 'my-client',
          redirect_uri: 'http://localhost:8080/callback',
          response_type: 'code',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_request');
      expect(res.body.error_description).toContain('resource');
      expect(res.body.error_description).toContain('RFC 8707');
    });

    it('rejects request with empty resource', async () => {
      const app = makeApp({ requireResource: true });

      const res = await request(app)
        .get('/authorize')
        .query({
          client_id: 'my-client',
          redirect_uri: 'http://localhost:8080/callback',
          response_type: 'code',
          resource: '',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_request');
    });

    it('passes when valid resource is present', async () => {
      const app = makeApp({ requireResource: true });

      const res = await request(app)
        .get('/authorize')
        .query({
          client_id: 'my-client',
          redirect_uri: 'http://localhost:8080/callback',
          response_type: 'code',
          resource: 'https://mcp.example.com',
        });

      expect(res.status).toBe(302);
    });
  });

  describe('allowlist enforcement', () => {
    it('passes matching resource', async () => {
      const app = makeApp({ allowedResources: parseResourcePatterns(['https://mcp.example.com/*']) });

      const res = await request(app)
        .get('/authorize')
        .query({
          client_id: 'my-client',
          redirect_uri: 'http://localhost:8080/callback',
          response_type: 'code',
          resource: 'https://mcp.example.com/v1/tools',
        });

      expect(res.status).toBe(302);
    });

    it('rejects non-matching resource', async () => {
      const app = makeApp({ allowedResources: parseResourcePatterns(['https://mcp.example.com/*']) });

      const res = await request(app)
        .get('/authorize')
        .query({
          client_id: 'my-client',
          redirect_uri: 'http://localhost:8080/callback',
          response_type: 'code',
          resource: 'https://other.example.com/mcp',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_request');
      expect(res.body.error_description).toBe('resource not allowed');
    });

    it('passes exact match', async () => {
      const app = makeApp({ allowedResources: parseResourcePatterns(['https://mcp.example.com/mcp']) });

      const res = await request(app)
        .get('/authorize')
        .query({
          client_id: 'my-client',
          redirect_uri: 'http://localhost:8080/callback',
          response_type: 'code',
          resource: 'https://mcp.example.com/mcp',
        });

      expect(res.status).toBe(302);
    });
  });
});

// ---------------------------------------------------------------------------
// Per-client redirect_uri enforcement
// ---------------------------------------------------------------------------
describe('GET /authorize (per-client redirect_uri enforcement)', () => {
  const CURSOR_ENTRY: ParsedClientNameEntry = {
    originalPattern: 'Cursor',
    normalizedPattern: 'cursor',
    isPrefix: false,
    clientId: 'cursor-sso-client',
    allowedRedirectUris: ['cursor://anysphere.cursor-mcp/*'],
  };

  const CLAUDE_ENTRY: ParsedClientNameEntry = {
    originalPattern: 'Claude Code*',
    normalizedPattern: 'claude code',
    isPrefix: true,
    clientId: 'claude-sso-client',
    allowedRedirectUris: ['http://localhost:*', 'http://127.0.0.1:*'],
  };

  const NAME_MAP = [CURSOR_ENTRY, CLAUDE_ENTRY];
  const CLIENT_REDIRECT_MAP = buildClientIdRedirectMap(NAME_MAP);

  function makeAppWithPerClient(overrides: Partial<AppConfig> = {}) {
    return createApp({
      config: {
        ...CONFIG,
        dcrClientNameMap: NAME_MAP,
        dcrClientIdRedirectMap: CLIENT_REDIRECT_MAP,
        ...overrides,
      },
      upstreamDoc: MOCK_UPSTREAM_DOC,
    }).app;
  }

  it('client_id in reverse map, valid redirect_uri → redirect proceeds', async () => {
    const app = makeAppWithPerClient();
    const res = await request(app)
      .get('/authorize')
      .query({
        client_id: 'claude-sso-client',
        redirect_uri: 'http://localhost:8080/callback',
        response_type: 'code',
      });

    expect(res.status).toBe(302);
  });

  it('client_id in reverse map, invalid redirect_uri → 400', async () => {
    const app = makeAppWithPerClient();
    const res = await request(app)
      .get('/authorize')
      .query({
        client_id: 'cursor-sso-client',
        redirect_uri: 'http://localhost:8080/callback',
        response_type: 'code',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(res.body.error_description).toContain('redirect_uri not allowed');
  });

  it('unknown client_id falls through to global allowlist', async () => {
    const app = makeAppWithPerClient();
    const res = await request(app)
      .get('/authorize')
      .query({
        client_id: 'unknown-client',
        redirect_uri: 'http://localhost:8080/callback',
        response_type: 'code',
      });

    expect(res.status).toBe(302);
  });

  it('CIMD clients bypass per-client check', async () => {
    const CIMD_URL = 'https://cursor.com/oauth-client.json';
    const mockCimdDoc = {
      client_id: CIMD_URL,
      redirect_uris: ['http://127.0.0.1:8080/callback'],
      client_name: 'Cursor',
    };
    const mockCimdFetcher = vi.fn().mockResolvedValue(mockCimdDoc);

    const app = createApp({
      config: {
        ...CONFIG,
        cimdMap: { [CIMD_URL]: 'cursor-sso-client' },
        cimdEnabled: true,
        dcrClientNameMap: NAME_MAP,
        dcrClientIdRedirectMap: CLIENT_REDIRECT_MAP,
      },
      upstreamDoc: MOCK_UPSTREAM_DOC,
      cimdFetcher: mockCimdFetcher,
    }).app;

    const res = await request(app)
      .get('/authorize')
      .query({
        client_id: CIMD_URL,
        redirect_uri: 'http://127.0.0.1:8080/callback',
        response_type: 'code',
      });

    expect(res.status).toBe(302);
  });

  it('multiple name entries mapped to same client_id → merged patterns', async () => {
    const entries: ParsedClientNameEntry[] = [
      {
        originalPattern: 'App A',
        normalizedPattern: 'app a',
        isPrefix: false,
        clientId: 'shared-client',
        allowedRedirectUris: ['http://localhost:*'],
      },
      {
        originalPattern: 'App B',
        normalizedPattern: 'app b',
        isPrefix: false,
        clientId: 'shared-client',
        allowedRedirectUris: ['https://app-b.example.com/cb'],
      },
    ];
    const mergedMap = buildClientIdRedirectMap(entries);

    const app = createApp({
      config: {
        ...CONFIG,
        dcrClientNameMap: entries,
        dcrClientIdRedirectMap: mergedMap,
      },
      upstreamDoc: MOCK_UPSTREAM_DOC,
    }).app;

    // First pattern (from App A)
    const res1 = await request(app)
      .get('/authorize')
      .query({
        client_id: 'shared-client',
        redirect_uri: 'http://localhost:3000/cb',
        response_type: 'code',
      });
    expect(res1.status).toBe(302);

    // Second pattern (from App B)
    const res2 = await request(app)
      .get('/authorize')
      .query({
        client_id: 'shared-client',
        redirect_uri: 'https://app-b.example.com/cb',
        response_type: 'code',
      });
    expect(res2.status).toBe(302);
  });

  it('Security #6: client_id at /authorize determines patterns, not DCR registration', async () => {
    const app = makeAppWithPerClient();

    // A client registered as "Cursor" (getting cursor-sso-client) but tries /authorize
    // with claude-sso-client — the redirect_uri patterns for claude-sso-client apply
    const res = await request(app)
      .get('/authorize')
      .query({
        client_id: 'claude-sso-client',
        redirect_uri: 'cursor://anysphere.cursor-mcp/callback',
        response_type: 'code',
      });

    expect(res.status).toBe(400);
    expect(res.body.error_description).toContain('redirect_uri not allowed');
  });
});

// ---------------------------------------------------------------------------
// idp_client label on authorize metrics
// ---------------------------------------------------------------------------
describe('GET /authorize (idp_client metrics label)', () => {
  const NAME_MAP: ParsedClientNameEntry[] = [{
    originalPattern: 'Cursor',
    normalizedPattern: 'cursor',
    isPrefix: false,
    clientId: 'cursor-sso-client',
  }];

  it('idp_client label present on redirectsTotal when client_id is known', async () => {
    const { app } = createApp({
      config: {
        ...CONFIG,
        metricsEnabled: true,
        dcrClientNameMap: NAME_MAP,
        dcrClientIdRedirectMap: buildClientIdRedirectMap(NAME_MAP),
      },
      upstreamDoc: MOCK_UPSTREAM_DOC,
    });

    await request(app)
      .get('/authorize')
      .query({
        client_id: 'cursor-sso-client',
        redirect_uri: 'http://localhost:8080/callback',
        response_type: 'code',
      });

    const metricsRes = await request(app).get('/metrics');
    expect(metricsRes.text).toContain('mcp_auth_authorize_redirects_total{idp_client="cursor-sso-client"} 1');
  });

  it('idp_client label absent when client_id is unknown', async () => {
    const { app } = createApp({
      config: {
        ...CONFIG,
        metricsEnabled: true,
        dcrClientNameMap: NAME_MAP,
        dcrClientIdRedirectMap: buildClientIdRedirectMap(NAME_MAP),
      },
      upstreamDoc: MOCK_UPSTREAM_DOC,
    });

    await request(app)
      .get('/authorize')
      .query({
        client_id: 'unknown-client',
        redirect_uri: 'http://localhost:8080/callback',
        response_type: 'code',
      });

    const metricsRes = await request(app).get('/metrics');
    const redirectLines = metricsRes.text.split('\n').filter((l: string) => l.startsWith('mcp_auth_authorize_redirects_total'));
    expect(redirectLines.length).toBeGreaterThan(0);
    expect(redirectLines.every((l: string) => !l.includes('idp_client'))).toBe(true);
  });

  it('idp_client label on rejectedTotal when client_id is known but redirect_uri fails', async () => {
    const entriesWithPatterns: ParsedClientNameEntry[] = [{
      originalPattern: 'Cursor',
      normalizedPattern: 'cursor',
      isPrefix: false,
      clientId: 'cursor-sso-client',
      allowedRedirectUris: ['cursor://anysphere.cursor-mcp/*'],
    }];
    const { app } = createApp({
      config: {
        ...CONFIG,
        metricsEnabled: true,
        dcrClientNameMap: entriesWithPatterns,
        dcrClientIdRedirectMap: buildClientIdRedirectMap(entriesWithPatterns),
      },
      upstreamDoc: MOCK_UPSTREAM_DOC,
    });

    await request(app)
      .get('/authorize')
      .query({
        client_id: 'cursor-sso-client',
        redirect_uri: 'http://localhost:8080/callback',
        response_type: 'code',
      });

    const metricsRes = await request(app).get('/metrics');
    expect(metricsRes.text).toContain('idp_client="cursor-sso-client"');
    expect(metricsRes.text).toContain('reason="redirect_uri_rejected"');
  });
});
