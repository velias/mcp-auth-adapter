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
  metricsEnabled: false,
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

  it('echoes back recognized RFC 7591 fields', async () => {
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

  it('drops arbitrary fields not in the DCR whitelist', async () => {
    const app = makeApp();
    const body = {
      redirect_uris: ['http://localhost:9000/cb'],
      client_name: 'Legit Client',
      arbitrary_key: 'should-be-dropped',
      __proto__: { injected: true },
      client_secret: 'fake-secret',
      registration_access_token: 'fake-token',
    };

    const res = await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send(body);

    expect(res.status).toBe(201);
    expect(res.body.redirect_uris).toEqual(body.redirect_uris);
    expect(res.body.client_name).toBe('Legit Client');
    expect(res.body).not.toHaveProperty('arbitrary_key');
    expect(res.body).not.toHaveProperty('client_secret');
    expect(res.body).not.toHaveProperty('registration_access_token');
    expect(res.body).not.toHaveProperty('injected');
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

  describe('DCR input validation', () => {
    describe('redirect_uris', () => {
      it('rejects non-array redirect_uris', async () => {
        const app = makeApp();
        const res = await request(app)
          .post('/register')
          .set('Content-Type', 'application/json')
          .send({ redirect_uris: 'http://localhost/cb' });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_client_metadata');
        expect(res.body.error_description).toContain('redirect_uris');
      });

      it('rejects non-string entry in redirect_uris', async () => {
        const app = makeApp();
        const res = await request(app)
          .post('/register')
          .set('Content-Type', 'application/json')
          .send({ redirect_uris: [123] });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_client_metadata');
        expect(res.body.error_description).toContain('redirect_uris[0]');
      });

      it('rejects URI with fragment (RFC 6749 §3.1.2)', async () => {
        const app = makeApp();
        const res = await request(app)
          .post('/register')
          .set('Content-Type', 'application/json')
          .send({ redirect_uris: ['http://localhost/cb#frag'] });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_client_metadata');
        expect(res.body.error_description).toContain('fragment');
      });

      it('rejects unparseable URI', async () => {
        const app = makeApp();
        const res = await request(app)
          .post('/register')
          .set('Content-Type', 'application/json')
          .send({ redirect_uris: ['://not-a-uri'] });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_client_metadata');
        expect(res.body.error_description).toContain('redirect_uris[0]');
      });

      it('accepts http and https schemes', async () => {
        const app = makeApp();
        const res = await request(app)
          .post('/register')
          .set('Content-Type', 'application/json')
          .send({ redirect_uris: ['http://localhost:9999/cb', 'https://app.example.com/cb'] });

        expect(res.status).toBe(201);
        expect(res.body.redirect_uris).toEqual(['http://localhost:9999/cb', 'https://app.example.com/cb']);
      });

      it('accepts custom URI schemes (RFC 8252 §7.1)', async () => {
        const app = makeApp();
        const uris = [
          'cursor://anysphere.cursor-mcp/callback',
          'vscode://vscode.github-authentication/callback',
        ];
        const res = await request(app)
          .post('/register')
          .set('Content-Type', 'application/json')
          .send({ redirect_uris: uris });

        expect(res.status).toBe(201);
        expect(res.body.redirect_uris).toEqual(uris);
      });

      it('accepts empty array', async () => {
        const app = makeApp();
        const res = await request(app)
          .post('/register')
          .set('Content-Type', 'application/json')
          .send({ redirect_uris: [] });

        expect(res.status).toBe(201);
        expect(res.body.redirect_uris).toEqual([]);
      });
    });

    describe('grant_types', () => {
      it('rejects non-array grant_types', async () => {
        const app = makeApp();
        const res = await request(app)
          .post('/register')
          .set('Content-Type', 'application/json')
          .send({ grant_types: 'authorization_code' });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_client_metadata');
        expect(res.body.error_description).toContain('grant_types');
      });

      it('rejects non-string entry in grant_types', async () => {
        const app = makeApp();
        const res = await request(app)
          .post('/register')
          .set('Content-Type', 'application/json')
          .send({ grant_types: [42] });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_client_metadata');
        expect(res.body.error_description).toContain('grant_types[0]');
      });

      it('accepts diverse grant types', async () => {
        const app = makeApp();
        const types = ['authorization_code', 'refresh_token', 'client_credentials'];
        const res = await request(app)
          .post('/register')
          .set('Content-Type', 'application/json')
          .send({ grant_types: types });

        expect(res.status).toBe(201);
        expect(res.body.grant_types).toEqual(types);
      });
    });

    describe('response_types', () => {
      it('rejects non-array response_types', async () => {
        const app = makeApp();
        const res = await request(app)
          .post('/register')
          .set('Content-Type', 'application/json')
          .send({ response_types: 'code' });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_client_metadata');
        expect(res.body.error_description).toContain('response_types');
      });

      it('rejects non-string entry in response_types', async () => {
        const app = makeApp();
        const res = await request(app)
          .post('/register')
          .set('Content-Type', 'application/json')
          .send({ response_types: [null] });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_client_metadata');
        expect(res.body.error_description).toContain('response_types[0]');
      });

      it('accepts any string values', async () => {
        const app = makeApp();
        const res = await request(app)
          .post('/register')
          .set('Content-Type', 'application/json')
          .send({ response_types: ['code', 'token'] });

        expect(res.status).toBe(201);
        expect(res.body.response_types).toEqual(['code', 'token']);
      });
    });

    it('empty body still returns 201', async () => {
      const app = makeApp();
      const res = await request(app)
        .post('/register')
        .set('Content-Type', 'application/json')
        .send({});

      expect(res.status).toBe(201);
      expect(res.body.client_id).toBe('fixed-test-client');
    });
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
