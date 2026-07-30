import request from 'supertest';
import { createApp } from '../src/app';
import { AppConfig } from '../src/config';
import { verifyState } from '../src/state-signer';

const UPSTREAM_PAR =
  'https://sso.example.com/auth/realms/test/protocol/openid-connect/ext/par/request';
const UPSTREAM_AUTH =
  'https://sso.example.com/auth/realms/test/protocol/openid-connect/auth';

const TEST_STATE_SECRET = Buffer.from('a'.repeat(64), 'hex');

const MOCK_UPSTREAM_DOC: Record<string, unknown> = {
  issuer: 'https://sso.example.com/auth/realms/test',
  authorization_endpoint: UPSTREAM_AUTH,
  token_endpoint: 'https://sso.example.com/auth/realms/test/protocol/openid-connect/token',
  pushed_authorization_request_endpoint: UPSTREAM_PAR,
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

function makeApp(
  configOverrides: Partial<AppConfig> = {},
  upstreamDoc: Record<string, unknown> = MOCK_UPSTREAM_DOC,
) {
  return createApp({
    config: { ...CONFIG, ...configOverrides },
    upstreamDoc,
  });
}

function mockUpstreamParResponse(options: {
  status?: number;
  body?: Record<string, unknown>;
  headers?: Record<string, string>;
} = {}) {
  const {
    status = 201,
    body = {
      request_uri: 'urn:ietf:params:oauth:request_uri:example',
      expires_in: 90,
    },
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

describe('POST /par (PAR Proxy)', () => {
  it('returns 404 when upstream does not announce PAR', async () => {
    const noPar = { ...MOCK_UPSTREAM_DOC };
    delete noPar.pushed_authorization_request_endpoint;
    const { app } = makeApp({}, noPar);

    const res = await request(app)
      .post('/par')
      .type('form')
      .send({
        client_id: 'test-client',
        redirect_uri: 'http://localhost:8080/callback',
        response_type: 'code',
      });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('invalid_request');
  });

  it('returns upstream request_uri on success', async () => {
    mockUpstreamParResponse();
    const { app } = makeApp();

    const res = await request(app)
      .post('/par')
      .type('form')
      .send({
        client_id: 'test-client',
        redirect_uri: 'http://localhost:8080/callback',
        response_type: 'code',
        scope: 'openid offline_access profile',
        state: 'client-state',
        code_challenge: 'challenge',
        code_challenge_method: 'S256',
      });

    expect(res.status).toBe(201);
    expect(res.body.request_uri).toBe('urn:ietf:params:oauth:request_uri:example');
    expect(res.body.expires_in).toBe(90);

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(fetchCall[0]).toBe(UPSTREAM_PAR);
    const sent = new URLSearchParams(fetchCall[1].body as string);
    expect(sent.get('client_id')).toBe('test-client');
    expect(sent.get('redirect_uri')).toBe('http://localhost:3000/authorize/callback');
    expect(sent.get('scope')).toBe('openid profile');
    expect(sent.get('state')).not.toBe('client-state');
    const verified = verifyState(sent.get('state')!, [TEST_STATE_SECRET]);
    expect(verified).not.toBeNull();
    expect(verified!.redirectUri).toBe('http://localhost:8080/callback');
    expect(verified!.state).toBe('client-state');
  });

  it('rejects request_uri in PAR body', async () => {
    const { app } = makeApp();

    const res = await request(app)
      .post('/par')
      .type('form')
      .send({
        client_id: 'test-client',
        redirect_uri: 'http://localhost:8080/callback',
        response_type: 'code',
        request_uri: 'urn:ietf:params:oauth:request_uri:evil',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
  });

  it('rejects invalid Content-Type', async () => {
    const { app } = makeApp();

    const res = await request(app)
      .post('/par')
      .set('Content-Type', 'application/json')
      .send({ client_id: 'test-client' });

    expect(res.status).toBe(415);
  });

  it('rejects disallowed redirect_uri', async () => {
    const { app } = makeApp();

    const res = await request(app)
      .post('/par')
      .type('form')
      .send({
        client_id: 'test-client',
        redirect_uri: 'https://evil.example.com/callback',
        response_type: 'code',
      });

    expect(res.status).toBe(400);
    expect(res.body.error_description).toBe('redirect_uri not allowed');
  });

  it('rejects missing redirect_uri when state wrapping is active', async () => {
    const { app } = makeApp();

    const res = await request(app)
      .post('/par')
      .type('form')
      .send({
        client_id: 'test-client',
        response_type: 'code',
      });

    expect(res.status).toBe(400);
    expect(res.body.error_description).toBe('redirect_uri is required');
  });

  it('forwards Authorization and DPoP headers', async () => {
    mockUpstreamParResponse({
      headers: { 'dpop-nonce': 'nonce-from-upstream' },
    });
    const { app } = makeApp();
    const dpopProof = 'eyJhbGciOiJFUzI1NiJ9.eyJodHUiOiJodHRwczovL2FkYXB0ZXIvcGFyIn0.sig';

    const res = await request(app)
      .post('/par')
      .type('form')
      .set('Authorization', 'Basic dGVzdDpzZWNyZXQ=')
      .set('DPoP', dpopProof)
      .set('DPoP-Nonce', 'client-nonce')
      .send({
        client_id: 'test-client',
        redirect_uri: 'http://localhost:8080/callback',
        response_type: 'code',
      });

    expect(res.status).toBe(201);
    expect(res.headers['dpop-nonce']).toBe('nonce-from-upstream');

    const fetchCall = vi.mocked(globalThis.fetch).mock.calls[0];
    const headers = fetchCall[1].headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Basic dGVzdDpzZWNyZXQ=');
    expect(headers['DPoP']).toBe(dpopProof);
    expect(headers['DPoP-Nonce']).toBe('client-nonce');
  });

  it('substitutes CIMD client_id', async () => {
    mockUpstreamParResponse();
    const CIMD_URL = 'https://cursor.com/oauth-client.json';
    const { app } = createApp({
      config: {
        ...CONFIG,
        cimdEnabled: true,
        cimdMap: { [CIMD_URL]: 'cursor-sso-client' },
      },
      upstreamDoc: MOCK_UPSTREAM_DOC,
      cimdFetcher: () => Promise.resolve({
        client_id: CIMD_URL,
        redirect_uris: ['http://127.0.0.1:8080/callback'],
      }),
    });

    const res = await request(app)
      .post('/par')
      .type('form')
      .send({
        client_id: CIMD_URL,
        redirect_uri: 'http://127.0.0.1:8080/callback',
        response_type: 'code',
      });

    expect(res.status).toBe(201);
    const sent = new URLSearchParams(
      vi.mocked(globalThis.fetch).mock.calls[0][1].body as string,
    );
    expect(sent.get('client_id')).toBe('cursor-sso-client');
  });

  it('returns 502 when upstream fetch fails', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'));
    const { app } = makeApp();

    const res = await request(app)
      .post('/par')
      .type('form')
      .send({
        client_id: 'test-client',
        redirect_uri: 'http://localhost:8080/callback',
        response_type: 'code',
      });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('server_error');
  });

  it('returns 502 when upstream response exceeds size limit', async () => {
    const oversized = new TextEncoder().encode('x'.repeat(65 * 1024));
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      body: {
        getReader: () => {
          let consumed = false;
          return {
            read: () => {
              if (consumed) return Promise.resolve({ done: true, value: undefined });
              consumed = true;
              return Promise.resolve({ done: false, value: oversized });
            },
            cancel: () => Promise.resolve(),
            releaseLock: () => {},
          };
        },
      },
    });
    const { app } = makeApp();

    const res = await request(app)
      .post('/par')
      .type('form')
      .send({
        client_id: 'test-client',
        redirect_uri: 'http://localhost:8080/callback',
        response_type: 'code',
      });

    expect(res.status).toBe(502);
    expect(res.body.error_description).toBe('Failed reading PAR endpoint upstream response');
  });

  it('rejects missing resource when requireResource is true', async () => {
    const { app } = makeApp({ requireResource: true });

    const res = await request(app)
      .post('/par')
      .type('form')
      .send({
        client_id: 'test-client',
        redirect_uri: 'http://localhost:8080/callback',
        response_type: 'code',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_request');
    expect(res.body.error_description).toMatch(/resource/i);
  });

  it('records upstream status metrics with bounded idp_client label', async () => {
    mockUpstreamParResponse();
    const { app, metricsRegistry } = createApp({
      config: { ...CONFIG, metricsEnabled: true, clientId: 'test-client' },
      upstreamDoc: MOCK_UPSTREAM_DOC,
    });

    await request(app)
      .post('/par')
      .type('form')
      .send({
        client_id: 'test-client',
        redirect_uri: 'http://localhost:8080/callback',
        response_type: 'code',
      });

    const text = metricsRegistry.serialize();
    expect(text).toContain('mcp_auth_par_proxy_upstream_status_total');
    expect(text).toContain('idp_client="test-client"');
    expect(text).toContain('status="201"');
  });
});
