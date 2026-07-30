import compression from 'compression';
import express, { Application, Request, Response, NextFunction } from 'express';
import { AppConfig } from './config';
import { createLogger } from './logger';
import { createMetricsRegistry, IMetricsRegistry } from './metrics';
import { createHttpMetricsMiddleware, HttpMetrics } from './middleware/metrics';
import { buildWellKnownDocument, createWellKnownRouter } from './routes/well-known';
import { createRegisterRouter } from './routes/register';
import { createAuthorizeRouter } from './routes/authorize';
import { createAuthorizeCallbackRouter } from './routes/authorize-callback';
import { createHealthRouter, createUpstreamProbe, UpstreamHealth } from './routes/health';
import { createMetricsRouter } from './routes/metrics';
import { createTokenRouter } from './routes/token';
import { createParRouter } from './routes/par';
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
  wellKnownDocumentSerialized: string;
  upstreamAuthorizationEndpoint: string;
  upstreamTokenEndpoint: string;
  upstreamParEndpoint: string;
  upstreamIssuer: string;
  upstreamSupportsIss: boolean;
}

export interface CreateAppOptions {
  config: AppConfig;
  upstreamDoc: Record<string, unknown>;
  /** Whether the upstream doc is a fallback (not fetched successfully). */
  fromFallback?: boolean;
  /** Override CIMD document fetcher (for testing). Defaults to fetchCimdDocument. */
  cimdFetcher?: (url: string) => Promise<import('./cimd').CimdDocument>;
}

export function buildUpstreamState(
  upstreamDoc: Record<string, unknown>,
  config: AppConfig,
  fromFallback = false,
): UpstreamState {
  const wellKnownDocument = buildWellKnownDocument(upstreamDoc, config);
  const parEndpoint = upstreamDoc.pushed_authorization_request_endpoint;
  return {
    wellKnownDocument,
    wellKnownDocumentSerialized: JSON.stringify(wellKnownDocument),
    upstreamAuthorizationEndpoint: upstreamDoc.authorization_endpoint as string,
    upstreamTokenEndpoint: upstreamDoc.token_endpoint as string,
    upstreamParEndpoint: typeof parEndpoint === 'string' ? parEndpoint : '',
    upstreamIssuer: (upstreamDoc.issuer as string) ?? config.upstreamSsoUrl,
    upstreamSupportsIss: fromFallback
      ? false
      : upstreamDoc.authorization_response_iss_parameter_supported === true,
  };
}

export function createApp({ config, upstreamDoc, fromFallback, cimdFetcher }: CreateAppOptions): {
  app: Application;
  metricsRegistry: IMetricsRegistry;
  updateUpstream: (newUpstreamDoc: Record<string, unknown>) => void;
  updateUpstreamHealth: (success: boolean, error?: string) => void;
  setShuttingDown: () => void;
  isShuttingDown: () => boolean;
} {
  let state = buildUpstreamState(upstreamDoc, config, fromFallback);
  const logger = createLogger(config.debug, config.accessLog);

  const metricsRegistry = createMetricsRegistry(config.metricsEnabled);

  const rejectedTotal = metricsRegistry.createCounter(
    'mcp_auth_request_rejected_total',
    'Requests rejected by input validation',
  );
  const authorizeRedirectsTotal = metricsRegistry.createCounter(
    'mcp_auth_authorize_redirects_total',
    'Successful authorize redirects to upstream',
  );

  let shuttingDown = false;
  const setShuttingDown = () => { shuttingDown = true; };
  const isShuttingDown = () => shuttingDown;

  const updateUpstream = (newUpstreamDoc: Record<string, unknown>) => {
    state = buildUpstreamState(newUpstreamDoc, config);
  };

  const upstreamHealth: UpstreamHealth = {
    url: config.upstreamSsoUrl,
    lastSuccessAt: fromFallback ? null : Date.now(),
    lastError: null,
    lastErrorAt: null,
    usingFallback: !!fromFallback,
  };

  const updateUpstreamHealth = (success: boolean, error?: string) => {
    if (success) {
      upstreamHealth.lastSuccessAt = Date.now();
      upstreamHealth.usingFallback = false;
    } else {
      upstreamHealth.lastError = error ?? 'unknown error';
      upstreamHealth.lastErrorAt = Date.now();
    }
  };

  const probeUpstream = createUpstreamProbe(upstreamHealth);

  const app = express();
  app.disable('x-powered-by');

  app.use(createHealthRouter(isShuttingDown, () => upstreamHealth, probeUpstream));
  app.use(compression());

  if (config.metricsEnabled) {
    app.use(createMetricsRouter(metricsRegistry));
  }
  app.use(express.json({ limit: '16kb' }));

  // Build the set of known upstream client_ids from all config sources (bounded cardinality for metrics)
  const knownIdpClients = new Set<string>();
  for (const entry of config.dcrClientNameMap) knownIdpClients.add(entry.clientId);
  if (config.clientId) knownIdpClients.add(config.clientId);
  for (const v of Object.values(config.cimdMap)) knownIdpClients.add(v);
  if (config.cimdDefaultClientId) knownIdpClients.add(config.cimdDefaultClientId);

  let httpMetrics: HttpMetrics | undefined;
  if (config.metricsEnabled) {
    httpMetrics = {
      requestsTotal: metricsRegistry.createCounter('mcp_auth_http_requests_total', 'Total HTTP requests to functional endpoints'),
      requestDuration: metricsRegistry.createHistogram('mcp_auth_http_request_duration_seconds', 'HTTP request duration in seconds'),
    };
  }

  const metricsMiddleware = httpMetrics ? createHttpMetricsMiddleware(httpMetrics) : undefined;

  const wellKnownRouter = createWellKnownRouter(() => state.wellKnownDocumentSerialized, logger, config.wellKnownRefreshMinutes);
  if (metricsMiddleware) app.use(metricsMiddleware, wellKnownRouter);
  else app.use(wellKnownRouter);

  if (config.proxyDcrEndpoint) {
    const registerRouter = createRegisterRouter({
      defaultClientId: config.clientId || undefined,
      dcrClientNameMap: config.dcrClientNameMap,
      rejectedTotal,
      metricsRegistry: config.metricsEnabled && config.dcrClientNameMap.length > 0 ? metricsRegistry : undefined,
      knownIdpClients,
    }, logger);
    if (metricsMiddleware) app.use(metricsMiddleware, registerRouter);
    else app.use(registerRouter);
  }

  let cimdResolve: ((cimdUrl: string) => string | null) | undefined;
  let cimdValidateAndCache: ((cimdUrl: string) => Promise<import('./cimd').CimdDocument>) | undefined;

  if (config.cimdEnabled) {
    const pinnedUrls = new Set(Object.keys(config.cimdMap));
    const cimdCache = new CimdCache({
      ttlMinutes: config.cimdCacheMinutes,
      pinnedUrls,
      metricsRegistry,
    });

    const fetcher = cimdFetcher ?? fetchCimdDocument;
    cimdResolve = (cimdUrl: string) => resolveUpstreamClientId(cimdUrl, config.cimdMap, config.cimdDefaultClientId);
    cimdValidateAndCache = (cimdUrl: string) => cimdCache.get(cimdUrl, fetcher);
  }

  if (config.proxyAuthEndpoint) {
    if (!state.upstreamAuthorizationEndpoint) {
      throw new Error('Upstream well-known document is missing authorization_endpoint');
    }
    if (!state.upstreamTokenEndpoint) {
      throw new Error('Upstream well-known document is missing token_endpoint');
    }

    const authorizeRouter = createAuthorizeRouter({
      getUpstreamAuthEndpoint: () => state.upstreamAuthorizationEndpoint,
      getUpstreamParEndpoint: () => state.upstreamParEndpoint,
      removed: config.authScopesRemoved,
      preserved: config.authScopesPreserved,
      requireResource: config.requireResource,
      allowedResources: config.allowedResources,
      cimdResolve,
      cimdValidateAndCache,
      stateBaseUrl: config.authStateSecret ? config.baseUrl : undefined,
      stateSecret: config.authStateSecret,
      stateTtlSeconds: config.authStateTtlSeconds,
      stateAllowedRedirectUris: config.authStateSecret ? config.allowedRedirectUris : undefined,
      dcrClientIdRedirectMap: config.dcrClientIdRedirectMap.size > 0 ? config.dcrClientIdRedirectMap : undefined,
      knownIdpClients: knownIdpClients.size > 0 ? knownIdpClients : undefined,
      rejectedTotal,
      redirectsTotal: authorizeRedirectsTotal,
    }, logger);
    if (metricsMiddleware) app.use(metricsMiddleware, authorizeRouter);
    else app.use(authorizeRouter);

    // Callback router for iss interception
    if (config.authStateSecret) {
      const secretsArray: Buffer[] = [config.authStateSecret];
      if (config.authStateSecretPrevious) secretsArray.push(config.authStateSecretPrevious);

      const callbackRouter = createAuthorizeCallbackRouter({
        baseUrl: config.baseUrl,
        getSecrets: () => secretsArray,
        getUpstreamIssuer: () => state.upstreamIssuer,
        getUpstreamSupportsIss: () => state.upstreamSupportsIss,
        rejectedTotal,
      }, logger);
      if (metricsMiddleware) app.use(metricsMiddleware, callbackRouter);
      else app.use(callbackRouter);
    }

    // Token proxy (unified — always active when authorize proxy is active)
    const tokenRouter = createTokenRouter({
      getUpstreamTokenEndpoint: () => state.upstreamTokenEndpoint,
      cimdMap: config.cimdMap,
      cimdDefaultClientId: config.cimdDefaultClientId,
      metricsRegistry,
      redirectBaseUrl: config.authStateSecret ? config.baseUrl : undefined,
      redirectAllowedUris: config.authStateSecret ? config.allowedRedirectUris : undefined,
      dcrClientIdRedirectMap: config.dcrClientIdRedirectMap.size > 0 ? config.dcrClientIdRedirectMap : undefined,
      knownIdpClients: knownIdpClients.size > 0 ? knownIdpClients : undefined,
      requireResource: config.requireResource,
      allowedResources: config.allowedResources,
      rejectedTotal,
    }, logger);
    if (metricsMiddleware) app.use(metricsMiddleware, tokenRouter);
    else app.use(tokenRouter);

    // PAR proxy — mounted with auth proxy; handlers 404 when upstream omits PAR
    const parRouter = createParRouter({
      getUpstreamParEndpoint: () => state.upstreamParEndpoint,
      removed: config.authScopesRemoved,
      preserved: config.authScopesPreserved,
      requireResource: config.requireResource,
      allowedResources: config.allowedResources,
      cimdResolve,
      cimdValidateAndCache,
      stateBaseUrl: config.authStateSecret ? config.baseUrl : undefined,
      stateSecret: config.authStateSecret,
      stateTtlSeconds: config.authStateTtlSeconds,
      stateAllowedRedirectUris: config.authStateSecret ? config.allowedRedirectUris : undefined,
      dcrClientIdRedirectMap: config.dcrClientIdRedirectMap.size > 0 ? config.dcrClientIdRedirectMap : undefined,
      knownIdpClients: knownIdpClients.size > 0 ? knownIdpClients : undefined,
      metricsRegistry,
      rejectedTotal,
    }, logger);
    if (metricsMiddleware) app.use(metricsMiddleware, parRouter);
    else app.use(parRouter);
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

  return { app, metricsRegistry, updateUpstream, updateUpstreamHealth, setShuttingDown, isShuttingDown };
}
