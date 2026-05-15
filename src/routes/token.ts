import { Router, Request, Response } from 'express';
import express from 'express';
import { Logger, requestMeta } from '../logger';
import { readResponseWithLimit } from '../fetch-utils';
import { isCimdClientId, validateCimdUrl, resolveUpstreamClientId, sanitizeForError } from '../cimd';
import { IMetricsRegistry, ICounter, IHistogram } from '../metrics';

const TOKEN_UPSTREAM_TIMEOUT_MS = 10000;
const TOKEN_UPSTREAM_MAX_RESPONSE_BYTES = 64 * 1024;
const RELAY_HEADERS = ['content-type', 'cache-control', 'pragma'];

export interface TokenCimdResolver {
  map: Record<string, string>;
  defaultClientId?: string;
}

export function createTokenRouter(
  getUpstreamTokenEndpoint: () => string,
  cimdResolver: TokenCimdResolver,
  logger: Logger,
  metricsRegistry?: IMetricsRegistry,
): Router {
  const router = Router();

  const upstreamDuration = metricsRegistry?.createHistogram('mcp_auth_token_proxy_upstream_duration_seconds', 'Token proxy upstream request duration in seconds');
  const upstreamStatus = metricsRegistry?.createCounter('mcp_auth_token_proxy_upstream_status_total', 'Token proxy upstream response status codes');

  const urlencodedParser = express.urlencoded({ extended: false, limit: '16kb' });

  router.post('/token', (req: Request, res: Response, next) => {
    const contentType = req.get('content-type') ?? '';
    if (!contentType.includes('application/x-www-form-urlencoded')) {
      res.status(415).json({
        error: 'invalid_request',
        error_description: 'Content-Type must be application/x-www-form-urlencoded',
      });
      return;
    }
    next();
  }, urlencodedParser, async (req: Request, res: Response) => {
    await handleTokenRequest(req, res, getUpstreamTokenEndpoint, cimdResolver, logger, upstreamDuration, upstreamStatus);
  });

  return router;
}

async function handleTokenRequest(
  req: Request,
  res: Response,
  getUpstreamTokenEndpoint: () => string,
  cimdResolver: TokenCimdResolver,
  logger: Logger,
  upstreamDuration?: IHistogram,
  upstreamStatusCounter?: ICounter,
): Promise<void> {
  try {
    const body = req.body as Record<string, string>;
    const clientId = body.client_id ?? '';

    logger.debug('token proxy request', {
      ...requestMeta(req),
      clientId: clientId.startsWith('https://') ? clientId.slice(0, 80) : clientId,
      grantType: body.grant_type,
    });

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === 'string') {
        params.set(key, value);
      }
    }

    if (clientId && isCimdClientId(clientId)) {
      const urlValidation = validateCimdUrl(clientId);
      if (!urlValidation.valid) {
        res.status(400).json({
          error: 'invalid_client',
          error_description: `Invalid CIMD client_id URL: ${sanitizeForError(urlValidation.reason)}`,
        });
        return;
      }

      const upstreamClientId = resolveUpstreamClientId(
        clientId,
        cimdResolver.map,
        cimdResolver.defaultClientId,
      );

      if (!upstreamClientId) {
        logger.debug('token proxy: unknown CIMD client rejected', { clientId: clientId.slice(0, 80) });
        res.status(403).json({
          error: 'invalid_client',
          error_description: `Unknown CIMD client: ${sanitizeForError(clientId)}`,
        });
        return;
      }

      params.set('client_id', upstreamClientId);
    }

    const upstreamUrl = getUpstreamTokenEndpoint();
    let upstreamResponse: globalThis.Response;
    const fetchStart = process.hrtime.bigint();
    try {
      upstreamResponse = await fetch(upstreamUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(TOKEN_UPSTREAM_TIMEOUT_MS),
      });
      const fetchDuration = Number(process.hrtime.bigint() - fetchStart) / 1e9;
      upstreamDuration?.observe(fetchDuration);
      upstreamStatusCounter?.inc({ status: String(upstreamResponse.status) });
    } catch (err) {
      const fetchDuration = Number(process.hrtime.bigint() - fetchStart) / 1e9;
      upstreamDuration?.observe(fetchDuration);
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
