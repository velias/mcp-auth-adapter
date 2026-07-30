import request from 'supertest';
import express from 'express';
import { createTokenRouter } from '../src/routes/token';
import { createLogger } from '../src/logger';
import { createMetricsRegistry } from '../src/metrics';
import { parseResourcePatterns } from '../src/uri-validation';

const UPSTREAM_TOKEN_URL = 'https://sso.example.com/auth/realms/test/protocol/openid-connect/token';

const CIMD_MAP = {
  'https://cursor.com/oauth-client.json': 'cursor-sso-client',
  'https://claude.ai/oauth-client.json': 'claude-sso-client',
};

function createTestApp(options: {
  map?: Record<string, string>;
  defaultClientId?: string;
} = {}) {
  const { map = CIMD_MAP, defaultClientId } = options;
  const app = express();
  app.disable('x-powered-by');
  app.use(createTokenRouter({
    getUpstreamTokenEndpoint: () => UPSTREAM_TOKEN_URL,
    cimdMap: map,
    cimdDefaultClientId: defaultClientId,
    requireResource: false,
    allowedResources: [],
    rejectedTotal: { inc() {} },
  }, createLogger(false)));
  return app;
}

function mockUpstreamTokenResponse(options: {
  status?: number;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
} = {}) {
  const {
    status = 200,
    body = { access_token: 'tok_123', token_type: 'Bearer', expires_in: 3600 },
    headers = {},
  } = options;

  const allHeaders: Record<string, string> = { 'content-type': 'application/json', ...headers };
  const encoded = new TextEncoder().encode(JSON.stringify(body));

  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name: string) => allHeaders[name.toLowerCase()] ?? null,
    },
    body: {
      getReader: () => {
        let consumed = false;
        return {
          read: () => {
            if (consumed) return Promise.resolve({ done: true, value: undefined });
            consumed = true;
            return Promise.resolve({ done: false, value: encoded });
          },
          cancel: () => Promise.resolve(),
          releaseLock: () => {},
        };
      },
    },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('POST /token (Token Proxy)', () => {
  it('substitutes CIMD client_id with upstream client_id', async () => {
    mockUpstreamTokenResponse();
    const app = createTestApp();

    const res = await request(app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        client_id: 'https://cursor.com/oauth-client.json',
        code: 'auth-code-123',
        redirect_uri: 'http://127.0.0.1:8080/callback',
        code_verifier: 'verifier-xyz',
      });

    expect(res.status).toBe(200);
    expect(res.body.access_token).toBe('tok_123');

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(fetchCall[0]).toBe(UPSTREAM_TOKEN_URL);
    const sentBody = new URLSearchParams(fetchCall[1].body as string);
    expect(sentBody.get('client_id')).toBe('cursor-sso-client');
    expect(sentBody.get('code')).toBe('auth-code-123');
    expect(sentBody.get('code_verifier')).toBe('verifier-xyz');
  });

  it('passes through non-CIMD client_id unchanged', async () => {
    mockUpstreamTokenResponse();
    const app = createTestApp();

    const res = await request(app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        client_id: 'regular-client-id',
        code: 'auth-code-456',
      });

    expect(res.status).toBe(200);
    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const sentBody = new URLSearchParams(fetchCall[1].body as string);
    expect(sentBody.get('client_id')).toBe('regular-client-id');
  });

  it('relays upstream response status and body', async () => {
    mockUpstreamTokenResponse({
      status: 400,
      body: { error: 'invalid_grant', error_description: 'Code expired' },
    });
    const app = createTestApp();

    const res = await request(app)
      .post('/token')
      .type('form')
      .send({ grant_type: 'authorization_code', client_id: 'regular', code: 'bad' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('returns 403 for unknown CIMD URL without default', async () => {
    const app = createTestApp({ map: CIMD_MAP });

    const res = await request(app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        client_id: 'https://unknown.com/oauth.json',
        code: 'code-123',
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('invalid_client');
  });

  it('uses default client_id for unknown CIMD URL when configured', async () => {
    mockUpstreamTokenResponse();
    const app = createTestApp({ map: CIMD_MAP, defaultClientId: 'generic-client' });

    const res = await request(app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        client_id: 'https://unknown.com/oauth.json',
        code: 'code-123',
      });

    expect(res.status).toBe(200);
    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const sentBody = new URLSearchParams(fetchCall[1].body as string);
    expect(sentBody.get('client_id')).toBe('generic-client');
  });

  it('works with grant_type=refresh_token', async () => {
    mockUpstreamTokenResponse({ body: { access_token: 'new_tok', token_type: 'Bearer', expires_in: 3600 } });
    const app = createTestApp();

    const res = await request(app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'refresh_token',
        client_id: 'https://cursor.com/oauth-client.json',
        refresh_token: 'rt_abc',
      });

    expect(res.status).toBe(200);
    expect(res.body.access_token).toBe('new_tok');
  });

  it('rejects request with wrong Content-Type (415)', async () => {
    const app = createTestApp();

    const res = await request(app)
      .post('/token')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ grant_type: 'authorization_code' }));

    expect(res.status).toBe(415);
    expect(res.body.error).toBe('invalid_request');
  });

  it('only relays whitelisted headers from upstream', async () => {
    mockUpstreamTokenResponse({
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'pragma': 'no-cache',
        'dpop-nonce': 'upstream-nonce-abc',
        'server': 'Keycloak/22.0',
        'x-powered-by': 'WildFly',
        'x-internal-trace': 'abc123',
      },
    });
    const app = createTestApp();

    const res = await request(app)
      .post('/token')
      .type('form')
      .send({ grant_type: 'authorization_code', client_id: 'regular', code: 'c' });

    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['pragma']).toBe('no-cache');
    expect(res.headers['dpop-nonce']).toBe('upstream-nonce-abc');
    expect(res.headers['server']).toBeUndefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-internal-trace']).toBeUndefined();
  });

  it('handles upstream timeout gracefully', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(
      new DOMException('The operation was aborted', 'AbortError'),
    );
    const app = createTestApp();

    const res = await request(app)
      .post('/token')
      .type('form')
      .send({ grant_type: 'authorization_code', client_id: 'regular', code: 'c' });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('server_error');
  });

  it('handles upstream redirect rejection', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(
      new TypeError('fetch failed: redirect mode is set to error'),
    );
    const app = createTestApp();

    const res = await request(app)
      .post('/token')
      .type('form')
      .send({ grant_type: 'authorization_code', client_id: 'regular', code: 'c' });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('server_error');
  });

  describe('CIMD URL validation', () => {
    it('rejects CIMD client_id with fragment', async () => {
      const app = createTestApp();

      const res = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          client_id: 'https://cursor.com/oauth-client.json#frag',
          code: 'code-123',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_client');
      expect(res.body.error_description).toMatch(/fragment/);
    });

    it('rejects CIMD client_id with dot segments', async () => {
      const app = createTestApp();

      const res = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          client_id: 'https://cursor.com/../etc/passwd',
          code: 'code-123',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_client');
      expect(res.body.error_description).toMatch(/dot/i);
    });

    it('rejects CIMD client_id with no path beyond /', async () => {
      const app = createTestApp();

      const res = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          client_id: 'https://cursor.com/',
          code: 'code-123',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_client');
      expect(res.body.error_description).toMatch(/path/);
    });

    it('rejects CIMD client_id with query string', async () => {
      const app = createTestApp();

      const res = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          client_id: 'https://cursor.com/oauth-client.json?foo=bar',
          code: 'code-123',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_client');
      expect(res.body.error_description).toMatch(/query/);
    });

    it('rejects CIMD client_id with userinfo', async () => {
      const app = createTestApp();

      const res = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          client_id: 'https://user:pass@cursor.com/oauth-client.json',
          code: 'code-123',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_client');
      expect(res.body.error_description).toMatch(/userinfo/);
    });

    it('does not validate non-CIMD client_id as URL', async () => {
      mockUpstreamTokenResponse();
      const app = createTestApp();

      const res = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          client_id: 'plain-client-id',
          code: 'code-123',
        });

      expect(res.status).toBe(200);
    });

    it('does not call upstream when CIMD URL validation fails', async () => {
      globalThis.fetch = vi.fn();
      const app = createTestApp();

      await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          client_id: 'https://cursor.com/#frag',
          code: 'code-123',
        });

      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  describe('redirect_uri validation and rewriting', () => {
    const REDIRECT_CONFIG = {
      redirectBaseUrl: 'http://localhost:3000',
      redirectAllowedUris: ['http://localhost:*', 'http://127.0.0.1:*'],
    };

    function createAppWithRedirect(options: {
      map?: Record<string, string>;
      defaultClientId?: string;
    } = {}) {
      const { map = CIMD_MAP, defaultClientId } = options;
      const app = express();
      app.disable('x-powered-by');
      app.use(createTokenRouter({
        getUpstreamTokenEndpoint: () => UPSTREAM_TOKEN_URL,
        cimdMap: map,
        cimdDefaultClientId: defaultClientId,
        requireResource: false,
        allowedResources: [],
        rejectedTotal: { inc() {} },
        ...REDIRECT_CONFIG,
      }, createLogger(false)));
      return app;
    }

    it('rewrites redirect_uri to adapter callback URL for authorization_code grant', async () => {
      mockUpstreamTokenResponse({ status: 200, body: { access_token: 'at', token_type: 'bearer' } });
      const app = createAppWithRedirect();

      const res = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          client_id: 'my-client',
          code: 'code-123',
          redirect_uri: 'http://localhost:8080/callback',
        });

      expect(res.status).toBe(200);
      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      const body = new URLSearchParams(fetchCall[1].body);
      expect(body.get('redirect_uri')).toBe('http://localhost:3000/authorize/callback');
    });

    it('rejects missing redirect_uri for authorization_code grant', async () => {
      const app = createAppWithRedirect();

      const res = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          client_id: 'my-client',
          code: 'code-123',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_request');
      expect(res.body.error_description).toContain('redirect_uri');
    });

    it('rejects redirect_uri not matching allowed patterns', async () => {
      const app = createAppWithRedirect();

      const res = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          client_id: 'my-client',
          code: 'code-123',
          redirect_uri: 'https://evil.com/steal',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_request');
      expect(res.body.error_description).toContain('redirect_uri');
    });

    it('passes through refresh_token grant without redirect_uri validation', async () => {
      mockUpstreamTokenResponse({ status: 200, body: { access_token: 'new-at', token_type: 'bearer' } });
      const app = createAppWithRedirect();

      const res = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'refresh_token',
          client_id: 'my-client',
          refresh_token: 'rt-123',
        });

      expect(res.status).toBe(200);
    });

    it('skips pattern validation for CIMD clients (validates via CIMD doc)', async () => {
      mockUpstreamTokenResponse({ status: 200, body: { access_token: 'at', token_type: 'bearer' } });
      const app = createAppWithRedirect({ defaultClientId: 'fallback' });

      const res = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          client_id: 'https://cursor.com/oauth-client.json',
          code: 'code-123',
          redirect_uri: 'http://localhost:8080/callback',
        });

      expect(res.status).toBe(200);
      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      const body = new URLSearchParams(fetchCall[1].body);
      expect(body.get('redirect_uri')).toBe('http://localhost:3000/authorize/callback');
    });
  });

  describe('client_credentials grant', () => {
    it('forwards client_secret_post params to upstream', async () => {
      mockUpstreamTokenResponse({ body: { access_token: 'cc_tok', token_type: 'Bearer', expires_in: 300 } });
      const app = createTestApp();

      const res = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'client_credentials',
          client_id: 'my-service',
          client_secret: 's3cr3t',
          scope: 'read write',
        });

      expect(res.status).toBe(200);
      expect(res.body.access_token).toBe('cc_tok');
      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      const sentBody = new URLSearchParams(fetchCall[1].body as string);
      expect(sentBody.get('grant_type')).toBe('client_credentials');
      expect(sentBody.get('client_id')).toBe('my-service');
      expect(sentBody.get('client_secret')).toBe('s3cr3t');
      expect(sentBody.get('scope')).toBe('read write');
    });

    it('forwards Authorization header for non-CIMD client (client_secret_basic)', async () => {
      mockUpstreamTokenResponse({ body: { access_token: 'basic_tok', token_type: 'Bearer' } });
      const app = createTestApp();
      const basicAuth = 'Basic ' + Buffer.from('my-service:s3cr3t').toString('base64');

      const res = await request(app)
        .post('/token')
        .type('form')
        .set('Authorization', basicAuth)
        .send({
          grant_type: 'client_credentials',
          scope: 'read',
        });

      expect(res.status).toBe(200);
      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(fetchCall[1].headers['Authorization']).toBe(basicAuth);
    });

    it('does NOT forward Authorization header for CIMD client_id', async () => {
      mockUpstreamTokenResponse({ body: { access_token: 'cimd_tok', token_type: 'Bearer' } });
      const app = createTestApp({ defaultClientId: 'generic-client' });
      const basicAuth = 'Basic ' + Buffer.from('fake:creds').toString('base64');

      const res = await request(app)
        .post('/token')
        .type('form')
        .set('Authorization', basicAuth)
        .send({
          grant_type: 'client_credentials',
          client_id: 'https://cursor.com/oauth-client.json',
          scope: 'read',
        });

      expect(res.status).toBe(200);
      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(fetchCall[1].headers['Authorization']).toBeUndefined();
    });

    it('does not require redirect_uri', async () => {
      mockUpstreamTokenResponse({ body: { access_token: 'tok', token_type: 'Bearer' } });
      const app = createTestApp();

      const res = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'client_credentials',
          client_id: 'my-service',
          client_secret: 's3cr3t',
        });

      expect(res.status).toBe(200);
    });

    it('relays upstream error transparently', async () => {
      mockUpstreamTokenResponse({
        status: 401,
        body: { error: 'invalid_client', error_description: 'Bad credentials' },
      });
      const app = createTestApp();

      const res = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'client_credentials',
          client_id: 'bad-service',
          client_secret: 'wrong',
        });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_client');
    });
  });

  describe('JWT bearer assertion grant', () => {
    it('forwards urn:ietf:params:oauth:grant-type:jwt-bearer with assertion', async () => {
      mockUpstreamTokenResponse({ body: { access_token: 'jwt_tok', token_type: 'Bearer', expires_in: 300 } });
      const app = createTestApp();
      const jwtAssertion = 'eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOiJteS1zZXJ2aWNlIn0.signature';

      const res = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: jwtAssertion,
          scope: 'read write',
        });

      expect(res.status).toBe(200);
      expect(res.body.access_token).toBe('jwt_tok');
      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      const sentBody = new URLSearchParams(fetchCall[1].body as string);
      expect(sentBody.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
      expect(sentBody.get('assertion')).toBe(jwtAssertion);
      expect(sentBody.get('scope')).toBe('read write');
    });
  });

  describe('Authorization header forwarding', () => {
    it('forwards Authorization header for non-CIMD authorization_code grant', async () => {
      mockUpstreamTokenResponse({ body: { access_token: 'at', token_type: 'Bearer' } });
      const app = createTestApp();
      const basicAuth = 'Basic ' + Buffer.from('confidential-client:secret').toString('base64');

      const res = await request(app)
        .post('/token')
        .type('form')
        .set('Authorization', basicAuth)
        .send({
          grant_type: 'authorization_code',
          client_id: 'confidential-client',
          code: 'auth-code',
        });

      expect(res.status).toBe(200);
      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(fetchCall[1].headers['Authorization']).toBe(basicAuth);
    });

    it('forwards Authorization header for non-CIMD refresh_token grant', async () => {
      mockUpstreamTokenResponse({ body: { access_token: 'new_at', token_type: 'Bearer' } });
      const app = createTestApp();
      const basicAuth = 'Basic ' + Buffer.from('confidential-client:secret').toString('base64');

      const res = await request(app)
        .post('/token')
        .type('form')
        .set('Authorization', basicAuth)
        .send({
          grant_type: 'refresh_token',
          client_id: 'confidential-client',
          refresh_token: 'rt-abc',
        });

      expect(res.status).toBe(200);
      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(fetchCall[1].headers['Authorization']).toBe(basicAuth);
    });

    it('does not forward Authorization header for CIMD refresh_token grant', async () => {
      mockUpstreamTokenResponse({ body: { access_token: 'at', token_type: 'Bearer' } });
      const app = createTestApp({ defaultClientId: 'generic' });
      const basicAuth = 'Basic ' + Buffer.from('fake:creds').toString('base64');

      const res = await request(app)
        .post('/token')
        .type('form')
        .set('Authorization', basicAuth)
        .send({
          grant_type: 'refresh_token',
          client_id: 'https://cursor.com/oauth-client.json',
          refresh_token: 'rt-abc',
        });

      expect(res.status).toBe(200);
      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(fetchCall[1].headers['Authorization']).toBeUndefined();
    });
  });

  describe('DPoP header forwarding', () => {
    it('forwards DPoP header for non-CIMD client', async () => {
      mockUpstreamTokenResponse({ body: { access_token: 'dpop_tok', token_type: 'DPoP' } });
      const app = createTestApp();
      const dpopProof = 'eyJhbGciOiJFUzI1NiJ9.eyJodHUiOiJodHRwczovL2FkYXB0ZXIvdG9rZW4ifQ.sig';

      const res = await request(app)
        .post('/token')
        .type('form')
        .set('DPoP', dpopProof)
        .send({
          grant_type: 'client_credentials',
          client_id: 'my-service',
          client_secret: 's3cr3t',
        });

      expect(res.status).toBe(200);
      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(fetchCall[1].headers['DPoP']).toBe(dpopProof);
    });

    it('forwards DPoP and DPoP-Nonce request headers together', async () => {
      mockUpstreamTokenResponse();
      const app = createTestApp();
      const dpopProof = 'eyJhbGciOiJFUzI1NiJ9.eyJub25jZSI6ImFiYyJ9.sig';

      const res = await request(app)
        .post('/token')
        .type('form')
        .set('DPoP', dpopProof)
        .set('DPoP-Nonce', 'nonce-from-client')
        .send({
          grant_type: 'client_credentials',
          client_id: 'my-service',
          client_secret: 's3cr3t',
        });

      expect(res.status).toBe(200);
      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(fetchCall[1].headers['DPoP']).toBe(dpopProof);
      expect(fetchCall[1].headers['DPoP-Nonce']).toBe('nonce-from-client');
    });

    it('forwards DPoP for CIMD client_id while not forwarding Authorization', async () => {
      mockUpstreamTokenResponse({ body: { access_token: 'cimd_dpop', token_type: 'DPoP' } });
      const app = createTestApp({ defaultClientId: 'generic-client' });
      const basicAuth = 'Basic ' + Buffer.from('fake:creds').toString('base64');
      const dpopProof = 'eyJhbGciOiJFUzI1NiJ9.eyJodHUiOiJodHRwczovL2FkYXB0ZXIvdG9rZW4ifQ.sig';

      const res = await request(app)
        .post('/token')
        .type('form')
        .set('Authorization', basicAuth)
        .set('DPoP', dpopProof)
        .send({
          grant_type: 'client_credentials',
          client_id: 'https://cursor.com/oauth-client.json',
          scope: 'read',
        });

      expect(res.status).toBe(200);
      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(fetchCall[1].headers['Authorization']).toBeUndefined();
      expect(fetchCall[1].headers['DPoP']).toBe(dpopProof);
    });

    it('does not set DPoP on upstream fetch when client omits it', async () => {
      mockUpstreamTokenResponse();
      const app = createTestApp();

      const res = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'client_credentials',
          client_id: 'my-service',
          client_secret: 's3cr3t',
        });

      expect(res.status).toBe(200);
      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      expect(fetchCall[1].headers['DPoP']).toBeUndefined();
      expect(fetchCall[1].headers['DPoP-Nonce']).toBeUndefined();
    });
  });

  describe('rejection counter', () => {
    it('increments rejectedTotal with content_type_invalid (no grant_type)', async () => {
      const incSpy = vi.fn();
      const app = express();
      app.disable('x-powered-by');
      app.use(createTokenRouter({
        getUpstreamTokenEndpoint: () => UPSTREAM_TOKEN_URL,
        cimdMap: CIMD_MAP,
        requireResource: false,
        allowedResources: [],
        rejectedTotal: { inc: incSpy },
      }, createLogger(false)));

      await request(app)
        .post('/token')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ grant_type: 'authorization_code' }));

      expect(incSpy).toHaveBeenCalledWith({
        route: '/token',
        reason: 'content_type_invalid',
      });
    });

    it('increments rejectedTotal with grant_type label for resource_required', async () => {
      const incSpy = vi.fn();
      const app = express();
      app.disable('x-powered-by');
      app.use(createTokenRouter({
        getUpstreamTokenEndpoint: () => UPSTREAM_TOKEN_URL,
        cimdMap: CIMD_MAP,
        requireResource: true,
        allowedResources: [],
        rejectedTotal: { inc: incSpy },
      }, createLogger(false)));

      await request(app)
        .post('/token')
        .type('form')
        .send({ grant_type: 'authorization_code', client_id: 'test', code: 'c' });

      expect(incSpy).toHaveBeenCalledWith({
        route: '/token',
        reason: 'resource_required',
        grant_type: 'authorization_code',
      });
    });
  });

  describe('grant_type label on upstream metrics', () => {
    it('includes grant_type in upstream duration and status metrics', async () => {
      const { createMetricsRegistry } = await import('../src/metrics');
      const registry = createMetricsRegistry(true);
      mockUpstreamTokenResponse();

      const app = express();
      app.disable('x-powered-by');
      app.use(createTokenRouter({
        getUpstreamTokenEndpoint: () => UPSTREAM_TOKEN_URL,
        cimdMap: {},
        requireResource: false,
        allowedResources: [],
        rejectedTotal: { inc() {} },
        metricsRegistry: registry,
      }, createLogger(false)));

      await request(app)
        .post('/token')
        .type('form')
        .send({ grant_type: 'authorization_code', client_id: 'test', code: 'c' });

      const output = registry.serialize();
      expect(output).toContain('grant_type="authorization_code"');
      expect(output).toContain('mcp_auth_token_proxy_upstream_status_total');
      expect(output).toContain('mcp_auth_token_proxy_upstream_duration_seconds');
    });
  });

  describe('resource parameter validation', () => {
    function createAppWithResource(options: {
      requireResource?: boolean;
      allowedResources?: string[];
    } = {}) {
      const { requireResource = false, allowedResources = [] } = options;
      const app = express();
      app.disable('x-powered-by');
      app.use(createTokenRouter({
        getUpstreamTokenEndpoint: () => UPSTREAM_TOKEN_URL,
        cimdMap: CIMD_MAP,
        requireResource,
        allowedResources: parseResourcePatterns(allowedResources),
        rejectedTotal: { inc() {} },
      }, createLogger(false)));
      return app;
    }

    it('passes through valid resource for authorization_code grant', async () => {
      mockUpstreamTokenResponse();
      const app = createAppWithResource();

      const res = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          client_id: 'my-client',
          code: 'code-123',
          resource: 'https://mcp.example.com',
        });

      expect(res.status).toBe(200);
      const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
      const body = new URLSearchParams(fetchCall[1].body);
      expect(body.get('resource')).toBe('https://mcp.example.com');
    });

    it('rejects resource with custom scheme', async () => {
      const app = createAppWithResource();

      const res = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          client_id: 'my-client',
          code: 'code-123',
          resource: 'cursor://foo/bar',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_request');
      expect(res.body.error_description).toContain('resource');
    });

    it('rejects resource with fragment', async () => {
      const app = createAppWithResource();

      const res = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          client_id: 'my-client',
          code: 'code-123',
          resource: 'https://mcp.example.com#frag',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_request');
    });

    it('rejects request missing resource when requireResource is true', async () => {
      const app = createAppWithResource({ requireResource: true });

      const res = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          client_id: 'my-client',
          code: 'code-123',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_request');
      expect(res.body.error_description).toContain('resource');
      expect(res.body.error_description).toContain('RFC 8707');
    });

    it('enforces requireResource for client_credentials grant', async () => {
      const app = createAppWithResource({ requireResource: true });

      const res = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'client_credentials',
          client_id: 'my-service',
          client_secret: 'secret',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_request');
      expect(res.body.error_description).toContain('resource');
    });

    it('skips validation for refresh_token grant', async () => {
      mockUpstreamTokenResponse({ body: { access_token: 'new_tok', token_type: 'Bearer' } });
      const app = createAppWithResource({ requireResource: true });

      const res = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'refresh_token',
          client_id: 'my-client',
          refresh_token: 'rt-abc',
        });

      expect(res.status).toBe(200);
    });

    it('rejects non-matching resource with allowlist', async () => {
      const app = createAppWithResource({ allowedResources: ['https://mcp.example.com/*'] });

      const res = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          client_id: 'my-client',
          code: 'code-123',
          resource: 'https://other.example.com/mcp',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_request');
      expect(res.body.error_description).toBe('resource not allowed');
    });

    it('passes matching resource with allowlist', async () => {
      mockUpstreamTokenResponse();
      const app = createAppWithResource({ allowedResources: ['https://mcp.example.com/*'] });

      const res = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'authorization_code',
          client_id: 'my-client',
          code: 'code-123',
          resource: 'https://mcp.example.com/v1/tools',
        });

      expect(res.status).toBe(200);
    });

    it('enforces validation for jwt-bearer grant', async () => {
      const app = createAppWithResource({ requireResource: true });

      const res = await request(app)
        .post('/token')
        .type('form')
        .send({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion: 'eyJ...',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_request');
      expect(res.body.error_description).toContain('resource');
    });
  });
});

// ---------------------------------------------------------------------------
// Per-client redirect_uri enforcement
// ---------------------------------------------------------------------------
describe('POST /token (per-client redirect_uri enforcement)', () => {
  const REDIRECT_CONFIG = {
    redirectBaseUrl: 'http://localhost:3000',
    redirectAllowedUris: ['http://localhost:*', 'http://127.0.0.1:*'],
  };

  const PER_CLIENT_MAP = new Map<string, string[]>([
    ['cursor-sso-client', ['cursor://anysphere.cursor-mcp/*']],
    ['claude-sso-client', ['http://localhost:*', 'http://127.0.0.1:*']],
  ]);

  function createAppWithPerClient(options: {
    map?: Record<string, string>;
    dcrClientIdRedirectMap?: Map<string, string[]>;
  } = {}) {
    const { map = CIMD_MAP, dcrClientIdRedirectMap = PER_CLIENT_MAP } = options;
    const app = express();
    app.disable('x-powered-by');
    app.use(createTokenRouter({
      getUpstreamTokenEndpoint: () => UPSTREAM_TOKEN_URL,
      cimdMap: map,
      requireResource: false,
      allowedResources: [],
      rejectedTotal: { inc() {} },
      dcrClientIdRedirectMap,
      ...REDIRECT_CONFIG,
    }, createLogger(false)));
    return app;
  }

  it('per-client: valid redirect_uri proceeds', async () => {
    mockUpstreamTokenResponse();
    const app = createAppWithPerClient();

    const res = await request(app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        client_id: 'claude-sso-client',
        code: 'code-123',
        redirect_uri: 'http://localhost:8080/callback',
      });

    expect(res.status).toBe(200);
  });

  it('per-client: invalid redirect_uri → 400', async () => {
    const app = createAppWithPerClient();

    const res = await request(app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        client_id: 'cursor-sso-client',
        code: 'code-123',
        redirect_uri: 'http://localhost:8080/callback',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(res.body.error_description).toContain('redirect_uri not allowed');
  });

  it('refresh_token grant: per-client redirect check does NOT apply', async () => {
    mockUpstreamTokenResponse();
    const app = createAppWithPerClient();

    const res = await request(app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'refresh_token',
        client_id: 'cursor-sso-client',
        refresh_token: 'rt-abc',
      });

    expect(res.status).toBe(200);
  });

  it('client_credentials grant: per-client redirect check does NOT apply', async () => {
    mockUpstreamTokenResponse();
    const app = createAppWithPerClient();

    const res = await request(app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'client_credentials',
        client_id: 'cursor-sso-client',
        client_secret: 'secret',
      });

    expect(res.status).toBe(200);
  });

  it('jwt_bearer grant: per-client redirect check does NOT apply', async () => {
    mockUpstreamTokenResponse();
    const app = createAppWithPerClient();

    const res = await request(app)
      .post('/token')
      .type('form')
      .send({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        client_id: 'cursor-sso-client',
        assertion: 'eyJ...',
      });

    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// idp_client label on token upstream metrics
// ---------------------------------------------------------------------------
describe('POST /token (idp_client metrics label)', () => {
  const KNOWN_CLIENTS = new Set(['cursor-sso-client']);

  it('idp_client label on upstream metrics when client_id is known', async () => {
    const registry = createMetricsRegistry(true);
    mockUpstreamTokenResponse();

    const app = express();
    app.disable('x-powered-by');
    app.use(createTokenRouter({
      getUpstreamTokenEndpoint: () => UPSTREAM_TOKEN_URL,
      cimdMap: {},
      requireResource: false,
      allowedResources: [],
      rejectedTotal: { inc() {} },
      metricsRegistry: registry,
      knownIdpClients: KNOWN_CLIENTS,
    }, createLogger(false)));

    await request(app)
      .post('/token')
      .type('form')
      .send({ grant_type: 'authorization_code', client_id: 'cursor-sso-client', code: 'c' });

    const output = registry.serialize();
    expect(output).toContain('idp_client="cursor-sso-client"');
    expect(output).toContain('mcp_auth_token_proxy_upstream_status_total');
    expect(output).toContain('mcp_auth_token_proxy_upstream_duration_seconds');
  });

  it('idp_client label absent for unknown client_id', async () => {
    const registry = createMetricsRegistry(true);
    mockUpstreamTokenResponse();

    const app = express();
    app.disable('x-powered-by');
    app.use(createTokenRouter({
      getUpstreamTokenEndpoint: () => UPSTREAM_TOKEN_URL,
      cimdMap: {},
      requireResource: false,
      allowedResources: [],
      rejectedTotal: { inc() {} },
      metricsRegistry: registry,
      knownIdpClients: KNOWN_CLIENTS,
    }, createLogger(false)));

    await request(app)
      .post('/token')
      .type('form')
      .send({ grant_type: 'authorization_code', client_id: 'unknown-client', code: 'c' });

    const output = registry.serialize();
    expect(output).not.toContain('idp_client');
  });
});
