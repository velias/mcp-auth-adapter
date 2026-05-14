import request from 'supertest';
import { createApp } from '../src/app';
import { AppConfig } from '../src/config';
import { buildDefaultUpstreamDoc, validateUpstreamDoc } from '../src/routes/well-known';

const MOCK_UPSTREAM_DOC: Record<string, unknown> = {
  issuer: 'https://sso.example.com/auth/realms/test',
  authorization_endpoint: 'https://sso.example.com/auth/realms/test/protocol/openid-connect/auth',
  token_endpoint: 'https://sso.example.com/auth/realms/test/protocol/openid-connect/token',
  jwks_uri: 'https://sso.example.com/auth/realms/test/protocol/openid-connect/certs',
  registration_endpoint: 'https://sso.example.com/auth/realms/test/clients-registrations/openid-connect',
  scopes_supported: ['openid', 'profile', 'email', 'offline_access'],
  response_types_supported: ['code', 'id_token'],
  response_modes_supported: ['query', 'fragment'],
  grant_types_supported: ['authorization_code', 'refresh_token'],
  token_endpoint_auth_methods_supported: ['client_secret_basic', 'none'],
  token_endpoint_auth_signing_alg_values_supported: ['RS256'],
  code_challenge_methods_supported: ['plain', 'S256'],
  id_token_signing_alg_values_supported: ['RS256'],
  subject_types_supported: ['public'],
  claims_supported: ['sub', 'iss', 'name', 'email'],
  introspection_endpoint: 'https://sso.example.com/auth/realms/test/protocol/openid-connect/token/introspect',
  userinfo_endpoint: 'https://sso.example.com/auth/realms/test/protocol/openid-connect/userinfo',
  revocation_endpoint: 'https://sso.example.com/auth/realms/test/protocol/openid-connect/revoke',
  authorization_response_iss_parameter_supported: true,
  // Fields that must be excluded:
  end_session_endpoint: 'https://sso.example.com/auth/realms/test/protocol/openid-connect/logout',
  check_session_iframe: 'https://sso.example.com/auth/realms/test/protocol/openid-connect/login-status-iframe.html',
  frontchannel_logout_supported: true,
  backchannel_logout_supported: true,
  device_authorization_endpoint: 'https://sso.example.com/auth/realms/test/protocol/openid-connect/auth/device',
  pushed_authorization_request_endpoint: 'https://sso.example.com/auth/realms/test/protocol/openid-connect/ext/par/request',
  mtls_endpoint_aliases: { token_endpoint: 'https://sso.example.com/mtls/token' },
  tls_client_certificate_bound_access_tokens: true,
};

function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    baseUrl: 'http://localhost:3000',
    port: 3000,
    upstreamSsoUrl: 'https://sso.example.com/auth/realms/test',
    clientId: 'test-client-id',
    scopesSupported: ['openid', 'profile'],
    proxyAuthEndpoint: true,
    proxyDcrEndpoint: true,
    wellKnownRefreshMinutes: 60,
    debug: false,
    cimdMap: {},
    cimdCacheMinutes: 30,
    cimdEnabled: false,
    shutdownTimeoutSeconds: 30,
    ...overrides,
  };
}

function makeApp(config: AppConfig, upstreamDoc: Record<string, unknown> = MOCK_UPSTREAM_DOC) {
  return createApp({ config, upstreamDoc }).app;
}

describe('Well-Known Discovery Endpoints', () => {
  describe('GET /.well-known/openid-configuration', () => {
    it('returns the merged descriptor', async () => {
      const app = makeApp(makeConfig());

      const res = await request(app).get('/.well-known/openid-configuration');

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      expect(res.body.issuer).toBe('http://localhost:3000');
      expect(res.body.token_endpoint).toBe(MOCK_UPSTREAM_DOC.token_endpoint);
      expect(res.body.jwks_uri).toBe(MOCK_UPSTREAM_DOC.jwks_uri);
      expect(res.body.code_challenge_methods_supported).toEqual(['plain', 'S256']);
    });

    it('overrides registration_endpoint with own URL', async () => {
      const app = makeApp(makeConfig());

      const res = await request(app).get('/.well-known/openid-configuration');

      expect(res.body.registration_endpoint).toBe('http://localhost:3000/register');
    });

    it('overrides authorization_endpoint when proxyAuthEndpoint is true', async () => {
      const app = makeApp(makeConfig({ proxyAuthEndpoint: true }));

      const res = await request(app).get('/.well-known/openid-configuration');

      expect(res.body.authorization_endpoint).toBe('http://localhost:3000/authorize');
    });

    it('overrides registration_endpoint when proxyDcrEndpoint is true', async () => {
      const app = makeApp(makeConfig({ proxyDcrEndpoint: true }));

      const res = await request(app).get('/.well-known/openid-configuration');

      expect(res.body.registration_endpoint).toBe('http://localhost:3000/register');
    });

    it('ensures token_endpoint_auth_methods_supported includes none when proxyDcrEndpoint is true', async () => {
      const upstreamWithoutNone = {
        ...MOCK_UPSTREAM_DOC,
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      };
      const config = makeConfig({ proxyDcrEndpoint: true });
      const app = createApp({ config, upstreamDoc: upstreamWithoutNone }).app;

      const res = await request(app).get('/.well-known/openid-configuration');

      expect(res.body.token_endpoint_auth_methods_supported).toContain('none');
    });

    it('does not duplicate none if upstream already includes it', async () => {
      const app = makeApp(makeConfig({ proxyDcrEndpoint: true }));

      const res = await request(app).get('/.well-known/openid-configuration');

      const methods = res.body.token_endpoint_auth_methods_supported as string[];
      expect(methods.filter((m: string) => m === 'none')).toHaveLength(1);
    });

    it('keeps upstream registration_endpoint when proxyDcrEndpoint is false', async () => {
      const app = makeApp(makeConfig({ proxyDcrEndpoint: false }));

      const res = await request(app).get('/.well-known/openid-configuration');

      expect(res.body.registration_endpoint).toBe(MOCK_UPSTREAM_DOC.registration_endpoint);
    });

    it('keeps upstream authorization_endpoint when proxyAuthEndpoint is false', async () => {
      const app = makeApp(makeConfig({ proxyAuthEndpoint: false }));

      const res = await request(app).get('/.well-known/openid-configuration');

      expect(res.body.authorization_endpoint).toBe(MOCK_UPSTREAM_DOC.authorization_endpoint);
    });

    it('uses scopes_supported from config', async () => {
      const app = makeApp(makeConfig({ scopesSupported: ['openid', 'custom_scope'] }));

      const res = await request(app).get('/.well-known/openid-configuration');

      expect(res.body.scopes_supported).toEqual(['openid', 'custom_scope']);
    });

    it('omits scopes_supported when config array is empty', async () => {
      const app = makeApp(makeConfig({ scopesSupported: [] }));

      const res = await request(app).get('/.well-known/openid-configuration');

      expect(res.body.scopes_supported).toBeUndefined();
    });

    it('omits scopes_supported when not configured', async () => {
      const app = makeApp(makeConfig({ scopesSupported: undefined }));

      const res = await request(app).get('/.well-known/openid-configuration');

      expect(res.body.scopes_supported).toBeUndefined();
    });

    it('sets issuer to baseUrl regardless of upstream value', async () => {
      const app = makeApp(makeConfig({ baseUrl: 'https://proxy.example.com' }));

      const res = await request(app).get('/.well-known/openid-configuration');

      expect(res.body.issuer).toBe('https://proxy.example.com');
    });

    it('omits authorization_response_iss_parameter_supported when proxyAuthEndpoint is true', async () => {
      const app = makeApp(makeConfig({ proxyAuthEndpoint: true }));

      const res = await request(app).get('/.well-known/openid-configuration');

      expect(res.body.authorization_response_iss_parameter_supported).toBeUndefined();
    });

    it('preserves authorization_response_iss_parameter_supported when proxyAuthEndpoint is false', async () => {
      const app = makeApp(makeConfig({ proxyAuthEndpoint: false }));

      const res = await request(app).get('/.well-known/openid-configuration');

      expect(res.body.authorization_response_iss_parameter_supported).toBe(true);
    });

    it('excludes fields not in the whitelist', async () => {
      const app = makeApp(makeConfig());

      const res = await request(app).get('/.well-known/openid-configuration');

      expect(res.body.end_session_endpoint).toBeUndefined();
      expect(res.body.check_session_iframe).toBeUndefined();
      expect(res.body.frontchannel_logout_supported).toBeUndefined();
      expect(res.body.backchannel_logout_supported).toBeUndefined();
      expect(res.body.device_authorization_endpoint).toBeUndefined();
      expect(res.body.pushed_authorization_request_endpoint).toBeUndefined();
      expect(res.body.mtls_endpoint_aliases).toBeUndefined();
      expect(res.body.tls_client_certificate_bound_access_tokens).toBeUndefined();
    });
  });

  describe('GET /.well-known/oauth-authorization-server', () => {
    it('returns the same document as openid-configuration', async () => {
      const app = makeApp(makeConfig());

      const oidc = await request(app).get('/.well-known/openid-configuration');
      const oauth = await request(app).get('/.well-known/oauth-authorization-server');

      expect(oauth.status).toBe(200);
      expect(oauth.body).toEqual(oidc.body);
    });
  });

  describe('Cache-Control header', () => {
    it('sets max-age to half the configured refresh interval', async () => {
      const app = makeApp(makeConfig({ wellKnownRefreshMinutes: 60 }));

      const res = await request(app).get('/.well-known/openid-configuration');

      expect(res.headers['cache-control']).toBe('public, max-age=1800');
    });

    it('uses default refresh interval when not configured', async () => {
      const app = makeApp(makeConfig());

      const res = await request(app).get('/.well-known/oauth-authorization-server');

      expect(res.headers['cache-control']).toBe('public, max-age=1800');
    });

    it('adjusts max-age for custom refresh interval', async () => {
      const app = makeApp(makeConfig({ wellKnownRefreshMinutes: 10 }));

      const res = await request(app).get('/.well-known/openid-configuration');

      expect(res.headers['cache-control']).toBe('public, max-age=300');
    });
  });

  describe('Upstream document refresh', () => {
    it('updateUpstream swaps the well-known document', async () => {
      const config = makeConfig();
      const { app, updateUpstream } = createApp({ config, upstreamDoc: MOCK_UPSTREAM_DOC });

      const before = await request(app).get('/.well-known/openid-configuration');
      expect(before.body.token_endpoint).toBe(MOCK_UPSTREAM_DOC.token_endpoint);

      const updatedDoc = {
        ...MOCK_UPSTREAM_DOC,
        token_endpoint: 'https://new-sso.example.com/token',
      };
      updateUpstream(updatedDoc);

      const after = await request(app).get('/.well-known/openid-configuration');
      expect(after.body.token_endpoint).toBe('https://new-sso.example.com/token');
    });
  });

  describe('Flow-level defaults', () => {
    const MINIMAL_UPSTREAM: Record<string, unknown> = {
      issuer: 'https://sso.example.com/auth/realms/test',
      authorization_endpoint: 'https://sso.example.com/auth/realms/test/protocol/openid-connect/auth',
      token_endpoint: 'https://sso.example.com/auth/realms/test/protocol/openid-connect/token',
    };

    it('injects response_types_supported when upstream omits it', async () => {
      const app = makeApp(makeConfig(), MINIMAL_UPSTREAM);

      const res = await request(app).get('/.well-known/openid-configuration');

      expect(res.body.response_types_supported).toEqual(['code']);
    });

    it('injects grant_types_supported when upstream omits it', async () => {
      const app = makeApp(makeConfig(), MINIMAL_UPSTREAM);

      const res = await request(app).get('/.well-known/openid-configuration');

      expect(res.body.grant_types_supported).toEqual(['authorization_code']);
    });

    it('injects code_challenge_methods_supported when upstream omits it', async () => {
      const app = makeApp(makeConfig(), MINIMAL_UPSTREAM);

      const res = await request(app).get('/.well-known/openid-configuration');

      expect(res.body.code_challenge_methods_supported).toEqual(['S256']);
    });

    it('does not override existing upstream values', async () => {
      const upstreamWithValues = {
        ...MINIMAL_UPSTREAM,
        response_types_supported: ['code', 'id_token'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['plain', 'S256'],
      };
      const app = makeApp(makeConfig(), upstreamWithValues);

      const res = await request(app).get('/.well-known/openid-configuration');

      expect(res.body.response_types_supported).toEqual(['code', 'id_token']);
      expect(res.body.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
      expect(res.body.code_challenge_methods_supported).toEqual(['plain', 'S256']);
    });

    it('does not inject defaults when authorization_endpoint is missing', async () => {
      const noAuthEndpoint: Record<string, unknown> = {
        issuer: 'https://sso.example.com/auth/realms/test',
        token_endpoint: 'https://sso.example.com/auth/realms/test/protocol/openid-connect/token',
      };
      const app = makeApp(makeConfig({ proxyAuthEndpoint: false }), noAuthEndpoint);

      const res = await request(app).get('/.well-known/openid-configuration');

      expect(res.body.response_types_supported).toBeUndefined();
      expect(res.body.grant_types_supported).toBeUndefined();
      expect(res.body.code_challenge_methods_supported).toBeUndefined();
    });

    it('does not inject defaults when token_endpoint is missing', async () => {
      const noTokenEndpoint: Record<string, unknown> = {
        issuer: 'https://sso.example.com/auth/realms/test',
        authorization_endpoint: 'https://sso.example.com/auth/realms/test/protocol/openid-connect/auth',
      };
      const app = makeApp(makeConfig(), noTokenEndpoint);

      const res = await request(app).get('/.well-known/openid-configuration');

      expect(res.body.response_types_supported).toBeUndefined();
      expect(res.body.grant_types_supported).toBeUndefined();
      expect(res.body.code_challenge_methods_supported).toBeUndefined();
    });
  });

  describe('Default upstream document fallback', () => {
    it('constructs endpoints from issuer URL', () => {
      const defaults = buildDefaultUpstreamDoc('https://sso.example.com/auth/realms/test');

      expect(defaults.issuer).toBe('https://sso.example.com/auth/realms/test');
      expect(defaults.authorization_endpoint).toBe('https://sso.example.com/auth/realms/test/protocol/openid-connect/auth');
      expect(defaults.token_endpoint).toBe('https://sso.example.com/auth/realms/test/protocol/openid-connect/token');
      expect(defaults.jwks_uri).toBe('https://sso.example.com/auth/realms/test/protocol/openid-connect/certs');
      expect(defaults.introspection_endpoint).toBe('https://sso.example.com/auth/realms/test/protocol/openid-connect/token/introspect');
      expect(defaults.userinfo_endpoint).toBe('https://sso.example.com/auth/realms/test/protocol/openid-connect/userinfo');
      expect(defaults.revocation_endpoint).toBe('https://sso.example.com/auth/realms/test/protocol/openid-connect/revoke');
    });

    it('includes code_challenge_methods_supported with S256', () => {
      const defaults = buildDefaultUpstreamDoc('https://sso.example.com/auth/realms/test');

      expect(defaults.code_challenge_methods_supported).toEqual(['S256']);
    });

    it('produces a working well-known document when used as upstream', async () => {
      const defaults = buildDefaultUpstreamDoc('https://sso.example.com/auth/realms/test');
      const app = makeApp(makeConfig(), defaults);

      const res = await request(app).get('/.well-known/openid-configuration');

      expect(res.status).toBe(200);
      expect(res.body.issuer).toBe('http://localhost:3000');
      expect(res.body.registration_endpoint).toBe('http://localhost:3000/register');
      expect(res.body.code_challenge_methods_supported).toEqual(['S256']);
      expect(res.body.token_endpoint).toContain('/protocol/openid-connect/token');
    });
  });
});

describe('validateUpstreamDoc', () => {
  const COMPLETE_DOC: Record<string, unknown> = {
    authorization_endpoint: 'https://sso.example.com/auth',
    token_endpoint: 'https://sso.example.com/token',
    code_challenge_methods_supported: ['S256'],
  };

  it('returns empty array when all required fields are present', () => {
    expect(validateUpstreamDoc(COMPLETE_DOC)).toEqual([]);
  });

  it('warns when authorization_endpoint is missing', () => {
    const doc = { ...COMPLETE_DOC };
    delete doc.authorization_endpoint;

    const warnings = validateUpstreamDoc(doc);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('authorization_endpoint');
  });

  it('warns when token_endpoint is missing', () => {
    const doc = { ...COMPLETE_DOC };
    delete doc.token_endpoint;

    const warnings = validateUpstreamDoc(doc);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('token_endpoint');
  });

  it('warns when code_challenge_methods_supported is missing', () => {
    const doc = { ...COMPLETE_DOC };
    delete doc.code_challenge_methods_supported;

    const warnings = validateUpstreamDoc(doc);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('code_challenge_methods_supported');
    expect(warnings[0]).toContain('advertise ["S256"]');
  });

  it('warns when code_challenge_methods_supported is present but does not include S256', () => {
    const doc = { ...COMPLETE_DOC, code_challenge_methods_supported: ['plain'] };

    const warnings = validateUpstreamDoc(doc);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('without S256');
  });
});

describe('CIMD well-known modifications', () => {
  it('adds client_id_metadata_document_supported when CIMD enabled', async () => {
    const config = makeConfig({
      cimdEnabled: true,
      cimdMap: { 'https://cursor.com/oauth.json': 'cursor-client' },
    });
    const app = makeApp(config);

    const res = await request(app).get('/.well-known/oauth-authorization-server');
    expect(res.body.client_id_metadata_document_supported).toBe(true);
  });

  it('rewrites token_endpoint to proxy URL when CIMD enabled', async () => {
    const config = makeConfig({
      cimdEnabled: true,
      cimdMap: { 'https://cursor.com/oauth.json': 'cursor-client' },
    });
    const app = makeApp(config);

    const res = await request(app).get('/.well-known/oauth-authorization-server');
    expect(res.body.token_endpoint).toBe('http://localhost:3000/token');
  });

  it('ensures token_endpoint_auth_methods_supported includes none when CIMD enabled', async () => {
    const config = makeConfig({
      cimdEnabled: true,
      cimdMap: { 'https://cursor.com/oauth.json': 'cursor-client' },
      proxyDcrEndpoint: false,
    });
    const app = makeApp(config);

    const res = await request(app).get('/.well-known/oauth-authorization-server');
    expect(res.body.token_endpoint_auth_methods_supported).toContain('none');
  });

  it('does not modify well-known when CIMD disabled', async () => {
    const config = makeConfig({ cimdEnabled: false, cimdMap: {} });
    const app = makeApp(config);

    const res = await request(app).get('/.well-known/oauth-authorization-server');
    expect(res.body.client_id_metadata_document_supported).toBeUndefined();
    expect(res.body.token_endpoint).toBe(
      'https://sso.example.com/auth/realms/test/protocol/openid-connect/token',
    );
  });
});
