import request from 'supertest';
import { createApp } from '../src/app';
import { AppConfig } from '../src/config';

const MOCK_UPSTREAM_DOC: Record<string, unknown> = {
  issuer: 'https://sso.example.com/auth/realms/test',
  authorization_endpoint: 'https://sso.example.com/auth/realms/test/protocol/openid-connect/auth',
  token_endpoint: 'https://sso.example.com/auth/realms/test/protocol/openid-connect/token',
  code_challenge_methods_supported: ['S256'],
};

const CONFIG: AppConfig = {
  baseUrl: 'http://localhost:3000',
  port: 3000,
  upstreamSsoUrl: 'https://sso.example.com/auth/realms/test',
  clientId: 'fixed-test-client',
  proxyAuthEndpoint: false,
  proxyDcrEndpoint: true,
  wellKnownRefreshMinutes: 60,
  debug: false,
  cimdMap: {},
  cimdCacheMinutes: 30,
  cimdEnabled: false,
  shutdownTimeoutSeconds: 30,
};

function makeApp(configOverrides: Partial<AppConfig> = {}) {
  return createApp({
    config: { ...CONFIG, ...configOverrides },
    upstreamDoc: MOCK_UPSTREAM_DOC,
  }).app;
}

describe('POST /register (DCR Proxy)', () => {
  it('returns 201 with the configured client_id', async () => {
    const app = makeApp();

    const res = await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({ redirect_uris: ['http://localhost:8080/callback'] });

    expect(res.status).toBe(201);
    expect(res.body.client_id).toBe('fixed-test-client');
  });

  it('returns token_endpoint_auth_method as none', async () => {
    const app = makeApp();

    const res = await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({});

    expect(res.body.token_endpoint_auth_method).toBe('none');
  });

  it('echoes back request body fields', async () => {
    const app = makeApp();
    const body = {
      redirect_uris: ['http://localhost:9000/cb'],
      client_name: 'My MCP Client',
      grant_types: ['authorization_code'],
      software_statement: 'eyJhbGciOiJSUzI1NiJ9.test.signature',
    };

    const res = await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).toBe(201);
    expect(res.body.redirect_uris).toEqual(body.redirect_uris);
    expect(res.body.client_name).toBe(body.client_name);
    expect(res.body.grant_types).toEqual(body.grant_types);
    expect(res.body.software_statement).toBe(body.software_statement);
  });

  it('sets Cache-Control: no-store header', async () => {
    const app = makeApp();

    const res = await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({});

    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('configured client_id overrides any client_id in the request', async () => {
    const app = makeApp();

    const res = await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({ client_id: 'attacker-client' });

    expect(res.body.client_id).toBe('fixed-test-client');
  });

  it('returns 404 when proxyDcrEndpoint is disabled', async () => {
    const app = makeApp({ proxyDcrEndpoint: false });

    const res = await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({ redirect_uris: ['http://localhost:8080/callback'] });

    expect(res.status).toBe(404);
  });

  describe('Content-Type enforcement (CSRF protection)', () => {
    it('rejects requests without Content-Type header', async () => {
      const app = makeApp();

      const res = await request(app)
        .post('/register')
        .set('Content-Type', 'text/plain')
        .send('{}');

      expect(res.status).toBe(415);
      expect(res.body.error).toBe('invalid_request');
    });

    it('rejects form-urlencoded requests', async () => {
      const app = makeApp();

      const res = await request(app)
        .post('/register')
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send('client_name=evil');

      expect(res.status).toBe(415);
    });

    it('rejects multipart/form-data requests', async () => {
      const app = makeApp();

      const res = await request(app)
        .post('/register')
        .set('Content-Type', 'multipart/form-data; boundary=---')
        .send('---');

      expect(res.status).toBe(415);
    });
  });
});
