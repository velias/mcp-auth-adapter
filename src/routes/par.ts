import { Router, Request, Response } from 'express';
import express from 'express';
import { Logger, truncateClientIdForLog, truncateUriForLog } from '../logger';
import { readResponseWithLimit } from '../fetch-utils';
import { IMetricsRegistry, ICounter, IHistogram } from '../metrics';
import {
  AuthScopeConfig,
  AuthRequestTransformConfig,
  applyAuthorizationRequestTransforms,
} from '../auth-request-transforms';

const ROUTE = '/par';
const PAR_UPSTREAM_TIMEOUT_MS = 10000;
const PAR_UPSTREAM_MAX_RESPONSE_BYTES = 64 * 1024;
const RELAY_HEADERS = ['content-type', 'cache-control', 'pragma', 'dpop-nonce'];

export interface ParRouterConfig extends AuthRequestTransformConfig {
  getUpstreamParEndpoint: () => string;
  metricsRegistry?: IMetricsRegistry;
  rejectedTotal: ICounter;
}

export function createParRouter(
  config: ParRouterConfig,
  logger: Logger,
): Router {
  const router = Router();

  const scopeConfig: AuthScopeConfig = {
    ...config,
    preservedSet: config.preserved?.length ? new Set(config.preserved) : undefined,
    removedSet: config.removed?.length ? new Set(config.removed) : undefined,
  };

  const upstreamDuration = config.metricsRegistry?.createHistogram(
    'mcp_auth_par_proxy_upstream_duration_seconds',
    'PAR proxy upstream request duration in seconds',
  );
  const upstreamStatus = config.metricsRegistry?.createCounter(
    'mcp_auth_par_proxy_upstream_status_total',
    'PAR proxy upstream response status codes',
  );

  const urlencodedParser = express.urlencoded({ extended: false, limit: '16kb' });

  router.post('/par', (req: Request, res: Response, next) => {
    const contentType = req.get('content-type') ?? '';
    if (!contentType.includes('application/x-www-form-urlencoded')) {
      logger.warn('par proxy: invalid Content-Type', { contentType: contentType.slice(0, 100) });
      config.rejectedTotal.inc({ route: ROUTE, reason: 'content_type_invalid' });
      res.status(415).json({
        error: 'invalid_request',
        error_description: 'Content-Type must be application/x-www-form-urlencoded',
      });
      return;
    }
    next();
  }, urlencodedParser, async (req: Request, res: Response) => {
    await handleParRequest(req, res, config, scopeConfig, logger, upstreamDuration, upstreamStatus);
  });

  return router;
}

async function handleParRequest(
  req: Request,
  res: Response,
  config: ParRouterConfig,
  scopeConfig: AuthScopeConfig,
  logger: Logger,
  upstreamDuration?: IHistogram,
  upstreamStatusCounter?: ICounter,
): Promise<void> {
  try {
    const rawBody = req.body as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(rawBody)) {
      if (typeof value === 'string') {
        params.set(key, value);
      }
    }

    const clientIdForLog = truncateClientIdForLog(params.get('client_id') ?? '');

    logger.accessLog('par proxy request', req, res, {
      scope: params.get('scope'),
      clientId: clientIdForLog,
      redirectUri: params.get('redirect_uri'),
      responseType: params.get('response_type'),
      codeChallengeMethod: params.get('code_challenge_method') || 'MISSING',
      statePresent: params.has('state'),
      hasAuthHeader: !!req.get('authorization'),
      hasDpopHeader: !!req.get('dpop'),
      resource: params.get('resource') || 'MISSING',
    });

    const upstreamUrl = config.getUpstreamParEndpoint();
    if (!upstreamUrl) {
      logger.warn('par proxy: upstream PAR endpoint not available', { clientId: clientIdForLog });
      res.status(404).json({
        error: 'invalid_request',
        error_description: 'Pushed authorization requests are not available',
      });
      return;
    }

    // RFC 9126 §2.1: request_uri MUST NOT be provided in a pushed authorization request
    if (params.has('request_uri')) {
      logger.warn('par proxy: request_uri not allowed in PAR body', { clientId: clientIdForLog });
      config.rejectedTotal.inc({ route: ROUTE, reason: 'request_uri_in_body' });
      res.status(400).json({
        error: 'invalid_request',
        error_description: 'request_uri must not be included in a pushed authorization request',
      });
      return;
    }

    const result = await applyAuthorizationRequestTransforms(
      params,
      config,
      scopeConfig,
      logger,
      'par',
    );

    if (!result.ok) {
      config.rejectedTotal.inc({
        route: ROUTE,
        reason: result.reason,
        ...result.resourceLabel,
        ...result.idpClientLabel,
      });
      res.status(result.status).json(result.body);
      return;
    }

    const outHeaders: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (!result.isCimd) {
      const authHeader = req.get('authorization');
      if (authHeader) {
        outHeaders['Authorization'] = authHeader;
      }
    } else if (req.get('authorization') && logger.isDebugEnabled) {
      logger.debug('par proxy: Authorization header not forwarded (CIMD client_id rewrite)', {
        clientId: clientIdForLog,
      });
    }
    const dpopHeader = req.get('dpop');
    if (dpopHeader) {
      outHeaders['DPoP'] = dpopHeader;
    }
    const dpopNonceHeader = req.get('dpop-nonce');
    if (dpopNonceHeader) {
      outHeaders['DPoP-Nonce'] = dpopNonceHeader;
    }

    if (logger.isDebugEnabled) {
      const effectiveClientId = result.params.get('client_id') ?? '';
      logger.debug('par proxy: forwarding to upstream', {
        upstreamUrl,
        clientId: truncateClientIdForLog(effectiveClientId),
        redirectUri: truncateUriForLog(result.params.get('redirect_uri') ?? ''),
        scope: result.params.get('scope') ?? '',
        isCimd: result.isCimd,
        hasAuthHeader: !!outHeaders['Authorization'],
        hasDpopHeader: !!outHeaders['DPoP'],
      });
    }

    let upstreamResponse: globalThis.Response;
    const fetchStart = process.hrtime.bigint();
    const upstreamLabels = { ...result.resourceLabel, ...result.idpClientLabel };
    try {
      upstreamResponse = await fetch(upstreamUrl, {
        method: 'POST',
        headers: outHeaders,
        body: result.params.toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(PAR_UPSTREAM_TIMEOUT_MS),
      });
      const fetchDuration = Number(process.hrtime.bigint() - fetchStart) / 1e9;
      upstreamDuration?.observe(fetchDuration, upstreamLabels);
      upstreamStatusCounter?.inc({ status: String(upstreamResponse.status), ...upstreamLabels });
    } catch (err) {
      const fetchDuration = Number(process.hrtime.bigint() - fetchStart) / 1e9;
      upstreamDuration?.observe(fetchDuration, upstreamLabels);
      logger.error('par proxy: upstream request failed', { error: String(err), clientId: clientIdForLog });
      res.status(502).json({
        error: 'server_error',
        error_description: 'PAR endpoint upstream request failed',
      });
      return;
    }

    let responseBody: Buffer;
    try {
      responseBody = await readResponseWithLimit(upstreamResponse, PAR_UPSTREAM_MAX_RESPONSE_BYTES);
    } catch (readErr) {
      logger.error('par proxy: failed reading upstream response', { error: String(readErr), clientId: clientIdForLog });
      res.status(502).json({
        error: 'server_error',
        error_description: 'Failed reading PAR endpoint upstream response',
      });
      return;
    }

    if (upstreamResponse.status >= 400) {
      logger.warn('par proxy: upstream returned error status', {
        status: upstreamResponse.status,
        clientId: truncateClientIdForLog(result.params.get('client_id') ?? clientIdForLog),
      });
    }

    for (const header of RELAY_HEADERS) {
      const value = upstreamResponse.headers.get(header);
      if (value) {
        res.set(header, value);
      }
    }

    res.status(upstreamResponse.status).send(responseBody);
  } catch (err) {
    logger.error('par proxy: unexpected error', { error: String(err) });
    res.status(500).json({
      error: 'server_error',
      error_description: 'Internal server error',
    });
  }
}
