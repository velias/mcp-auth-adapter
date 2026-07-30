import request from 'supertest';
import { createApp } from '../src/app';
import { AppConfig, ParsedClientNameEntry, buildClientIdRedirectMap } from '../src/config';

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
  accessLog: false,
  cimdMap: {},
  cimdCacheMinutes: 30,
  cimdEnabled: false,
  metricsEnabled: false,
  dpopEnabled: false,
  shutdownTimeoutSeconds: 30,
  authStateTtlSeconds: 1800,
  allowedRedirectUris: [],
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

// ---------------------------------------------------------------------------
// Client name mapping
// ---------------------------------------------------------------------------
describe('POST /register (client name mapping)', () => {
  const CURSOR_ENTRY: ParsedClientNameEntry = {
    originalPattern: 'Cursor',
    normalizedPattern: 'cursor',
    isPrefix: false,
    clientId: 'cursor-sso-client',
  };

  const CLAUDE_ENTRY: ParsedClientNameEntry = {
    originalPattern: 'Claude Code*',
    normalizedPattern: 'claude code',
    isPrefix: true,
    clientId: 'claude-sso-client',
  };

  const NAME_MAP = [CURSOR_ENTRY, CLAUDE_ENTRY];

  function makeAppWithMap(overrides: Partial<AppConfig> = {}) {
    return createApp({
      config: {
        ...CONFIG,
        clientId: 'default-client',
        dcrClientNameMap: NAME_MAP,
        dcrClientIdRedirectMap: buildClientIdRedirectMap(NAME_MAP),
        ...overrides,
      },
      upstreamDoc: MOCK_UPSTREAM_DOC,
    }).app;
  }

  it('exact match returns mapped client_id', async () => {
    const app = makeAppWithMap();
    const res = await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({ client_name: 'Cursor' });

    expect(res.status).toBe(201);
    expect(res.body.client_id).toBe('cursor-sso-client');
  });

  it('prefix match with parenthesized suffix returns mapped client_id', async () => {
    const app = makeAppWithMap();
    const res = await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({ client_name: 'Claude Code (rh-product-mcp)' });

    expect(res.status).toBe(201);
    expect(res.body.client_id).toBe('claude-sso-client');
  });

  it('case-insensitive matching', async () => {
    const app = makeAppWithMap();
    const res = await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({ client_name: 'CURSOR' });

    expect(res.status).toBe(201);
    expect(res.body.client_id).toBe('cursor-sso-client');
  });

  it('exact match takes priority over prefix match', async () => {
    const exactAndPrefix: ParsedClientNameEntry[] = [
      { originalPattern: 'Claude Code*', normalizedPattern: 'claude code', isPrefix: true, clientId: 'prefix-client' },
      { originalPattern: 'Claude Code', normalizedPattern: 'claude code', isPrefix: false, clientId: 'exact-client' },
    ];
    const app = createApp({
      config: {
        ...CONFIG,
        clientId: 'default-client',
        dcrClientNameMap: exactAndPrefix,
        dcrClientIdRedirectMap: buildClientIdRedirectMap(exactAndPrefix),
      },
      upstreamDoc: MOCK_UPSTREAM_DOC,
    }).app;

    const res = await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({ client_name: 'Claude Code' });

    expect(res.status).toBe(201);
    expect(res.body.client_id).toBe('exact-client');
  });

  it('unmatched client_name falls back to default', async () => {
    const app = makeAppWithMap();
    const res = await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({ client_name: 'Unknown App' });

    expect(res.status).toBe(201);
    expect(res.body.client_id).toBe('default-client');
  });

  it('unmatched client_name without default returns 400', async () => {
    const app = makeAppWithMap({ clientId: '' });
    const res = await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({ client_name: 'Unknown App' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client_metadata');
    expect(res.body.error_description).toContain('client_name');
  });

  it('missing client_name falls back to default', async () => {
    const app = makeAppWithMap();
    const res = await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({});

    expect(res.status).toBe(201);
    expect(res.body.client_id).toBe('default-client');
  });

  it('missing client_name without default returns 400', async () => {
    const app = makeAppWithMap({ clientId: '' });
    const res = await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client_metadata');
  });

  it('whitespace-only client_name treated as missing', async () => {
    const app = makeAppWithMap({ clientId: '' });
    const res = await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({ client_name: '   ' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client_metadata');
  });

  it('redirect_uris in DCR body are NOT validated against per-client patterns', async () => {
    const entriesWithPatterns: ParsedClientNameEntry[] = [{
      originalPattern: 'Cursor',
      normalizedPattern: 'cursor',
      isPrefix: false,
      clientId: 'cursor-sso-client',
      allowedRedirectUris: ['cursor://anysphere.cursor-mcp/*'],
    }];
    const app = createApp({
      config: {
        ...CONFIG,
        clientId: 'default-client',
        dcrClientNameMap: entriesWithPatterns,
        dcrClientIdRedirectMap: buildClientIdRedirectMap(entriesWithPatterns),
      },
      upstreamDoc: MOCK_UPSTREAM_DOC,
    }).app;

    const res = await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({
        client_name: 'Cursor',
        redirect_uris: ['http://localhost:8080/callback'],
      });

    expect(res.status).toBe(201);
    expect(res.body.client_id).toBe('cursor-sso-client');
  });

  it('auto-enable: map-only config → endpoint active', async () => {
    const app = createApp({
      config: {
        ...CONFIG,
        clientId: '',
        proxyDcrEndpoint: true,
        dcrClientNameMap: NAME_MAP,
        dcrClientIdRedirectMap: buildClientIdRedirectMap(NAME_MAP),
      },
      upstreamDoc: MOCK_UPSTREAM_DOC,
    }).app;

    const resMatched = await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({ client_name: 'Cursor' });
    expect(resMatched.status).toBe(201);

    const resUnmatched = await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({ client_name: 'Unknown' });
    expect(resUnmatched.status).toBe(400);
  });

  it('backwards compatibility: neither map nor default → 404', async () => {
    const app = createApp({
      config: {
        ...CONFIG,
        clientId: '',
        proxyDcrEndpoint: false,
        dcrClientNameMap: [],
        dcrClientIdRedirectMap: new Map(),
      },
      upstreamDoc: MOCK_UPSTREAM_DOC,
    }).app;

    const res = await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({ client_name: 'Cursor' });

    expect(res.status).toBe(404);
  });

  describe('mcp_auth_dcr_registrations_total metric', () => {
    it('incremented with correct idp_client and match_type on success', async () => {
      const { app } = createApp({
        config: {
          ...CONFIG,
          clientId: 'default-client',
          metricsEnabled: true,
          dcrClientNameMap: NAME_MAP,
          dcrClientIdRedirectMap: buildClientIdRedirectMap(NAME_MAP),
        },
        upstreamDoc: MOCK_UPSTREAM_DOC,
      });

      await request(app)
        .post('/register')
        .set('Content-Type', 'application/json')
        .send({ client_name: 'Cursor' });

      await request(app)
        .post('/register')
        .set('Content-Type', 'application/json')
        .send({ client_name: 'Claude Code (test)' });

      await request(app)
        .post('/register')
        .set('Content-Type', 'application/json')
        .send({ client_name: 'Unknown App' });

      const metricsRes = await request(app).get('/metrics');
      expect(metricsRes.text).toContain('mcp_auth_dcr_registrations_total{idp_client="cursor-sso-client",match_type="exact"} 1');
      expect(metricsRes.text).toContain('mcp_auth_dcr_registrations_total{idp_client="claude-sso-client",match_type="prefix"} 1');
      expect(metricsRes.text).toContain('mcp_auth_dcr_registrations_total{idp_client="default-client",match_type="default"} 1');
    });
  });
});

// ---------------------------------------------------------------------------
// Access log content tests
// ---------------------------------------------------------------------------
describe('POST /register (access log content)', () => {
  const CURSOR_ENTRY: ParsedClientNameEntry = {
    originalPattern: 'Cursor',
    normalizedPattern: 'cursor',
    isPrefix: false,
    clientId: 'cursor-client',
  };

  const CLAUDE_ENTRY: ParsedClientNameEntry = {
    originalPattern: 'Claude Code*',
    normalizedPattern: 'claude code',
    isPrefix: true,
    clientId: 'claude-client',
  };

  const NAME_MAP = [CURSOR_ENTRY, CLAUDE_ENTRY];

  function makeAppWithAccessLog(overrides: Partial<AppConfig> = {}) {
    return createApp({
      config: {
        ...CONFIG,
        accessLog: true,
        clientId: 'default-client',
        dcrClientNameMap: NAME_MAP,
        dcrClientIdRedirectMap: buildClientIdRedirectMap(NAME_MAP),
        ...overrides,
      },
      upstreamDoc: MOCK_UPSTREAM_DOC,
    }).app;
  }

  let logLines: string[];

  beforeEach(() => {
    logLines = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logLines.push(String(args[0]));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function findLogLine(substring: string): string | undefined {
    return logLines.find(l => l.includes(substring));
  }

  it('includes idpClient and matchedMapping for exact match', async () => {
    const app = makeAppWithAccessLog();
    await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({ client_name: 'Cursor' });

    const line = findLogLine('DCR register request');
    expect(line).toBeDefined();
    expect(line).toContain('idpClient="cursor-client"');
    expect(line).toContain('matchedMapping="exact:Cursor"');
  });

  it('includes idpClient and matchedMapping for prefix match', async () => {
    const app = makeAppWithAccessLog();
    await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({ client_name: 'Claude Code (rh-product-mcp)' });

    const line = findLogLine('DCR register request');
    expect(line).toBeDefined();
    expect(line).toContain('idpClient="claude-client"');
    expect(line).toContain('matchedMapping="prefix:Claude Code*"');
  });

  it('includes idpClient for fallback, matchedMapping absent', async () => {
    const app = makeAppWithAccessLog();
    await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({ client_name: 'Unknown App' });

    const line = findLogLine('DCR register request');
    expect(line).toBeDefined();
    expect(line).toContain('idpClient="default-client"');
    expect(line).not.toContain('matchedMapping=');
  });

  it('omits matchedMapping when no client_name provided', async () => {
    const app = makeAppWithAccessLog();
    await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({});

    const line = findLogLine('DCR register request');
    expect(line).toBeDefined();
    expect(line).toContain('idpClient="default-client"');
    expect(line).not.toContain('matchedMapping=');
  });

  it('truncates clientName to 200 characters for long values', async () => {
    const app = makeAppWithAccessLog();
    const longName = 'A'.repeat(300);
    await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({ client_name: longName });

    const line = findLogLine('DCR register request');
    expect(line).toBeDefined();
    expect(line).toContain(`clientName="${'A'.repeat(200)}"`);
    expect(line).not.toContain('A'.repeat(201));
  });

  it('still includes existing fields alongside new fields', async () => {
    const app = makeAppWithAccessLog();
    await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({
        client_name: 'Cursor',
        software_id: 'cursor-ide',
        redirect_uris: ['http://localhost:8080/cb'],
      });

    const line = findLogLine('DCR register request');
    expect(line).toBeDefined();
    expect(line).toContain('clientName="Cursor"');
    expect(line).toContain('softwareId="cursor-ide"');
    expect(line).toContain('redirectUriCount="1"');
    expect(line).toContain('idpClient="cursor-client"');
  });
});
