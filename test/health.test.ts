import request from 'supertest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp } from '../src/app';
import { AppConfig } from '../src/config';
import { createHealthRouter, createUpstreamProbe, UpstreamHealth } from '../src/routes/health';
import express from 'express';

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

function makeApp(opts?: { fromFallback?: boolean }) {
  return createApp({
    config: CONFIG,
    upstreamDoc: MOCK_UPSTREAM_DOC,
    fromFallback: opts?.fromFallback,
  });
}

describe('Health probes', () => {
  it('GET /health/live returns 200', async () => {
    const res = await request(makeApp().app).get('/health/live');
    expect(res.status).toBe(200);
  });

  it('GET /health/ready returns 200', async () => {
    const res = await request(makeApp().app).get('/health/ready');
    expect(res.status).toBe(200);
  });

  it('GET /health/ready returns 503 when shutting down', async () => {
    const { app, setShuttingDown } = makeApp();
    setShuttingDown();
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
  });

  it('GET /health/live still returns 200 when shutting down', async () => {
    const { app, setShuttingDown } = makeApp();
    setShuttingDown();
    const res = await request(app).get('/health/live');
    expect(res.status).toBe(200);
  });
});

describe('GET /health — composite health check', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockProbeSuccess() {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
  }

  function mockProbeFailure(message = 'ECONNREFUSED') {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(message));
  }

  it('returns 200 with status ok when everything is healthy', async () => {
    mockProbeSuccess();
    const { app } = makeApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.status).toBe('ok');
    expect(res.body.checks.adapter).toBe('ok');
    expect(res.body.checks.upstream_idp).toBe('ok');
    expect(res.body.message).toBeUndefined();
  });

  it('includes upstream_idp detail with url and last_success_at', async () => {
    mockProbeSuccess();
    const { app } = makeApp();
    const res = await request(app).get('/health');
    expect(res.body.upstream_idp.url).toBe('https://sso.example.com/auth/realms/test');
    expect(res.body.upstream_idp.last_success_at).toBeDefined();
    expect(res.body.upstream_idp.last_error).toBeUndefined();
    expect(res.body.upstream_idp.last_error_at).toBeUndefined();
    expect(res.body.upstream_idp.using_fallback).toBeUndefined();
  });

  it('returns 503 with adapter error when shutting down', async () => {
    mockProbeSuccess();
    const { app, setShuttingDown } = makeApp();
    setShuttingDown();
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
    expect(res.body.checks.adapter).toBe('error');
    expect(res.body.checks.upstream_idp).toBe('ok');
    expect(res.body.message).toContain('adapter: shutting down');
  });

  it('returns 503 with upstream error when upstream was never reached (fromFallback)', async () => {
    mockProbeFailure();
    const { app } = makeApp({ fromFallback: true });
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
    expect(res.body.checks.adapter).toBe('ok');
    expect(res.body.checks.upstream_idp).toBe('error');
    expect(res.body.message).toContain('upstream_idp: never successfully reached');
    expect(res.body.upstream_idp.using_fallback).toBe(true);
  });

  it('returns 503 with upstream error when probe fails after previous success', async () => {
    mockProbeFailure('HTTP 503 Service Unavailable');
    const { app } = makeApp();
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
    expect(res.body.checks.adapter).toBe('ok');
    expect(res.body.checks.upstream_idp).toBe('error');
    expect(res.body.message).toContain('upstream_idp: unreachable');
    expect(res.body.upstream_idp.last_error).toBe('HTTP 503 Service Unavailable');
    expect(res.body.upstream_idp.last_error_at).toBeDefined();
    expect(res.body.upstream_idp.last_success_at).toBeDefined();
  });

  it('returns error (worst status) when both adapter and upstream are failing', async () => {
    mockProbeFailure();
    const { app, setShuttingDown } = makeApp({ fromFallback: true });
    setShuttingDown();
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
    expect(res.body.checks.adapter).toBe('error');
    expect(res.body.checks.upstream_idp).toBe('error');
    expect(res.body.message).toContain('adapter: shutting down');
    expect(res.body.message).toContain('upstream_idp: never successfully reached');
  });

});

describe('GET /health — probe integration via router', () => {
  function makeRouterApp(opts: {
    health: UpstreamHealth;
    probe?: () => Promise<void>;
    shuttingDown?: boolean;
  }) {
    const app = express();
    app.use(createHealthRouter(
      () => !!opts.shuttingDown,
      () => opts.health,
      opts.probe,
    ));
    return app;
  }

  it('calls probeUpstream on each /health request', async () => {
    const probe = vi.fn().mockResolvedValue(undefined);
    const health: UpstreamHealth = {
      url: 'https://sso.example.com',
      lastSuccessAt: Date.now(),
      lastError: null,
      lastErrorAt: null,
      usingFallback: false,
    };
    const app = makeRouterApp({ health, probe });
    await request(app).get('/health');
    expect(probe).toHaveBeenCalledTimes(1);
    await request(app).get('/health');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('does not crash if probe throws — state still reflected in response', async () => {
    const health: UpstreamHealth = {
      url: 'https://sso.example.com',
      lastSuccessAt: Date.now(),
      lastError: null,
      lastErrorAt: null,
      usingFallback: false,
    };
    const probe = vi.fn().mockImplementation(() => {
      health.lastError = 'probe failed';
      health.lastErrorAt = Date.now();
      return Promise.resolve();
    });
    const app = makeRouterApp({ health, probe });
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
    expect(res.body.upstream_idp.last_error).toBe('probe failed');
  });

  it('works without probe function (no-op)', async () => {
    const health: UpstreamHealth = {
      url: 'https://sso.example.com',
      lastSuccessAt: Date.now(),
      lastError: null,
      lastErrorAt: null,
      usingFallback: false,
    };
    const app = makeRouterApp({ health });
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('recovers to ok after probe succeeds following a failure', async () => {
    const health: UpstreamHealth = {
      url: 'https://sso.example.com',
      lastSuccessAt: Date.now() - 60_000,
      lastError: null,
      lastErrorAt: null,
      usingFallback: false,
    };
    const probe = vi.fn()
      .mockImplementationOnce(() => {
        health.lastError = 'connection refused';
        health.lastErrorAt = Date.now();
        return Promise.resolve();
      })
      .mockImplementationOnce(() => {
        health.lastSuccessAt = Date.now();
        return Promise.resolve();
      });
    const app = makeRouterApp({ health, probe });

    let res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
    expect(res.body.checks.upstream_idp).toBe('error');

    res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.checks.upstream_idp).toBe('ok');
    expect(res.body.message).toBeUndefined();
  });

  it('works without upstream health getter (minimal response)', async () => {
    const app = express();
    app.use(createHealthRouter(() => false));
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.checks.adapter).toBe('ok');
    expect(res.body.checks.upstream_idp).toBe('ok');
    expect(res.body.upstream_idp).toBeUndefined();
  });
});

describe('createUpstreamProbe', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function makeHealth(overrides?: Partial<UpstreamHealth>): UpstreamHealth {
    return {
      url: 'https://sso.example.com',
      lastSuccessAt: null,
      lastError: null,
      lastErrorAt: null,
      usingFallback: true,
      ...overrides,
    };
  }

  it('updates health on successful probe', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    const health = makeHealth();
    const probe = createUpstreamProbe(health, 0, 5000);
    await probe();
    expect(health.lastSuccessAt).toBeGreaterThan(0);
    expect(health.usingFallback).toBe(false);
    expect(health.lastError).toBeNull();
  });

  it('updates health on failed probe', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const health = makeHealth();
    const probe = createUpstreamProbe(health, 0, 5000);
    await probe();
    expect(health.lastSuccessAt).toBeNull();
    expect(health.lastError).toBe('ECONNREFUSED');
    expect(health.lastErrorAt).toBeGreaterThan(0);
    expect(health.usingFallback).toBe(true);
  });

  it('falls back to GET when HEAD returns 405', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 405 }))
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const health = makeHealth();
    const probe = createUpstreamProbe(health, 0, 5000);
    await probe();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][1]).toEqual(expect.objectContaining({ method: 'HEAD' }));
    expect(fetchSpy.mock.calls[1][1]).not.toHaveProperty('method');
    expect(health.lastSuccessAt).toBeGreaterThan(0);
  });

  it('reports error when GET fallback also fails', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 405 }))
      .mockResolvedValueOnce(new Response(null, { status: 503, statusText: 'Service Unavailable' }));
    const health = makeHealth();
    const probe = createUpstreamProbe(health, 0, 5000);
    await probe();
    expect(health.lastError).toBe('HTTP 503 Service Unavailable');
    expect(health.lastErrorAt).toBeGreaterThan(0);
  });

  it('skips fetch when cache is fresh', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    const health = makeHealth();
    const probe = createUpstreamProbe(health, 60_000, 5000);

    await probe();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await probe();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('re-probes after cache TTL expires', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    const health = makeHealth();
    const probe = createUpstreamProbe(health, 10, 5000);

    await probe();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    await new Promise((r) => setTimeout(r, 15));
    await probe();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent calls', async () => {
    let resolveProbe: (() => void) | undefined;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => new Promise<Response>((resolve) => {
        resolveProbe = () => resolve(new Response(null, { status: 200 }));
      }),
    );
    const health = makeHealth();
    const probe = createUpstreamProbe(health, 0, 5000);

    const p1 = probe();
    const p2 = probe();

    expect(fetchSpy).toHaveBeenCalledTimes(1);

    resolveProbe!();
    await p1;
    await p2;

    expect(health.lastSuccessAt).toBeGreaterThan(0);
  });

  it('probes the well-known URL path', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 200 }),
    );
    const health = makeHealth({ url: 'https://sso.example.com/auth/realms/test' });
    const probe = createUpstreamProbe(health, 0, 5000);
    await probe();
    expect(fetchSpy.mock.calls[0][0]).toBe(
      'https://sso.example.com/auth/realms/test/.well-known/openid-configuration',
    );
  });
});
