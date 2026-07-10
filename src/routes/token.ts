import { Router, Request, Response } from 'express';
import express from 'express';
import { Logger } from '../logger';
import { readResponseWithLimit } from '../fetch-utils';
import { isCimdClientId, validateCimdUrl, resolveUpstreamClientId, sanitizeForError } from '../cimd';
import { matchesRedirectPattern, checkAndMatchResource, ResourceConfig } from '../uri-validation';
import { IMetricsRegistry, ICounter, IHistogram } from '../metrics';

const ROUTE = '/token';
const TOKEN_UPSTREAM_TIMEOUT_MS = 10000;
const TOKEN_UPSTREAM_MAX_RESPONSE_BYTES = 64 * 1024;
const RELAY_HEADERS = ['content-type', 'cache-control', 'pragma'];

const GRANT_TYPE_LABELS: Record<string, string> = {
  'authorization_code': 'authorization_code',
  'refresh_token': 'refresh_token',
  'client_credentials': 'client_credentials',
  'urn:ietf:params:oauth:grant-type:jwt-bearer': 'jwt_bearer',
};

function grantTypeLabel(gt: string): string | undefined {
  return GRANT_TYPE_LABELS[gt];
}

export interface TokenRouterConfig extends ResourceConfig {
  getUpstreamTokenEndpoint: () => string;
  cimdMap: Record<string, string>;
  cimdDefaultClientId?: string;
  metricsRegistry?: IMetricsRegistry;
  redirectBaseUrl?: string;
  redirectAllowedUris?: string[];
  dcrClientIdRedirectMap?: Map<string, string[]>;
  knownIdpClients?: Set<string>;
  rejectedTotal: ICounter;
}

export function createTokenRouter(
  config: TokenRouterConfig,
  logger: Logger,
): Router {
  const router = Router();

  const upstreamDuration = config.metricsRegistry?.createHistogram('mcp_auth_token_proxy_upstream_duration_seconds', 'Token proxy upstream request duration in seconds');
  const upstreamStatus = config.metricsRegistry?.createCounter('mcp_auth_token_proxy_upstream_status_total', 'Token proxy upstream response status codes');

  const urlencodedParser = express.urlencoded({ extended: false, limit: '16kb' });

  router.post('/token', (req: Request, res: Response, next) => {
    const contentType = req.get('content-type') ?? '';
    if (!contentType.includes('application/x-www-form-urlencoded')) {
      logger.warn('token proxy: invalid Content-Type', { contentType: contentType.slice(0, 100) });
      config.rejectedTotal.inc({ route: ROUTE, reason: 'content_type_invalid' });
      res.status(415).json({
        error: 'invalid_request',
        error_description: 'Content-Type must be application/x-www-form-urlencoded',
      });
      return;
    }
    next();
  }, urlencodedParser, async (req: Request, res: Response) => {
    await handleTokenRequest(req, res, config, logger, upstreamDuration, upstreamStatus);
  });

  return router;
}

async function handleTokenRequest(
  req: Request,
  res: Response,
  config: TokenRouterConfig,
  logger: Logger,
  upstreamDuration?: IHistogram,
  upstreamStatusCounter?: ICounter,
): Promise<void> {
  try {
    const rawBody = req.body as Record<string, unknown>;
    const str = (v: unknown): string => typeof v === 'string' ? v : '';
    const clientId = str(rawBody.client_id);
    const grantType = str(rawBody.grant_type);
    const redirectUri = str(rawBody.redirect_uri);
    const resource = str(rawBody.resource);

    logger.accessLog('token proxy request', req, res, {
      clientId: clientId.startsWith('https://') ? clientId.slice(0, 80) : clientId,
      grantType,
      redirectUri: redirectUri ? redirectUri.split('?')[0].slice(0, 200) : undefined,
      hasAuthHeader: !!req.get('authorization'),
      resource: resource || 'MISSING',
    });

    const gtLabel = grantTypeLabel(grantType);

    // RFC 8707 resource parameter validation (skip for refresh_token per RFC 8707 §2.2)
    let resourceLabel: Record<string, string> = {};
    if (grantType !== 'refresh_token') {
      const { error: resourceError, matchedPattern } = checkAndMatchResource(resource, config);
      resourceLabel = matchedPattern ? { resource: matchedPattern } : {};
      if (resourceError) {
        logger.warn('token proxy: resource parameter rejected', { reason: resourceError.reason, resource: resource.slice(0, 200), grantType, clientId: clientId.startsWith('https://') ? clientId.slice(0, 80) : clientId });
        config.rejectedTotal.inc({
          route: ROUTE,
          reason: resourceError.reason,
          ...(gtLabel ? { grant_type: gtLabel } : {}),
          ...resourceLabel,
        });
        res.status(400).json({
          error: 'invalid_request',
          error_description: resourceError.description,
        });
        return;
      }
    }

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(rawBody)) {
      if (typeof value === 'string') {
        params.set(key, value);
      }
    }

    const isCimd = !!(clientId && isCimdClientId(clientId));

    if (isCimd) {
      const urlValidation = validateCimdUrl(clientId);
      if (!urlValidation.valid) {
        logger.warn('token proxy: invalid CIMD client_id URL', { clientId: clientId.slice(0, 80), reason: urlValidation.reason });
        config.rejectedTotal.inc({
          route: ROUTE,
          reason: 'cimd_url_invalid',
          ...(gtLabel ? { grant_type: gtLabel } : {}),
          ...resourceLabel,
        });
        res.status(400).json({
          error: 'invalid_client',
          error_description: `Invalid CIMD client_id URL: ${sanitizeForError(urlValidation.reason)}`,
        });
        return;
      }

      const upstreamClientId = resolveUpstreamClientId(
        clientId,
        config.cimdMap,
        config.cimdDefaultClientId,
      );

      if (!upstreamClientId) {
        logger.warn('token proxy: unknown CIMD client rejected', { clientId: clientId.slice(0, 80) });
        config.rejectedTotal.inc({
          route: ROUTE,
          reason: 'cimd_client_unknown',
          ...(gtLabel ? { grant_type: gtLabel } : {}),
          ...resourceLabel,
        });
        res.status(403).json({
          error: 'invalid_client',
          error_description: `Unknown CIMD client: ${sanitizeForError(clientId)}`,
        });
        return;
      }

      params.set('client_id', upstreamClientId);
    }

    // Resolve idp_client label for metrics (uses client_id after CIMD rewrite)
    const effectiveClientId = params.get('client_id') ?? '';
    const idpClientLabel: Record<string, string> = config.knownIdpClients?.has(effectiveClientId)
      ? { idp_client: effectiveClientId } : {};

    // Redirect URI validation and rewriting for authorization_code grants
    if (config.redirectBaseUrl && grantType === 'authorization_code') {
      if (!redirectUri) {
        logger.warn('token proxy: redirect_uri missing', { grantType, clientId: effectiveClientId });
        config.rejectedTotal.inc({
          route: ROUTE,
          reason: 'redirect_uri_missing',
          ...(gtLabel ? { grant_type: gtLabel } : {}),
          ...resourceLabel,
          ...idpClientLabel,
        });
        res.status(400).json({
          error: 'invalid_request',
          error_description: 'redirect_uri is required for authorization_code grant',
        });
        return;
      }

      if (!isCimd) {
        // Per-client redirect_uri enforcement via dcrClientIdRedirectMap
        const perClientPatterns = config.dcrClientIdRedirectMap?.get(effectiveClientId);
        if (perClientPatterns) {
          const match = matchesRedirectPattern(redirectUri, perClientPatterns);
          if (!match.allowed) {
            logger.warn('token proxy: redirect_uri rejected (per-client)', { reason: match.reason, uri: redirectUri.slice(0, 200), clientId: effectiveClientId });
            config.rejectedTotal.inc({
              route: ROUTE,
              reason: 'redirect_uri_rejected',
              ...(gtLabel ? { grant_type: gtLabel } : {}),
              ...resourceLabel,
              ...idpClientLabel,
            });
            res.status(400).json({
              error: 'invalid_request',
              error_description: 'redirect_uri not allowed',
            });
            return;
          }
          if (logger.isDebugEnabled) logger.debug('token proxy: redirect_uri allowed (per-client)', {
            clientId: effectiveClientId,
            uri: redirectUri.slice(0, 200),
          });
        } else {
          const match = matchesRedirectPattern(redirectUri, config.redirectAllowedUris!);
          if (!match.allowed) {
            logger.warn('token proxy: redirect_uri rejected', { reason: match.reason, uri: redirectUri.slice(0, 200), clientId: effectiveClientId });
            config.rejectedTotal.inc({
              route: ROUTE,
              reason: 'redirect_uri_rejected',
              ...(gtLabel ? { grant_type: gtLabel } : {}),
              ...resourceLabel,
              ...idpClientLabel,
            });
            res.status(400).json({
              error: 'invalid_request',
              error_description: 'redirect_uri not allowed',
            });
            return;
          }
        }
      }

      params.set('redirect_uri', `${config.redirectBaseUrl}/authorize/callback`);
    }

    const upstreamUrl = config.getUpstreamTokenEndpoint();
    // Forward Authorization header for non-CIMD requests (supports client_secret_basic
    // per RFC 6749 §2.3.1). Skipped for CIMD because client_id is rewritten — the
    // original credentials would be invalid for the upstream IdP's mapped client.
    const outHeaders: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    if (!isCimd) {
      const authHeader = req.get('authorization');
      if (authHeader) {
        outHeaders['Authorization'] = authHeader;
      }
    }

    let upstreamResponse: globalThis.Response;
    const fetchStart = process.hrtime.bigint();
    try {
      upstreamResponse = await fetch(upstreamUrl, {
        method: 'POST',
        headers: outHeaders,
        body: params.toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(TOKEN_UPSTREAM_TIMEOUT_MS),
      });
      const fetchDuration = Number(process.hrtime.bigint() - fetchStart) / 1e9;
      const upstreamLabels = { ...(gtLabel ? { grant_type: gtLabel } : {}), ...resourceLabel, ...idpClientLabel };
      upstreamDuration?.observe(fetchDuration, upstreamLabels);
      upstreamStatusCounter?.inc({ status: String(upstreamResponse.status), ...upstreamLabels });
    } catch (err) {
      const fetchDuration = Number(process.hrtime.bigint() - fetchStart) / 1e9;
      const upstreamLabels = { ...(gtLabel ? { grant_type: gtLabel } : {}), ...resourceLabel, ...idpClientLabel };
      upstreamDuration?.observe(fetchDuration, upstreamLabels);
      logger.error('token proxy: upstream request failed', { error: String(err) });
      res.status(502).json({
        error: 'server_error',
        error_description: 'Token endpoint upstream request failed',
      });
      return;
    }

    let responseBody: Buffer;
    try {
      responseBody = await readResponseWithLimit(upstreamResponse, TOKEN_UPSTREAM_MAX_RESPONSE_BYTES);
    } catch (readErr) {
      logger.error('token proxy: failed reading upstream response', { error: String(readErr) });
      res.status(502).json({
        error: 'server_error',
        error_description: 'Failed reading token endpoint upstream response',
      });
      return;
    }

    for (const header of RELAY_HEADERS) {
      const value = upstreamResponse.headers.get(header);
      if (value) {
        res.set(header, value);
      }
    }

    res.status(upstreamResponse.status).send(responseBody);
  } catch (err) {
    logger.error('token proxy: unexpected error', { error: String(err) });
    res.status(500).json({
      error: 'server_error',
      error_description: 'Internal server error',
    });
  }
}
