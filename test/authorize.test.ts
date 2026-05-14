import request from 'supertest';
import { createApp } from '../src/app';
import { AppConfig } from '../src/config';
import { filterScopes } from '../src/routes/authorize';

const UPSTREAM_AUTH_ENDPOINT = 'https://sso.example.com/auth/realms/test/protocol/openid-connect/auth';

const MOCK_UPSTREAM_DOC: Record<string, unknown> = {
  issuer: 'https://sso.example.com/auth/realms/test',
  authorization_endpoint: UPSTREAM_AUTH_ENDPOINT,
  token_endpoint: 'https://sso.example.com/auth/realms/test/protocol/openid-connect/token',
  code_challenge_methods_supported: ['S256'],
};

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
  cimdMap: {},
  cimdCacheMinutes: 30,
  cimdEnabled: false,
  metricsEnabled: false,
  shutdownTimeoutSeconds: 30,
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
  it('redirects to upstream authorization endpoint', async () => {
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
    expect(location.searchParams.get('redirect_uri')).toBe('http://localhost:8080/callback');
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('scope')).toBe('openid profile');
    expect(location.searchParams.get('state')).toBe('abc123');
  });

  describe('Scope removal mode (authScopesRemoved)', () => {
    it('strips configured scopes from request', async () => {
      const app = makeApp({ authScopesRemoved: ['offline_access'] });

      const res = await request(app)
        .get('/authorize')
        .query({
          client_id: 'my-client',
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
          response_type: 'code',
          scope: 'openid offline_access profile email',
        });

      expect(res.status).toBe(302);
      const location = new URL(res.headers.location);
      expect(location.searchParams.get('scope')).toBe('openid offline_access profile email');
    });
  });

  it('preserves all security-critical parameters', async () => {
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
    expect(location.searchParams.get('state')).toBe('state-value');
    expect(location.searchParams.get('code_challenge')).toBe('challenge123');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('nonce')).toBe('nonce-value');
    expect(location.searchParams.get('resource')).toBe('https://mcp.example.com');
  });

  it('works when no scope parameter is present', async () => {
    const app = makeApp();

    const res = await request(app)
      .get('/authorize')
      .query({
        client_id: 'my-client',
        response_type: 'code',
      });

    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.searchParams.has('scope')).toBe(false);
  });

  it('silently drops non-string query values (repeated params)', async () => {
    const app = makeApp();

    const res = await request(app)
      .get('/authorize?client_id=my-client&response_type=code&scope=openid&extra=a&extra=b');

    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.searchParams.get('client_id')).toBe('my-client');
    expect(location.searchParams.has('extra')).toBe(false);
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

  const mockCimdFetcher = jest.fn().mockResolvedValue(mockCimdDoc);

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

  it('substitutes CIMD client_id and redirects to upstream', async () => {
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
    expect(location.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8080/callback');
    expect(location.searchParams.get('state')).toBe('xyz');
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
    const failingFetcher = jest.fn().mockRejectedValue(
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

describe('Global JSON error handler', () => {
  it('returns RFC-style JSON 500 on unhandled route errors', async () => {
    const poisoned = { toString() { throw new Error('Simulated internal failure'); } };
    const { app } = createApp({
      config: CONFIG,
      upstreamDoc: { ...MOCK_UPSTREAM_DOC, authorization_endpoint: poisoned },
    });

    const res = await request(app)
      .get('/authorize')
      .query({ client_id: 'my-client', response_type: 'code' });

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
      .query({ client_id: 'my-client', response_type: 'code' });

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
