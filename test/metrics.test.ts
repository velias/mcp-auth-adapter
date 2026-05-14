import request from 'supertest';
import { createMetricsRegistry, IMetricsRegistry } from '../src/metrics';
import { createApp } from '../src/app';
import { AppConfig } from '../src/config';
import { loadConfig } from '../src/config';
import { CimdCache, CimdDocument } from '../src/cimd';

// ---------------------------------------------------------------------------
// Registry primitives
// ---------------------------------------------------------------------------
describe('Metrics — Counter', () => {
  let registry: IMetricsRegistry;
  beforeEach(() => { registry = createMetricsRegistry(true); });

  it('increments without labels', () => {
    const counter = registry.createCounter('test_total', 'Test counter');
    counter.inc();
    counter.inc();
    const output = registry.serialize();
    expect(output).toContain('# HELP test_total Test counter');
    expect(output).toContain('# TYPE test_total counter');
    expect(output).toContain('test_total 2');
  });

  it('increments with labels', () => {
    const counter = registry.createCounter('req_total', 'Requests');
    counter.inc({ method: 'GET', status: '200' });
    counter.inc({ method: 'GET', status: '200' });
    counter.inc({ method: 'POST', status: '201' });
    const output = registry.serialize();
    expect(output).toContain('req_total{method="GET",status="200"} 2');
    expect(output).toContain('req_total{method="POST",status="201"} 1');
  });

  it('sorts label keys alphabetically', () => {
    const counter = registry.createCounter('c', 'c');
    counter.inc({ z: '1', a: '2' });
    const output = registry.serialize();
    expect(output).toContain('{a="2",z="1"}');
  });

  it('escapes backslash, double quote, and newline in label values', () => {
    const counter = registry.createCounter('esc', 'escape test');
    counter.inc({ val: 'a\\b"c\nd' });
    const output = registry.serialize();
    expect(output).toContain('{val="a\\\\b\\"c\\nd"}');
  });
});

describe('Metrics — Gauge', () => {
  let registry: IMetricsRegistry;
  beforeEach(() => { registry = createMetricsRegistry(true); });

  it('sets value without labels', () => {
    const gauge = registry.createGauge('temp', 'Temperature');
    gauge.set(42.5);
    const output = registry.serialize();
    expect(output).toContain('# TYPE temp gauge');
    expect(output).toContain('temp 42.5');
  });

  it('overwrites previous value', () => {
    const gauge = registry.createGauge('temp', 'Temperature');
    gauge.set(10);
    gauge.set(20);
    const output = registry.serialize();
    expect(output).toContain('temp 20');
    expect(output).not.toContain('temp 10');
  });

  it('sets value with labels', () => {
    const gauge = registry.createGauge('mem', 'Memory');
    gauge.set(1024, { pool: 'heap' });
    const output = registry.serialize();
    expect(output).toContain('mem{pool="heap"} 1024');
  });
});

describe('Metrics — Histogram', () => {
  let registry: IMetricsRegistry;
  beforeEach(() => { registry = createMetricsRegistry(true); });

  it('observes values and populates buckets', () => {
    const hist = registry.createHistogram('duration', 'Duration', [0.1, 0.5, 1]);
    hist.observe(0.05);
    hist.observe(0.3);
    hist.observe(0.8);
    const output = registry.serialize();
    expect(output).toContain('# TYPE duration histogram');
    expect(output).toContain('duration_bucket{le="0.1"} 1');
    expect(output).toContain('duration_bucket{le="0.5"} 2');
    expect(output).toContain('duration_bucket{le="1"} 3');
    expect(output).toContain('duration_bucket{le="+Inf"} 3');
    expect(output).toContain('duration_sum 1.15');
    expect(output).toContain('duration_count 3');
  });

  it('handles labeled histograms', () => {
    const hist = registry.createHistogram('dur', 'D', [1]);
    hist.observe(0.5, { method: 'GET' });
    hist.observe(2, { method: 'GET' });
    const output = registry.serialize();
    expect(output).toContain('dur_bucket{method="GET",le="1"} 1');
    expect(output).toContain('dur_bucket{method="GET",le="+Inf"} 2');
    expect(output).toContain('dur_sum{method="GET"} 2.5');
    expect(output).toContain('dur_count{method="GET"} 2');
  });
});

describe('Metrics — Registry serialization', () => {
  it('concatenates multiple metrics with blank lines', () => {
    const registry = createMetricsRegistry(true);
    registry.createCounter('a', 'A').inc();
    registry.createGauge('b', 'B').set(1);
    const output = registry.serialize();
    expect(output).toContain('# TYPE a counter');
    expect(output).toContain('# TYPE b gauge');
    expect(output.indexOf('a 1')).toBeLessThan(output.indexOf('b 1'));
  });

  it('returns only trailing newline for empty registry', () => {
    const registry = createMetricsRegistry(true);
    registry.createCounter('unused', 'U');
    expect(registry.serialize()).toBe('\n');
  });
});

// ---------------------------------------------------------------------------
// No-op registry
// ---------------------------------------------------------------------------
describe('Metrics — NoopRegistry', () => {
  it('returns empty serialization', () => {
    const registry = createMetricsRegistry(false);
    expect(registry.serialize()).toBe('');
  });

  it('counter.inc is a no-op (does not throw)', () => {
    const registry = createMetricsRegistry(false);
    const counter = registry.createCounter('x', 'x');
    expect(() => counter.inc()).not.toThrow();
    expect(() => counter.inc({ a: '1' })).not.toThrow();
  });

  it('gauge.set is a no-op', () => {
    const registry = createMetricsRegistry(false);
    const gauge = registry.createGauge('x', 'x');
    expect(() => gauge.set(42)).not.toThrow();
  });

  it('histogram.observe is a no-op', () => {
    const registry = createMetricsRegistry(false);
    const hist = registry.createHistogram('x', 'x');
    expect(() => hist.observe(0.5)).not.toThrow();
  });

  it('all no-op instances are singletons', () => {
    const registry = createMetricsRegistry(false);
    const c1 = registry.createCounter('a', 'a');
    const c2 = registry.createCounter('b', 'b');
    expect(c1).toBe(c2);
  });
});

// ---------------------------------------------------------------------------
// /metrics endpoint integration
// ---------------------------------------------------------------------------
const MOCK_UPSTREAM_DOC: Record<string, unknown> = {
  issuer: 'https://sso.example.com/auth/realms/test',
  authorization_endpoint: 'https://sso.example.com/auth/realms/test/protocol/openid-connect/auth',
  token_endpoint: 'https://sso.example.com/auth/realms/test/protocol/openid-connect/token',
  code_challenge_methods_supported: ['S256'],
};

const BASE_CONFIG: AppConfig = {
  baseUrl: 'http://localhost:3000',
  port: 3000,
  upstreamSsoUrl: 'https://sso.example.com/auth/realms/test',
  clientId: 'test-client',
  proxyAuthEndpoint: false,
  proxyDcrEndpoint: true,
  wellKnownRefreshMinutes: 60,
  debug: false,
  cimdMap: {},
  cimdCacheMinutes: 30,
  cimdEnabled: false,
  metricsEnabled: true,
  shutdownTimeoutSeconds: 30,
};

describe('/metrics endpoint', () => {
  it('returns 200 with Prometheus content type when enabled', async () => {
    const { app } = createApp({ config: BASE_CONFIG, upstreamDoc: MOCK_UPSTREAM_DOC });
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('includes process metrics', async () => {
    const { app } = createApp({ config: BASE_CONFIG, upstreamDoc: MOCK_UPSTREAM_DOC });
    const res = await request(app).get('/metrics');
    expect(res.text).toContain('process_uptime_seconds');
    expect(res.text).toContain('process_resident_memory_bytes');
    expect(res.text).toContain('process_heap_used_bytes');
  });

  it('returns 404 when metrics disabled', async () => {
    const { app } = createApp({
      config: { ...BASE_CONFIG, metricsEnabled: false },
      upstreamDoc: MOCK_UPSTREAM_DOC,
    });
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(404);
  });
});

describe('HTTP metrics — functional routes only', () => {
  it('records metrics for well-known requests', async () => {
    const { app } = createApp({ config: BASE_CONFIG, upstreamDoc: MOCK_UPSTREAM_DOC });
    await request(app).get('/.well-known/openid-configuration');
    const res = await request(app).get('/metrics');
    expect(res.text).toContain('mcp_auth_http_requests_total');
    expect(res.text).toContain('mcp_auth_http_request_duration_seconds');
  });

  it('records metrics for register requests', async () => {
    const { app } = createApp({ config: BASE_CONFIG, upstreamDoc: MOCK_UPSTREAM_DOC });
    await request(app)
      .post('/register')
      .set('Content-Type', 'application/json')
      .send({});
    const res = await request(app).get('/metrics');
    expect(res.text).toContain('status="201"');
  });

  it('does not record metrics for health endpoints', async () => {
    const { app } = createApp({ config: BASE_CONFIG, upstreamDoc: MOCK_UPSTREAM_DOC });
    await request(app).get('/health/live');
    await request(app).get('/health/ready');
    const res = await request(app).get('/metrics');
    expect(res.text).not.toContain('path="/health');
  });

  it('does not record metrics for /metrics itself', async () => {
    const { app } = createApp({ config: BASE_CONFIG, upstreamDoc: MOCK_UPSTREAM_DOC });
    await request(app).get('/metrics');
    const res = await request(app).get('/metrics');
    expect(res.text).not.toContain('path="/metrics"');
  });

  it('does not record metrics for unmatched paths', async () => {
    const { app } = createApp({ config: BASE_CONFIG, upstreamDoc: MOCK_UPSTREAM_DOC });
    await request(app).get('/nonexistent-path');
    const res = await request(app).get('/metrics');
    expect(res.text).not.toContain('path="/nonexistent-path"');
  });
});

// ---------------------------------------------------------------------------
// Config tests for MCP_METRICS_ENABLED
// ---------------------------------------------------------------------------
const REQUIRED_ENV = {
  MCP_BASE_URL: 'http://localhost:3000',
  MCP_UPSTREAM_SSO_URL: 'https://sso.example.com/auth/realms/test',
};

function withEnv(extra: Record<string, string>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  const allKeys = new Set([...Object.keys(REQUIRED_ENV), ...Object.keys(extra)]);
  for (const key of allKeys) {
    saved[key] = process.env[key];
  }
  try {
    for (const key of Object.keys(REQUIRED_ENV)) {
      process.env[key] = REQUIRED_ENV[key as keyof typeof REQUIRED_ENV];
    }
    for (const [key, value] of Object.entries(extra)) {
      process.env[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('loadConfig — MCP_METRICS_ENABLED', () => {
  it('defaults to true when not set', () => {
    withEnv({}, () => {
      expect(loadConfig().metricsEnabled).toBe(true);
    });
  });

  it('is true when explicitly set to "true"', () => {
    withEnv({ MCP_METRICS_ENABLED: 'true' }, () => {
      expect(loadConfig().metricsEnabled).toBe(true);
    });
  });

  it('is false when set to "false"', () => {
    withEnv({ MCP_METRICS_ENABLED: 'false' }, () => {
      expect(loadConfig().metricsEnabled).toBe(false);
    });
  });

  it('is false for any non-"true" value', () => {
    withEnv({ MCP_METRICS_ENABLED: '0' }, () => {
      expect(loadConfig().metricsEnabled).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// HTTP metrics for /authorize
// ---------------------------------------------------------------------------
describe('HTTP metrics — /authorize route', () => {
  const AUTH_CONFIG: AppConfig = {
    ...BASE_CONFIG,
    proxyAuthEndpoint: true,
    authScopesRemoved: ['offline_access'],
  };

  it('records metrics for authorize redirects', async () => {
    const { app } = createApp({ config: AUTH_CONFIG, upstreamDoc: MOCK_UPSTREAM_DOC });
    await request(app)
      .get('/authorize?response_type=code&client_id=test&redirect_uri=http%3A%2F%2Flocalhost&code_challenge=abc&code_challenge_method=S256');
    const res = await request(app).get('/metrics');
    expect(res.text).toContain('path="/authorize"');
    expect(res.text).toContain('status="302"');
  });
});

// ---------------------------------------------------------------------------
// HTTP metrics for /token (CIMD-enabled)
// ---------------------------------------------------------------------------
describe('HTTP metrics — /token route', () => {
  const CIMD_CONFIG: AppConfig = {
    ...BASE_CONFIG,
    proxyAuthEndpoint: true,
    cimdEnabled: true,
    cimdMap: { 'https://example.com/oauth-client.json': 'upstream-client' },
  };

  it('records metrics for token proxy requests', async () => {
    const { app } = createApp({ config: CIMD_CONFIG, upstreamDoc: MOCK_UPSTREAM_DOC });
    await request(app)
      .post('/token')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('grant_type=authorization_code&code=abc&client_id=upstream-client');
    const res = await request(app).get('/metrics');
    expect(res.text).toContain('path="/token"');
  });
});

// ---------------------------------------------------------------------------
// CIMD cache metrics
// ---------------------------------------------------------------------------
describe('CIMD cache metrics', () => {
  const mockDoc: CimdDocument = {
    client_id: 'https://example.com/oauth-client.json',
    redirect_uris: ['http://localhost/callback'],
  };

  it('records hit/miss counts and cache size', async () => {
    const registry = createMetricsRegistry(true);
    const cache = new CimdCache({
      ttlMinutes: 60,
      pinnedUrls: new Set(),
      metricsRegistry: registry,
    });

    const fetcher = jest.fn<Promise<CimdDocument>, [string]>().mockResolvedValue(mockDoc);

    await cache.get('https://example.com/oauth-client.json', fetcher);
    await cache.get('https://example.com/oauth-client.json', fetcher);

    const output = registry.serialize();
    expect(output).toContain('mcp_auth_cimd_cache_operations_total{result="miss"} 1');
    expect(output).toContain('mcp_auth_cimd_cache_operations_total{result="hit"} 1');
    expect(output).toContain('mcp_auth_cimd_cache_size 1');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('records eviction count', async () => {
    const registry = createMetricsRegistry(true);
    const cache = new CimdCache({
      ttlMinutes: 60,
      pinnedUrls: new Set(),
      maxUnpinnedSize: 1,
      metricsRegistry: registry,
    });

    const fetcher = jest.fn<Promise<CimdDocument>, [string]>().mockImplementation((url: string) =>
      Promise.resolve({ client_id: url, redirect_uris: ['http://localhost/cb'] }),
    );

    await cache.get('https://a.com/meta', fetcher);
    await cache.get('https://b.com/meta', fetcher);

    const output = registry.serialize();
    expect(output).toContain('mcp_auth_cimd_cache_evictions_total 1');
  });
});

// ---------------------------------------------------------------------------
// Upstream refresh metrics (via metricsRegistry from createApp)
// ---------------------------------------------------------------------------
describe('Upstream refresh metrics', () => {
  it('metricsRegistry is exposed and can register upstream refresh metrics', () => {
    const { metricsRegistry } = createApp({ config: BASE_CONFIG, upstreamDoc: MOCK_UPSTREAM_DOC });

    const counter = metricsRegistry.createCounter('mcp_auth_upstream_refresh_total', 'test');
    counter.inc({ result: 'success' });
    counter.inc({ result: 'error' });

    const gauge = metricsRegistry.createGauge('mcp_auth_upstream_refresh_duration_seconds', 'test');
    gauge.set(0.42);

    const output = metricsRegistry.serialize();
    expect(output).toContain('mcp_auth_upstream_refresh_total{result="success"} 1');
    expect(output).toContain('mcp_auth_upstream_refresh_total{result="error"} 1');
    expect(output).toContain('mcp_auth_upstream_refresh_duration_seconds 0.42');
  });

  it('upstream refresh metrics appear on /metrics endpoint', async () => {
    const { app, metricsRegistry } = createApp({ config: BASE_CONFIG, upstreamDoc: MOCK_UPSTREAM_DOC });

    const counter = metricsRegistry.createCounter('mcp_auth_upstream_refresh_total', 'Upstream well-known refresh attempts');
    counter.inc({ result: 'success' });

    const res = await request(app).get('/metrics');
    expect(res.text).toContain('mcp_auth_upstream_refresh_total{result="success"} 1');
  });
});
