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
};

function makeApp() {
  return createApp({
    config: CONFIG,
    upstreamDoc: MOCK_UPSTREAM_DOC,
  }).app;
}

describe('Health probes', () => {
  it('GET /health/live returns 200', async () => {
    const res = await request(makeApp()).get('/health/live');
    expect(res.status).toBe(200);
  });

  it('GET /health/ready returns 200', async () => {
    const res = await request(makeApp()).get('/health/ready');
    expect(res.status).toBe(200);
  });
});
