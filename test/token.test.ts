import request from 'supertest';
import express from 'express';
import { createTokenRouter } from '../src/routes/token';
import { createLogger } from '../src/logger';

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
  app.use(createTokenRouter(
    () => UPSTREAM_TOKEN_URL,
    { map, defaultClientId },
    createLogger(false),
  ));
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

  (globalThis.fetch as jest.Mock) = jest.fn().mockResolvedValue({
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
  jest.restoreAllMocks();
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

    const fetchCall = (globalThis.fetch as jest.Mock).mock.calls[0];
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
    const fetchCall = (globalThis.fetch as jest.Mock).mock.calls[0];
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
    const fetchCall = (globalThis.fetch as jest.Mock).mock.calls[0];
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
    expect(res.headers['server']).toBeUndefined();
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-internal-trace']).toBeUndefined();
  });

  it('handles upstream timeout gracefully', async () => {
    (globalThis.fetch as jest.Mock) = jest.fn().mockRejectedValue(
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
    (globalThis.fetch as jest.Mock) = jest.fn().mockRejectedValue(
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
      (globalThis.fetch as jest.Mock) = jest.fn();
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
      baseUrl: 'http://localhost:3000',
      allowedRedirectUris: ['http://localhost:*', 'http://127.0.0.1:*'],
    };

    function createAppWithRedirect(options: {
      map?: Record<string, string>;
      defaultClientId?: string;
    } = {}) {
      const { map = CIMD_MAP, defaultClientId } = options;
      const app = express();
      app.disable('x-powered-by');
      app.use(createTokenRouter(
        () => UPSTREAM_TOKEN_URL,
        { map, defaultClientId },
        createLogger(false),
        undefined,
        REDIRECT_CONFIG,
      ));
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
      const fetchCall = (globalThis.fetch as jest.Mock).mock.calls[0];
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
      const fetchCall = (globalThis.fetch as jest.Mock).mock.calls[0];
      const body = new URLSearchParams(fetchCall[1].body);
      expect(body.get('redirect_uri')).toBe('http://localhost:3000/authorize/callback');
    });
  });
});
