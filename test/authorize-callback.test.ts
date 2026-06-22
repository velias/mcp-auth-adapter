import request from 'supertest';
import express from 'express';
import { createAuthorizeCallbackRouter } from '../src/routes/authorize-callback';
import { signState } from '../src/state-signer';
import { createLogger } from '../src/logger';

const SECRET = Buffer.from('a'.repeat(64), 'hex');
const SECRET_PREV = Buffer.from('b'.repeat(64), 'hex');
const BASE_URL = 'http://localhost:3000';
const UPSTREAM_ISSUER = 'https://sso.example.com/auth/realms/test';

function createTestApp(options: {
  upstreamSupportsIss?: boolean;
  upstreamIssuer?: string;
  secrets?: Buffer[];
} = {}) {
  const {
    upstreamSupportsIss = false,
    upstreamIssuer = UPSTREAM_ISSUER,
    secrets = [SECRET],
  } = options;

  const app = express();
  app.use(createAuthorizeCallbackRouter({
    baseUrl: BASE_URL,
    getSecrets: () => secrets,
    getUpstreamIssuer: () => upstreamIssuer,
    getUpstreamSupportsIss: () => upstreamSupportsIss,
    rejectedTotal: { inc() {} },
  }, createLogger(false)));
  return app;
}

function makeValidBlob(overrides: { redirectUri?: string; state?: string | null; ttl?: number; secret?: Buffer } = {}) {
  const { redirectUri = 'http://localhost:8080/callback', state = 'client-state', ttl = 300, secret = SECRET } = overrides;
  return signState({ redirectUri, state }, secret, ttl);
}

describe('GET /authorize/callback', () => {
  describe('happy path', () => {
    it('redirects to client with code, restored state, and adapter iss', async () => {
      const app = createTestApp();
      const blob = makeValidBlob();

      const res = await request(app)
        .get('/authorize/callback')
        .query({ code: 'AUTH_CODE', state: blob, iss: UPSTREAM_ISSUER });

      expect(res.status).toBe(302);
      const location = new URL(res.headers.location);
      expect(location.origin + location.pathname).toBe('http://localhost:8080/callback');
      expect(location.searchParams.get('code')).toBe('AUTH_CODE');
      expect(location.searchParams.get('state')).toBe('client-state');
      expect(location.searchParams.get('iss')).toBe(BASE_URL);
    });

    it('sets Cache-Control and Referrer-Policy headers', async () => {
      const app = createTestApp();
      const blob = makeValidBlob();

      const res = await request(app)
        .get('/authorize/callback')
        .query({ code: 'CODE', state: blob });

      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['referrer-policy']).toBe('no-referrer');
    });

    it('handles null state (client did not send state)', async () => {
      const app = createTestApp();
      const blob = makeValidBlob({ state: null });

      const res = await request(app)
        .get('/authorize/callback')
        .query({ code: 'CODE', state: blob });

      expect(res.status).toBe(302);
      const location = new URL(res.headers.location);
      expect(location.searchParams.has('state')).toBe(false);
      expect(location.searchParams.get('code')).toBe('CODE');
      expect(location.searchParams.get('iss')).toBe(BASE_URL);
    });
  });

  describe('state verification failures', () => {
    it('returns 400 when state parameter is missing', async () => {
      const app = createTestApp();

      const res = await request(app)
        .get('/authorize/callback')
        .query({ code: 'CODE' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('invalid_request');
      expect(res.body.error_description).toContain('state');
    });

    it('returns 400 when state is tampered', async () => {
      const app = createTestApp();

      const res = await request(app)
        .get('/authorize/callback')
        .query({ code: 'CODE', state: 'tampered.blob' });

      expect(res.status).toBe(400);
      expect(res.body.error_description).toContain('State verification failed');
    });

    it('returns 400 when state is expired', async () => {
      const app = createTestApp();
      const blob = makeValidBlob({ ttl: -1 });

      const res = await request(app)
        .get('/authorize/callback')
        .query({ code: 'CODE', state: blob });

      expect(res.status).toBe(400);
      expect(res.body.error_description).toContain('State verification failed');
    });
  });

  describe('two-tier upstream iss validation', () => {
    it('accepts when upstream supports RFC 9207 and iss is present and correct', async () => {
      const app = createTestApp({ upstreamSupportsIss: true });
      const blob = makeValidBlob();

      const res = await request(app)
        .get('/authorize/callback')
        .query({ code: 'CODE', state: blob, iss: UPSTREAM_ISSUER });

      expect(res.status).toBe(302);
    });

    it('rejects when upstream supports RFC 9207 and iss is present but wrong', async () => {
      const app = createTestApp({ upstreamSupportsIss: true });
      const blob = makeValidBlob();

      const res = await request(app)
        .get('/authorize/callback')
        .query({ code: 'CODE', state: blob, iss: 'https://evil.com' });

      expect(res.status).toBe(400);
      expect(res.body.error_description).toContain('iss');
    });

    it('rejects when upstream supports RFC 9207 and iss is missing (downgrade attack)', async () => {
      const app = createTestApp({ upstreamSupportsIss: true });
      const blob = makeValidBlob();

      const res = await request(app)
        .get('/authorize/callback')
        .query({ code: 'CODE', state: blob });

      expect(res.status).toBe(400);
      expect(res.body.error_description).toContain('iss');
    });

    it('accepts when upstream does not support RFC 9207 and iss is absent', async () => {
      const app = createTestApp({ upstreamSupportsIss: false });
      const blob = makeValidBlob();

      const res = await request(app)
        .get('/authorize/callback')
        .query({ code: 'CODE', state: blob });

      expect(res.status).toBe(302);
    });

    it('accepts when upstream does not support RFC 9207 and iss is present and correct', async () => {
      const app = createTestApp({ upstreamSupportsIss: false });
      const blob = makeValidBlob();

      const res = await request(app)
        .get('/authorize/callback')
        .query({ code: 'CODE', state: blob, iss: UPSTREAM_ISSUER });

      expect(res.status).toBe(302);
    });

    it('rejects when upstream does not support RFC 9207 but iss is present and wrong', async () => {
      const app = createTestApp({ upstreamSupportsIss: false });
      const blob = makeValidBlob();

      const res = await request(app)
        .get('/authorize/callback')
        .query({ code: 'CODE', state: blob, iss: 'https://evil.com' });

      expect(res.status).toBe(400);
      expect(res.body.error_description).toContain('iss');
    });
  });

  describe('error response forwarding', () => {
    it('forwards error to client redirect_uri with restored state', async () => {
      const app = createTestApp();
      const blob = makeValidBlob();

      const res = await request(app)
        .get('/authorize/callback')
        .query({ error: 'access_denied', error_description: 'User denied consent', state: blob });

      expect(res.status).toBe(302);
      const location = new URL(res.headers.location);
      expect(location.origin + location.pathname).toBe('http://localhost:8080/callback');
      expect(location.searchParams.get('error')).toBe('access_denied');
      expect(location.searchParams.get('error_description')).toBe('User denied consent');
      expect(location.searchParams.get('state')).toBe('client-state');
      expect(location.searchParams.has('iss')).toBe(false);
    });

    it('forwards error without error_description', async () => {
      const app = createTestApp();
      const blob = makeValidBlob();

      const res = await request(app)
        .get('/authorize/callback')
        .query({ error: 'server_error', state: blob });

      expect(res.status).toBe(302);
      const location = new URL(res.headers.location);
      expect(location.searchParams.get('error')).toBe('server_error');
      expect(location.searchParams.has('error_description')).toBe(false);
      expect(location.searchParams.get('state')).toBe('client-state');
    });
  });

  describe('parameter whitelist', () => {
    it('drops unknown query params from upstream', async () => {
      const app = createTestApp();
      const blob = makeValidBlob();

      const res = await request(app)
        .get('/authorize/callback')
        .query({ code: 'CODE', state: blob, extra_param: 'injected', session_state: 'xyz' });

      expect(res.status).toBe(302);
      const location = new URL(res.headers.location);
      expect(location.searchParams.has('extra_param')).toBe(false);
      expect(location.searchParams.has('session_state')).toBe(false);
      expect(location.searchParams.get('code')).toBe('CODE');
    });
  });

  describe('malformed callback', () => {
    it('returns 400 when neither code nor error is present', async () => {
      const app = createTestApp();
      const blob = makeValidBlob();

      const res = await request(app)
        .get('/authorize/callback')
        .query({ state: blob });

      expect(res.status).toBe(400);
      expect(res.body.error_description).toContain('code');
    });
  });

  describe('rejection counter', () => {
    it('increments rejectedTotal with state_missing reason', async () => {
      const incSpy = vi.fn();
      const app = express();
      app.use(createAuthorizeCallbackRouter({
        baseUrl: BASE_URL,
        getSecrets: () => [SECRET],
        getUpstreamIssuer: () => UPSTREAM_ISSUER,
        getUpstreamSupportsIss: () => false,
        rejectedTotal: { inc: incSpy },
      }, createLogger(false)));

      await request(app)
        .get('/authorize/callback')
        .query({ code: 'CODE' });

      expect(incSpy).toHaveBeenCalledWith({
        route: '/authorize/callback',
        reason: 'state_missing',
      });
    });
  });

  describe('key rotation', () => {
    it('accepts blob signed with previous key', async () => {
      const blob = makeValidBlob({ secret: SECRET_PREV });
      const app = createTestApp({ secrets: [SECRET, SECRET_PREV] });

      const res = await request(app)
        .get('/authorize/callback')
        .query({ code: 'CODE', state: blob });

      expect(res.status).toBe(302);
    });
  });
});
