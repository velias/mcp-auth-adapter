#!/usr/bin/env node
import 'dotenv/config';
import { loadConfig } from './config';
import { createApp } from './app';
import { createLogger, Logger } from './logger';
import { IMetricsRegistry } from './metrics';
import { readResponseWithLimit } from './fetch-utils';
import { buildDefaultUpstreamDoc, validateUpstreamDoc } from './routes/well-known';
import { version } from '../package.json';


const DISCOVERY_PATHS = [
  '/.well-known/openid-configuration',
  '/.well-known/oauth-authorization-server',  // RFC 8414 fallback
];
const WELL_KNOWN_FETCH_TIMEOUT_MS = 10_000;
const WELL_KNOWN_MAX_BYTES = 256 * 1024;

async function fetchUpstreamWellKnown(
  issuerUrl: string,
  log?: Logger,
): Promise<Record<string, unknown>> {
  let lastError: Error | undefined;
  for (const path of DISCOVERY_PATHS) {
    const url = `${issuerUrl}${path}`;
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(WELL_KNOWN_FETCH_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      if (path !== DISCOVERY_PATHS[0]) {
        log?.info(`Upstream well-known fetched via fallback path ${path}`);
      }
      const body = await readResponseWithLimit(response, WELL_KNOWN_MAX_BYTES);
      return JSON.parse(body.toString('utf-8')) as Record<string, unknown>;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      log?.debug(`Discovery fetch failed for ${path}`, { error: String(err) });
    }
  }
  throw lastError ?? new Error('All discovery paths failed');
}

interface InstrumentedRefresh {
  (): void;
  /** Retroactively record the initial startup fetch that happened before the registry existed. */
  recordInitial(success: boolean, durationSec: number): void;
}

/**
 * Creates an instrumented periodic refresh callback for the upstream
 * well-known document. Records success/error counts, duration, and
 * last-success timestamp via the provided metrics registry.
 */
function createInstrumentedRefresh(
  issuerUrl: string,
  log: Logger,
  metricsRegistry: IMetricsRegistry,
  updateUpstream: (doc: Record<string, unknown>) => void,
): InstrumentedRefresh {
  const refreshTotal = metricsRegistry.createCounter('mcp_auth_upstream_refresh_total', 'Upstream well-known refresh attempts');
  const refreshDuration = metricsRegistry.createGauge('mcp_auth_upstream_refresh_duration_seconds', 'Last upstream refresh duration in seconds');
  const refreshLastSuccess = metricsRegistry.createGauge('mcp_auth_upstream_refresh_last_success_timestamp', 'Unix timestamp of last successful upstream refresh');

  const refresh: InstrumentedRefresh = (() => {
    const start = process.hrtime.bigint();
    void fetchUpstreamWellKnown(issuerUrl, log).then((newDoc) => {
      const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
      refreshTotal.inc({ result: 'success' });
      refreshDuration.set(durationSec);
      refreshLastSuccess.set(Math.floor(Date.now() / 1000));
      updateUpstream(newDoc);
      log.info('Upstream well-known document refreshed');
      for (const warning of validateUpstreamDoc(newDoc)) {
        log.warn(warning);
      }
    }).catch((err: unknown) => {
      const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
      refreshTotal.inc({ result: 'error' });
      refreshDuration.set(durationSec);
      log.warn('Failed to refresh upstream well-known, keeping previous', { error: String(err) });
    });
  }) as InstrumentedRefresh;

  refresh.recordInitial = (success: boolean, durationSec: number) => {
    refreshTotal.inc({ result: success ? 'success' : 'error' });
    refreshDuration.set(durationSec);
    if (success) {
      refreshLastSuccess.set(Math.floor(Date.now() / 1000));
    }
  };

  return refresh;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger(config.debug);

  log.info(`MCP Auth Adapter version ${version} is starting...`);

  if (config.authScopesRemoved && config.authScopesPreserved) {
    log.warn('Both MCP_PROXY_AUTH_SCOPES_REMOVED and MCP_PROXY_AUTH_SCOPES_PRESERVED are configured; MCP_PROXY_AUTH_SCOPES_PRESERVED takes precedence, MCP_PROXY_AUTH_SCOPES_REMOVED is ignored');
    config.authScopesRemoved = undefined;
  }

  let upstreamDoc: Record<string, unknown>;
  let initialFetchOk = false;
  const fetchStart = process.hrtime.bigint();
  log.info('Fetching upstream well-known', { url: config.upstreamSsoUrl });
  try {
    upstreamDoc = await fetchUpstreamWellKnown(config.upstreamSsoUrl, log);
    initialFetchOk = true;
    log.info('Upstream well-known document cached');
    for (const warning of validateUpstreamDoc(upstreamDoc)) {
      log.warn(warning);
    }
  } catch (err) {
    log.warn('Failed to fetch upstream well-known, using defaults', { error: String(err) });
    upstreamDoc = buildDefaultUpstreamDoc(config.upstreamSsoUrl);
  }
  const initialFetchDuration = Number(process.hrtime.bigint() - fetchStart) / 1e9;

  const { app, metricsRegistry, updateUpstream, setShuttingDown } = createApp({ config, upstreamDoc });

  const doRefresh = createInstrumentedRefresh(config.upstreamSsoUrl, log, metricsRegistry, updateUpstream);
  doRefresh.recordInitial(initialFetchOk, initialFetchDuration);
  const refreshMs = config.wellKnownRefreshMinutes * 60 * 1000;
  const refreshTimer = setInterval(doRefresh, refreshMs);

  const server = app.listen(config.port, () => {
    log.info('MCP Auth Adapter started', {
      port: config.port,
      baseUrl: config.baseUrl,
      upstreamSso: config.upstreamSsoUrl,
      authProxy: config.proxyAuthEndpoint ? 'enabled' : 'disabled',
      dcrProxy: config.proxyDcrEndpoint ? 'enabled' : 'disabled',
      cimdProxy: config.cimdEnabled ? 'enabled (EXPERIMENTAL)' : 'disabled',
      metrics: config.metricsEnabled ? 'enabled' : 'disabled',
      refreshMinutes: config.wellKnownRefreshMinutes,
      debug: config.debug,
    });
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    log.info('Shutdown signal received, draining connections', { signal });
    setShuttingDown();
    clearInterval(refreshTimer);

    const forceTimeout = setTimeout(() => {
      log.error('Graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, config.shutdownTimeoutSeconds * 1000);
    forceTimeout.unref();

    server.close((err) => {
      clearTimeout(forceTimeout);
      if (err) {
        log.error('Error during server close', { error: String(err) });
        process.exit(1);
      }
      log.info('Server closed, exiting');
      process.exit(0);
    });
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

const bootstrapLog = createLogger(false);
main().catch((err) => {
  bootstrapLog.error('Fatal error', { error: String(err) });
  process.exit(1);
});
