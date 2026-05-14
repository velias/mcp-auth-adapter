import compression from 'compression';
import express, { Application, Request, Response, NextFunction } from 'express';
import { AppConfig } from './config';
import { createLogger } from './logger';
import { createMetricsRegistry, IMetricsRegistry } from './metrics';
import { createHttpMetricsMiddleware, HttpMetrics } from './middleware/metrics';
import { buildWellKnownDocument, createWellKnownRouter } from './routes/well-known';
import { createRegisterRouter } from './routes/register';
import { createAuthorizeRouter, AuthCimdConfig } from './routes/authorize';
import { createHealthRouter } from './routes/health';
import { createMetricsRouter } from './routes/metrics';
import { createTokenRouter } from './routes/token';
import {
  CimdCache,
  fetchCimdDocument,
  resolveUpstreamClientId,
} from './cimd';

/**
 * Holds the current upstream state. Updated atomically by the
 * periodic refresh; routes read from this on every request.
 */
export interface UpstreamState {
  wellKnownDocument: Record<string, unknown>;
  upstreamAuthorizationEndpoint: string;
  upstreamTokenEndpoint: string;
}

export interface CreateAppOptions {
  config: AppConfig;
  upstreamDoc: Record<string, unknown>;
  /** Override CIMD document fetcher (for testing). Defaults to fetchCimdDocument. */
  cimdFetcher?: (url: string) => Promise<import('./cimd').CimdDocument>;
}

export function buildUpstreamState(
  upstreamDoc: Record<string, unknown>,
  config: AppConfig,
): UpstreamState {
  return {
    wellKnownDocument: buildWellKnownDocument(upstreamDoc, config),
    upstreamAuthorizationEndpoint: upstreamDoc.authorization_endpoint as string,
    upstreamTokenEndpoint: upstreamDoc.token_endpoint as string,
  };
}

export function createApp({ config, upstreamDoc, cimdFetcher }: CreateAppOptions): {
  app: Application;
  metricsRegistry: IMetricsRegistry;
  updateUpstream: (newUpstreamDoc: Record<string, unknown>) => void;
  setShuttingDown: () => void;
  isShuttingDown: () => boolean;
} {
  let state = buildUpstreamState(upstreamDoc, config);
  const logger = createLogger(config.debug);

  const metricsRegistry = createMetricsRegistry(config.metricsEnabled);

  let shuttingDown = false;
  const setShuttingDown = () => { shuttingDown = true; };
  const isShuttingDown = () => shuttingDown;

  const updateUpstream = (newUpstreamDoc: Record<string, unknown>) => {
    state = buildUpstreamState(newUpstreamDoc, config);
  };

  const app = express();
  app.disable('x-powered-by');

  app.use(compression());
  app.use(createHealthRouter(isShuttingDown));

  if (config.metricsEnabled) {
    app.use(createMetricsRouter(metricsRegistry));
  }

  app.use(express.json({ limit: '16kb' }));

  let httpMetrics: HttpMetrics | undefined;
  if (config.metricsEnabled) {
    httpMetrics = {
      requestsTotal: metricsRegistry.createCounter('mcp_auth_http_requests_total', 'Total HTTP requests to functional endpoints'),
      requestDuration: metricsRegistry.createHistogram('mcp_auth_http_request_duration_seconds', 'HTTP request duration in seconds'),
    };
  }

  const metricsMiddleware = httpMetrics ? createHttpMetricsMiddleware(httpMetrics) : undefined;

  const wellKnownRouter = createWellKnownRouter(() => state.wellKnownDocument, logger, config.wellKnownRefreshMinutes);
  if (metricsMiddleware) app.use(metricsMiddleware, wellKnownRouter);
  else app.use(wellKnownRouter);

  if (config.proxyDcrEndpoint) {
    const registerRouter = createRegisterRouter(config, logger);
    if (metricsMiddleware) app.use(metricsMiddleware, registerRouter);
    else app.use(registerRouter);
  }

  let cimdConfig: AuthCimdConfig | undefined;

  if (config.cimdEnabled) {
    if (!state.upstreamTokenEndpoint) {
      throw new Error('Upstream well-known document is missing token_endpoint (required by CIMD token proxy)');
    }

    const pinnedUrls = new Set(Object.keys(config.cimdMap));
    const cimdCache = new CimdCache({
      ttlMinutes: config.cimdCacheMinutes,
      pinnedUrls,
      metricsRegistry,
    });

    const fetcher = cimdFetcher ?? fetchCimdDocument;
    cimdConfig = {
      resolve: (cimdUrl: string) => resolveUpstreamClientId(cimdUrl, config.cimdMap, config.cimdDefaultClientId),
      validateAndCache: (cimdUrl: string) => cimdCache.get(cimdUrl, fetcher),
    };

    const tokenRouter = createTokenRouter(
      () => state.upstreamTokenEndpoint,
      { map: config.cimdMap, defaultClientId: config.cimdDefaultClientId },
      logger,
      metricsRegistry,
    );
    if (metricsMiddleware) app.use(metricsMiddleware, tokenRouter);
    else app.use(tokenRouter);
  }

  if (config.proxyAuthEndpoint) {
    if (!state.upstreamAuthorizationEndpoint) {
      throw new Error('Upstream well-known document is missing authorization_endpoint');
    }
    const authorizeRouter = createAuthorizeRouter(
      () => state.upstreamAuthorizationEndpoint,
      logger,
      { removed: config.authScopesRemoved, preserved: config.authScopesPreserved },
      cimdConfig,
    );
    if (metricsMiddleware) app.use(metricsMiddleware, authorizeRouter);
    else app.use(authorizeRouter);
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    logger.error('unhandled error', {
      method: req.method,
      path: req.path,
      error: String(err),
    });
    if (!res.headersSent) {
      res.status(500).json({
        error: 'server_error',
        error_description: 'An unexpected error occurred',
      });
    }
  });

  return { app, metricsRegistry, updateUpstream, setShuttingDown, isShuttingDown };
}
